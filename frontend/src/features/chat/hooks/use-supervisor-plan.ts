import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { call, callWithEvents, respondSupervisorConfirmation } from "@/lib/api";
import { type StreamControl, streamOperation } from "@/lib/stream";
import type { UIMessage, UIMessagePart } from "@/lib/ai-types";

/** Events streamed by `execute_supervisor_plan` (mirrors the Rust enum). */
export type SupervisorEvent =
  | {
      type: "planStarted";
      goal: string;
      stepCount: number;
      steps: { id: string; tool: string; task: string; dependsOn: string[] }[];
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
  | { type: "planRevising"; failedStepIds: string[]; attempt: number }
  | {
      type: "planRevised";
      attempt: number;
      stepCount: number;
      steps: { id: string; tool: string; task: string; dependsOn: string[] }[];
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
  planning: { round: number; provider: string; searching: boolean; tools: string[] } | null;
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
  /** Superseded plan versions, oldest first. */
  priorVersions: PriorPlanVersion[];
  /** True when the replan budget is spent — failure then offers "new plan". */
  replansExhausted: boolean;
}

interface RunPlanOptions {
  plan: unknown;
  sessionId: number;
  agentId?: string;
}

export interface SupervisorPlanCallbacks {
  onPlanCompleted?: (goal: string | null, output: string | null) => void;
  onPlanFailed?: (goal: string | null, error: string) => void;
  /** Called after a title has been generated (fire-and-forget) so the UI can
   *  reload the session list. */
  onTitleGenerated?: () => void;
}

export async function createSupervisorPlan(goal: string, sessionId: number, agentId: string): Promise<unknown> {
  return call("plan_task", { goal, sessionId, agentId });
}
// NOTE: the live path (`planAndRun`) uses `callWithEvents` instead — planning
// progress rides a Channel alongside the resolved plan. `createSupervisorPlan`
// stays for callers that only want the plan.

/** Persist one message to the session's SQLite history (best-effort). */
function sanitizeForIpc(s: string | null): string | null {
  if (!s) return s;
  // Tauri IPC serializes invoke args as JSON: control characters and
  // unpaired surrogates (PDF extraction can emit both) make the Rust side
  // reject the command, silently losing the write.
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

async function persist(sessionId: number, role: "user" | "assistant", rawContent: string): Promise<void> {
  const content = sanitizeForIpc(rawContent) ?? rawContent;
  try {
    await call("append_chat_message", { sessionId, role, content });
  } catch (err) {
    // History write failures must never break an executing plan — but they
    // must be visible; a silent rejection here loses the whole turn record.
    console.error("[supervisor] persist failed:", err);
  }
}

/** Structured plan record persisted as the assistant message content so a
 *  reopened session replays the plan, not just prose. Parsed by
 *  `historyToMessages` (chat-helpers). */
export interface PersistedPlan {
  type: "supervisor-plan";
  v: 1;
  goal: string | null;
  steps: { id: string; tool: string; state: SupervisorStep["state"]; output?: string }[];
  output: string | null;
  /** Present on failed-plan records — the terminal error. */
  error?: string;
}

/** Seed the tracked plan structure from planStarted/planRevised wire steps —
 *  every step starts pending with no artifacts. */
function seedSteps(steps: { id: string; tool: string; task: string; dependsOn: string[] }[]): SupervisorStep[] {
  return steps.map((s) => ({
    stepId: s.id,
    tool: s.tool,
    task: s.task,
    dependsOn: s.dependsOn,
    state: "pending" as const,
    artifacts: [],
  }));
}

/** Persist the structured plan record (goal + per-step states). Embedded
 *  outputs are capped — full results live in the plan progress panel /
 *  artifacts, not in chat history. */
function persistPlanSnapshot(
  sessionId: number,
  goal: string | null,
  steps: SupervisorStep[],
  extra: { output: string | null; error?: string },
): void {
  const record: PersistedPlan = {
    type: "supervisor-plan",
    v: 1,
    goal,
    steps: steps.map((s) => ({
      id: s.stepId,
      tool: s.tool,
      state: s.state,
      output: s.output ? s.output.slice(0, 500) : s.output,
    })),
    output: extra.output,
    error: extra.error,
  };
  void persist(sessionId, "assistant", JSON.stringify(record));
}

/** Parse a validated `plan_task` result into the review model. Steps the
 *  supervisor cannot dispatch are filtered exactly like the composition root
 *  filters them from the executing registry. */
const NON_DISPATCHABLE_REVIEW_TOOLS: string[] = [];
function parseReview(plan: unknown, sessionId: number, agentId: string): PlanReview | null {
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
  const steps: PlanReviewStep[] = [];
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
  return { plan, goal: p.goal, steps, sessionId, agentId };
}

/** Remove a step from the review model — steps that (transitively) depended
 *  on it are pruned too: the scheduler would skip them anyway (dependency on
 *  a non-completed step), so removing keeps the reviewed contract honest. */
function pruneReviewStep(review: PlanReview, stepId: string): PlanReview {
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

export function useSupervisorPlan(callbacks?: SupervisorPlanCallbacks) {
  const [state, setState] = useState<SupervisorPlanState>({
    status: "idle",
    goal: null,
    steps: [],
    planning: null,
    pendingConfirmation: null,
    finalOutput: null,
    error: null,
    review: null,
    planVersion: 0,
    priorVersions: [],
    replansExhausted: false,
  });
  const [messages, setMessages] = useState<UIMessage[]>([]);

  const streamCtrl = useRef<StreamControl | null>(null);
  const streamIdRef = useRef<string>("");
  const goalRef = useRef<string | null>(null);
  const stepsRef = useRef<SupervisorStep[]>([]);
  /** True between Stop being clicked and the terminal event arriving — the
   *  backend cancels cooperatively (active steps finish first), so the panel
   *  must say "stopping", not "failed", until the stream ends. */
  const stoppingRef = useRef(false);
  const planVersionRef = useRef(0);
  const replansUsedRef = useRef(0);
  const priorVersionsRef = useRef<PriorPlanVersion[]>([]);
  // Resume: re-execute the LAST plan verbatim. Same plan JSON → same plan key
  // → the supervisor serves already-completed steps from its persisted
  // ExecutionMemo seed and only re-runs what failed or never ran.
  const lastPlanRef = useRef<{ plan: unknown; sessionId: number; agentId: string } | null>(null);

  const patch = useCallback((partial: Partial<SupervisorPlanState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const upsertStep = useCallback((stepId: string, seed: Partial<SupervisorStep>, next: Partial<SupervisorStep>) => {
    setState((prev) => {
      const steps = [...prev.steps];
      const idx = steps.findIndex((s) => s.stepId === stepId);
      if (idx >= 0) {
        steps[idx] = { ...steps[idx], ...seed, ...next };
      } else {
        steps.push({
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
      stepsRef.current = steps;
      return { ...prev, steps };
    });
  }, []);

  const runPlan = useCallback(
    (options: RunPlanOptions) => {
      if (streamCtrl.current) return;
      // Remember the plan for `resume()` — same plan JSON → same plan key →
      // completed steps are skipped via the persisted step cache.
      lastPlanRef.current = {
        plan: options.plan,
        sessionId: options.sessionId,
        agentId: options.agentId ?? "",
      };
      const sessionId = options.sessionId;

      const streamId = crypto.randomUUID();
      streamIdRef.current = streamId;
      goalRef.current = null;

      setState({
        status: "running",
        goal: null,
        steps: [],
        planning: null,
        pendingConfirmation: null,
        finalOutput: null,
        error: null,
        review: null,
        planVersion: 1,
        priorVersions: [],
        replansExhausted: false,
      });
      stepsRef.current = [];
      stoppingRef.current = false;
      planVersionRef.current = 1;
      replansUsedRef.current = 0;
      priorVersionsRef.current = [];

      // The plan state above is the source of truth and renders through
      // PlanProgressPanel; the conversation carries only the goal and the
      // final output — steps are NOT projected into chat tool parts.
      const assistantId = nanoid();
      let parts: UIMessagePart[] = [];
      const syncAssistant = () => {
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === assistantId);
          const message: UIMessage = {
            id: assistantId,
            role: "assistant",
            parts: [...parts],
          };
          return exists ? prev.map((m) => (m.id === assistantId ? message : m)) : [...prev, message];
        });
      };
      streamCtrl.current = streamOperation<SupervisorEvent>(
        "execute_supervisor_plan",
        {
          plan: options.plan,
          sessionId,
          agentId: options.agentId,
          streamId,
        },
        {
          onEvent: (ev) => {
            switch (ev.type) {
              case "planStarted":
                goalRef.current = ev.goal;
                stepsRef.current = seedSteps(ev.steps);
                patch({
                  goal: ev.goal,
                  steps: stepsRef.current,
                });
                parts = [{ type: "text", text: `Goal: ${ev.goal}`, state: "streaming" as const }];
                syncAssistant();
                break;
              case "stepStarted":
                upsertStep(ev.stepId, { tool: ev.tool }, { state: "running", startedAt: Date.now() });
                break;
              case "confirmationRequested":
                upsertStep(ev.stepId, { task: ev.task }, { state: "running" });
                patch({
                  status: "awaitingConfirmation",
                  pendingConfirmation: {
                    streamId: ev.streamId,
                    stepId: ev.stepId,
                    task: ev.task,
                    description: ev.description,
                  },
                });
                break;
              case "stepCompleted":
                upsertStep(
                  ev.stepId,
                  {},
                  {
                    state: "completed",
                    output: ev.output,
                    retriesUsed: ev.retries_used,
                    artifacts: ev.artifacts.map((a) => ({
                      kind: a.kind as SupervisorArtifact["kind"],
                      handle: a.handle,
                      filename: a.filename,
                      label: a.label,
                    })),
                  },
                );
                break;
              case "stepFailed":
                upsertStep(ev.stepId, {}, { state: "failed", error: ev.error, errorKind: ev.kind });
                break;
              case "stepSkipped":
                upsertStep(ev.stepId, {}, { state: "skipped", error: ev.reason });
                break;
              case "planRevising":
                // The supervisor is asking the planner for a revised plan —
                // execution state stays "running"; the failed steps already
                // carry their failed state from stepFailed events.
                patch({ status: "running", pendingConfirmation: null });
                break;
              case "planRevised": {
                // Snapshot the superseded plan's progress BEFORE re-seeding —
                // history then shows what v1 accomplished before the revision.
                const prior = stepsRef.current;
                const priorCompleted = prior.filter((s) => s.state === "completed").length;
                const priorVersion = planVersionRef.current;
                persistPlanSnapshot(sessionId, goalRef.current, prior, {
                  output: null,
                  error: `superseded by revision #${ev.attempt}`,
                });
                // New plan structure replaces the old one — re-seed all steps
                // as pending (same shape as planStarted). Conversation keeps
                // the same goal; only the remaining work is re-planned.
                stepsRef.current = seedSteps(ev.steps);
                planVersionRef.current = priorVersion + 1;
                replansUsedRef.current += 1;
                priorVersionsRef.current = [
                  ...priorVersionsRef.current,
                  {
                    version: priorVersion,
                    completed: priorCompleted,
                    total: prior.length,
                    note: `revised after failure`,
                  },
                ];
                patch({
                  status: "running",
                  steps: stepsRef.current,
                  error: null,
                  planVersion: planVersionRef.current,
                  priorVersions: priorVersionsRef.current,
                  replansExhausted: replansUsedRef.current >= 1,
                });
                break;
              }
              case "planCompleted": {
                patch({
                  status: "completed",
                  pendingConfirmation: null,
                  finalOutput: ev.finalOutput ?? null,
                });
                persistPlanSnapshot(sessionId, goalRef.current, stepsRef.current, {
                  output: ev.finalOutput ?? null,
                });
                parts = parts.map((p) =>
                  p.type === "text" && p.state === "streaming" ? { ...p, state: "done" as const } : p,
                );
                if (ev.finalOutput) {
                  parts = [...parts, { type: "text", text: ev.finalOutput, state: "done" as const }];
                }
                syncAssistant();
                callbacks?.onPlanCompleted?.(goalRef.current, ev.finalOutput ?? null);
                // Fire-and-forget: generate a concise title via Cloudflare Workers AI
                // while the UI is already showing the completed result.
                void call("generate_session_title", { sessionId })
                  .catch(() => {})
                  .finally(() => callbacks?.onTitleGenerated?.());
                break;
              }
              case "planFailed":
                patch({
                  status: "failed",
                  pendingConfirmation: null,
                  error: ev.error,
                });
                parts = parts.map((p) =>
                  p.type === "text" && p.state === "streaming" ? { ...p, state: "done" as const } : p,
                );
                syncAssistant();
                // Persist the FULL structured record (per-step states), not
                // just prose — a failed plan must replay with its step states
                // intact for diagnosis and future resume.
                persistPlanSnapshot(sessionId, goalRef.current, stepsRef.current, {
                  output: null,
                  error: ev.error,
                });
                callbacks?.onPlanFailed?.(goalRef.current, ev.error);
                break;
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            setState((prev) => {
              if (stoppingRef.current) {
                // Cancel resolved without a terminal event (e.g. the web
                // transport aborts the connection) — the stop is final.
                stoppingRef.current = false;
                return { ...prev, status: "failed", error: "Plan stopped.", pendingConfirmation: null };
              }
              return prev.status === "running" || prev.status === "awaitingConfirmation"
                ? {
                    ...prev,
                    status: prev.status === "awaitingConfirmation" ? prev.status : "completed",
                    pendingConfirmation: null,
                  }
                : prev;
            });
          },
          onError: (err) => {
            streamCtrl.current = null;
            const wasStopping = stoppingRef.current;
            stoppingRef.current = false;
            patch({
              status: "failed",
              pendingConfirmation: null,
              error: wasStopping ? "Plan stopped." : err.message,
            });
            void persist(sessionId, "assistant", `Plan error: ${err.message}`);
          },
        },
        streamId,
      );
    },
    [patch, upsertStep, callbacks],
  );

  const planAndRun = useCallback(
    async (goal: string, sessionId: number, agentId: string) => {
      // User message first (display + history), then plan. Execution waits
      // for the review gate — the user runs, prunes, or cancels the plan.
      const userMessage: UIMessage = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: goal, state: "done" as const }],
      };
      setMessages((prev) => [...prev, userMessage]);
      void persist(sessionId, "user", goal);

      // A plan_task rejection must surface like any other failure — an
      // unhandled rejection here silently eats the whole turn. Planning
      // rounds stream live over a Channel while the plan resolves. The
      // optimistic seed below shows motion INSTANTLY — before the IPC even
      // lands, the context build + first LLM round can stay quiet for a while.
      patch({ planning: { round: 0, provider: "", searching: true, tools: [] } });
      let plan: unknown;
      try {
        plan = await callWithEvents<unknown, SupervisorEvent>(
          "plan_task",
          { goal, sessionId, agentId },
          (ev) => {
            if (ev.type === "planningStarted" || ev.type === "planningRound") {
              setState((prev) => ({
                ...prev,
                planning: {
                  round: ev.type === "planningRound" ? ev.round : 1,
                  provider: ev.type === "planningRound" ? ev.provider : "",
                  searching:
                    ev.type === "planningRound" ? ev.searching : (prev.planning?.searching ?? true),
                  tools: prev.planning?.tools ?? [],
                },
              }));
            } else if (ev.type === "planningToolSearch") {
              setState((prev) => ({
                ...prev,
                planning: {
                  round: prev.planning?.round ?? 0,
                  provider: prev.planning?.provider ?? "",
                  searching: true,
                  tools: ev.tools,
                },
              }));
            }
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch({ status: "failed", error: message, planning: null });
        void persist(sessionId, "assistant", `Plan error: ${message}`);
        callbacks?.onPlanFailed?.(goal, message);
        return;
      }
      const review = parseReview(plan, sessionId, agentId);
      if (review == null) {
        // Unparseable plan — do not gate; execute as before (the backend
        // validation is the authority, the review model is a courtesy).
        runPlan({ plan, sessionId, agentId });
        return;
      }
      patch({ status: "reviewing", review, error: null, planning: null });
    },
    [runPlan, patch, callbacks],
  );

  /** Review gate: execute the plan exactly as reviewed. */
  const approvePlan = useCallback(() => {
    const review = state.review;
    if (!review || streamCtrl.current) return;
    runPlan({ plan: review.plan, sessionId: review.sessionId, agentId: review.agentId });
  }, [runPlan, state.review]);

  /** Review gate: discard the plan without executing anything. */
  const cancelPlan = useCallback(() => {
    patch({ status: "idle", review: null, error: null });
  }, [patch]);

  /** Review gate: remove one step — transitively dependent steps are pruned
   *  with it (they could never run once their source is gone). */
  const removeStep = useCallback((stepId: string) => {
    setState((prev) => (prev.review ? { ...prev, review: pruneReviewStep(prev.review, stepId) } : prev));
  }, []);

  const respond = useCallback(
    async (approved: boolean) => {
      const current = state.pendingConfirmation;
      if (!current) return;
      await respondSupervisorConfirmation(streamIdRef.current, current.stepId, approved);
      patch({ pendingConfirmation: null, status: "running" });
    },
    [patch, state.pendingConfirmation],
  );

  const stop = useCallback(() => {
    const ctrl = streamCtrl.current;
    if (!ctrl) return;
    // Cooperative cancellation: the backend finishes active steps and starts
    // no new wave. Stay "stopping" until the terminal event arrives — never
    // claim the plan is dead while steps are still running.
    stoppingRef.current = true;
    ctrl.cancel();
    streamCtrl.current = null;
    patch({ status: "stopping", pendingConfirmation: null });
  }, [patch]);

  const clearMessages = useCallback(() => setMessages([]), []);

  const resume = useCallback(() => {
    const last = lastPlanRef.current;
    if (!last || streamCtrl.current) return;
    runPlan({ plan: last.plan, sessionId: last.sessionId, agentId: last.agentId });
  }, [runPlan]);

  return {
    ...state,
    messages,
    clearMessages,
    runPlan,
    planAndRun,
    resume,
    approvePlan,
    cancelPlan,
    removeStep,
    approve: () => respond(true),
    reject: () => respond(false),
    stop,
  };
}
