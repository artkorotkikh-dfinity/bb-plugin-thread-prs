---
name: thread-prs
description: List every GitHub pull request this thread and its child threads made, with state, checks and review, or mark one of them ready. Use when asked which PRs a thread opened or worked on, or for the status of all of them at once.
---

# Thread PRs

`bb thread-prs list [thread-id] [--json]` prints every PR of a thread and its
descendant threads: Focus Board links plus each environment's current-branch PR,
deduplicated by `owner/repo#number`. Without a thread id it uses the calling thread.

`bb thread-prs ready <pr-url> [thread-id]` marks one listed draft PR ready for review
(`gh pr ready`). It refuses PRs that are not listed for the thread or not drafts.

`bb thread-prs autofix <pr-url> on|off [thread-id]` toggles Auto-fix for a listed
open or draft PR. It is off by default. Only enable it when the user asks: it sends
fix requests to the PR's branch-owner thread (or first linking thread) and asks
that agent to fix the branch and push. The optional thread id selects the list,
not the owner. `list` includes the Auto-fix state; `--json` includes attempts,
owner, last trigger, send time and stop reason.

Enabling wakes a check immediately. Enabled rows and `list` also explain their
activity: waiting for CI, waiting for the agent, no action needed, an already
requested failure, or unavailable status. If another thread owns Auto-fix, the UI
shows that target. State is shared per PR: an off/on cycle from another list can
reselect the owner and resets attempts. Repeating `on` while enabled wakes a check
without changing owner or attempts. Inspect `bb plugin logs thread-prs` for enable,
disable, ownership and activity diagnostics.

The background poll runs every two minutes, waits for an idle owner and settled
checks, skips archived/deleted owners and completed PRs, deduplicates triggers by
head plus failing checks or latest changes-requested review, and stops after
three attempts. Explicitly re-enabling resets attempts. It never asks the agent
to merge, close or force-push. See [Auto-fix guardrails](../../README.md#auto-fix).

A PR shows up only if it is linked or is an environment's branch PR. When you open or
push to a PR from another branch, link it so it appears:
`bb focus-board link set "$BB_THREAD_ID" <pr-url>`.

The row's three-dot menu offers View diff, Re-run failed CI, Copilot review and Merge. These are
manual UI actions, not additional CLI commands. CI retries only failed GitHub Actions
jobs on the current head and can use runner minutes. Copilot review uses the active
GitHub account's permissions and Copilot quota. Merge opens a two-minute, one-use
confirmation for the exact head and target; it keeps branches and does not bypass
rules or enqueue a required merge queue. Do not invoke a mutation just to test a
button. An ambiguous write is never automatically retried: check GitHub first.

The extension settings independently show or hide each item through four **PR menu**
switches (default on). Keys: `showViewDiffAction`, `showRerunFailedCiAction`,
`showCopilotReviewAction`, `showMergeAction`. These control visibility, not GitHub
permissions. When no enabled action applies, the menu is hidden. Auto-fix stays visible.
