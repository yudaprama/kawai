import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { call, respondSupervisorConfirmation } from "@/lib/api";
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
      artifacts: { kind: string; handle?: string; filename?: string }[];
    }
  | {
      type: "stepFailed";
      stepId: string;
      error: string;
      /** Failure class from the scheduler: timeout | confirmation | cancelled | tool */
      kind: string;
    }
  | { type: "stepSkipped"; stepId: string; reason: string }
  | { type: "planRevising"; failedStepIds: string[]; attempt: number }
  | {
      type: "planRevised";
      attempt: number;
      stepCount: number;
      steps: { id: string; tool: string; task: string; dependsOn: string[] }[];
    }
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
  /** Failure class: timeout | confirmation | cancelled | tool */
  errorKind?: string;
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
              case "planRevised":
                // Snapshot the superseded plan's progress BEFORE re-seeding —
                // history then shows what v1 accomplished before the revision.
                void persist(
                  sessionId,
                  "assistant",
                  JSON.stringify({
                    type: "supervisor-plan",
                    v: 1,
                    goal: goalRef.current,
                    steps: stepsRef.current.map((s) => ({
                      id: s.stepId,
                      tool: s.tool,
                      state: s.state,
                      output: s.output ? s.output.slice(0, 500) : s.output,
                    })),
                    output: null,
                    error: `superseded by revision #${ev.attempt}`,
                  } satisfies PersistedPlan),
                );
                // New plan structure replaces the old one — re-seed all steps
                // as pending (same shape as planStarted). Conversation keeps
                // the same goal; only the remaining work is re-planned.
                stepsRef.current = ev.steps.map((s) => ({
                  stepId: s.id,
                  tool: s.tool,
                  task: s.task,
                  dependsOn: s.dependsOn,
                  state: "pending" as const,
                  artifacts: [],
                }));
                patch({ status: "running", steps: stepsRef.current, error: null });
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
                    // Cap embedded outputs — full results live in the plan
                    // progress panel / artifacts, not in chat history.
                    output: s.output ? s.output.slice(0, 500) : s.output,
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
                // Persist the FULL structured record (per-step states), not
                // just prose — a failed plan must replay with its step states
                // intact for diagnosis and future resume.
                void persist(
                  sessionId,
                  "assistant",
                  JSON.stringify({
                    type: "supervisor-plan",
                    v: 1,
                    goal: goalRef.current,
                    steps: stepsRef.current.map((s) => ({
                      id: s.stepId,
                      tool: s.tool,
                      state: s.state,
                      output: s.output ? s.output.slice(0, 500) : s.output,
                    })),
                    output: null,
                    error: ev.error,
                  } satisfies PersistedPlan),
                );
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

      // A plan_task rejection must surface like any other failure — an
      // unhandled rejection here silently eats the whole turn.
      let plan: unknown;
      try {
        plan = await createSupervisorPlan(goal, sessionId, agentId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch({ status: "failed", error: message });
        void persist(sessionId, "assistant", `Plan error: ${message}`);
        callbacks?.onPlanFailed?.(goal, message);
        return;
      }
      runPlan({ plan, sessionId, agentId });
    },
    [runPlan, patch, callbacks],
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
    approve: () => respond(true),
    reject: () => respond(false),
    stop,
  };
}
