import { useCallback, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { call, callWithEvents, respondSupervisorConfirmation } from "@/lib/api";
import { type StreamControl, streamOperation } from "@/lib/stream";
import type { UIMessage, UIMessagePart } from "@/lib/ai-types";
import { initialSupervisorState, parseReview, pruneReviewStep, supervisorReducer } from "./plan-reducer";
import type { SupervisorArtifact, SupervisorEvent, SupervisorPlanState, SupervisorStep } from "./supervisor-types";

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
  onPlanCompleted?: (
    goal: string | null,
    output: string | null,
    /** Deliverable artifacts from planCompleted — deck hero source. */
    artifacts?: { kind: string; handle?: string; filename?: string; label?: string }[],
  ) => void;
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
  steps: {
    id: string;
    tool: string;
    state: SupervisorStep["state"];
    output?: string;
    /** Planner's human task label (restored journals show it, not the tool). */
    task?: string;
    /** Dispatch order — lets a restored journal re-derive phases. */
    dependsOn?: string[];
    /** Dataflow bindings — restored so the rail shows the step's wiring. */
    inputs?: { arg: string; fromStep: string; output: string }[];
    /** Per-step artifacts (charts/files) — captured once here at terminal
     *  write; the wire events that carried them are gone by reopen time. */
    artifacts?: PersistedPlan["artifacts"];
    /** Failure message — restored so failed steps keep their why. */
    error?: string;
  }[];
  output: string | null;
  /** Execution-memo key — lets a restored journal fetch FULL step bodies
   *  from supervisor_step_results (not just the ≤2000-char embeds). Absent on
   *  records written before this field existed. */
  planKey?: string | null;
  /** Deliverable artifacts (deck hero, stored files) — restored on reopen. */
  artifacts?: { kind: string; handle?: string; filename?: string; label?: string }[];
  /** Present on failed-plan records — the terminal error. */
  error?: string;
  /** True while the run is in flight: the row is appended once and updated
   *  in place per step event, then replaced by the terminal record. A row
   *  that stays partial means the run never reached a terminal event (app
   *  quit / crash) — history renders it as an interrupted run. */
  partial?: boolean;
}

/** The current run's execution-memo key, kept in sync from planStarted /
 *  planRevised events — module-level because persistPlanSnapshot (also
 *  module-level) embeds it in every record. One supervisor runs at a time. */
const planKeyRef: { current: string | null } = { current: null };

/** The current run's partial-snapshot message row (appended once, updated in
 *  place per step event) and the chain serializing those writes — a row id
 *  is never raced by a later snapshot. Module-level like planKeyRef; reset
 *  to a fresh row on planStarted/planRevised (new plan → new row). */
const partialRowRef: { current: number | null } = { current: null };
const partialWriteChainRef: { current: Promise<void> } = { current: Promise.resolve() };

function buildPlanRecord(
  goal: string | null,
  steps: SupervisorStep[],
  extra: { output: string | null; artifacts?: PersistedPlan["artifacts"]; error?: string },
  partial: boolean,
): PersistedPlan {
  return {
    type: "supervisor-plan",
    v: 1,
    goal,
    planKey: planKeyRef.current,
    steps: steps.map((s) => ({
      id: s.stepId,
      tool: s.tool,
      state: s.state,
      output: s.output,
      task: s.task,
      dependsOn: s.dependsOn,
      inputs: s.inputs,
      artifacts: s.artifacts.length > 0 ? s.artifacts : undefined,
      error: s.error,
    })),
    output: extra.output,
    artifacts: extra.artifacts,
    error: extra.error,
    partial: partial || undefined,
  };
}

/** Write a plan record to session history (best-effort, never throws).
 *  PARTIAL records: appended once at the first write, then updated IN PLACE
 *  per step event — an interrupted run survives as exactly one row instead
 *  of one row per write. TERMINAL records replace the run's partial row, so
 *  a completed run leaves a single history row. */
function writePlanRecord(sessionId: number, record: PersistedPlan): void {
  const content = sanitizeForIpc(JSON.stringify(record)) ?? JSON.stringify(record);
  partialWriteChainRef.current = partialWriteChainRef.current
    .then(async () => {
      if (record.partial) {
        if (partialRowRef.current == null) {
          const row = await call<{ id: number }>("append_chat_message", {
            sessionId,
            role: "assistant",
            content,
          });
          partialRowRef.current = typeof row?.id === "number" ? row.id : null;
        } else {
          await call("update_chat_message", {
            sessionId,
            messageId: partialRowRef.current,
            content,
          });
        }
        return;
      }
      const rowId = partialRowRef.current;
      partialRowRef.current = null;
      if (rowId != null) {
        await call("update_chat_message", { sessionId, messageId: rowId, content });
      } else {
        await call("append_chat_message", { sessionId, role: "assistant", content });
      }
    })
    .catch((err) => console.error("[supervisor] plan record persist failed:", err));
}

/** Persist the structured plan record (goal + per-step states). Embedded
 *  outputs are the wire previews (≤2000 chars each) — full results live in
 *  plan progress panel / supervisor_step_results (reachable via the record's
 *  planKey) / artifacts, not in chat history. */
