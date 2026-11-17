import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "../dist/host.js";

const url = (n) => `https://github.com/o/r/pull/${n}`;
const check = (change = {}) => ({ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-17T10:00:00Z", detailsUrl: "https://ci.example/build", ...change });
function pr(n = 1, nodes = [check()]) {
  return {
    number: n, title: "Fix it", url: url(n), state: "OPEN", isDraft: false,
    updatedAt: "2026-11-17T10:00:00Z", headRefOid: "head-1", headRefName: "fix/one",
    reviewDecision: "CHANGES_REQUESTED", reviews: { nodes: [{ id: "review-1", author: { login: "reviewer" } }] },
    reviewRequests: { totalCount: 0 },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] },
  };
}

// Exercise the built host entry, real execFile argument handling and SDK validation.
// A private PATH fixture prevents all GitHub reads and writes during these tests.
async function setup(t, payload, code = 0, stderr = "") {
  const dir = await mkdtemp(path.join(tmpdir(), "thread-prs-host-"));
  const response = path.join(dir, "response.json");
  const args = path.join(dir, "args.json");
  await writeFile(response, typeof payload === "string" ? payload : JSON.stringify(payload));
  await writeFile(path.join(dir, "gh"), `#!/usr/bin/env node\nconst fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2))); process.stdout.write(fs.readFileSync(${JSON.stringify(response)})); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code};\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${previousPath}`;
  const harness = experimental_createHostEntryHarness(entry);
  t.after(async () => { process.env.PATH = previousPath; await harness.experimental_dispose(); await rm(dir, { recursive: true, force: true }); });
  return { call: (urls) => harness.experimental_call("fetchPullRequests", { urls }), args: () => readFile(args, "utf8").then(JSON.parse), harness };
}

test("queued rerun cannot be treated as settled CI", async (t) => {
  const fixture = await setup(t, { data: { p0: pr(1, [check(), check({ status: "QUEUED", conclusion: null, startedAt: null })]) } });
  const { results } = await fixture.call([url(1)]);
  assert.equal(results[url(1)].ok, true);
  assert.equal(results[url(1)].pr.checksComplete, false);
  assert.equal(results[url(1)].pr.checks.pending, 1);
  assert.equal(results[url(1)].pr.checks.state, "pending");
  assert.deepEqual((await fixture.args()).slice(0, 4), ["api", "graphql", "--hostname", "github.com"]);
});

test("batched reads carry current base and mergeability, including lazy UNKNOWN", async (t) => {
  const conflict = { ...pr(1), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", baseRefName: "main", baseRefOid: "b".repeat(40) };
  const unknown = { ...pr(2), mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", baseRefName: "stack", baseRefOid: "c".repeat(40) };
  const fixture = await setup(t, { data: { p0: conflict, p1: unknown } });
  const { results } = await fixture.call([url(1), url(2)]);
  for (const node of [conflict, unknown]) {
    for (const field of ["mergeable", "mergeStateStatus", "baseRefName", "baseRefOid"]) {
      assert.equal(results[node.url].pr[field], node[field]);
      assert.ok((await fixture.args()).at(-1).includes(field));
    }
  }
});

test("batched reads include PR authors and aliased first/last review comments for COMMENTED reviews", async (t) => {
  const node = pr();
  node.author = { login: "pr-author" };
  node.reviewDecision = "REVIEW_REQUIRED";
  node.reviews = { nodes: [] };
  node.reviewThreads = { nodes: [{
    id: "thread-1", isResolved: false, isOutdated: false, path: "docs/ai/writing.md", startLine: 164, line: 166,
    firstComment: { nodes: [{ id: "comment-1", author: { login: "copilot-pull-request-reviewer" }, body: "Changes recommended", url: `${url(1)}#discussion_r1` }] },
    lastComment: { nodes: [{ id: "comment-2", author: { login: "reviewer" } }] },
  }] };
  const fixture = await setup(t, { data: { p0: node, p1: pr(2) } });
  const { results } = await fixture.call([url(1), url(2)]);
  assert.equal(results[url(1)].pr.review, "review_required");
  assert.equal(results[url(1)].pr.authorLogin, "pr-author");
  assert.deepEqual(results[url(1)].pr.reviewThreads, [{
    id: "thread-1", isResolved: false, isOutdated: false, path: "docs/ai/writing.md", startLine: 164, line: 166,
    firstComment: { id: "comment-1", author: "copilot-pull-request-reviewer", body: "Changes recommended", url: `${url(1)}#discussion_r1` },
    lastComment: { id: "comment-2", author: "reviewer" },
  }]);
  const query = (await fixture.args()).at(-1);
  assert.match(query, /p0: resource/); assert.match(query, /p1: resource/);
  assert.match(query, /reviewThreads\(first: 50\)/);
  assert.match(query, /firstComment: comments\(first: 1\)/);
  assert.match(query, /lastComment: comments\(last: 1\)/);
});

test("nested GraphQL failure rejects its PR while preserving other aliases", async (t) => {
  const partial = pr();
  partial.commits.nodes[0].commit.statusCheckRollup = null;
  const fixture = await setup(t, { data: { p0: partial, p1: pr(2) }, errors: [{ path: ["p0", "commits", "nodes", 0, "commit", "statusCheckRollup"], message: "resource failed" }] }, 1);
  const { results } = await fixture.call([url(1), url(2)]);
  assert.deepEqual(results[url(1)], { ok: false, message: "resource failed" });
  assert.equal(results[url(2)].ok, true);
});

test("missing commit data is incomplete; a confirmed null rollup means no checks", async (t) => {
  const missing = pr();
  missing.commits = { nodes: [] };
  const noChecks = pr(2);
  noChecks.commits.nodes[0].commit.statusCheckRollup = null;
  const fixture = await setup(t, { data: { p0: missing, p1: noChecks } });
  const { results } = await fixture.call([url(1), url(2)]);
  assert.equal(results[url(1)].pr.checksComplete, false);
  assert.equal(results[url(2)].pr.checksComplete, true);
  assert.equal(results[url(2)].pr.checks.state, "no_checks");
});

test("an incomplete check page never authorizes Auto-fix", async (t) => {
  const incomplete = pr();
  incomplete.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  const fixture = await setup(t, { data: { p0: incomplete } });
  assert.equal((await fixture.call([url(1)])).results[url(1)].pr.checksComplete, false);
});

test("global GraphQL errors reject all PRs and invalid URLs never reach gh", async (t) => {
  const fixture = await setup(t, { data: { p0: pr() }, errors: [{ message: "rate limit" }] }, 1);
  assert.equal((await fixture.call([url(1)])).results[url(1)].ok, false);
  const invalid = 'https://example.com/pull/1;echo bad';
  assert.equal((await fixture.call([invalid])).results[invalid].ok, false);
  const result = await fixture.harness.experimental_call("markReady", { url: invalid });
  assert.equal(result.ok, false);
  const draft = await fixture.harness.experimental_call("markDraft", { url: invalid });
  assert.deepEqual(draft, { ok: false, message: "Not a github.com pull request URL" });
  assert.equal((await fixture.args())[0], "api", "invalid mutation did not invoke gh");
});

test("mark draft runs gh pr ready --undo with the URL as one argument", async (t) => {
  const fixture = await setup(t, "Marked as draft\n");
  assert.deepEqual(await fixture.harness.experimental_call("markDraft", { url: url(1) }), {
    ok: true, message: "Marked as draft",
  });
  assert.deepEqual(await fixture.args(), ["pr", "ready", "--undo", url(1)]);
});

test("mark draft returns the first line of gh failures", async (t) => {
  const fixture = await setup(t, "", 1, "Permission denied\nMore details\n");
  assert.deepEqual(await fixture.harness.experimental_call("markDraft", { url: url(1) }), {
    ok: false, message: "Permission denied",
  });
});
