import { execFile } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { commitOidSchema, hostContract, parsePrUrl, type GhRead, type MergeMethod, type MergePreview, type PrStatus } from "./contract.js";

const GH_TIMEOUT_MS = 20_000;

type GhOutput = { code: number; stdout: string; stderr: string };

function runGh(args: string[], signal: AbortSignal): Promise<GhOutput> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        signal,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr) || (error?.message ?? ""),
        });
      },
    );
  });
}

const FIELDS = `number title url state isDraft updatedAt reviewDecision headRefOid headRefName
  reviews(last: 1, states: [CHANGES_REQUESTED]) { nodes { id author { login } } }
  reviewRequests(first: 1) { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
    pageInfo { hasNextPage }
    nodes { __typename ... on CheckRun { name status conclusion startedAt detailsUrl } ... on StatusContext { context state createdAt targetUrl } }
  } } } } }`;

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_STATUS = new Set(["PENDING", "EXPECTED"]);

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;

function toStatus(node: Json): PrStatus | null {
  const number = node.number;
  const url = node.url;
  if (typeof number !== "number" || typeof url !== "string") return null;
  const commit = obj(obj((obj(node.commits)?.nodes as unknown[] | undefined)?.[0])?.commit);
  const contexts = obj(obj(commit?.statusCheckRollup)?.contexts);
  // A re-run leaves the earlier run in the rollup: count each check name once, latest run wins,
  // which is also how bb's PR segment counts, so both show the same numbers.
  const latest = new Map<string, { at: string; pending: boolean; ctx: Json }>();
  let unsettled = false;
  for (const raw of (contexts?.nodes as unknown[] | undefined) ?? []) {
    const ctx = obj(raw);
    if (ctx === null) continue;
    // Queued reruns have no startedAt and can otherwise lose to the old failure.
    // Any unresolved context prevents an automatic fix, even if a newer run exists.
    const pending = ctx.__typename === "CheckRun" ? ctx.status !== "COMPLETED" : PENDING_STATUS.has(String(ctx.state));
    if (pending) {
      unsettled = true;
    }
    const name = String(ctx.__typename === "CheckRun" ? ctx.name : ctx.context);
    const at = String(ctx.startedAt ?? ctx.createdAt ?? "");
    const seen = latest.get(name);
    if (seen === undefined || (pending && !seen.pending) || (pending === seen.pending && at > seen.at)) {
      latest.set(name, { at, pending, ctx });
    }
  }
  const checks = { passed: 0, failed: 0, pending: 0, total: 0 };
  const failingChecks: NonNullable<PrStatus["failingChecks"]> = [];
  for (const [name, { ctx }] of latest) {
    checks.total += 1;
    const failedBefore = checks.failed;
    if (ctx.__typename === "CheckRun") {
      if (ctx.status !== "COMPLETED") checks.pending += 1;
      else if (PASSED.has(String(ctx.conclusion))) checks.passed += 1;
      else checks.failed += 1;
    } else if (ctx.state === "SUCCESS") checks.passed += 1;
    else if (PENDING_STATUS.has(String(ctx.state))) checks.pending += 1;
    else checks.failed += 1;
    if (checks.failed > failedBefore) {
      const link = ctx.detailsUrl ?? ctx.targetUrl;
      failingChecks.push({ name, detailsUrl: typeof link === "string" ? link : null });
    }
  }
  const checksState =
    checks.failed > 0
      ? "failing"
      : checks.pending > 0
        ? "pending"
        : checks.total > 0
          ? "passing"
          : "no_checks";
  const state =
    node.state === "MERGED"
      ? "merged"
      : node.state === "CLOSED"
        ? "closed"
        : node.isDraft === true
          ? "draft"
          : "open";
  const requested = Number(obj(node.reviewRequests)?.totalCount ?? 0);
  const review =
    node.reviewDecision === "APPROVED"
      ? "approved"
      : node.reviewDecision === "CHANGES_REQUESTED"
        ? "changes_requested"
        : node.reviewDecision === "REVIEW_REQUIRED"
          ? requested > 0
            ? "review_requested"
            : "review_required"
          : "none";
  return {
    number,
    url,
    title: typeof node.title === "string" ? node.title : "",
    state,
    checks: { state: checksState, ...checks },
    review,
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : new Date(0).toISOString(),
    headRefOid: typeof node.headRefOid === "string" ? node.headRefOid : undefined,
    headRefName: typeof node.headRefName === "string" ? node.headRefName : undefined,
    failingChecks,
    // An incomplete rollup cannot establish that every check has finished.
    checksComplete: !unsettled && commit !== null &&
      (commit.statusCheckRollup === null || obj(contexts?.pageInfo)?.hasNextPage === false),
    latestChangesRequested: (() => {
      const review = obj((obj(node.reviews)?.nodes as unknown[] | undefined)?.[0]);
      if (typeof review?.id !== "string") return null;
      const author = obj(review.author)?.login;
      return { id: review.id, author: typeof author === "string" ? author : null };
    })(),
  };
}

