import { useState, type MouseEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract, type CopilotIssue, type ThreadPr } from "../contract";
import { cn } from "./utils";

type FollowUp = NonNullable<ThreadPr["copilotFollowUp"]>;

const BUSY_REASON = "The agent is busy. Send when its turn ends.";

const SEVERITY_TEXT: Record<string, string> = {
  critical: "text-destructive-text",
  high: "text-destructive-text",
  medium: "text-attention-foreground",
};

function chipText(followUp: FollowUp): { short: string; full: string } {
  const count = followUp.issues.length;
  if (followUp.verdict === "closer_look") {
    return { short: "Copilot: closer look", full: "Copilot needs a closer look" };
  }
  return { short: `Copilot: ${count} open`, full: `Copilot: ${count} open ${count === 1 ? "issue" : "issues"}` };
}

function IssueItem({ issue, openUrl }: { issue: CopilotIssue; openUrl: (url: string) => (event: MouseEvent) => void }) {
  const where = issue.kind === "missed" ? "Missed in an earlier review" : "Still open from an earlier review";
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex min-w-0 items-baseline gap-1.5">
        {issue.severity ? (
          <span className={cn("shrink-0", SEVERITY_TEXT[issue.severity.toLowerCase()] ?? "text-muted-foreground")}>{issue.severity}</span>
        ) : null}
        {issue.url ? (
          <a href={issue.url} target="_blank" rel="noopener noreferrer" onClick={openUrl(issue.url)}
            className="min-w-0 break-words text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {issue.title}
          </a>
        ) : <span className="min-w-0 break-words text-foreground">{issue.title}</span>}
      </span>
      <span className="text-muted-foreground">
        {where}{issue.location ? <> · <span className="break-all font-mono">{issue.location}</span></> : null}
      </span>
      {issue.detail ? <span className="line-clamp-3 text-muted-foreground" title={issue.detail}>{issue.detail}</span> : null}
    </li>
  );
}

/**
 * Copilot's latest review still has concerns: a chip that opens the findings, with
 * Send to agent and Dismiss. Nothing reaches the agent without that click.
 */
export function CopilotFollowUp({ threadId, item, compact = false, openUrl }: {
  threadId: string;
  item: ThreadPr;
  compact?: boolean;
  openUrl: (url: string) => (event: MouseEvent) => void;
}) {
  const pluginId = experimental_usePluginId();
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "copilotFollowUp" });
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const followUp = item.copilotFollowUp;
  if (!followUp) return null;
  const text = chipText(followUp);
  const count = followUp.issues.length;
  const owner = followUp.ownerThreadTitle ? `“${followUp.ownerThreadTitle}”` : "the owner thread";
  const run = async (action: "send" | "dismiss") => {
    setFailure(null);
    try {
      const result = await mutation.mutate({ threadId, url: item.url, reviewId: followUp.reviewId, action });
      if (result.ok) {
        setOpen(false);
        toast.success(result.message);
      } else setFailure(result.message);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The request could not be completed.");
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFailure(null); }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title={`${text.full}. Show the findings`}
          aria-label={`${text.full} on pull request #${item.number}. Show the findings`}
          className="inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded px-1.5 text-xs tabular-nums text-attention-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active"
        >
          <Icon name="Bot" className="size-3.5 shrink-0" aria-hidden />
          {compact ? (count > 0 ? count : null) : text.short}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-bb-plugin-root=""
          data-bb-plugin={pluginId}
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={`${text.full} on pull request #${item.number}`}
          className="z-50 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-2.5 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
        >
          <div className="flex items-center gap-1.5">
            <Icon name="Bot" className="size-3.5 shrink-0 text-attention-foreground" aria-hidden />
            <span className="min-w-0 flex-1 font-medium">{followUp.verdictLabel || "Copilot review"}</span>
            <a href={followUp.reviewUrl} target="_blank" rel="noopener noreferrer" onClick={openUrl(followUp.reviewUrl)}
              className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
              Open review
            </a>
          </div>
          {followUp.summary ? <p className="text-pretty break-words">{followUp.summary}</p> : null}
          {count > 0 ? (
            <ul aria-label="Copilot's findings" className="-mr-1 flex max-h-72 flex-col gap-2.5 overflow-y-auto border-t border-border pt-2.5 pr-1">
              {followUp.issues.map((issue, index) => <IssueItem key={`${issue.url ?? issue.title}-${index}`} issue={issue} openUrl={openUrl} />)}
            </ul>
          ) : null}
          <p className="text-muted-foreground">
            {followUp.ownerBusy ? BUSY_REASON : `Send asks the agent in ${owner} to check each finding, fix the valid ones and push.`}
          </p>
          {failure ? <p role="alert" className="text-destructive-text">{failure}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={mutation.isPending} onClick={() => void run("dismiss")}
              className="min-h-8 cursor-pointer rounded-md px-2.5 text-xs hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
              Dismiss
            </button>
            <button type="button" disabled={mutation.isPending || followUp.ownerBusy} onClick={() => void run("send")}
              title={followUp.ownerBusy ? BUSY_REASON : undefined}
              className="min-h-8 cursor-pointer rounded-md bg-primary px-2.5 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
              {mutation.isPending ? "Working…" : "Send to agent"}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
