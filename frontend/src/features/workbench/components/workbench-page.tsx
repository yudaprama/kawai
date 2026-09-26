import { Icon } from "@/components/shared/icon";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/features/chat/components/chat-composer";
import type { RecentRunInfo } from "@/lib/api";
import { RecentRuns } from "@/features/workbench/components/recent-runs";
import { isDeliverableStep, useWorkbench } from "@/features/workbench/hooks/use-workbench";
import type { WorkbenchRun } from "@/features/workbench/hooks/use-workbench";

import { AnalysisDeskForm } from "./analysis-desk-form";
import { DeliverableViewer, PastRunCanvas, RunHistory, RunSwitcher } from "./deliverable-viewer";
import type { CanvasView } from "./deliverable-viewer";
import { ComposerQuoteBadge, FollowUpChips } from "./follow-up-composer";
import { GoalComposer } from "./goal-composer";
import { ProgressRail, RunHistoryRail } from "./progress-rail";

// ── Sessions button ─────────────────────────────────────────────────────────

/** Opens the shared SessionHistoryDialog (App owns the dialog state). */
function SessionsButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Browse past sessions (Cmd/Ctrl+K)"
      aria-label="Open session history"
      className="text-muted-foreground hover:bg-[var(--tea-color-bg-secondary-default)] hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[10px] tracking-wider uppercase transition-colors"
    >
      <Icon name="history" className="size-3.5" />
      Sessions
    </button>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export interface WorkbenchPageProps {
  /** Knowledge integration for the composer's @ menu + image drop. */
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  /** Import file handler — returns the imported office files (for auto-attach). */
  onAddFiles?: () => Promise<{ id: string; originalName: string; ext: string }[] | undefined> | undefined;
  onAddLink?: () => void;
  /** Open the session-history dialog (same modal as Cmd/Ctrl+K). */
  onOpenSessions?: () => void;
  /** App-owned: the session dialog is open — the landing recents list
   *  refetches when it closes (renames/deletes happened underneath). */
  sessionsOpen?: boolean;
  /** App-owned ref: on mount the page publishes its `selectSession` here so
   *  the App-level session dialog can target the WORKBENCH's session state
   *  (the workbench keeps its own sessions, separate from the chat hook). */
  sessionSelectorRef?: React.MutableRefObject<((id: number) => void) | null>;
  /** App-owned ref: on mount the page publishes its new-session handler here
   *  so the App-level "New" button (rail + Cmd/Ctrl+N) can reset the
   *  WORKBENCH — resetting the chat hook alone is invisible on this surface. */
  newSessionRef?: React.MutableRefObject<(() => void) | null>;
  /** App-owned ref: on mount the page publishes its attachFiles here so the
   *  App-level LinkDialog can auto-attach a freshly imported YouTube
   *  transcript as a composer chip (same UX as the file-import auto-attach). */
  attachFilesRef?: React.MutableRefObject<
    ((files: { id: string; originalName: string; ext: string }[]) => void) | null
  >;
}

/** The kawai Workbench — the work-centric primary surface (PLAN-workbench.md).
 *  Left: a single sidebar — progress phases + Messages & Tools timeline, with
 *  the goal composer pinned at the bottom. Right: the deliverable. Results
 *  never enter chat. */
