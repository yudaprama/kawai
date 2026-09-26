import { Icon } from "@/components/shared/icon";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/features/chat/components/chat-composer";
import type { RecentRunInfo } from "@/lib/api";
import { RecentRuns } from "@/features/workbench/components/recent-runs";
import { isDeliverableStep, useWorkbench } from "@/features/workbench/hooks/use-workbench";
import type { WorkbenchRun } from "@/features/workbench/hooks/use-workbench";
import { logInfo } from "@/lib/logger";
import { toast } from "sonner";

import { AnalysisDeskForm } from "./analysis-desk-form";
import { DeliverableViewer, EMPTY_RUNS_HINT, PastRunCanvas, RunHistory, RunSwitcher } from "./deliverable-viewer";
import type { CanvasView } from "./deliverable-viewer";
import { ComposerQuoteBadge, FollowUpChips } from "./follow-up-composer";
import { GoalComposer } from "./goal-composer";
import { GoalTemplates, placeholderForTemplate, templateOpensDesk, templateOpensYoutube } from "./goal-templates";
import type { GoalTemplateId } from "./goal-templates";
import { ProgressRail, RunHistoryRail } from "./progress-rail";
import { YoutubeSummaryForm } from "./youtube-summary-form";

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

/** First-run quick starts — dropped into the composer as an editable draft
 *  (never auto-submitted). Shown on the landing only while the session has
 *  no runs yet. */
const EXAMPLE_GOALS = [
  "Research the current state of solid-state batteries and write a brief",
  "Analyze BTC's price action this month and chart it",
  "Draft a one-page project proposal for a customer portal",
];

export interface WorkbenchPageProps {
  /** Knowledge integration for the composer's @ menu + image drop. */
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  /** Import file handler — returns the imported office files (for auto-attach). */
  onAddFiles?: () => Promise<{ id: string; originalName: string; ext: string }[] | undefined> | undefined;
  onAddLink?: () => void;
  /** App-owned: open the nav drawer (the mobile nav lives outside the
   *  Workbench — the landing header's hamburger calls it). */
  onOpenNav?: () => void;
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
  onOpenNav,
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
    logInfo("workbench", "auto-switch to new run", { runId: activeRunId });
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
  // Landing goal template (single-select, null = none). Research-flavored
  // picks disclose the Analysis Desk panel; the rest reframe the composer's
  // placeholder. Reset whenever the landing is re-entered fresh.
  const [template, setTemplate] = useState<GoalTemplateId | null>(null);
  // Mobile progress drawer (below lg the sidebar IS a drawer — opened from
  // the run view's top bar, auto-opened when the plan needs the user).
  const [mobileRail, setMobileRail] = useState(false);

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
  /** Double-submit guard: submit is synchronous up to its gates, so this
   *  flips false again only after the returned promise settles. */
  const startingRef = useRef(false);
  /** Two-step Esc stop: the first press arms (toast hint), a second press
   *  within 2s stops. A stray Esc ("close this" reflex after clicking a
   *  report button) must not kill a long run; the rail's Stop button stays
   *  the one-click path. Timestamp self-expires — no timer cleanup. */
  const escStopArmedAt = useRef(0);

