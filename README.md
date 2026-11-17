---
title: Thread PRs (bb plugin)
tags: [bb, plugin, pull-requests]
---

# Thread PRs (bb plugin)

Shows every GitHub pull request a bb thread and its child threads made, not only the
PR of the environment's current branch.

## Requirements

- BB 0.49.0 or newer with Plugin SDK 0.6.132–0.6.x. The plugin uses experimental
  SDK surfaces and should be checked against a new SDK minor version before upgrading.
- The [GitHub CLI](https://cli.github.com/) installed and signed in on each machine
  that owns a thread's environment. Reads and PR actions use that machine's
  current `gh` account. GitHub Enterprise Server is not supported.
- BB's bundled GitHub PR Status plugin supplies branch PRs. The separately installed
  [Focus Board](https://github.com/cristoslc/bb-plugin-focus-board) plugin supplies
  explicit PR links; without it, branch PRs still work.
- Auto-fix uses the owner thread's configured agent, permissions, and provider quota
  or billing. It starts work only after you explicitly enable it for that PR.

## What it lists

For the open thread and every descendant thread (archived and hidden included):

- **Focus Board links**: GitHub PR links stored by the Focus Board plugin
  (`bb focus-board link set <thread> <url>`, or the `focus_board_link_issue` agent tool).
- **Branch PRs**: each environment's current-branch PR, read from bb's built-in
  GitHub PR Status plugin.

Deduplicated by `owner/repo#number`. Open and draft first, then merged, then closed;
newest number first inside each.

## Where it shows

- **Context row above the composer**: right after bb's own PR segment, using the PRs
  visible under **Completed pull requests**:
  - **One PR**: inline state icon, linked number and title, checks, and review. Drafts
    have **Mark ready**; open and draft PRs have **Auto-fix** at the end. There is no
    expanded list. As space narrows, review hides first, then checks text while its
    icon stays visible, and the title truncates to fit.
  - **Two or more PRs**: one compact summary button with the pull-request icon,
    `PRs N` (`Active PRs N` under **Active only**) and one state dot per visible PR,
    up to six. Clicking the summary toggles the full list; it supports keyboard focus
    and has an accessible label describing the count and any hidden items.
  Mixed-repository lists prefix numbers with the repository name. Links follow
  **Open pull requests in**; modifier clicks keep their normal behavior. The segment
  appears only in the banner row and is hidden when the thread's only visible PR is
  its own branch PR (bb's segment already shows that one).
- **Thread context card** (when bb shows the card instead of the row): a "Pull requests"
  section with one row per PR.

Each row: state, `#number`, title, checks, review, where it came from ("This branch" or the
child thread), and a link to GitHub. Draft PRs get a **Mark ready** button
(`gh pr ready`). Open and draft rows also have an **Auto-fix** toggle beside it.

## Quick actions

The three-dot menu at the end of each PR row contains quick actions, in both the
composer list and context card. The menu uses one line per action; hover an action
for its availability explanation or quota note. Screen readers can access the same description.
Choose which actions appear in **Plugins → Thread PRs → Settings**, using the four
**PR menu** switches. All four start enabled; turning all of them off hides the menu.
These preferences update every list immediately and control menu visibility, not
GitHub permissions. Auto-fix remains visible beside the menu.

- **View diff** opens the PR's changed files, following the link-opening setting.
  This action remains available on completed PRs.
- **Re-run failed CI** retries failed jobs in the latest failed GitHub Actions run
  for each workflow/event on the displayed head commit. It checks the PR head and
  each run again before submitting. Successful workflows and checks from external
  CI providers are not rerun. GitHub's rerun age/attempt limits apply; this can use
  runner minutes. At most 10 failed workflows are submitted per click.
- **Copilot review** requests a new review through GitHub's Copilot code-review API,
  preserving human reviewers. It requires Copilot eligibility, quota and pull-request
  write permission; an existing pending request is reported without another retry.
- **Merge** first reads fresh GitHub state, then shows a confirmation with the PR,
  source/target branches, exact commit and repository-supported merge methods. The
  confirmation expires after two minutes and can be used once. Submission checks
  the head, target, reviews, checks, permission and merge readiness again; the merge
  request also pins the head SHA. The branch is kept.

These actions run only on explicit clicks. Writes are not automatically retried
after failures or timeouts; inspect GitHub before trying an ambiguous result again.
Only PRs currently listed for the thread can be acted on, using their owning machine.
Merge requires complete passing CI data (at most 100 contexts) and GitHub's clean
merge state. It does not enable auto-merge, enqueue a required merge queue, bypass
repository rules or delete branches; use GitHub for those flows.

## Auto-fix

Auto-fix is **off by default** for every PR. Click **Auto-fix** once on an open or
draft row to enable it, in either the composer list or the context card. The tooltip
shows `Auto-fix → <thread title>`. The owner is the thread of the PR's branch source,
or the first thread that linked the PR when there is no branch source. The optional
CLI thread id identifies the list containing the PR; it does not override the owner.

While enabled, a background service checks the PR every two minutes, even without
an open list. Enabling Auto-fix wakes that worker immediately; it does not wait for
the next two-minute poll. On reload, the first automatic poll waits 30 seconds for
plugin registration. It shares the
list's machine-scoped cache and batches stale enabled PRs into host calls of up to
50 PRs per machine. A new failing-check set, changes-requested review, or actionable
unresolved review comment triggers a request to the owner. Comments from Copilot
and people count even when GitHub records their review as `COMMENTED` and leaves
the PR's review decision at `REVIEW_REQUIRED`.

The request includes the PR URL, branch, failing checks and their links, and new
actionable threads. Each thread includes `path:startLine-line`, the first comment's
author, up to 600 characters of its body, and its URL. It asks the agent to check
each comment against the code because Copilot comments are often wrong, fix only
valid ones on the named branch and push, then report fixes and rejected comments
with reasons. It forbids GitHub replies, resolving threads, merging, closing and
force-pushing. Checks and new comments share one request when both are present.

Guardrails:

- Sends only for open or draft PRs. Check and changes-requested review triggers
  wait for settled, complete CI data (at most 100 contexts). New actionable comments
  do not wait for pending checks or a complete CI rollup.
- Waits for the owner to be idle, with no active background agents or queued
  messages. Archived, deleted and unavailable owners never receive requests.
- Uses the head commit plus sorted failing check names, or the head commit plus
  the latest changes-requested review id for reviews without inline threads.
  Reviews with inline threads use the thread rules below. The same trigger is not sent twice in
  a row, including after a plugin reload. When both checks and review fail,
  the check trigger takes precedence and the message includes both.
- Reads the first 50 review threads. A thread is actionable only while unresolved,
  not outdated, and its last comment is not by the PR author. An author's reply
  leaves the ball with the reviewer. Dedupe uses thread id plus last comment id,
  persisted per PR: a push does not repeat a thread; a new reviewer comment can
  trigger again. A request includes only new actionable thread keys.
- Sends at most three requests before disabling itself with **Stopped after 3
  tries**, shared across all trigger kinds. Clicking it again resets the attempt
  count but retains sent thread keys. Repeating `on` while already enabled does
  not reset the limit.
- Reserves each attempt durably before sending. A crash can consume an attempt
  without delivering it. A send error disables Auto-fix; explicitly enable it
  again to retry. It never automatically repeats an ambiguously delivered send.
- Failed GitHub reads never trigger from retained status. Branch/head details
  must come from a successful read by this plugin. A partial GraphQL error or missing
  branch/head details prevents any request; incomplete or unsettled CI prevents
  requests unless there are new actionable comments.
- If neither the owner's links nor its environment's branch PR still associate
  it with the PR, polling pauses. You can still turn off its saved subscription with
  `bb thread-prs autofix <pr-url> off [thread-id]` after its row disappears.

The toggle keeps a stable **Auto-fix** label and shows a green dot when enabled.
Hover it or focus it with the keyboard to see the current activity, target thread,
last request time, attempt count and purpose, such as
`Sent 14:02 (1/3) · 1 review comment`. The CLI reports the same summary.
State is stored per PR in the plugin's
`bb.storage.kv`, shared across every list containing that PR. Turning it off stops
future requests; work already sent to an agent continues. The agent uses its
existing permissions and credentials, so a request does not guarantee a fix.

Routine activity, such as **Waiting for CI**, **Waiting for agent**,
**No action needed**, **Already requested for this commit**, or
**Already requested for these comments**, stays in the tooltip
and remains available to screen readers. An attention icon stays visible when the
owner, machine, PR link or CI data is unavailable, or the subscription has stopped.
The target thread is named in the tooltip, including when it differs from the
thread you are viewing. The state is shared between sessions: switching sessions does not move the
owner, while turning it off and back on selects the owner from that list again and
resets the attempt budget. Turning an already enabled subscription on through the
CLI wakes a check without resetting its owner or attempts.

`bb plugin logs thread-prs` records enables, disables, owner IDs, request counts and
changes in waiting reasons. These diagnostics stay in BB's local plugin log and do
not include credentials. They apply from this version onward; earlier enable and
skip decisions were not recorded.

## Settings

The **PR menu: View diff**, **PR menu: Re-run failed CI**, **PR menu: Copilot review**
and **PR menu: Merge** switches independently show or hide those menu items. Their
keys are `showViewDiffAction`, `showRerunFailedCiAction`, `showCopilotReviewAction`
and `showMergeAction`; each defaults to `true`. For example:

```bash
bb plugin config thread-prs set showMergeAction false
```

Completed PRs offer only View diff. If no enabled action applies to a PR, its menu
is hidden. Visibility changes apply to future menu entries; an open confirmation
stays available until dismissed, expired or completed, including while a merge is pending.

`Open pull requests in` (`openPullRequestsIn`): `bb` (default) opens a clicked PR the way
bb opens any link, following Settings → General → Links; `system` always opens it in the
system browser. Change it in bb's plugin settings or with:

```bash
bb plugin config thread-prs set openPullRequestsIn system
```

The system-browser path calls the desktop app's `window.bbDesktop.openExternalUrl`, the
same bridge bb uses for its own external links, and falls back to a new tab in a web
client. It is not a Plugin SDK API, so a bb release could rename it.

`Completed pull requests` (`completedPullRequests`): `all` (**All**, default) shows every
PR; `activeOnly` (**Open and draft only**) hides merged and closed PRs. Entries whose
status is still loading or unavailable stay visible. The setting updates the composer
segment, count, chips, expanded list and context card live; visible lists show how many
merged or closed PRs are hidden. The CLI always lists everything. Change it in bb's
plugin settings or with:

```bash
bb plugin config thread-prs set completedPullRequests activeOnly
```

## Freshness

Status comes from batched `gh api graphql` calls on each PR owner's machine, using
whatever `gh` is logged in there. A branch source takes priority over a link source;
a linking thread without an environment uses the root thread's machine. Reads from
different machines have separate caches. The server caches each PR: 30 s while checks run,
2 min for other open PRs, 15 min for merged or closed, 1 min after an error. It reads
GitHub while some client shows the thread (`bb.rpc.experimental_whileWatched`),
and also polls explicitly enabled Auto-fix PRs in the background,
and re-checks the thread's links locally every 30 s. When bb's PR plugin has a newer
read of a branch PR, that one wins.
On equal GitHub timestamps, this plugin's read wins because checks can finish without
changing the PR's timestamp. Lists report when the 50-PR or 200-thread limit cuts results.

## Install, enable, disable

```bash
bb plugin install ~/Github/bb-plugin-thread-prs   # path install, builds on install
bb plugin disable thread-prs
bb plugin enable thread-prs
bb plugin reload thread-prs                        # after editing the source
bb plugin remove thread-prs
```

## CLI

```bash
bb thread-prs list [thread-id] [--json]     # default: the calling thread
bb thread-prs ready <pr-url> [thread-id]    # mark one listed draft PR ready
bb thread-prs autofix <pr-url> on|off [thread-id]  # toggle Auto-fix for a listed PR
```

## Develop

```bash
npm install --include=dev
npm run typecheck
npm test               # builds, then runs server and host-entry regression tests
bb plugin types --check .
bb plugin dev .        # rebuild + reload on save
```

`package.json` pins `csstype` to 3.2.3 through `overrides`: npm returned 404 for the
3.2.4 tarball when this was scaffolded.

The test suite uses fake BB threads and a private `gh` executable fixture. It never
changes a real PR, retries a real workflow or sends work to a real agent. Builds from Git omit development
dependencies, so the SDK used by the host entry is a runtime dependency.

## Data and limitations

PR status is read directly from GitHub. Auto-fix settings and attempt history stay
in this plugin's BB storage; the plugin adds no telemetry or external backend.
GitHub credentials stay in the machine's existing `gh` configuration. Auto-fix sends
the PR URL, branch, failing check names and links, reviewer identity, and review
comment excerpts, locations and URLs to the
owner's agent, which uses its existing model provider.

The list reads at most 200 threads and 50 distinct PRs, and labels truncated results.
Provider-internal subagents are not BB child threads: link their PRs on Focus Board
to include them. Auto-fix skips CI triggers for rollups above 100 contexts;
comment triggers remain independent of CI. Only the first 50 review threads are
inspected. It cannot guarantee a fix, and an attempt reserved just before a
crash may be consumed without delivery. Avoid running another automatic PR fixer
on the same thread and PR.

## License

MIT; see [LICENSE](./LICENSE).
