---
name: thread-prs
description: List every GitHub pull request this thread and its child threads made, with state, checks and review, or mark one of them ready or as draft. Use when asked which PRs a thread opened or worked on, or for the status of all of them at once.
---

# Thread PR Manager

`bb thread-prs list [thread-id] [--json]` prints every PR of a thread and its
descendant threads: Focus Board links plus each environment's current-branch PR,
deduplicated by `owner/repo#number`. Without a thread id it uses the calling thread.

PR rows show **N unresolved** for unresolved review threads (one per conversation,
including outdated ones), hiding zero or unknown counts. JSON status exposes
`unresolvedReviewThreadCount`; `null` or an absent field means unknown. Count-only
pagination does not expand Auto-fix's first-50-thread policy.

`bb thread-prs ready <pr-url> [thread-id]` marks one listed draft PR ready for review
(`gh pr ready`). It refuses PRs that are not listed for the thread or not drafts.

`bb thread-prs draft <pr-url> [thread-id]` marks one listed open PR as draft
(`gh pr ready --undo`). It refuses unlisted, draft, merged and closed PRs. The UI
offers **Mark as draft** in the three-dot menu only for open PRs, with one click
and no confirmation; **Mark ready** reverses it. Both commands refresh the list
and bb's PR status for branch PRs in the background after acknowledging GitHub's result.

`bb thread-prs autofix <pr-url> on|off [thread-id]` toggles Auto-fix for a listed
open or draft PR. It is off by default. Only enable it when the user asks: it sends
fix requests to the PR's branch-owner thread (or first linking thread) and asks
that agent to fix the branch and push. The optional thread id selects the list,
not the owner. `list` includes the Auto-fix state; `--json` includes attempts,
owner, last trigger, sent thread and conflict keys, send time, send summary and stop reason.

Enabling wakes a check immediately. Enabled rows and `list` also explain their
activity: waiting for CI or mergeability, waiting for the agent, no action needed, an already
requested failure, or unavailable status. If another thread owns Auto-fix, the UI
shows that target. State is shared per PR: an off/on cycle from another list can
reselect the owner and resets attempts. Repeating `on` while enabled wakes a check
without changing owner or attempts. Inspect `bb plugin logs thread-prs` for enable,
disable, ownership and activity diagnostics.

The background poll runs every two minutes, waits for an idle owner, and skips
archived/deleted owners and completed PRs. Check and changes-requested review
triggers wait for settled, complete CI and dedupe by head plus failing checks or
latest changes-requested review without inline threads. Reviews with inline
feedback use thread keys. The review's own inline-comment count determines this;
unrelated older threads and author replies do not retrigger a general review.
Unknown review metadata waits for another read. Unresolved review threads from Copilot or people
also trigger, including `COMMENTED` reviews, without waiting for CI. Of the first
50 threads, only unresolved, non-outdated threads whose last comment is not by the
PR author are actionable. Sent thread-id/last-comment-id keys survive pushes,
reloads and re-enabling; a new reviewer comment can trigger again.

Merge conflicts also trigger for open and draft PRs, without waiting for CI.
Only `mergeable: CONFLICTING` counts; `mergeStateStatus: DIRTY` alone does not.
GitHub calculates mergeability lazily: `UNKNOWN` never triggers a conflict and shows
**Waiting for mergeability** until a later tick reads it again (30-second cache TTL).
The batched status query includes mergeability and the current base name and SHA.
Conflict keys use head SHA + base SHA + `conflict` and survive reloads, other trigger
kinds and re-enabling. A new push or moved base can trigger; the same state cannot.

Conflicts, checks and new comments produce one request. A conflict request names
the PR, branch and current base, explains that the base moved, and asks the agent to
merge the current base into the branch, resolve conflicts, run the project's checks
and push normally. Use the current base (often `main` after a stacked base PR merged),
not the old stack branch. Do not rebase. Reply in the owner thread with what
conflicted and how it was resolved.

Comment requests include the file and line range, the latest comment's author,
an excerpt of up to 600 characters and its URL. Check the current discussion
against the code before editing or pushing, then report fixes and skipped feedback.
Comment requests forbid replying on GitHub or resolving review threads. All
requests forbid merging, closing and force-pushing.

The three-attempt limit covers all trigger kinds. Re-enabling resets attempts
and keeps sent thread and conflict keys. If delivery is unconfirmed, re-enable
Auto-fix to monitor new triggers. Check the owner thread before retrying the
unconfirmed request manually. Tooltips and `list` show the last send's purpose,
such as `Sent 14:02 (1/3) · merge conflict`.
See [Auto-fix guardrails](../../docs/reference.md#auto-fix).

A PR shows up only if it is linked or is an environment's branch PR. When you open or
push to a PR from another branch, link it so it appears:
`bb focus-board link set "$BB_THREAD_ID" <pr-url>`.

The row's three-dot menu offers View diff, Re-run failed CI, Copilot review, Mark as draft
and Merge. Diff, CI retry, Copilot review and Merge are manual UI actions without
additional CLI commands. CI retries only failed GitHub Actions
jobs on the current head and can use runner minutes. Copilot review uses the active
GitHub account's permissions and Copilot quota. Merge opens a two-minute, one-use
confirmation for the exact head and target; it keeps branches and does not bypass
rules or enqueue a required merge queue. Do not invoke a mutation just to test a
button. An ambiguous write is never automatically retried: check GitHub first.

A **Copilot** chip appears when Copilot's latest review on the current head says
"Needs a closer look", or lists issues that are still open or previously missed.
**Send to agent** and **Dismiss** are the user's decisions: don't call the
`copilotFollowUp` RPC unless the user asks. A sent request starts with
`[Thread PR Manager plugin · Copilot follow-up]`. Verify each quoted finding
against the code, fix only the valid ones, push, and reply with what you fixed and
what you rejected. See [Copilot follow-ups](../../docs/reference.md#copilot-follow-ups).

The extension settings independently show or hide each item through five **PR menu**
switches (default on). Keys: `showViewDiffAction`, `showRerunFailedCiAction`,
`showCopilotReviewAction`, `showMarkDraftAction`, `showMergeAction`. These control visibility, not GitHub
permissions. When no enabled action applies, the menu is hidden. Auto-fix stays visible.
