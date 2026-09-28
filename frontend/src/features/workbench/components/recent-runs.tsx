import { useEffect, useState } from "react";
import { Icon } from "@/components/shared/icon";
import { relativeTime } from "@/features/chat/lib/chat-helpers";
import { type RecentRunInfo, call } from "@/lib/api";
import { logWarn } from "@/lib/logger";

/** Backend-read fuse: a stalled invoke must land in the error/Retry state,
 *  never skeleton forever (a deadlocked backend task never settles the
 *  promise — e.g. a wiped data dir under a cached DB handle). */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * Landing "Recent runs" — the cross-session journal strip: the newest plan
 * record from every session with runs. Row markup mirrors RunHistory
 * (bordered card, goal + meta line + status icon) so the two history surfaces
 * read as one system. An empty list or a first-load failure renders an
 * inline line (failure: with a Retry) instead of nothing.
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
  // The fetch failed AND there is nothing on screen to show — surface the
  // error line + Retry instead of a silent blank. A failed REFETCH of a
  // non-empty list keeps the rows already visible (never blanks them).
  const [failed, setFailed] = useState(false);
  // Manual Retry re-runs the effect (a failed first load also leaves
  // `runs` at [], so the effect must be re-triggerable without a bump).
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    void reloadKey; // refetch trigger — a bump forces a fresh list read
    void retryKey; // manual Retry — same, via the button below
    let cancelled = false;
    // The timer lives for the fetch only; a settled (or cancelled) read
    // disarms it so no stray rejection flips the state later.
    let timer: number | undefined;
    const stale = () =>
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("list_recent_runs timed out")), LOAD_TIMEOUT_MS);
      });
    void Promise.race([call<RecentRunInfo[]>("list_recent_runs", {}), stale()])
      .then((rows) => {
        if (!cancelled) {
          // Defensive: a non-array body must not re-poison `runs` (null
          // would pin the skeleton forever).
          setRuns(Array.isArray(rows) ? rows : []);
          setFailed(false);
        }
      })
      .catch((err) => {
        logWarn("list_recent_runs", err);
        if (!cancelled) {
          setFailed(true);
          setRuns((prev) => prev ?? []);
        }
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, reloadKey, retryKey]);

  // First load: skeleton rows instead of a silent pop-in.
  if (runs === null) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-2 p-6 text-left">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Recent runs</h3>
        </div>
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
  // Nothing on screen: a failed fetch says WHY and offers a Retry, an empty
  // result sets expectations — both beats a silent blank.
  if (runs.length === 0) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6 text-left">
        {failed ? (
          <div className="flex items-center gap-3">
            <p className="text-muted-foreground font-mono text-xs" role="alert">
              Couldn&apos;t load recent runs.
            </p>
            <button
              type="button"
              onClick={() => setRetryKey((k) => k + 1)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md font-mono text-[10px] tracking-wider uppercase transition-colors hover:underline"
            >
              <Icon name="refresh-cw" className="size-3" />
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-foreground font-mono text-xs">No runs yet.</p>
            <p className="text-muted-foreground font-mono text-xs">
              State a goal above — completed runs land here, and reopening one shows its full deliverable.
            </p>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-4xl space-y-2 p-6 text-left">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Recent runs</h3>
      </div>
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
