---
title: Thread PR Manager reference
tags: [bb, plugin, pull-requests, reference]
---

# Thread PR Manager reference

How BB finds PRs, what each action requires, and how to troubleshoot Auto-fix.

## PRs and status

The list combines current-branch PRs from BB's GitHub PR Status plugin with
Focus Board links from the thread and its descendants. It deduplicates by
repository and PR number, and flags results capped at 200 threads or 50 PRs.
Link PRs from provider-internal subagents on Focus Board to include them.

The composer shows a single PR inline or a collapsible list for several.
When the only PR is the thread's own branch PR, BB's built-in PR badge shows
it. When the list holds that PR among others, the list replaces BB's badge and
its Merge action, so each PR has one set of controls. The committed file count
comes from BB's Git plugin.

**Unresolved** counts review conversations, including outdated ones that
remain open. General PR comments are excluded. Zero and incomplete counts
stay hidden.

Status and actions use the PR owner's GitHub CLI login. A branch source takes
priority over a link. If a linking thread has no environment, the list uses
the root thread's machine. Status is cached for 30 seconds while checks or
mergeability are pending, two minutes for other open PRs, and 15 minutes for
completed PRs. Failed reads retry after one minute.

## Quick actions

- **View diff** opens GitHub's changed-files view, including on completed PRs.
- **Re-run failed CI** retries failed jobs in Actions runs verified for the
  selected PR and its current head and base. Each click retries up to 10
  workflows and can use runner minutes.
- **Copilot review** requires Copilot eligibility, quota, and PR write access.
  A pending request is reused and human reviewers stay assigned.
- **Mark as draft** takes effect immediately. Use **Mark ready** to reverse it.
- **Merge** uses a single-use confirmation that expires after two minutes.
  It rechecks the head, target, reviews, checks, and permissions. The branch
  is kept. Use GitHub for merge queues or auto-merge.

Check GitHub before retrying a write with an uncertain result. BB submits
these actions only on a click.

## Auto-fix

Enable Auto-fix per PR to check immediately and then every two minutes,
including with the list closed. It waits for an idle owner with no queued
work. The owner is the branch thread or, when the PR is linked only, the first
thread that linked it. Each request contains the relevant GitHub links and
review excerpts and goes to that thread's configured agent.

- **CI and general reviews** need settled, complete check data of up to 100
  contexts. A changes-requested review with no inline comments can trigger
  even when older discussions have been resolved.
- **Inline reviews** inspect the first 50 review conversations. A conversation
  qualifies while unresolved, current, and last commented on by someone
  other than the PR author. The request quotes the latest comment and asks
  the agent to verify the live discussion before editing or pushing.
- **Merge conflicts** require GitHub to confirm the conflict. Auto-fix uses
  the current base branch, including after a stacked PR has been retargeted.
  New conflicts and review comments can trigger while CI is pending.

Auto-fix remembers sent comments and conflicts and stops after three requests.
Turning it off and back on resets the budget and chooses the owner again.
Turning it off stops future requests. A send cancelled before handoff can
retry. For **Delivery unconfirmed**, check the owner thread before retrying
manually. Re-enable Auto-fix to watch for new triggers.

Hover or focus **Auto-fix** for the owner, activity, and last request. If the
PR's association disappears, polling pauses and the CLI can still turn it
off. If an older subscription shows **Machine unavailable**, re-enable it
from the root thread with the intended environment. Use
`bb plugin logs thread-prs` for local diagnostics.

GitHub credentials stay in `gh`. Subscription history stays in BB plugin
storage. The owner's model provider receives the PR URL, branch, applicable
check links, and review excerpts with their authors and locations.

## Copilot follow-ups

Copilot code review posts its verdict and findings in the review body, often
with no inline comments. The PR row shows a **Copilot** chip when Copilot's
latest review is on the PR's current head and one of these is true:

- The verdict is **Needs a closer look**.
- It lists open issues that aren't marked **New**. These were raised in an
  earlier review and are still open.
- It lists **previously missed issues**, with a file and line but no inline
  conversation.

New issues have their own inline conversations, so they don't show the chip.
Auto-fix handles them like any other review comment. A newer commit hides
the chip until Copilot reviews again.

Click the chip to see the verdict, Copilot's summary and each finding. On a
narrow bar, the chip shows only a count.

- **Send to agent** starts one turn in the owner thread, the same thread
  Auto-fix uses. The request quotes the verdict, the summary and each finding
  with its link or location. It asks the agent to check each finding against
  the code, fix only the valid ones and push. The agent doesn't reply on
  GitHub, resolve threads or request another review. Send works only while the
  owner is idle, so it never interrupts a running turn.
- **Dismiss** hides the findings until Copilot posts a new review.

Both buttons apply to that review only, and the choice is kept across reloads.
With Auto-fix on, the plugin also sends one BB push notification per
qualifying review through the built-in Push Notifications plugin. A click on
the notification opens the owner thread. Copilot's findings are never sent to
the agent without a click, even with Auto-fix on, and sending them doesn't use
Auto-fix's three requests.

## Settings

Open **Plugins → Thread PR Manager → Settings**. All five menu switches
start on. The menu disappears when no enabled action applies.

| Setting | Key | Values |
| --- | --- | --- |
| Open pull requests in | `openPullRequestsIn` | `bb` (default), `system` |
| Completed pull requests | `completedPullRequests` | `all` (default), `activeOnly` |
| PR menu · View diff | `showViewDiffAction` | On or off |
| PR menu · Re-run failed CI | `showRerunFailedCiAction` | On or off |
| PR menu · Copilot review | `showCopilotReviewAction` | On or off |
| PR menu · Mark as draft | `showMarkDraftAction` | On or off |
| PR menu · Merge | `showMergeAction` | On or off |

## CLI

Commands default to the calling thread. The list includes completed PRs.

```bash
bb thread-prs list [thread-id] [--json]
bb thread-prs ready <pr-url> [thread-id]
bb thread-prs draft <pr-url> [thread-id]
bb thread-prs autofix <pr-url> on|off [thread-id]
```

## Develop

```bash
npm ci
npm run typecheck
npm test
bb plugin types --check .
bb plugin dev .
```

Use `bb plugin install .` to install the checkout. Tests use fixture PRs
and exercise the host, server, and UI without changing GitHub state.
