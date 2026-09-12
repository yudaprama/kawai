import { useCallback, useEffect, useState } from "react";

import { errText, call } from "@/lib/api";
import { useSupervisorPlan } from "@/features/chat/hooks/use-supervisor-plan";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";

// ── Derived view models ─────────────────────────────────────────────────────

// ── Follow-up composer (PLAN-followup-composer.md) ──────────────────────

/** Static quick-action chips shown above the composer once a run finished
 *  with a deliverable. Hardcoded by design (deterministic, zero latency,
 *  zero failure mode) — dynamic chips (Fase 3) swap in over them when the
 *  suggest_followups op answers. Clicking a chip seeds the composer with
 *  the prefix; the user completes the sentence. */
export interface FollowUpChip {
  icon: string;
  label: string;
  prefix: string;
}
export const FOLLOW_UP_CHIPS: FollowUpChip[] = [
  { icon: "✨", label: "Enhance", prefix: "Enhance the previous deliverable: " },
  { icon: "➕", label: "Expand", prefix: "Expand the previous deliverable with more depth and examples: " },
  {
    icon: "🎯",
    label: "More actionable",
    prefix: "Rewrite the previous deliverable to be more concrete and actionable: ",
  },
  { icon: "✂️", label: "Shorter", prefix: "Condense the previous deliverable, keep the key findings: " },
  { icon: "✍️", label: "Change tone", prefix: "Rewrite the previous deliverable in a different tone: " },
  { icon: "🌐", label: "Translate", prefix: "Translate the previous deliverable to: " },
];

/** The excerpt is LLM-generated content quoted verbatim into the planner's
 *  goal — a deliverable containing the block's own tags could spoof the
 *  boundary. Strip them before wrapping (decision #11). */
export function sanitizeDeliverableExcerpt(excerpt: string): string {
  return excerpt.split("<previous-deliverable>").join("").split("</previous-deliverable>").join("");
}

const QUOTE_EXCERPT_MAX_CHARS = 800;

/** Build the goal string sent to `plan_task`: the self-describing quote
 *  block plus the user's verbatim goal. The clean goal NEVER enters here —
 *  callers keep it separate for userGoal/title/plan record (decision #10). */
export function buildQuotedGoal(opts: { goal: string; excerpt: string; planKey: string; sessionId: number }): string {
  const excerpt = sanitizeDeliverableExcerpt(opts.excerpt).slice(0, QUOTE_EXCERPT_MAX_CHARS);
  return `<previous-deliverable planKey="${opts.planKey}" session="${opts.sessionId}" chars="${opts.excerpt.length}">\n${excerpt}\n</previous-deliverable>\n\n<user-goal>\n${opts.goal}\n</user-goal>`;
}

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
  /** Full deliverable text (in-memory only) — backs the run journal sections
   *  (A2); full step reports still live in supervisor_step_results. */
  outputFull?: string;
  stepsDone?: number;
  stepsTotal?: number;
  /** True when THIS run was submitted with a quote of the previous run's
   *  deliverable — drives the journal's `↳ builds on` marker. */
  quoted?: boolean;
  /** Plan key — lets the journal read this run's full step reports from
   *  supervisor_step_results even after the supervisor moved on. */
  planKey?: string | null;
  /** Lightweight step snapshot captured at terminal state — backs the
   *  journal's step timeline. Full bodies stay in supervisor_step_results. */
  steps?: {
    stepId: string;
    tool: string;
    task: string;
    state: SupervisorStep["state"];
    dependsOn: string[];
  }[];
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
    const deps = (s.dependsOn ?? []).map((d) => byId.get(d)).filter((dep): dep is SupervisorStep => dep != null);
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

// ── Hook ────────────────────────────────────────────────────────────────────

