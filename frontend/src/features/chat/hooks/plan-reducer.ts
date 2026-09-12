/** Pure event-fold reducer for the supervisor plan — the first actually testable hook.
 *
 *  All SupervisorEvent → SupervisorPlanState transitions live here as pure
 *  functions. The hook (`use-supervisor-plan.ts`) only wires I/O (persist,
 *  streaming, callbacks) around this reducer. This file has ZERO React imports
 *  and ZERO side effects, so it can be unit-tested without a renderer.
 */

import type { SupervisorArtifact, SupervisorEvent, SupervisorPlanState, SupervisorStep } from "./supervisor-types";

export type {
  SupervisorEvent,
  SupervisorStatus,
  SupervisorStep,
  SupervisorArtifact,
  PlanReview,
  PlanReviewStep,
  PriorPlanVersion,
  SupervisorPlanState,
} from "./supervisor-types";

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Seed the tracked plan structure from planStarted/planRevised wire steps —
 *  every step starts pending with no artifacts. */
export function seedSteps(steps: { id: string; tool: string; task: string; dependsOn: string[] }[]): SupervisorStep[] {
  return steps.map((s) => ({
    stepId: s.id,
    tool: s.tool,
    task: s.task,
    dependsOn: s.dependsOn,
    state: "pending" as const,
    artifacts: [],
  }));
}

/** Parse a validated `plan_task` result into the review model. Steps the
 *  supervisor cannot dispatch are filtered exactly like the composition root
 *  filters them from the executing registry. Must stay in sync with
 *  `supervisor::NON_DISPATCHABLE_TOOLS`. */
const NON_DISPATCHABLE_REVIEW_TOOLS: string[] = [
  "deep_write",
  "draft_document",
  "plan_task",
  "plan_revise",
  "artifact_recall",
];

export interface PlanReviewInput {
  plan: unknown;
  sessionId: number;
  agentId: string;
}

export function parseReview(plan: unknown, sessionId: number, agentId: string) {
  if (typeof plan !== "object" || plan == null) return null;
  const p = plan as {
    goal?: unknown;
    steps?: {
      id?: unknown;
      tool?: unknown;
      task?: unknown;
      dependsOn?: unknown;
      requiresConfirmation?: unknown;
    }[];
  };
  if (typeof p.goal !== "string" || !Array.isArray(p.steps)) return null;
  const steps: import("./supervisor-types").PlanReviewStep[] = [];
  for (const s of p.steps) {
    if (typeof s.id !== "string") continue;
    if (typeof s.tool === "string" && NON_DISPATCHABLE_REVIEW_TOOLS.includes(s.tool)) continue;
    steps.push({
      id: s.id,
      tool: typeof s.tool === "string" ? s.tool : "",
      task: typeof s.task === "string" ? s.task : "",
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === "string") : [],
      requiresConfirmation: s.requiresConfirmation === true,
    });
  }
  if (steps.length === 0) return null;
  return { plan, goal: p.goal, steps, sessionId, agentId } as import("./supervisor-types").PlanReview;
}

/** Remove a step from the review model — steps that (transitively) depended
 *  on it are pruned too: the scheduler would skip them anyway (dependency on
 *  a non-completed step), so removing keeps the reviewed contract honest. */
export function pruneReviewStep(
  review: import("./supervisor-types").PlanReview,
  stepId: string,
): import("./supervisor-types").PlanReview {
  const doomed = new Set<string>([stepId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of review.steps) {
      if (doomed.has(s.id)) continue;
      if (s.dependsOn.some((d) => doomed.has(d))) {
        doomed.add(s.id);
        grew = true;
      }
    }
  }
  const steps = review.steps.filter((s) => !doomed.has(s.id));
  const plan =
    typeof review.plan === "object" && review.plan != null
      ? {
          ...review.plan,
          steps: (review.plan as { steps?: unknown[] }).steps?.filter(
            (s) => typeof s === "object" && s != null && !doomed.has((s as { id?: unknown }).id as string),
          ),
        }
      : review.plan;
  return { ...review, steps, plan };
}

// ── Initial state ───────────────────────────────────────────────────────────

export function initialSupervisorState(): SupervisorPlanState {
  return {
    status: "idle",
    goal: null,
    steps: [],
    planning: null,
    planStartedAt: null,
    planCompletedAt: null,
    pendingConfirmation: null,
    finalOutput: null,
    error: null,
    review: null,
    planVersion: 0,
    planKey: null,
    priorVersions: [],
    replansExhausted: false,
  };
}

// ── Pure upsert ─────────────────────────────────────────────────────────────

function upsertStepPure(
  steps: SupervisorStep[],
  stepId: string,
  seed: Partial<SupervisorStep>,
  next: Partial<SupervisorStep>,
): SupervisorStep[] {
  const copy = [...steps];
  const idx = copy.findIndex((s) => s.stepId === stepId);
  if (idx >= 0) {
    copy[idx] = { ...copy[idx], ...seed, ...next };
  } else {
    copy.push({
      stepId,
      tool: "",
      task: "",
      dependsOn: [],
      state: "running",
      artifacts: [],
      ...seed,
      ...next,
    });
  }
  return copy;
}

