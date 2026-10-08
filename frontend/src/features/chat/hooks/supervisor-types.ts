/** Shared supervisor types — single source for the reducer, the hook, and the
 *  workbench's persisted-record reader. Types + pure helpers only; the wire
 *  event union and its payload types are GENERATED from the Rust side and
 *  re-exported below (the generated module imports nothing, so there is no
 *  circular-import risk). */

/** Wire event union + plan-step payload — generated from
 *  `kawai_events::SupervisorEvent` by `bun run generate:events`; never
 *  hand-edited. Re-exported so existing import paths keep working. */
export type { PlanStepInfo, SupervisorEvent } from "@/generated/events";
import type { PlanSummary } from "@/generated/events";

export type SupervisorStatus =
  | "idle"
  | "reviewing"
  | "running"
  | "stopping"
  | "awaitingConfirmation"
  | "completed"
  | "failed";

export interface SupervisorArtifact {
  kind: "text" | "file" | "structured" | "handle";
  handle?: string;
  filename?: string;
  /** Human-readable one-liner from the backend — the UI never renders raw
   *  handles or a generic "structured result". */
  label?: string;
}

/** One explicit dataflow binding: the step consumes `fromStep`'s `output`
 *  artifact as its `arg` argument. Rendered as "arg ← step.output". */
export interface SupervisorInputBinding {
  arg: string;
  fromStep: string;
  output: string;
}

export interface SupervisorStep {
  stepId: string;
  tool: string;
  task: string;
  dependsOn: string[];
  state: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  /** Failure class: timeout | confirmation | cancelled | tool */
  errorKind?: string;
  /** Retries the scheduler spent on this step (0 = first attempt). */
  retriesUsed?: number;
  /** Wall-clock start of the current/last run — drives the elapsed timer. */
  startedAt?: number;
  /** Wall-clock end — freezes the per-step duration. */
  finishedAt?: number;
  artifacts: SupervisorArtifact[];
  /** Explicit dataflow bindings — shown as the wiring the step consumes. */
  inputs?: SupervisorInputBinding[];
}

/** One step of a plan awaiting user review (before execution). Wire shape
 *  mirrors the camelCase TaskStep serialization from `plan_task`. */
export interface PlanReviewStep {
  id: string;
  tool: string;
  task: string;
  dependsOn: string[];
  /** Dataflow bindings — reviewed alongside the step list so the user sees
   *  what each step consumes, not just what it runs. */
  inputs?: SupervisorInputBinding[];
  requiresConfirmation: boolean;
}

export interface PlanReview {
  plan: unknown;
  summary: PlanSummaryInfo | null;
  goal: string;
  steps: PlanReviewStep[];
  sessionId: number;
  agentId: string;
}

/** A superseded plan version (failure-driven replan) kept for the version
 *  history in the progress panel. */
export interface PriorPlanVersion {
  version: number;
  completed: number;
  total: number;
  note: string;
}

export interface PlanSummaryInfo {
  /** 1–3 sentences (user's language): what the agent will do and why. */
  overview: string;
  /** ≤5 plain-language actions. */
  actions: string[];
  /** ≤5 expected outputs / deliverables. */
  outputs: string[];
}

