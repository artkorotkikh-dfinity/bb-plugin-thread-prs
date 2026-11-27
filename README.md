---
title: Thread PR Manager
tags: [bb, plugin, pull-requests]
---

# Thread PR Manager

See GitHub pull requests from a BB thread and its child threads beside the
composer. Check CI, review status and unresolved discussions from one list.

![Thread PR Manager demo showing PR status, quick actions, Auto-fix and settings](./assets/thread-pr-manager-demo.gif)

## Install

Use BB 0.49.0+ with Plugin SDK 0.6.132–0.6.x. Install the
[GitHub CLI](https://cli.github.com/) and sign in on each machine that owns a
thread's environment.

```bash
bb plugin install 'git:https://github.com/artkorotkikh-dfinity/bb-plugin-thread-prs.git@^0.1.0'
```

BB's bundled GitHub PR Status supplies branch PRs. Install
[Focus Board](https://github.com/cristoslc/bb-plugin-focus-board) to include PRs
linked to a thread.

## Use it

Open the PR list above the composer. Use the three-dot menu to view a diff,
retry eligible CI jobs, request Copilot review, mark a PR as draft, or confirm a
merge. Choose which actions appear in the plugin settings.

When Copilot's latest review says **Needs a closer look**, or lists issues that
are still open or were missed earlier, a **Copilot** chip appears on the PR row.
Open it to send the findings to the thread's agent or dismiss them.

## Auto-fix

Auto-fix is off by default. Enable it per PR to let the owning agent follow up
on failing checks, review feedback or merge conflicts. It stops after three
requests. PR details and review excerpts go to the agent's configured model
provider.

## Reference

See how PRs are selected, how Auto-fix handles retries, and how to use the CLI or
develop the plugin.

Source: [Thread PR Manager reference](./docs/reference.md)

## License

[MIT](./LICENSE)
