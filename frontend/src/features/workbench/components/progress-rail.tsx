import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleXIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PlayIcon,
  ShieldAlertIcon,
  SquareIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";
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

function StateIcon({ state }: { state: SupervisorStep["state"] }) {
  if (state === "completed") return <CheckCircle2Icon className="text-success size-3.5 shrink-0" />;
  if (state === "failed") return <CircleXIcon className="text-destructive size-3.5 shrink-0" />;
  if (state === "running") return <LoaderCircleIcon className="text-primary size-3.5 shrink-0 animate-spin" />;
  if (state === "skipped") return <ChevronDownIcon className="text-muted-foreground size-3.5 shrink-0" />;
  return <span className="text-muted-foreground/50 block size-3.5 shrink-0 rounded-full border" />;
}

/** Live-ticking duration, freezing at `to` once set. */
function Duration({ from, to }: { from: number; to?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (to != null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [to]);
  return (
    <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">{fmtDuration(from, to)}</span>
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
              <ChevronDownIcon
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
                      <span className="text-foreground/90 min-w-0 truncate" title={agentName(step)}>
                        {agentName(step)}
                      </span>
                      <StateIcon state={step.state} />
                    </div>
                    <div className="flex items-center justify-between">
                      {live && step.state === "running" && step.startedAt != null ? (
                        <Duration from={step.startedAt} />
                      ) : (
                        <span className="text-muted-foreground truncate font-mono text-[10px]">{step.tool}</span>
                      )}
                      {reportable(step, live) && (
                        <button
                          className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
                          onClick={() => onOpenReport(step.stepId)}
                          type="button"
                        >
                          <FileTextIcon className="size-3" />
                          see report
                        </button>
                      )}
                    </div>
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
                <FileTextIcon className="size-3" />
                see report
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A step carries an inspectable report: live rows gate on the wire preview
 *  existing (completed), history rows on the state being terminal. */
function reportable(step: SupervisorStep, live: boolean): boolean {
  if (live) return step.output != null && step.state === "completed";
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
  onOpenDeliverable,
  onOpenStep,
}: {
  runs: WorkbenchRun[];
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
                <ChevronDownIcon
                  className={`text-muted-foreground size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
                />
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">Run {i + 1}</span>
                <span className="text-foreground/90 min-w-0 flex-1 truncate text-xs" title={r.goal}>
                  {r.goal}
                </span>
                {r.status === "running" ? (
                  <LoaderCircleIcon className="text-primary size-3.5 shrink-0 animate-spin" />
                ) : r.status === "completed" ? (
                  <CheckCircle2Icon className="text-success size-3.5 shrink-0" />
                ) : (
                  <CircleXIcon className="text-destructive size-3.5 shrink-0" />
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
                    artifacts: [],
                  }));
                  return (
                    <div className="border-border/60 border-t px-2 py-1.5">
                      {stepTree.length > 0 ? (
                        <StepTree live={false} onOpenReport={(stepId) => onOpenStep(r.id, stepId)} steps={stepTree} />
                      ) : (
                        <div className="text-muted-foreground font-mono text-xs">No steps were recorded.</div>
                      )}
                      {(r.outputFull != null || r.outputPreview != null) && (
                        <button
                          className="text-muted-foreground hover:text-primary mt-1 inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
                          onClick={() => onOpenDeliverable(r.id)}
                          type="button"
                        >
                          <FileTextIcon className="size-3" />
                          deliverable
                        </button>
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
}: {
  workbench: ReturnType<typeof useWorkbench>;
  onOpenReport: (id: string) => void;
  onNewGoal: () => void;
}) {
  const { supervisor } = workbench;
  // During planning `supervisor.goal` is still the PREVIOUS run's (or null on
  // the first) until planStarted seeds it — the run record already knows the
  // submitted goal, so show it immediately (system-status visibility).
  const currentRun = workbench.runs[workbench.runs.length - 1];
  const headerGoal = supervisor.goal ?? currentRun?.goal ?? null;
  const startedAt = supervisor.planStartedAt ?? currentRun?.startedAt ?? null;
  // Live-tick while a run is in flight so the elapsed timers move every
  // second even when no events arrive (long silent planner rounds).
  const [, tick] = useState(0);
  useEffect(() => {
    if (supervisor.status !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [supervisor.status]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-primary/30 mb-4 border-b pb-3">
        <h2 className="text-foreground inline-flex items-center gap-1.5 font-mono text-sm font-bold">
          <ZapIcon className="text-primary size-4" />
          Progress
        </h2>
        <div className="text-foreground/80 mt-1 font-mono text-xs font-bold">
          {headerGoal ? `${statusLabel(supervisor.status)} · ${headerGoal.slice(0, 40)}` : "Idle"}
        </div>
        {startedAt != null && (
          <div className="text-muted-foreground font-mono text-xs">
            Duration: {fmtDuration(startedAt, supervisor.planCompletedAt ?? undefined)}
          </div>
        )}
      </div>

      {supervisor.status === "reviewing" && supervisor.review ? (
        <div className="space-y-2">
          <p className="text-muted-foreground font-mono text-[11px] uppercase">
            Review plan · {supervisor.review.steps.length} steps
          </p>
          {supervisor.review.steps.map((s) => (
            <div className="text-foreground/80 font-mono text-xs" key={s.id}>
              · {s.task || s.tool || s.id}
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <Button className="flex-1" onClick={workbench.supervisor.approvePlan} size="sm">
              <PlayIcon className="size-3" />
              Run
            </Button>
            <Button onClick={workbench.supervisor.cancelPlan} size="sm" variant="outline">
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1">
          <StepTree live onOpenReport={onOpenReport} steps={supervisor.steps} />
          {supervisor.steps.length === 0 && supervisor.status !== "idle" && (
            <div className="text-muted-foreground mt-2 space-y-1 font-mono text-xs">
              <div className="flex items-center gap-2">
                <LoaderCircleIcon className="text-primary size-3.5 animate-spin" />
                {supervisor.planning != null
                  ? supervisor.planning.round === 0
                    ? "starting…"
                    : `${supervisor.planning.searching ? "searching tools" : "writing plan"} · round ${supervisor.planning.round}${supervisor.planning.provider ? ` · ${supervisor.planning.provider}` : ""}`
                  : "preparing context…"}
              </div>
              {supervisor.planning?.searching && supervisor.planning.tools.length > 0 && (
                <div className="text-muted-foreground/80 pl-5.5 text-[11px]">
                  found tools: {supervisor.planning.tools.slice(0, 3).join(", ")}
                  {supervisor.planning.tools.length > 3 ? "…" : ""}
                </div>
              )}
              {supervisor.planning?.activity && (
                <div className="text-muted-foreground/60 pl-5.5 line-clamp-2 max-h-8 overflow-hidden text-[11px] italic">
                  ⌁ {supervisor.planning.activity}
                </div>
              )}
              {supervisor.planning != null && currentRun != null && (
                <div className="text-muted-foreground/60 pl-5.5 text-[11px] tabular-nums">
                  {fmtDuration(currentRun.startedAt)} elapsed
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {supervisor.status === "awaitingConfirmation" && supervisor.pendingConfirmation && (
        <div className="border-primary/30 mt-4 space-y-2 rounded-md border p-3">
          <div className="text-foreground inline-flex items-center gap-1.5 font-mono text-xs font-bold">
            <ShieldAlertIcon className="text-primary size-3.5" />
            Approval required
          </div>
          <p className="text-foreground/80 font-mono text-[11px]">
            {supervisor.pendingConfirmation.description || supervisor.pendingConfirmation.task}
          </p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={workbench.supervisor.approve} size="sm">
              <PlayIcon className="size-3" />
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
          <SquareIcon className="size-3" />
          {supervisor.status === "stopping" ? "Stopping…" : "Stop run"}
        </Button>
      )}
      {supervisor.status === "failed" && (
        <div className="mt-4 space-y-2">
          {supervisor.steps.some((s) => s.state === "completed") && (
            <Button className="w-full" onClick={workbench.supervisor.resume} size="sm" variant="outline">
              <PlayIcon className="size-3" />
              Resume
            </Button>
          )}
          <Button
            className="w-full"
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
      )}
    </div>
  );
}
