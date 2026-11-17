import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "../dist/host.js";

const HEAD = "a".repeat(40), BASE = "b".repeat(40), URL = "https://github.com/o/r/pull/1";
const pr = (changes = {}) => ({
  number:1, title:"Reviewed change", url:URL, state:"OPEN", isDraft:false,
  updatedAt:new Date().toISOString(), headRefOid:HEAD, headRefName:"feature", baseRefOid:BASE, baseRefName:"main",
  mergeable:"MERGEABLE", mergeStateStatus:"CLEAN", reviewDecision:"APPROVED",
  repository:{nameWithOwner:"o/r",viewerPermission:"WRITE",mergeCommitAllowed:true,squashMergeAllowed:true,rebaseMergeAllowed:false},
  reviews:{nodes:[]}, reviewRequests:{totalCount:0}, commits:{nodes:[{commit:{statusCheckRollup:null}}]}, ...changes,
});
const readPr = (changes) => ({contains:["graphql"],json:{data:{resource:pr(changes)}}});
const response = (code, body) => `HTTP/2.0 ${code}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
const runPr = (number = 1, base = "main") => ({
  number,
  base: { ref: base, repo: { id: 100 } },
  head: { ref: "feature", sha: HEAD, repo: { id: 100 } },
});
const workflow = (changes = {}) => ({
  id:17, workflow_id:9, run_number:1, run_attempt:1, head_sha:HEAD, head_branch:"feature",
  event:"pull_request", status:"completed", conclusion:"failure", created_at:new Date().toISOString(),
  repository:{id:100, full_name:"o/r"}, head_repository:{id:100}, pull_requests:[runPr()], ...changes,
});
const listRuns = (runs) => ({contains:[`repos/o/r/actions/runs?head_sha=${HEAD}`],json:{total_count:runs.length,workflow_runs:runs}});

// Every gh process is a private fixture. No request can escape to GitHub.
async function setup(t, steps) {
  const dir=await mkdtemp(path.join(tmpdir(),"thread-prs-actions-"));
  const state=path.join(dir,"steps.json"), log=path.join(dir,"calls.jsonl");
  await writeFile(state,JSON.stringify({index:0,steps}));
  await writeFile(path.join(dir,"gh"),`#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");const p=${JSON.stringify(state)};const s=JSON.parse(fs.readFileSync(p,"utf8"));const step=s.steps[s.index++];fs.writeFileSync(p,JSON.stringify(s));if(!step||!step.contains.every(x=>args.some(a=>a.includes(x)))){process.stderr.write("Unexpected fixture call: "+JSON.stringify(args));process.exit(99);}process.stdout.write(step.stdout??JSON.stringify(step.json));process.stderr.write(step.stderr??"");process.exitCode=step.code??0;\n`,{mode:0o700});
  const previousPath=process.env.PATH;
  process.env.PATH=`${dir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${previousPath}`;
  const harness=experimental_createHostEntryHarness(entry);
  t.after(async()=>{process.env.PATH=previousPath;await harness.experimental_dispose();await rm(dir,{recursive:true,force:true});});
  return {call:(method,input)=>harness.experimental_call(method,input),calls:async()=>{try{return(await readFile(log,"utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);}catch{return[];}}};
}

test("merge preview is read-only and offers only repository-supported methods",async(t)=>{
  const env=await setup(t,[readPr()]);
  const result=await env.call("prepareMerge",{url:URL});
  assert.equal(result.ok,true);
  assert.deepEqual(result.preview.methods,["squash","merge"]);
  assert.equal(result.preview.headRefOid,HEAD);
  assert.equal((await env.calls()).length,1);
});

for(const changes of [
  {isDraft:true},{state:"CLOSED"},{mergeable:"CONFLICTING"},{mergeStateStatus:"BLOCKED"},
  {reviewDecision:"CHANGES_REQUESTED"},{reviewDecision:"REVIEW_REQUIRED"},
  {repository:{...pr().repository,viewerPermission:"READ"}},
  {commits:{nodes:[]}},
])test(`merge fails closed for ${JSON.stringify(changes)}`,async(t)=>{
  const env=await setup(t,[readPr(changes)]);
  const result=await env.call("mergePullRequest",{url:URL,expectedHead:HEAD,expectedBase:BASE,baseRefName:"main",method:"squash"});
  assert.equal(result.ok,false);
  assert.equal((await env.calls()).length,1,"no merge write");
});

for(const [changes,method] of [[{headRefOid:"c".repeat(40)},"squash"],[{baseRefOid:"c".repeat(40)},"squash"],[{baseRefName:"release"},"squash"],[{},"rebase"]])
  test(`merge rechecks head, target and method: ${JSON.stringify(changes)} ${method}`,async(t)=>{
    const env=await setup(t,[readPr(changes)]);
    assert.equal((await env.call("mergePullRequest",{url:URL,expectedHead:HEAD,expectedBase:BASE,baseRefName:"main",method})).ok,false);
    assert.equal((await env.calls()).length,1);
});

test("partial GitHub reads cannot authorize a write",async(t)=>{
  const partial={contains:["graphql"],json:{data:{resource:pr()},errors:[{message:"partial failure"}]}};
  const env=await setup(t,[partial,partial,partial]);
  for(const [method,input] of [["requestCopilotReview",{url:URL}],["rerunFailedCi",{url:URL,expectedHead:HEAD}],["mergePullRequest",{url:URL,expectedHead:HEAD,expectedBase:BASE,baseRefName:"main",method:"squash"}]])
    assert.equal((await env.call(method,input)).ok,false);
  assert.equal((await env.calls()).length,3);
});

test("an ambiguous merge response asks for a refresh and never replays the write",async(t)=>{
  const env=await setup(t,[readPr(),{contains:["PUT"],stdout:"HTTP/2.0 200\n\nnot-json"}]);
  const result=await env.call("mergePullRequest",{url:URL,expectedHead:HEAD,expectedBase:BASE,baseRefName:"main",method:"squash"});
  assert.equal(result.ok,false);assert.match(result.message,/Refresh the PR/);
  assert.equal((await env.calls()).length,2);
});

test("merge sends the confirmed SHA and strategy without bypass or deletion",async(t)=>{
  const env=await setup(t,[readPr(),{contains:["PUT","repos/o/r/pulls/1/merge",`sha=${HEAD}`,"merge_method=squash"],stdout:response(200,{merged:true,message:"merged"})}]);
  const result=await env.call("mergePullRequest",{url:URL,expectedHead:HEAD,expectedBase:BASE,baseRefName:"main",method:"squash"});
  assert.equal(result.ok,true,result.message);
  const calls=await env.calls();assert.equal(calls.length,2);
  assert.ok(!calls[1].some(a=>/admin|delete/.test(a)));
});

test("GitHub declining a merge is not reported as success",async(t)=>{
  const env=await setup(t,[readPr(),{contains:["PUT"],stdout:response(200,{merged:false,message:"Merge queue required"})}]);
  const result=await env.call("mergePullRequest",{url:URL,expectedHead:HEAD,expectedBase:BASE,baseRefName:"main",method:"squash"});
  assert.equal(result.ok,false);assert.match(result.message,/queue/);
});

for(const [status,exit,ok] of [[201,0,true],[409,1,true],[422,1,false],[403,1,false]])test(`Copilot review handles HTTP ${status} without retry`,async(t)=>{
  const env=await setup(t,[readPr(),{contains:["POST","repos/o/r/pulls/1/copilot-code-review","2026-03-10"],stdout:response(status,{message:"eligibility or quota"}),stderr:exit?`gh: request failed (HTTP ${status})`:"",code:exit}]);
  const result=await env.call("requestCopilotReview",{url:URL});
  assert.equal(result.ok,ok);assert.equal((await env.calls()).length,2);
});

test("Copilot review refuses completed and invalid PR targets",async(t)=>{
  const env=await setup(t,[readPr({state:"MERGED"})]);
  assert.equal((await env.call("requestCopilotReview",{url:URL})).ok,false);
  assert.equal((await env.call("requestCopilotReview",{url:"https://evil.example/pull/1"})).ok,false);
  assert.equal((await env.calls()).length,1);
});

test("CI retry selects only current-head, latest failed Actions runs",async(t)=>{
  const selected=workflow();
  const runs = [
    selected,
    workflow({id:18, workflow_id:10}),
    workflow({id:19, workflow_id:10, run_number:2, conclusion:"success"}),
    workflow({id:20, workflow_id:11, head_sha:"c".repeat(40)}),
    workflow({id:21, workflow_id:12, repository:{id:101, full_name:"other/repo"}}),
    workflow({id:22, run_number:3, pull_requests:[runPr(2, "release")]}),
    workflow({id:23, workflow_id:13, event:"workflow_dispatch"}),
    workflow({id:24, workflow_id:14, pull_requests:[]}),
    workflow({id:25, workflow_id:15, pull_requests:[runPr(), runPr(2, "release")]}),
  ];
  const env=await setup(t,[readPr(),listRuns(runs),{contains:["GET","repos/o/r/actions/runs/17"],json:selected},readPr(),{contains:["POST","repos/o/r/actions/runs/17/rerun-failed-jobs"],stdout:response(201,{})}]);
  const result=await env.call("rerunFailedCi",{url:URL,expectedHead:HEAD});
  assert.equal(result.ok,true,result.message);
  assert.equal((await env.calls()).filter(c=>c.includes("POST")).length,1);
});

test("CI retry does not write when the PR head changes",async(t)=>{
  const env=await setup(t,[readPr(),listRuns([workflow()]),{contains:["GET","repos/o/r/actions/runs/17"],json:workflow()},readPr({headRefOid:"c".repeat(40)})]);
  const result=await env.call("rerunFailedCi",{url:URL,expectedHead:HEAD});
  assert.equal(result.ok,false);assert.match(result.message,/head changed/);
  assert.equal((await env.calls()).filter(c=>c.includes("POST")).length,0);
});

test("CI retry skips a run if the PR target changes before submission", async (t) => {
  const run = workflow();
  const env = await setup(t, [
    readPr(), listRuns([run]),
    {contains:["GET", "repos/o/r/actions/runs/17"], json:run},
    readPr({baseRefName:"release"}),
  ]);
  const result = await env.call("rerunFailedCi", {url:URL, expectedHead:HEAD});
  assert.equal(result.ok, false);
  assert.match(result.message, /no longer matches this PR/);
  assert.equal((await env.calls()).some(call => call.includes("POST")), false);
});

for(const changed of [{status:"in_progress",conclusion:null},{run_attempt:50},{created_at:"2020-01-01T00:00:00Z"},{pull_requests:[runPr(2,"release")]}])test(`CI retry skips an unsupported or changed run: ${JSON.stringify(changed)}`,async(t)=>{
  const env=await setup(t,[readPr(),listRuns([workflow()]),{contains:["GET","repos/o/r/actions/runs/17"],json:workflow(changed)}]);
  assert.equal((await env.call("rerunFailedCi",{url:URL,expectedHead:HEAD})).ok,false);
  assert.equal((await env.calls()).filter(c=>c.includes("POST")).length,0);
});

test("CI retry reports partial success without replaying writes",async(t)=>{
  const runs=[workflow(),workflow({id:18,workflow_id:10})];
  const env=await setup(t,[readPr(),listRuns(runs),{contains:["GET","runs/17"],json:runs[0]},readPr(),{contains:["POST","runs/17/rerun-failed-jobs"],stdout:response(201,{})},{contains:["GET","runs/18"],json:runs[1]},readPr(),{contains:["POST","runs/18/rerun-failed-jobs"],code:1,stderr:"gh: forbidden (HTTP403)"}]);
  const result=await env.call("rerunFailedCi",{url:URL,expectedHead:HEAD});
  assert.equal(result.ok,false);assert.match(result.message,/1 workflow/);
  assert.equal((await env.calls()).filter(c=>c.includes("POST")).length,2);
});
