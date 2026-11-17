// Thread PRs frontend: a context-row segment after bb's own PR segment, and the
// same list as a thread context card section when the pane shows the card.
import { useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useThreadContextKind,
  useBbNavigate,
  useSettings,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { autoFixLastSendLabel, rpcContract, truncationText, type PrStatus, type ThreadPr, type ThreadPrs } from "./contract";
import { cn } from "./lib/utils";
import { Tooltip } from "./lib/tooltip";
import { PrQuickActions } from "./lib/pr-actions";

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

/** The list adds something only when it holds a PR other than the one bb's own segment shows. */
function hasExtras(data: ThreadPrs | undefined): data is ThreadPrs {
  return data !== undefined && data.items.some((item) => item.key !== data.ownBranchKey);
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
        <span role="alert" title={failure} className="max-w-40 truncate text-destructive-text">
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
      {failure === null ? null : <span role="alert" title={failure} className="max-w-40 truncate text-destructive-text">{failure}</span>}
      <Tooltip content={
        <span className="flex flex-col gap-1">
          <span className="font-medium">{state.enabled ? "Auto-fix enabled" : "Auto-fix disabled"}</span>
          <span>{state.stoppedReason ?? state.activity ?? "Enable to monitor CI and review feedback"}</span>
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

function PrActions({ threadId, item }: { threadId: string; item: ThreadPr }) {
  const open = useOpenUrl();
  const actionsRef = useRef<HTMLSpanElement>(null);
  const active = item.status?.state === "open" || item.status?.state === "draft";
  return (
    <span ref={actionsRef} className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
      {item.status?.state === "draft" ? <MarkReadyButton threadId={threadId} item={item} /> : null}
      {active ? <AutoFixButton threadId={threadId} item={item} /> : null}
      <PrQuickActions threadId={threadId} item={item} onOpenDiff={open(`${item.url}/files`)}
        onReturnFocus={() => actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus()} />
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

function PrRow({ threadId, item, ownBranchKey, mixedRepos }: {
  threadId: string;
  item: ThreadPr;
  ownBranchKey: string | null;
  mixedRepos: boolean;
}) {
  const open = useOpenUrl();
  const status = item.status;
  const state = status === null ? null : STATE[status.state];
  const title = status?.title ?? `${item.repo}#${item.number}`;
  const done = status?.state === "merged" || status?.state === "closed";
  return (
    <li className={cn("flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-xs hover:bg-state-hover", done && "opacity-70")}>
      <Icon
        name={state?.icon ?? "GitPullRequest"}
        className={cn("mt-px size-3.5 shrink-0", state?.text ?? "text-muted-foreground")}
        aria-label={state?.label ?? "Pull request"}
      />
      <span className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
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
        </a>
        <StatusLine item={item} ownBranchKey={ownBranchKey} />
      </span>
      <PrActions threadId={threadId} item={item} />
    </li>
  );
}

function PrList({ threadId, data, hiddenCount, mixedRepos }: {
  threadId: string;
  data: ThreadPrs;
  hiddenCount: number;
  mixedRepos: boolean;
}) {
  return (
    <ul aria-label="Pull requests of this thread and its child threads" className="flex max-h-60 flex-col overflow-y-auto">
      {data.items.map((item) => (
        <PrRow key={item.key} threadId={threadId} item={item} ownBranchKey={data.ownBranchKey} mixedRepos={mixedRepos} />
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
        status.checks.state === "passing" && "text-success-foreground")}
      aria-label={checks.label}
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
  return (
    <div className="@container/thread-pr-summary min-w-0 flex-1">
      <div className="flex min-h-6 min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <Icon name={state?.icon ?? "GitPullRequest"} className={cn("size-3.5 shrink-0", state?.text)} aria-label={state?.label ?? "Pull request"} />
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open(item.url)}
          title={`${item.repo}#${item.number} ${title}`}
          aria-label={`Open ${item.repo}#${item.number}: ${title}`}
          className="flex min-w-0 items-baseline gap-1.5 rounded text-foreground no-underline hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="shrink-0 tabular-nums">{numberLabel(item, mixedRepos)}</span>
          <span className="min-w-0 truncate">{title}</span>
        </a>
        <span className={cn("flex shrink-0 items-center gap-1.5", status?.checks.state === "no_checks" && "@max-[28rem]/thread-pr-summary:hidden")}>
          <span aria-hidden>·</span>
          {status === null ? <span title={item.error ?? undefined}>{item.error ? "Status unavailable" : "Loading status…"}</span> : <SummaryChecks status={status} />}
        </span>
        {review === null ? null : (
          <span className="flex shrink-0 items-center gap-1.5 @max-[40rem]/thread-pr-summary:hidden" data-promptbox-hide-compact="">
            <span aria-hidden>·</span>
            <span className={review.text}>{review.label}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {status?.state === "draft" ? <MarkReadyButton threadId={threadId} item={item} /> : null}
          {active ? <AutoFixButton threadId={threadId} item={item} /> : null}
        </span>
      </div>
    </div>
  );
}

function SegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const { data, hiddenCount, mixedRepos, activeOnly } = useThreadPrs(threadId);
  if (!hasExtras(data)) return null;
  if (data.items.length === 1) return <InlinePr threadId={threadId} item={data.items[0]} mixedRepos={mixedRepos} />;
  const dots = data.items.slice(0, 6);
  const label = [
    `${data.items.length} ${activeOnly ? "active " : ""}pull requests from this thread and its child threads`,
    ...listNotes(data, hiddenCount),
  ].join(" · ");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={label}
      title={label}
      className={cn(
        "flex min-h-6 min-w-8 cursor-pointer items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
    </button>
  );
}

function SegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { data, hiddenCount, mixedRepos } = useThreadPrs(threadId);
  if (!isExpanded || !hasExtras(data) || data.items.length === 1) return null;
  return (
    <div className="px-1.5 pb-1.5">
      <PrList threadId={threadId} data={data} hiddenCount={hiddenCount} mixedRepos={mixedRepos} />
    </div>
  );
}

function useSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const { data } = useThreadPrs(threadId);
  return kind === "banner" && hasExtras(data);
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