  /** Landing → run view handoff. The planning baseline is captured at SUBMIT
   *  time (planStarted fires later, inside the run) and applied here — onStart
   *  only runs once every gate passed, so a blocked submit never leaves the
   *  landing or clears the composer's draft. Below lg the progress sidebar is
   *  a drawer: surface it immediately so planning/progress is reachable. */
  const enterRunView = useCallback((baseline: number | null) => {
    setHome(false);
    // Canvas policy (same as Run 1): drop the pinned view so the canvas
    // defaults to the newest run with doc "final" — the new run's prompt
    // shows in the header immediately, and the once-per-run auto-switch
    // takes over when its first content lands.
    setView(null);
    setStealAllowed(true);
    planStartedBaseline.current = baseline;
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) setMobileRail(true);
  }, []);

  /** Back to the landing hero — keeps the session + runs ("New goal"
   *  semantics). Blocked while a plan is in flight or awaiting review: the
   *  run view must keep showing progress (there is no way back mid-run). */
  const goHome = useCallback(() => {
    if (supervisor.planning != null || runInFlight || supervisor.status === "reviewing") return;
    setView(null);
    autoSwitchedRun.current = null;
    setTemplate(null);
    setMobileRail(false);
    setHome(true);
  }, [supervisor.planning, runInFlight, supervisor.status]);

  /** Submit a goal. Navigation to the run view happens INSIDE run()'s onStart
   *  (every gate passed). A rejection keeps the composer's draft — PromptInput
   *  clears only when the returned promise resolves — and the failure surfaces
   *  on the landing (`sessionError`) instead of as a silent no-op. */
  const submit = (text: string, fileIds?: string[]) => {
    if (!text.trim()) return;
    // A plan awaiting review owns the rail — new goals wait until it is run
    // or discarded. REJECT (not return) so the composer keeps the draft.
    if (supervisor.status === "reviewing") throw new Error("A plan is awaiting your review — run or discard it first");
    if (startingRef.current) throw new Error("Submit already in progress");
    startingRef.current = true;
    const quote = workbench.followUp;
    const baseline = supervisor.planStartedAt;
    return new Promise<void>((resolve, reject) => {
      void workbench.run(text, fileIds, { quote, onStart: () => enterRunView(baseline) }).then(
        () => {
          startingRef.current = false;
          resolve();
        },
        (err) => {
          startingRef.current = false;
          reject(err);
        },
      );
    });
  };

  /** Analysis Desk submit (PLAN-analysis-desk): the FIXED stock-research
   *  pipeline for one ticker. Same canvas handoff as a goal submit — the
   *  desk streams the same SupervisorEvent lifecycle, so the rail, deliverable
   *  viewer, and AGENT REPORTS render it unchanged. */
  const submitDesk = useCallback(
    (ticker: string, tradeDate: string | undefined, analysts: string[] | undefined) => {
      if (supervisor.status === "reviewing") return;
      if (startingRef.current) return;
      startingRef.current = true;
      const baseline = supervisor.planStartedAt;
      void workbench.runDesk(ticker, tradeDate, analysts, { onStart: () => enterRunView(baseline) }).then(
        () => {
          startingRef.current = false;
        },
        () => {
          // Gates already toasted + sessionError'd (shown on the landing).
          startingRef.current = false;
        },
      );
    },
    [supervisor.status, supervisor.planStartedAt, workbench.runDesk, enterRunView],
  );

  /** YouTube Summary submit (PLAN-youtube-summary): one link in, the FIXED
   *  pipeline out. Same canvas handoff as a desk submit — the run streams the
   *  same SupervisorEvent lifecycle, so the rail, deliverable viewer, and
   *  AGENT REPORTS render it unchanged. */
  const submitYoutube = useCallback(
    (url: string) => {
      if (supervisor.status === "reviewing") return;
      if (startingRef.current) return;
      startingRef.current = true;
      const baseline = supervisor.planStartedAt;
      void workbench.runYoutube(url, { onStart: () => enterRunView(baseline) }).then(
        () => {
          startingRef.current = false;
        },
        () => {
          // Gates already toasted + sessionError'd (shown on the landing).
          startingRef.current = false;
        },
      );
    },
    [supervisor.status, supervisor.planStartedAt, workbench.runYoutube, enterRunView],
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
    setTemplate(null);
    setView(null);
    setMobileRail(false);
    setHome(true);
  }, [supervisor.planning, supervisor.status, supervisor.cancelPlan, runInFlight, workbench.startNewSession]);

  // Esc: close the mobile progress drawer, else two-step-stop a running plan
  // (see escStopArmedAt). Mirrors
  // the composer's editable-context rule — the composer opts back in via
  // data-chat-composer; dialogs and the App nav drawer own their own Esc.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-open-drawer]") != null) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest("[role=dialog]") != null) return;
      const inEditable = el != null && el.closest("input, textarea, select, [contenteditable=true]") != null;
      if (inEditable && el?.closest("[data-chat-composer]") == null) return;
      if (mobileRail) {
        e.preventDefault();
        setMobileRail(false);
        return;
      }
      if (supervisor.status === "stopping") return;
      if (["running", "awaitingConfirmation"].includes(supervisor.status)) {
        e.preventDefault();
        const now = Date.now();
        if (now - escStopArmedAt.current < 2000) {
          escStopArmedAt.current = 0;
          supervisor.stop();
        } else {
          escStopArmedAt.current = now;
          toast("Press Esc again to stop the run", { id: "esc-stop", duration: 2000 });
        }
      } else {
        escStopArmedAt.current = 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileRail, supervisor.status, supervisor.stop]);

  // Below lg the sidebar is a drawer — force it open when the plan needs the
  // user (confirmation gates, review) so the run can't stall invisibly.
  useEffect(() => {
    if (!["awaitingConfirmation", "reviewing"].includes(supervisor.status)) return;
    if (typeof window === "undefined" || !window.matchMedia("(max-width: 1023px)").matches) return;
    setMobileRail(true);
  }, [supervisor.status]);

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
          <span className="inline-flex items-center gap-1.5">
            {onOpenNav && (
              <button
                type="button"
                aria-label="Open navigation"
                title="Navigation"
                onClick={onOpenNav}
                className="text-muted-foreground hover:text-foreground -ml-1.5 rounded-lg p-1.5 transition-colors lg:hidden"
              >
                <Icon name="menu" className="size-4" />
              </button>
            )}
            <span className="text-foreground inline-flex items-center gap-1.5 font-mono text-xs font-bold tracking-wider uppercase">
              <Icon name="zap" className="text-primary size-4" />
              Kawai Workbench
            </span>
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
          <div className="w-full max-w-2xl text-left">
            <ChatComposer
              agentName="Workbench"
              chipDraft={chipDraft}
              disabled={composerStatus === "submitted"}
              lastUserText={workbench.lastUserText}
              onAddFiles={handleAddFiles}
              onAddLink={onAddLink}
              onImageToKnowledge={onImageToKnowledge}
              onSubmit={(text, fileIds) => submit(text, fileIds)}
              onStop={workbench.supervisor.stop}
              status={composerStatus}
              placeholder={placeholderForTemplate(template)}
              attachedFiles={workbench.attachedFiles}
              onRemoveAttachedFile={workbench.removeAttachedFile}
            />
            <p className="text-muted-foreground mt-3 font-mono text-xs">
              Attach knowledge files with @ — the run's agents can search them.
            </p>
            {/* Blocked submits reject the composer promise (draft kept) —
                this is where the WHY lands; before, it only toasted. */}
            {workbench.sessionError && (
              <p className="text-destructive mt-2 font-mono text-xs leading-snug break-words" role="alert">
                {workbench.sessionError}
              </p>
            )}
            {workbench.runs.length === 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">Try</span>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLE_GOALS.map((g) => (
                    <button
                      className="border-border text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground inline-flex items-center rounded-full border px-3 py-1 font-mono text-[11px] transition-colors"
                      key={g}
                      onClick={() => setChipDraft({ text: g, nonce: Date.now() })}
                      title="Drop this goal into the composer to edit"
                      type="button"
                    >
                      {g}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <GoalTemplates value={template} disabled={composerStatus === "submitted"} onChange={setTemplate} />
            {templateOpensDesk(template) && (
              <div className="mt-3">
                <AnalysisDeskForm disabled={composerStatus === "submitted"} onSubmit={submitDesk} />
              </div>
            )}
            {templateOpensYoutube(template) && (
              <div className="mt-3">
                <YoutubeSummaryForm disabled={composerStatus === "submitted"} onSubmit={submitYoutube} />
              </div>
            )}
          </div>
          {workbench.runs.length > 0 ? (
            <div className="w-full max-w-2xl text-left">
              <RunHistory
                onReopen={(runId) => {
                  setHome(false);
                  userPick(runId, "final");
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
      {/* Mobile: the progress sidebar is a drawer — a tap-outside backdrop
          closes it (Esc closes it too, see the keydown effect above). */}
      {mobileRail && (
        <button
          type="button"
          aria-label="Close progress panel"
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileRail(false)}
        />
      )}
      {/* Left: one sidebar — progress + timeline (scrolls), composer pinned at
           the bottom. Hidden below lg by default; open = overlay drawer. */}
      <aside
        className={`border-border/60 bg-background w-96 max-w-[88vw] shrink-0 flex-col border-r lg:flex ${
          mobileRail ? "fixed inset-y-0 left-0 z-50 flex shadow-xl lg:static lg:z-auto lg:shadow-none" : "hidden"
        }`}
      >
        {/* Drawer header (below lg): label + close affordance. */}
        <div className="border-border/60 flex items-center justify-between border-b px-3 py-2 lg:hidden">
          <span className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">Progress</span>
          <button
            type="button"
            aria-label="Close progress panel"
            title="Close"
            onClick={() => setMobileRail(false)}
            className="text-muted-foreground hover:text-foreground rounded-lg p-1.5 transition-colors"
          >
            <Icon name="x" className="size-4" />
          </button>
        </div>
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
            onNewGoal={goHome}
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
            <p className="text-muted-foreground mb-2 font-mono text-xs">
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
        {/* Mobile run-view chrome (the sidebar is a drawer below lg): nav +
            progress drawer + back-to-landing. */}
        <div className="border-border/60 flex items-center gap-1 border-b px-2 py-1.5 lg:hidden">
          {onOpenNav && (
            <button
              type="button"
              aria-label="Open navigation"
              title="Navigation"
              onClick={onOpenNav}
              className="text-muted-foreground hover:text-foreground rounded-lg p-1.5 transition-colors"
            >
              <Icon name="menu" className="size-4" />
            </button>
          )}
          <button
            type="button"
            aria-label="Open progress panel"
            title="Progress"
            onClick={() => setMobileRail(true)}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors"
          >
            <Icon name="panel-left" className="size-4" />
            <span className="font-mono text-[10px] tracking-wider uppercase">Progress</span>
          </button>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Back to goal composer"
            title="New goal"
            disabled={supervisor.planning != null || runInFlight || supervisor.status === "reviewing"}
            onClick={goHome}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors disabled:opacity-40"
          >
            <Icon name="arrow-left" className="size-4" />
          </button>
        </div>
        {workbench.runs.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-center font-mono text-sm">
            {EMPTY_RUNS_HINT}
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
                      onPickDoc={(doc) => userPick(shown.id, doc)}
                      onAsk={workbench.askAboutResult}
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
                    onPickDoc={(doc) => {
                      if (activeRunId != null) userPick(activeRunId, doc);
                    }}
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
