import { execFile } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, parsePrUrl, type GhRead, type PrStatus } from "./contract.js";

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
  return text.trim().split("\n").find((line) => line.trim() !== "")?.trim() ?? "gh failed";
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
  },
});
