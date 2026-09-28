import { Icon } from "@/components/shared/icon";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { SupervisorController, SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";
import type { PlanSummaryInfo } from "@/features/chat/hooks/supervisor-types";
import {
  agentName,
  computePhases,
  isDeliverableStep,
  type useWorkbench,
} from "@/features/workbench/hooks/use-workbench";
import type { WorkbenchRun } from "@/features/workbench/hooks/use-workbench";

// ── Small shared pieces ─────────────────────────────────────────────────────

export function fmtDuration(from: number, to?: number): string {
  const secs = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Plan Summary — "what will the agent do, what will I get" without reading
 *  the technical step list. LLM-written (sanitized) or the deterministic
 *  fallback from the step tasks; `null` hides the card entirely. */
function PlanSummaryCard({ summary }: { summary: PlanSummaryInfo | null }) {
  if (!summary || (!summary.overview && summary.actions.length === 0 && summary.outputs.length === 0)) {
    return null;
  }
  return (
    <div>
      <p className="text-primary font-mono text-[11px] font-bold uppercase tracking-wide">Plan summary</p>
      {summary.overview && <p className="text-foreground/90 mt-1 text-xs leading-relaxed">{summary.overview}</p>}
      {summary.actions.length > 0 && (
        <ul className="text-foreground/80 mt-2 space-y-0.5 text-xs">
          {summary.actions.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static display list, no unique IDs
            <li key={i}>· {a}</li>
          ))}
        </ul>
      )}
      {summary.outputs.length > 0 && (
        <div className="mt-2">
          <p className="text-muted-foreground font-mono text-[10px] uppercase">Expected outputs</p>
          <ul className="mt-1 space-y-0.5">
            {summary.outputs.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static display list, no unique IDs
              <li className="text-foreground/80 flex items-start gap-1 text-xs" key={i}>
                <Icon name="check-circle-2" className="text-success mt-0.5 size-3 shrink-0" />
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Run / Discard actions for the plan-review gate — the rail's review card
 *  and the canvas mirror both mount these, so both panes act on the same
 *  supervisor actions. Discard arms on the first click ("Confirm discard",
 *  3s window) so a misclick can't throw away a planner round. */
export function ReviewActions({ supervisor }: { supervisor: SupervisorController }) {
  const [discardArmed, setDiscardArmed] = useState(false);
  useEffect(() => {
    if (!discardArmed) return;
    const t = setTimeout(() => setDiscardArmed(false), 3000);
    return () => clearTimeout(t);
  }, [discardArmed]);
  return (
    <div className="flex gap-2 pt-2">
      <Button className="flex-1" onClick={supervisor.approvePlan} size="sm">
        <Icon name="play" className="size-3" />
        Run
      </Button>
      <Button
        onClick={() => {
          if (discardArmed) supervisor.cancelPlan();
          else setDiscardArmed(true);
        }}
        size="sm"
        variant="outline"
      >
        {discardArmed ? "Confirm discard" : "Discard"}
      </Button>
    </div>
  );
}

function StateIcon({ state }: { state: SupervisorStep["state"] }) {
  if (state === "completed") return <Icon name="check-circle-2" className="text-success size-3.5 shrink-0" />;
  if (state === "failed") return <Icon name="circle-x" className="text-destructive size-3.5 shrink-0" />;
  if (state === "running") return <Icon name="loader-circle" className="text-primary size-3.5 shrink-0 animate-spin" />;
  if (state === "skipped") return <Icon name="chevron-down" className="text-muted-foreground size-3.5 shrink-0" />;
  return <span className="text-muted-foreground/50 block size-3.5 shrink-0 rounded-full border" />;
}

/** Live-ticking duration, freezing at `to` once set. The tick lives HERE so
 *  the parent rail/tree never re-renders per second. `className` upgrades
 *  the text size (header uses text-xs; step rows keep text-[10px]). */
function Duration({ className, from, to }: { className?: string; from: number; to?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (to != null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [to]);
  return (
    <span
      className={`text-muted-foreground shrink-0 font-mono tabular-nums ${className == null ? "text-[10px]" : className}`}
    >
      {fmtDuration(from, to)}
    </span>
  );
}

/** The ONE step-tree renderer — used by BOTH the active Progress rail and
 *  every run-history entry, guaranteeing identical format (phases, step rows,
 *  state icons, tools, report buttons). `live` enables running spinners and
 *  per-step durations; settled rows show the tool label instead. */
export function StepTree({
  live,
  onOpenReport,
  steps,
}: {
  live: boolean;
  onOpenReport: (stepId: string) => void;
  steps: SupervisorStep[];
}) {
  const phases = computePhases(steps);
  const deliverableStep = steps.find(isDeliverableStep);
  const [collapsedPhases, setCollapsedPhases] = useState<Set<number>>(new Set());
  const togglePhase = (i: number) =>
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div className="space-y-4">
      {phases.map((phase, i) => {
        const allSettled = phase.every((s) => s.state === "completed" || s.state === "skipped");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: phases are derived wave buckets with no stable identity
          <div key={i}>
            <button
              aria-expanded={!collapsedPhases.has(i)}
              className="text-foreground/80 hover:text-foreground mb-2 flex w-full items-center gap-1 font-mono text-[10px] font-bold tracking-wider uppercase"
              onClick={() => togglePhase(i)}
              type="button"
            >
              <Icon
                name="chevron-down"
                className={`size-3 transition-transform ${collapsedPhases.has(i) ? "-rotate-90" : ""}`}
              />
              {phases.length > 1 ? `Phase ${i + 1}` : "Steps"}
              {allSettled && <span className="text-muted-foreground ml-1 normal-case">· settled</span>}
            </button>
            {!collapsedPhases.has(i) && (
              <div className="ml-2 space-y-1.5">
                {phase.map((step) => (
                  <div key={step.stepId} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 font-mono text-xs">
                      <span
                        className="text-foreground/90 min-w-0 flex-1 whitespace-normal break-words leading-snug"
                        title={agentName(step)}
                      >
                        {agentName(step)}
                      </span>
                      <StateIcon state={step.state} />
                    </div>
                    <div className="flex items-center justify-between">
                      {live && step.state === "running" && step.startedAt != null ? (
                        <Duration from={step.startedAt} />
                      ) : (
                        <span
                          className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[10px]"
                          title={step.tool}
                        >
                          {step.tool}
                        </span>
                      )}
                      {reportable(step, live) && (
                        <button
                          className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
                          onClick={() => onOpenReport(step.stepId)}
                          type="button"
                        >
                          <Icon name="file-text" className="size-3" />
                          see report
                        </button>
                      )}
                    </div>
                    {/* Failure visibility: a failed/skipped step shows its WHY
                        right in the rail (live rows and history rows share
                        this tree). Full body still lives behind "see report". */}
                    {step.error != null && (step.state === "failed" || step.state === "skipped") && (
                      <p
                        className={`font-mono text-[10px] leading-snug break-words ${
                          step.state === "failed" ? "text-destructive" : "text-muted-foreground"
                        }`}
                        title={step.error}
                      >
                        {step.error}
                      </p>
                    )}
                    {(step.inputs?.length ?? 0) > 0 && (
                      <div
                        className="text-muted-foreground/80 flex flex-wrap gap-x-2 font-mono text-[10px]"
                        title="Dataflow bindings from earlier steps"
                      >
                        {step.inputs?.map((b) => (
                          <span key={b.arg}>
                            {b.arg} ← {b.fromStep}.{b.output}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {deliverableStep && (
        <div className="space-y-0.5">
          <div className="flex items-center justify-between gap-2 font-mono text-xs">
            <span className="text-foreground/90 min-w-0 truncate">Writing your deliverable</span>
            <StateIcon state={deliverableStep.state} />
          </div>
          <div className="flex items-center justify-between">
            {live && deliverableStep.state === "running" ? (
              <Duration from={deliverableStep.startedAt ?? Date.now()} />
            ) : (
              <span className="text-muted-foreground font-mono text-[10px]">{deliverableStep.tool}</span>
            )}
            {reportable(deliverableStep, live) && (
              <button
                className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
                onClick={() => onOpenReport("final")}
                type="button"
              >
                <Icon name="file-text" className="size-3" />
                see report
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A step carries an inspectable report: live rows gate on something being
 *  showable — a completed step's wire preview, or a failed step's error —
 *  history rows on the state being terminal. */
function reportable(step: SupervisorStep, live: boolean): boolean {
  if (live) {
    if (step.state === "failed") return step.error != null || step.output != null;
    return step.state === "completed" && step.output != null;
  }
  return step.state === "completed" || step.state === "failed";
}

// ── Run history rail (sidebar) ──────────────────────────────────────────────

/** Run history rail (sidebar): past runs as expandable entries whose body is
 *  the run's STEP TIMELINE. Nothing renders the old deliverable here —
 *  picking `report` or `deliverable` opens it on the CANVAS (right pane).
 *  Full step bodies load on demand from supervisor_step_results via the
 *  run's stored planKey. */
export function RunHistoryRail({
  runs,
  onBuildOn,
  onOpenDeliverable,
  onOpenStep,
}: {
  runs: WorkbenchRun[];
  /** "Build on this": arm this run's deliverable as the follow-up quote
   *  target. Only offered for completed runs with a quotable deliverable. */
  onBuildOn?: (run: WorkbenchRun) => void;
  onOpenDeliverable: (runId: string) => void;
  onOpenStep: (runId: string, stepId: string) => void;
}) {
  const past = runs.slice(0, -1);
  const [openId, setOpenId] = useState<string | null>(null);
  if (past.length === 0) return null;
  return (
    <div className="border-border/60 mb-4 border-b pb-3">
      <h3 className="text-muted-foreground mb-2 font-mono text-[10px] font-bold tracking-wider uppercase">
        Run history
      </h3>
      <div className="space-y-1">
        {past.map((r, i) => {
          const open = openId === r.id;
          return (
            <div className="border-border/60 rounded border" key={r.id}>
              <button
                aria-expanded={open}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
                onClick={() => setOpenId((v) => (v === r.id ? null : r.id))}
                type="button"
              >
                <Icon
                  name="chevron-down"
                  className={`text-muted-foreground size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
                />
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">Run {i + 1}</span>
                <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs" title={r.goal}>
                  {r.goal}
                </span>
                {r.status === "running" ? (
                  <Icon name="loader-circle" className="text-primary size-3.5 shrink-0 animate-spin" />
                ) : r.status === "completed" ? (
                  <Icon name="check-circle-2" className="text-success size-3.5 shrink-0" />
                ) : (
                  <Icon name="circle-x" className="text-destructive size-3.5 shrink-0" />
                )}
              </button>
              {open &&
                (() => {
                  const stepTree: SupervisorStep[] = (r.steps ?? []).map((s) => ({
                    stepId: s.stepId,
                    tool: s.tool,
                    task: s.task,
                    state: s.state,
                    dependsOn: s.dependsOn,
                    inputs: s.inputs ?? [],
                    artifacts: s.artifacts ?? [],
                    error: s.error,
                  }));
                  return (
                    <div className="border-border/60 border-t px-2 py-1.5">
                      {stepTree.length > 0 ? (
                        <StepTree live={false} onOpenReport={(stepId) => onOpenStep(r.id, stepId)} steps={stepTree} />
                      ) : (
                        <div className="text-muted-foreground font-mono text-xs">No steps were recorded.</div>
                      )}
                      {(r.outputFull != null || r.outputPreview != null) && (
                        <div className="mt-1 flex items-center gap-3">
                          <button
                            className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
                            onClick={() => onOpenDeliverable(r.id)}
                            type="button"
                          >
                            <Icon name="file-text" className="size-3" />
                            deliverable
                          </button>
                          {onBuildOn != null &&
                            r.status === "completed" &&
                            r.outputFull != null &&
                            r.planKey != null && (
                              <button
                                className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
                                onClick={() => onBuildOn(r)}
                                title={`Arm “${r.goal}” as the follow-up context`}
                                type="button"
                              >
                                <Icon name="corner-down-right" className="size-3" />
                                build on this
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  );
                })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Progress rail (left sidebar) ────────────────────────────────────────────

function statusLabel(status: ReturnType<typeof useWorkbench>["supervisor"]["status"]): string {
  switch (status) {
    case "reviewing":
      return "Awaiting review";
    case "running":
      return "Running";
    case "awaitingConfirmation":
      return "Awaiting confirmation";
    case "stopping":
      return "Stopping";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

export function ProgressRail({
  workbench,
  onOpenReport,
  onNewGoal,
  unseeded,
}: {
  workbench: ReturnType<typeof useWorkbench>;
  onOpenReport: (id: string) => void;
  onNewGoal: () => void;
  /** True while a run is in flight but planStarted hasn't seeded the
   *  supervisor yet — the steps/goal/planStartedAt still BELONG to the
   *  previous run and must never render as the new run's progress. */
  unseeded: boolean;
}) {
  const { supervisor } = workbench;
  // Per-second tick while planning is in flight — the silent windows (context
  // fan-out, each planner LLM round) otherwise read as a frozen UI.
  const [planningTick, setPlanningTick] = useState(0);
  const planningLive = unseeded && supervisor.planning != null;
  useEffect(() => {
    if (!planningLive) {
      setPlanningTick(0);
      return;
    }
    const t = setInterval(() => setPlanningTick((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [planningLive]);
  const planningElapsed = ` · ${planningTick}s`;
  // During planning `supervisor.goal` is still the PREVIOUS run's (or null on
  // the first) until planStarted seeds it — the run record already knows the
  // submitted goal, so show it immediately (system-status visibility).
  const currentRun = workbench.runs[workbench.runs.length - 1];
  const headerGoal = (unseeded ? currentRun?.goal : (supervisor.goal ?? currentRun?.goal)) ?? null;
  const startedAt = unseeded
    ? (currentRun?.startedAt ?? null)
    : (supervisor.planStartedAt ?? currentRun?.startedAt ?? null);
  // Execution steps start COLLAPSED in review — the plan summary is the
  // contract; the step list is an appendix opened on demand.
  const [reviewStepsOpen, setReviewStepsOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: planVersion intentionally re-collapses steps on revision
  useEffect(() => {
    if (supervisor.status === "reviewing") setReviewStepsOpen(false);
  }, [supervisor.status, supervisor.planVersion]);
  // Focus moves to the blocking card when the run needs the user (review or
  // confirmation gate) — keyboard and screen-reader users otherwise keep
  // typing into the composer with no signal. The short delay lets the mobile
  // drawer (auto-opened by the page in the same commit; child effects run
  // first) become visible before focus lands — focus() on a hidden element
  // is a no-op.
  const confirmCardRef = useRef<HTMLDivElement>(null);
  const reviewCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (supervisor.status !== "awaitingConfirmation") return;
    const t = setTimeout(() => confirmCardRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [supervisor.status]);
  useEffect(() => {
    if (supervisor.status !== "reviewing") return;
    const t = setTimeout(() => reviewCardRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [supervisor.status]);
  // "New goal" — the desktop's only path back to the landing hero once no
  // run/review owns the rail (the run view's back arrow is mobile-only, so
  // idle/completed/failed used to be a dead end). Hidden while a run is in
  // flight or awaiting review; disabled through the planning window, where
  // `goHome` deliberately no-ops (same rule as the mobile strip's back
  // button — the run must keep showing progress).
  const showNewGoal = !["running", "stopping", "awaitingConfirmation", "reviewing"].includes(supervisor.status);
  return (
    <div className="flex h-full flex-col">
      <div className="border-primary/30 mb-4 border-b pb-3">
        <h2 className="text-foreground inline-flex items-center gap-1.5 font-mono text-sm font-bold">
          <Icon name="zap" className="text-primary size-4" />
          Progress
        </h2>
        <div className="text-foreground/80 mt-1 truncate font-mono text-xs font-bold" title={headerGoal ?? undefined}>
          {headerGoal
            ? `${unseeded && supervisor.planning != null ? "Planning" : statusLabel(supervisor.status)} · ${headerGoal}`
            : "Idle"}
        </div>
        {/* Failure visibility: the plan-level WHY rides the header — the
            status label alone ("Failed · goal") never said what broke. */}
        {!unseeded && supervisor.status === "failed" && supervisor.error != null && (
          <p className="text-destructive mt-1 font-mono text-xs leading-snug break-words" role="alert">
            {supervisor.error}
          </p>
        )}
        {startedAt != null && (
          <div className="text-muted-foreground font-mono text-xs">
            Duration:{" "}
            <Duration
              className="text-xs"
              from={startedAt}
              /* Unseeded: planCompletedAt still belongs to the previous run —
                 tick live from this run's submit instead of freezing on it. */
              to={unseeded ? undefined : (supervisor.planCompletedAt ?? undefined)}
            />
          </div>
        )}
        {/* Determinate run progress: settled steps over the planned total —
            glanceable completion without reading the step tree. While
            planning the slot holds an indeterminate pulse (the steps still
            belong to the previous run); empty plans render nothing. */}
        {unseeded ? (
          // Planning window: reserve the bar's slot with an indeterminate
          // pulse so the determinate bar doesn't shift the layout in later.
          <div aria-hidden className="bg-accent mt-2 h-1 animate-pulse rounded-full" />
        ) : (
          supervisor.steps.length > 0 && (
            <Progress
              aria-label={`${supervisor.steps.filter((s) => s.state === "completed" || s.state === "failed" || s.state === "skipped").length} of ${supervisor.steps.length} steps done`}
              className="mt-2 h-1"
              value={
                (supervisor.steps.filter(
                  (s) => s.state === "completed" || s.state === "failed" || s.state === "skipped",
                ).length /
                  supervisor.steps.length) *
                100
              }
            />
          )
        )}
      </div>

      {supervisor.status === "reviewing" && supervisor.review ? (
        <div className="space-y-2" ref={reviewCardRef} tabIndex={-1}>
          <PlanSummaryCard summary={supervisor.review.summary ?? supervisor.summary} />
          <button
            aria-expanded={reviewStepsOpen}
            className="text-muted-foreground flex w-full items-center gap-1 font-mono text-[11px] uppercase hover:text-foreground"
            onClick={() => setReviewStepsOpen((o) => !o)}
            type="button"
          >
            <Icon
              className={`size-3 transition-transform ${reviewStepsOpen ? "rotate-90" : ""}`}
              name="chevron-right"
            />
            {reviewStepsOpen ? "Hide" : "View"} {supervisor.review.steps.length} execution steps
          </button>
          {reviewStepsOpen &&
            supervisor.review.steps.map((s) => (
              <div className="text-foreground/80 pl-4 font-mono text-xs" key={s.id}>
                · {s.task || s.tool || s.id}
                {(s.inputs?.length ?? 0) > 0 && (
                  <div className="text-muted-foreground/80 pl-4 text-[10px]">
                    {s.inputs?.map((b) => (
                      <div key={b.arg}>
                        {b.arg} ← {b.fromStep}.{b.output}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          <ReviewActions supervisor={workbench.supervisor} />
        </div>
      ) : (
        <div className="flex-1">
          {/* Unseeded planning window: the stale tree is the PREVIOUS run's —
              show only the planning spinner until planStarted seeds the new
              steps (same policy as the canvas). */}
          {!unseeded && <StepTree live onOpenReport={onOpenReport} steps={supervisor.steps} />}
          {(unseeded || (supervisor.steps.length === 0 && supervisor.status !== "idle")) && (
            <div className="text-muted-foreground mt-2 space-y-1 font-mono text-xs">
              <div className="flex items-center gap-2">
                <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
                {supervisor.planning != null
                  ? supervisor.planning.round === 0
                    ? supervisor.planning.context != null
                      ? `context loaded — starting planner${planningElapsed}`
                      : `loading context (persona · memories · skills · catalog)${planningElapsed}`
                    : `${supervisor.planning.searching ? "searching tools" : "writing plan"} · round ${supervisor.planning.round}${supervisor.planning.provider ? ` · ${supervisor.planning.provider}` : ""}${planningElapsed}`
                  : `preparing context…${planningElapsed}`}
              </div>
              {supervisor.planning?.searching && supervisor.planning.tools.length > 0 && (
                <div className="text-muted-foreground/80 pl-5.5 text-xs">
                  found tools: {supervisor.planning.tools.slice(0, 3).join(", ")}
                  {supervisor.planning.tools.length > 3 ? "…" : ""}
                </div>
              )}
              {supervisor.planning?.searching && (supervisor.planning.queries?.length ?? 0) > 0 && (
                <div className="text-muted-foreground/80 pl-5.5 truncate text-xs italic">
                  searching: “{supervisor.planning.queries[supervisor.planning.queries.length - 1]}”
                </div>
              )}
              {supervisor.planning?.activity && (
                <div className="text-muted-foreground/80 pl-5.5 line-clamp-2 max-h-8 overflow-hidden text-xs italic">
                  ⌁ {supervisor.planning.activity}
                </div>
              )}
              {supervisor.planning?.context &&
                (supervisor.planning.context.persona ||
                  supervisor.planning.context.memories > 0 ||
                  supervisor.planning.context.skills > 0 ||
                  supervisor.planning.context.files > 0) && (
                  <div className="text-muted-foreground/80 pl-5.5 text-xs">
                    context:{" "}
                    {[
                      supervisor.planning.context.persona ? "persona" : null,
                      supervisor.planning.context.memories > 0
                        ? `${supervisor.planning.context.memories} memories`
                        : null,
                      supervisor.planning.context.skills > 0 ? `${supervisor.planning.context.skills} skills` : null,
                      supervisor.planning.context.files > 0 ? `${supervisor.planning.context.files} files` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              {supervisor.planning != null && currentRun != null && (
                <div className="text-muted-foreground/80 pl-5.5 text-xs tabular-nums">
                  {fmtDuration(currentRun.startedAt)} elapsed
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {supervisor.revising && supervisor.status === "running" && (
        <div className="border-warning/30 mt-4 flex items-center gap-1.5 rounded-md border p-3 font-mono text-xs font-bold">
          <Icon name="refresh-cw" className="size-3.5 animate-spin text-warning" />
          <span className="text-foreground/80">Repairing plan (attempt {supervisor.revising.attempt})…</span>
        </div>
      )}

      {supervisor.status === "awaitingConfirmation" && supervisor.pendingConfirmation && (
        <div className="border-primary/30 mt-4 space-y-2 rounded-md border p-3" ref={confirmCardRef} tabIndex={-1}>
          <div className="text-foreground inline-flex items-center gap-1.5 font-mono text-xs font-bold">
            <Icon name="shield-alert" className="text-primary size-3.5" />
            Approval required
          </div>
          <p className="text-foreground/80 font-mono text-xs">
            {supervisor.pendingConfirmation.description || supervisor.pendingConfirmation.task}
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={workbench.supervisor.approve} size="sm">
              <Icon name="play" className="size-3" />
              Approve
            </Button>
            <Button onClick={workbench.supervisor.reject} size="sm" variant="outline">
              Deny
            </Button>
          </div>
        </div>
      )}

      {(supervisor.status === "running" ||
        supervisor.status === "stopping" ||
        supervisor.status === "awaitingConfirmation") && (
        <Button
          className="mt-4 w-full"
          disabled={supervisor.status === "stopping"}
          onClick={workbench.supervisor.stop}
          size="sm"
          variant="outline"
        >
          <Icon name="square" className="size-3" />
          {supervisor.status === "stopping" ? "Stopping…" : "Stop run"}
        </Button>
      )}
      {supervisor.status === "failed" && (
        <div className="mt-4 space-y-2">
          {supervisor.steps.some((s) => s.state === "completed") && (
            <Button className="w-full" onClick={workbench.supervisor.resume} size="sm" variant="outline">
              <Icon name="play" className="size-3" />
              Resume
            </Button>
          )}
          {/* The two "start over" actions side by side: New goal keeps this
              session and its runs, New session drops them. */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              disabled={supervisor.planning != null}
              title="Back to the landing composer — this session and its runs stay."
              onClick={onNewGoal}
              size="sm"
              variant="outline"
            >
              <Icon name="plus" className="size-3" />
              New goal
            </Button>
            <Button
              title="Starts a fresh session — the next run will not recall these runs."
              onClick={() => {
                workbench.startNewSession();
                onNewGoal();
              }}
              size="sm"
              variant="outline"
            >
              New session
            </Button>
          </div>
        </div>
      )}
      {/* Idle/completed: the same affordance at full width — before this the
          rail showed NOTHING once the run stopped needing the user, leaving
          desktop with no way back to the landing hero. */}
      {showNewGoal && supervisor.status !== "failed" && (
        <Button
          className="mt-4 w-full"
          disabled={supervisor.planning != null}
          title="Back to the landing composer — this session and its runs stay."
          onClick={onNewGoal}
          size="sm"
          variant="outline"
        >
          <Icon name="plus" className="size-3" />
          New goal
        </Button>
      )}
    </div>
  );
}
