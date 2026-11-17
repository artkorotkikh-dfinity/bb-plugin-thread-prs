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

A PR shows up only if it is linked or is an environment's branch PR. When you open or
push to a PR from another branch, link it so it appears:
`bb focus-board link set "$BB_THREAD_ID" <pr-url>`.
