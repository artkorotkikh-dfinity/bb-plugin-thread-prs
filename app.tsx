// Thread PR Manager frontend: a context-row segment after bb's own PR segment, and the
// same list as a thread context card section when the pane shows the card.
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useRpcKeyedQuery,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useThreadContextKind,
  useBbNavigate,
  useSettings,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import {
  autoFixLastSendLabel,
  PR_STATUS_PLUGIN,
  prStatusContract,
  prStatusRowKey,
  rpcContract,
  truncationText,
  type PrStatus,
  type ThreadPr,
  type ThreadPrs,
} from "./contract";
import { cn } from "./lib/utils";
import { Tooltip } from "./lib/tooltip";
import { PrQuickActions } from "./lib/pr-actions";
import { CopilotFollowUp } from "./lib/copilot-follow-up";

// Same tokens and icons as bb's GitHub PR Status plugin, so both segments read as siblings.
const STATE = {
  open: { label: "Open", icon: "GitPullRequestArrow", text: "text-success-foreground", dot: "bg-success" },
  draft: { label: "Draft", icon: "GitPullRequestDraft", text: "text-muted-foreground", dot: "bg-muted-foreground" },
  merged: { label: "Merged", icon: "GitMerge", text: "text-pr-merged", dot: "bg-pr-merged" },
  closed: { label: "Closed", icon: "GitPullRequestClosed", text: "text-destructive-text", dot: "bg-destructive" },
} as const;

const REVIEW: Record<PrStatus["review"], { label: string; text: string } | null> = {
  approved: { label: "Approved", text: "text-success-foreground" },
  changes_requested: { label: "Changes requested", text: "text-destructive-text" },
  review_required: { label: "Review required", text: "" },
  review_requested: { label: "Review requested", text: "" },
  none: null,
};

function useThreadPrs(threadId: string) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "threadPullRequests",
    input: { threadId },
  });
  const completedPullRequests = useSettings().values?.completedPullRequests;
  const items = filterItems(query.data?.items ?? [], completedPullRequests);
  return {
    data: query.data === undefined ? undefined : { ...query.data, items },
    hiddenCount: (query.data?.items.length ?? 0) - items.length,
    mixedRepos: new Set(query.data?.items.map((item) => item.repo.toLowerCase())).size > 1,
    activeOnly: completedPullRequests === "activeOnly",
  };
}

function filterItems(items: ThreadPr[], completedPullRequests: unknown): ThreadPr[] {
  return completedPullRequests === "activeOnly"
    ? items.filter((item) => item.status === null || item.status.state === "open" || item.status.state === "draft")
    : items;
}

function numberLabel(item: ThreadPr, mixedRepos: boolean): string {
  return `${mixedRepos ? item.repo.split("/")[1] : ""}#${item.number}`;
}

function listNotes(data: ThreadPrs, hiddenCount: number): string[] {
  return [
    hiddenCount > 0 ? `${hiddenCount} merged or closed hidden` : null,
    truncationText(data),
  ].filter((note): note is string => note !== null);
}

/**
 * The list adds something only when it holds a PR other than the one bb's own segment
 * shows, or Copilot findings that bb's segment can't show. While bb's badge lacks the
 * branch PR (`badgeHasOwn` false), that PR counts as one bb doesn't show.
 */
function hasExtras(data: ThreadPrs | undefined, badgeHasOwn = true): data is ThreadPrs {
  return data !== undefined
    && data.items.some((item) => item.key !== data.ownBranchKey || !badgeHasOwn || item.copilotFollowUp);
}

// bb's page re-reads its PR badge when bb's server signals a change, and a page hidden
// at that moment misses the signal, so a PR opened at the end of a turn can stay off the
// badge until a reload. One re-read per (environment, PR) for the page's lifetime,
// shared by every mounted hook.
const badgeRereads = new Map<string, Promise<void>>();
const settledBadgeRereads = new Set<string>();

/**
 * Whether bb's badge has the thread's branch PR, so our segment can leave that PR out.
 * When bb's row lacks it, ask bb's store to re-read the row once; the badge reads the
 * same store. If the row still lacks the PR after that read, return false so our segment
 * shows it, until the row gets it.
 */
