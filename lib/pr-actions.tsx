import { useEffect, useRef, useState, type MouseEventHandler } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, experimental_useRpcMutation, useSettings } from "@get-bb/plugin-sdk/app";
import { commitOidSchema, rpcContract, type ConfirmedMerge, type MergeMethod, type ThreadPr } from "../contract";
import { Tooltip } from "./tooltip";

const ICON_BUTTON = "inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-40";
const METHOD_LABELS: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" };

const MENU_ITEM = "flex min-h-8 cursor-default select-none items-center gap-2 rounded px-2 py-1 text-xs outline-none [@media(pointer:coarse)]:min-h-10 data-[highlighted]:bg-state-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

function MenuAction({ label, hint, icon, reason, pending, onSelect }: {
  label: string; hint: string; icon: string; reason: string | null; pending: boolean; onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item disabled={pending || reason !== null} className={MENU_ITEM} onSelect={onSelect}
      title={reason ?? hint} aria-description={reason ?? hint}>
      <Icon name={pending ? "RefreshCw" : icon} className={pending ? "size-3.5 shrink-0 animate-spin motion-reduce:animate-none" : "size-3.5 shrink-0"} aria-hidden />
      <span>{label}</span>
    </DropdownMenu.Item>
  );
}

function MergeConfirmation({ confirmation, onClose, onMerged, returnFocus }: {
  confirmation: ConfirmedMerge; onClose: () => void; onMerged: () => void; returnFocus: () => void;
}) {
  const pluginId = experimental_usePluginId();
  const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "mergePullRequest" });
  const [method, setMethod] = useState<MergeMethod>(confirmation.preview.methods[0]!);
  const [failure, setFailure] = useState<string | null>(null);
  const submitted = useRef(false);
  const pr = confirmation.preview;
  const run = async () => {
    if (submitted.current) return;
    submitted.current = true;
    setFailure(null);
    try {
      const result = await mutation.mutate({ token: confirmation.token, method });
      if (result.ok) { toast.success(result.message); onMerged(); }
      else setFailure(result.message);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The merge could not be confirmed. Refresh the PR before trying again.");
    }
  };
  return (
    <AlertDialog.Root open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-bb-plugin-root="" data-bb-plugin={pluginId} className="fixed inset-0 z-50 bg-black/30" />
        <AlertDialog.Content data-bb-plugin-root="" data-bb-plugin={pluginId}
          onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus(); }}
          className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl">
          <AlertDialog.Title className="text-base font-medium">Merge {pr.repo}#{pr.number}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
            This merges the reviewed commit into {pr.baseRefName}. GitHub will check repository rules again.
          </AlertDialog.Description>
          <div className="mt-4 space-y-3 text-sm">
            <p className="break-words">{pr.title}</p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">From</dt><dd className="break-all">{pr.headRefName}</dd>
              <dt className="text-muted-foreground">Into</dt><dd className="break-all">{pr.baseRefName}</dd>
              <dt className="text-muted-foreground">Commit</dt><dd className="break-all font-mono text-xs">{pr.headRefOid}</dd>
            </dl>
            <label className="flex flex-col gap-1.5">
              Merge method
              <select value={method} disabled={mutation.isPending || submitted.current}
                className="min-h-10 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onChange={(event) => {
                  const next = pr.methods.find((candidate) => candidate === event.target.value);
                  if (next) setMethod(next);
                }}>
                {pr.methods.map((value) => <option key={value} value={value}>{METHOD_LABELS[value]}</option>)}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">Confirmation expires after two minutes. Your branch is kept.</p>
            {failure ? <p role="alert" className="text-sm text-destructive-text">{failure} Close this dialog and check the PR before trying again.</p> : null}
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={mutation.isPending} className="min-h-10 rounded-md px-3 text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">{failure ? "Close" : "Cancel"}</button>
            </AlertDialog.Cancel>
            <button type="button" disabled={mutation.isPending || submitted.current} onClick={() => void run()}
              className="min-h-10 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50">
              {mutation.isPending ? "Merging…" : "Merge pull request"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function PrQuickActions({ threadId, item, onOpenDiff, onReturnFocus }: {
  threadId: string; item: ThreadPr; onOpenDiff: MouseEventHandler<HTMLAnchorElement>; onReturnFocus?: () => void;
}) {
  const retry = experimental_useRpcMutation({ contract: rpcContract, method: "rerunFailedCi" });
  const copilot = experimental_useRpcMutation({ contract: rpcContract, method: "requestCopilotReview" });
  const draft = experimental_useRpcMutation({ contract: rpcContract, method: "markDraft" });
  const prepare = experimental_useRpcMutation({ contract: rpcContract, method: "prepareMerge" });
  const pluginId = experimental_usePluginId();
  const settings = useSettings().values;
  const showDiff = settings?.showViewDiffAction !== false;
  const showRetry = settings?.showRerunFailedCiAction !== false;
  const showCopilot = settings?.showCopilotReviewAction !== false;
  const showDraft = settings?.showMarkDraftAction !== false;
  const showMerge = settings?.showMergeAction !== false;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmedMerge | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const active = item.status?.state === "open" || item.status?.state === "draft";
  const hasItems = showDiff || (active && (showRetry || showCopilot || showMerge)) || (item.status?.state === "open" && showDraft);
  useEffect(() => {
    if (!hasItems) setMenuOpen(false);
  }, [hasItems]);
  const busy = retry.isPending || copilot.isPending || draft.isPending || prepare.isPending || confirmation !== null;
  const expectedHead = commitOidSchema.safeParse(item.status?.headRefOid).data;
  const retryReason = busy ? "Another action is running" : item.error ? "Refresh GitHub status first" :
    !expectedHead ? "Loading the current commit" : !item.status?.checks.failed ? "No failed checks to retry" : null;
  const mergeReason = busy ? "Another action is running" : item.error ? "Refresh GitHub status first" :
    item.status?.state === "draft" ? "Mark the draft ready before merging" :
      !item.status?.checksComplete ? "Complete CI data is required before merging" :
        item.status.checks.failed || item.status.checks.pending ? "Wait for passing CI checks" : null;
  const run = async (action: "retry" | "copilot" | "draft" | "merge") => {
    if (busyRef.current || busy) return;
    busyRef.current = true;
    try {
      if (action === "merge") {
        const result = await prepare.mutate({ threadId, url: item.url });
        if (result.ok) setConfirmation(result.confirmation);
        else toast.error(result.message);
      } else {
        if (action === "retry" && !expectedHead) return;
        const result = action === "retry" && expectedHead
          ? await retry.mutate({ threadId, url: item.url, expectedHead })
          : action === "draft"
            ? await draft.mutate({ threadId, url: item.url })
            : await copilot.mutate({ threadId, url: item.url });
        if (result.ok) toast.success(result.message);
        else toast.error(result.message);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The PR action could not be completed.");
    } finally { busyRef.current = false; }
  };
  // Visibility changes must not tear down a confirmation or hide a submitted write's result.
  if (!hasItems && !confirmation) return null;
  return (
    <>
      {hasItems ? <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip content="PR actions">
          <DropdownMenu.Trigger asChild>
            <button ref={triggerRef} type="button" aria-label={`Actions for pull request #${item.number}`} className={ICON_BUTTON} aria-busy={busy}>
              <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden="true">
                <circle cx="4" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="20" cy="12" r="1.8" />
              </svg>
            </button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-bb-plugin-root="" data-bb-plugin={pluginId} align="end" sideOffset={4}
            aria-label={`Actions for pull request #${item.number}`}
            className="z-50 w-48 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            {showDiff ? <DropdownMenu.Item asChild className={MENU_ITEM}>
              <a href={`${item.url}/files`} target="_blank" rel="noopener noreferrer" onClick={(event) => { onOpenDiff(event); setMenuOpen(false); }}>
                <Icon name="FileDiff" className="size-3.5 shrink-0" aria-hidden />View diff
              </a>
            </DropdownMenu.Item> : null}
            {active && showRetry ? <MenuAction label="Re-run failed CI" hint="Uses GitHub Actions runner minutes" icon="RotateCcw"
              reason={retryReason} pending={retry.isPending} onSelect={() => void run("retry")} /> : null}
            {active && showCopilot ? <MenuAction label="Copilot review" hint="Uses Copilot quota" icon="Bot"
              reason={busy ? "Another action is running" : null} pending={copilot.isPending} onSelect={() => void run("copilot")} /> : null}
            {item.status?.state === "open" && showDraft ? <MenuAction label="Mark as draft" hint="Can be reversed with Mark ready" icon="GitPullRequestDraft"
              reason={busy ? "Another action is running" : item.error ? "Refresh GitHub status first" : null} pending={draft.isPending} onSelect={() => void run("draft")} /> : null}
            {active && showMerge ? <MenuAction label="Merge…" hint="Review and confirm before merging" icon="GitMerge"
              reason={mergeReason} pending={prepare.isPending} onSelect={() => void run("merge")} /> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root> : null}
      {confirmation ? <MergeConfirmation confirmation={confirmation} onClose={() => setConfirmation(null)} onMerged={() => setConfirmation(null)}
        returnFocus={() => { if (triggerRef.current) triggerRef.current.focus(); else onReturnFocus?.(); }} /> : null}
    </>
  );
}
