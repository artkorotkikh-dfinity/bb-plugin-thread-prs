import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "../dist/host.js";
import { copilotBody } from "./copilot-fixtures.mjs";

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
  const calls = path.join(dir, "calls.jsonl");
  const index = path.join(dir, "index");
  await writeFile(response, typeof payload === "string" ? payload : JSON.stringify(payload));
  await writeFile(path.join(dir, "gh"), `#!/usr/bin/env node\nconst fs = require("node:fs"); const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(args)}, JSON.stringify(args)); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+"\\n"); const raw=fs.readFileSync(${JSON.stringify(response)},"utf8"); if (${Array.isArray(payload)}) { const file=${JSON.stringify(index)};const i=fs.existsSync(file)?Number(fs.readFileSync(file,"utf8")):0;fs.writeFileSync(file,String(i+1));const step=JSON.parse(raw)[i];if(!step)process.exit(99);process.stdout.write(typeof step.payload==="string"?step.payload:JSON.stringify(step.payload));process.stderr.write(step.stderr??"");process.exitCode=step.code??0; } else { process.stdout.write(raw); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${code}; }\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${previousPath}`;
  const harness = experimental_createHostEntryHarness(entry);
  t.after(async () => { process.env.PATH = previousPath; await harness.experimental_dispose(); await rm(dir, { recursive: true, force: true }); });
  return { call: (urls) => harness.experimental_call("fetchPullRequests", { urls }), args: () => readFile(args, "utf8").then(JSON.parse), calls: async () => (await readFile(calls,"utf8")).trim().split("\n").map(JSON.parse), harness };
}

const threadPage = (nodes, hasNextPage = false, endCursor = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const countedPr = (n, connection) => ({ ...pr(n), reviewThreads: connection });

test("unresolved counts use review conversations, including outdated threads and threads without readable comments", async (t) => {
  const node = countedPr(1, threadPage([
    { id:"one", isResolved:false, isOutdated:true },
    { id:"two", isResolved:false },
    { id:"three", isResolved:true },
  ]));
  const fixture = await setup(t, { data:{ p0:node, p1:countedPr(2,threadPage([])), p2:pr(3) } });
  const {results} = await fixture.call([url(1),url(2),url(3)]);
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,2);
  assert.equal(results[url(2)].pr.unresolvedReviewThreadCount,0);
  assert.equal(results[url(3)].pr.unresolvedReviewThreadCount,null,"missing data is not zero");
  assert.equal((await fixture.calls()).length,1);
});

test("unresolved counts continue beyond the initial 50 threads without expanding Auto-fix's thread list",async(t)=>{
  const first=Array.from({length:50},(_,i)=>({id:`first-${i}`,isResolved:true}));
  const fixture=await setup(t,[
    {payload:{data:{p0:countedPr(1,threadPage(first,true,"cursor-50"))}}},
    {payload:{data:{p0:{reviewThreads:threadPage([{id:"later-1",isResolved:false},{id:"later-2",isResolved:false}])}}}},
  ]);
  const {results}=await fixture.call([url(1)]);
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,2);
  assert.equal(results[url(1)].pr.reviewThreads.length,0,"count-only pages add no actionable comments");
  assert.match((await fixture.calls())[1].at(-1),/reviewThreads\(first: 100, after: "cursor-50"\)/);
});

test("a failed count page keeps the count unknown while another PR's paginated count succeeds",async(t)=>{
  const first=threadPage([{id:"one",isResolved:false}],true,"cursor");
  const fixture=await setup(t,[
    {payload:{data:{p0:countedPr(1,first),p1:countedPr(2,first),p2:countedPr(3,threadPage([]))}}},
    {payload:{data:{p0:null,p1:{reviewThreads:threadPage([{id:"two",isResolved:false}])}},errors:[{path:["p0","reviewThreads"],message:"page unavailable"}]},code:1},
  ]);
  const {results}=await fixture.call([url(1),url(2),url(3)]);
  assert.equal(results[url(1)].ok,true,"CI and Auto-fix data remain usable");
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,null);
  assert.equal(results[url(2)].pr.unresolvedReviewThreadCount,2);
  assert.equal(results[url(3)].pr.unresolvedReviewThreadCount,0);
});

for(const connection of [
  threadPage([{id:"one",isResolved:false}],true,"cursor"),
  threadPage([{id:"one",isResolved:"false"}]),
])test(`incomplete or malformed count pages never produce a partial count: ${JSON.stringify(connection)}`,async(t)=>{
  const fixture=await setup(t,[
    {payload:{data:{p0:countedPr(1,threadPage([{id:"first",isResolved:false}],true,"cursor"))}}},
    {payload:{data:{p0:{reviewThreads:connection}}}},
  ]);
  const {results}=await fixture.call([url(1)]);
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,null);
  assert.equal((await fixture.calls()).length,2);
});

test("count pagination has a fixed budget and deduplicates thread ids",async(t)=>{
  const pages=Array.from({length:11},(_,i)=>({payload:{data:{p0:i===0
    ? countedPr(1,threadPage([{id:"same",isResolved:false}],true,"c0"))
    : {reviewThreads:threadPage([{id:"same",isResolved:false}],i<10,`c${i}`)}}}}));
  const fixture=await setup(t,pages);
  const {results}=await fixture.call([url(1)]);
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,1);
  assert.equal((await fixture.calls()).length,11);
});