function useBadgeHasBranchPr(environmentId: string | null, ownBranchKey: string | null): boolean {
  const watched = ownBranchKey === null ? null : environmentId;
  const pair = watched === null ? null : `${watched} ${ownBranchKey}`;
  const { data, refetchKeys } = experimental_useRpcKeyedQuery({
    pluginId: PR_STATUS_PLUGIN,
    contract: prStatusContract,
    method: "pullRequests",
    keys: watched === null ? [] : [watched],
    enabled: watched !== null,
  });
  const row = watched === null ? undefined : data?.[watched];
  // An unloaded row is no answer yet: change nothing until bb's store has one.
  const missing = row !== undefined && prStatusRowKey(row) !== ownBranchKey;
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!missing || watched === null || pair === null) return;
    let reread = badgeRereads.get(pair);
    if (reread === undefined) {
      reread = refetchKeys([watched])
        .catch(() => {})
        .then(() => { settledBadgeRereads.add(pair); });
      badgeRereads.set(pair, reread);
    }
    let live = true;
    void reread.then(() => { if (live) setSettled(pair); });
    return () => { live = false; };
  }, [missing, watched, pair, refetchKeys]);
  return !(missing && pair !== null && (settled === pair || settledBadgeRereads.has(pair)));
}

/** The context row's PRs, and whether bb's badge already shows the branch PR. */
function useSegmentPrs({ threadId, environment }: ExperimentalThreadContextSegmentInput) {
  const prs = useThreadPrs(threadId);
  const own = prs.data?.items.find((item) => item.key === prs.data?.ownBranchKey);
  const badgeHasOwn = useBadgeHasBranchPr(environment?.id ?? null, own?.key ?? null);
  return { ...prs, badgeHasOwn };
}

type DesktopBridge = { openExternalUrl?: (url: string) => void };

// The SDK has no "open in the system browser" call. This mirrors bb's own external-browser
// path (the desktop app's window.bbDesktop bridge, else a new tab) and may need updating
// if a bb release renames that bridge.
function openInSystemBrowser(url: string): void {
  const desktop = (window as Window & { bbDesktop?: DesktopBridge }).bbDesktop;
  if (typeof desktop?.openExternalUrl === "function") desktop.openExternalUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Opens a PR where the plugin setting says; returns false to let the link's default run. */
function useOpenPullRequest(): (url: string) => boolean {
  const navigate = useBbNavigate();
  const target = useSettings().values?.openPullRequestsIn;
  return (url: string) => {
    if (target === "system") {
      openInSystemBrowser(url);
      return true;
    }
    return navigate.openUrl(url);
  };
}

function useOpenUrl() {
  const openPullRequest = useOpenPullRequest();
  return (url: string) => (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openPullRequest(url)) event.preventDefault();
  };
}

function checksText(status: PrStatus): { label: string; text: string; icon: string | null } {
  const { checks } = status;
  switch (checks.state) {
    case "passing":
      return { label: `Checks ${checks.passed}/${checks.total}`, text: "", icon: "Check" };
    case "failing":
      return { label: `${checks.failed} failing`, text: "text-destructive-text", icon: "X" };
    case "pending":
      return { label: `${checks.pending} running`, text: "", icon: null };
    case "no_checks":
      return { label: "No checks", text: "", icon: null };
  }
}

function sourceText(item: ThreadPr, ownBranchKey: string | null): { label: string; threadId: string | null } | null {
  if (item.key === ownBranchKey) return { label: "This branch", threadId: null };
  const child = item.sources.find((source) => !source.isRoot);
  if (child === undefined || item.sources.some((source) => source.isRoot)) return null;
  return { label: child.threadTitle ?? "Child thread", threadId: child.threadId };
}

// Below this segment width (20rem) Mark ready and Auto-fix leave the row for the "…" menu, so the
// bar stays one line on a phone. Matches the `@max-[20rem]` container rules below.
const COMPACT_WIDTH_PX = 320;
// The expanded list spans the whole bar, so it goes compact at a wider 30rem.
const COMPACT_LIST_WIDTH_PX = 480;

/** Tracks whether the element is narrower than `threshold` px. False until measured. */
function useCompact<T extends HTMLElement>(threshold = COMPACT_WIDTH_PX): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setCompact(width < threshold);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);
  return [ref, compact];
}

