/** Shared supervisor types — single source for both the reducer and the hook.
 *  No runtime code here, so no circular-import risk. */

export type SupervisorEvent =
  | {
      type: "planStarted";
      goal: string;
      stepCount: number;
      steps: { id: string; tool: string; task: string; dependsOn: string[] }[];
      /** Hash of the executed plan — read key for supervisor_step_output. */
      planKey: string;
    }
  | { type: "stepStarted"; stepId: string; tool: string }
  | {
      type: "confirmationRequested";
      streamId: string;
      stepId: string;
      task: string;
      description: string;
    }
  | {
      type: "stepCompleted";
      stepId: string;
      output: string;
      artifacts: { kind: string; handle?: string; filename?: string; label?: string }[];
      /** Retries the scheduler spent before this step completed. */
      retries_used: number;
    }
  | {
      type: "stepFailed";
      stepId: string;
      error: string;
      /** Failure class from the scheduler: timeout | confirmation | cancelled | tool */
      kind: string;
    }
  | { type: "stepSkipped"; stepId: string; reason: string }
  | {
      /** Emitted once when `plan_task` starts — instant acknowledgment. */
      type: "planningStarted";
    }
  | {
      /** Emitted per planner LLM round while `plan_task` runs — twice per
       *  round: on open (provider empty) and on completion. */
      type: "planningRound";
      round: number;
      provider: string;
      searching: boolean;
    }
  | {
      /** Tool names a planning search round surfaced for the first time. */
      type: "planningToolSearch";
      queries: string[];
      tools: string[];
    }
  | {
      /** Throttled trailing slice of the planner LLM's reasoning — live
       *  motion inside a round (one round can stream for minutes). */
      type: "planningActivity";
      text: string;
    }
  | { type: "planRevising"; failedStepIds: string[]; attempt: number }
  | {
      type: "planRevised";
      attempt: number;
      stepCount: number;
      steps: { id: string; tool: string; task: string; dependsOn: string[] }[];
      /** Key of the REVISED plan — replaces the planStarted key. */
      planKey: string;
    }
  | { type: "planCompleted"; finalOutput?: string }
  | { type: "planFailed"; error: string };

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
}

/** One step of a plan awaiting user review (before execution). Wire shape
 *  mirrors the camelCase TaskStep serialization from `plan_task`. */
export interface PlanReviewStep {
  id: string;
  tool: string;
  task: string;
  dependsOn: string[];
  requiresConfirmation: boolean;
}

export interface PlanReview {
  plan: unknown;
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

export interface SupervisorPlanState {
  status: SupervisorStatus;
  goal: string | null;
  /** Full plan structure — seeded at planStarted, before any step runs. */
  steps: SupervisorStep[];
  /** Live planning progress — non-null only while `plan_task` is in flight. */
  planning: {
    round: number;
    provider: string;
    searching: boolean;
    tools: string[];
    /** Trailing slice of the planner's reasoning (planningActivity). */
    activity?: string;
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
}