function firstLine(text: string): string {
  return (text.trim().split("\n").find((line) => line.trim() !== "")?.trim() ?? "gh failed").slice(0,500);
}

async function fetchPullRequests(
  urls: string[],
  signal: AbortSignal,
): Promise<Record<string, GhRead>> {
  const results: Record<string, GhRead> = {};
  const valid = urls.filter((url) => {
    if (parsePrUrl(url)) return true;
    results[url] = { ok: false, message: "Not a github.com pull request URL" };
    return false;
  });
  if (valid.length === 0) return results;
  const query = `query {\n${valid
    .map((url, index) => `p${index}: resource(url: ${JSON.stringify(url)}) { ... on PullRequest { ${FIELDS} } }`)
    .join("\n")}\n}`;
  const out = await runGh(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`], signal);
  let parsed: Json | null = null;
  try {
    parsed = obj(JSON.parse(out.stdout));
  } catch {
    parsed = null;
  }
  const data = obj(parsed?.data);
  if (data === null) {
    const message = firstLine(out.stderr || out.stdout);
    for (const url of valid) results[url] = { ok: false, message };
    return results;
  }
  // A partial GraphQL error (one PR not found or not visible) nulls only its alias.
  const errors = Array.isArray(parsed?.errors) ? (parsed.errors as unknown[]) : [];
  if (out.code !== 0 && errors.length === 0) {
    for (const url of valid) results[url] = { ok: false, message: firstLine(out.stderr || "gh failed") };
    return results;
  }
  valid.forEach((url, index) => {
    const alias = `p${index}`;
    const node = obj(data[alias]);
    const error = errors
      .map(obj)
      .find((entry) => !Array.isArray(entry?.path) || entry.path[0] === alias);
    const status = node === null || error ? null : toStatus(node);
    if (status !== null) {
      results[url] = { ok: true, pr: status };
      return;
    }
    results[url] = {
      ok: false,
      message: typeof error?.message === "string" ? error.message : "GitHub returned no pull request",
    };
  });
  return results;
}

const repositorySchema = z.object({
  nameWithOwner: z.string(), viewerPermission: z.string().nullable(),
  mergeCommitAllowed: z.boolean(), squashMergeAllowed: z.boolean(), rebaseMergeAllowed: z.boolean(),
});
const actionPrSchema = z.object({
  number: z.number().int().positive(), url: z.string(), title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]), isDraft: z.boolean(),
  headRefOid: commitOidSchema, headRefName: z.string().min(1),
  baseRefOid: commitOidSchema, baseRefName: z.string().min(1),
  mergeable: z.string(), mergeStateStatus: z.string(), reviewDecision: z.string().nullable(),
  repository: repositorySchema,
}).passthrough();
type ActionPr = z.infer<typeof actionPrSchema> & { status: PrStatus };

async function readActionPr(url: string, signal: AbortSignal): Promise<ActionPr> {
  const parsed = parsePrUrl(url);
  if (!parsed) throw new Error("Not a github.com pull request URL");
  const fields = `${FIELDS} baseRefOid baseRefName mergeable mergeStateStatus
    repository { nameWithOwner viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed }`;
  const query = `query { resource(url: ${JSON.stringify(parsed.url)}) { ... on PullRequest { ${fields} } } }`;
  const out = await runGh(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`], signal);
  let body: Json | null = null;
  try { body = obj(JSON.parse(out.stdout)); } catch { /* Report the failed read below. */ }
  if (out.code !== 0 || !body || (Array.isArray(body.errors) && body.errors.length)) {
    throw new Error(firstLine(out.stderr || "Could not read current PR state from GitHub."));
  }
  const node = actionPrSchema.safeParse(obj(body.data)?.resource);
  const status = node.success ? toStatus(node.data) : null;
  if (!node.success || !status || parsePrUrl(node.data.url)?.url !== parsed.url ||
      node.data.number !== parsed.number || node.data.repository.nameWithOwner.toLowerCase() !== parsed.repo) {
    throw new Error("GitHub returned incomplete or mismatched PR details. Refresh and try again.");
  }
  return { ...node.data, status };
}

function requireOpen(pr: ActionPr, expectedHead?: string) {
  if (pr.state !== "OPEN") throw new Error("This pull request is no longer open.");
  if (expectedHead && pr.headRefOid !== expectedHead) throw new Error("The PR head changed. Refresh and try again.");
}

