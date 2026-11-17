---
title: Thread PRs (bb plugin)
tags: [bb, plugin, pull-requests]
---

# Thread PRs (bb plugin)

Shows every GitHub pull request a bb thread and its child threads made, not only the
PR of the environment's current branch.

## What it lists

For the open thread and every descendant thread (archived and hidden included):

- **Focus Board links**: GitHub PR links stored by the Focus Board plugin
  (`bb focus-board link set <thread> <url>`, or the `focus_board_link_issue` agent tool).
- **Branch PRs**: each environment's current-branch PR, read from bb's built-in
  GitHub PR Status plugin.

Deduplicated by `owner/repo#number`. Open and draft first, then merged, then closed;
newest number first inside each.

## Where it shows

- **Context row above the composer**: a `PRs N` segment right after bb's own PR segment,
  with one dot per PR. Click it to expand the list. The segment is hidden when the thread's
  only PR is its own branch PR (bb's segment already shows that one).
- **Thread context card** (when bb shows the card instead of the row): a "Pull requests"
  section with one row per PR.

Each row: state, `#number`, title, checks, review, where it came from ("This branch" or the
child thread), and a link to GitHub. Draft PRs get a **Mark ready** button
(`gh pr ready`). Open and draft rows also have an **Auto-fix** toggle beside it.

## Auto-fix

Auto-fix is **off by default** for every PR. Click **Auto-fix** once on an open or
draft row to enable it, in either the composer list or the context card. The tooltip
shows `Auto-fix → <thread title>`. The owner is the thread of the PR's branch source,
or the first thread that linked the PR when there is no branch source. The optional
CLI thread id identifies the list containing the PR; it does not override the owner.

While enabled, a background service checks the PR every two minutes, even without
an open list. It shares the list's cache and batches stale enabled PRs into one host
call per machine per poll. A new failing-check set or changes-requested review
triggers a short request to the owner: fix the named branch, push, and reply with
what changed. The request includes the PR URL, failing checks and their links (or
the reviewer), identifies the Thread PRs plugin, and says
"Don't merge, close or force-push."

Guardrails:

- Sends only for open or draft PRs, after every check has finished. Rollups with
  more than 100 contexts are treated as incomplete and do not trigger Auto-fix.
- Waits for the owner to be idle, with no active background agents or queued
  messages. Archived, deleted and unavailable owners never receive requests.
- Uses the head commit plus sorted failing check names, or the head commit plus
  the latest changes-requested review id. The same trigger is not sent twice in
  a row, including after a plugin reload. When both checks and review fail,
  the check trigger takes precedence and the message includes both.
- Sends at most three requests before disabling itself with **Stopped after 3
  tries**. Clicking it again resets the attempt count. Repeating `on` while
  already enabled does not reset the limit.
- Reserves each attempt durably before sending. A crash can consume an attempt
  without delivering it. A send error disables Auto-fix; explicitly enable it
  again to retry. It never automatically repeats an ambiguously delivered send.
- Failed GitHub reads never trigger from retained status. Branch/head details
  must come from a complete successful read by this plugin.

The toggle shows **Auto-fix** when off, **Auto-fix on** when enabled, then a local
time such as **Sent 12:04 (1/3)**. State is stored per PR in the plugin's
`bb.storage.kv`, shared across every list containing that PR. Turning it off stops
future requests; work already sent to an agent continues. The agent uses its
existing permissions and credentials, so a request does not guarantee a fix.

## Settings

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
segment, count, dots, expanded list and context card live; visible lists show how many
merged or closed PRs are hidden. The CLI always lists everything. Change it in bb's
plugin settings or with:

```bash
bb plugin config thread-prs set completedPullRequests activeOnly
```

## Freshness

Status comes from one batched `gh api graphql` call on the thread's machine, using
whatever `gh` is logged in there. The server caches each PR: 30 s while checks run,
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
npm test             # builds, then runs test/server.test.mjs in the SDK's fake plugin host
bb plugin dev .        # rebuild + reload on save
```

`package.json` pins `csstype` to 3.2.3 through `overrides`: npm returned 404 for the
3.2.4 tarball when this was scaffolded.
