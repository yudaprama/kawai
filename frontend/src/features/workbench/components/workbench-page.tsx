import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleXIcon,
  ShieldAlertIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PlayIcon,
  SquareIcon,
  XIcon,
  ZapIcon,
  CornerDownRightIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChatComposer } from "@/features/chat/components/chat-composer";
import { FileIcon } from "@/components/shared/file-icon";
import { Streamdown } from "@/lib/streamdown";
import { call, errText } from "@/lib/api";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";
import { AgentReportsSwitcher, StepReportBody } from "@/features/workbench/components/shared-canvas";
import {
  agentName,
  computePhases,
  FOLLOW_UP_CHIPS,
  isDeliverableStep,
  useWorkbench,
  type WorkbenchRun,
} from "@/features/workbench/hooks/use-workbench";

// ── Small shared pieces ─────────────────────────────────────────────────────

function fmtDuration(from: number, to?: number): string {
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

// ── Follow-up composer extras (PLAN-followup-composer.md) ───────────────────

/** Quick-action chips above the composer — static set until the dynamic
 *  suggest_followups result lands, then swapped (statis-first, Fase 3).
 *  Only rendered after a finished run with a completed deliverable; chips
 *  never block free-form input and disappear while a plan is under review. */
function FollowUpChips({
  workbench,
  onChip,
}: {
  workbench: ReturnType<typeof useWorkbench>;
  onChip: (text: string) => void;
}) {
  if (!workbench.canFollowUp || !workbench.composing) return null;
  const chips: { icon?: string; label: string; text: string }[] =
    workbench.dynamicChips.length > 0
      ? workbench.dynamicChips.map((t) => ({ label: t, text: t }))
      : FOLLOW_UP_CHIPS.map((c) => ({ icon: c.icon, label: c.label, text: c.prefix }));
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <button
          className="border-border/60 hover:border-primary/60 text-foreground/80 hover:text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors"
          key={c.label}
          onClick={() => onChip(c.text)}
          title={c.text}
          type="button"
        >
          {c.icon && <span aria-hidden>{c.icon}</span>}
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** The single quote indicator (PLAN-workbench-multi-run-ux.md): rendered
 *  ONLY when a quote is armed — chips are the only way to arm it, ✕ disarms.
 *  No second opt-in entry point. */
function ComposerQuoteBadge({ workbench }: { workbench: ReturnType<typeof useWorkbench> }) {
  if (!workbench.followUp || !workbench.composing) return null;
  const title = workbench.supervisor.goal ?? "previous deliverable";
  return (
    <div className="text-muted-foreground mb-2 flex items-center gap-1.5 font-mono text-[11px]">
      <CornerDownRightIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate" title={`Will include: “${title}” (previous deliverable)`}>
        Will include the previous deliverable
      </span>
      <button
        aria-label="Do not include the previous deliverable"
        className="hover:text-foreground shrink-0"
        onClick={() => workbench.setFollowUp(false)}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** Run history rail (sidebar): past runs as expandable entries whose body is
 *  the run's STEP TIMELINE. Nothing renders the old deliverable here —
 *  picking `report` or `deliverable` opens it on the CANVAS (right pane).
 *  Full step bodies load on demand from supervisor_step_results via the
 *  run's stored planKey. */
function RunHistoryRail({
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

/** Canvas view: which run's which document is on the right pane. Null only
 *  before the first run produces anything. doc = "final" | stepId. */
interface CanvasView {
  runId: string;
  doc: string;
}

/** Level-1 switcher in the canvas header: pick which RUN is shown. */
function RunSwitcher({
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
              <LoaderCircleIcon className="text-primary size-3 shrink-0 animate-spin" />
            ) : r.status === "completed" ? (
              <CheckCircle2Icon className="text-success size-3 shrink-0" />
            ) : (
              <CircleXIcon className="text-destructive size-3 shrink-0" />
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
function PastRunCanvas({
  loadFullOutput,
  onPickDoc,
  run,
  runIndex,
  doc,
}: {
  loadFullOutput: (stepId: string, planKey?: string) => Promise<string | null>;
  onPickDoc: (doc: string) => void;
  run: WorkbenchRun;
  runIndex: number;
  doc: string;
}) {
  const reportableSteps = (run.steps ?? []).filter((s) => s.state === "completed" || s.state === "failed");
  const isDeliverable = doc === "final";
  /** Header label: the step's task (agentName), or the tool — never the raw
   *  step id. Same derivation the active canvas uses. */
  const docStep = (run.steps ?? []).find((s) => s.stepId === doc);
  const docLabel = isDeliverable
    ? "Deliverable"
    : docStep != null
      ? (docStep.task || docStep.tool).trim().length > 48
        ? `${(docStep.task || docStep.tool).trim().slice(0, 47).trimEnd()}…`
        : (docStep.task || docStep.tool).trim()
      : doc;
  const deliverableBody = run.outputFull ?? (run.outputPreview ? `${run.outputPreview}…` : null);
  const stepTool = run.steps?.find((s) => s.stepId === doc)?.tool ?? "";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h3 className="text-foreground inline-flex items-center gap-2 text-xl font-semibold">
            <ZapIcon className="text-primary size-5" />
            Run {runIndex + 1} · {docLabel}
          </h3>
          <div className="text-muted-foreground mt-1 font-mono text-sm">
            {new Date(run.startedAt).toLocaleString()}
            {run.stepsTotal != null && ` · ${run.stepsDone ?? 0}/${run.stepsTotal} steps`}
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
            needsFetch
            planKey={run.planKey ?? undefined}
            previewOutput=""
            stepId={doc}
            tool={stepTool}
          />
        )}

        <AgentReportsSwitcher
          activeDoc={doc}
          hasDeliverable={deliverableBody != null}
          onPickDoc={onPickDoc}
          reports={reportableSteps.map((s) => ({ stepId: s.stepId, label: s.task || s.tool }))}
        />
      </div>
    </div>
  );
}

/** The ONE step-tree renderer — used by BOTH the active Progress rail and
 *  every run-history entry, guaranteeing identical format (phases, step rows,
 *  state icons, tools, report buttons). `live` enables running spinners and
 *  per-step durations; settled rows show the tool label instead. */
function StepTree({
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

// ── Left rail: progress phases ──────────────────────────────────────────────

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

function ProgressRail({
  workbench,
  onOpenReport,
  onNewGoal,
}: {
  workbench: ReturnType<typeof useWorkbench>;
  onOpenReport: (id: string) => void;
  onNewGoal: () => void;
}) {
  const { supervisor } = workbench;
  return (
    <div className="flex h-full flex-col">
      <div className="border-primary/30 mb-4 border-b pb-3">
        <h2 className="text-foreground inline-flex items-center gap-1.5 font-mono text-sm font-bold">
          <ZapIcon className="text-primary size-4" />
          Progress
        </h2>
        <div className="text-foreground/80 mt-1 font-mono text-xs font-bold">
          {supervisor.goal ? `${statusLabel(supervisor.status)} · ${supervisor.goal.slice(0, 40)}` : "Idle"}
        </div>
        {supervisor.planStartedAt != null && (
          <div className="text-muted-foreground font-mono text-xs">
            Duration: {fmtDuration(supervisor.planStartedAt, supervisor.planCompletedAt ?? undefined)}
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
            <div className="text-muted-foreground mt-2 flex items-center gap-2 font-mono text-xs">
              <LoaderCircleIcon className="text-primary size-3.5 animate-spin" />
              {supervisor.planning != null
                ? supervisor.planning.round === 0
                  ? "starting…"
                  : `planning · round ${supervisor.planning.round}${supervisor.planning.provider ? ` · ${supervisor.planning.provider}` : ""}`
                : "preparing…"}
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

// ── Center: deliverable viewer ──────────────────────────────────────────────

function DeliverableViewer({
  doc,
  onPickDoc,
  runIndex,
  workbench,
}: {
  /** Pinned document: "final" | stepId. The page owns navigation policy —
   *  this component NEVER auto-jumps on its own. */
  doc: string;
  onPickDoc: (doc: string) => void;
  runIndex: number;
  workbench: ReturnType<typeof useWorkbench>;
}) {
  const { supervisor } = workbench;
  const reports = useMemo(
    () =>
      supervisor.steps.filter(
        (s) => !isDeliverableStep(s) && s.output && (s.state === "completed" || s.state === "failed"),
      ),
    [supervisor.steps],
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

  const done = supervisor.steps.filter((s) => s.state === "completed").length;

  const exportGoal = async (format: "pdf" | "docx") => {
    if (supervisor.finalOutput == null || exporting) return;
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
          <h3 className="text-foreground inline-flex items-center gap-2 text-xl font-semibold">
            <ZapIcon className="text-primary size-5" />
            {`Run ${runIndex + 1} · `}
            {effective === "final"
              ? "Deliverable"
              : step != null
                ? `${agentName(step)} — report`
                : supervisor.goal
                  ? supervisor.goal
                  : "Deliverable"}
          </h3>
          <div className="text-muted-foreground mt-1 font-mono text-sm">
            {done}/{supervisor.steps.length} steps
            {supervisor.planStartedAt != null &&
              ` · ${fmtDuration(supervisor.planStartedAt, supervisor.planCompletedAt ?? undefined)}`}
          </div>
        </div>

        {supervisor.status === "idle" && supervisor.planning == null && (
          <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
            State a goal in the composer to start a run.
          </div>
        )}

        {effective === "final" && supervisor.finalOutput != null && (
          <div className="border-primary/30 bg-card rounded-lg border p-6">
            <Streamdown>{supervisor.finalOutput}</Streamdown>
          </div>
        )}
        {effective === "final" && supervisor.finalOutput != null && supervisor.status === "completed" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground mr-1 font-mono text-[11px] uppercase">Export</span>
            <Button disabled={exporting != null} onClick={() => void exportGoal("pdf")} size="sm" variant="outline">
              {exporting === "pdf" ? (
                <LoaderCircleIcon className="size-3 animate-spin" />
              ) : (
                <FileIcon className="size-3" name="export.pdf" />
              )}
              PDF
            </Button>
            <Button disabled={exporting != null} onClick={() => void exportGoal("docx")} size="sm" variant="outline">
              {exporting === "docx" ? (
                <LoaderCircleIcon className="size-3 animate-spin" />
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
        {effective !== "final" && step != null && output != null && (
          <StepReportBody
            fetcher={workbench.loadFullOutput}
            needsFetch={previewTruncated}
            cacheKey={`${supervisor.goal ?? ""}::${supervisor.planVersion ?? ""}`}
            previewOutput={output}
            stepId={step.stepId}
            tool={step.tool}
          />
        )}
        {effective === "final" && supervisor.finalOutput == null && supervisor.status !== "idle" && (
          <div className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-8 font-mono text-sm">
            <LoaderCircleIcon className="text-primary size-4 animate-spin" />
            The deliverable is being written…
          </div>
        )}

        <AgentReportsSwitcher
          activeDoc={effective}
          hasDeliverable={supervisor.finalOutput != null}
          onPickDoc={onPickDoc}
          reports={reports.map((r) => ({ stepId: r.stepId, label: agentName(r) }))}
        />
      </div>
    </div>
  );
}

// ── History strip (home state) ──────────────────────────────────────────────

function RunHistory({
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
                  <LoaderCircleIcon className="text-primary size-4 animate-spin" />
                ) : r.status === "completed" ? (
                  <CheckCircle2Icon className="text-success size-4" />
                ) : (
                  <CircleXIcon className="text-destructive size-4" />
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

// ── Page ────────────────────────────────────────────────────────────────────

export interface WorkbenchPageProps {
  /** Knowledge integration for the composer's @ menu + image drop. */
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  onAddFiles?: () => void;
  onAddLink?: () => void;
}

/** The kawai Workbench — the work-centric primary surface (PLAN-workbench.md).
 *  Left: a single sidebar — progress phases + Messages & Tools timeline, with
 *  the goal composer pinned at the bottom. Right: the deliverable. Results
 *  never enter chat. */
export function WorkbenchPage({ onImageToKnowledge, onAddFiles, onAddLink }: WorkbenchPageProps) {
  const workbench = useWorkbench();
  const { supervisor } = workbench;
  // Home = the landing composer. Submitting a goal moves to the workbench;
  // "New goal" returns here.
  const [home, setHome] = useState(true);
  // Canvas navigation (PLAN-workbench-multi-run-ux.md, canvas policy):
  // view = which run + which document is on the right pane. null = the first
  // run hasn't produced anything yet. The canvas NEVER moves on its own
  // except twice per run: (1) when the new run's FIRST content lands, it
  // switches to that run once; (2) when the deliverable lands, it switches
  // to "final" once — and only if the user hasn't manually navigated.
  const [view, setView] = useState<CanvasView | null>(null);
  const [stealAllowed, setStealAllowed] = useState(true);
  const autoSwitchedRun = useRef<string | null>(null);
  const activeRunId = workbench.runs.at(-1)?.id ?? null;
  // supervisor.planStartedAt captured at submit. While planStartedAt still
  // equals this baseline, the supervisor state BELONGS to the previous run
  // (planning reuses it until planStarted fires) — the canvas must treat the
  // active run as "not seeded yet" and never read steps/finalOutput as its.
  const planStartedBaseline = useRef<number | null>(null);
  const seededForActiveRun =
    supervisor.planStartedAt != null && supervisor.planStartedAt !== planStartedBaseline.current;

  /** User-initiated navigation — cancels the deliverable steal. */
  const userPick = (runId: string, doc: string) => {
    setStealAllowed(false);
    setView({ runId, doc });
  };

  // Auto-switch ONCE per run: only AFTER the supervisor has seeded the new
  // run (planStarted) and its first content lands. During planning the
  // supervisor still carries the PREVIOUS run's steps/output — those must
  // never count as the new run's content.
  useEffect(() => {
    if (activeRunId == null || autoSwitchedRun.current === activeRunId) return;
    if (!seededForActiveRun) return;
    const hasContent = supervisor.finalOutput != null || supervisor.steps.some((s) => s.output != null);
    if (!hasContent) return;
    autoSwitchedRun.current = activeRunId;
    const firstReport = supervisor.steps.find(
      (s) => !isDeliverableStep(s) && s.output != null && (s.state === "completed" || s.state === "failed"),
    );
    console.log("[workbench] AUTO-SWITCH to new run", activeRunId);
    console.log("[workbench] AUTO-SWITCH to new run", activeRunId);
    setView({ runId: activeRunId, doc: supervisor.finalOutput != null ? "final" : (firstReport?.stepId ?? "final") });
  }, [activeRunId, seededForActiveRun, supervisor.finalOutput, supervisor.steps]);

  // Steal ONCE: when the NEW run's deliverable lands (finalOutput null →
  // value AFTER seeding) and the user hasn't navigated manually since
  // submit, show it. While unseeded, keep syncing the baseline so run 1's
  // stale finalOutput is never mistaken for run 2's.
  const prevFinal = useRef<string | null>(null);
  useEffect(() => {
    if (!seededForActiveRun) {
      prevFinal.current = supervisor.finalOutput;
      return;
    }
    const arrived = supervisor.finalOutput != null && prevFinal.current == null;
    prevFinal.current = supervisor.finalOutput;
    if (!arrived || !stealAllowed) return;
    if (activeRunId == null) return;
    setView({ runId: activeRunId, doc: "final" });
    setStealAllowed(false);
  }, [stealAllowed, seededForActiveRun, supervisor.finalOutput, activeRunId]);

  /** Rail "see report" — a user pick. The steps shown in the rail belong to
   *  the active run once seeded, otherwise (planning) to the previous run. */
  const openReport = (id: string) => {
    const owner = seededForActiveRun ? activeRunId : (workbench.runs.at(-2)?.id ?? activeRunId);
    if (owner != null) userPick(owner, id);
  };
  // Chip click → draft dropped into the input for editing (not auto-submit).
  const [chipDraft, setChipDraft] = useState<{ text: string; nonce: number } | null>(null);
  const chipClicked = (text: string) => {
    workbench.setFollowUp(true);
    setChipDraft({ text, nonce: Date.now() });
  };
  const submit = (text: string, fileIds?: string[]) => {
    if (!text.trim()) return;
    // A plan awaiting review owns the rail — new goals wait until it is run
    // or discarded.
    if (supervisor.status === "reviewing") return;
    setHome(false);
    // Canvas policy: keep showing whatever is on screen (run 1) until the
    // new run's first content lands; then the once-per-run auto-switch fires.
    setStealAllowed(true);
    planStartedBaseline.current = supervisor.planStartedAt;
    const quote = workbench.followUp;
    void workbench.run(text, fileIds, { quote });
  };
  const composerStatus = ["running", "stopping", "awaitingConfirmation"].includes(supervisor.status)
    ? ("submitted" as const)
    : ("ready" as const);

  // Keep the history list's step tally fresh while a run progresses.
  useEffect(() => {
    workbench.syncLatestRun(supervisor.steps);
  }, [supervisor.steps, workbench.syncLatestRun]); // eslint-disable-line react-hooks/exhaustive-deps

  // Landing: hero composer, no rails — the goal is the whole screen.
  if (home) {
    return (
      <div className="bg-background flex h-full w-full flex-col">
        <div className="flex items-center justify-between px-4 py-2">
          <span className="text-foreground inline-flex items-center gap-1.5 font-mono text-xs font-bold tracking-wider uppercase">
            <ZapIcon className="text-primary size-4" />
            Kawai Workbench
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
          <div className="space-y-2">
            <p className="text-foreground inline-flex items-center gap-2 text-lg font-semibold">
              <ZapIcon className="text-primary size-6" />
              State a goal. Watch the work.
            </p>
            <p className="text-muted-foreground max-w-md text-xs">
              Kawai plans the steps, runs the agents, and you watch every report land — the deliverable is written here,
              not in a chat.
            </p>
          </div>
          <div className="w-full max-w-2xl">
            <ChatComposer
              agentName="Workbench"
              chipDraft={chipDraft}
              lastUserText={null}
              onAddFiles={onAddFiles}
              onAddLink={onAddLink}
              onImageToKnowledge={onImageToKnowledge}
              onSubmit={(text, fileIds) => submit(text, fileIds)}
              onStop={workbench.supervisor.stop}
              status={composerStatus}
            />
            <p className="text-muted-foreground mt-3 text-left font-mono text-[10px]">
              Attach knowledge files with @ — the run's agents can search them.
            </p>
          </div>
          {workbench.runs.length > 0 && (
            <div className="w-full max-w-2xl text-left">
              <RunHistory
                latestRunId={workbench.runs.at(-1)?.id}
                onReopen={(runId) => {
                  // S1: only the latest run's report is inspectable.
                  if (runId === workbench.runs.at(-1)?.id) {
                    setHome(false);
                    userPick(runId, "final");
                  }
                }}
                runs={workbench.runs}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full w-full overflow-hidden">
      {/* Left: one sidebar — progress + timeline (scrolls), composer pinned at
          the bottom. */}
      <aside className="border-border/60 hidden w-96 shrink-0 flex-col border-r lg:flex">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <RunHistoryRail
            onOpenDeliverable={(runId) => userPick(runId, "final")}
            onOpenStep={(runId, stepId) => userPick(runId, stepId)}
            runs={workbench.runs}
          />
          <ProgressRail
            workbench={workbench}
            onNewGoal={() => {
              setView(null);
              autoSwitchedRun.current = null;
              setHome(true);
            }}
            onOpenReport={openReport}
          />
        </div>
        <div className="border-border/60 border-t p-4">
          {workbench.runs.length > 0 && (
            <div className="text-muted-foreground mb-2 font-mono text-[10px] tracking-wider uppercase">
              Session · {workbench.runs.length} run{workbench.runs.length === 1 ? "" : "s"}
            </div>
          )}
          {supervisor.status === "reviewing" && (
            <p className="text-muted-foreground mb-2 font-mono text-[11px]">
              A plan is awaiting your review above — run or discard it first.
            </p>
          )}
          <FollowUpChips onChip={chipClicked} workbench={workbench} />
          <ComposerQuoteBadge workbench={workbench} />
          <ChatComposer
            agentName="Workbench"
            chipDraft={chipDraft}
            lastUserText={null}
            onAddFiles={onAddFiles}
            onAddLink={onAddLink}
            onImageToKnowledge={onImageToKnowledge}
            onSubmit={submit}
            onStop={workbench.supervisor.stop}
            status={composerStatus}
            placeholder={
              workbench.canFollowUp
                ? "Follow up on the previous deliverable… (e.g. expand section 2, change tone)"
                : undefined
            }
          />
          {workbench.sessionError && (
            <p className="text-destructive mt-2 font-mono text-[11px]">{workbench.sessionError}</p>
          )}
        </div>
      </aside>

      {/* Right: the CANVAS — run switcher + exactly one full document. The
          canvas never moves on its own except the two approved steals. */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-border/60 flex items-center justify-between border-b px-4 py-2">
          <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Kawai Workbench</span>
        </div>
        {workbench.runs.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-center font-mono text-sm">
            State a goal in the composer to start a run.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-border/60 border-b px-4 py-2">
              <RunSwitcher
                activeRunId={activeRunId}
                onPick={(runId) => userPick(runId, "final")}
                runs={workbench.runs}
                view={view}
              />
            </div>
            <div className="min-h-0 flex-1">
              {(() => {
                const shown = view != null ? workbench.runs.find((r) => r.id === view.runId) : undefined;
                const runIndex = shown != null ? workbench.runs.indexOf(shown) : -1;
                if (shown != null && runIndex < workbench.runs.length - 1) {
                  return (
                    <PastRunCanvas
                      doc={view?.doc ?? "final"}
                      loadFullOutput={workbench.loadFullOutput}
                      onPickDoc={(d) => userPick(shown.id, d)}
                      run={shown}
                      runIndex={runIndex}
                    />
                  );
                }
                // Active (latest) run — live. doc stays pinned; before the
                // first content arrives it's "final" (shows the goal/planning
                // placeholder), which is the approved first-run behavior.
                return (
                  <DeliverableViewer
                    doc={view != null && view.runId === activeRunId ? view.doc : "final"}
                    onPickDoc={(d) => activeRunId != null && userPick(activeRunId, d)}
                    runIndex={workbench.runs.length - 1}
                    workbench={workbench}
                  />
                );
              })()}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
