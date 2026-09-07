import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CircleXIcon,
  FileTextIcon,
  ListPlusIcon,
  LoaderCircleIcon,
  PlayIcon,
  Redo2Icon,
  SkipForwardIcon,
  SquareIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { emitOpenPreview } from "@/lib/preview-bridge";
import type {
  PriorPlanVersion,
  PlanReview,
  SupervisorArtifact,
  SupervisorStatus,
  SupervisorStep,
} from "@/features/chat/hooks/use-supervisor-plan";

function StepIcon({ state }: { state: SupervisorStep["state"] }) {
  // Token-driven colors only — raw palette classes bypass the theme and break
  // dark-mode contrast (see critique 2026-09-04).
  if (state === "completed") return <CheckCircle2Icon className="text-success size-3.5 shrink-0" />;
  if (state === "failed") return <CircleXIcon className="text-destructive size-3.5 shrink-0" />;
  if (state === "running") return <LoaderCircleIcon className="text-primary size-3.5 shrink-0 animate-spin" />;
  if (state === "skipped") return <SkipForwardIcon className="text-muted-foreground size-3.5 shrink-0" />;
  return <CircleIcon className="text-muted-foreground/50 size-3.5 shrink-0" />;
}

// ── Workbench chrome (shared by every plan state) ───────────────────────────

/** `01:46`-style duration; <1 min reads `42s`. */
function fmtDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return mm > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : `${ss}s`;
}