/**
 * Goes compact when the full row overflows its box, and back once the box is as
 * wide as the full row needed. Width alone can't tell, because what the row needs
 * depends on its content (Mark ready, Auto-fix, unresolved count).
 */
function useFitsCompact<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [compact, setCompact] = useState(false);
  const needed = useRef(0);
  const check = () => {
    const element = ref.current;
    if (element === null || element.clientWidth === 0) return;
    if (!compact) {
      if (element.scrollWidth > element.clientWidth + 1) {
        needed.current = element.scrollWidth;
        setCompact(true);
      }
    } else if (element.clientWidth >= needed.current) {
      setCompact(false);
    }
  };
  // Runs after every render: new status data can widen the row without resizing it.
  useLayoutEffect(() => {
    check();
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  });
  return [ref, compact];
}

function AutoFixOnDot({ item }: { item: ThreadPr }) {
  if (!item.autoFix.enabled) return null;
  return <span role="img" aria-label="Auto-fix on" title="Auto-fix on" className="size-1.5 shrink-0 rounded-full bg-success" />;
}

function Dot({ className }: { className: string }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", className)} />;
}

const ACTION_BUTTON_CLASS = "inline-flex cursor-pointer items-center whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-xs transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

function MarkReadyButton({ threadId, item }: { threadId: string; item: ThreadPr }) {
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "markReady" });
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setFailure(null);
    try {
      const result = await mutation.mutate({ threadId, url: item.url });
      if (!result.ok) setFailure(result.message);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {failure === null ? null : (
        <span role="alert" title={failure} className="max-w-28 truncate text-destructive-text">
          {failure}
        </span>
      )}
      <button
        type="button"
        onClick={() => void run()}
        disabled={mutation.isPending}
        className={ACTION_BUTTON_CLASS}
        aria-label={`Mark pull request #${item.number} ready for review`}
      >
        {mutation.isPending ? "Marking…" : "Mark ready"}
      </button>
    </span>
  );
}

function AutoFixButton({ threadId, item }: { threadId: string; item: ThreadPr }) {
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "setAutoFix" });
  const [failure, setFailure] = useState<string | null>(null);
  const state = item.autoFix;
  const descriptionId = useId();
  const warning = state.stoppedReason ?? (state.activity?.includes("unavailable") ||
    state.activity === "Waiting for PR link" || state.activity === "Waiting for complete CI data" ? state.activity : null);
  const run = async () => {
    setFailure(null);
    try {
      const result = await mutation.mutate({ threadId, url: item.url, enabled: !state.enabled });
      if (!result.ok) setFailure(result.message);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {failure === null ? null : <span role="alert" title={failure} className="max-w-28 truncate text-destructive-text">{failure}</span>}
      <Tooltip content={
        <span className="flex flex-col gap-1">
          <span className="font-medium">{state.enabled ? "Auto-fix enabled" : "Auto-fix disabled"}</span>
          <span>{state.stoppedReason ?? state.activity ?? "Enable to monitor CI, review feedback and merge conflicts"}</span>
          {state.lastSentAt === null ? null : (
            <span>{autoFixLastSendLabel(state)}</span>
          )}
          <span className="text-muted-foreground">Target: {state.ownerThreadTitle ?? state.ownerThreadId}</span>
        </span>
      }>
        <button
          type="button"
          onClick={() => void run()}
          disabled={mutation.isPending}
          aria-pressed={state.enabled}
          aria-label={`Auto-fix pull request #${item.number}`}
          aria-describedby={descriptionId}
          className="relative inline-flex min-h-10 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state.enabled ? <Dot className="bg-success" /> : null}
          {mutation.isPending ? "Updating…" : "Auto-fix"}
          {warning ? <Icon name="AlertTriangle" className="size-3 text-attention-foreground" aria-hidden /> : null}
        </button>
      </Tooltip>
      <span id={descriptionId} role="status" className="sr-only">
        {[state.stoppedReason ?? state.activity, autoFixLastSendLabel(state), `Target: ${state.ownerThreadTitle ?? state.ownerThreadId}`].filter(Boolean).join(". ")}
      </span>
    </span>
  );
}