export function WorkbenchPage({
  onImageToKnowledge,
  onAddFiles,
  onAddLink,
  onOpenSessions,
  sessionsOpen = false,
  sessionSelectorRef,
  newSessionRef,
  attachFilesRef,
}: WorkbenchPageProps) {
  const workbench = useWorkbench();
  const { supervisor } = workbench;

  // Publish selectSession upward while mounted (App owns the dialog).
  useEffect(() => {
    if (sessionSelectorRef == null) return;
    sessionSelectorRef.current = workbench.selectSession;
    return () => {
      sessionSelectorRef.current = null;
    };
  }, [sessionSelectorRef, workbench.selectSession]);
  // Publish attachFiles upward while mounted (App owns the LinkDialog — a
  // successful YouTube import attaches the transcript chip through this ref).
  useEffect(() => {
    if (attachFilesRef == null) return;
    attachFilesRef.current = workbench.attachFiles;
    return () => {
      attachFilesRef.current = null;
    };
  }, [attachFilesRef, workbench.attachFiles]);
  // Home = the landing composer. Submitting a goal moves to the workbench;
  // "New goal" returns here.
  const [home, setHome] = useState(true);
  // Landing recents: refetch when a run lands its plan record (the edge
  // below) and when the sessions dialog closes (rename/delete underneath —
  // that edge flips RecentRuns' `open` prop via `sessionsOpen`).
  const [recentKey, setRecentKey] = useState(0);
  const runWasInFlight = useRef(false);
  useEffect(() => {
    const inFlight = ["running", "stopping", "awaitingConfirmation", "reviewing"].includes(supervisor.status);
    if (runWasInFlight.current && !inFlight) setRecentKey((k) => k + 1);
    runWasInFlight.current = inFlight;
  }, [supervisor.status]);
  // A cross-session pick opens AFTER its records rehydrate: the effect below
  // waits for the picked session's runs to land, then opens that run's report
  // (restored run ids are `restored-<message rowId>` — exact match on rowId).
  const pendingPickRow = useRef<number | null>(null);
  // Canvas navigation (PLAN-workbench-multi-run-ux.md, canvas policy):
  // view = which run + which document is on the right pane. null = the first
  // run hasn't produced anything yet. The canvas NEVER moves on its own
  // except twice per run: (1) when the new run's FIRST content lands, it
  // switches to that run once; (2) when the deliverable lands, it switches
  // to "final" once — and only if the user hasn't manually navigated.
  const [view, setView] = useState<CanvasView | null>(null);
  const [stealAllowed, setStealAllowed] = useState(true);
  const autoSwitchedRun = useRef<string | null>(null);
  const activeRunId = workbench.runs.at(-1)?.id ?? null;
  // supervisor.planStartedAt captured at submit. While planStartedAt still
  // equals this baseline, the supervisor state BELONGS to the previous run
  // (planning reuses it until planStarted fires) — the canvas must treat the
  // active run as "not seeded yet" and never read steps/finalOutput as its.
  const planStartedBaseline = useRef<number | null>(null);
  const seededForActiveRun =
    supervisor.planStartedAt != null && supervisor.planStartedAt !== planStartedBaseline.current;
  // A run is in flight or planning, but the supervisor hasn't been seeded by
  // planStarted yet — rail AND canvas must treat the supervisor state as the
  // previous run's, never as the new run's progress. NOTE: during planning
  // `supervisor.status` still reads "completed" (the previous run's terminal
  // state) — the reliable in-planning signal is `supervisor.planning != null`.
  const runInFlight = ["running", "stopping", "awaitingConfirmation"].includes(supervisor.status);
  const planningUnseeded =
    !seededForActiveRun && (supervisor.planning != null || runInFlight || supervisor.status === "reviewing");

  /** User-initiated navigation — cancels the deliverable steal. */
  const userPick = useCallback((runId: string, doc: string) => {
    setStealAllowed(false);
    setView({ runId, doc });
  }, []);

  // Auto-switch ONCE per run: only AFTER the supervisor has seeded the new
  // run (planStarted) and its first content lands. During planning the
  // supervisor still carries the PREVIOUS run's steps/output — those must
  // never count as the new run's content.
  useEffect(() => {
    if (activeRunId == null || autoSwitchedRun.current === activeRunId) return;
    if (!seededForActiveRun) return;
    const hasContent = supervisor.finalOutput != null || supervisor.steps.some((s) => s.output != null);
    if (!hasContent) return;
    autoSwitchedRun.current = activeRunId;
    const firstReport = supervisor.steps.find(
      (s) => !isDeliverableStep(s) && s.output != null && (s.state === "completed" || s.state === "failed"),
    );
    console.log("[workbench] AUTO-SWITCH to new run", activeRunId);
    setView({ runId: activeRunId, doc: supervisor.finalOutput != null ? "final" : (firstReport?.stepId ?? "final") });
  }, [activeRunId, seededForActiveRun, supervisor.finalOutput, supervisor.steps]);

  // Steal ONCE: when the NEW run's deliverable lands (finalOutput null →
  // value AFTER seeding) and the user hasn't navigated manually since
  // submit, show it. While unseeded, keep syncing the baseline so run 1's
  // stale finalOutput is never mistaken for run 2's.
  const prevFinal = useRef<string | null>(null);
  useEffect(() => {
    if (!seededForActiveRun) {
      prevFinal.current = supervisor.finalOutput;
      return;
    }
    const arrived = supervisor.finalOutput != null && prevFinal.current == null;
    prevFinal.current = supervisor.finalOutput;
    if (!arrived || !stealAllowed) return;
    if (activeRunId == null) return;
    setView({ runId: activeRunId, doc: "final" });
    setStealAllowed(false);
  }, [stealAllowed, seededForActiveRun, supervisor.finalOutput, activeRunId]);

  // Resolve a pending cross-session pick once the target session's runs are
  // restored (no-op until `restored-<rowId>` shows up in the journal).
  useEffect(() => {
    const rowId = pendingPickRow.current;
    if (rowId == null) return;
    const hit = workbench.runs.find((r) => r.id === `restored-${rowId}`);
    if (!hit) return;
    pendingPickRow.current = null;
    userPick(hit.id, "final");
  }, [workbench.runs, userPick]);

  /** Open a recent run from the landing strip: point the session at it and
   *  queue the report pick for when its records restore. */
  const openRecent = useCallback(
    (run: RecentRunInfo) => {
      pendingPickRow.current = run.rowId;
      setHome(false);
      workbench.selectSession(run.sessionId);
    },
    [workbench.selectSession],
  );

  /** Rail "see report" — a user pick. The steps shown in the rail belong to
   *  the active run once seeded, otherwise (planning) to the previous run. */
  const openReport = (id: string) => {
    const owner = seededForActiveRun ? activeRunId : (workbench.runs.at(-2)?.id ?? activeRunId);
    if (owner != null) userPick(owner, id);
  };
  // Chip click → draft dropped into the input for editing (not auto-submit).
  const [chipDraft, setChipDraft] = useState<{ text: string; nonce: number } | null>(null);

  /** Wrap the App-level import handler: when the import returns the office
   *  files, auto-attach them as workbench chips (optimistic status = indexing
   *  for non-tabular; `run()` commits them to the lazy session). */
  const handleAddFiles = useCallback(async () => {
    const imported = await onAddFiles?.();
    if (Array.isArray(imported) && imported.length > 0) workbench.attachFiles(imported);
  }, [onAddFiles, workbench.attachFiles]);
  const chipClicked = (text: string) => {
    workbench.setFollowUp(true);
    setChipDraft({ text, nonce: Date.now() });
  };
  // "Build on this": arm the run as the follow-up quote target. The badge
  // above the composer shows the pick; ✕ on the badge disarms it.
  const buildOn = (run: WorkbenchRun) => {
    workbench.setFollowUp(false);
    workbench.setQuoteTarget(run);
  };
  const submit = (text: string, fileIds?: string[]) => {
    if (!text.trim()) return;
    // A plan awaiting review owns the rail — new goals wait until it is run
    // or discarded.
    if (supervisor.status === "reviewing") return;
    setHome(false);
    // Canvas policy (same as Run 1): drop the pinned view so the canvas
    // defaults to the newest run with doc "final" — the new run's prompt
    // shows in the header immediately, and the once-per-run auto-switch
    // takes over when its first content lands.
    setView(null);
    setStealAllowed(true);
    planStartedBaseline.current = supervisor.planStartedAt;
    const quote = workbench.followUp;
    void workbench.run(text, fileIds, { quote });
  };

  /** Analysis Desk submit (PLAN-analysis-desk): the FIXED stock-research
   *  pipeline for one ticker. Same canvas handoff as a goal submit — the
   *  desk streams the same SupervisorEvent lifecycle, so the rail, deliverable
   *  viewer, and AGENT REPORTS render it unchanged. */
  const submitDesk = useCallback(
    (ticker: string, tradeDate: string | undefined, analysts: string[] | undefined) => {
      if (supervisor.status === "reviewing") return;
      setHome(false);
      setView(null);
      setStealAllowed(true);
      planStartedBaseline.current = supervisor.planStartedAt;
      void workbench.runDesk(ticker, tradeDate, analysts);
    },
    [supervisor.status, workbench.runDesk],
  );
  const composerStatus = ["running", "stopping", "awaitingConfirmation"].includes(supervisor.status)
    ? ("submitted" as const)
    : ("ready" as const);

  /** App-level "New" (rail button + Cmd/Ctrl+N): fresh session back at the
   *  landing hero. Blocked while a run/plan is in flight — same guard as the
   *  chat hook's newChat — and a plan awaiting review is discarded first: it
   *  owns the rail and would silently block the next submit. */
  const newSession = useCallback(() => {
    if (supervisor.planning != null || runInFlight) return;
    if (supervisor.status === "reviewing") supervisor.cancelPlan();
    workbench.startNewSession();
    pendingPickRow.current = null;
    autoSwitchedRun.current = null;
    setChipDraft(null);
    setView(null);
    setHome(true);
  }, [supervisor.planning, supervisor.status, supervisor.cancelPlan, runInFlight, workbench.startNewSession]);

  // Publish the App-level "New" while mounted (App owns the rail button +
  // Cmd/Ctrl+N) — the workbench keeps its own session/runs/view state, so
  // resetting the chat hook alone is invisible on this surface.
  useEffect(() => {
    if (newSessionRef == null) return;
    newSessionRef.current = newSession;
    return () => {
      newSessionRef.current = null;
    };
  }, [newSessionRef, newSession]);

  // Keep the history list's step tally fresh while a run progresses.
  useEffect(() => {
    workbench.syncLatestRun(supervisor.steps);
  }, [supervisor.steps, workbench.syncLatestRun]); // eslint-disable-line react-hooks/exhaustive-deps

  // Landing: hero composer, no rails — the goal is the whole screen.
  if (home) {
    return (
      <div className="bg-background flex h-full w-full flex-col">
        <div className="flex items-center justify-between px-4 py-2">
          <span className="text-foreground inline-flex items-center gap-1.5 font-mono text-xs font-bold tracking-wider uppercase">
            <Icon name="zap" className="text-primary size-4" />
            Kawai Workbench
          </span>
          {onOpenSessions && <SessionsButton onOpen={onOpenSessions} />}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
          <div className="space-y-2">
            <p className="text-foreground inline-flex items-center gap-2 text-lg font-semibold">
              <Icon name="zap" className="text-primary size-6" />
              State a goal. Watch the work.
            </p>
            <p className="text-muted-foreground max-w-md text-xs">
              Kawai plans the steps, runs the agents, and you watch every report land — the deliverable is written here,
              not in a chat.
            </p>
          </div>
          <div className="w-full max-w-2xl">
            <ChatComposer
              agentName="Workbench"
              chipDraft={chipDraft}
              disabled={composerStatus === "submitted"}
              lastUserText={null}
              onAddFiles={handleAddFiles}
              onAddLink={onAddLink}
              onImageToKnowledge={onImageToKnowledge}
              onSubmit={(text, fileIds) => submit(text, fileIds)}
              onStop={workbench.supervisor.stop}
              status={composerStatus}
              attachedFiles={workbench.attachedFiles}
              onRemoveAttachedFile={workbench.removeAttachedFile}
            />
            <p className="text-muted-foreground mt-3 text-left font-mono text-[10px]">
              Attach knowledge files with @ — the run's agents can search them.
            </p>
          </div>
          <div className="w-full max-w-2xl">
            <AnalysisDeskForm disabled={composerStatus === "submitted"} onSubmit={submitDesk} />
          </div>
          {workbench.runs.length > 0 ? (
            <div className="w-full max-w-2xl text-left">
              <RunHistory
                latestRunId={workbench.runs.at(-1)?.id}
                onReopen={(runId) => {
                  // S1: only the latest run's report is inspectable.
                  if (runId === workbench.runs.at(-1)?.id) {
                    setHome(false);
                    userPick(runId, "final");
                  }
                }}
                runs={workbench.runs}
              />
            </div>
          ) : (
            <RecentRuns open={!sessionsOpen} reloadKey={recentKey} onOpen={openRecent} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full w-full overflow-hidden">
      {/* Left: one sidebar — progress + timeline (scrolls), composer pinned at
           the bottom. */}
      <aside className="border-border/60 hidden w-96 shrink-0 flex-col border-r lg:flex">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <RunHistoryRail
            onBuildOn={buildOn}
            onOpenDeliverable={(runId) => userPick(runId, "final")}
            onOpenStep={(runId, stepId) => userPick(runId, stepId)}
            runs={workbench.runs}
          />
          <ProgressRail
            unseeded={planningUnseeded}
            workbench={workbench}
            onNewGoal={() => {
              setView(null);
              autoSwitchedRun.current = null;
              setHome(true);
            }}
            onOpenReport={openReport}
          />
        </div>
        <div className="border-border/60 border-t p-4">
          <div className="mb-2 flex items-center justify-between">
            {workbench.runs.length > 0 ? (
              <div className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">
                Session · {workbench.runs.length} run{workbench.runs.length === 1 ? "" : "s"}
              </div>
            ) : (
              <span />
            )}
            {onOpenSessions && <SessionsButton onOpen={onOpenSessions} />}
          </div>
          {supervisor.status === "reviewing" && (
            <p className="text-muted-foreground mb-2 font-mono text-[11px]">
              A plan is awaiting your review above — run or discard it first.
            </p>
          )}
          <FollowUpChips onChip={chipClicked} workbench={workbench} />
          <ComposerQuoteBadge workbench={workbench} />
          <GoalComposer
            chipDraft={chipDraft}
            workbench={workbench}
            onAddFiles={handleAddFiles}
            onAddLink={onAddLink}
            onImageToKnowledge={onImageToKnowledge}
            onSubmit={submit}
            placeholder={
              workbench.canFollowUp
                ? "Follow up on the previous deliverable… (e.g. expand section 2, change tone)"
                : undefined
            }
          />
        </div>
      </aside>

      {/* Right: the CANVAS — run switcher + exactly one full document. The
           canvas never moves on its own except the two approved steals. */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {workbench.runs.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-center font-mono text-sm">
            State a goal in the composer to start a run.
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-border/60 border-b px-4 py-2">
              <RunSwitcher
                activeRunId={activeRunId}
                onPick={(runId) => userPick(runId, "final")}
                runs={workbench.runs}
                view={view}
              />
            </div>
            <div className="min-h-0 flex-1">
              {(() => {
                const shown = view != null ? workbench.runs.find((r) => r.id === view.runId) : undefined;
                const runIndex = shown != null ? workbench.runs.indexOf(shown) : -1;
                if (shown != null && runIndex < workbench.runs.length - 1) {
                  return (
                    <PastRunCanvas
                      doc={view?.doc ?? "final"}
                      loadFullOutput={workbench.loadFullOutput}
                      onBuildOn={buildOn}
                      run={shown}
                    />
                  );
                }
                // Active (latest) run — live. doc stays pinned; before the
                // first content arrives it's "final" (shows the goal/planning
                // placeholder), which is the approved first-run behavior.
                return (
                  <DeliverableViewer
                    doc={view != null && view.runId === activeRunId ? view.doc : "final"}
                    runIndex={workbench.runs.length - 1}
                    unseeded={planningUnseeded}
                    workbench={workbench}
                  />
                );
              })()}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