async function api(method: "GET" | "POST" | "PUT", endpoint: string, signal: AbortSignal, fields: Record<string,string> = {}) {
  signal.throwIfAborted();
  const args = ["api", "--hostname", "github.com", "--method", method, endpoint,
    "-H", "X-GitHub-Api-Version: 2026-03-10"];
  if (method !== "GET") args.push("--include");
  for (const [name, value] of Object.entries(fields)) args.push("-f", `${name}=${value}`);
  return runGh(args, signal);
}

function httpStatus(out: GhOutput): number | undefined {
  const statuses = [...out.stdout.matchAll(/^HTTP\/[\d.]+\s+(\d{3})/gm)];
  return statuses.length ? Number(statuses.at(-1)?.[1]) : undefined;
}

function mergeBlockReason(pr: ActionPr): string | null {
  if (pr.state !== "OPEN" || pr.isDraft) return "Only an open, non-draft pull request can be merged.";
  if (!["WRITE", "MAINTAIN", "ADMIN"].includes(pr.repository.viewerPermission ?? "")) return "Your GitHub account has no merge permission.";
  if (pr.mergeable !== "MERGEABLE") return pr.mergeable === "CONFLICTING" ? "Resolve merge conflicts first." : "GitHub is still calculating mergeability. Try again shortly.";
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") return "Required reviews are not satisfied.";
  if (!pr.status.checksComplete || pr.status.checks.pending > 0 || pr.status.checks.failed > 0) return "Wait for complete, passing CI checks before merging.";
  if (pr.mergeStateStatus !== "CLEAN") return `GitHub reports ${pr.mergeStateStatus.toLowerCase()} merge readiness. Check the PR rules or merge queue on GitHub.`;
  return null;
}

function mergePreview(pr: ActionPr): MergePreview {
  const reason = mergeBlockReason(pr);
  if (reason) throw new Error(reason);
  const methods: MergeMethod[] = [];
  if (pr.repository.squashMergeAllowed) methods.push("squash");
  if (pr.repository.mergeCommitAllowed) methods.push("merge");
  if (pr.repository.rebaseMergeAllowed) methods.push("rebase");
  if (!methods.length) throw new Error("This repository has no available merge method.");
  return { url: pr.url, title: pr.title, repo: pr.repository.nameWithOwner, number: pr.number,
    headRefName: pr.headRefName, headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName, baseRefOid: pr.baseRefOid, methods };
}

const runIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const workflowRunSchema = z.object({
  id: runIdSchema, workflow_id: runIdSchema, run_number: runIdSchema, run_attempt: runIdSchema,
  head_sha: commitOidSchema, head_branch: z.string().nullable(), event: z.string(),
  status: z.string(), conclusion: z.string().nullable(), created_at: z.string(),
  repository: z.object({ full_name: z.string() }),
});
type WorkflowRun = z.infer<typeof workflowRunSchema>;
const failedRun = (run: WorkflowRun) => run.status === "completed" && ["failure", "timed_out"].includes(run.conclusion ?? "");

async function failedRuns(repo: string, pr: ActionPr, signal: AbortSignal): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  let total = Infinity;
  for (let page = 1; page <= 10 && runs.length < total; page++) {
    const out = await api("GET", `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&per_page=100&page=${page}`, signal);
    if (out.code !== 0) throw new Error(firstLine(out.stderr));
    const result = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(workflowRunSchema) }).parse(JSON.parse(out.stdout));
    total = result.total_count;
    runs.push(...result.workflow_runs);
    if (!result.workflow_runs.length) break;
  }
  if (runs.length < total) throw new Error("Too many workflow runs to inspect completely. Use GitHub Actions for this PR.");
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (run.head_sha !== pr.headRefOid || run.head_branch !== pr.headRefName || run.repository.full_name.toLowerCase() !== repo.toLowerCase()) continue;
    const key = `${run.workflow_id}:${run.event}`;
    const previous = latest.get(key);
    if (!previous || run.run_number > previous.run_number || (run.run_number === previous.run_number && run.id > previous.id)) latest.set(key, run);
  }
  const failed = [...latest.values()].filter(failedRun);
  if (failed.length > 10) throw new Error("More than 10 workflows failed. Re-run them from GitHub Actions.");
  return failed;
}