/** Seconds since `startedAt`, re-rendered once a second while the step is
 *  running. The only "alive" signal between stream events. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
      {fmtDuration(Date.now() - startedAt)}
    </span>
  );
}

/** Total plan wall-clock: ticks while `endedAt` is unset, freezes after. */
function TotalElapsed({ startedAt, endedAt }: { startedAt: number; endedAt: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (endedAt != null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [endedAt]);
  return (
    <span
      className="text-muted-foreground inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums"
      title="Total plan duration"
    >
      ⏱ {fmtDuration((endedAt ?? Date.now()) - startedAt)}
    </span>
  );
}

const STATUS_LABEL: Record<SupervisorStatus, string> = {
  idle: "idle",
  reviewing: "review",
  running: "running",
  stopping: "stopping…",
  awaitingConfirmation: "awaiting approval",
  completed: "completed",
  failed: "failed",
};

function StatusPill({ status }: { status: SupervisorStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium ${
        status === "failed"
          ? "bg-destructive/10 text-destructive"
          : status === "completed"
            ? "bg-success/10 text-success"
            : status === "stopping"
              ? "bg-warning/10 text-warning"
              : "bg-primary/10 text-primary"
      }`}
    >
      {(status === "running" || status === "stopping") && <LoaderCircleIcon className="size-3 animate-spin" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** The shared card chrome: `⚡ ANALYSIS` label + status pill on the left,
 *  actions on the right. One visual identity from planning to terminal. */
function ChromeHeader({ status, children }: { status: SupervisorStatus; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-foreground inline-flex shrink-0 items-center gap-1 font-mono text-xs font-bold">
        <ZapIcon className="text-primary size-3.5" />
        ANALYSIS
      </span>
      <StatusPill status={status} />
      {children}
    </div>
  );
}

function CardFrame({ children }: { children: React.ReactNode }) {
  return <div className="bg-card w-full rounded-xl border p-3.5 text-sm shadow-xs">{children}</div>;
}

// ── Planning card (live `plan_task` progress) ──────────────────────────────

export interface PlanningState {
  round: number;
  provider: string;
  searching: boolean;
  tools: string[];
}

export interface PlanningCardProps {
  planning: PlanningState;
}

/** Live planning progress, shown while `plan_task` runs (tens of seconds of
 *  otherwise-silent LLM time). Rendered inline in the chat column in the same
 *  chrome as the progress card so planning → execution reads as one
 *  lifecycle. `round 0` is the optimistic pre-IPC seed ("starting…"); a
 *  round-open event carries an empty provider (request in flight). */
export function PlanningCard({ planning }: PlanningCardProps) {
  return (
    <CardFrame>
      <ChromeHeader status="running">
        <span className="text-primary inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium">
          <LoaderCircleIcon className="size-3 animate-spin" />
          PLANNING
        </span>
        <span className="text-muted-foreground font-mono text-[11px]">
          {planning.round === 0 ? "starting…" : `round ${planning.round}`}
          {planning.provider && ` · ${planning.provider}`}
          {planning.searching ? " · searching tools" : planning.round > 0 ? " · writing plan" : ""}
        </span>
      </ChromeHeader>
      {planning.tools.length > 0 && (
        <p className="text-muted-foreground mt-2 font-mono text-[11px]">
          <span className="text-foreground/70">FOUND:</span> {planning.tools.join(", ")}
        </p>
      )}
    </CardFrame>
  );
}

// ── Step rows ───────────────────────────────────────────────────────────────

/** Retried steps get a small indicator — `retriesUsed` comes from the
 *  scheduler's own retry counter, not the dispatcher. */
function RetryBadge({ retries }: { retries: number }) {
  if (retries <= 0) return null;
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-0.5 text-[10px]"
      title={`Scheduler retried this step ${retries} time${retries > 1 ? "s" : ""} before it succeeded`}
    >
      <Redo2Icon className="size-3" />
      {retries}
    </span>
  );
}

/** Expandable full step output. The transport caps step output at
 *  STEP_EVENT_OUTPUT_MAX_CHARS (2000) — this shows exactly what the frontend
 *  has, honestly; full bodies stay on the artifact / artifact_recall path. */
function StepOutput({ output }: { output: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-0.5">
      <button
        className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono text-[10px] hover:underline"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <FileTextIcon className="size-3" />
        {open ? "hide output" : "see output"}
      </button>
      {open && (
        <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap">
          {output}
        </pre>
      )}
    </div>
  );
}

function StepRow({ step, onStopTicking }: { step: SupervisorStep; onStopTicking?: boolean }) {
  // Human label first (planner-written task); the machine identity degrades
  // to a chip on the right. Tool-only fallback keeps raw name as the label.
  const label = step.task && step.task !== step.tool ? step.task : step.tool || step.stepId;
  const doneMs =
    step.finishedAt != null && step.startedAt != null ? fmtDuration(step.finishedAt - step.startedAt) : null;
  return (
    <li
      className={`flex items-start gap-2.5 rounded-md font-mono text-xs ${
        step.state === "running" ? "-mx-2 bg-primary/5 px-2 py-1.5" : "px-0 py-1"
      }`}
    >
      <span className="pt-0.5">
        <StepIcon state={step.state} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-sans font-medium">{label}</span>
          {step.tool && step.tool !== label && (
            <span className="bg-muted rounded px-1 py-px text-[10px]" title={`tool: ${step.tool}`}>
              {step.tool}
            </span>
          )}
          <RetryBadge retries={step.retriesUsed ?? 0} />
        </div>
        {step.output && step.state !== "running" && <StepOutput output={step.output} />}
        {step.error && (
          <p className="text-destructive mt-0.5 font-sans text-[11px]">
            {step.errorKind && ERROR_HINT[step.errorKind] ? `${ERROR_HINT[step.errorKind]} — ` : ""}
            {step.error}
          </p>
        )}
        {step.artifacts.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {step.artifacts.map((a) => (
              <ArtifactRow artifact={a} key={`${step.stepId}-${a.handle ?? a.kind}`} />
            ))}
          </div>
        )}
      </div>
      {doneMs != null && <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{doneMs}</span>}
      {step.state === "running" && step.startedAt != null && !onStopTicking && <Elapsed startedAt={step.startedAt} />}
    </li>
  );
}

function ArtifactRow({ artifact }: { artifact: SupervisorArtifact }) {
  if (artifact.kind === "file") {
    return (
      <button
        className="text-primary inline-flex items-center gap-1 rounded-sm text-xs font-medium hover:underline"
        onClick={() => artifact.handle && emitOpenPreview(artifact.handle, artifact.filename ?? artifact.handle)}
        type="button"
      >
        <FileTextIcon className="size-3" />
        {artifact.filename ?? artifact.handle}
      </button>
    );
  }
  if (artifact.kind === "structured") {
    // Backend-provided shape description ("table: 4 rows × 3 cols") — never a
    // generic "structured result"; no chevron (nothing expands).
    return <span className="text-muted-foreground text-[11px]">{artifact.label ?? "data result"}</span>;
  }
  if (artifact.kind === "handle") {
    // Raw handles (mem1, …) are internal paging keys — a user-facing chip
    // says the result is retrievable, not what the key looks like.
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
        <CheckCircle2Icon className="size-3" />
        {artifact.label ?? "result saved"}
      </span>
    );
  }
  return null;
}

/** Failure-class → human copy. `errorKind` is the scheduler's typed
 *  FailureKind, not a parsed string. */
const ERROR_HINT: Record<string, string> = {
  timeout: "ran out of time",
  confirmation: "needs your approval",
  cancelled: "was cancelled",
};

// ── Wave computation ────────────────────────────────────────────────────────

// The scheduler dispatches in waves derived from `dependsOn`; the panel shows
// that real structure (not artificial sequencing).

interface Wave {
  index: number;
  steps: SupervisorStep[];
}

function computeWaves(steps: SupervisorStep[]): Wave[] {
  const waveOf = new Map<string, number>();
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const depth = (s: SupervisorStep): number => {
    const cached = waveOf.get(s.stepId);
    if (cached != null) return cached;
    const depSteps = s.dependsOn.map((d) => byId.get(d)).filter((x): x is SupervisorStep => x != null);
    const w = depSteps.length === 0 ? 1 : Math.max(...depSteps.map(depth)) + 1;
    waveOf.set(s.stepId, w);
    return w;
  };
  const waves: Wave[] = [];
  for (const s of steps) {
    const w = depth(s);
    let wave = waves.find((x) => x.index === w);
    if (!wave) {
      wave = { index: w, steps: [] };
      waves.push(wave);
    }
    wave.steps.push(s);
  }
  return waves.sort((a, b) => a.index - b.index);
}

/** One collapsible phase. Auto-collapsed when every step is settled
 *  (completed/skipped); the active phase is always expanded. User toggle
 *  overrides within this mount. */
function PhaseSection({ wave, multiPhase }: { wave: Wave; multiPhase: boolean }) {
  const allSettled = wave.steps.every((s) => s.state === "completed" || s.state === "skipped");
  const [open, setOpen] = useState(!allSettled);
  const isExpanded = open || !allSettled;
  const doneCount = wave.steps.filter((s) => s.state === "completed").length;
  return (
    <section>
      <button
        aria-expanded={isExpanded}
        className="text-muted-foreground hover:text-foreground mb-1 flex w-full items-center gap-1 font-mono text-[10px] font-medium tracking-wide uppercase"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <ChevronDownIcon className={`size-3 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
        {multiPhase ? `Phase ${wave.index}` : "Steps"}
        {allSettled && (
          <span className="ml-1 normal-case">
            · {doneCount}/{wave.steps.length} done
          </span>
        )}
      </button>
      {isExpanded && (
        <ol className="ml-2 space-y-1">
          {wave.steps.map((step) => (
            <StepRow key={step.stepId} step={step} />
          ))}
        </ol>
      )}
    </section>
  );
}

// ── Review panel (R1) ───────────────────────────────────────────────────────

export interface PlanReviewPanelProps {
  review: PlanReview;
  onApprove: () => void;
  onCancel: () => void;
  onRemoveStep: (stepId: string) => void;
}

/** Pre-execution plan review: the planner's validated contract, shown before
 *  anything runs. The deterministic supervisor guarantees the reviewed plan
 *  is the executed plan. Same chrome as the progress card — one lifecycle. */
export function PlanReviewPanel({ review, onApprove, onCancel, onRemoveStep }: PlanReviewPanelProps) {
  const confirmCount = review.steps.filter((s) => s.requiresConfirmation).length;
  return (
    <CardFrame>
      <ChromeHeader status="reviewing">
        <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium">
          {review.steps.length} step{review.steps.length > 1 ? "s" : ""}
          {confirmCount > 0 && ` · ${confirmCount} will ask approval`}
        </span>
        <div className="ml-auto flex gap-2">
          <Button onClick={onCancel} size="sm" variant="ghost">
            Discard
          </Button>
          <Button onClick={onApprove} size="sm">
            <PlayIcon className="size-3.5" />
            Run plan
          </Button>
        </div>
      </ChromeHeader>

      {review.goal && <p className="mt-2.5 line-clamp-2 text-sm leading-snug">{review.goal}</p>}
      <p className="text-muted-foreground mt-1 text-[11px]">
        Steps run automatically in dependency order; nothing executes until you run the plan. Remove a step to also
        remove the steps that depend on it.
      </p>

      <ol className="mt-3 space-y-1">
        {review.steps.map((step) => (
          <li className="group flex items-start gap-2.5 rounded-md px-0 py-1 text-xs" key={step.id}>
            <span className="pt-0.5">
              <CircleIcon className="text-muted-foreground/50 size-3.5 shrink-0" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-sans font-medium">{step.task || step.id}</span>
                {step.tool && <span className="bg-muted rounded px-1 py-px font-mono text-[10px]">{step.tool}</span>}
                {step.requiresConfirmation && (
                  <span className="bg-warning/10 text-warning rounded px-1 py-px text-[10px] font-medium">
                    asks approval
                  </span>
                )}
              </div>
            </div>
            <button
              aria-label={`Remove step ${step.id} and its dependents`}
              className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onRemoveStep(step.id)}
              title="Remove this step (and steps that depend on it)"
              type="button"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </li>
        ))}
      </ol>
    </CardFrame>
  );
}

