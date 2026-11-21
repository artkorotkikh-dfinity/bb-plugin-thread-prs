import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
// The SDK's query cache uses background GC timers; dispose those with this DOM.
const uiTimers = new Set();
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { const timer = schedule(...args); uiTimers.add(timer); return timer; };
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "DocumentFragment", "HTMLInputElement", "SVGElement", "ShadowRoot", "MutationObserver", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
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
  t.after(() => { dom.window.HTMLElement.prototype.getBoundingClientRect = rect; delete globalThis.ResizeObserver; });
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
