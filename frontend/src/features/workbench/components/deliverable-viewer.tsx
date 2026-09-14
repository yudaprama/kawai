import { Icon } from "@/components/shared/icon";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { FileIcon } from "@/components/shared/file-icon";
import { Streamdown } from "@/lib/streamdown";
import { DeckPreview } from "@/features/workbench/components/deck-preview";
import { call, errText } from "@/lib/api";
import { AgentReportsSwitcher, StepReportBody } from "@/features/workbench/components/shared-canvas";
import { agentName, isDeliverableStep, type useWorkbench } from "@/features/workbench/hooks/use-workbench";
import type { WorkbenchRun } from "@/features/workbench/hooks/use-workbench";
import { fmtDuration } from "./progress-rail";

/** The run's deck artifact, if any — the deliverable hero. Set DIRECTLY from
 *  the planCompleted callback / restored record (workbench.deck) — not via
 *  the reducer — so the hero cannot be lost to a state-chain regression. */

// ── Canvas view ───────────────────────────────────────────────────────────────

/** Canvas view: which run's which document is on the right pane. Null only
 *  before the first run produces anything. doc = "final" | stepId. */
export interface CanvasView {
  runId: string;
  doc: string;
}

/** Level-1 switcher in the canvas header: pick which RUN is shown. */
export function RunSwitcher({
  activeRunId,
  onPick,
  runs,
  view,
}: {
  activeRunId: string | null;
  onPick: (runId: string) => void;
  runs: WorkbenchRun[];
  view: CanvasView | null;
}) {
  if (runs.length === 0) return null;
  const selectedId = view?.runId ?? activeRunId;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {runs.map((r, i) => {
        const sel = r.id === selectedId;
        return (
          <button
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors ${
              sel
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border/60 text-foreground/80 hover:border-primary/60"
            }`}
            key={r.id}
            onClick={() => onPick(r.id)}
            type="button"
          >
            Run {i + 1}
            {r.status === "running" ? (
              <Icon name="loader-circle" className="text-primary size-3 shrink-0 animate-spin" />
            ) : r.status === "completed" ? (
              <Icon name="check-circle-2" className="text-success size-3 shrink-0" />
            ) : (
              <Icon name="circle-x" className="text-destructive size-3 shrink-0" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Canvas content for a PAST run: its deliverable or one of its step reports
 *  (fetched on demand from supervisor_step_results via the run's planKey).
 *  Same shape as the active-run canvas: header, document, doc switcher. */
export function PastRunCanvas({
  loadFullOutput,
  onPickDoc,
  run,
  doc,
  onBuildOn,
}: {
  loadFullOutput: (stepId: string, planKey?: string) => Promise<string | null>;
  onPickDoc: (doc: string) => void;
  run: WorkbenchRun;
  doc: string;
  /** "Build on this": arm this run's deliverable as the follow-up quote
   *  target. Only offered when the run has a quotable deliverable. */
  onBuildOn?: (run: WorkbenchRun) => void;
}) {
  const reportableSteps = (run.steps ?? []).filter((s) => s.state === "completed" || s.state === "failed");
  const isDeliverable = doc === "final";
  /** Header label: the step's task (agentName), or the tool — never the raw
   *  step id. Same derivation the active canvas uses. */
  const docStep = (run.steps ?? []).find((s) => s.stepId === doc);
  const docStepLabel = (docStep?.task || docStep?.tool || doc).trim();
  const goalLabel = run.goal.length > 48 ? `${run.goal.slice(0, 47).trimEnd()}…` : run.goal;
  const deliverableBody = run.outputFull ?? (run.outputPreview ? `${run.outputPreview}…` : null);
  const stepTool = run.steps?.find((s) => s.stepId === doc)?.tool ?? "";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h3 className="text-foreground inline-flex items-center gap-2 text-xl font-semibold">
            <Icon name="zap" className="text-primary size-5" />
            {goalLabel || "Working…"}
            {!isDeliverable && docStep != null && (
              <span className="text-muted-foreground text-sm font-normal">— {docStepLabel} report</span>
            )}
          </h3>
          <div className="text-muted-foreground mt-1 flex items-center gap-3 font-mono text-sm">
            <span>
              {new Date(run.startedAt).toLocaleString()}
              {run.stepsTotal != null && ` · ${run.stepsDone ?? 0}/${run.stepsTotal} steps`}
            </span>
            {onBuildOn != null && run.status === "completed" && run.outputFull != null && run.planKey != null && (
              <button
                className="hover:text-primary inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                onClick={() => onBuildOn(run)}
                title={`Arm “${goalLabel}” as the follow-up context`}
                type="button"
              >
                <Icon name="corner-down-right" className="size-3" />
                build on this
              </button>
            )}
          </div>
        </div>

        {isDeliverable ? (
          deliverableBody ? (
            <div className="border-primary/30 bg-card rounded-lg border p-6">
              <Streamdown>{deliverableBody}</Streamdown>
            </div>
          ) : (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
              No deliverable was produced.
            </div>
          )
        ) : (
          <StepReportBody
            fetcher={loadFullOutput}
            // Fetch the full body only when the run's own planKey is known
            // (records persist it now; restored runs would otherwise hit the
            // supervisor's CURRENT planKey — the newest run, wrong run for
            // past-run journals). Without a planKey, serve the record's
            // ≤500-char output embed as-is.
            needsFetch={run.planKey != null || docStep?.output == null}
            planKey={run.planKey ?? undefined}
            previewOutput={docStep?.output ?? ""}
            stepId={doc}
            tool={stepTool}
          />
        )}

        <AgentReportsSwitcher
          activeDoc={doc}
          hasDeliverable={deliverableBody != null}
          onBuildOn={
            onBuildOn != null && run.status === "completed" && run.outputFull != null && run.planKey != null
              ? () => onBuildOn(run)
              : undefined
          }
          onPickDoc={onPickDoc}
          reports={reportableSteps.map((s) => ({ stepId: s.stepId, label: s.task || s.tool }))}
        />
      </div>
    </div>
  );
}

// ── Center: deliverable viewer ──────────────────────────────────────────────

export function DeliverableViewer({
  doc,
  onPickDoc,
  runIndex,
  unseeded,
  workbench,
}: {
  /** Pinned document: "final" | stepId. The page owns navigation policy —
   *  this component NEVER auto-jumps on its own. */
  doc: string;
  onPickDoc: (doc: string) => void;
  runIndex: number;
  /** True while the supervisor state still BELONGS to the previous run
   *  (new run submitted but planStarted hasn't seeded it yet) — the goal,
   *  steps, and finalOutput read from the supervisor are stale and must not
   *  render; the run record's own goal stands in for the header instead. */
  unseeded?: boolean;
  workbench: ReturnType<typeof useWorkbench>;
}) {
  const { supervisor } = workbench;
  // Header goal: the run record knows the submitted goal from the moment of
  // submit; supervisor.goal only arrives at planStarted (and is the previous
  // run's until then). No generic "Deliverable" placeholder — that read as
  // an unexplained label.
  const runGoal = (unseeded ? null : supervisor.goal) ?? workbench.runs[runIndex]?.goal ?? null;
  // Full goal in the viewer header — it has room (max-w-4xl); the 48-char cut
  // stays only in the compact report switcher.
  const headerGoal = runGoal;
  const reports = useMemo(
    () =>
      unseeded
        ? []
        : supervisor.steps.filter(
            (s) => !isDeliverableStep(s) && s.output && (s.state === "completed" || s.state === "failed"),
          ),
    [unseeded, supervisor.steps],
  );
  const effective = doc;
  const step = reports.find((r) => r.stepId === effective);

  // The wire preview is capped at 2000 chars — when the shown report hits
  // that bound, fetch the full body from the persisted step results. Values
  // are `string` on success, `"failed"` after a failed fetch (stay on the
  // preview; no retry spinner). In-flight tracking lives in a ref — a state
  // flag here would re-trigger this very effect and deadlock the fetch.
  const previewTruncated = (step?.output?.length ?? 0) >= 2000;
  const output = step?.output;

  // Export the deliverable as a stored .pdf/.docx via the office engines.
  const [exporting, setExporting] = useState<"pdf" | "docx" | null>(null);
  const [exportedName, setExportedName] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const done = unseeded ? 0 : supervisor.steps.filter((s) => s.state === "completed").length;

  const exportGoal = async (format: "pdf" | "docx") => {
    if (unseeded || supervisor.finalOutput == null || exporting) return;
    setExporting(format);
    setExportedName(null);
    setExportError(null);
    const slug =
      (supervisor.goal ?? "deliverable")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "deliverable";
    try {
      const file = await call<{ originalName: string }>("export_deliverable", {
        markdown: supervisor.finalOutput,
        filename: `${slug}.${format}`,
      });
      setExportedName(file.originalName);
      setExportError(null);
    } catch (err) {
      console.error("[workbench] export_deliverable:", errText(err));
      setExportedName(null);
      setExportError(errText(err));
    } finally {
      setExporting(null);
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h3 className="text-foreground flex items-start gap-2 text-xl font-semibold" title={headerGoal ?? undefined}>
            <span>{headerGoal ?? "Working…"}</span>
          </h3>
          {effective !== "final" && step != null && (
            <div className="text-muted-foreground mt-1 font-mono text-xs">Agent report · {agentName(step)}</div>
          )}
          <div className="text-muted-foreground mt-1 font-mono text-sm">
            {done}/{unseeded ? 0 : supervisor.steps.length} steps
            {supervisor.planStartedAt != null &&
              ` · ${fmtDuration(supervisor.planStartedAt, supervisor.planCompletedAt ?? undefined)}`}
          </div>
        </div>

        {supervisor.status === "idle" && supervisor.planning == null && (
          <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
            State a goal in the composer to start a run.
          </div>
        )}

        {/* Planning progress lives in the sidebar rail (PlanningStatus inside
            ProgressRail). The canvas keeps showing the previous run's content
            until the new run's first content lands (canvas policy). */}

        {/* Deck hero: on the final view AND on the deck_writer step report
            (the report the user lands on via "see report") — both otherwise
            show only the note text without the slides. */}
        {!unseeded && workbench.deck != null && (effective === "final" || effective === "__deliverable") && (
          <div className="space-y-1">
            <div className="text-muted-foreground flex items-center gap-2 font-mono text-[11px] uppercase">
              <Icon name="zap" className="size-3" /> Deck · {workbench.deck.label ?? "presentation"}
            </div>
            {/* Native slide preview — plain DOM fragments + theme CSS (a few
                  KB per slide). The full reveal.js deck opens in the browser via
                  "Open full deck" inside the preview; no iframe in the app. */}
            <DeckPreview fileId={workbench.deck.handle} />
          </div>
        )}
        {effective === "final" && !unseeded && supervisor.finalOutput != null && (
          <div className="border-primary/30 bg-card rounded-lg border p-6">
            <Streamdown>{supervisor.finalOutput}</Streamdown>
          </div>
        )}
        {effective === "final" && !unseeded && supervisor.finalOutput != null && supervisor.status === "completed" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground mr-1 font-mono text-[11px] uppercase">Export</span>
            <Button disabled={exporting != null} onClick={() => void exportGoal("pdf")} size="sm" variant="outline">
              {exporting === "pdf" ? (
                <Icon name="loader-circle" className="size-3 animate-spin" />
              ) : (
                <FileIcon className="size-3" name="export.pdf" />
              )}
              PDF
            </Button>
            <Button disabled={exporting != null} onClick={() => void exportGoal("docx")} size="sm" variant="outline">
              {exporting === "docx" ? (
                <Icon name="loader-circle" className="size-3 animate-spin" />
              ) : (
                <FileIcon className="size-3" name="export.docx" />
              )}
              DOCX
            </Button>
            {exportedName && (
              <span className="text-success font-mono text-[11px]">Saved as {exportedName} — view it in Documents</span>
            )}
            {exportError && (
              <span className="text-destructive font-mono text-[11px]">Export failed: {exportError}</span>
            )}
          </div>
        )}
        {effective !== "final" && step != null && output != null && step.tool !== "deck_writer" && (
          <StepReportBody
            fetcher={workbench.loadFullOutput}
            needsFetch={previewTruncated}
            cacheKey={`${supervisor.goal ?? ""}::${supervisor.planVersion ?? ""}`}
            previewOutput={output}
            stepId={step.stepId}
            tool={step.tool}
          />
        )}
        <AgentReportsSwitcher
          activeDoc={effective}
          hasDeliverable={!unseeded && supervisor.finalOutput != null}
          onPickDoc={onPickDoc}
          reports={reports.map((r) => ({ stepId: r.stepId, label: agentName(r) }))}
        />
      </div>
    </div>
  );
}

// ── History strip (home state) ──────────────────────────────────────────────

export function RunHistory({
  runs,
  onReopen,
  latestRunId,
}: {
  runs: WorkbenchRun[];
  /** Open the run's deliverable in the viewer. Only wired for the latest run (S1: supervisor holds one run's state). */
  onReopen?: (runId: string) => void;
  latestRunId?: string;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-2 p-6">
      <h3 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Run history</h3>
      {runs
        .slice()
        .reverse()
        .map((r) => {
          const clickable = onReopen != null && latestRunId === r.id && r.status !== "running";
          const RowInner = (
            <>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-foreground truncate text-sm">{r.goal}</div>
                <div className="text-muted-foreground font-mono text-[11px]">
                  {new Date(r.startedAt).toLocaleString()}
                  {r.stepsTotal != null && ` · ${r.stepsDone ?? 0}/${r.stepsTotal} steps`}
                  {r.outputPreview && ` · ${r.outputPreview.slice(0, 60)}…`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {clickable && (
                  <span className="text-primary font-mono text-[10px] group-hover:underline">View report</span>
                )}
                {r.status === "running" ? (
                  <Icon name="loader-circle" className="text-primary size-4 animate-spin" />
                ) : r.status === "completed" ? (
                  <Icon name="check-circle-2" className="text-success size-4" />
                ) : (
                  <Icon name="circle-x" className="text-destructive size-4" />
                )}
              </div>
            </>
          );
          return clickable ? (
            <button
              className="group border-border/60 hover:border-primary/50 flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors"
              key={r.id}
              onClick={() => onReopen(r.id)}
              title={`View report: ${r.goal}`}
              type="button"
            >
              {RowInner}
            </button>
          ) : (
            <div className="border-border/60 flex items-center justify-between gap-3 rounded-lg border p-3" key={r.id}>
              {RowInner}
            </div>
          );
        })}
    </div>
  );
}
