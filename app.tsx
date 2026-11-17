// Thread PRs frontend: a context-row segment after bb's own PR segment, and the
// same list as a thread context card section when the pane shows the card.
import { useState, type MouseEvent, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  experimental_useThreadContextKind,
  useBbNavigate,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract, type PrStatus, type ThreadPr, type ThreadPrs } from "./contract";
import { cn } from "@/lib/utils";

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
  return experimental_useRpcQuery({
    contract: rpcContract,
    method: "threadPullRequests",
    input: { threadId },
  });
}

/** The list adds something only when it holds a PR other than the one bb's own segment shows. */
function hasExtras(data: ThreadPrs | undefined): data is ThreadPrs {
  return data !== undefined && data.items.some((item) => item.key !== data.ownBranchKey);
}

function useOpenUrl() {
  const navigate = useBbNavigate();
  return (url: string) => (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (navigate.openUrl(url)) event.preventDefault();
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
        className="inline-flex cursor-pointer items-center whitespace-nowrap rounded border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-xs transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        aria-label={`Mark pull request #${item.number} ready for review`}
      >
        {mutation.isPending ? "Marking…" : "Mark ready"}
      </button>
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
        <span key="error" title={item.error}>
          Status unavailable
        </span>
      ),
    );
  } else {
    const checks = checksText(status);
    const review = status.state === "open" || status.state === "draft" ? REVIEW[status.review] : null;
    parts.push(
      <span key="state" className={STATE[status.state].text}>
        {STATE[status.state].label}
      </span>,
    );
    if (status.state === "open" || status.state === "draft") {
      parts.push(
        <span key="checks" className={cn("inline-flex items-center gap-1", checks.text)}>
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
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index} className="flex min-w-0 shrink-0 items-center gap-1.5 last:shrink">
          {index > 0 ? <span aria-hidden>·</span> : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function PrRow({ threadId, item, ownBranchKey }: { threadId: string; item: ThreadPr; ownBranchKey: string | null }) {
  const open = useOpenUrl();
  const status = item.status;
  const state = status === null ? null : STATE[status.state];
  const title = status?.title ?? `${item.repo}#${item.number}`;
  const done = status?.state === "merged" || status?.state === "closed";
  return (
    <li className={cn("flex items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-state-hover", done && "opacity-70")}>
      <Icon
        name={state?.icon ?? "GitPullRequest"}
        className={cn("mt-px size-3.5 shrink-0", state?.text ?? "text-muted-foreground")}
        aria-label={state?.label ?? "Pull request"}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={open(item.url)}
          title={`${item.repo}#${item.number} ${title}`}
          className="flex min-w-0 items-baseline gap-1.5 text-foreground no-underline hover:underline"
        >
          <span className="shrink-0 tabular-nums">#{item.number}</span>
          <span className="min-w-0 truncate">{title}</span>
        </a>
        <StatusLine item={item} ownBranchKey={ownBranchKey} />
      </span>
      {status?.state === "draft" ? <MarkReadyButton threadId={threadId} item={item} /> : null}
    </li>
  );
}

function PrList({ threadId, data }: { threadId: string; data: ThreadPrs }) {
  return (
    <ul aria-label="Pull requests of this thread and its child threads" className="flex max-h-60 flex-col overflow-y-auto">
      {data.items.map((item) => (
        <PrRow key={item.key} threadId={threadId} item={item} ownBranchKey={data.ownBranchKey} />
      ))}
    </ul>
  );
}

function SegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const { data } = useThreadPrs(threadId);
  if (!hasExtras(data)) return null;
  const dots = data.items.slice(0, 6);
  const label = `${data.items.length} pull requests from this thread and its child threads`;
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
      <span className="shrink-0 tabular-nums">PRs {data.items.length}</span>
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
  const { data } = useThreadPrs(threadId);
  if (!isExpanded || !hasExtras(data)) return null;
  return (
    <div className="px-1.5 pb-1.5">
      <PrList threadId={threadId} data={data} />
    </div>
  );
}

function useSegmentVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const kind = experimental_useThreadContextKind();
  const { data } = useThreadPrs(threadId);
  return kind === "banner" && hasExtras(data);
}

function CardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const { data } = useThreadPrs(threadId);
  const navigate = useBbNavigate();
  if (!hasExtras(data)) return null;
  return (
    <>
      {data.items.map((item) => {
        const status = item.status;
        const state = status === null ? null : STATE[status.state];
        const checks = status === null ? null : checksText(status);
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
            label={`#${item.number} ${status?.title ?? item.repo}`}
            title={[
              `${item.repo}#${item.number}`,
              status?.title,
              state?.label,
              checks?.label,
              status ? REVIEW[status.review]?.label : null,
              item.key === data.ownBranchKey ? "This branch" : null,
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
            action={status?.state === "draft" ? <MarkReadyButton threadId={threadId} item={item} /> : undefined}
            onClick={() => {
              if (!navigate.openUrl(item.url)) window.open(item.url, "_blank", "noopener,noreferrer");
            }}
          />
        );
      })}
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
