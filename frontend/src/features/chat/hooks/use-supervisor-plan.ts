import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { call, callWithEvents, respondSupervisorConfirmation } from "@/lib/api";
import { type StreamControl, streamOperation } from "@/lib/stream";
import type { UIMessage, UIMessagePart } from "@/lib/ai-types";
import { initialSupervisorState, parseReview, pruneReviewStep, supervisorReducer } from "./plan-reducer";
import type { SupervisorEvent, SupervisorPlanState, SupervisorStep } from "./supervisor-types";

// Re-export types so existing import paths (`@/features/chat/hooks/use-supervisor-plan`) keep working.
export type {
  SupervisorEvent,
  SupervisorStatus,
  SupervisorArtifact,
  SupervisorStep,
  PlanReview,
  PlanReviewStep,
  PriorPlanVersion,
  SupervisorPlanState,
} from "./supervisor-types";

interface RunPlanOptions {
  plan: unknown;
  sessionId: number;
  agentId?: string;
  /** The user's verbatim goal — the deliverable writer answers this, not
   *  the planner's rewritten plan.goal. */
  userGoal?: string;
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

export function useSupervisorPlan(callbacks?: SupervisorPlanCallbacks) {
  const [state, setState] = useState<SupervisorPlanState>(() => initialSupervisorState());
  const [messages, setMessages] = useState<UIMessage[]>([]);

  const streamCtrl = useRef<StreamControl | null>(null);
  const streamIdRef = useRef<string>("");
  const goalRef = useRef<string | null>(null);
  /** The user's verbatim goal — captured before the planner can rewrite it;
   *  rides execute_supervisor_plan as `userGoal` for the deliverable writer. */
  const userGoalRef = useRef<string | null>(null);
  const stepsRef = useRef<SupervisorStep[]>([]);
  /** True between Stop being clicked and the terminal event arriving — the
   *  backend cancels cooperatively (active steps finish first), so the panel
   *  must say "stopping", not "failed", until the stream ends. */
  const stoppingRef = useRef(false);
  // Resume: re-execute the LAST plan verbatim. Same plan JSON → same plan key
  // → the supervisor serves already-completed steps from its persisted
  // ExecutionMemo seed and only re-runs what failed or never ran.
  const lastPlanRef = useRef<{ plan: unknown; sessionId: number; agentId: string } | null>(null);

  // Keep stepsRef in sync with state.steps for persist snapshots.
  const dispatch = useCallback((event: SupervisorEvent) => {
    setState((prev) => {
      const next = supervisorReducer(prev, event);
      stepsRef.current = next.steps;
      if (event.type === "planStarted") goalRef.current = event.goal;
      return next;
    });
  }, []);

  const patch = useCallback((partial: Partial<SupervisorPlanState>) => {
    setState((prev) => {
      const next = { ...prev, ...partial };
      stepsRef.current = next.steps;
      return next;
    });
  }, []);

  const runPlan = useCallback(
    (options: RunPlanOptions) => {
      if (streamCtrl.current) return;
      lastPlanRef.current = {
        plan: options.plan,
        sessionId: options.sessionId,
        agentId: options.agentId ?? "",
      };
      const sessionId = options.sessionId;

      const streamId = crypto.randomUUID();
      streamIdRef.current = streamId;
      goalRef.current = null;
      userGoalRef.current = null;

      setState({
        ...initialSupervisorState(),
        status: "running",
        planVersion: 1,
      });
      stepsRef.current = [];
      stoppingRef.current = false;

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
          userGoal: options.userGoal,
          streamId,
        },
        {
          onEvent: (ev) => {
            // Terminal events need side-effect handling plus reducer.
            switch (ev.type) {
              case "planRevised": {
                // Snapshot the superseded plan's progress BEFORE re-seeding —
                // history then shows what v1 accomplished before the revision.
                const prior = stepsRef.current;
                persistPlanSnapshot(sessionId, goalRef.current, prior, {
                  output: null,
                  error: `superseded by revision #${ev.attempt}`,
                });
                dispatch(ev);
                break;
              }
              case "planCompleted": {
                streamCtrl.current = null;
                dispatch(ev);
                // Persist after reducer applied — read from next snapshot via ref.
                // Use timeout to read updated ref (synchronous dispatch already updated it).
                // Instead, persist using the current stepsRef which will be the OLD steps
                // before reducer's seed? For planCompleted we want current steps.
                // The reducer doesn't change steps on planCompleted, so stepsRef is still accurate.
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
                void call("generate_session_title", { sessionId })
                  .catch(() => {})
                  .finally(() => callbacks?.onTitleGenerated?.());
                break;
              }
              case "planFailed": {
                streamCtrl.current = null;
                dispatch(ev);
                parts = parts.map((p) =>
                  p.type === "text" && p.state === "streaming" ? { ...p, state: "done" as const } : p,
                );
                syncAssistant();
                persistPlanSnapshot(sessionId, goalRef.current, stepsRef.current, {
                  output: null,
                  error: ev.error,
                });
                callbacks?.onPlanFailed?.(goalRef.current, ev.error);
                break;
              }
              default: {
                if (ev.type === "planStarted") {
                  parts = [{ type: "text", text: `Goal: ${ev.goal}`, state: "streaming" as const }];
                  syncAssistant();
                }
                dispatch(ev);
                break;
              }
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            setState((prev) => {
              if (stoppingRef.current) {
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
    [dispatch, patch, callbacks],
  );

  const planAndRun = useCallback(
    async (goal: string, sessionId: number, agentId: string, userGoal?: string) => {
      const cleanGoal = userGoal ?? goal;
      const userMessage: UIMessage = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: cleanGoal, state: "done" as const }],
      };
      setMessages((prev) => [...prev, userMessage]);
      void persist(sessionId, "user", cleanGoal);

      patch({ planning: { round: 0, provider: "", searching: true, tools: [], queries: [] } });
      userGoalRef.current = cleanGoal;
      let plan: unknown;
      try {
        plan = await callWithEvents<unknown, SupervisorEvent>("plan_task", { goal, sessionId, agentId }, (ev) => {
          dispatch(ev);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch({ status: "failed", error: message, planning: null });
        void persist(sessionId, "assistant", `Plan error: ${message}`);
        callbacks?.onPlanFailed?.(cleanGoal, message);
        return;
      }
      const review = parseReview(plan, sessionId, agentId);
      if (review == null) {
        runPlan({ plan, sessionId, agentId, userGoal: goal });
        return;
      }
      patch({ status: "reviewing", review, error: null, planning: null });
    },
    [runPlan, patch, dispatch, callbacks],
  );

  /** Review gate: execute the plan exactly as reviewed. The goal rides the
   *  ref — it was captured at planAndRun, before the planner possibly rewrote
   *  plan.goal, and the deliverable must answer the USER's words. */
  const approvePlan = useCallback(() => {
    const review = state.review;
    if (!review || streamCtrl.current) return;
    runPlan({
      plan: review.plan,
      sessionId: review.sessionId,
      agentId: review.agentId,
      userGoal: userGoalRef.current ?? undefined,
    });
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
