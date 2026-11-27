import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
// The SDK's query cache uses background GC timers; dispose those with this DOM.
const uiTimers = new Set();
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { const timer = schedule(...args); uiTimers.add(timer); return timer; };
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DocumentFragment", "HTMLInputElement", "SVGElement", "ShadowRoot", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent", "NodeFilter"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
after(() => {
  dom.window.close();
  for (const timer of uiTimers) clearTimeout(timer);
  globalThis.setTimeout = schedule;
});

// Use the public SDK's actual query/runtime harness, not a replacement for its hooks.
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, waitFor } = await import("@testing-library/react");
const { rpcContract } = await import("../contract.ts");
const app = await loadPluginApp(() => import("../app.tsx"));
const segment = app.threadContextSegments.find(slot => slot.id === "thread-prs");

const item = (number, state = "open") => ({
  key: `o/r#${number}`, repo: "o/r", number, url: `https://github.com/o/r/pull/${number}`,
  sources: [{ kind: "link", threadId: "R", threadTitle: "Root", isRoot: true }],
  status: { number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state,
    checks: { state: "passing", passed: 3, failed: 0, pending: 0, total: 3 },
    review: "none", updatedAt: "2026-11-17T10:00:00Z", headRefOid: "a".repeat(40), checksComplete: true },
  error: null, statusSource: "gh", fetchedAt: Date.now(),
  autoFix: { enabled: false, ownerThreadId: "R", attempts: 0, lastTriggerKey: null,
    lastSentAt: null, stoppedReason: null, sentThreadKeys: [], sentConflictKeys: [],
    lastSentSummary: null, ownerThreadTitle: "Root", activity: null },
});
const data = items => ({ threadId: "R", items, ownBranchKey: null, truncated: false, truncationReason: null });
const props = { threadId: "R", isExpanded: true, onToggle() {} };
const options = getData => ({ pluginId: "thread-prs", experimental_rpcContract: rpcContract,
  rpc: { threadPullRequests: getData }, settings: { completedPullRequests: "all" } });

for (const state of ["open", "draft"]) {
  test(`a single linked ${state} PR has its three-dot actions in the summary`, async t => {
    const slot = renderSlot({ component: segment.summary }, props, options(() => data([item(12, state)])));
    t.after(() => slot.lifecycle.unmount());
    const trigger = await slot.findByRole("button", { name: "Actions for pull request #12" });
    assert.equal(trigger.querySelectorAll("svg circle").length, 3);
    fireEvent.keyDown(trigger, { key: "Enter" });
    await slot.findByRole("menuitem", { name: "View diff" });
    assert.ok(slot.getByRole("menuitem", { name: "Copilot review" }));
  });
}

test("the menu survives a two-PR to one-PR summary transition", async t => {
  let items = [item(12), item(13)];
  const slot = renderSlot({ component: segment.summary }, props, options(() => data(items)));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "2 pull requests from this thread and its child threads" });
  items = [items[0]];
  await slot.behavior.experimental_invalidateRpc(null);
  await slot.findByRole("button", { name: "Actions for pull request #12" });
});

test("hiding completed PRs retains actions for the remaining active PR", async t => {
  const config = options(() => data([item(12), item(13, "merged")]));
  config.settings.completedPullRequests = "activeOnly";
  const slot = renderSlot({ component: segment.summary }, props, config);
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Actions for pull request #12" });
});

test("single-PR actions obey the menu visibility settings", async t => {
  const config = options(() => data([item(12)]));
  for (const key of ["showViewDiffAction", "showRerunFailedCiAction", "showCopilotReviewAction", "showMarkDraftAction", "showMergeAction"]) config.settings[key] = false;
  const slot = renderSlot({ component: segment.summary }, props, config);
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Auto-fix pull request #12" });
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
});

test("a sole current-branch PR still uses BB's native bar", async t => {
  const slot = renderSlot({ component: segment.summary }, props, options(() => ({ ...data([item(12)]), ownBranchKey: "o/r#12" })));
  t.after(() => slot.lifecycle.unmount());
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some(call => call.method === "threadPullRequests")));
  await slot.behavior.experimental_invalidateRpc(null);
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
});

