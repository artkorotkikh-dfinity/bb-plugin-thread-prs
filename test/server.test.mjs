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

function setup({ threads = THREADS, links = LINKS, descendantIds = ["C", "G"], readPr } = {}) {
  const hostCalls = [];
  const rpcCalls = [];
  const rows = {
    eR: builtinRow(10, "open", "2026-11-17T09:00:00Z"),
    eC: builtinRow(12, "draft", "2026-11-17T10:00:00Z"),
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "thread-prs",
    sdk: {
      threads: {
        experimental_listDescendants: async ({ threadIds }) => ({
          threads: threadIds.map((threadId) => ({ threadId, descendantIds: threadId === "R" ? descendantIds : [] })),
        }),
        get: async ({ threadId }) =>
          makeThreadResponse({ id: threadId, title: threads[threadId].title, environmentId: threads[threadId].environmentId }),
        experimental_listPluginMetadata: async ({ pluginId, threadIds }) => {
          assert.equal(pluginId, "focus-board");
          return { threads: threadIds.map((threadId) => ({ threadId, metadata: { linkedIssues: links[threadId] ?? [] } })) };
        },
      },
      environments: { get: async ({ environmentId }) => ({ id: environmentId, hostId: "host-1" }) },
      plugins: {
        callRpc: async ({ pluginId, method, input }) => {
          rpcCalls.push({ pluginId, method, input });
          if (method === "refresh") return { ok: true };
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
        12: status(12, "draft", "2026-11-17T10:00:00Z"), // checks can finish without changing the stamp
        13: status(13, "open", "2026-11-17T10:00:00Z", "pending"),
      };
      return {
        results: Object.fromEntries(
          input.urls.map((u) => [u, readPr ? readPr(u) : { ok: true, pr: byNumber[Number(u.split("/").pop())] }]),
        ),
      };
    },
  });
  return { bb, harness, hostCalls, rpcCalls, rows };
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
  assert.equal(result.truncated, false);

  const pr10 = result.items.find((item) => item.number === 10);
  assert.deepEqual(
    pr10.sources.map((s) => [s.kind, s.threadId, s.isRoot]),
    [["branch", "R", true], ["link", "C", false]],
  );
  assert.equal(pr10.statusSource, "gh");
  assert.equal(pr10.status.checks.total, 3);

  const pr12 = result.items.find((item) => item.number === 12);
  assert.deepEqual(pr12.sources.map((s) => [s.kind, s.threadId]), [["branch", "C"]]);
  assert.equal(pr12.statusSource, "gh");
  assert.equal(pr12.status.title, "PR 12");
  assert.equal(pr12.status.checks.total, 3);

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

test("a changed bb row invalidates views while the gh cache is fresh", async (t) => {
  const { bb, harness, hostCalls, rows } = setup();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await list(harness);
  const before = harness.inspection.experimental_rpcInvalidations.length;

  rows.eR.pullRequest.checks.failedCount = 1;
  rows.eR.pullRequest.checks.state = "failing";
  await list(harness);

  assert.equal(hostCalls.length, 1);
  assert.equal(harness.inspection.experimental_rpcInvalidations.length, before + 1);
  assert.deepEqual(harness.inspection.experimental_rpcInvalidations.at(-1), ["thread-prs:R"]);
});

test("errors with a retained merged status retry after one minute", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let fail = false;
  const { bb, harness, hostCalls } = setup({
    readPr: (u) => fail
      ? { ok: false, message: "GitHub unavailable" }
      : { ok: true, pr: status(Number(u.split("/").pop()), "merged") },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await list(harness);
  now += 15 * 60_000;
  fail = true;
  const failed = await list(harness);
  const retained = failed.items.find((item) => item.number === 11);
  assert.equal(retained.status.state, "merged");
  assert.equal(retained.error, "GitHub unavailable");
  assert.equal(hostCalls.length, 2);

  now += 59_999;
  await list(harness);
  assert.equal(hostCalls.length, 2);
  now += 1;
  fail = false;
  const recovered = await list(harness);
  assert.equal(hostCalls.length, 3);
  assert.equal(recovered.items.find((item) => item.number === 11).error, null);
});

for (const count of [50, 51]) {
  test(`PR limit: ${count} distinct PRs only flags truncation when something is cut`, async (t) => {
    const { bb, harness } = setup({
      threads: { R: { title: "Root", environmentId: null } },
      descendantIds: [],
      links: { R: Array.from({ length: count }, (_, i) => ({ repo: "o/r", issue: i + 1, kind: "pull" })) },
    });
    t.after(() => harness.lifecycle.dispose());
    await plugin(bb);
    const result = await list(harness);
    assert.equal(result.items.length, 50);
    assert.equal(result.truncated, count > 50);
    assert.equal(result.truncationReason, count > 50 ? "pullRequests" : null);
    const text = await harness.behavior.runCli(["list", "R"]);
    assert.equal(text.stdout.includes("Only the first 50 pull requests are shown"), count > 50);
  });
}

for (const count of [200, 201]) {
  test(`thread limit: ${count} threads only flags truncation when something is cut`, async (t) => {
    const ids = ["R", ...Array.from({ length: count - 1 }, (_, i) => `C${i}`)];
    const { bb, harness } = setup({
      threads: Object.fromEntries(ids.map((id) => [id, { title: id, environmentId: null }])),
      descendantIds: ids.slice(1),
      links: {},
    });
    t.after(() => harness.lifecycle.dispose());
    await plugin(bb);
    const result = await list(harness);
    assert.equal(result.truncated, count > 200);
    assert.equal(result.truncationReason, count > 200 ? "threads" : null);
    assert.equal(harness.inspection.sdk.callsTo("threads.get").length, 400);
    const text = await harness.behavior.runCli(["list", "R"]);
    assert.equal(text.stdout.includes("Only the first 200 threads were read"), count > 200);
  });
}

test("the completed PR setting leaves CLI results complete", async (t) => {
  const { bb, harness } = setup();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await harness.behavior.setSettings({ completedPullRequests: "activeOnly" });
  const result = await list(harness);
  assert.equal(result.items.length, 5);
  assert.ok(result.items.some((item) => item.status.state === "merged"));
  assert.ok(result.items.some((item) => item.status.state === "closed"));
});
