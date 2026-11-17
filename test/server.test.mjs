// Runs the built server bundle (dist/server.js) in the SDK's fake plugin host.
// Run: bb plugin build . && node --test test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../dist/server.js";

const url = (n) => `https://github.com/o/r/pull/${n}`;
const status = (n, state, updatedAt = "2026-11-17T10:00:00Z", checks = "passing") => ({
  number: n,
  title: `PR ${n}`,
  url: url(n),
  state,
  checks: { state: checks, passed: 3, failed: 0, pending: 0, total: 3 },
  review: "review_required",
  updatedAt,
});
const builtinRow = (n, state, updatedAt) => ({
  outcome: "available",
  pullRequest: {
    number: n,
    title: `PR ${n} (bb)`,
    url: url(n),
    state,
    updatedAt,
    checks: { state: "passing", totalCount: 2, passedCount: 2, failedCount: 0, pendingCount: 0 },
    review: { state: "none", reviewRequestCount: 0 },
  },
});

// Root R (env eR, branch PR #10) > child C (env eC, branch PR #12) > grandchild G (no env).
const THREADS = {
  R: { title: "Root", environmentId: "eR" },
  C: { title: "Child", environmentId: "eC" },
  G: { title: "Grandchild", environmentId: null },
};
const LINKS = {
  R: [
    { tracker: "github", repo: "o/r", issue: 11, kind: "pull", href: url(11), createdAt: "2026-11-17T00:00:00Z", source: "agent" },
    { tracker: "github", repo: "o/r", issue: 9, kind: "pull", href: url(9), createdAt: "2026-11-17T00:00:00Z", source: "agent" },
  ],
  // Same PR as R's branch PR, other case: must dedupe.
  C: [{ tracker: "github", repo: "O/R", issue: 10, kind: "pull", href: url(10), createdAt: "2026-11-17T00:00:00Z", source: "agent" }],
  G: [
    { tracker: "github", repo: "o/r", issue: 13, kind: "pull", href: url(13), createdAt: "2026-11-17T00:00:00Z", source: "agent" },
    { tracker: "github", repo: "o/r", issue: 99, kind: "issue", href: "https://github.com/o/r/issues/99", createdAt: "2026-11-17T00:00:00Z", source: "agent" },
    { tracker: "external", url: "https://linear.app/x/issue/X-1", hostname: "linear.app", createdAt: "2026-11-17T00:00:00Z", source: "agent" },
  ],
};

function setup() {
  const hostCalls = [];
  const rpcCalls = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "thread-prs",
    sdk: {
      threads: {
        experimental_listDescendants: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({ threadId, descendantIds: threadId === "R" ? ["C", "G"] : [] })),
        }),
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, title: THREADS[threadId].title, environmentId: THREADS[threadId].environmentId }),
        experimental_listPluginMetadata: async ({ pluginId, threadIds }) => {
          assert.equal(pluginId, "focus-board");
          return { threads: threadIds.map((threadId) => ({ threadId, metadata: { linkedIssues: LINKS[threadId] ?? [] } })) };
        },
      },
      environments: { get: async ({ environmentId }) => ({ id: environmentId, hostId: "host-1" }) },
      plugins: {
        callRpc: async ({ pluginId, method, input }) => {
          rpcCalls.push({ pluginId, method, input });
          if (method === "refresh") return { ok: true };
          const rows = {
            eR: builtinRow(10, "open", "2026-11-17T09:00:00Z"),
            eC: builtinRow(12, "draft", "2026-11-17T10:00:00Z"),
          };
          return Object.fromEntries(input.keys.map((key) => [key, rows[key] ?? { outcome: "absent" }]));
        },
      },
    },
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      hostCalls.push({ method, input, hostId });
      if (method === "markReady") return { ok: true, message: "marked" };
      const byNumber = {
        9: status(9, "closed"),
        10: status(10, "open", "2026-11-17T10:00:00Z"), // newer than bb's row: ours wins
        11: status(11, "merged"),
        12: status(12, "draft", "2026-11-17T10:00:00Z"), // same stamp as bb's row: bb's wins
        13: status(13, "open", "2026-11-17T10:00:00Z", "pending"),
      };
      return {
        results: Object.fromEntries(
          input.urls.map((u) => [u, { ok: true, pr: byNumber[Number(u.split("/").pop())] }]),
        ),
      };
    },
  });
  return { bb, harness, hostCalls, rpcCalls };
}

async function list(harness) {
  const out = await harness.behavior.runCli(["list", "R", "--json"]);
  assert.equal(out.exitCode, 0, out.stderr);
  return JSON.parse(out.stdout);
}

test("collects links and branch PRs from the whole subtree, deduped and sorted", async () => {
  const { bb, harness, hostCalls } = setup();
  await plugin(bb);
  const result = await list(harness);

  assert.deepEqual(
    result.items.map((item) => item.key),
    ["o/r#13", "o/r#12", "o/r#10", "o/r#11", "o/r#9"],
  );
  assert.equal(result.ownBranchKey, "o/r#10");

  const pr10 = result.items.find((item) => item.number === 10);
  assert.deepEqual(
    pr10.sources.map((s) => [s.kind, s.threadId, s.isRoot]),
    [["branch", "R", true], ["link", "C", false]],
  );
  assert.equal(pr10.statusSource, "gh");
  assert.equal(pr10.status.checks.total, 3);

  const pr12 = result.items.find((item) => item.number === 12);
  assert.deepEqual(pr12.sources.map((s) => [s.kind, s.threadId]), [["branch", "C"]]);
  assert.equal(pr12.statusSource, "github-pr-status");

  const pr13 = result.items.find((item) => item.number === 13);
  assert.deepEqual(pr13.sources.map((s) => [s.kind, s.threadId, s.threadTitle]), [["link", "G", "Grandchild"]]);

  // One batched GitHub read for all five PRs, on the root's machine.
  assert.equal(hostCalls.length, 1);
  assert.equal(hostCalls[0].method, "fetchPullRequests");
  assert.equal(hostCalls[0].hostId, "host-1");
  assert.equal(hostCalls[0].input.urls.length, 5);

  // Within every TTL nothing is read from GitHub again.
  await list(harness);
  assert.equal(hostCalls.length, 1);
  await harness.lifecycle.dispose();
});

test("mark ready: only listed drafts, and bb's PR segment is refreshed for branch PRs", async () => {
  const { bb, harness, hostCalls, rpcCalls } = setup();
  await plugin(bb);
  await list(harness);

  const refused = await harness.behavior.callRpc("markReady", { threadId: "R", url: url(13) });
  assert.deepEqual(refused, { ok: false, message: "#13 is not a draft." });
  const unlisted = await harness.behavior.callRpc("markReady", { threadId: "R", url: url(500) });
  assert.equal(unlisted.ok, false);

  const ready = await harness.behavior.callRpc("markReady", { threadId: "R", url: url(12) });
  assert.deepEqual(ready, { ok: true, message: "marked" });
  assert.deepEqual(
    hostCalls.filter((call) => call.method === "markReady").map((call) => call.input),
    [{ url: url(12) }],
  );
  assert.ok(
    rpcCalls.some((call) => call.method === "refresh" && call.input.environmentId === "eC"),
    "bb--github-pr-status refresh for the child's environment",
  );
  await harness.lifecycle.dispose();
});
