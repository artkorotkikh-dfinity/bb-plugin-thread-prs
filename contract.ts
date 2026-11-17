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
});
export type PrStatus = z.infer<typeof prStatusSchema>;

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
  status: prStatusSchema.nullable(),
  /** Set when GitHub could not be read for this PR; `status` may still hold the last good read. */
  error: z.string().nullable(),
  /** Where `status` came from: our own gh read, or bb's GitHub PR Status plugin. */
  statusSource: z.enum(["gh", "github-pr-status"]).nullable(),
  fetchedAt: z.number().nullable(),
});
export type ThreadPr = z.infer<typeof threadPrSchema>;

export const threadPrsSchema = z.object({
  threadId: z.string(),
  items: z.array(threadPrSchema),
  /** The root thread's own current-branch PR key, which bb's PR segment already shows. */
  ownBranchKey: z.string().nullable(),
});
export type ThreadPrs = z.infer<typeof threadPrsSchema>;

export const THREAD_PRS_TAG = "thread-prs";

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
});
