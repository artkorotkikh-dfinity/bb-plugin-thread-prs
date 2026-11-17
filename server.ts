// Thread PR Manager: every pull request a thread and its descendant threads made.
//
// Sources, deduplicated by repo#number:
//   1. Focus Board links (thread metadata, namespace "focus-board", key "linkedIssues").
//   2. bb--github-pr-status: each environment's current-branch PR.
// Status comes from one batched `gh api graphql` call on the thread's machine,
// cached here with state-dependent TTLs. Watchers refresh visible lists; a
// background service also refreshes PRs explicitly enabled for Auto-fix.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  autoFixLabel,
  autoFixLastSendLabel,
  autoFixSchema,
  hostContract,
  parsePrUrl,
  prStateSchema,
  reviewStateSchema,
  rpcContract,
  THREAD_PRS_TAG,
  truncationText,
  type PrSource,
  type PrStatus,
  type ThreadPr,
  type ThreadPrs,
  type MergePreview,
  type MergeMethod,
} from "./contract";

const FOCUS_BOARD = "focus-board";
const PR_STATUS_PLUGIN = "bb--github-pr-status";
const MAX_THREADS = 200;
const MAX_PRS = 50;

const SECOND = 1000;
const TICK_MS = 30 * SECOND;
const AUTO_FIX_MS = 2 * 60 * SECOND;
const AUTO_FIX_PREFIX = "autofix:";
const savedAutoFixSchema = autoFixSchema.extend({ url: z.string().url(), hostId: z.string().nullable() });
type SavedAutoFix = z.infer<typeof savedAutoFixSchema>;

const TTL_PENDING_MS = 30 * SECOND;
const TTL_OPEN_MS = 2 * 60 * SECOND;
const TTL_DONE_MS = 15 * 60 * SECOND;
const TTL_ERROR_MS = 60 * SECOND;

const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const cacheKey = (hostId: string | null, url: string) => JSON.stringify([hostId, url]);

// Only the part of Focus Board's link record we read; anything else is ignored.
const focusLinkSchema = z.object({
  tracker: z.literal("github").optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issue: z.number().int().positive(),
  kind: z.literal("pull"),
});

// The part of bb--github-pr-status's `pullRequests` row we read.
const builtinPullRequestSchema = z
  .object({
    number: z.number(),
    title: z.string(),
    url: z.string(),
    state: prStateSchema,
    updatedAt: z.string(),
    checks: z
      .object({
        state: z.string(),
        totalCount: z.number(),
        passedCount: z.number(),
        failedCount: z.number(),
        pendingCount: z.number(),
      })
      .passthrough(),
    review: z.object({ state: z.string() }).passthrough(),
  })
  .passthrough();
const builtinRowSchema = z
  .object({ outcome: z.string(), pullRequest: z.unknown().optional() })
  .passthrough();
const builtinOutputSchema = z.record(z.string(), builtinRowSchema);

function fromBuiltin(row: z.infer<typeof builtinRowSchema>): PrStatus | null {
  if (row.outcome !== "available") return null;
  const parsed = builtinPullRequestSchema.safeParse(row.pullRequest);
  if (!parsed.success) return null;
  const pr = parsed.data;
  const checksState = (["passing", "failing", "pending", "no_checks"] as const).find(
    (state) => state === pr.checks.state,
  );
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    checks: {
      state: checksState ?? "no_checks",
      passed: pr.checks.passedCount,
      failed: pr.checks.failedCount,
      pending: pr.checks.pendingCount,
      total: pr.checks.totalCount,
    },
    review: reviewStateSchema.safeParse(pr.review.state).data ?? "none",
    updatedAt: pr.updatedAt,
  };
}

type Ref = {
  key: string;
  repo: string;
  number: number;
  url: string;
  sources: PrSource[];
  builtin: PrStatus | null;
  environmentId: string | null;
  hostId: string | null;
};

type Collected = {
  refs: Ref[];
  ownBranchKey: string | null;
  hostId: string | null;
  truncationReason: ThreadPrs["truncationReason"];
};

type CacheEntry = { status: PrStatus | null; error: string | null; fetchedAt: number };

function ttlFor(entry: CacheEntry): number {
  if (entry.error !== null || entry.status === null) return TTL_ERROR_MS;
  if (entry.status.state === "merged" || entry.status.state === "closed") return TTL_DONE_MS;
  if (entry.status.mergeable === "UNKNOWN") return TTL_PENDING_MS;
  if (entry.status.checks.pending > 0 || entry.status.checks.state === "pending") return TTL_PENDING_MS;
  return TTL_OPEN_MS;
}

// Checks can change without updatedAt changing, so ties favor our gh read in assemble.
function newer(a: PrStatus | null, b: PrStatus | null): PrStatus | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b.updatedAt) >= Date.parse(a.updatedAt) ? b : a;
}

