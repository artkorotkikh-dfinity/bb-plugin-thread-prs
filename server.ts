// Thread PRs: every pull request a thread and its descendant threads made.
//
// Sources, deduplicated by repo#number:
//   1. Focus Board links (thread metadata, namespace "focus-board", key "linkedIssues").
//   2. bb--github-pr-status: each environment's current-branch PR.
// Status comes from one batched `gh api graphql` call on the thread's machine,
// cached here with state-dependent TTLs. Watchers refresh visible lists; a
// background service also refreshes PRs explicitly enabled for Auto-fix.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  autoFixLabel,
  autoFixSchema,
  hostContract,
  prStateSchema,
  reviewStateSchema,
  rpcContract,
  THREAD_PRS_TAG,
  truncationText,
  type AutoFix,
  type PrSource,
  type PrStatus,
  type ThreadPr,
  type ThreadPrs,
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

const GITHUB_PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

function parsePrUrl(url: string): { repo: string; number: number; url: string } | null {
  const match = GITHUB_PR_URL.exec(url);
  if (match === null) return null;
  const [, owner, name, num] = match;
  const repo = `${owner}/${name}`;
  const number = Number(num);
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

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
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const cache = new Map<string, CacheEntry>();
  const hostByEnvironment = new Map<string, string | null>();
  const lastSignature = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  const hostReads = new Map<string | null, Promise<unknown>>();
  const autoFix = new Map<string, SavedAutoFix>();
  for (const key of await bb.storage.kv.list(AUTO_FIX_PREFIX)) {
    const parsed = savedAutoFixSchema.safeParse(await bb.storage.kv.get(key));
    const pr = parsed.success ? parsePrUrl(parsed.data.url) : null;
    if (parsed.success && pr && key === `${AUTO_FIX_PREFIX}${prKey(pr.repo, pr.number)}`) {
      autoFix.set(prKey(pr.repo, pr.number), parsed.data);
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

  function autoFixFor(ref: Ref): AutoFix & { ownerThreadTitle: string | null } {
    const owner = ownerOf(ref);
    const saved = autoFix.get(ref.key);
    return {
      ...(saved ? autoFixSchema.parse(saved) : {
        enabled: false, ownerThreadId: owner.threadId, attempts: 0,
        lastTriggerKey: null, lastSentAt: null, stoppedReason: null,
      }),
      ownerThreadTitle: ref.sources.find((source) => source.threadId === (saved?.ownerThreadId ?? owner.threadId))?.threadTitle ?? null,
    };
  }

  async function hostIdFor(environmentId: string, signal?: AbortSignal): Promise<string | null> {
    if (hostByEnvironment.has(environmentId)) return hostByEnvironment.get(environmentId) ?? null;
    const environment = await bb.sdk.environments.get({ environmentId, signal }).catch(() => null);
    const hostId = environment?.hostId ?? null;
    hostByEnvironment.set(environmentId, hostId);
    return hostId;
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
        ref = { key, ...parsed, sources: [], builtin: null, environmentId: null };
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

    return { refs: [...refs.values()], ownBranchKey, hostId, truncationReason };
  }

  function assemble(threadId: string, collected: Collected): ThreadPrs {
    const items: ThreadPr[] = collected.refs.map((ref) => {
      const entry = cache.get(ref.url);
      const status = newer(ref.builtin, entry?.status ?? null);
      return {
        key: ref.key,
        repo: ref.repo,
        number: ref.number,
        url: ref.url,
        sources: ref.sources,
        status,
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
          const entry = cache.get(url);
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
            ({ results } = await host.call(
              "fetchPullRequests",
              { urls: stale },
              { hostId, signal, timeoutMs: 30 * SECOND },
            ));
          } catch (error) {
            if (signal?.aborted) return false;
            failure = errorText(error);
            bb.log.warn(`gh read failed: ${failure}`);
          }
        }
        for (const url of stale) {
          const read = results[url];
          const previous = cache.get(url);
          const next: CacheEntry =
            read?.ok === true
              ? { status: read.pr, error: null, fetchedAt: Date.now() }
              : {
                  status: previous?.status ?? null,
                  error: failure ?? (read?.ok === false ? read.message : "No answer from gh."),
                  fetchedAt: Date.now(),
                };
          if (store(url, next)) changed = true;
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
      const collected = await collect(threadId, signal);
      await refreshUrls(collected.hostId, collected.refs.map((ref) => ref.url), signal);
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
      const collected = await collect(threadId);
      const ref = parsed === null ? undefined : collected.refs.find((candidate) => candidate.key === prKey(parsed.repo, parsed.number));
      if (!ref) return { ok: false, message: "That pull request is not listed for this thread." };
      const previous = autoFix.get(ref.key);
      if (enabled && previous?.enabled) return { ok: true, message: "Auto-fix is already on." };
      const owner = ownerOf(ref);
      if (enabled) {
        await refreshUrls(collected.hostId, [ref.url]);
        const status = newer(ref.builtin, cache.get(ref.url)?.status ?? null);
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
        url: ref.url, hostId: hostId ?? collected.hostId,
      } : {
        ...(previous ?? { ownerThreadId: owner.threadId, attempts: 0, lastTriggerKey: null, lastSentAt: null, url: ref.url, hostId: null }),
        enabled: false, stoppedReason: null,
      });
      return { ok: true, message: `Auto-fix ${enabled ? "on" : "off"}.` };
    });
  }

  async function pollAutoFix(signal: AbortSignal): Promise<void> {
    const groups = new Map<string, SavedAutoFix[]>();
    for (const state of autoFix.values()) {
      if (!state.enabled) continue;
      const thread = await bb.sdk.threads.get({ threadId: state.ownerThreadId, signal }).catch(() => null);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) continue;
      const hostId = (thread.environmentId ? await hostIdFor(thread.environmentId, signal) : null) ?? state.hostId;
      if (hostId === null) continue;
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
      if (!state.enabled || sentOwners.has(state.ownerThreadId)) continue;
      if (state.attempts >= 3) {
        await saveAutoFix(key, { ...state, enabled: false, stoppedReason: "Stopped after 3 tries" });
        continue;
      }
      const entry = cache.get(state.url);
      const pr = entry?.status;
      if (!entry || entry.error || Date.now() - entry.fetchedAt >= ttlFor(entry) || !pr ||
          (pr.state !== "open" && pr.state !== "draft") || pr.checks.pending > 0 ||
          pr.checks.state === "pending" || pr.checksComplete !== true || !pr.headRefOid || !pr.headRefName) continue;
      const failing = pr.failingChecks ?? [];
      const review = pr.review === "changes_requested" ? pr.latestChangesRequested : null;
      if (!failing.length && !review) continue;
      // Prefer checks when both fail; include the review in the same request.
      const triggerKey = JSON.stringify(failing.length
        ? [pr.headRefOid, "checks", failing.map((check) => check.name).sort()]
        : [pr.headRefOid, "review", review!.id]);
      if (triggerKey === state.lastTriggerKey) continue;
      const thread = await bb.sdk.threads.get({ threadId: state.ownerThreadId, signal }).catch(() => null);
      if (!thread || thread.archivedAt !== null || thread.deletedAt !== null || thread.status !== "idle" ||
          thread.runtime.displayStatus !== "idle" || thread.activeBackgroundAgentCount > 0 || thread.queuedMessageCount > 0) continue;
      const text = [
        `[Thread PRs plugin · Auto-fix] Fix ${state.url} on branch ${JSON.stringify(pr.headRefName)}.`,
        ...failing.map((check) => `Failing check: ${JSON.stringify(check.name)} — ${check.detailsUrl ?? `${state.url}/checks`}`),
        review ? `Reviewer ${JSON.stringify(review.author ?? "unknown")} requested changes (${review.id}).` : null,
        "Fix on that branch, push, and reply with what changed. Don't merge, close or force-push.",
      ].filter(Boolean).join("\n");
      // Reserve before sending: a crash or ambiguous delivery must not repeat the request.
      const next = { ...state, attempts: state.attempts + 1, lastTriggerKey: triggerKey };
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
        await saveAutoFix(key, { ...next, lastSentAt: Date.now() });
      } catch (error) {
        await saveAutoFix(key, { ...next, enabled: false, stoppedReason: next.stoppedReason ?? "Send failed; enable to retry" });
        bb.log.warn(`Auto-fix send failed for ${state.url}: ${errorText(error)}`);
      }
    }
  }

  bb.background.service("auto-fix", {
    async start(signal) {
      while (!signal.aborted) {
        await serializeAutoFix(() => pollAutoFix(signal)).catch((error: unknown) => {
          if (!signal.aborted) bb.log.warn(`Auto-fix poll failed: ${errorText(error)}`);
        });
        await sleep(AUTO_FIX_MS, signal);
      }
    },
  });

  async function markReady(threadId: string, url: string): Promise<{ ok: boolean; message: string }> {
    const collected = await collect(threadId);
    const ref = collected.refs.find((candidate) => candidate.url === url);
    const item = assemble(threadId, collected).items.find((candidate) => candidate.url === url);
    if (ref === undefined || item === undefined) {
      return { ok: false, message: "That pull request is not listed for this thread." };
    }
    if (item.status?.state !== "draft") return { ok: false, message: `#${item.number} is not a draft.` };
    if (collected.hostId === null) return { ok: false, message: "No machine to run gh on." };
    const result = await host
      .call("markReady", { url }, { hostId: collected.hostId, timeoutMs: 30 * SECOND })
      .catch((error: unknown) => ({ ok: false, message: errorText(error) }));
    if (!result.ok) return result;
    cache.delete(url);
    // bb's own PR segment shows the same PR when it is an environment's branch PR: let it catch up too.
    if (ref.environmentId !== null) {
      await bb.sdk.plugins
        .callRpc({
          pluginId: PR_STATUS_PLUGIN,
          method: "refresh",
          input: { environmentId: ref.environmentId },
          outputSchema: z.unknown(),
        })
        .catch(() => undefined);
    }
    await refresh(threadId).catch(() => undefined);
    bb.rpc.experimental_invalidate([`${THREAD_PRS_TAG}:${threadId}`]);
    return result;
  }

  bb.rpc.register(
    rpcContract,
    {
      threadPullRequests: async ({ threadId }, context) => {
        const collected = await collect(threadId, context.experimental_signal);
        // PRs never read yet start a refresh; the watcher below normally gets there first.
        if (collected.refs.some((ref) => !cache.has(ref.url))) {
          void refresh(threadId).catch(() => undefined);
        }
        return assemble(threadId, collected);
      },
      markReady: ({ threadId, url }) => markReady(threadId, url),
      setAutoFix: ({ threadId, url, enabled }) => setAutoFix(threadId, url, enabled),
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
        case "ready": {
          const parsed = args[0] ? parsePrUrl(args[0]) : null;
          const threadId = args[1] ?? ctx.threadId;
          if (parsed === null || !threadId) return { exitCode: 1, stderr: usage };
          const result = await markReady(threadId, parsed.url);
          return result.ok
            ? { exitCode: 0, stdout: result.message }
            : { exitCode: 1, stderr: result.message };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
