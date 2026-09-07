import { useCallback, useState } from "react";

import { errText, call } from "@/lib/api";
import { useSupervisorPlan } from "@/features/chat/hooks/use-supervisor-plan";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";

// ── Derived view models ─────────────────────────────────────────────────────

/** One past/current run in the desk's history list (in-memory for S1; S2
 *  persists runs to the office store for cross-restart history). */
export interface WorkbenchRun {
  id: string;
  goal: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  /** Synthesized deliverable (terminal) — full text lives in the viewer. */
  outputPreview?: string;
  stepsDone?: number;
  stepsTotal?: number;
}

export interface TimelineRow {
  id: string;
  kind: "tool" | "step" | "failed" | "planner";
  /** Wall-clock label (mm:ss since plan start). */
  at: string;
  agent: string;
  detail: string;
}

/** Agent display name: the planner's human task, de-gritted. Falls back to
 *  the tool name; never shows raw step ids like "s2" as the primary label. */
export function agentName(step: SupervisorStep): string {
  const t = (step.task || step.tool || step.stepId).trim();
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
}

/** The virtual post-plan synthesis step is rendered as a dedicated rail row,
 *  not a phase member (it runs after ALL phases). */
export const DELIVERABLE_TOOL = "deliverable_writer";
export function isDeliverableStep(s: SupervisorStep): boolean {
  return s.tool === DELIVERABLE_TOOL;
}

/** Waves (dispatch order from `dependsOn`) — same derivation the plan card
 *  uses, kept local so the workbench owns its view model. The deliverable
 *  step is excluded (it has no dependencies and would otherwise land in
 *  phase 1). */
export function computePhases(steps: SupervisorStep[]): SupervisorStep[][] {
  const planSteps = steps.filter((s) => !isDeliverableStep(s));
  const waveOf = new Map<string, number>();
  const byId = new Map(planSteps.map((s) => [s.stepId, s]));
  const depth = (s: SupervisorStep): number => {
    const cached = waveOf.get(s.stepId);
    if (cached != null) return cached;
    const deps = s.dependsOn.map((d) => byId.get(d)).filter((dep): dep is SupervisorStep => dep != null);
    const w = deps.length === 0 ? 1 : Math.max(...deps.map(depth)) + 1;
    waveOf.set(s.stepId, w);
    return w;
  };
  const waves = new Map<number, SupervisorStep[]>();
  for (const s of planSteps) {
    const w = depth(s);
    const bucket = waves.get(w) ?? [];
    bucket.push(s);
    waves.set(w, bucket);
  }
  const sortedWaves = [...waves.keys()].sort((a, b) => a - b);
  return sortedWaves.map((w) => waves.get(w) ?? []);
}