function PrActions({ threadId, item, compact = false, className = "ml-auto" }: {
  threadId: string;
  item: ThreadPr;
  compact?: boolean;
  className?: string;
}) {
  const open = useOpenUrl();
  const actionsRef = useRef<HTMLSpanElement>(null);
  const active = item.status?.state === "open" || item.status?.state === "draft";
  return (
    <span ref={actionsRef} className={cn("flex shrink-0 flex-nowrap items-center justify-end gap-0.5", className)} onClick={(event) => event.stopPropagation()}>
      {active ? <CopilotFollowUp threadId={threadId} item={item} compact={compact} openUrl={open} /> : null}
      {!compact && item.status?.state === "draft" ? <MarkReadyButton threadId={threadId} item={item} /> : null}
      {!compact && active ? <AutoFixButton threadId={threadId} item={item} /> : null}
      <PrQuickActions threadId={threadId} item={item} compact={compact} onOpenDiff={open(`${item.url}/files`)}
        onReturnFocus={() => actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus()} />
    </span>
  );
}

function UnresolvedComments({ count, compact = false }: { count: number | null | undefined; compact?: boolean }) {
  if (count == null || count === 0) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title={`${count} unresolved review ${count === 1 ? "thread" : "threads"}, including outdated conversations`}
      aria-label={`${count} unresolved review ${count === 1 ? "thread" : "threads"}`}>
      {compact ? <Icon name="MessageSquare" className="size-3 shrink-0" aria-hidden /> : null}
      {compact ? count : `${count} unresolved`}
    </span>
  );
}

function StatusLine({ item, ownBranchKey }: { item: ThreadPr; ownBranchKey: string | null }) {
  const navigate = useBbNavigate();
  const status = item.status;
  const source = sourceText(item, ownBranchKey);
  const parts: ReactNode[] = [];
  if (status === null) {
    parts.push(
      item.error === null ? (
        <span key="loading">Loading status…</span>
      ) : (
        <span key="error" title={item.error} className="inline-flex items-center gap-1">
          <Icon name="AlertTriangle" className="size-3" aria-hidden />
          Status unavailable
        </span>
      ),
    );
  } else {
    const checks = checksText(status);
    const review = status.state === "open" || status.state === "draft" ? REVIEW[status.review] : null;
    if (status.state !== "open") parts.push(
      <span key="state" className={STATE[status.state].text}>
        {STATE[status.state].label}
      </span>,
    );
    if (status.state === "open" || status.state === "draft") {
      parts.push(
        <span key="checks" title={`${checks.label}; ${status.checks.passed} passed, ${status.checks.failed} failed, ${status.checks.pending} pending`} className={cn("inline-flex items-center gap-1 tabular-nums", checks.text)}>
          {checks.icon === null ? (
            status.checks.state === "pending" ? <Dot className="bg-attention" /> : null
          ) : (
            <Icon name={checks.icon} className="size-3" aria-hidden />
          )}
          {checks.label}
        </span>,
      );
    }
    if (review !== null) {
      parts.push(
        <span key="review" className={review.text}>
          {review.label}
        </span>,
      );
    }
    if (status.unresolvedReviewThreadCount) {
      parts.push(<UnresolvedComments key="comments" count={status.unresolvedReviewThreadCount} />);
    }
    if (item.error !== null) {
      parts.push(
        <span key="stale" title={item.error} className="inline-flex items-center gap-1">
          <Icon name="AlertTriangle" className="size-3" aria-hidden />
          Not refreshed
        </span>,
      );
    }
  }
  if (source !== null) {
    parts.push(
      source.threadId === null ? (
        <span key="source">{source.label}</span>
      ) : (
        <button
          key="source"
          type="button"
          onClick={() => navigate.toThread(source.threadId!, { split: true })}
          className="min-w-0 cursor-pointer truncate hover:text-foreground hover:underline"
          title={`Open ${source.label}`}
        >
          {source.label}
        </button>
      ),
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index} className="flex min-w-0 shrink-0 items-center gap-1.5 last:shrink">
          {index > 0 ? <span aria-hidden>·</span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function PrRow({ threadId, item, ownBranchKey, mixedRepos, compact }: {
  threadId: string;
  item: ThreadPr;
  ownBranchKey: string | null;
  mixedRepos: boolean;
  compact: boolean;
}) {
  const open = useOpenUrl();
  const status = item.status;
  const state = status === null ? null : STATE[status.state];
  const title = status?.title ?? `${item.repo}#${item.number}`;
  const done = status?.state === "merged" || status?.state === "closed";
  return (
    <li className={cn("flex items-start gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-xs hover:bg-state-hover", compact ? "flex-nowrap" : "flex-wrap", done && "opacity-70")}>
      <Icon
        name={state?.icon ?? "GitPullRequest"}
        className={cn("mt-px size-3.5 shrink-0", state?.text ?? "text-muted-foreground")}
        aria-label={state?.label ?? "Pull request"}
      />
      <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !compact && "basis-60")}>
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open(item.url)}
          title={`${item.repo}#${item.number} ${title}`}
          className="flex min-w-0 items-baseline gap-1.5 text-foreground no-underline hover:underline"
        >
          <span className="shrink-0 tabular-nums">{numberLabel(item, mixedRepos)}</span>
          <span className="min-w-0 truncate">{title}</span>
          {compact ? <span className="self-center"><AutoFixOnDot item={item} /></span> : null}
        </a>
        <StatusLine item={item} ownBranchKey={ownBranchKey} />
      </span>
      <PrActions threadId={threadId} item={item} compact={compact} />
    </li>
  );
}

