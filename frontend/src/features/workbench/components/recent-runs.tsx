import { useEffect, useState } from "react";
import { Icon } from "@/components/shared/icon";
import { relativeTime } from "@/features/chat/lib/chat-helpers";
import { type RecentRunInfo, call } from "@/lib/api";
import { logWarn } from "@/lib/logger";

/**
 * Landing "Recent runs" — the cross-session journal strip: the newest plan
 * record from every session with runs. Row markup mirrors RunHistory
 * (bordered card, goal + meta line + status icon) so the two history surfaces
 * read as one system. Renders nothing on an empty list or a fetch failure.
 *
 * `reloadKey` bumps when a run just finished or the session dialog closed —
 * the list refetches so fresh records, renames, and deletes show up.
 */
export function RecentRuns({
  open,
  reloadKey,
  onOpen,
}: {
  /** The landing hero is visible (and the dialog is closed) — fetch/show. */
  open: boolean;
  /** Bumped by the owner to force a refetch. */
  reloadKey: number;
  onOpen: (run: RecentRunInfo) => void;
}) {
  const [runs, setRuns] = useState<RecentRunInfo[] | null>(null);

  useEffect(() => {
    if (!open) return;
    void reloadKey; // refetch trigger — a bump forces a fresh list read
    let cancelled = false;
    void call<RecentRunInfo[]>("list_recent_runs", {})
      .then((rows) => {
        if (!cancelled) setRuns(rows);
      })
      .catch((err) => {
        logWarn("list_recent_runs", err);
        // First-load failure renders nothing (documented) — a refetch
        // failure keeps the rows already on screen.
        if (!cancelled) setRuns((prev) => prev ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  // First load: skeleton rows instead of a silent pop-in.
  if (runs === null) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-2 p-6 text-left">
        <div className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Recent runs</div>
        {[0, 1, 2].map((i) => (
          <div className="border-border/60 flex items-center justify-between gap-3 rounded-lg border p-3" key={i}>
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-4 w-2/3 animate-pulse rounded bg-accent" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-accent" />
            </div>
            <div className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-accent" />
          </div>
        ))}
      </div>
    );
  }
  if (runs.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-2 p-6 text-left">
      <h3 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Recent runs</h3>
      {runs.map((run) => (
        <button
          className="group border-border/60 hover:border-primary/50 flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors"
          key={run.rowId}
          onClick={() => onOpen(run)}
          title={`Open: ${run.goal || run.sessionTitle || "session"}`}
          type="button"
        >
          <div className="min-w-0 flex-1 text-left">
            <div className="text-foreground truncate text-sm">{run.goal || run.sessionTitle || "Untitled session"}</div>
            <div className="text-muted-foreground font-mono text-[11px]">
              {relativeTime(run.createdAt)}
              {run.goal && run.sessionTitle && ` · ${run.sessionTitle}`}
              {` · ${run.stepsDone}/${run.stepsTotal} steps`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-primary font-mono text-[10px] group-hover:underline">Open</span>
            {run.status === "completed" ? (
              <Icon name="check-circle-2" className="text-success size-4" />
            ) : (
              <Icon name="circle-x" className="text-destructive size-4" />
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