// ── Progress panel ──────────────────────────────────────────────────────────

export interface PlanProgressPanelProps {
  status: SupervisorStatus;
  goal: string | null;
  steps: SupervisorStep[];
  error: string | null;
  finalOutput: string | null;
  onStop: () => void;
  /** Re-execute the same plan — completed steps are skipped via the
   *  supervisor's persisted step cache. */
  onResume?: () => void;
  /** Plan version — 1 on the first run, incremented per failure-driven
   *  replan. Hidden entirely when no revision has happened. */
  planVersion: number;
  /** Superseded plan versions, for the collapse history. */
  priorVersions: PriorPlanVersion[];
  /** Replan budget is spent — failure offers "new plan" alongside resume. */
  replansExhausted: boolean;
  /** Start a fresh plan for the same goal (goes through review again). */
  onNewPlan?: () => void;
  /** Wall-clock start of the plan (planStarted) — drives the total timer. */
  planStartedAt?: number | null;
  /** Terminal time (planCompleted/planFailed) — freezes the total timer. */
  planCompletedAt?: number | null;
}

/** Live plan view in the workbench chrome: total duration, phases derived
 *  from the real `dependsOn` waves (collapsed once settled), per-step human
 *  labels with tool chips, durations, `see output` expanders, artifacts. */