function PrList({ threadId, data, hiddenCount, mixedRepos }: {
  threadId: string;
  data: ThreadPrs;
  hiddenCount: number;
  mixedRepos: boolean;
}) {
  const [listRef, compact] = useCompact<HTMLUListElement>(COMPACT_LIST_WIDTH_PX);
  return (
    <ul ref={listRef} aria-label="Pull requests of this thread and its child threads" className="flex max-h-60 flex-col overflow-y-auto overflow-x-hidden">
      {data.items.map((item) => (
        <PrRow key={item.key} threadId={threadId} item={item} ownBranchKey={data.ownBranchKey} mixedRepos={mixedRepos} compact={compact} />
      ))}
      {listNotes(data, hiddenCount).map((note) => (
        <li key={note} className="px-1.5 py-1 text-xs text-muted-foreground">{note}</li>
      ))}
    </ul>
  );
}

function SummaryChecks({ status }: { status: PrStatus }) {
  const checks = checksText(status);
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 tabular-nums", checks.text,
        status.checks.state === "passing" && "text-success-foreground",
        status.checks.state === "no_checks" && "@max-[28rem]/thread-pr-summary:hidden")}
      role="img"
      aria-label={checks.label}
      title={checks.label}
    >
      {checks.icon === null ? (
        status.checks.state === "pending" ? <Dot className="bg-attention" /> : null
      ) : <Icon name={checks.icon} className="size-3 shrink-0" aria-hidden />}
      <span className="@max-[28rem]/thread-pr-summary:hidden">
        {status.checks.state === "passing" ? `${status.checks.passed}/${status.checks.total}` : checks.label}
      </span>
    </span>
  );
}

