import { Icon } from "@/components/shared/icon";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { FileIcon } from "@/components/shared/file-icon";
import { MarkdownWithCharts } from "@/features/workbench/components/markdown-with-charts";
import { DeckPreview } from "@/features/workbench/components/deck-preview";
import { slugify } from "@/lib/utils";
import { call, errText } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { AgentReportsSwitcher, StepReportBody } from "@/features/workbench/components/shared-canvas";
import {
  agentName,
  DELIVERABLE_STEP_ID,
  DELIVERABLE_TOOL,
  isDeliverableStep,
  type WorkbenchController,
} from "@/features/workbench/hooks/use-workbench";
import type { WorkbenchRun } from "@/features/workbench/hooks/use-workbench";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";
import { fmtDuration } from "./progress-rail";

/** The run's deck artifact, if any — the deliverable hero. Set DIRECTLY from
 *  the planCompleted callback / restored record (workbench.deck) — not via
 *  the reducer — so the hero cannot be lost to a state-chain regression. */

// ── Canvas view ───────────────────────────────────────────────────────────────

/** Shared empty-state line — the canvas (idle viewer) and the page's
 *  zero-runs branch render the same words, so the hint reads as one system. */
export const EMPTY_RUNS_HINT = "State a goal in the composer to start a run.";

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
            title={r.goal}
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

/** PDF/DOCX export row for a completed deliverable — shared by the live
 *  canvas and PastRunCanvas; owns its own in-flight/feedback state. Copy
 *  puts the raw markdown on the clipboard; the saved filename opens the
 *  office-store file in the app-level preview dialog (same bridge the
 *  tool-renderer cards use). */