function fmtClock(at: number, startedAt: number | null): string {
  if (startedAt == null) return "";
  const secs = Math.max(0, Math.round((at - startedAt) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useWorkbench() {
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const supervisor = useSupervisorPlan({
    onPlanCompleted: (goal, output) => {
      setRuns((prev) =>
        prev.map((r, i) =>
          i === prev.length - 1 && r.status === "running"
            ? {
                ...r,
                status: "completed",
                finishedAt: Date.now(),
                outputPreview: output?.slice(0, 200) ?? r.outputPreview,
              }
            : r,
        ),
      );
      void goal;
    },
    onPlanFailed: (goal, error) => {
      setRuns((prev) =>
        prev.map((r, i) =>
          i === prev.length - 1 && r.status === "running"
            ? { ...r, status: "failed", finishedAt: Date.now(), outputPreview: error.slice(0, 200) }
            : r,
        ),
      );
      void goal;
    },
  });
  // Composer is unlocked only when no run is active (config-first, locked
  // during a run) — see PLAN-workbench.md.
  const composing = !["running", "stopping", "awaitingConfirmation", "reviewing"].includes(supervisor.status);

  const run = useCallback(
    async (goal: string, fileIds?: string[]) => {
      const trimmed = goal.trim();
      if (!trimmed) return;
      // Sessions are lazy — create on first desk run. Workbench runs live in
      // their own session so chat history stays chat.
      let sid = sessionId;
      if (sid == null) {
        try {
          const s = await call<{ id: number }>("create_chat_session", {
            title: `Desk: ${trimmed.slice(0, 72)}`,
          });
          sid = s.id;
          setSessionId(s.id);
        } catch (err) {
          setSessionError(`Couldn't start the run — ${errText(err)}`);
          return;
        }
      }
      // Knowledge files attached via the composer's @ menu scope this run's
      // knowledge_search to the desk session (same contract as chat).
      if (fileIds?.length) {
        void call("knowledge_add_to_session", { sessionId: sid, fileIds }).catch(() => {});
      }
      setRuns((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          goal: trimmed,
          status: "running",
          startedAt: Date.now(),
        },
      ]);
      await supervisor.planAndRun(trimmed, sid, "auto");
    },
    [sessionId, supervisor],
  );

  /** The just-started run's goal lands in `runs` via `run()`; keep the latest
   *  running entry's step tally fresh for the history list. */
  const syncLatestRun = useCallback((steps: SupervisorStep[]) => {
    setRuns((prev) => {
      if (prev.length === 0 || prev[prev.length - 1].status !== "running") return prev;
      const last = prev[prev.length - 1];
      if (last.stepsTotal === steps.length && last.stepsDone === steps.filter((s) => s.state !== "pending").length)
        return prev;
      return prev.map((r, i) =>
        i === prev.length - 1
          ? { ...r, stepsTotal: steps.length, stepsDone: steps.filter((s) => s.state !== "pending").length }
          : r,
      );
    });
  }, []);

  const timeline = buildTimeline(supervisor);

  /** Full body of a step's output, from the persisted supervisor_step_results
   *  (the wire preview is capped at 2000 chars). Null when nothing is running
   *  yet (no session/plan key) or the fetch fails — caller keeps the preview. */
  const loadFullOutput = useCallback(
    async (stepId: string): Promise<string | null> => {
      if (sessionId == null || supervisor.planKey == null) return null;
      try {
        return await call<string>("supervisor_step_output", {
          sessionId,
          planKey: supervisor.planKey,
          stepId,
        });
      } catch (err) {
        console.error("[workbench] supervisor_step_output:", errText(err));
        return null;
      }
    },
    [sessionId, supervisor.planKey],
  );

  return {
    supervisor,
    runs,
    timeline,
    sessionId,
    sessionError,
    composing,
    run,
    syncLatestRun,
    loadFullOutput,
    abandonSession: () => {
      // "New goal": the next run gets a fresh session.
      setSessionId(null);
    },
    newRun: () => {
      setSessionId(null);
    },
  };
}

type SupervisorView = ReturnType<typeof useSupervisorPlan>;

/** Chronological machine log derived from the supervisor state — the
 *  Messages & Tools rail. S2 replaces this with true per-event streaming
 *  (args + per-step LLM usage). */
function buildTimeline(supervisor: SupervisorView): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const startedAt = supervisor.planStartedAt;
  if (supervisor.planning != null || supervisor.status === "reviewing") {
    rows.push({
      id: "planner",
      kind: "planner",
      at: fmtClock(Date.now(), startedAt),
      agent: "Planner",
      detail: supervisor.planning?.provider
        ? `${supervisor.planning.provider} · round ${supervisor.planning.round}`
        : "decomposing the goal",
    });
  }
  for (const s of supervisor.steps) {
    const agent = isDeliverableStep(s) ? "Deliverable Writer" : agentName(s);
    if (s.state === "pending") continue;
    if (s.startedAt != null) {
      rows.push({
        id: `${s.stepId}:start`,
        kind: "tool",
        at: fmtClock(s.startedAt, startedAt),
        agent,
        detail: s.tool,
      });
    }
    if (s.finishedAt != null) {
      rows.push({
        id: `${s.stepId}:end`,
        kind: s.state === "failed" ? "failed" : "step",
        at: fmtClock(s.finishedAt, startedAt),
        agent,
        detail:
          s.state === "failed"
            ? (s.error ?? "failed")
            : `completed${s.retriesUsed ? ` (retried ×${s.retriesUsed})` : ""}`,
      });
    }
  }
  return rows;
}