function InlinePr({ threadId, item, mixedRepos }: { threadId: string; item: ThreadPr; mixedRepos: boolean }) {
  const open = useOpenUrl();
  const status = item.status;
  const state = status === null ? null : STATE[status.state];
  const active = status?.state === "open" || status?.state === "draft";
  const review = active && (status.review === "approved" || status.review === "changes_requested" || status.review === "review_requested")
    ? REVIEW[status.review] : null;
  const title = status?.title ?? `${item.repo}#${item.number}`;
  const [rowRef, compact] = useFitsCompact<HTMLDivElement>();
  return (
    // Takes the row space bb's Git toggle leaves (see the content script below),
    // down to a floor that still fits the compact row.
    <div data-thread-prs-summary="" className="@container/thread-pr-summary min-w-44 flex-1">
      <div ref={rowRef} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap px-2 text-xs text-muted-foreground">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open(item.url)}
          title={`${item.repo}#${item.number} ${title}`}
          aria-label={`Open ${item.repo}#${item.number}: ${title}${state ? ` (${state.label})` : ""}`}
          // No min-w-0 here: the link may shrink only down to icon + number, so the
          // hover and focus box always wraps them. Only the title gives up width.
          className="group/pr-link -ml-1 flex min-h-10 items-center gap-1.5 rounded px-1 text-foreground no-underline transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon name={state?.icon ?? "GitPullRequest"} className={cn("size-3.5 shrink-0", state?.text ?? "text-muted-foreground")} aria-hidden />
          <span className="flex items-baseline gap-1.5">
            <span className="max-w-24 shrink-0 truncate font-normal tabular-nums text-muted-foreground @max-[14rem]/thread-pr-summary:font-medium">{numberLabel(item, mixedRepos)}</span>
            {/* minmax(0, max-content) gives the title a min-content width of 0, so it
                truncates without raising the link's minimum width. */}
            <span className="grid min-w-0 grid-cols-[minmax(0,max-content)] @max-[14rem]/thread-pr-summary:sr-only">
              <span className="truncate font-medium group-hover/pr-link:underline">{title}</span>
            </span>
          </span>
        </a>
        {compact ? <AutoFixOnDot item={item} /> : null}
        {status === null ? (
          compact ? (
            item.error ? <span title={item.error} className="inline-flex shrink-0"><Icon name="AlertTriangle" className="size-3" aria-label="Status unavailable" /></span> : null
          ) : (
            <span className="shrink-0" title={item.error ?? undefined}>{item.error ? "Status unavailable" : "Loading status…"}</span>
          )
        ) : (
          <SummaryChecks status={status} />
        )}
        {review === null ? null : (
          <span className={cn("shrink-0 @max-[40rem]/thread-pr-summary:hidden", review.text)} data-promptbox-hide-compact="">
            {review.label}
          </span>
        )}
        <UnresolvedComments count={status?.unresolvedReviewThreadCount} compact={compact} />
        <PrActions threadId={threadId} item={item} compact={compact} className="empty:hidden" />
      </div>
    </div>
  );
}

/** bb's own segment shows the thread's branch PR; this adds only Copilot's findings beside it. */
function OwnBranchCopilot({ threadId, item }: { threadId: string; item: ThreadPr }) {
  const open = useOpenUrl();
  return (
    <div className="flex shrink-0 items-center px-1">
      <CopilotFollowUp threadId={threadId} item={item} openUrl={open} />
    </div>
  );
}

function SegmentSummary(props: ExperimentalThreadContextSegmentProps) {
  const { threadId, isExpanded, onToggle } = props;
  const { data, hiddenCount, mixedRepos, activeOnly, badgeHasOwn } = useSegmentPrs(props);
  if (!hasExtras(data, badgeHasOwn)) return null;
  if (data.items.length === 1) {
    const only = data.items[0]!;
    return only.key === data.ownBranchKey && badgeHasOwn
      ? <OwnBranchCopilot threadId={threadId} item={only} />
      : <InlinePr threadId={threadId} item={only} mixedRepos={mixedRepos} />;
  }
  const dots = data.items.slice(0, 6);
  const copilotCount = data.items.filter((item) => item.copilotFollowUp).length;
  const label = [
    `${data.items.length} ${activeOnly ? "active " : ""}pull requests from this thread and its child threads`,
    copilotCount ? `Copilot has concerns on ${copilotCount === 1 ? "1 pull request" : `${copilotCount} pull requests`}` : null,
    ...listNotes(data, hiddenCount),
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={label}
      title={label}
      className={cn(
        "flex min-h-6 min-w-8 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isExpanded && "bg-state-active text-foreground",
      )}
    >
      <Icon name="GitPullRequest" className="size-3.5 shrink-0" aria-hidden />
      <span className="shrink-0 tabular-nums">{activeOnly ? "Active PRs" : "PRs"} {data.items.length}</span>
      <span className="flex shrink-0 items-center gap-0.5" data-promptbox-hide-compact="">
        {dots.map((item) => (
          <Dot
            key={item.key}
            className={
              item.status === null
                ? "bg-border"
                : item.status.checks.state === "failing" && (item.status.state === "open" || item.status.state === "draft")
                  ? "bg-destructive"
                  : STATE[item.status.state].dot
            }
          />
        ))}
      </span>
      {copilotCount ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 tabular-nums text-attention-foreground">
          <Icon name="Bot" className="size-3.5 shrink-0" aria-hidden />
          {copilotCount > 1 ? copilotCount : null}
        </span>
      ) : null}
    </button>
  );
}

