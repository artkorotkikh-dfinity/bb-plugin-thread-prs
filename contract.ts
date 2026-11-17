import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const prStateSchema = z.enum(["draft", "open", "merged", "closed"]);
export const checksStateSchema = z.enum([
  "passing",
  "failing",
  "pending",
  "no_checks",
]);
export const reviewStateSchema = z.enum([
  "approved",
  "changes_requested",
  "review_required",
  "review_requested",
  "none",
]);

export const reviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().int().nullable(),
  startLine: z.number().int().nullable(),
  lastComment: z.object({ id: z.string(), author: z.string().nullable(), body: z.string(), url: z.string() }),
});

export const prStatusSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: prStateSchema,
  checks: z.object({
    state: checksStateSchema,
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  review: reviewStateSchema,
  updatedAt: z.string(),
  headRefOid: z.string().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  baseRefOid: z.string().optional(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).optional(),
  mergeStateStatus: z.string().optional(),
  failingChecks: z.array(z.object({ name: z.string(), detailsUrl: z.string().nullable() })).optional(),
  checksComplete: z.boolean().optional(),
  latestChangesRequested: z.object({ id: z.string(), author: z.string().nullable(), inlineCommentCount: z.number().int().nonnegative().optional() }).nullable().optional(),
  authorLogin: z.string().nullable().optional(),
  reviewThreads: z.array(reviewThreadSchema).optional(),
  /** All unresolved review conversations, including outdated ones; null until a complete read. */
  unresolvedReviewThreadCount: z.number().int().nonnegative().nullable().optional(),
});
export type PrStatus = z.infer<typeof prStatusSchema>;

/** Only github.com PRs are supported; canonical casing also stabilizes cache keys. */
export function parsePrUrl(url: string): { repo: string; number: number; url: string } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

export const autoFixSchema = z.object({
  enabled: z.boolean(),
  ownerThreadId: z.string(),
  attempts: z.number().int().min(0).max(3),
  lastTriggerKey: z.string().nullable(),
  lastSentAt: z.number().nullable(),
  stoppedReason: z.string().nullable(),
  sentThreadKeys: z.array(z.string()).default([]),
  sentConflictKeys: z.array(z.string()).default([]),
  lastSentSummary: z.string().nullable().default(null),
});
export type AutoFix = z.infer<typeof autoFixSchema>;

export function autoFixLabel(state: AutoFix): string {
  if (state.stoppedReason) return state.stoppedReason;
  if (!state.enabled) return "Auto-fix";
  return autoFixLastSendLabel(state) ?? "Auto-fix on";
}

export function autoFixLastSendLabel(state: AutoFix): string | null {
  if (state.lastSentAt !== null) {
    const time = new Date(state.lastSentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return `Sent ${time} (${state.attempts}/3)${state.lastSentSummary ? ` · ${state.lastSentSummary}` : ""}`;
  }
  return null;
}

export const prSourceSchema = z.object({
  kind: z.enum(["branch", "link"]),
  threadId: z.string(),
  threadTitle: z.string().nullable(),
  isRoot: z.boolean(),
});
export type PrSource = z.infer<typeof prSourceSchema>;

export const threadPrSchema = z.object({
  /** `owner/repo#number`, lowercase repo: the dedupe key. */
  key: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  sources: z.array(prSourceSchema),
  status: prStatusSchema.omit({ reviewThreads: true }).nullable(),
  /** Set when GitHub could not be read for this PR; `status` may still hold the last good read. */
  error: z.string().nullable(),
  /** Where `status` came from: our own gh read, or bb's GitHub PR Status plugin. */
  statusSource: z.enum(["gh", "github-pr-status"]).nullable(),
  fetchedAt: z.number().nullable(),
  autoFix: autoFixSchema.extend({ ownerThreadTitle: z.string().nullable(), activity: z.string().nullable() }),
});
export type ThreadPr = z.infer<typeof threadPrSchema>;

export const threadPrsSchema = z.object({
  threadId: z.string(),
  items: z.array(threadPrSchema),
  truncated: z.boolean(),
  truncationReason: z.enum(["threads", "pullRequests"]).nullable(),
  /** The root thread's own current-branch PR key, which bb's PR segment already shows. */
  ownBranchKey: z.string().nullable(),
});
export type ThreadPrs = z.infer<typeof threadPrsSchema>;

export function truncationText(data: ThreadPrs): string | null {
  if (!data.truncated) return null;
  return data.truncationReason === "pullRequests"
    ? "Only the first 50 pull requests are shown"
    : "Only the first 200 threads were read";
}

export const THREAD_PRS_TAG = "thread-prs";

export const actionResultSchema = z.object({ ok: z.boolean(), message: z.string() });
export const commitOidSchema = z.string().regex(/^[a-f0-9]{40}$/i);
export const mergeMethodSchema = z.enum(["squash", "merge", "rebase"]);
export type MergeMethod = z.infer<typeof mergeMethodSchema>;
export const mergePreviewSchema = z.object({
  url: z.string().url(), title: z.string(), repo: z.string(), number: z.number().int().positive(),
  headRefName: z.string(), headRefOid: commitOidSchema,
  baseRefName: z.string(), baseRefOid: commitOidSchema,
  methods: z.array(mergeMethodSchema).min(1),
});
export type MergePreview = z.infer<typeof mergePreviewSchema>;
const prepareMergeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), preview: mergePreviewSchema }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export const confirmedMergeSchema = z.object({
  token: z.string().uuid(), expiresAt: z.number(), preview: mergePreviewSchema,
});
export type ConfirmedMerge = z.infer<typeof confirmedMergeSchema>;
const threadPrInputSchema = z.object({ threadId: z.string().min(1), url: z.string().url() }).strict();