// A phone-width bar: Mark ready and Auto-fix leave the row for the "…" menu.
function narrowBar(t, width = 300) {
  const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0 });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  // The single-PR row goes compact when its full content overflows: the full row
  // (with Mark ready or Auto-fix inline) doesn't fit this bar, the compact row does.
  const proto = dom.window.HTMLElement.prototype;
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(proto, "scrollWidth", { configurable: true, get() {
    return this.querySelector('[aria-label^="Mark pull request"], [aria-label^="Auto-fix pull request"]') ? width + 100 : width;
  } });
  t.after(() => {
    proto.getBoundingClientRect = rect;
    // Removing the overrides falls back to jsdom's Element getters.
    delete proto.clientWidth;
    delete proto.scrollWidth;
    delete globalThis.ResizeObserver;
  });
}

test("a narrow bar moves Mark ready and Auto-fix into the menu", async t => {
  narrowBar(t);
  const pr = item(12, "draft");
  pr.autoFix.enabled = true;
  const slot = renderSlot({ component: segment.summary }, props, options(() => data([pr])));
  t.after(() => slot.lifecycle.unmount());
  const trigger = await slot.findByRole("button", { name: "Actions for pull request #12" });
  assert.equal(slot.queryByRole("button", { name: "Mark pull request #12 ready for review" }), null);
  assert.equal(slot.queryByRole("button", { name: "Auto-fix pull request #12" }), null);
  assert.ok(slot.getByRole("img", { name: "Auto-fix on" }));
  fireEvent.keyDown(trigger, { key: "Enter" });
  await slot.findByRole("menuitem", { name: "Mark ready" });
  const autoFix = slot.getByRole("menuitemcheckbox", { name: /Auto-fix/ });
  assert.equal(autoFix.getAttribute("aria-checked"), "true");
});

test("a narrow bar keeps the menu when every optional action is hidden", async t => {
  narrowBar(t);
  const config = options(() => data([item(12)]));
  for (const key of ["showViewDiffAction", "showRerunFailedCiAction", "showCopilotReviewAction", "showMarkDraftAction", "showMergeAction"]) config.settings[key] = false;
  const slot = renderSlot({ component: segment.summary }, props, config);
  t.after(() => slot.lifecycle.unmount());
  const trigger = await slot.findByRole("button", { name: "Actions for pull request #12" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  await slot.findByRole("menuitemcheckbox", { name: /Auto-fix/ });
});

const followUp = (change = {}) => ({
  reviewId: "cr-1", reviewUrl: "https://github.com/o/r/pull/12#pullrequestreview-1",
  verdict: "closer_look", verdictLabel: "Needs a closer look",
  summary: "Human assessment is needed because the cache may serve a stale list.",
  issues: [
    { kind: "still_open", severity: "Medium", title: "Bound pagination pages", url: "https://github.com/o/r/pull/12#discussion_r11", location: null, detail: null },
    { kind: "missed", severity: "Low", title: "Dispose of loaders", url: null, location: "src/Detail.svelte:346", detail: "Clearing the loader leaves pagination running." },
  ],
  ownerThreadId: "R", ownerThreadTitle: "Root", ownerBusy: false, ...change,
});
const withFollowUp = (change) => ({ ...item(12), copilotFollowUp: followUp(change) });
const followUpOptions = (pr, result = { ok: true, message: "Sent to “Root”." }) => {
  const config = options(() => data([pr]));
  config.rpc.copilotFollowUp = () => result;
  return config;
};

test("Copilot's open concerns show as a chip whose popover sends them to the agent on request", async t => {
  const slot = renderSlot({ component: segment.summary }, props, followUpOptions(withFollowUp()));
  t.after(() => slot.lifecycle.unmount());
  const chip = await slot.findByRole("button", { name: "Copilot needs a closer look on pull request #12. Show the findings" });
  assert.match(chip.textContent, /Copilot: closer look/);
  fireEvent.click(chip);
  const popover = await slot.findByRole("dialog", { name: "Copilot needs a closer look on pull request #12" });
  for (const text of ["Needs a closer look", "cache may serve a stale list", "Bound pagination pages", "Still open from an earlier review",
    "Dispose of loaders", "Missed in an earlier review", "src/Detail.svelte:346", "Send asks the agent in “Root”"]) {
    assert.ok(popover.textContent.includes(text), text);
  }
  assert.equal(slot.getByRole("link", { name: "Bound pagination pages" }).getAttribute("href"), "https://github.com/o/r/pull/12#discussion_r11");
  assert.equal(slot.inspection.rpcCalls.some(call => call.method === "copilotFollowUp"), false, "nothing is sent on open");
  fireEvent.click(slot.getByRole("button", { name: "Send to agent" }));
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some(call => call.method === "copilotFollowUp")));
  const call = slot.inspection.rpcCalls.find(entry => entry.method === "copilotFollowUp");
  assert.deepEqual(call.input, { threadId: "R", url: "https://github.com/o/r/pull/12", reviewId: "cr-1", action: "send" });
  await waitFor(() => assert.equal(slot.queryByRole("dialog"), null));
});

