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
(`gh pr ready`). There are no other actions.

## Freshness

Status comes from one batched `gh api graphql` call on the thread's machine, using
whatever `gh` is logged in there. The server caches each PR: 30 s while checks run,
2 min for other open PRs, 15 min for merged or closed, 1 min after an error. It reads
GitHub only while some client shows the thread (`bb.rpc.experimental_whileWatched`),
and re-checks the thread's links locally every 30 s. When bb's PR plugin has a newer
read of a branch PR, that one wins.

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
