/**
 * Shared canvas primitives for the workbench viewer.
 *
 * Extracted from DeliverableViewer + PastRunCanvas to eliminate duplicated
 * per-step fetch/cache/render and AGENT REPORTS switcher logic — the root cause
 * of the StrictMode deadlock and renderer-mismatch bugs.
 */
import { Icon } from "@/components/shared/icon";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { renderStepReport } from "@/features/workbench/components/tool-views";

import { AskAboutResult } from "./ask-about-result";

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
 *  @returns `{ output, loading, failed, retry }` — output is the full body or
 *            the caller's preview (when fetch wasn't needed). loading is true
 *            while the fetch is in flight; failed marks a rejected/empty
 *            fetch (preview stays visible); retry clears the entry so the
 *            effect refetches. */
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
}): { output: string | null; loading: boolean; failed: boolean; retry: () => void } {
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

  // `failed` is terminal for auto-fetch (no spinner loop) but recoverable by
  // hand: `retry()` drops the cached entry so the effect refetches.
  const loading = body === "loading" || (body == null && needsFetch);
  const output = body != null && body !== "loading" && body !== "failed" ? body : null;
  const failed = body === "failed";
  const retry = () => {
    if (stepId == null) return;
    setBodies((prev) => {
      if (!(stepId in prev)) return prev;
      const next = { ...prev };
      delete next[stepId];
      return next;
    });
  };
  return { output, loading, failed, retry };
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
  onAsk,
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
  /** When set, renders the "Tanya tentang hasil ini" affordance below the
   *  report (PLAN-ask-about-step-result.md). */
  onAsk?: (stepId: string, question: string) => Promise<string | null>;
}) {
  const { output, loading, failed, retry } = useStepReport({
    cacheKey: cacheKey ?? "step-report",
    stepId,
    fetcher,
    planKey,
    needsFetch,
  });
  const body = output ?? previewOutput;
  return (
    <div className="bg-card rounded-lg border p-4">
      {failed && (
        <div className="border-destructive/30 mb-2 flex items-center justify-between gap-2 rounded-md border bg-destructive/5 px-3 py-2">
          <p className="text-destructive text-xs" role="alert">
            Full report couldn&apos;t load — showing the 2k preview.
          </p>
          <Button onClick={retry} size="xs" variant="outline">
            Retry
          </Button>
        </div>
      )}
      {loading && (
        <p className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
          <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
          Loading full report…
        </p>
      )}
      {renderStepReport(tool, body)}
      {onAsk != null && <AskAboutResult onAsk={onAsk} stepId={stepId} />}
    </div>
  );
}

// ── AgentReportsSwitcher ────────────────────────────────────────────────────

/** The document picker — a compact chip strip that switches the canvas
 *  between the deliverable and the run's step reports. It renders inside the
 *  canvas's sticky header bar, so document navigation stays reachable while
 *  reading a long deliverable instead of hiding below it. With no reports to
 *  switch to, the whole switcher stays hidden: the deliverable needs no
 *  button to show itself. */
export function AgentReportsSwitcher({
  activeDoc,
  reports,
  hasDeliverable,
  onPickDoc,
}: {
  activeDoc: string;
  reports: { stepId: string; label: string }[];
  hasDeliverable: boolean;
  onPickDoc: (doc: string) => void;
}) {
  if (reports.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground shrink-0 font-mono text-[10px] tracking-widest uppercase">
        Agent reports
      </span>
      <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {hasDeliverable && (
          <button
            aria-pressed={activeDoc === "final"}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              activeDoc === "final"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border/60 text-foreground/80 hover:border-primary/60"
            }`}
            onClick={() => onPickDoc("final")}
            title="The run's final deliverable"
            type="button"
          >
            <Icon name="file-text" className="text-primary size-3 shrink-0" />
            Deliverable
          </button>
        )}
        {reports.map((r) => (
          <button
            aria-pressed={activeDoc === r.stepId}
            className={`inline-flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              activeDoc === r.stepId
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border/60 text-foreground/80 hover:border-primary/60"
            }`}
            key={r.stepId}
            onClick={() => onPickDoc(r.stepId)}
            title={r.label}
            type="button"
          >
            <span className="truncate">{r.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