function SegmentDetails(props: ExperimentalThreadContextSegmentProps) {
  const { threadId, isExpanded } = props;
  const { data, hiddenCount, mixedRepos, badgeHasOwn } = useSegmentPrs(props);
  if (!isExpanded || !hasExtras(data, badgeHasOwn) || data.items.length === 1) return null;
  return (
    <div className="px-1.5 pb-1.5">
      <PrList threadId={threadId} data={data} hiddenCount={hiddenCount} mixedRepos={mixedRepos} />
    </div>
  );
}

function useSegmentVisible(input: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const { data, badgeHasOwn } = useSegmentPrs(input);
  return kind === "banner" && hasExtras(data, badgeHasOwn);
}

function CardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const { data, hiddenCount, mixedRepos } = useThreadPrs(threadId);
  const openPullRequest = useOpenPullRequest();
  if (!hasExtras(data)) return null;
  return (
    <>
      {data.items.map((item) => {
        const status = item.status;
        const state = status === null ? null : STATE[status.state];
        const checks = status === null ? null : checksText(status);
        const source = sourceText(item, data.ownBranchKey);
        const review = status?.review === "approved" || status?.review === "changes_requested" ? REVIEW[status.review] : null;
        return (
          <ThreadContextCardRow
            key={item.key}
            leading={
              <Icon
                name={state?.icon ?? "GitPullRequest"}
                className={cn("size-3.5", state?.text ?? "text-muted-foreground")}
                aria-label={state?.label ?? "Pull request"}
              />
            }
            label={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span>{numberLabel(item, mixedRepos)} {status?.title ?? item.repo}</span>
                {source === null ? null : <span className="text-muted-foreground">{source.label}</span>}
                {review === null ? null : <span className={cn("text-xs", review.text)}>{review.label}</span>}
                <UnresolvedComments count={status?.unresolvedReviewThreadCount} />
                {item.error === null ? null : (
                  <span title={item.error} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Icon name="AlertTriangle" className="size-3" aria-hidden />
                    {status === null ? "Status unavailable" : "Not refreshed"}
                  </span>
                )}
              </span>
            }
            title={[
              `${item.repo}#${item.number}`,
              status?.title,
              state?.label,
              checks?.label,
              status ? REVIEW[status.review]?.label : null,
              source?.label,
              item.error,
            ]
              .filter(Boolean)
              .join(" · ")}
            trailing={
              status === null ? null : status.state === "open" || status.state === "draft" ? (
                <span className={cn("text-xs", checks?.text)}>{checks?.label}</span>
              ) : (
                <span className={cn("text-xs", state?.text)}>{state?.label}</span>
              )
            }
            action={<PrActions threadId={threadId} item={item} />}
            onClick={() => {
              if (!openPullRequest(item.url)) window.open(item.url, "_blank", "noopener,noreferrer");
            }}
          />
        );
      })}
      {listNotes(data, hiddenCount).map((note) => (
        <div key={note} className="px-1.5 py-1 text-xs text-muted-foreground">{note}</div>
      ))}
    </>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "align-changed-files",
    mount() {
      const style = document.createElement("style");
      // BB's Git summary grows to fill its share of the row. Keep that hit area
      // and align its contents, including the disclosure chevron, at the end.
      // When our single-PR summary shares the row, Git sizes to its own content
      // instead, so it stops splitting the row evenly with the PR, and the PR takes
      // the rest. Git still shrinks and clips when the row is tight.
      style.textContent = `
        #thread-prompt-banner-git-toggle {
          justify-content: flex-end;
        }
        #thread-prompt-banner-git-toggle > :last-child {
          margin-left: 0;
        }
        section:has([data-thread-prs-summary]) #thread-prompt-banner-git-toggle {
          flex: 0 1 auto;
        }
      `;
      document.head.append(style);
      return () => style.remove();
    },
  });
  app.slots.experimental_threadContextSegment({
    id: "thread-prs",
    title: "Pull requests of this thread",
    // bb's own PR segment is "2_pullRequest" order 10: sit right after it.
    group: "2_pullRequest",
    order: 20,
    summary: SegmentSummary,
    details: SegmentDetails,
    useVisible: useSegmentVisible,
  });
  app.slots.experimental_threadContextCardSection({
    id: "thread-prs",
    title: "Pull requests",
    group: SECTION_GROUPS.related,
    order: 50,
    component: CardSection,
  });
});