export interface SupervisorPlanState {
  status: SupervisorStatus;
  goal: string | null;
  /** Full plan structure — seeded at planStarted, before any step runs. */
  steps: SupervisorStep[];
  /** User-facing "what will the agent do / produce" — from planStarted/planRevised. */
  summary: PlanSummaryInfo | null;
  /** Live planning progress — non-null only while `plan_task` is in flight. */
  planning: {
    round: number;
    provider: string;
    searching: boolean;
    tools: string[];
    /** Tool-catalog search queries the planner issued (planningToolSearch). */
    queries: string[];
    /** Trailing slice of the planner's reasoning (planningActivity). */
    activity?: string;
    /** Personal context loaded into the planner call (planningContext). */
    context?: { persona: boolean; memories: number; skills: number; files: number };
  } | null;
  /** Wall-clock plan start (planStarted) and terminal time — drive the
   *  workbench card's total-duration timer. */
  planStartedAt: number | null;
  planCompletedAt: number | null;
  pendingConfirmation: {
    streamId: string;
    stepId: string;
    task: string;
    description: string;
  } | null;
  finalOutput: string | null;
  /** Deliverable artifacts of the finished run — a deck artifact renders as
   *  the deliverable hero in the viewer. */
  artifacts: SupervisorArtifact[];
  error: string | null;
  /** Plan awaiting user review (plan_task done, execution not started). */
  review: PlanReview | null;
  /** Current plan version — 1 on first run, incremented per replan. */
  planVersion: number;
  /** Hash of the currently-executing plan — the read key for the
   *  `supervisor_step_output` op (full report bodies). */
  planKey: string | null;
  /** Superseded plan versions, oldest first. */
  priorVersions: PriorPlanVersion[];
  /** True when the replan budget is spent — failure then offers "new plan". */
  replansExhausted: boolean;
  /** Surgical repair in progress (planRevising) — cleared by planRevised /
   *  planCompleted / planFailed. Surfaces a "repairing plan" rail row so the
   *  LLM revise rounds don't read as a hung run. */
  revising: { attempt: number } | null;
}

// ── Persisted plan records (assistant-message JSON in chat history) ─────────

/** Wire shape of one persisted plan step (from the JSON blob in chat history). */
export interface PersistedPlanStep {
  id: string;
  tool: string;
  state: string;
  output?: string;
  /** Planner's human task label (restored journals show it, not the tool). */
  task?: string;
  /** Dispatch order — lets a restored journal re-derive phases. */
  dependsOn?: string[];
  /** Dataflow bindings — restored so the rail shows the step's wiring. */
  inputs?: { arg: string; fromStep: string; output: string }[];
  /** Per-step artifacts (charts/files) — restored on reopen. */
  artifacts?: { kind: string; handle?: string; filename?: string; label?: string }[];
  /** Failure message — restored so failed steps keep their why. */
  error?: string;
}

/** Wire shape of a persisted plan record (assistant message JSON blob). */
export interface PersistedPlanRecord {
  type?: string;
  goal?: string | null;
  planKey?: string | null;
  steps?: PersistedPlanStep[];
  output?: string | null;
  artifacts?: { kind: string; handle?: string; filename?: string; label?: string }[];
  error?: string;
  /** Still in flight when last written — the run never reached a terminal
   *  event (app quit / crash). Renders as an interrupted (failed) run. */
  partial?: boolean;
}

/** Map a wire/persisted artifact list into the live SupervisorArtifact
 *  shape: JSON round-trips widen `kind` to string (cast back at the
 *  boundary), and the wire carries `string | null` where the UI shape uses
 *  `undefined` for absent fields. Normalize both here. */
export function hydrateArtifacts(
  list: { kind: string; handle?: string | null; filename?: string | null; label?: string | null }[] | undefined,
): SupervisorArtifact[] {
  return (list ?? []).map((a) => ({
    kind: a.kind as SupervisorArtifact["kind"],
    handle: a.handle ?? undefined,
    filename: a.filename ?? undefined,
    label: a.label ?? undefined,
  }));
}

/** Wire `PlanSummary` → the state's shape. The generator types serde
 *  `default` fields as optional; the serializer always emits them, so the
 *  state normalizes to concrete arrays. */
export function hydrateSummary(s: PlanSummary): PlanSummaryInfo {
  return { overview: s.overview, actions: s.actions ?? [], outputs: s.outputs ?? [] };
}

/** Normalize a persisted plan step into the live SupervisorStep shape.
 *  Non-terminal states never survive a restore — the run they belonged to is
 *  over, so `running`/`awaitingConfirmation` come back as `pending` (the
 *  restored rail must match the live-run rail field for field, with no step
 *  stuck "running" forever). */
export function hydrateStep(s: PersistedPlanStep): SupervisorStep {
  return {
    stepId: s.id,
    tool: s.tool,
    task: s.task ?? s.tool,
    state: (s.state === "completed" || s.state === "failed" || s.state === "skipped"
      ? s.state
      : "pending") as SupervisorStep["state"],
    dependsOn: s.dependsOn ?? [],
    inputs: s.inputs ?? [],
    output: s.output,
    artifacts: hydrateArtifacts(s.artifacts),
    error: s.error,
  };
}