function persistPlanSnapshot(
  sessionId: number,
  goal: string | null,
  steps: SupervisorStep[],
  extra: { output: string | null; artifacts?: PersistedPlan["artifacts"]; error?: string },
): void {
  writePlanRecord(sessionId, buildPlanRecord(goal, steps, extra, false));
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
      if (event.type === "planStarted" || event.type === "planRevised") {
        planKeyRef.current = event.planKey;
        // New plan → its progress snapshot is a NEW history row.
        partialRowRef.current = null;
      }
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
      planKeyRef.current = null;

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
                  artifacts: ev.artifacts,
                });
                parts = parts.map((p) =>
                  p.type === "text" && p.state === "streaming" ? { ...p, state: "done" as const } : p,
                );
                if (ev.finalOutput) {
                  parts = [...parts, { type: "text", text: ev.finalOutput, state: "done" as const }];
                }
                syncAssistant();
                callbacks?.onPlanCompleted?.(goalRef.current, ev.finalOutput ?? null, ev.artifacts);
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
                // Progress snapshot: appended once at planStarted, updated in
                // place on every step lifecycle event — an interrupted run
                // leaves exactly one partial row behind.
                if (
                  ev.type === "planStarted" ||
                  ev.type === "stepStarted" ||
                  ev.type === "stepCompleted" ||
                  ev.type === "stepFailed" ||
                  ev.type === "stepSkipped"
                ) {
                  writePlanRecord(
                    sessionId,
                    buildPlanRecord(goalRef.current, stepsRef.current, { output: null }, true),
                  );
                }
                break;
              }
            }
          },
          onDone: () => {
            streamCtrl.current = null;
            const wasStopping = stoppingRef.current;
            if (wasStopping) {
              // A user stop surfaces as stream end (no planFailed arrives) —
              // finalize the partial row so history shows a stopped run, not
              // an interrupted one.
              persistPlanSnapshot(sessionId, goalRef.current, stepsRef.current, {
                output: null,
                error: "Plan stopped.",
              });
            }
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
            const message = wasStopping ? "Plan stopped." : err.message;
            // Finalize the partial row — a transport error is terminal, and
            // in-flight steps close failed exactly like the rail state.
            persistPlanSnapshot(
              sessionId,
              goalRef.current,
              stepsRef.current.map((s) =>
                s.state === "running" ? { ...s, state: "failed" as const, error: message } : s,
              ),
              { output: null, error: message },
            );
            setState((prev) => ({
              ...prev,
              status: "failed",
              pendingConfirmation: null,
              error: message,
              // Close in-flight steps — no terminal step events arrive on a
              // transport error, so their rail rows would spin forever.
              steps: prev.steps.map((s) =>
                s.state === "running" ? { ...s, state: "failed" as const, error: message, errorKind: "cancelled" } : s,
              ),
            }));
            void persist(sessionId, "assistant", `Plan error: ${err.message}`);
          },
        },
        streamId,
      );
    },
    [dispatch, callbacks],
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

  /** Rehydrate terminal state from a persisted supervisor-plan record
   *  (session reopen). Artifacts ride along so the deliverable viewer can
   *  render the deck hero; planKey stays null — the viewer reads the run
   *  record's own planKey, or falls back to the session-scope step_output
   *  read for records without one. No-op mid-run. */
  const restorePersisted = useCallback(
    (record: {
      goal?: string | null;
      steps?: {
        id: string;
        tool: string;
        state: string;
        output?: string;
        task?: string;
        dependsOn?: string[];
        inputs?: { arg: string; fromStep: string; output: string }[];
        artifacts?: PersistedPlan["artifacts"];
        error?: string;
      }[];
      output?: string | null;
      artifacts?: PersistedPlan["artifacts"];
      error?: string;
      partial?: boolean;
    }) => {
      if (streamCtrl.current) return;
      // Hydrate EXACTLY like use-workbench's hydrateStep — same task names,
      // same dependsOn-derived phases, and non-terminal states stay pending
      // so a restored rail matches the live-run rail field for field.
      const steps: SupervisorStep[] = (record.steps ?? []).map((s) => ({
        stepId: s.id,
        tool: s.tool,
        task: s.task ?? s.tool,
        dependsOn: s.dependsOn ?? [],
        inputs: s.inputs ?? [],
        state: (s.state === "completed" || s.state === "failed" || s.state === "skipped"
          ? s.state
          : "pending") as SupervisorStep["state"],
        output: s.output,
        artifacts: (s.artifacts ?? []).map((a) => ({
          kind: a.kind as SupervisorArtifact["kind"],
          handle: a.handle,
          filename: a.filename,
          label: a.label,
        })),
        error: s.error,
      }));
      patch({
        status: record.error || record.partial ? "failed" : "completed",
        goal: record.goal ?? null,
        steps,
        finalOutput: record.output ?? null,
        artifacts: (record.artifacts ?? []).map((a) => ({
          kind: a.kind as SupervisorArtifact["kind"],
          handle: a.handle,
          filename: a.filename,
          label: a.label,
        })),
        error: record.error ?? (record.partial ? "Run interrupted before completion." : null),
        planCompletedAt: Date.now(),
      });
    },
    [patch],
  );

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
    restorePersisted,
    approve: () => respond(true),
    reject: () => respond(false),
    stop,
  };
}
