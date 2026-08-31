import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { call, respondSupervisorConfirmation } from "@/lib/api";
import { type StreamControl, streamOperation } from "@/lib/stream";
import type { UIMessage, UIMessagePart } from "@/lib/ai-types";

/** Events streamed by `execute_supervisor_plan` (mirrors the Rust enum). */
export type SupervisorEvent =
  | { type: "planStarted"; goal: string; stepCount: number }
  | { type: "stepStarted"; stepId: string; tool: string }
  | {
      type: "confirmationRequested";
      streamId: string;
      stepId: string;
      task: string;
      description: string;
    }
  | { type: "stepCompleted"; stepId: string; output: string }
  | { type: "stepFailed"; stepId: string; error: string }
  | { type: "stepSkipped"; stepId: string; reason: string }
  | { type: "planCompleted"; finalOutput?: string }
  | { type: "planFailed"; error: string };

export type SupervisorStatus = "idle" | "running" | "awaitingConfirmation" | "completed" | "failed";

export interface SupervisorStep {
  stepId: string;
  tool: string;
  state: "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
}

export interface SupervisorPlanState {
  status: SupervisorStatus;
  goal: string | null;
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

export function useSupervisorPlan() {
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

  const patch = useCallback((partial: Partial<SupervisorPlanState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const upsertStep = useCallback((stepId: string, tool: string, next: Partial<SupervisorStep>) => {
    setState((prev) => {
      const steps = [...prev.steps];
      const idx = steps.findIndex((s) => s.stepId === stepId);
      if (idx >= 0) {
        steps[idx] = { ...steps[idx], ...next };
      } else {
        steps.push({ stepId, tool, state: "running", ...next });
      }
      return { ...prev, steps };
    });
  }, []);

  const runPlan = useCallback(
    (options: RunPlanOptions) => {
      if (streamCtrl.current) return;
      const sessionId = options.sessionId;

      const streamId = crypto.randomUUID();
      streamIdRef.current = streamId;

      setState({
        status: "running",
        goal: null,
        steps: [],
        pendingConfirmation: null,
        finalOutput: null,
        error: null,
      });

      // Conversation view: one growing assistant message carries the plan
      // (text + one tool part per step), like the agent-chat rendering model.
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
      const stepToolId = (stepId: string) => `step-${stepId}`;

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
                patch({ goal: ev.goal });
                parts = [{ type: "text", text: `Goal: ${ev.goal}`, state: "streaming" as const }];
                syncAssistant();
                break;
              case "stepStarted":
                upsertStep(ev.stepId, ev.tool, { state: "running" });
                parts = [
                  ...parts.filter((p) => !("toolCallId" in p && p.toolCallId === stepToolId(ev.stepId))),
                  {
                    type: `tool-${ev.tool || "step"}`,
                    toolCallId: stepToolId(ev.stepId),
                    state: "input-available" as const,
                    input: { step: ev.stepId },
                  } as UIMessagePart,
                ];
                syncAssistant();
                break;
              case "confirmationRequested":
                upsertStep(ev.stepId, "", { state: "running" });
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
                upsertStep(ev.stepId, "", {
                  state: "completed",
                  output: ev.output,
                });
                parts = parts.map((p) =>
                  "toolCallId" in p && p.toolCallId === stepToolId(ev.stepId)
                    ? {
                        ...p,
                        state: "output-available" as const,
                        output: { ok: true, summary: ev.output.slice(0, 2000) },
                      }
                    : p,
                );
                syncAssistant();
                break;
              case "stepFailed":
                upsertStep(ev.stepId, "", {
                  state: "failed",
                  error: ev.error,
                });
                parts = parts.map((p) =>
                  "toolCallId" in p && p.toolCallId === stepToolId(ev.stepId)
                    ? {
                        ...p,
                        state: "output-error" as const,
                        errorText: ev.error,
                      }
                    : p,
                );
                syncAssistant();
                break;
              case "stepSkipped":
                upsertStep(ev.stepId, "", {
                  state: "skipped",
                  error: ev.reason,
                });
                break;
              case "planCompleted":
                patch({
                  status: "completed",
                  pendingConfirmation: null,
                  finalOutput: ev.finalOutput ?? null,
                });
                parts = parts.map((p) =>
                  p.type === "text" && p.state === "streaming" ? { ...p, state: "done" as const } : p,
                );
                if (ev.finalOutput) {
                  parts = [...parts, { type: "text", text: ev.finalOutput, state: "done" as const }];
                }
                syncAssistant();
                void persist(sessionId, "assistant", ev.finalOutput ?? "(plan completed)");
                break;
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
    [patch, upsertStep],
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

      const plan = await createSupervisorPlan(goal, sessionId, agentId);
      runPlan({ plan, sessionId, agentId });
    },
    [runPlan],
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