// ── Pure reducer ────────────────────────────────────────────────────────────

/** Options for deterministic testing — `now` defaults to Date.now(). */
export interface ReducerOptions {
  now?: number;
}

/** Pure fold: SupervisorPlanState × SupervisorEvent → SupervisorPlanState.
 *  No I/O, no refs, no callbacks — just state. */
export function supervisorReducer(
  state: SupervisorPlanState,
  event: SupervisorEvent,
  opts: ReducerOptions = {},
): SupervisorPlanState {
  const now = opts.now ?? Date.now();
  switch (event.type) {
    case "planStarted": {
      const steps = seedSteps(event.steps);
      return {
        ...state,
        goal: event.goal,
        steps,
        planStartedAt: now,
        planCompletedAt: null,
        planKey: event.planKey,
      };
    }
    case "stepStarted": {
      const steps = upsertStepPure(
        state.steps,
        event.stepId,
        { tool: event.tool },
        { state: "running", startedAt: now },
      );
      return { ...state, steps };
    }
    case "confirmationRequested": {
      const steps = upsertStepPure(state.steps, event.stepId, { task: event.task }, { state: "running" });
      return {
        ...state,
        steps,
        status: "awaitingConfirmation",
        pendingConfirmation: {
          streamId: event.streamId,
          stepId: event.stepId,
          task: event.task,
          description: event.description,
        },
      };
    }
    case "stepCompleted": {
      const steps = upsertStepPure(
        state.steps,
        event.stepId,
        {},
        {
          state: "completed",
          output: event.output,
          retriesUsed: event.retries_used,
          finishedAt: now,
          artifacts: event.artifacts.map((a) => ({
            kind: a.kind as SupervisorArtifact["kind"],
            handle: a.handle,
            filename: a.filename,
            label: a.label,
          })),
        },
      );
      return { ...state, steps };
    }
    case "stepFailed": {
      const steps = upsertStepPure(
        state.steps,
        event.stepId,
        {},
        { state: "failed", error: event.error, errorKind: event.kind, finishedAt: now },
      );
      return { ...state, steps };
    }
    case "stepSkipped": {
      const steps = upsertStepPure(state.steps, event.stepId, {}, { state: "skipped", error: event.reason });
      return { ...state, steps };
    }
    case "planRevising": {
      return { ...state, status: "running", pendingConfirmation: null };
    }
    case "planRevised": {
      const priorCompleted = state.steps.filter((s) => s.state === "completed").length;
      const priorVersion = state.planVersion;
      const priorVersions = [
        ...state.priorVersions,
        {
          version: priorVersion,
          completed: priorCompleted,
          total: state.steps.length,
          note: `revised after failure`,
        },
      ];
      const steps = seedSteps(event.steps);
      return {
        ...state,
        status: "running",
        steps,
        error: null,
        planVersion: priorVersion + 1,
        planKey: event.planKey,
        priorVersions,
        replansExhausted: priorVersions.length >= 1,
      };
    }
    case "planCompleted": {
      return {
        ...state,
        status: "completed",
        pendingConfirmation: null,
        finalOutput: event.finalOutput ?? null,
        planCompletedAt: now,
      };
    }
    case "planFailed": {
      return {
        ...state,
        status: "failed",
        pendingConfirmation: null,
        error: event.error,
        planCompletedAt: now,
      };
    }
    // ── planning progress (plan_task) ───────────────────────────────────────
    case "planningStarted": {
      return {
        ...state,
        planning: {
          round: 1,
          provider: "",
          searching: true,
          tools: [],
          queries: [],
        },
      };
    }
    case "planningRound": {
      return {
        ...state,
        planning: {
          round: event.round,
          provider: event.provider,
          searching: event.searching,
          tools: state.planning?.tools ?? [],
          queries: state.planning?.queries ?? [],
          activity: state.planning?.activity,
          context: state.planning?.context,
        },
      };
    }
    case "planningToolSearch": {
      return {
        ...state,
        planning: {
          round: state.planning?.round ?? 0,
          provider: state.planning?.provider ?? "",
          searching: true,
          tools: event.tools,
          queries: event.queries.length > 0 ? event.queries : (state.planning?.queries ?? []),
          activity: state.planning?.activity,
          context: state.planning?.context,
        },
      };
    }
    case "planningActivity": {
      if (!state.planning) return state;
      return {
        ...state,
        planning: { ...state.planning, activity: event.text },
      };
    }
    case "planningContext": {
      if (!state.planning) return state;
      return {
        ...state,
        planning: {
          ...state.planning,
          context: {
            persona: event.persona,
            memories: event.memories,
            skills: event.skills,
            files: event.files,
          },
        },
      };
    }
    // planRevising already handled; fallback identity
    default:
      return state;
  }
}

/** Apply a partial patch via the reducer — for non-event transitions
 *  (initial run reset, review gate, cancel, etc.). Kept here so tests can
 *  assert the initial/reset shape matches the reducer's contract. */
export function supervisorPatch(
  state: SupervisorPlanState,
  partial: Partial<SupervisorPlanState>,
): SupervisorPlanState {
  return { ...state, ...partial };
}