test("exhausting the count page budget leaves the total unknown",async(t)=>{
  const pages=Array.from({length:12},(_,i)=>({payload:{data:{p0:i===0
    ? countedPr(1,threadPage([{id:"first",isResolved:false}],true,"c0"))
    : {reviewThreads:threadPage([{id:`later-${i}`,isResolved:false}],true,`c${i}`)}}}}));
  const fixture=await setup(t,pages);
  const {results}=await fixture.call([url(1)]);
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,null);
  assert.equal((await fixture.calls()).length,11,"no unbounded pagination");
});

test("a failed count request preserves PR status without displaying a partial total",async(t)=>{
  const fixture=await setup(t,[
    {payload:{data:{p0:countedPr(1,threadPage([{id:"first",isResolved:false}],true,"cursor"))}}},
    {payload:"not-json",code:1,stderr:"gh: network unavailable"},
  ]);
  const {results}=await fixture.call([url(1)]);
  assert.equal(results[url(1)].ok,true);
  assert.equal(results[url(1)].pr.unresolvedReviewThreadCount,null);
  assert.equal(results[url(1)].pr.checks.failed,1);
});

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

test("batched reads include the latest review reply for COMMENTED reviews", async (t) => {
  const node = pr();
  node.author = { login: "pr-author" };
  node.reviewDecision = "REVIEW_REQUIRED";
  node.reviews = { nodes: [] };
  node.reviewThreads = { nodes: [{
    id: "thread-1", isResolved: false, isOutdated: false, path: "docs/ai/writing.md", startLine: 164, line: 166,
    firstComment: { nodes: [{ id: "comment-1", author: { login: "copilot-pull-request-reviewer" }, body: "Changes recommended", url: `${url(1)}#discussion_r1` }] },
    lastComment: { nodes: [{ id: "comment-2", author: { login: "reviewer" }, body: "Keep it unchanged", url: `${url(1)}#discussion_r2` }] },
  }] };
  const fixture = await setup(t, { data: { p0: node, p1: pr(2) } });
  const { results } = await fixture.call([url(1), url(2)]);
  assert.equal(results[url(1)].pr.review, "review_required");
  assert.equal(results[url(1)].pr.authorLogin, "pr-author");
  assert.deepEqual(results[url(1)].pr.reviewThreads, [{
    id: "thread-1", isResolved: false, isOutdated: false, path: "docs/ai/writing.md", startLine: 164, line: 166,
    lastComment: { id: "comment-2", author: "reviewer", body: "Keep it unchanged", url: `${url(1)}#discussion_r2` },
  }]);
  const query = (await fixture.args()).at(-1);
  assert.match(query, /p0: resource/); assert.match(query, /p1: resource/);
  assert.match(query, /reviewThreads\(first: 50\)/);
  assert.match(query, /lastComment: comments\(last: 1\) \{ nodes \{ id author \{ login \} body url \} \}/);
  assert.doesNotMatch(query, /firstComment:/);
});

test("latest review metadata distinguishes general feedback from inline feedback", async t => {
  const general = pr(1), inline = pr(2), unknown = pr(3);
  general.reviews.nodes[0].comments = { totalCount: 0 };
  inline.reviews.nodes[0].comments = { totalCount: 2 };
  const fixture = await setup(t, { data: { p0: general, p1: inline, p2: unknown } });
  const { results } = await fixture.call([url(1), url(2), url(3)]);
  assert.equal(results[url(1)].pr.latestChangesRequested.inlineCommentCount, 0);
  assert.equal(results[url(2)].pr.latestChangesRequested.inlineCommentCount, 2);
  assert.equal(results[url(3)].pr.latestChangesRequested.inlineCommentCount, undefined);
  assert.match((await fixture.args()).at(-1), /reviews\(last: 1, states: \[CHANGES_REQUESTED\]\).*comments \{ totalCount \}/);
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

test("reads Copilot's latest review with its commit and parses the findings", async (t) => {
  const reviewed = pr(1), never = pr(2), unread = pr(3);
  reviewed.copilotReview = { nodes: [{
    id: "cr-1", url: `${url(1)}#pullrequestreview-1`, submittedAt: "2026-11-27T12:00:00Z", commit: { oid: "head-1" },
    body: copilotBody({ verdict: "closer_look", summary: "Human assessment is needed.",
      missed: [{ severity: "Medium", title: "Verify identity", location: "src/a.ts:4", detail: "It can report another size." }] }),
  }] };
  never.copilotReview = { nodes: [] };
  const fixture = await setup(t, { data: { p0: reviewed, p1: never, p2: unread } });
  const { results } = await fixture.call([url(1), url(2), url(3)]);
  assert.deepEqual(results[url(1)].pr.copilotReview, {
    id: "cr-1", url: `${url(1)}#pullrequestreview-1`, submittedAt: "2026-11-27T12:00:00Z", commitOid: "head-1",
    verdict: "closer_look", verdictLabel: "Needs a closer look", summary: "Human assessment is needed.", resolvedCount: 0,
    issues: [{ kind: "missed", severity: "Medium", title: "Verify identity", url: null, location: "src/a.ts:4", detail: "It can report another size." }],
  });
  assert.equal(results[url(2)].pr.copilotReview, null, "Copilot never reviewed");
  assert.equal(results[url(3)].pr.copilotReview, undefined, "not read");
  assert.match((await fixture.args()).at(-1),
    /copilotReview: reviews\(last: 1, author: "copilot-pull-request-reviewer\[bot\]"\) \{ nodes \{ id url submittedAt body commit \{ oid \} \} \}/);
});
