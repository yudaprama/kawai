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

/** Retried steps get a small indicator — `retriesUsed` comes from the
 *  scheduler's own retry counter, not the dispatcher. */
function RetryBadge({ retries }: { retries: number }) {
  if (retries <= 0) return null;
  return (
    <span
      aria-label={`retried ${retries} time${retries > 1 ? "s" : ""}`}
      className="text-muted-foreground inline-flex items-center gap-0.5 text-[10px]"
      title={`Scheduler retried this step ${retries} time${retries > 1 ? "s" : ""} before it succeeded`}
    >
      <Redo2Icon className="size-3" />
      {retries}
    </span>
  );
}

/** Seconds since `startedAt`, re-rendered once a second while the step is
 *  running. The only "alive" signal between stream events. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return (
    <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px] tabular-nums">
      {mm > 0 ? `${mm}:${String(ss).padStart(2, "0")}` : `${ss}s`}
    </span>
  );
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
    const deps = s.dependsOn.filter((d) => byId.has(d));
    const w = deps.length === 0 ? 1 : Math.max(...deps.map((d) => depth(byId.get(d)!))) + 1;
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

// ── Step row (shared by progress + review) ─────────────────────────────────

function StepMeta({ step }: { step: { tool: string; task: string } }) {
  return (
    <>
      {step.tool && <span className="bg-muted rounded px-1 py-px font-mono text-[11px]">{step.tool}</span>}
      {step.task && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">{step.task}</p>}
    </>
  );
}

function StepRow({ step, onStopTicking }: { step: SupervisorStep; onStopTicking?: boolean }) {
  return (
    <li
      className={`flex items-start gap-2.5 rounded-md text-xs ${
        step.state === "running" ? "-mx-2 bg-primary/5 px-2 py-1.5" : "px-0 py-1"
      }`}
    >
      <span className="pt-0.5">
        <StepIcon state={step.state} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{step.stepId}</span>
          <StepMeta step={step} />
          <RetryBadge retries={step.retriesUsed ?? 0} />
        </div>
        {step.output && (
          <p className="text-foreground/80 mt-0.5 truncate text-[11px]" title={step.output}>
            {step.output.length > 160 ? `${step.output.slice(0, 159)}…` : step.output}
          </p>
        )}
        {step.error && (
          <p className="text-destructive mt-0.5 text-[11px]">
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
      {step.state === "running" && step.startedAt != null && !onStopTicking && <Elapsed startedAt={step.startedAt} />}
    </li>
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
 *  is the executed plan. */
export function PlanReviewPanel({ review, onApprove, onCancel, onRemoveStep }: PlanReviewPanelProps) {
  const confirmCount = review.steps.filter((s) => s.requiresConfirmation).length;
  return (
    <div className="bg-card w-full rounded-xl border p-3.5 text-sm shadow-xs">
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold">Review plan</span>
        <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium">
          {review.steps.length} step{review.steps.length > 1 ? "s" : ""}
          {confirmCount > 0 && ` · ${confirmCount} will ask for approval`}
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
      </div>

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
                <span className="font-medium">{step.id}</span>
                <StepMeta step={step} />
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
    </div>
  );
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
 *  otherwise-silent LLM time). Rendered inline in the chat column, styled
 *  like the plan card so the two read as one lifecycle. */