function DeliverableExport({ goal, markdown }: { goal: string; markdown: string }) {
  const [exporting, setExporting] = useState<"pdf" | "docx" | null>(null);
  const [exported, setExported] = useState<{ id: string; name: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setExportError("Copy failed — clipboard unavailable");
    }
  };

  const runExport = async (format: "pdf" | "docx") => {
    if (exporting) return;
    setExporting(format);
    setExported(null);
    setExportError(null);
    const slug = slugify(goal, "deliverable");
    try {
      const file = await call<{ id: string; originalName: string }>("export_deliverable", {
        markdown,
        filename: `${slug}.${format}`,
      });
      setExported({ id: file.id, name: file.originalName });
      setExportError(null);
    } catch (err) {
      console.error("[workbench] export_deliverable:", errText(err));
      setExported(null);
      setExportError(errText(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={copied} onClick={() => void copyMarkdown()} size="sm" variant="outline">
        <Icon name={copied ? "check" : "copy"} className="size-3" />
        {copied ? "Copied" : "Copy"}
      </Button>
      <span className="text-muted-foreground mr-1 font-mono text-[11px] uppercase">Export</span>
      <Button disabled={exporting != null} onClick={() => void runExport("pdf")} size="sm" variant="outline">
        {exporting === "pdf" ? (
          <Icon name="loader-circle" className="size-3 animate-spin" />
        ) : (
          <FileIcon className="size-3" name="export.pdf" />
        )}
        PDF
      </Button>
      <Button disabled={exporting != null} onClick={() => void runExport("docx")} size="sm" variant="outline">
        {exporting === "docx" ? (
          <Icon name="loader-circle" className="size-3 animate-spin" />
        ) : (
          <FileIcon className="size-3" name="export.docx" />
        )}
        DOCX
      </Button>
      {exported && (
        <button
          className="text-success hover:text-primary inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
          onClick={() => emitOpenPreview(exported.id, exported.name)}
          title="Open the exported file"
          type="button"
        >
          Saved as {exported.name}
          <Icon name="external-link" className="size-3" />
        </button>
      )}
      {exportError && <span className="text-destructive font-mono text-[11px]">Export failed: {exportError}</span>}
    </div>
  );
}

/** Canvas content for a PAST run: its deliverable or one of its step reports
 *  (fetched on demand from supervisor_step_results via the run's planKey).
 *  Same shape as the active-run canvas: header, document, doc switcher. */
export function PastRunCanvas({
  loadFullOutput,
  run,
  doc,
  onBuildOn,
  onPickDoc,
}: {
  loadFullOutput: (stepId: string, planKey?: string) => Promise<string | null>;
  run: WorkbenchRun;
  doc: string;
  /** "Build on this": arm this run's deliverable as the follow-up quote
   *  target. Only offered when the run has a quotable deliverable. */
  onBuildOn?: (run: WorkbenchRun) => void;
  /** Switch the canvas to one of this run's documents (deliverable or a
   *  step report) — wired by the page to its canvas-view navigation. */
  onPickDoc?: (doc: string) => void;
}) {
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
          run.status === "failed" && run.error != null ? (
            // Failure visibility: a failed run never produced a deliverable —
            // and its outputPreview is just the error's first 200 chars, which
            // must not render AS the deliverable body.
            <div className="border-destructive/40 bg-card rounded-lg border p-6">
              <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Run failed</div>
              <p className="text-muted-foreground mt-2 font-mono text-xs leading-relaxed break-words">{run.error}</p>
            </div>
          ) : deliverableBody ? (
            <div className="border-primary/30 bg-card rounded-lg border p-6">
              <MarkdownWithCharts>{deliverableBody}</MarkdownWithCharts>
            </div>
          ) : (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
              No deliverable was produced.
            </div>
          )
        ) : docStep?.state === "failed" && docStep.error != null && docStep.output == null ? (
          <div className="border-destructive/40 bg-card rounded-lg border p-4">
            <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Step failed</div>
            <p className="text-muted-foreground mt-1.5 font-mono text-xs leading-relaxed break-words">
              {docStep.error}
            </p>
          </div>
        ) : (
          <StepReportBody
            fetcher={loadFullOutput}
            // Always fetch the full body — same as the live canvas, so a
            // restored report matches what the run showed. Runs with a
            // planKey read their own plan's rows; legacy records without one
            // pass "" which hits supervisor::step_output's session-scope
            // fallback (newest rows for that step id, still user-scoped —
            // a same-id step from a NEWER run can win). On failure the
            // ≤2000-char record embed stays visible.
            needsFetch
            planKey={run.planKey ?? ""}
            previewOutput={docStep?.output ?? ""}
            stepId={doc}
            tool={stepTool}
          />
        )}

        {/* Past runs export too — same office pipeline as the live canvas. */}
        {isDeliverable && run.status === "completed" && run.outputFull != null && (
          <DeliverableExport goal={run.goal} markdown={run.outputFull} />
        )}

        {/* Document picker: jump between this run's deliverable and its step
            reports without going through the rail. Restored records embed
            their steps; live records carry tallies only, so runs without
            embedded steps simply hide the grid. */}
        {onPickDoc != null && (run.steps ?? []).length > 0 && (
          <AgentReportsSwitcher
            activeDoc={doc}
            hasDeliverable={run.status === "completed" && run.outputFull != null}
            onPickDoc={onPickDoc}
            reports={(run.steps ?? [])
              .filter(
                (s) =>
                  // Record steps are the persisted shape (optional fields) —
                  // match the reserved writer step by id/tool instead of
                  // isDeliverableStep (which needs the live SupervisorStep).
                  s.stepId !== DELIVERABLE_STEP_ID &&
                  s.tool !== DELIVERABLE_TOOL &&
                  (s.state === "completed" || s.state === "failed") &&
                  (s.output != null || s.error != null),
              )
              .map((s) => ({ label: (s.task || s.tool || s.stepId).trim(), stepId: s.stepId }))}
          />
        )}
      </div>
    </div>
  );
}

// ── In-flight status strip ───────────────────────────────────────────────────

/** Live status card on the FINAL view while a run is in flight — the canvas
 *  never sits blank between submit and the deliverable landing. Covers the
 *  planning window (unseeded), step execution, the deliverable writer (whose
 *  output only lands at planCompleted), approval gates, and stop. The rich
 *  planning telemetry stays in the rail; this is the compact canvas mirror.
 *  Elapsed clocks tick via the parent's per-second re-render. */