export function useWorkbench() {
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Follow-up intent (Fase 2): explicit UI state, never regex. True only via
  // chip click or the "include quote" suggestion; reset after every submit.
  const [followUp, setFollowUp] = useState(false);
  // True when the current/last run was submitted with a quote — drives the
  // previous-run rail (Fase 4). Ephemeral like everything here.
  const [quotedLastRun, setQuotedLastRun] = useState(false);
  // Dynamic chips (Fase 3): empty = show the static ones. Best-effort swap
  // after `finished`; failures keep the static chips silently.
  const [dynamicChips, setDynamicChips] = useState<string[]>([]);

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
                outputFull: output ?? r.outputFull,
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

  /** A deliverable is quotable when the last run finished complete with a
   *  deliverable, its full output, and the planKey lookup key for agents to
   *  read the full body via session_step_results. */
  const canFollowUp =
    supervisor.status === "completed" &&
    supervisor.finalOutput != null &&
    supervisor.finalOutput.trim() !== "" &&
    supervisor.planKey != null &&
    sessionId != null;

  // Fase 3: statis-first swap. When a deliverable becomes quotable, spawn
  // the suggest_followups one-shot in the background; on success swap the
  // chips, on any failure the static chips stay. A new run clears them.
  useEffect(() => {
    const output = supervisor.finalOutput;
    if (
      supervisor.status !== "completed" ||
      output == null ||
      output.trim() === "" ||
      supervisor.planKey == null ||
      sessionId == null
    ) {
      setDynamicChips([]);
      return;
    }
    let cancelled = false;
    void call<string[]>("suggest_followups", {
      excerpt: output.slice(0, 2000),
      sessionId,
    })
      .then((chips) => {
        if (cancelled || !Array.isArray(chips)) return;
        const clean = chips.filter((c) => typeof c === "string" && c.trim() !== "").slice(0, 4);
        if (clean.length > 0) setDynamicChips(clean);
      })
      .catch(() => {}); // static chips remain — no error surface (decision #2)
    return () => {
      cancelled = true;
    };
  }, [supervisor.status, supervisor.finalOutput, supervisor.planKey, sessionId]);

  // Journal capture: when the current/last run reaches a terminal state,
  // snapshot its steps + planKey into the run record — the supervisor state
  // itself is single-run and gets wiped by the next planAndRun.
  const terminal = supervisor.status === "completed" || supervisor.status === "failed";
  useEffect(() => {
    if (!terminal) return;
    setRuns((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.planKey === supervisor.planKey && last.steps != null) return prev;
      return prev.map((r, i) =>
        i === prev.length - 1
          ? {
              ...r,
              planKey: supervisor.planKey,
              steps: supervisor.steps.map((s) => ({
                stepId: s.stepId,
                tool: s.tool,
                task: s.task,
                state: s.state,
                dependsOn: s.dependsOn,
              })),
            }
          : r,
      );
    });
  }, [terminal, supervisor.planKey, supervisor.steps]);

  const run = useCallback(
    async (goal: string, fileIds?: string[], opts?: { quote?: boolean }) => {
      const trimmed = goal.trim();
      if (!trimmed) return;
      setFollowUp(false);
      const quote = opts?.quote === true;
      setQuotedLastRun(quote);
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
      // Awaited so the session_files rows are committed before the planner
      // starts — otherwise the first steps' knowledge_search can miss the
      // files that were just mentioned. Failure blocks the run: a goal that
      // depends on attached files must not silently run without them.
      if (fileIds?.length) {
        try {
          await call("knowledge_add_to_session", { sessionId: sid, fileIds });
        } catch (err) {
          setSessionError(`Couldn't attach the mentioned files to the run — ${errText(err)}`);
          return;
        }
      }
      setRuns((prev) => [
        ...prev,
        {
          id: `${Date.now()}`,
          goal: trimmed,
          status: "running",
          startedAt: Date.now(),
          quoted: quote,
        },
      ]);
      // Quoted vs clean (decision #10): the planner receives the quote block
      // + goal; userGoal, the runs list, and all persisted records keep the
      // clean verbatim form. The quote is built only from the live supervisor
      // state — the full deliverable, uncapped (STEP_EVENT_OUTPUT_MAX_CHARS
      // only bounds per-step events, not planCompleted.final_output).
      const quoteable = quote && canFollowUp && supervisor.planKey != null && sid != null;
      const quotedGoal = quoteable
        ? buildQuotedGoal({
            goal: trimmed,
            excerpt: supervisor.finalOutput ?? "",
            planKey: supervisor.planKey ?? "",
            sessionId: sid ?? 0,
          })
        : trimmed;
      await supervisor.planAndRun(quotedGoal, sid, "auto", trimmed);
    },
    [sessionId, supervisor, canFollowUp],
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

  /** Full body of a step's output, from the persisted supervisor_step_results
   *  (the wire preview is capped at 2000 chars). Pass `planKey` to read a
   *  PAST run's step (the journal); omit it for the current run. Null when
   *  nothing is running yet or the fetch fails — caller keeps the preview. */
  const loadFullOutput = useCallback(
    async (stepId: string, planKey?: string): Promise<string | null> => {
      const key = planKey ?? supervisor.planKey;
      if (sessionId == null || key == null) return null;
      try {
        return await call<string>("supervisor_step_output", {
          sessionId,
          planKey: key,
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
    sessionId,
    sessionError,
    composing,
    run,
    syncLatestRun,
    loadFullOutput,
    followUp,
    setFollowUp,
    quotedLastRun,
    canFollowUp,
    dynamicChips,
    /** "New session": the ONLY reset — the next run gets a fresh session and
     *  recalls nothing from these runs. Named for what it actually does. */
    startNewSession: () => {
      setSessionId(null);
      setRuns([]);
      setFollowUp(false);
      setQuotedLastRun(false);
      setDynamicChips([]);
    },
  };
}
