import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { call, respondSupervisorConfirmation } from "@/lib/api";
import { type StreamControl, streamOperation } from "@/lib/stream";
import type { UIMessage, UIMessagePart } from "@/lib/ai-types";
import { gateTurn } from "@/features/billing/usage-billing";

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
      artifacts: { kind: string; handle?: string; filename?: string }[];
    }
  | { type: "stepFailed"; stepId: string; error: string }
  | { type: "stepSkipped"; stepId: string; reason: string }
  | { type: "planCompleted"; finalOutput?: string }
  | { type: "planFailed"; error: string };

export type SupervisorStatus = "idle" | "running" | "awaitingConfirmation" | "completed" | "failed";

export interface SupervisorArtifact {
  kind: "text" | "file" | "structured" | "handle";
  handle?: string;
  filename?: string;
}

export interface SupervisorStep {
  stepId: string;
  tool: string;
  task: string;
  dependsOn: string[];
  state: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  artifacts: SupervisorArtifact[];
}

export interface SupervisorPlanState {
  status: SupervisorStatus;
  goal: string | null;
  /** Full plan structure — seeded at planStarted, before any step runs. */
  steps: SupervisorStep[];
  pendingConfirmation: {
    streamId: string;
    stepId: string;
    task: string;
    description: string;
  } | null;
  finalOutput: string | null;
  error: string | null;
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

/** Persist one message to the session's SQLite history (best-effort). */
async function persist(sessionId: number, role: "user" | "assistant", content: string): Promise<void> {
  try {
    await call("append_chat_message", { sessionId, role, content });
  } catch {
    // History write failures must never break an executing plan.
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
}

export function useSupervisorPlan(callbacks?: SupervisorPlanCallbacks) {
  const [state, setState] = useState<SupervisorPlanState>({
    status: "idle",
    goal: null,
    steps: [],
    pendingConfirmation: null,
    finalOutput: null,
    error: null,
  });
  const [messages, setMessages] = useState<UIMessage[]>([]);

  const streamCtrl = useRef<StreamControl | null>(null);
  const streamIdRef = useRef<string>("");
  const goalRef = useRef<string | null>(null);
  const stepsRef = useRef<SupervisorStep[]>([]);

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
      const sessionId = options.sessionId;

      const streamId = crypto.randomUUID();
      streamIdRef.current = streamId;
      goalRef.current = null;

      setState({
        status: "running",
        goal: null,
        steps: [],
        pendingConfirmation: null,
        finalOutput: null,
        error: null,
      });
      stepsRef.current = [];

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
                stepsRef.current = ev.steps.map((s) => ({
                  stepId: s.id,
                  tool: s.tool,
                  task: s.task,
                  dependsOn: s.dependsOn,
                  state: "pending" as const,
                  artifacts: [],
                }));
                patch({
                  goal: ev.goal,
                  steps: stepsRef.current,
                });
                parts = [{ type: "text", text: `Goal: ${ev.goal}`, state: "streaming" as const }];
                syncAssistant();
                break;
              case "stepStarted":
                upsertStep(ev.stepId, { tool: ev.tool }, { state: "running" });
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
                    artifacts: ev.artifacts.map((a) => ({
                      kind: a.kind as SupervisorArtifact["kind"],
                      handle: a.handle,
                      filename: a.filename,
                    })),
                  },
                );
                break;
              case "stepFailed":
                upsertStep(ev.stepId, {}, { state: "failed", error: ev.error });
                break;
              case "stepSkipped":
                upsertStep(ev.stepId, {}, { state: "skipped", error: ev.reason });
                break;
              case "planCompleted": {
                patch({
                  status: "completed",
                  pendingConfirmation: null,
                  finalOutput: ev.finalOutput ?? null,
                });
                const record: PersistedPlan = {
                  type: "supervisor-plan",
                  v: 1,
                  goal: goalRef.current,
                  steps: stepsRef.current.map((s) => ({
                    id: s.stepId,
                    tool: s.tool,
                    state: s.state,
                    output: s.output,
                  })),
                  output: ev.finalOutput ?? null,
                };
                void persist(sessionId, "assistant", JSON.stringify(record));
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
                void persist(sessionId, "assistant", `Plan failed: ${ev.error}`);
                callbacks?.onPlanFailed?.(goalRef.current, ev.error);
                break;
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            setState((prev) =>
              prev.status === "running" || prev.status === "awaitingConfirmation"
                ? {
                    ...prev,
                    status: prev.status === "awaitingConfirmation" ? prev.status : "completed",
                    pendingConfirmation: null,
                  }
                : prev,
            );
          },
          onError: (err) => {
            streamCtrl.current = null;
            patch({
              status: "failed",
              pendingConfirmation: null,
              error: err.message,
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
      // User message first (display + history), then plan and execute.
      const userMessage: UIMessage = {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: goal, state: "done" as const }],
      };
      setMessages((prev) => [...prev, userMessage]);
      void persist(sessionId, "user", goal);

      // ── Interim billing gate (per-turn flat fee, honor system —
      //    features/billing/usage-billing.ts). Blokir hanya kalau saldo
      //    terkonfirmasi kurang; error infra = fail-open. ──
      const bill = await gateTurn();
      if (bill.insufficient) {
        patch({
          status: "failed",
          error:
            "Insufficient token credit — contact admin to top up " +
            "(interim billing: 0.05 USDT/turn).",
        });
        void persist(sessionId, "assistant", "Turn blocked: insufficient balance.");
        return;
      }

      const plan = await createSupervisorPlan(goal, sessionId, agentId);
      runPlan({ plan, sessionId, agentId });
    },
    [runPlan, patch],
  );

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
    streamCtrl.current?.cancel();
    streamCtrl.current = null;
    patch({ status: "failed", pendingConfirmation: null, error: "cancelled" });
  }, [patch]);

  const clearMessages = useCallback(() => setMessages([]), []);

  return {
    ...state,
    messages,
    clearMessages,
    runPlan,
    planAndRun,
    approve: () => respond(true),
    reject: () => respond(false),
    stop,
  };
}