export const rpcContract = defineRpcContract({
  threadPullRequests: {
    experimental_description:
      "Every GitHub pull request a thread and its descendant threads linked on Focus Board or have as an environment's current-branch PR, with cached status.",
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadPrsSchema,
    tags: (input) => [THREAD_PRS_TAG, `${THREAD_PRS_TAG}:${input.threadId}`],
  },
  markReady: {
    experimental_description:
      "Mark one draft pull request listed for a thread ready for review (gh pr ready).",
    input: z
      .object({
        threadId: z.string().min(1),
        url: z.string().url(),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  markDraft: {
    experimental_description:
      "Mark one open pull request listed for a thread as draft (gh pr ready --undo).",
    input: threadPrInputSchema,
    output: actionResultSchema,
  },
  setAutoFix: {
    input: z.object({ threadId: z.string().min(1), url: z.string().url(), enabled: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  rerunFailedCi: {
    input: threadPrInputSchema.extend({ expectedHead: commitOidSchema }).strict(),
    output: actionResultSchema,
  },
  requestCopilotReview: { input: threadPrInputSchema, output: actionResultSchema },
  prepareMerge: {
    input: threadPrInputSchema,
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), confirmation: confirmedMergeSchema }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  mergePullRequest: {
    input: z.object({ token: z.string().uuid(), method: mergeMethodSchema }).strict(),
    output: actionResultSchema,
  },
});

const ghReadSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), pr: prStatusSchema }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type GhRead = z.infer<typeof ghReadSchema>;

export const hostContract = defineRpcContract({
  fetchPullRequests: {
    experimental_retryable: true,
    input: z
      .object({ urls: z.array(z.string().url()).min(1).max(50) })
      .strict(),
    output: z.object({ results: z.record(z.string(), ghReadSchema) }),
  },
  markReady: {
    input: z.object({ url: z.string().url() }).strict(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  markDraft: {
    input: z.object({ url: z.string().url() }).strict(),
    output: actionResultSchema,
  },
  rerunFailedCi: {
    input: z.object({ url: z.string().url(), expectedHead: commitOidSchema }).strict(),
    output: actionResultSchema,
  },
  requestCopilotReview: {
    input: z.object({ url: z.string().url() }).strict(), output: actionResultSchema,
  },
  prepareMerge: {
    experimental_retryable: true,
    input: z.object({ url: z.string().url() }).strict(), output: prepareMergeResultSchema,
  },
  mergePullRequest: {
    input: z.object({
      url: z.string().url(), expectedHead: commitOidSchema, expectedBase: commitOidSchema,
      baseRefName: z.string().min(1), method: mergeMethodSchema,
    }).strict(),
    output: actionResultSchema,
  },
});
