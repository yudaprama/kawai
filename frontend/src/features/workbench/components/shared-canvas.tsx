/**
 * Shared canvas primitives for the workbench viewer.
 *
 * Extracted from DeliverableViewer + PastRunCanvas to eliminate duplicated
 * per-step fetch/cache/render and AGENT REPORTS grid logic — the root cause
 * of the StrictMode deadlock and renderer-mismatch bugs.
 */
import { CornerDownRightIcon, FileTextIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { renderStepReport } from "@/features/workbench/components/tool-views";

// ── useStepReport hook ──────────────────────────────────────────────────────

/** Per-step full-output fetch with cache + inflight guard.
 *
 *  The inflight ref prevents the StrictMode double-invoke deadlock:
 *  a double-mounted effect discards the first fetch's cleanup (`cancelled = true`)
 *  while the second run early-returns on the "loading" body, leaving the
 *  spinner stuck forever. The ref survives re-renders and re-mounts within
 *  the same component identity, so only one fetch is in flight at a time.
 *
 *  @param cacheKey  Changes when the entire cache should be cleared (e.g.
 *                   run id for history, goal+planVersion for live).
 *  @param stepId    The step to fetch. null/undefined = skip.
 *  @param fetcher   `(stepId, planKey?) => Promise<string | null>`.
 *  @param planKey   Optional, passed through to the fetcher.
 *  @param needsFetch  true when the full body must be fetched (always for
 *                     history; for live, when preview ≥ 2000 chars).
 *  @returns `{ output, loading }` — output is the full body or the
 *            caller's preview (when fetch wasn't needed). loading is true
 *            while the fetch is in flight. */
export function useStepReport({
  cacheKey,
  stepId,
  fetcher,
  planKey,
  needsFetch,
}: {
  cacheKey: string;
  stepId: string | null | undefined;
  fetcher: (stepId: string, planKey?: string) => Promise<string | null>;
  planKey?: string;
  needsFetch: boolean;
}): { output: string | null; loading: boolean } {
  const [bodies, setBodies] = useState<Record<string, string | "loading" | "failed">>({});
  const inflight = useRef<Set<string>>(new Set());

  // Clear the cache when the identity changes (new run, new plan, etc.).
  // biome-ignore lint/correctness/useExhaustiveDependencies: cache key changes are the point
  useEffect(() => {
    setBodies({});
  }, [cacheKey]);

  const body = stepId != null ? bodies[stepId] : undefined;

  useEffect(() => {
    if (!stepId || !needsFetch || (body != null && body !== "loading") || inflight.current.has(stepId)) return;
    inflight.current.add(stepId);
    if (body == null) setBodies((prev) => ({ ...prev, [stepId]: "loading" }));
    fetcher(stepId, planKey)
      .then((full) => {
        setBodies((prev) => ({ ...prev, [stepId]: full ?? "failed" }));
      })
      .catch((err) => {
        console.error("[workbench] step report fetch REJECTED:", err);
        setBodies((prev) => ({ ...prev, [stepId]: "failed" }));
      })
      .finally(() => {
        inflight.current.delete(stepId);
      });
  }, [body, stepId, needsFetch, fetcher, planKey]);

  // `failed` is terminal: keep the preview visible and stop showing an
  // infinite spinner when the persisted full-report lookup is unavailable.
  const loading = body === "loading" || (body == null && needsFetch);
  const output = body != null && body !== "loading" && body !== "failed" ? body : null;
  return { output, loading };
}

// ── StepReportBody ──────────────────────────────────────────────────────────

/** Fetches (if needed) and renders a single step's full report body.
 *  Shared between DeliverableViewer (live) and PastRunCanvas (history). */
export function StepReportBody({
  stepId,
  tool,
  previewOutput,
  fetcher,
  planKey,
  needsFetch,
  cacheKey,
}: {
  cacheKey?: string;
  stepId: string;
  tool: string;
  /** The ≤2000-char wire preview. Used as-is when not truncated. */
  previewOutput: string;
  /** `(stepId, planKey?) => full body`. */
  fetcher: (stepId: string, planKey?: string) => Promise<string | null>;
  planKey?: string;
  /** true = full body must be fetched (preview truncated or history). */
  needsFetch: boolean;
}) {
  const { output, loading } = useStepReport({
    cacheKey: cacheKey ?? "step-report",
    stepId,
    fetcher,
    planKey,
    needsFetch,
  });
  const body = output ?? previewOutput;
  return (
    <div className="bg-card rounded-lg border p-4">
      {loading && (
        <p className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
          <LoaderCircleIcon className="text-primary size-3.5 animate-spin" />
          Loading full report…
        </p>
      )}
      {renderStepReport(tool, body)}
    </div>
  );
}

// ── AgentReportsSwitcher ────────────────────────────────────────────────────

/** The AGENT REPORTS grid — a document picker that switches the canvas
 *  between step reports (and, when one exists, the final deliverable).
 *  The deliverable sits on its own row above the grid — it is the run's
 *  primary output, not a peer of the reports. With no reports to switch
 *  to, the whole switcher stays hidden: the deliverable needs no button
 *  to show itself. */
export function AgentReportsSwitcher({
  activeDoc,
  reports,
  hasDeliverable,
  onPickDoc,
  onBuildOn,
}: {
  activeDoc: string;
  reports: { stepId: string; label: string }[];
  hasDeliverable: boolean;
  onPickDoc: (doc: string) => void;
  /** When set (past-run canvas), the deliverable row becomes the
   *  "build on this" action — arm the run's deliverable as the follow-up
   *  quote target. Returning to the "final" doc stays possible via the
   *  run switcher (picking a run resets doc to "final"). */
  onBuildOn?: () => void;
}) {
  if (reports.length === 0) return null;
  return (
    <div className="space-y-4">
      {hasDeliverable &&
        (onBuildOn != null ? (
          <button
            className="text-foreground hover:border-primary/60 hover:bg-primary/5 flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 font-mono text-xs transition-colors"
            onClick={onBuildOn}
            title="Arm this deliverable as the follow-up context"
            type="button"
          >
            <CornerDownRightIcon className="text-primary size-3.5 shrink-0" />
            <span className="font-bold">Build on this</span>
            <span className="text-muted-foreground ml-auto truncate font-normal">follow up from this run</span>
          </button>
        ) : (
        <button
          aria-pressed={activeDoc === "final"}
          className={`text-foreground flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 font-mono text-xs transition-colors ${
            activeDoc === "final" ? "border-primary bg-primary/10" : "hover:border-primary/60"
          }`}
          onClick={() => onPickDoc("final")}
          type="button"
        >
          <FileTextIcon className="text-primary size-3.5 shrink-0" />
          <span className="font-bold">Deliverable</span>
          <span className="text-muted-foreground ml-auto truncate font-normal">final output</span>
        </button>
        ))}
      <div className="rounded-lg border p-4">
        <h4 className="text-muted-foreground mb-3 text-center font-mono text-sm tracking-[0.2em]">AGENT REPORTS</h4>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {reports.map((r) => (
            <button
              aria-pressed={activeDoc === r.stepId}
              className={`text-foreground truncate rounded-lg border px-3 py-2 font-mono text-xs transition-colors ${
                activeDoc === r.stepId ? "border-primary bg-primary/10" : "hover:border-primary/60"
              }`}
              key={r.stepId}
              onClick={() => onPickDoc(r.stepId)}
              title={r.label}
              type="button"
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