test("a busy owner disables Send, and a refused request keeps the findings open", async t => {
  const slot = renderSlot({ component: segment.summary }, props,
    followUpOptions(withFollowUp({ ownerBusy: true, verdict: "changes", verdictLabel: "Changes recommended" }), { ok: false, message: "Copilot's review changed. Check the PR again before sending." }));
  t.after(() => slot.lifecycle.unmount());
  fireEvent.click(await slot.findByRole("button", { name: "Copilot: 2 open issues on pull request #12. Show the findings" }));
  await slot.findByRole("dialog");
  const send = slot.getByRole("button", { name: "Send to agent" });
  assert.equal(send.disabled, true);
  assert.ok(slot.getByText("The agent is busy. Send when its turn ends."));
  fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
  const alert = await slot.findByRole("alert");
  assert.match(alert.textContent, /review changed/);
  assert.ok(slot.getByRole("dialog"));
});

test("a narrow bar keeps the Copilot chip as an icon and a count", async t => {
  narrowBar(t);
  const slot = renderSlot({ component: segment.summary }, props,
    followUpOptions(withFollowUp({ verdict: "changes", verdictLabel: "Changes recommended" })));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Actions for pull request #12" });
  const chip = slot.getByRole("button", { name: "Copilot: 2 open issues on pull request #12. Show the findings" });
  assert.equal(chip.textContent, "2");
});

test("PRs without Copilot concerns show no chip", async t => {
  const slot = renderSlot({ component: segment.summary }, props, options(() => data([item(12)])));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Actions for pull request #12" });
  assert.equal(slot.queryByRole("button", { name: /Copilot/ }), null);
});

test("a sole current-branch PR with Copilot concerns adds only the chip beside BB's bar", async t => {
  const config = followUpOptions(withFollowUp());
  config.rpc.threadPullRequests = () => ({ ...data([withFollowUp()]), ownBranchKey: "o/r#12" });
  const slot = renderSlot({ component: segment.summary }, props, config);
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Copilot needs a closer look on pull request #12. Show the findings" });
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
});

test("the collapsed PR list marks PRs with Copilot concerns", async t => {
  const slot = renderSlot({ component: segment.summary }, props, options(() => data([withFollowUp(), item(13)])));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "2 pull requests from this thread and its child threads · Copilot has concerns on 1 pull request" });
});

// bb's PR badge reads bb--github-pr-status's keyed `pullRequests` row for the thread's
// environment. The harness routes RPC by method name, so `pullRequests` stands in for bb.
// Each test uses its own environment: re-reads are remembered per (environment, PR).
const bbRow = number => number === null
  ? { outcome: "absent" }
  : { outcome: "available", pullRequest: { number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: "open" } };
const withEnvironment = id => ({ ...props, environment: { id } });
const bbReads = slot => slot.inspection.rpcCalls.filter(call => call.method === "pullRequests").length;
function badgeOptions(rows, getData = () => ({ ...data([item(12)]), ownBranchKey: "o/r#12" })) {
  const config = options(getData);
  config.rpc.pullRequests = async ({ keys }) => Object.fromEntries(await Promise.all(keys.map(async key => [key, await rows()])));
  return config;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test("a thread with no PRs never reads bb's badge row", async t => {
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_none"), badgeOptions(() => bbRow(null), () => data([])));
  t.after(() => slot.lifecycle.unmount());
  await waitFor(() => assert.ok(slot.inspection.rpcCalls.some(call => call.method === "threadPullRequests")));
  await settle();
  assert.equal(bbReads(slot), 0);
});

test("a linked PR while bb's badge shows none: one read of bb's row, and the PR stays in our segment", async t => {
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_linked"), badgeOptions(() => bbRow(null), () => data([item(12)])));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Actions for pull request #12" });
  await settle();
  assert.equal(bbReads(slot), 1);
});

