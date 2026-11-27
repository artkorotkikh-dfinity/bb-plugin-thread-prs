import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCopilotReviewBody } from "../lib/copilot-review.ts";
import { copilotFollowUpOf, copilotFollowUpTitle } from "../contract.ts";
import { copilotBody, discussion } from "./copilot-fixtures.mjs";

test("a closer-look review with no open issues keeps its verdict and summary", () => {
  const parsed = parseCopilotReviewBody(copilotBody({ verdict: "closer_look", summary: "Human assessment is needed because the cache may serve a stale list." }));
  assert.deepEqual(parsed, {
    verdict: "closer_look", verdictLabel: "Needs a closer look",
    summary: "Human assessment is needed because the cache may serve a stale list.",
    issues: [], resolvedCount: 0,
  });
});

test("open issues are split into new and still open; resolved ones are only counted", () => {
  const parsed = parseCopilotReviewBody(copilotBody({
    verdict: "changes", summary: "Two issues remain.",
    open: [
      { severity: "Medium", title: "Bound pagination [pages] and `records`", url: discussion(1, 11), isNew: false },
      { severity: "High", title: "Reject repeated pages", url: discussion(1, 12), isNew: true },
    ],
    resolved: [{ severity: "Low", title: "Fix the label", url: discussion(1, 9) }, { severity: "Low", title: "Fix the hint", url: discussion(1, 8) }],
  }));
  assert.equal(parsed.verdict, "changes");
  assert.equal(parsed.verdictLabel, "Changes recommended");
  assert.equal(parsed.resolvedCount, 2);
  assert.deepEqual(parsed.issues, [
    { kind: "still_open", severity: "Medium", title: "Bound pagination [pages] and `records`", url: discussion(1, 11), location: null, detail: null },
    { kind: "new", severity: "High", title: "Reject repeated pages", url: discussion(1, 12), location: null, detail: null },
  ]);
});

test("previously missed issues keep their location without zero-width spaces and their full detail", () => {
  const parsed = parseCopilotReviewBody(copilotBody({
    verdict: "closer_look", summary: "Unresolved issues can break opening a file.",
    missed: [
      { severity: "Medium", title: "Verify asset identity", location: "src/lib/assets.ts:412", detail: "Matching the type does not tie the response to the asset." },
      { severity: "Low", title: "Dispose of loaders", location: "src/Detail.svelte:346", detail: "Clearing the loader leaves `pagination` running." },
    ],
  }));
  assert.deepEqual(parsed.issues, [
    { kind: "missed", severity: "Medium", title: "Verify asset identity", url: null, location: "src/lib/assets.ts:412", detail: "Matching the type does not tie the response to the asset." },
    { kind: "missed", severity: "Low", title: "Dispose of loaders", url: null, location: "src/Detail.svelte:346", detail: "Clearing the loader leaves `pagination` running." },
  ]);
});

test("approval verdicts and bodies without a verdict parse safely", () => {
  assert.equal(parseCopilotReviewBody(copilotBody({ verdict: "approval", summary: "Looks right." })).verdict, "approval");
  assert.equal(parseCopilotReviewBody(copilotBody({ verdict: "approved", summary: "Looks right." })).verdictLabel, "Approved");
  const legacy = parseCopilotReviewBody("## Pull request overview\n\nThis PR adds a retry.\n\n### Reviewed changes\n\nCopilot reviewed 2 out of 2 changed files.");
  assert.deepEqual(legacy, { verdict: "unknown", verdictLabel: "", summary: "", issues: [], resolvedCount: 0 });
  assert.deepEqual(parseCopilotReviewBody(""), legacy);
});

const review = (change = {}) => ({
  id: "review-2", url: "https://github.com/o/r/pull/1#pullrequestreview-2", submittedAt: "2026-11-27T12:00:00Z",
  commitOid: "head-1", verdict: "changes", verdictLabel: "Changes recommended", summary: "Two issues remain.",
  issues: [], resolvedCount: 0, ...change,
});
const pr = (change = {}) => ({ state: "open", headRefOid: "head-1", copilotReview: review(), ...change });
const newIssue = { kind: "new", severity: "High", title: "New one", url: discussion(1, 2), location: null, detail: null };
const stillOpen = { ...newIssue, kind: "still_open", title: "Old one" };
const missed = { kind: "missed", severity: "Low", title: "Missed one", url: null, location: "a.ts:1", detail: "d" };

test("a follow-up needs Copilot's latest review on the current head with something the agent was not asked about", () => {
  assert.equal(copilotFollowUpOf(pr()), null, "no issues and no closer look");
  assert.equal(copilotFollowUpOf(pr({ copilotReview: review({ issues: [newIssue] }) })), null, "new issues go through Auto-fix");
  assert.deepEqual(copilotFollowUpOf(pr({ copilotReview: review({ issues: [newIssue, stillOpen, missed] }) })).issues, [stillOpen, missed]);
  const closer = copilotFollowUpOf(pr({ copilotReview: review({ verdict: "closer_look", issues: [newIssue] }) }));
  assert.deepEqual(closer.issues, []);
  assert.equal(copilotFollowUpTitle(closer), "Copilot needs a closer look");
  assert.equal(copilotFollowUpTitle(copilotFollowUpOf(pr({ copilotReview: review({ issues: [stillOpen] }) }))), "Copilot: 1 open issue");
  assert.equal(copilotFollowUpOf(pr({ headRefOid: "head-2", copilotReview: review({ issues: [stillOpen] }) })), null, "a newer commit hides it");
  assert.equal(copilotFollowUpOf(pr({ state: "merged", copilotReview: review({ issues: [stillOpen] }) })), null);
  assert.equal(copilotFollowUpOf(pr({ copilotReview: null })), null);
  assert.equal(copilotFollowUpOf(null), null);
});