const stateRank: Record<string, number> = { open: 0, draft: 0, merged: 1, closed: 2 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default async function plugin(bb: BbPluginApi) {
  // Read by the app through useSettings(); the server only declares it.
  bb.settings.define({
    openPullRequestsIn: {
      type: "select",
      label: "Open pull requests in",
      description:
        "Where a click on a PR in the list opens it. bb's browser follows Settings → General → Links.",
      options: ["bb", "system"],
      experimental_optionLabels: { bb: "bb's browser", system: "System browser" },
      default: "bb",
    },
    completedPullRequests: {
      type: "select",
      label: "Completed pull requests",
      description: "Hide merged and closed pull requests from the list. The CLI always lists everything.",
      options: ["all", "activeOnly"],
      experimental_optionLabels: { all: "All", activeOnly: "Open and draft only" },
      default: "all",
    },
    showViewDiffAction: {
      type: "boolean", label: "PR menu: View diff",
      description: "Show View diff in each PR's three-dot menu.", default: true,
    },
    showRerunFailedCiAction: {
      type: "boolean", label: "PR menu: Re-run failed CI",
      description: "Show Re-run failed CI. Retrying GitHub Actions jobs can use runner minutes.", default: true,
    },
    showCopilotReviewAction: {
      type: "boolean", label: "PR menu: Copilot review",
      description: "Show Copilot review. Requests require account eligibility and use Copilot quota.", default: true,
    },
    showMarkDraftAction: {
      type: "boolean", label: "PR menu: Mark as draft",
      description: "Show Mark as draft for open pull requests. Drafts can be marked ready again.", default: true,
    },
    showMergeAction: {
      type: "boolean", label: "PR menu: Merge",
      description: "Show Merge. Every merge still requires a fresh confirmation and GitHub readiness checks.", default: true,
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const cache = new Map<string, CacheEntry>();
  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());
  const lastSignature = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  const hostReads = new Map<string | null, Promise<unknown>>();
  const autoFix = new Map<string, SavedAutoFix>();
  const autoFixActivity = new Map<string, string>();
  const prActionsInFlight = new Set<string>();
  const mergeConfirmations = new Map<string, {
    threadId: string; url: string; hostId: string; preview: MergePreview; expiresAt: number;
  }>();
  let autoFixWake = new AbortController();
  function requestAutoFixPoll() { autoFixWake.abort(); }
  async function waitForAutoFix(ms: number, signal: AbortSignal) {
    const wake = autoFixWake;
    await sleep(ms, AbortSignal.any([signal, wake.signal]));
    if (autoFixWake === wake) autoFixWake = new AbortController();
  }
  function reportAutoFix(key: string, activity: string) {
    if (autoFixActivity.get(key) === activity) return;
    autoFixActivity.set(key, activity);
    bb.log.info(`Auto-fix ${key}: ${activity}; owner ${autoFix.get(key)?.ownerThreadId ?? "unknown"}`);
    bb.rpc.experimental_invalidate([THREAD_PRS_TAG]);
  }
  for (const key of await bb.storage.kv.list(AUTO_FIX_PREFIX)) {
    const parsed = savedAutoFixSchema.safeParse(await bb.storage.kv.get(key));
    const pr = parsed.success ? parsePrUrl(parsed.data.url) : null;
    if (parsed.success && pr && key === `${AUTO_FIX_PREFIX}${prKey(pr.repo, pr.number)}`) {
      autoFix.set(prKey(pr.repo, pr.number), { ...parsed.data, url: pr.url });
    }
  }
  let autoFixWork: Promise<unknown> = Promise.resolve();
  function serializeAutoFix<T>(work: () => Promise<T>): Promise<T> {
    const next = autoFixWork.then(work);
    autoFixWork = next.catch(() => undefined);
    return next;
  }

  async function saveAutoFix(key: string, state: SavedAutoFix): Promise<void> {
    await bb.storage.kv.set(`${AUTO_FIX_PREFIX}${key}`, state);
    autoFix.set(key, state);
    bb.rpc.experimental_invalidate([THREAD_PRS_TAG]);
  }

  function ownerOf(ref: Ref): PrSource {
    return ref.sources.find((source) => source.kind === "branch") ?? ref.sources[0]!;
  }

  function autoFixFor(ref: Ref): ThreadPr["autoFix"] {
    const owner = ownerOf(ref);
    const saved = autoFix.get(ref.key);
    return {
      ...autoFixSchema.parse(saved ?? {
        enabled: false, ownerThreadId: owner.threadId, attempts: 0,
        lastTriggerKey: null, lastSentAt: null, stoppedReason: null,
      }),
      ownerThreadTitle: ref.sources.find((source) => source.threadId === (saved?.ownerThreadId ?? owner.threadId))?.threadTitle ?? null,
      activity: saved?.enabled ? autoFixActivity.get(ref.key) ?? "Waiting for next check" : null,
    };
  }

  async function hostIdFor(environmentId: string, signal?: AbortSignal): Promise<string | null> {
    const environment = await bb.sdk.environments.get({ environmentId, signal }).catch(() => null);
    return environment?.hostId ?? null;
  }

  async function collect(threadId: string, signal?: AbortSignal): Promise<Collected> {
    const descendants = await bb.sdk.threads
      .experimental_listDescendants({
        threadIds: [threadId],
        includeArchived: true,
        includeHidden: true,
        signal,
      })
      .catch(() => ({ threads: [] }));
    const ids = [
      threadId,
      ...(descendants.threads.find((entry) => entry.threadId === threadId)?.descendantIds ?? []),
    ];
    let truncationReason: Collected["truncationReason"] = ids.length > MAX_THREADS ? "threads" : null;
    ids.length = Math.min(ids.length, MAX_THREADS);

    const threads = new Map<string, { title: string | null; environmentId: string | null }>();
    await Promise.all(
      ids.map(async (id) => {
        const thread = await bb.sdk.threads.get({ threadId: id, signal }).catch(() => null);
        if (thread !== null) {
          threads.set(id, {
            title: thread.title ?? null,
            environmentId: thread.environmentId ?? null,
          });
        }
      }),
    );

    const refs = new Map<string, Ref>();
    const addSource = (
      parsed: { repo: string; number: number; url: string },
      source: PrSource,
      extra: { builtin?: PrStatus; environmentId?: string } = {},
    ) => {
      const key = prKey(parsed.repo, parsed.number);
      let ref = refs.get(key);
      if (ref === undefined) {
        if (refs.size >= MAX_PRS) {
          truncationReason = "pullRequests";
          return;
        }
        ref = { key, ...parsed, sources: [], builtin: null, environmentId: null, hostId: null };
        refs.set(key, ref);
      }
      if (!ref.sources.some((s) => s.kind === source.kind && s.threadId === source.threadId)) {
        ref.sources.push(source);
      }
      if (extra.builtin) ref.builtin = newer(ref.builtin, extra.builtin);
      if (extra.environmentId && ref.environmentId === null) ref.environmentId = extra.environmentId;
    };
    const sourceOf = (id: string, kind: PrSource["kind"]): PrSource => ({
      kind,
      threadId: id,
      threadTitle: threads.get(id)?.title ?? null,
      isRoot: id === threadId,
    });

    // Environments' current-branch PRs, read from bb's own PR plugin.
    const envOwners = new Map<string, string>();
    for (const id of ids) {
      const environmentId = threads.get(id)?.environmentId;
      // A child that shares its parent's environment shares its branch PR: credit the first thread, so the root wins.
      if (environmentId && !envOwners.has(environmentId)) envOwners.set(environmentId, id);
    }
    let ownBranchKey: string | null = null;
    if (envOwners.size > 0) {
      const rows = await bb.sdk.plugins
        .callRpc({
          pluginId: PR_STATUS_PLUGIN,
          method: "pullRequests",
          input: { keys: [...envOwners.keys()] },
          outputSchema: builtinOutputSchema,
          signal,
        })
        .catch((error: unknown) => {
          if (!signal?.aborted) bb.log.warn(`github-pr-status read failed: ${errorText(error)}`);
          return {} as z.infer<typeof builtinOutputSchema>;
        });
      for (const [environmentId, owner] of envOwners) {
        const row = rows[environmentId];
        const status = row === undefined ? null : fromBuiltin(row);
        const parsed = status === null ? null : parsePrUrl(status.url);
        if (status === null || parsed === null) continue;
        addSource(parsed, sourceOf(owner, "branch"), { builtin: status, environmentId });
        if (owner === threadId) ownBranchKey = prKey(parsed.repo, parsed.number);
      }
    }

    // Focus Board links on the thread and every descendant.
    const metadata = await bb.sdk.threads
      .experimental_listPluginMetadata({ pluginId: FOCUS_BOARD, threadIds: ids, signal })
      .catch(() => ({ threads: [] as { threadId: string; metadata: Record<string, unknown> }[] }));
    for (const id of ids) {
      const links = metadata.threads.find((entry) => entry.threadId === id)?.metadata.linkedIssues;
      if (!Array.isArray(links)) continue;
      for (const raw of links) {
        const link = focusLinkSchema.safeParse(raw);
        if (!link.success) continue;
        const parsed = parsePrUrl(`https://github.com/${link.data.repo}/pull/${link.data.issue}`);
        if (parsed !== null) addSource(parsed, sourceOf(id, "link"));
      }
    }

    const rootEnvironment = threads.get(threadId)?.environmentId ?? null;
    let hostId = rootEnvironment === null ? null : await hostIdFor(rootEnvironment, signal);
    for (const environmentId of envOwners.keys()) {
      if (hostId !== null) break;
      hostId = await hostIdFor(environmentId, signal);
    }
    const hosts = new Map<string, Promise<string | null>>();
    for (const ref of refs.values()) {
      // Branch ownership wins over links; otherwise use the first linking thread's machine.
      const environmentId = threads.get(ownerOf(ref).threadId)?.environmentId;
      if (environmentId) {
        if (!hosts.has(environmentId)) hosts.set(environmentId, hostIdFor(environmentId, signal));
        ref.hostId = await hosts.get(environmentId)!;
      } else ref.hostId = hostId;
    }
    return { refs: [...refs.values()], ownBranchKey, hostId, truncationReason };
  }

  function assemble(threadId: string, collected: Collected): ThreadPrs {
    const items: ThreadPr[] = collected.refs.map((ref) => {
      const entry = cache.get(cacheKey(ref.hostId, ref.url));
      const status = newer(ref.builtin, entry?.status ?? null);
      // The list needs the unresolved count. Comment contents stay in the Auto-fix cache.
      let visibleStatus: ThreadPr["status"] = null;
      if (status !== null) {
        const { reviewThreads: _reviewThreads, ...summary } = status;
        visibleStatus = summary;
      }
      return {
        key: ref.key,
        repo: ref.repo,
        number: ref.number,
        url: ref.url,
        sources: ref.sources,
        status: visibleStatus,
        error: entry?.error ?? null,
        statusSource: status === null ? null : status === entry?.status ? "gh" : "github-pr-status",
        fetchedAt: entry?.fetchedAt ?? null,
        autoFix: autoFixFor(ref),
      };
    });
    const rank = (item: ThreadPr) => (item.status === null ? 0 : (stateRank[item.status.state] ?? 0));
    items.sort((a, b) => rank(a) - rank(b) || b.number - a.number || a.repo.localeCompare(b.repo));
    return {
      threadId,
      items,
      ownBranchKey: collected.ownBranchKey,
      truncated: collected.truncationReason !== null,
      truncationReason: collected.truncationReason,
    };
  }

  function store(url: string, next: CacheEntry): boolean {
    const previous = cache.get(url);
    cache.set(url, next);
    return (
      JSON.stringify([previous?.status ?? null, previous?.error ?? null]) !==
      JSON.stringify([next.status, next.error])
    );
  }

  // Serialize reads per host and recheck TTLs after waiting for another reader.
  async function refreshUrls(hostId: string | null, urls: string[], signal?: AbortSignal): Promise<boolean> {
    const previous = hostReads.get(hostId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (signal?.aborted) return false;
      const now = Date.now();
      const stale = urls.filter((url) => {
          const entry = cache.get(cacheKey(hostId, url));
          return entry === undefined || now - entry.fetchedAt >= ttlFor(entry);
      });
      let changed = false;
      if (stale.length > 0) {
        let failure: string | null = null;
        let results: Record<string, { ok: true; pr: PrStatus } | { ok: false; message: string }> = {};
        if (hostId === null) {
          failure = "No machine to run gh on: the thread has no environment.";
        } else {
          try {
            for (let offset = 0; offset < stale.length; offset += MAX_PRS) {
              for (let attempt = 0; ; attempt++) {
                (signal ?? lifecycle.signal).throwIfAborted();
                try {
                  const batch = await host.call(
                    "fetchPullRequests", { urls: stale.slice(offset, offset + MAX_PRS) },
                    { hostId, signal, timeoutMs: 30 * SECOND },
                  );
                  Object.assign(results, batch.results);
                  break;
                } catch (error) {
                  // Existing UI watchers can run during candidate activation on reload.
                  // Retry only this local readiness error, for at most five seconds.
                  if (attempt >= 19 || !errorText(error).startsWith("host plugin calls are unavailable during factory registration")) throw error;
                  await sleep(250, signal ?? lifecycle.signal);
                }
              }
            }
          } catch (error) {
            if (signal?.aborted) return false;
            failure = errorText(error);
            bb.log.warn(`gh read failed: ${failure}`);
          }
        }
        for (const url of stale) {
          const read = results[url];
          const previous = cache.get(cacheKey(hostId, url));
          const next: CacheEntry =
            read?.ok === true
              ? { status: read.pr, error: null, fetchedAt: Date.now() }
              : {
                  status: previous?.status ?? null,
                  error: failure ?? (read?.ok === false ? read.message : "No answer from gh."),
                  fetchedAt: Date.now(),
                };
          if (store(cacheKey(hostId, url), next)) changed = true;
        }
      }
      if (changed) bb.rpc.experimental_invalidate([THREAD_PRS_TAG]);
      return changed;
    });
    hostReads.set(hostId, work);
    try { return await work; }
    finally { if (hostReads.get(hostId) === work) hostReads.delete(hostId); }
  }

  /** Re-collect the thread's PRs and read GitHub for the stale ones; invalidate open views on change. */
  function refresh(threadId: string, signal?: AbortSignal): Promise<void> {
    const running = inflight.get(threadId);
    if (running !== undefined) return running;
    const work = (async () => {
      signal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
      const collected = await collect(threadId, signal);
      const groups = new Map<string | null, string[]>();
      for (const ref of collected.refs) {
        const urls = groups.get(ref.hostId) ?? [];
        urls.push(ref.url);
        groups.set(ref.hostId, urls);
      }
      await Promise.all([...groups].map(([hostId, urls]) => refreshUrls(hostId, urls, signal)));
      let changed = false;
      const signature = JSON.stringify([
        collected.refs.map((ref) => [ref.key, ref.sources, ref.builtin]),
        collected.ownBranchKey,
        collected.truncationReason,
      ]);
      if (lastSignature.get(threadId) !== signature) {
        lastSignature.set(threadId, signature);
        changed = true;
      }
      if (changed) bb.rpc.experimental_invalidate([`${THREAD_PRS_TAG}:${threadId}`]);
    })().finally(() => inflight.delete(threadId));
    inflight.set(threadId, work);
    return work;
  }

  function setAutoFix(threadId: string, url: string, enabled: boolean) {
    return serializeAutoFix(async () => {
      const parsed = parsePrUrl(url);
      const key = parsed ? prKey(parsed.repo, parsed.number) : null;
      const saved = key ? autoFix.get(key) : undefined;
      // A removed link must never make an existing subscription impossible to stop.
      if (!enabled && key && saved) {
        await saveAutoFix(key, { ...saved, enabled: false, stoppedReason: null });
        reportAutoFix(key, "Disabled");
        return { ok: true, message: "Auto-fix off." };
      }
      const collected = await collect(threadId);
      const ref = parsed === null ? undefined : collected.refs.find((candidate) => candidate.key === prKey(parsed.repo, parsed.number));
      if (!ref) return { ok: false, message: "That pull request is not listed for this thread." };
      const previous = autoFix.get(ref.key);
      if (enabled && previous?.enabled) {
        requestAutoFixPoll();
        return { ok: true, message: "Auto-fix is already on; checking now." };
      }
      const owner = ownerOf(ref);
      if (enabled) {
        await refreshUrls(ref.hostId, [ref.url], lifecycle.signal);
        const status = newer(ref.builtin, cache.get(cacheKey(ref.hostId, ref.url))?.status ?? null);
        if (status?.state !== "open" && status?.state !== "draft") {
          return { ok: false, message: "Auto-fix requires an open or draft pull request." };
        }
      }
      const thread = await bb.sdk.threads.get({ threadId: owner.threadId }).catch(() => null);
      if (enabled && (!thread || thread.archivedAt !== null || thread.deletedAt !== null)) {
        return { ok: false, message: "The owner thread is archived, deleted or unavailable." };
      }
      const hostId = thread?.environmentId ? await hostIdFor(thread.environmentId) : null;
      await saveAutoFix(ref.key, enabled ? {
        enabled: true, ownerThreadId: owner.threadId, attempts: 0,
        lastTriggerKey: null, lastSentAt: null, stoppedReason: null,
        sentThreadKeys: previous?.sentThreadKeys ?? [], lastSentSummary: null,
        sentConflictKeys: previous?.sentConflictKeys ?? [],
        url: ref.url, hostId: hostId ?? ref.hostId,
      } : {
        ...(previous ?? { ownerThreadId: owner.threadId, attempts: 0, lastTriggerKey: null, lastSentAt: null, sentThreadKeys: [], sentConflictKeys: [], lastSentSummary: null, url: ref.url, hostId: null }),
        enabled: false, stoppedReason: null,
      });
      if (enabled) {
        // The request stays pending if a poll is running; the next wait consumes it.
        reportAutoFix(ref.key, "Checking PR");
        bb.log.info(`Auto-fix enabled for ${ref.key} from ${threadId}; owner ${owner.threadId}; attempt budget reset`);
        requestAutoFixPoll();
      }
      return { ok: true, message: `Auto-fix ${enabled ? "on" : "off"}.` };
    });
  }

  async function pollAutoFix(signal: AbortSignal): Promise<void> {
    const groups = new Map<string, SavedAutoFix[]>();
    const readHosts = new Map<string, string>();
    for (const [key, state] of autoFix) {
      if (!state.enabled) continue;
      const thread = await bb.sdk.threads.get({ threadId: state.ownerThreadId, signal }).catch(() => null);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
        reportAutoFix(key, "Owner unavailable");
        continue;
      }
      const collected = await collect(state.ownerThreadId, signal);
      const ref = collected.refs.find((ref) => ref.url === state.url && ref.sources.some((source) => source.threadId === state.ownerThreadId));
      if (!ref) { reportAutoFix(key, "Waiting for PR link"); continue; }
      const hostId = thread.environmentId ? await hostIdFor(thread.environmentId, signal) : state.hostId;
      if (hostId === null) { reportAutoFix(key, "Machine unavailable"); continue; }
      readHosts.set(state.url, hostId);
      const group = groups.get(hostId) ?? [];
      group.push(state);
      groups.set(hostId, group);
    }
    for (const [hostId, states] of groups) {
      await refreshUrls(hostId, states.map((state) => state.url), signal);
    }
    const sentOwners = new Set<string>();
    for (const [key, state] of autoFix) {
      if (signal.aborted) return;
      if (!state.enabled) continue;
      if (sentOwners.has(state.ownerThreadId)) { reportAutoFix(key, "Waiting for agent"); continue; }
      if (state.attempts >= 3) {
        await saveAutoFix(key, { ...state, enabled: false, stoppedReason: "Stopped after 3 tries" });
        continue;
      }
      const hostId = readHosts.get(state.url);
      if (!hostId) continue;
      const entry = cache.get(cacheKey(hostId, state.url));
      const pr = entry?.status;
      if (!entry || entry.error || Date.now() - entry.fetchedAt >= ttlFor(entry) || !pr) {
        reportAutoFix(key, "GitHub status unavailable"); continue;
      }
      if (pr.state !== "open" && pr.state !== "draft") { reportAutoFix(key, "PR completed"); continue; }
      const threadKey = (thread: NonNullable<PrStatus["reviewThreads"]>[number]) =>
        JSON.stringify([thread.id, thread.lastComment.id]);
      const actionable = (pr.reviewThreads ?? []).filter((thread) =>
        !thread.isResolved && !thread.isOutdated && pr.authorLogin &&
        thread.lastComment.author?.toLowerCase() !== pr.authorLogin.toLowerCase());
      const sentThreadKeys = new Set(state.sentThreadKeys);
      const comments = actionable.filter((thread) => !sentThreadKeys.has(threadKey(thread)));
      // UNKNOWN is GitHub's lazy calculation, never evidence of a conflict.
      const conflictKey = pr.mergeable === "CONFLICTING" && pr.headRefOid && pr.baseRefOid && pr.baseRefName
        ? JSON.stringify([pr.headRefOid, pr.baseRefOid, "conflict"]) : null;
      const conflict = conflictKey !== null && !state.sentConflictKeys.includes(conflictKey);
      const pending = pr.checks.pending > 0 || pr.checks.state === "pending";
      if (!comments.length && !conflict && pending) {
        reportAutoFix(key, pr.mergeable === "UNKNOWN" ? "Waiting for mergeability" : "Waiting for CI"); continue;
      }
      if ((!comments.length && !conflict && pr.checksComplete !== true) || !pr.headRefOid || !pr.headRefName) {
        reportAutoFix(key, "Waiting for complete CI data"); continue;
      }
      const failing = pr.failingChecks ?? [];
      // The review's own count survives later replies and is independent of sampled thread history.
      const latestReview = pr.review === "changes_requested" ? pr.latestChangesRequested : null;
      const review = latestReview?.inlineCommentCount === 0 ? latestReview : null;
      if (!failing.length && !review && !comments.length && !conflict) {
        reportAutoFix(key, latestReview && latestReview.inlineCommentCount === undefined ? "Waiting for review data" : pr.mergeable === "UNKNOWN" ? "Waiting for mergeability" : conflictKey ? "Already requested for this merge conflict" : actionable.length ? "Already requested for these comments" : "No action needed"); continue;
      }
      // Prefer checks when both fail; include the review in the same request.
      const triggerKey = JSON.stringify(failing.length
        ? [pr.headRefOid, "checks", failing.map((check) => check.name).sort()]
        : review ? [pr.headRefOid, "review", review.id] : null);
      if (!comments.length && !conflict && triggerKey === state.lastTriggerKey) { reportAutoFix(key, "Already requested for this commit"); continue; }
      const thread = await bb.sdk.threads.get({ threadId: state.ownerThreadId, signal }).catch(() => null);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null || thread.status !== "idle" ||
          thread.runtime.displayStatus !== "idle" || thread.activeBackgroundAgentCount > 0 || thread.queuedMessageCount > 0) {
        reportAutoFix(key, "Waiting for agent"); continue;
      }
      const text = [
        `[Thread PR Manager plugin · Auto-fix] Fix ${state.url} on branch ${JSON.stringify(pr.headRefName)}.`,
        conflict ? `Merge conflict: the base moved. PR #${pr.number} (${JSON.stringify(pr.title)}) now targets ${JSON.stringify(pr.baseRefName)} (${pr.baseRefOid}). If the previous base of this stacked PR was merged, GitHub may have retargeted it; use the current base named here. Merge the current base ${JSON.stringify(pr.baseRefName)} into ${JSON.stringify(pr.headRefName)} (do not rebase), resolve the conflicts, run the project's checks, and push normally.` : null,
        ...failing.map((check) => `Failing check: ${JSON.stringify(check.name)} — ${check.detailsUrl ?? `${state.url}/checks`}`),
        review ? `Reviewer ${JSON.stringify(review.author ?? "unknown")} requested changes (${review.id}).` : null,
        ...comments.map((thread) => {
          const line = thread.line ?? thread.startLine;
          const location = `${thread.path}:${thread.startLine ?? line ?? "?"}-${line ?? "?"}`;
          const body = thread.firstComment.body;
          return `Review comment: ${location} by ${JSON.stringify(thread.firstComment.author ?? "unknown")}\n${body.slice(0, 600)}${body.length > 600 ? "…" : ""}\n${thread.firstComment.url}`;
        }),
        comments.length
          ? `Check each comment against the code; Copilot comments are often wrong. Fix only the valid ones on ${JSON.stringify(pr.headRefName)} and push. Don't reply on GitHub or resolve threads; don't merge, close or force-push. Reply here with what you fixed and which comments you rejected and why.`
          : conflict ? null : "Fix on that branch, push, and reply with what changed. Don't merge, close or force-push.",
        conflict ? "Don't merge, close or force-push. Reply here with what conflicted and how you resolved it." : null,
      ].filter(Boolean).join("\n");
      const summary = [
        conflict ? "merge conflict" : null,
        failing.length ? `${failing.length} failing check${failing.length === 1 ? "" : "s"}` : null,
        review ? "changes requested" : null,
        comments.length ? `${comments.length} review comment${comments.length === 1 ? "" : "s"}` : null,
      ].filter(Boolean).join(" · ");
      // Reserve before sending: a crash or ambiguous delivery must not repeat the request.
      const next = {
        ...state, attempts: state.attempts + 1,
        lastTriggerKey: failing.length || review ? triggerKey : state.lastTriggerKey,
        sentThreadKeys: [...sentThreadKeys, ...comments.map(threadKey)],
        sentConflictKeys: conflict ? [...state.sentConflictKeys, conflictKey] : state.sentConflictKeys,
      };
      if (next.attempts >= 3) {
        next.enabled = false;
        next.stoppedReason = "Stopped after 3 tries";
      }
      await saveAutoFix(key, next);
      if (signal.aborted) return;
      try {
        await bb.sdk.threads.send({
          threadId: state.ownerThreadId, mode: "start", originPluginId: "thread-prs",
          input: [{ type: "text", text, mentions: [] }],
        });
        sentOwners.add(state.ownerThreadId);
        const sent = { ...next, lastSentAt: Date.now(), lastSentSummary: summary };
        await saveAutoFix(key, sent);
        reportAutoFix(key, autoFixLastSendLabel(sent)!);
      } catch (error) {
        await saveAutoFix(key, { ...next, enabled: false, stoppedReason: next.stoppedReason ?? "Send failed; enable to retry" });
        bb.log.warn(`Auto-fix send failed for ${state.url}: ${errorText(error)}`);
      }
    }
  }

  bb.background.service("auto-fix", {
    async start(signal) {
      // Services may start before the candidate plugin's host entry can be called.
      await waitForAutoFix(TICK_MS, signal);
      while (!signal.aborted) {
        await serializeAutoFix(() => pollAutoFix(signal)).catch((error: unknown) => {
          if (!signal.aborted) bb.log.warn(`Auto-fix poll failed: ${errorText(error)}`);
        });
        await waitForAutoFix(AUTO_FIX_MS, signal);
      }
    },
  });

  async function refreshAfterAction(threadId: string, ref: Ref) {
    cache.delete(cacheKey(ref.hostId, ref.url));
    bb.rpc.experimental_invalidate([THREAD_PRS_TAG]);
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30 * SECOND)]);
    await Promise.all([
      ref.environmentId !== null ? bb.sdk.plugins.callRpc({
        pluginId: PR_STATUS_PLUGIN, method: "refresh", input: { environmentId: ref.environmentId }, outputSchema: z.unknown(),
        signal,
      }).catch(() => undefined) : Promise.resolve(),
      refresh(threadId, signal).catch(() => undefined),
    ]);
    bb.rpc.experimental_invalidate([THREAD_PRS_TAG]);
  }

  async function actionTarget(threadId: string, url: string, signal: AbortSignal) {
    const parsed = parsePrUrl(url);
    if (!parsed) throw new Error("Not a github.com pull request URL.");
    const collected = await collect(threadId, signal);
    const ref = collected.refs.find((ref) => ref.url === parsed.url);
    if (!ref) throw new Error("That pull request is not listed for this thread.");
    if (!ref.hostId) throw new Error("The PR owner's machine is unavailable.");
    return { ref, hostId: ref.hostId };
  }

  async function withPrAction(key: string, work: () => Promise<{ok:boolean;message:string}>) {
    if (prActionsInFlight.has(key)) return { ok: false, message: "Another action is already running for this PR." };
    prActionsInFlight.add(key);
    try { return await work(); }
    catch (error) { return { ok: false, message: errorText(error).slice(0,1000) }; }
    finally { prActionsInFlight.delete(key); }
  }

  async function quickAction(method: "rerunFailedCi" | "requestCopilotReview", input: {threadId:string;url:string;expectedHead?:string}, signal: AbortSignal) {
    try {
      const { ref, hostId } = await actionTarget(input.threadId, input.url, signal);
      return await withPrAction(ref.key, async () => {
        const options = { hostId, signal, timeoutMs: 120 * SECOND };
        const result = method === "rerunFailedCi" && input.expectedHead
          ? await host.call("rerunFailedCi", { url: ref.url, expectedHead: input.expectedHead }, options)
          : method === "requestCopilotReview"
            ? await host.call("requestCopilotReview", { url: ref.url }, options)
            : { ok: false, message: "Refresh the PR's commit before retrying CI." };
        // A slow status reader must not hide a confirmed write behind a timeout.
        void refreshAfterAction(input.threadId, ref).catch(() => undefined);
        return result;
      });
    } catch (error) { return { ok: false, message: errorText(error).slice(0,1000) }; }
  }

  async function prepareMerge(threadId: string, url: string, signal: AbortSignal) {
    try {
      const { ref, hostId } = await actionTarget(threadId, url, signal);
      const result = await host.call("prepareMerge", { url: ref.url }, { hostId, signal, timeoutMs: 30 * SECOND });
      if (!result.ok) return result;
      const now = Date.now();
      for (const [key, entry] of mergeConfirmations) if (entry.expiresAt <= now) mergeConfirmations.delete(key);
      if (mergeConfirmations.size >= 100) mergeConfirmations.delete(mergeConfirmations.keys().next().value!);
      const token = randomUUID();
      const expiresAt = now + 2 * 60 * SECOND;
      mergeConfirmations.set(token, { threadId, url: ref.url, hostId, preview: result.preview, expiresAt });
      return { ok: true as const, confirmation: { token, expiresAt, preview: result.preview } };
    } catch (error) { return { ok: false as const, message: errorText(error).slice(0,1000) }; }
  }

  async function mergePullRequest(token: string, method: MergeMethod, signal: AbortSignal) {
    const entry = mergeConfirmations.get(token);
    mergeConfirmations.delete(token); // One use, including an ambiguously delivered write.
    if (!entry || entry.expiresAt <= Date.now()) return { ok: false, message: "This merge confirmation expired. Open a new confirmation." };
    if (!entry.preview.methods.includes(method)) return { ok: false, message: "That merge method was not offered for this PR." };
    try {
      const { ref, hostId } = await actionTarget(entry.threadId, entry.url, signal);
      if (hostId !== entry.hostId) return { ok: false, message: "The PR's machine changed. Open a new merge confirmation." };
      return await withPrAction(ref.key, async () => {
        const result = await host.call("mergePullRequest", {
          url: ref.url, expectedHead: entry.preview.headRefOid, expectedBase: entry.preview.baseRefOid,
          baseRefName: entry.preview.baseRefName, method,
        }, { hostId, signal, timeoutMs: 30 * SECOND });
        void refreshAfterAction(entry.threadId, ref).catch(() => undefined);
        return result;
      });
    } catch (error) { return { ok: false, message: errorText(error).slice(0,1000) }; }
  }

  async function markReady(threadId: string, url: string): Promise<{ ok: boolean; message: string }> {
    const collected = await collect(threadId);
    const ref = collected.refs.find((candidate) => candidate.url === url);
    const item = assemble(threadId, collected).items.find((candidate) => candidate.url === url);
    if (ref === undefined || item === undefined) {
      return { ok: false, message: "That pull request is not listed for this thread." };
    }
    if (item.status?.state !== "draft") return { ok: false, message: `#${item.number} is not a draft.` };
    if (ref.hostId === null) return { ok: false, message: "No machine to run gh on." };
    const result = await host
      .call("markReady", { url }, { hostId: ref.hostId, signal: lifecycle.signal, timeoutMs: 30 * SECOND })
      .catch((error: unknown) => ({ ok: false, message: errorText(error) }));
    if (!result.ok) return result;
    void refreshAfterAction(threadId, ref).catch(() => undefined);
    return result;
  }

  async function markDraft(threadId: string, url: string): Promise<{ ok: boolean; message: string }> {
    const collected = await collect(threadId);
    const ref = collected.refs.find((candidate) => candidate.url === url);
    const item = assemble(threadId, collected).items.find((candidate) => candidate.url === url);
    if (ref === undefined || item === undefined) {
      return { ok: false, message: "That pull request is not listed for this thread." };
    }
    if (item.status?.state !== "open") {
      return { ok: false, message: `#${item.number} must be open to mark as draft (current state: ${item.status?.state ?? "unknown"}).` };
    }
    if (ref.hostId === null) return { ok: false, message: "No machine to run gh on." };
    const result = await host
      .call("markDraft", { url }, { hostId: ref.hostId, signal: lifecycle.signal, timeoutMs: 30 * SECOND })
      .catch((error: unknown) => ({ ok: false, message: errorText(error) }));
    if (!result.ok) return result;
    void refreshAfterAction(threadId, ref).catch(() => undefined);
    return result;
  }

  bb.rpc.register(
    rpcContract,
    {
      threadPullRequests: async ({ threadId }, context) => {
        const collected = await collect(threadId, context.experimental_signal);
        // PRs never read yet start a refresh; the watcher below normally gets there first.
        if (collected.refs.some((ref) => !cache.has(cacheKey(ref.hostId, ref.url)))) {
          void refresh(threadId).catch(() => undefined);
        }
        return assemble(threadId, collected);
      },
      markReady: ({ threadId, url }) => markReady(threadId, url),
      markDraft: ({ threadId, url }) => markDraft(threadId, url),
      setAutoFix: ({ threadId, url, enabled }) => setAutoFix(threadId, url, enabled),
      rerunFailedCi: (input, context) => quickAction("rerunFailedCi", input, AbortSignal.any([lifecycle.signal, context.experimental_signal])),
      requestCopilotReview: (input, context) => quickAction("requestCopilotReview", input, AbortSignal.any([lifecycle.signal, context.experimental_signal])),
      prepareMerge: ({ threadId, url }, context) => prepareMerge(threadId, url, AbortSignal.any([lifecycle.signal, context.experimental_signal])),
      mergePullRequest: ({ token, method }, context) => mergePullRequest(token, method, AbortSignal.any([lifecycle.signal, context.experimental_signal])),
    },
    { experimental_discoverable: true },
  );

  // Poll only while a client shows the thread: local reads every tick, GitHub only for stale PRs.
  bb.rpc.experimental_whileWatched("threadPullRequests", async (read, signal) => {
    const input = z.object({ threadId: z.string().min(1) }).safeParse("input" in read ? read.input : null);
    if (!input.success) return;
    while (!signal.aborted) {
      await refresh(input.data.threadId, signal).catch((error: unknown) => {
        if (!signal.aborted) bb.log.warn(`refresh failed: ${errorText(error)}`);
      });
      await sleep(TICK_MS, signal);
    }
  });

  const usage = [
    "Usage:",
    "  bb thread-prs list [thread-id] [--json]   PRs of a thread and its descendants (default: this thread)",
    "  bb thread-prs ready <pr-url> [thread-id]  Mark one listed draft PR ready for review",
    "  bb thread-prs draft <pr-url> [thread-id]  Mark one listed open PR as draft",
    "  bb thread-prs autofix <pr-url> on|off [thread-id]  Toggle Auto-fix for one listed PR",
  ].join("\n");

  function formatItem(item: ThreadPr, ownBranchKey: string | null): string {
    const status = item.status;
    const checks = status
      ? status.checks.total === 0
        ? "no checks"
        : `checks ${status.checks.state} ${status.checks.passed}/${status.checks.total}`
      : (item.error ?? "status pending");
    const from = item.sources
      .map((source) =>
        source.isRoot
          ? source.kind === "branch" && item.key === ownBranchKey
            ? "this branch"
            : "linked"
          : `${source.kind === "branch" ? "branch of" : "linked in"} ${source.threadTitle ?? source.threadId}`,
      )
      .join(", ");
    return [
      `${item.repo}#${item.number}`,
      status?.state ?? "…",
      checks,
      status && (status.state === "open" || status.state === "draft") ? `review ${status.review}` : "",
      `[${from}]`,
      `Auto-fix ${item.autoFix.enabled ? autoFixLabel(item.autoFix).replace(/^Auto-fix /, "") : item.autoFix.stoppedReason ?? "off"}`,
      item.autoFix.enabled && item.autoFix.activity ? `[${item.autoFix.activity}]` : "",
      !item.autoFix.enabled && item.autoFix.lastSentAt !== null ? autoFixLastSendLabel(item.autoFix)! : "",
      status?.title ?? "",
    ]
      .filter((part) => part !== "")
      .join("  ");
  }

  bb.cli.register({
    name: "thread-prs",
    summary: "List every pull request a thread and its child threads made",
    commands: [
      { name: "list", summary: "List a thread's PRs with status", usage: "bb thread-prs list [thread-id] [--json]" },
      { name: "autofix", summary: "Toggle Auto-fix for one listed PR", usage: "bb thread-prs autofix <pr-url> on|off [thread-id]" },
      { name: "ready", summary: "Mark one listed draft PR ready", usage: "bb thread-prs ready <pr-url> [thread-id]" },
      { name: "draft", summary: "Mark one listed open PR as draft", usage: "bb thread-prs draft <pr-url> [thread-id]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      switch (command) {
        case undefined:
        case "help":
        case "--help":
        case "-h":
          return { exitCode: 0, stdout: usage };
        case "list": {
          if (args.length > 1) return { exitCode: 1, stderr: usage };
          const threadId = args[0] ?? ctx.threadId;
          if (!threadId) return { exitCode: 1, stderr: `No thread id.\n${usage}` };
          await refresh(threadId, ctx.signal);
          const result = assemble(threadId, await collect(threadId, ctx.signal));
          if (json) return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
          return {
            exitCode: 0,
            stdout: [
              result.items.length === 0
                ? "No pull requests."
                : result.items.map((item) => formatItem(item, result.ownBranchKey)).join("\n"),
              truncationText(result),
            ].filter(Boolean).join("\n"),
          };
        }
        case "autofix": {
          const parsed = args[0] ? parsePrUrl(args[0]) : null;
          const threadId = args[2] ?? ctx.threadId;
          if (parsed === null || !threadId || !["on", "off"].includes(args[1] ?? "") || args.length > 3) {
            return { exitCode: 1, stderr: usage };
          }
          const result = await setAutoFix(threadId, parsed.url, args[1] === "on");
          return result.ok ? { exitCode: 0, stdout: result.message } : { exitCode: 1, stderr: result.message };
        }
        case "ready":
        case "draft": {
          const parsed = args[0] ? parsePrUrl(args[0]) : null;
          const threadId = args[1] ?? ctx.threadId;
          if (parsed === null || !threadId || args.length > 2) return { exitCode: 1, stderr: usage };
          const result = await (command === "ready" ? markReady : markDraft)(threadId, parsed.url);
          return result.ok
            ? { exitCode: 0, stdout: result.message }
            : { exitCode: 1, stderr: result.message };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