test("a branch PR that bb's badge already has: one read of bb's row and nothing from us", async t => {
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_has"), badgeOptions(() => bbRow(12)));
  t.after(() => slot.lifecycle.unmount());
  await waitFor(() => assert.equal(bbReads(slot), 1));
  await settle();
  assert.equal(bbReads(slot), 1);
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
});

test("a stale bb badge gets one re-read, and our segment stays out once bb has the PR", async t => {
  let reads = 0;
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_stale"), badgeOptions(() => bbRow(reads++ === 0 ? null : 12)));
  t.after(() => slot.lifecycle.unmount());
  await waitFor(() => assert.equal(bbReads(slot), 2));
  await settle();
  assert.equal(bbReads(slot), 2);
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
});

test("when bb's row still lacks the branch PR after the re-read, our segment shows it until bb has it", async t => {
  let row = bbRow(null);
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_missing"), badgeOptions(() => row));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "Actions for pull request #12" });
  assert.equal(bbReads(slot), 2);
  // bb's change signal invalidates the row by its environment tag; the badge has the PR again.
  row = bbRow(12);
  await slot.behavior.experimental_invalidateRpc(["environment:env_missing"], "bb--github-pr-status");
  await waitFor(() => assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null));
});

test("bb's row is re-read once per environment and PR, even across remounts", async t => {
  const first = renderSlot({ component: segment.summary }, withEnvironment("env_once"), badgeOptions(() => bbRow(null)));
  await first.findByRole("button", { name: "Actions for pull request #12" });
  assert.equal(bbReads(first), 2);
  first.lifecycle.unmount();
  const second = renderSlot({ component: segment.summary }, withEnvironment("env_once"), badgeOptions(() => bbRow(null)));
  t.after(() => second.lifecycle.unmount());
  await second.findByRole("button", { name: "Actions for pull request #12" });
  await settle();
  assert.equal(bbReads(second), 1);
});

test("a stale bb badge with a PR that is no longer the branch PR: ours waits for the re-read, then shows it", async t => {
  // Our data counts #12 only as a linked PR; bb's page still has #12 as the branch PR.
  let release;
  const reread = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_left"),
    badgeOptions(() => (reads++ === 0 ? bbRow(12) : reread), () => data([item(12)])));
  t.after(() => slot.lifecycle.unmount());
  await waitFor(() => assert.equal(bbReads(slot), 2));
  await settle();
  // bb's badge still shows #12 while the re-read is out: never both.
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
  release(bbRow(null));
  await slot.findByRole("button", { name: "Actions for pull request #12" });
});

test("bb's row confirms a PR our data doesn't count as the branch PR: our segment leaves it to bb", async t => {
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_confirmed"), badgeOptions(() => bbRow(12), () => data([item(12)])));
  t.after(() => slot.lifecycle.unmount());
  await waitFor(() => assert.equal(bbReads(slot), 2));
  await settle();
  assert.equal(bbReads(slot), 2);
  assert.equal(slot.queryByRole("button", { name: "Actions for pull request #12" }), null);
});

// The marker the content script keys on to hide bb's badge and its Merge action.
const coversBadge = slot => slot.container.querySelector("[data-thread-prs-covers-badge]") !== null;

test("a PR list that holds the PR bb's badge shows stands in for bb's badge", async t => {
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_cover"),
    badgeOptions(() => bbRow(12), () => ({ ...data([item(12), item(13)]), ownBranchKey: "o/r#12" })));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "2 pull requests from this thread and its child threads" });
  await waitFor(() => assert.ok(coversBadge(slot)));
});

test("a PR list without the PR bb's badge shows leaves bb's badge alone", async t => {
  const slot = renderSlot({ component: segment.summary }, withEnvironment("env_nocover"),
    badgeOptions(() => bbRow(null), () => data([item(13), item(14)])));
  t.after(() => slot.lifecycle.unmount());
  await slot.findByRole("button", { name: "2 pull requests from this thread and its child threads" });
  await settle();
  assert.equal(bbReads(slot), 1);
  assert.equal(coversBadge(slot), false);
});