export function PlanningCard({ planning }: PlanningCardProps) {
  return (
    <div className="bg-card w-full rounded-xl border p-3.5 text-sm shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium">
          <LoaderCircleIcon className="size-3 animate-spin" />
          Planning…
        </span>
        <span className="text-muted-foreground text-[11px]">
          {planning.round === 0 ? "starting…" : `round ${planning.round}`}
          {planning.provider && ` · ${planning.provider}`}
          {planning.searching ? " · searching tools" : planning.round > 0 ? " · writing plan" : ""}
        </span>
      </div>
      {planning.tools.length > 0 && (
        <p className="text-muted-foreground mt-2 text-[11px]">Found: {planning.tools.join(", ")}</p>
      )}
    </div>
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
}

const STATUS_LABEL: Record<SupervisorStatus, string> = {
  idle: "idle",
  reviewing: "review",
  running: "running",
  stopping: "stopping…",
  awaitingConfirmation: "waiting for your approval",
  completed: "completed",
  failed: "failed",
};

/** Live plan view: full step structure (tool, task, dependencies) grouped
 *  into the waves the scheduler actually dispatches, per-step status,
 *  retries, elapsed time, and artifacts. */
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
    <div className="bg-card w-full rounded-xl border p-3.5 text-sm shadow-xs">
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold">
          Plan
          {revised && <span className="text-muted-foreground ml-1.5 font-normal">v{planVersion}</span>}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
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
          {steps.length > 0 && ` · ${completed}/${steps.length}`}
          {status === "running" && runningCount > 1 && ` · ${runningCount} parallel`}
        </span>
        {status === "completed" && steps.length > 0 && (
          <button
            className="text-muted-foreground hover:text-foreground ml-auto shrink-0 text-[11px] font-medium hover:underline"
            onClick={() => setShowDetails((v) => !v)}
            type="button"
          >
            {showDetails ? "Hide details" : "View details"}
          </button>
        )}
        {(status === "running" || status === "stopping" || status === "awaitingConfirmation") && (
          <Button className="ml-auto" disabled={status === "stopping"} onClick={onStop} size="sm" variant="outline">
            <SquareIcon className="size-3" />
            {status === "stopping" ? "Stopping…" : "Stop plan"}
          </Button>
        )}
        {status === "failed" && onResume && steps.some((s) => s.state === "completed") && (
          <Button className="ml-auto" onClick={onResume} size="sm" variant="outline">
            <PlayIcon className="size-3" />
            Resume plan
          </Button>
        )}
      </div>

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

      {goal && <p className="mt-2.5 line-clamp-2 text-sm leading-snug">{goal}</p>}

      {status === "stopping" && (
        <p className="text-muted-foreground mt-1.5 text-[11px]">
          Stopping after the active steps finish — no new steps will start.
        </p>
      )}

      {collapsed ? (
        <p className="text-muted-foreground mt-2 text-[11px]">
          {completed}/{steps.length} steps completed
          {steps.some((s) => s.artifacts.length > 0) &&
            ` · ${steps.reduce((n, s) => n + s.artifacts.length, 0)} artifact${steps.reduce((n, s) => n + s.artifacts.length, 0) > 1 ? "s" : ""}`}
          {failed > 0 && ` · ${failed} failed`}
        </p>
      ) : (
        steps.length > 0 && (
          <div className="mt-3 space-y-3">
            {waves.map((wave) => (
              <section key={wave.index}>
                {/* Real scheduler structure — waves are derived from dependsOn,
                    not invented sequencing. One section per wave keeps the
                    reading order == execution order. */}
                <p
                  aria-label={`Wave ${wave.index}`}
                  className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase"
                >
                  {waves.length > 1 ? `Wave ${wave.index}` : "Steps"}
                </p>
                <ol className="space-y-1">
                  {wave.steps.map((step) => (
                    <StepRow key={step.stepId} step={step} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )
      )}

      {revised && priorVersions.length > 0 && (
        <div className="mt-2.5 border-t pt-2">
          <button
            className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium hover:underline"
            onClick={() => setShowHistory((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showHistory ? "rotate-180" : ""}`} />
            {priorVersions.length} earlier version{priorVersions.length > 1 ? "s" : ""}
          </button>
          {showHistory && (
            <ul className="mt-1.5 space-y-0.5">
              {priorVersions.map((v) => (
                <li className="text-muted-foreground text-[11px]" key={v.version}>
                  v{v.version} — {v.completed}/{v.total} steps completed · {v.note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
      {status === "failed" && replansExhausted && onNewPlan && (
        <Button className="mt-2" onClick={onNewPlan} size="sm" variant="outline">
          <ListPlusIcon className="size-3.5" />
          Try a new plan
        </Button>
      )}
      {finalOutput && (
        <div className="mt-2.5 border-t pt-2">
          <button
            className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
            onClick={() => setShowOutput((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showOutput ? "rotate-180" : ""}`} />
            Final output
          </button>
          {showOutput && (
            <div className="bg-muted mt-1.5 rounded-md p-2.5 text-xs whitespace-pre-wrap">{finalOutput}</div>
          )}
        </div>
      )}
    </div>
  );
}