async function rerunFailedCi(url: string, expectedHead: string, signal: AbortSignal) {
  const pr = await readActionPr(url, signal);
  requireOpen(pr, expectedHead);
  const repo = pr.repository.nameWithOwner;
  const runs = await failedRuns(repo, pr, signal);
  if (!runs.length) return { ok: false, message: "No failed GitHub Actions runs on this PR's current commit." };
  let sent = 0;
  const failures: string[] = [];
  for (const run of runs) {
    try {
      const read = await api("GET", `repos/${repo}/actions/runs/${run.id}`, signal);
      if (read.code !== 0) throw new Error(firstLine(read.stderr || "Could not read the current workflow run."));
      const current = workflowRunSchema.safeParse(JSON.parse(read.stdout));
      if (!current.success) throw new Error("GitHub returned incomplete workflow run details. Refresh and try again.");
      const latest = current.data;
      if (latest.id !== run.id || latest.head_sha !== expectedHead || latest.head_branch !== pr.headRefName || latest.repository.full_name.toLowerCase() !== repo.toLowerCase() || !failedRun(latest)) {
        failures.push(`Run ${run.id} changed; skipped`); continue;
      }
      const created = Date.parse(latest.created_at);
      if (!Number.isFinite(created) || Date.now() - created > 30 * 24 * 60 * 60 * 1000 || latest.run_attempt >= 50) {
        failures.push(`Run ${run.id} is outside GitHub's rerun limits`); continue;
      }
      requireOpen(await readActionPr(url, signal), expectedHead);
      const out = await api("POST", `repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`, signal);
      if (out.code !== 0) failures.push(`Run ${run.id}: ${firstLine(out.stderr)}`);
      else sent++;
    } catch (error) {
      failures.push(firstLine(error instanceof Error ? error.message : String(error)));
      break;
    }
  }
  return { ok: sent > 0 && !failures.length,
    message: `${sent} workflow${sent === 1 ? "" : "s"} requested for re-run.${failures.length ? ` ${failures.slice(0,3).join("; ")}` : ""}` };
}

const actionInFlight = new Set<string>();
async function writeAction(url: string, work: () => Promise<{ok:boolean;message:string}>) {
  const key = parsePrUrl(url)?.url;
  if (!key) return { ok: false, message: "Not a github.com pull request URL" };
  if (actionInFlight.has(key)) return { ok: false, message: "Another action is already running for this PR." };
  actionInFlight.add(key);
  try { return await work(); }
  catch (error) { return { ok: false, message: firstLine(error instanceof Error ? error.message : String(error)) }; }
  finally { actionInFlight.delete(key); }
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    fetchPullRequests: async ({ urls }, context) => ({
      results: await fetchPullRequests(urls, context.signal),
    }),
    markReady: async ({ url }, context) => {
      if (!parsePrUrl(url)) return { ok: false, message: "Not a github.com pull request URL" };
      const out = await runGh(["pr", "ready", url], context.signal);
      return out.code === 0
        ? { ok: true, message: firstLine(out.stdout || out.stderr || "Marked ready") }
        : { ok: false, message: firstLine(out.stderr || out.stdout) };
    },
    rerunFailedCi: ({ url, expectedHead }, context) => writeAction(url, () => rerunFailedCi(url, expectedHead, context.signal)),
    requestCopilotReview: ({ url }, context) => writeAction(url, async () => {
      const pr = await readActionPr(url, context.signal);
      requireOpen(pr);
      const out = await api("POST", `repos/${pr.repository.nameWithOwner}/pulls/${pr.number}/copilot-code-review`, context.signal);
      if (httpStatus(out) === 409) return { ok: true, message: "A Copilot review is already pending." };
      return out.code === 0 ? { ok: true, message: "Copilot review requested." } : { ok: false, message: firstLine(out.stderr || out.stdout) };
    }),
    prepareMerge: async ({ url }, context) => {
      try { return { ok: true as const, preview: mergePreview(await readActionPr(url, context.signal)) }; }
      catch (error) { return { ok: false as const, message: firstLine(error instanceof Error ? error.message : String(error)) }; }
    },
    mergePullRequest: ({ url, expectedHead, expectedBase, baseRefName, method }, context) => writeAction(url, async () => {
      const pr = await readActionPr(url, context.signal);
      requireOpen(pr, expectedHead);
      if (pr.baseRefName !== baseRefName || pr.baseRefOid !== expectedBase) return { ok: false, message: "The target branch changed. Open a new merge confirmation." };
      const preview = mergePreview(pr);
      if (!preview.methods.includes(method)) return { ok: false, message: "This merge method is no longer allowed by the repository." };
      const out = await api("PUT", `repos/${pr.repository.nameWithOwner}/pulls/${pr.number}/merge`, context.signal, { sha: expectedHead, merge_method: method });
      if (out.code !== 0) return { ok: false, message: firstLine(out.stderr || out.stdout) };
      const body = out.stdout.split(/\r?\n\r?\n/).at(-1) ?? "";
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const result = z.object({ merged: z.boolean(), message: z.string() }).safeParse(parsed);
      return result.success && result.data.merged ? { ok: true, message: `Merged #${pr.number} into ${pr.baseRefName}.` } : { ok: false, message: result.success ? result.data.message : "GitHub did not confirm the merge. Refresh the PR before trying again." };
    }),
  },
});