function RunStatusStrip({
  startedAt,
  unseeded,
  workbench,
}: {
  /** Current run's submit time — the elapsed clock source while unseeded
   *  (planStartedAt still belongs to the previous run then). */
  startedAt: number | null;
  unseeded: boolean;
  workbench: WorkbenchController;
}) {
  const { supervisor } = workbench;

  // Approval gate on the canvas (DESIGN: "the confirmation card appears in
  // the center pane") — the run is paused; both mounts act on the same
  // supervisor.approve/reject and disappear together once answered.
  if (supervisor.status === "awaitingConfirmation" && supervisor.pendingConfirmation) {
    return (
      <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
          <Icon name="shield-alert" className="text-primary size-4" />
          Approval required
        </div>
        <p className="text-foreground/90 font-mono text-sm leading-relaxed break-words">
          {supervisor.pendingConfirmation.description || supervisor.pendingConfirmation.task}
        </p>
        <div className="flex gap-2">
          <Button onClick={workbench.supervisor.approve} size="sm">
            <Icon name="play" className="size-3" />
            Approve
          </Button>
          <Button onClick={workbench.supervisor.reject} size="sm" variant="outline">
            Deny
          </Button>
        </div>
      </div>
    );
  }

  // Plan awaiting review: the review card (summary + Run/Discard) lives in
  // the rail (mobile: the drawer auto-opens); the canvas says what's up.
  if (unseeded && supervisor.status === "reviewing") {
    return (
      <div className="border-primary/30 bg-card rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
          <Icon name="clipboard-check" className="text-primary size-4" />
          Plan ready for review
        </div>
        <p className="text-muted-foreground mt-2 font-mono text-xs">
          Review the plan in the progress panel, then run or discard it.
        </p>
      </div>
    );
  }

  // Planning window (unseeded): the supervisor steps/goal still belong to the
  // previous run — mirror the rail's compact planning line instead.
  if (unseeded) {
    const planning = supervisor.planning;
    const label =
      planning == null
        ? "Preparing run…"
        : planning.round === 0
          ? planning.context != null
            ? "Starting planner…"
            : "Loading context (persona · memories · skills)…"
          : `${planning.searching ? "Searching tools" : "Writing plan"} · round ${planning.round}${planning.provider ? ` · ${planning.provider}` : ""}`;
    return (
      <div className="border-border/60 bg-card space-y-2 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
          <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
          {label}
          {startedAt != null && <span className="text-muted-foreground">· {fmtDuration(startedAt)}</span>}
        </div>
        {planning?.activity && (
          <p className="text-muted-foreground/70 line-clamp-2 pl-5.5 font-mono text-[11px] italic">
            ⌁ {planning.activity}
          </p>
        )}
      </div>
    );
  }

  // Seeded execution window: settled-step tally + what's happening now.
  const count = `${supervisor.steps.filter((s) => s.state === "completed" || s.state === "failed" || s.state === "skipped").length}/${supervisor.steps.length} steps`;
  const elapsed = supervisor.planStartedAt != null ? ` · ${fmtDuration(supervisor.planStartedAt)}` : "";

  if (supervisor.status === "stopping") {
    return (
      <div className="border-border/60 bg-card rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
          <Icon name="square" className="text-muted-foreground size-3.5" />
          Stopping…
          <span className="text-muted-foreground">
            · {count}
            {elapsed}
          </span>
        </div>
      </div>
    );
  }

  // Deliverable writer running: its output arrives only with planCompleted —
  // show a writing skeleton instead of a blank pane.
  if (supervisor.steps.some((s) => isDeliverableStep(s) && s.state === "running")) {
    return (
      <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
          <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
          Writing your answer…
          <span className="text-muted-foreground">{elapsed}</span>
        </div>
        <div className="space-y-2.5 pt-1">
          <div className="h-3 w-3/4 animate-pulse rounded bg-accent" />
          <div className="h-3 w-full animate-pulse rounded bg-accent" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-accent" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-accent" />
        </div>
      </div>
    );
  }

  const runningStep = supervisor.steps.find((s) => s.state === "running" && !isDeliverableStep(s));
  return (
    <div className="border-border/60 bg-card rounded-lg border p-6">
      <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
        <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
        {runningStep != null ? `Running · ${agentName(runningStep)}` : "Working…"}
        <span className="text-muted-foreground">
          · {count}
          {elapsed}
        </span>
      </div>
    </div>
  );
}

// ── Center: deliverable viewer ──────────────────────────────────────────────