export function PlanProgressPanel({
  status,
  goal,
  steps,
  error,
  finalOutput,
  onStop,
  onResume,
  planVersion,
  priorVersions,
  replansExhausted,
  onNewPlan,
  planStartedAt,
  planCompletedAt,
}: PlanProgressPanelProps) {
  const [showOutput, setShowOutput] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  if (status === "idle" || status === "reviewing") return null;

  const completed = steps.filter((s) => s.state === "completed").length;
  const failed = steps.filter((s) => s.state === "failed").length;
  const runningCount = steps.filter((s) => s.state === "running").length;
  const done = completed + failed + steps.filter((s) => s.state === "skipped").length;
  const progress = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0;
  const waves = computeWaves(steps);
  const revised = planVersion > 1;
  // Completed plans collapse to a one-line summary — the final answer lives
  // in the conversation, not duplicated here (P2).
  const collapsed = status === "completed" && !showDetails;

  return (
    <CardFrame>
      <ChromeHeader status={status}>
        {steps.length > 0 && (
          <span className="text-muted-foreground font-mono text-[11px]">
            {completed}/{steps.length}
            {status === "running" && runningCount > 1 && ` · ${runningCount} parallel`}
          </span>
        )}
        {planStartedAt != null && (
          <span className="ml-auto">
            <TotalElapsed startedAt={planStartedAt} endedAt={planCompletedAt ?? null} />
          </span>
        )}
        {status === "completed" && steps.length > 0 && (
          <button
            className="text-muted-foreground hover:text-foreground shrink-0 font-mono text-[11px] font-medium hover:underline"
            onClick={() => setShowDetails((v) => !v)}
            type="button"
          >
            [{showDetails ? "hide details" : "details"}]
          </button>
        )}
        {(status === "running" || status === "stopping" || status === "awaitingConfirmation") && (
          <Button
            className={planStartedAt != null ? "" : "ml-auto"}
            disabled={status === "stopping"}
            onClick={onStop}
            size="sm"
            variant="outline"
          >
            <SquareIcon className="size-3" />
            {status === "stopping" ? "Stopping…" : "Stop"}
          </Button>
        )}
        {status === "failed" && onResume && steps.some((s) => s.state === "completed") && (
          <Button className="ml-auto" onClick={onResume} size="sm" variant="outline">
            <PlayIcon className="size-3" />
            Resume plan
          </Button>
        )}
      </ChromeHeader>
      {revised && <span className="text-muted-foreground ml-0.5 font-mono text-[10px]">v{planVersion}</span>}

      {/* Progress rail — the at-a-glance signal the text counters alone lacked. */}
      {steps.length > 0 && (
        <div
          aria-label={`Plan progress: ${completed} of ${steps.length} steps completed`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full"
          role="progressbar"
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${
              status === "failed" ? "bg-destructive" : "bg-primary"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {goal && <p className="mt-2.5 line-clamp-2 font-sans text-sm leading-snug">{goal}</p>}

      {status === "stopping" && (
        <p className="text-muted-foreground mt-1.5 text-[11px]">
          Stopping after the active steps finish — no new steps will start.
        </p>
      )}

      {collapsed ? (
        <p className="text-muted-foreground mt-2 font-mono text-[11px]">
          {completed}/{steps.length} steps · {done === steps.length ? "all settled" : `${failed} failed`}
          {steps.some((s) => s.artifacts.length > 0) &&
            ` · ${steps.reduce((n, s) => n + s.artifacts.length, 0)} artifact${steps.reduce((n, s) => n + s.artifacts.length, 0) > 1 ? "s" : ""}`}
        </p>
      ) : (
        steps.length > 0 && (
          <div className="mt-3 space-y-3">
            {waves.map((wave) => (
              <PhaseSection key={wave.index} multiPhase={waves.length > 1} wave={wave} />
            ))}
          </div>
        )
      )}

      {revised && priorVersions.length > 0 && (
        <div className="mt-2.5 border-t pt-2">
          <button
            className="text-muted-foreground inline-flex items-center gap-1 font-mono text-[11px] font-medium hover:underline"
            onClick={() => setShowHistory((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showHistory ? "rotate-180" : ""}`} />
            {priorVersions.length} earlier version{priorVersions.length > 1 ? "s" : ""}
          </button>
          {showHistory && (
            <ul className="mt-1.5 space-y-0.5">
              {priorVersions.map((v) => (
                <li className="text-muted-foreground font-mono text-[11px]" key={v.version}>
                  v{v.version} — {v.completed}/{v.total} steps completed · {v.note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-destructive mt-2 font-sans text-xs">{error}</p>}
      {status === "failed" && replansExhausted && onNewPlan && (
        <Button className="mt-2" onClick={onNewPlan} size="sm" variant="outline">
          <ListPlusIcon className="size-3.5" />
          Try a new plan
        </Button>
      )}
      {finalOutput && (
        <div className="mt-2.5 border-t pt-2">
          <button
            className="text-muted-foreground inline-flex items-center gap-1 font-mono text-[11px] font-medium hover:underline"
            onClick={() => setShowOutput((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showOutput ? "rotate-180" : ""}`} />
            final output
          </button>
          {showOutput && (
            <div className="bg-muted mt-1.5 rounded-md p-2.5 font-mono text-[10px] whitespace-pre-wrap">
              {finalOutput}
            </div>
          )}
        </div>
      )}
    </CardFrame>
  );
}
