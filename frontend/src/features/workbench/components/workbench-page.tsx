import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleXIcon,
  ShieldAlertIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PlayIcon,
  SquareIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChatComposer } from "@/features/chat/components/chat-composer";
import { Streamdown } from "@/lib/streamdown";
import { call, errText } from "@/lib/api";
import { renderStepReport } from "@/features/workbench/components/tool-views";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";
import {
  agentName,
  computePhases,
  isDeliverableStep,
  useWorkbench,
  type TimelineRow,
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
  const phases = computePhases(supervisor.steps);
  const deliverableStep = supervisor.steps.find(isDeliverableStep);
  const [collapsedPhases, setCollapsedPhases] = useState<Set<number>>(new Set());
  const togglePhase = (i: number) =>
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
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
        <div className="flex-1 space-y-4">
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
                          {step.state === "running" && step.startedAt != null ? (
                            <Duration from={step.startedAt} />
                          ) : (
                            <span className="text-muted-foreground font-mono text-[10px]">{step.tool}</span>
                          )}
                          {step.output && step.state === "completed" && (
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
                <span className="text-foreground/90 min-w-0 truncate">Deliverable Writer</span>
                <StateIcon state={deliverableStep.state} />
              </div>
              <div className="flex items-center justify-between">
                {deliverableStep.state === "running" ? (
                  <Duration from={deliverableStep.startedAt ?? Date.now()} />
                ) : (
                  <span className="text-muted-foreground font-mono text-[10px]">{deliverableStep.tool}</span>
                )}
                {deliverableStep.output && deliverableStep.state === "completed" && (
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
          {supervisor.steps.length === 0 && supervisor.status !== "idle" && (
            <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs">
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
            onClick={() => {
              workbench.newRun();
              onNewGoal();
            }}
            size="sm"
            variant="outline"
          >
            New goal
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Center: deliverable viewer ──────────────────────────────────────────────

function DeliverableViewer({
  workbench,
  selected,
  onSelect,
}: {
  workbench: ReturnType<typeof useWorkbench>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { supervisor } = workbench;
  const reports = useMemo(
    () =>
      supervisor.steps.filter(
        (s) => !isDeliverableStep(s) && s.output && (s.state === "completed" || s.state === "failed"),
      ),
    [supervisor.steps],
  );
  // Follow the work: newest completed report while running, the deliverable
  // once it exists — unless the user pinned a report (rail or switcher).
  const newest = reports.length > 0 ? reports[reports.length - 1] : null;
  const effective =
    selected === "auto" ? (supervisor.finalOutput != null ? "final" : (newest?.stepId ?? "final")) : selected;
  const step = reports.find((r) => r.stepId === effective);

  // The wire preview is capped at 2000 chars — when the shown report hits
  // that bound, fetch the full body from the persisted step results. Values
  // are `string` on success, `"failed"` after a failed fetch (stay on the
  // preview; no retry spinner). In-flight tracking lives in a ref — a state
  // flag here would re-trigger this very effect and deadlock the fetch.
  const previewTruncated = (step?.output?.length ?? 0) >= 2000;
  const [fullOutputs, setFullOutputs] = useState<Record<string, string | "failed">>({});
  const inflight = useRef<Set<string>>(new Set());
  useEffect(() => {
    const stepId = step?.stepId;
    if (!stepId || !previewTruncated || fullOutputs[stepId] != null || inflight.current.has(stepId)) return;
    inflight.current.add(stepId);
    void workbench.loadFullOutput(stepId).then((full) => {
      inflight.current.delete(stepId);
      setFullOutputs((prev) => ({ ...prev, [stepId]: full ?? "failed" }));
    });
  }, [step, previewTruncated, fullOutputs, workbench.loadFullOutput]);
  // A new run invalidates everything fetched for the previous one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset triggers are the point — clear the cache when the run identity changes
  useEffect(() => {
    setFullOutputs({});
    setExportedName(null);
    setExportError(null);
  }, [supervisor.goal, supervisor.planVersion]);

  const full = step ? fullOutputs[step.stepId] : undefined;
  const output = step ? (typeof full === "string" ? full : step.output) : undefined;
  const loadingFull = previewTruncated && full == null;

  const done = supervisor.steps.filter((s) => s.state === "completed").length;

  // Export the deliverable as a stored .pdf/.docx via the office engines.
  const [exporting, setExporting] = useState<"pdf" | "docx" | null>(null);
  const [exportedName, setExportedName] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
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
            {supervisor.finalOutput != null
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

        {supervisor.status === "idle" && (
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
                <FileTextIcon className="size-3" />
              )}
              PDF
            </Button>
            <Button disabled={exporting != null} onClick={() => void exportGoal("docx")} size="sm" variant="outline">
              {exporting === "docx" ? (
                <LoaderCircleIcon className="size-3 animate-spin" />
              ) : (
                <FileTextIcon className="size-3" />
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
          <div className="bg-card rounded-lg border p-4">
            {loadingFull && (
              <p className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
                <LoaderCircleIcon className="text-primary size-3.5 animate-spin" />
                Loading full report…
              </p>
            )}
            {renderStepReport(step.tool, output)}
          </div>
        )}
        {effective === "final" && supervisor.finalOutput == null && supervisor.status !== "idle" && (
          <div className="text-muted-foreground flex items-center gap-2 rounded-lg border border-dashed p-8 font-mono text-sm">
            <LoaderCircleIcon className="text-primary size-4 animate-spin" />
            The deliverable is being written…
          </div>
        )}

        {reports.length > 0 && (
          <div className="rounded-lg border p-4">
            <h4 className="text-muted-foreground mb-3 text-center font-mono text-sm tracking-[0.2em]">AGENT REPORTS</h4>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <button
                className={`text-foreground rounded-lg border px-3 py-2 font-mono text-xs transition-colors ${
                  effective === "final" ? "border-primary bg-primary/10" : "hover:border-primary/60"
                }`}
                onClick={() => onSelect("final")}
                type="button"
              >
                ★ Deliverable
              </button>
              {reports.map((r) => (
                <button
                  className={`text-foreground truncate rounded-lg border px-3 py-2 font-mono text-xs transition-colors ${
                    effective === r.stepId ? "border-primary bg-primary/10" : "hover:border-primary/60"
                  }`}
                  key={r.stepId}
                  onClick={() => onSelect(r.stepId)}
                  title={agentName(r)}
                  type="button"
                >
                  {agentName(r)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Right rail: composer + machine timeline ─────────────────────────────────

function ComposerAndTimeline({
  workbench,
  composerProps,
}: {
  workbench: ReturnType<typeof useWorkbench>;
  composerProps: {
    agentName: string;
    status: "ready" | "submitted";
    onStop: () => void;
    onSubmit: (text: string, fileIds?: string[]) => void;
    onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
    onAddFiles?: () => void;
    onAddLink?: () => void;
  };
}) {
  const { supervisor } = workbench;
  return (
    <div className="flex h-full flex-col">
      <div className="border-primary/20 border-b p-4">
        <h2 className="text-foreground mb-3 font-mono text-sm font-bold">Goal</h2>
        {supervisor.status === "reviewing" ? (
          <p className="text-muted-foreground font-mono text-[11px]">
            A plan is awaiting your review — approve it in the Progress rail.
          </p>
        ) : (
          <ChatComposer
            agentName={composerProps.agentName}
            lastUserText={null}
            onAddFiles={composerProps.onAddFiles}
            onAddLink={composerProps.onAddLink}
            onImageToKnowledge={composerProps.onImageToKnowledge}
            onSubmit={composerProps.onSubmit}
            onStop={composerProps.onStop}
            status={composerProps.status}
          />
        )}
        {workbench.sessionError && (
          <p className="text-destructive mt-2 font-mono text-[11px]">{workbench.sessionError}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="text-foreground mb-3 font-mono text-sm font-bold">Messages &amp; Tools</h2>
        <div className="space-y-3">
          {workbench.timeline.map((row) => (
            <TimelineView key={row.id} row={row} />
          ))}
          {workbench.timeline.length === 0 && (
            <p className="text-muted-foreground font-mono text-[11px]">No activity yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineView({ row }: { row: TimelineRow }) {
  return (
    <div className="border-border/50 border-b pb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-muted-foreground font-mono text-xs font-bold">{row.at}</span>
        <span
          className={`rounded px-2 py-0.5 font-mono text-[10px] ${
            row.kind === "failed"
              ? "bg-destructive/10 text-destructive"
              : row.kind === "tool"
                ? "bg-warning/10 text-warning"
                : "bg-primary/10 text-primary"
          }`}
        >
          {row.kind === "tool" ? "Tool" : row.kind === "failed" ? "Failed" : row.kind === "planner" ? "Plan" : "Done"}
        </span>
      </div>
      <div className="text-foreground/60 font-mono text-xs">{row.agent}</div>
      <div className="text-foreground font-mono text-xs">
        {row.kind === "tool" && <WrenchIcon className="mr-1 inline size-3" />}
        {row.detail}
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
 *  Left: progress phases. Center: the deliverable. Right: goal composer +
 *  machine timeline. Results never enter chat. */
export function WorkbenchPage({ onImageToKnowledge, onAddFiles, onAddLink }: WorkbenchPageProps) {
  const workbench = useWorkbench();
  const { supervisor } = workbench;
  // Home = the landing composer. Submitting a goal moves to the workbench;
  // "New goal" returns here.
  const [home, setHome] = useState(true);
  // Which report the viewer shows ("auto" follows the work; a step id or
  // "final" pins it). Rail "see report" and the switcher share this state.
  const [selectedReport, setSelectedReport] = useState<string>("auto");
  const openReport = (id: string) => setSelectedReport(id);

  const submit = (text: string, fileIds?: string[]) => {
    if (!text.trim()) return;
    setHome(false);
    setSelectedReport("auto"); // follow the new run's work, not a stale pin
    void workbench.run(text, fileIds);
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
              lastUserText={null}
              onAddFiles={onAddFiles}
              onAddLink={onAddLink}
              onDraftConsumed={undefined}
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
                onReopen={() => {
                  setHome(false);
                  setSelectedReport("final");
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
      {/* Left: progress rail */}
      <aside className="border-border/60 hidden w-72 shrink-0 overflow-y-auto border-r p-4 lg:block">
        <ProgressRail
          workbench={workbench}
          onNewGoal={() => {
            setSelectedReport("auto"); // stale pin would blank the next run
            setHome(true);
          }}
          onOpenReport={openReport}
        />
      </aside>

      {/* Center: deliverable (or history when idle) */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="border-border/60 flex items-center justify-between border-b px-4 py-2">
          <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Kawai Workbench</span>
        </div>
        {supervisor.status === "idle" ? (
          <RunHistory
            latestRunId={workbench.runs.at(-1)?.id}
            onReopen={() => setSelectedReport("final")}
            runs={workbench.runs}
          />
        ) : (
          <DeliverableViewer selected={selectedReport} onSelect={setSelectedReport} workbench={workbench} />
        )}
      </main>

      {/* Right: composer + timeline */}
      <aside className="border-border/60 hidden w-80 shrink-0 overflow-hidden border-l md:flex md:flex-col">
        <ComposerAndTimeline
          composerProps={{
            agentName: "Workbench",
            status: composerStatus,
            onStop: workbench.supervisor.stop,
            onSubmit: submit,
            onImageToKnowledge,
            onAddFiles,
            onAddLink,
          }}
          workbench={workbench}
        />
      </aside>
    </div>
  );
}
