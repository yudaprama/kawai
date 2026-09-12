import { ZapIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/features/chat/components/chat-composer";
import { isDeliverableStep, useWorkbench } from "@/features/workbench/hooks/use-workbench";

import { DeliverableViewer, PastRunCanvas, RunHistory, RunSwitcher } from "./deliverable-viewer";
import type { CanvasView } from "./deliverable-viewer";
import { ComposerQuoteBadge, FollowUpChips } from "./follow-up-composer";
import { GoalComposer } from "./goal-composer";
import { ProgressRail, RunHistoryRail } from "./progress-rail";

// ── Page ────────────────────────────────────────────────────────────────────

export interface WorkbenchPageProps {
  /** Knowledge integration for the composer's @ menu + image drop. */
  onImageToKnowledge: (dataUrl: string, name: string) => Promise<string[]>;
  onAddFiles?: () => void;
  onAddLink?: () => void;
}

/** The kawai Workbench — the work-centric primary surface (PLAN-workbench.md).
 *  Left: a single sidebar — progress phases + Messages & Tools timeline, with
 *  the goal composer pinned at the bottom. Right: the deliverable. Results
 *  never enter chat. */
export function WorkbenchPage({ onImageToKnowledge, onAddFiles, onAddLink }: WorkbenchPageProps) {
  const workbench = useWorkbench();
  const { supervisor } = workbench;
  // Home = the landing composer. Submitting a goal moves to the workbench;
  // "New goal" returns here.
  const [home, setHome] = useState(true);
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
  const userPick = (runId: string, doc: string) => {
    setStealAllowed(false);
    setView({ runId, doc });
  };

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

  /** Rail "see report" — a user pick. The steps shown in the rail belong to
   *  the active run once seeded, otherwise (planning) to the previous run. */
  const openReport = (id: string) => {
    const owner = seededForActiveRun ? activeRunId : (workbench.runs.at(-2)?.id ?? activeRunId);
    if (owner != null) userPick(owner, id);
  };
  // Chip click → draft dropped into the input for editing (not auto-submit).
  const [chipDraft, setChipDraft] = useState<{ text: string; nonce: number } | null>(null);
  const chipClicked = (text: string) => {
    workbench.setFollowUp(true);
    setChipDraft({ text, nonce: Date.now() });
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
  const composerStatus = ["running", "stopping", "awaitingConfirmation"].includes(supervisor.status)
    ? ("submitted" as const)
    : ("ready" as const);

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
            <ZapIcon className="text-primary size-4" />
            Kawai Workbench
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
          <div className="space-y-2">
            <p className="text-foreground inline-flex items-center gap-2 text-lg font-semibold">
              <ZapIcon className="text-primary size-6" />
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
              lastUserText={null}
              onAddFiles={onAddFiles}
              onAddLink={onAddLink}
              onImageToKnowledge={onImageToKnowledge}
              onSubmit={(text, fileIds) => submit(text, fileIds)}
              onStop={workbench.supervisor.stop}
              status={composerStatus}
            />
            <p className="text-muted-foreground mt-3 text-left font-mono text-[10px]">
              Attach knowledge files with @ — the run's agents can search them.
            </p>
          </div>
          {workbench.runs.length > 0 && (
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
          {workbench.runs.length > 0 && (
            <div className="text-muted-foreground mb-2 font-mono text-[10px] tracking-wider uppercase">
              Session · {workbench.runs.length} run{workbench.runs.length === 1 ? "" : "s"}
            </div>
          )}
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
            onAddFiles={onAddFiles}
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
                      onPickDoc={(d) => userPick(shown.id, d)}
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
                    onPickDoc={(d) => activeRunId != null && userPick(activeRunId, d)}
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