export function DeliverableViewer({
  doc,
  runIndex,
  unseeded,
  workbench,
  onPickDoc,
}: {
  /** Pinned document: "final" | stepId. The page owns navigation policy —
   *  this component NEVER auto-jumps on its own. */
  doc: string;
  runIndex: number;
  /** True while the supervisor state still BELONGS to the previous run
   *  (new run submitted but planStarted hasn't seeded it yet) — the goal,
   *  steps, and finalOutput read from the supervisor are stale and must not
   *  render; the run record's own goal stands in for the header instead. */
  unseeded?: boolean;
  workbench: WorkbenchController;
  /** Switch the canvas document (deliverable ↔ step reports) — wired by the
   *  page to its canvas-view navigation; without it the reports grid hides. */
  onPickDoc?: (doc: string) => void;
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
            (s) =>
              !isDeliverableStep(s) &&
              (s.state === "completed" || s.state === "failed") &&
              (s.output != null || s.error != null),
          ),
    [unseeded, supervisor.steps],
  );
  const effective = doc;
  // Step source: supervisor state for the run it currently holds; the run
  // RECORD (≤2000-char embeds + its own planKey) otherwise — a reopened
  // session's newest run renders here too, and the supervisor may be empty
  // or hold a different run's state.
  const runRecord = workbench.runs[runIndex];
  const step =
    reports.find((r) => r.stepId === effective) ??
    (runRecord?.steps ?? []).find(
      (s) =>
        s.stepId === effective &&
        (s.state === "completed" || s.state === "failed") &&
        (s.output != null || s.error != null),
    ) ??
    null;
  const resolvedStep: SupervisorStep | undefined = step ? { artifacts: [], ...step } : undefined;

  // The wire preview is capped at 2000 chars. Always fetch the full body
  // from the persisted step results — the length heuristic missed truncated
  // reports (e.g. a 2000-char JSON that parses into a few items). Values are
  // `string` on success, `"failed"` after a failed fetch (stay on the
  // preview; no retry spinner). In-flight tracking lives in a ref — a state
  // flag here would re-trigger this very effect and deadlock the fetch.
  const output = resolvedStep?.output;

  const done = unseeded ? 0 : supervisor.steps.filter((s) => s.state === "completed").length;

  // In-flight strip on the final view: shown through the whole submit →
  // deliverable window (planning unseeded, execution, writer, approval gate,
  // stop) — the canvas must never sit blank in between. `unseeded` alone is
  // enough while the supervisor state belongs to the previous run; afterwards
  // the in-flight statuses qualify until the final output lands.
  const inFlightNow = ["running", "stopping", "awaitingConfirmation"].includes(supervisor.status);
  const stripVisible = effective === "final" && (unseeded === true || (inFlightNow && supervisor.finalOutput == null));
  // Per-second tick while the strip is up — silent windows (planner rounds,
  // deliverable synthesis, no-event steps) otherwise read as a frozen UI.
  // Also keeps the header's duration line moving.
  const [, setStripTick] = useState(0);
  useEffect(() => {
    if (!stripVisible) return;
    const t = setInterval(() => setStripTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [stripVisible]);
  // Screen-reader phase announcement — the text changes ONLY on coarse phase
  // transitions (never on the per-second tick or per-step churn), so the live
  // region announces once per phase instead of chattering.
  const phaseAnnouncement = !stripVisible
    ? ""
    : unseeded
      ? supervisor.status === "reviewing"
        ? "Plan ready for review"
        : "Planning your goal"
      : supervisor.status === "awaitingConfirmation"
        ? "Approval required"
        : supervisor.status === "stopping"
          ? "Stopping"
          : supervisor.steps.some((s) => isDeliverableStep(s) && s.state === "running")
            ? "Writing your answer"
            : "Running";

  return (
    <div className="h-full overflow-y-auto">
      <div aria-live="polite" className="sr-only" role="status">
        {phaseAnnouncement}
      </div>
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h3 className="text-foreground flex items-start gap-2 text-xl font-semibold" title={headerGoal ?? undefined}>
            <span className="line-clamp-2">{headerGoal ?? "Working…"}</span>
          </h3>
          {effective !== "final" && resolvedStep != null && (
            <div className="text-muted-foreground mt-1 font-mono text-xs">Agent report · {agentName(resolvedStep)}</div>
          )}
          <div className="text-muted-foreground mt-1 font-mono text-sm">
            {unseeded ? (
              <>
                planning…
                {runRecord?.startedAt != null && ` · ${fmtDuration(runRecord.startedAt)}`}
              </>
            ) : (
              <>
                {done}/{supervisor.steps.length} steps
                {supervisor.planStartedAt != null &&
                  ` · ${fmtDuration(supervisor.planStartedAt, supervisor.planCompletedAt ?? undefined)}`}
              </>
            )}
          </div>
        </div>

        {/* In-flight status strip: planning, execution, writer, approval gate,
            stop — never a blank pane between submit and the deliverable. */}
        {stripVisible && (
          <RunStatusStrip startedAt={runRecord?.startedAt ?? null} unseeded={unseeded === true} workbench={workbench} />
        )}

        {supervisor.status === "idle" && supervisor.planning == null && (
          <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
            {EMPTY_RUNS_HINT}
          </div>
        )}

        {/* Failure visibility: a failed run says WHY on the canvas — the
            final view otherwise rendered nothing but the step counter. */}
        {effective === "final" && !unseeded && supervisor.status === "failed" && supervisor.finalOutput == null && (
          <div className="border-destructive/40 bg-card rounded-lg border p-6">
            <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Run failed</div>
            <p className="text-muted-foreground mt-2 font-mono text-xs leading-relaxed break-words">
              {supervisor.error ?? "The run ended before a deliverable was written."}
            </p>
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
            <MarkdownWithCharts>{supervisor.finalOutput}</MarkdownWithCharts>
          </div>
        )}
        {effective === "final" && !unseeded && supervisor.finalOutput != null && supervisor.status === "completed" && (
          <DeliverableExport goal={supervisor.goal ?? "deliverable"} markdown={supervisor.finalOutput} />
        )}
        {/* Failed step with no output: show its WHY instead of an empty body
            (the rail's "see report" now opens something meaningful). */}
        {effective !== "final" &&
          resolvedStep != null &&
          resolvedStep.state === "failed" &&
          output == null &&
          resolvedStep.error != null && (
            <div className="border-destructive/40 bg-card rounded-lg border p-4">
              <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Step failed</div>
              <p className="text-muted-foreground mt-1.5 font-mono text-xs leading-relaxed break-words">
                {resolvedStep.error}
              </p>
            </div>
          )}
        {effective !== "final" && resolvedStep != null && output != null && resolvedStep.tool !== "deck_writer" && (
          <StepReportBody
            fetcher={workbench.loadFullOutput}
            needsFetch
            // The shown run's OWN planKey — supervisor.planKey is the ACTIVE
            // run's key and is null/stale once the session is reopened.
            // Legacy records without a planKey pass "" (session-scope read).
            planKey={runRecord?.planKey ?? supervisor.planKey ?? ""}
            cacheKey={runRecord?.id ?? "live"}
            previewOutput={output}
            stepId={resolvedStep.stepId}
            tool={resolvedStep.tool}
          />
        )}

        {/* Document picker: the canvas-native way back to the deliverable or
            on to another report (the rail's "see report" links stay). Hidden
            while planning (no reports yet) and when navigation isn't wired. */}
        {onPickDoc != null && reports.length > 0 && (
          <AgentReportsSwitcher
            activeDoc={effective}
            hasDeliverable={supervisor.finalOutput != null}
            onPickDoc={onPickDoc}
            reports={reports.map((r) => ({ label: agentName(r), stepId: r.stepId }))}
          />
        )}
      </div>
    </div>
  );
}

// ── History strip (home state) ──────────────────────────────────────────────

export function RunHistory({
  runs,
  onReopen,
}: {
  runs: WorkbenchRun[];
  /** Open the run's deliverable in the viewer — any finished run qualifies:
   *  the canvas renders past runs from their record (PastRunCanvas), not
   *  from the single-run supervisor state. */
  onReopen?: (runId: string) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-2 p-6">
      <h3 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Run history</h3>
      {runs
        .slice()
        .reverse()
        .map((r) => {
          const clickable = onReopen != null && r.status !== "running";
          const RowInner = (
            <>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-foreground truncate text-sm">{r.goal}</div>
                <div className="text-muted-foreground font-mono text-[11px]">
                  {new Date(r.startedAt).toLocaleString()}
                  {r.stepsTotal != null && ` · ${r.stepsDone ?? 0}/${r.stepsTotal} steps`}
                  {/* Failed rows fall back to the plan-level error — restored
                      failed records have an empty outputPreview. */}
                  {(r.outputPreview || (r.status === "failed" ? r.error : null)) &&
                    ` · ${(r.outputPreview || r.error || "").slice(0, 60)}…`}
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
            // Not reopenable while running — visibly inert so it doesn't read
            // as a broken button. A running row keeps full contrast: it's
            // live, just not clickable yet.
            <div
              className={`border-border/60 flex items-center justify-between gap-3 rounded-lg border p-3${
                r.status !== "running" ? " cursor-default opacity-60" : ""
              }`}
              key={r.id}
            >
              {RowInner}
            </div>
          );
        })}
    </div>
  );
}
