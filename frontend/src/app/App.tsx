import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { LinkDialog, PreviewDialog } from "@/features/knowledge/components/knowledge-dialogs";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import { overlayOwnsEscape } from "@/lib/esc";
import { useKnowledgeActions } from "@/features/knowledge/hooks/use-knowledge-actions";
import { useSupervisorChat } from "@/features/chat/hooks/use-supervisor-chat";
import { WorkbenchPage } from "@/features/workbench/components/workbench-page";
import { AssetChromeContext } from "@/features/assets/components/asset-chrome";
import { type AgentInfo, call, codegraphIsAvailable, tauriOpenFile, errText } from "@/lib/api";
import { logWarn } from "@/lib/logger";
import { OPEN_PREVIEW_EVENT, type OpenPreviewDetail } from "@/lib/preview-bridge";
import { runningInTauri } from "@/platform";
import { AssetNavList } from "@/features/assets/components/asset-nav-list";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { tauriWalletAdapter } from "@/features/wallet/lib/wallet-adapter";
import { CodeAssetPage } from "@/features/codegraph/components/code-page";
import { MemoryAssetPage } from "@/features/memory/components/memory-page";
import { SkillsAssetPage } from "@/features/skills/components/skills-page";
import { ConnectionsPage } from "@/features/connector/components/connections-page";
import { WikiAssetPage } from "@/features/assets/pages/wiki-page";
import { SqlSourcesAssetPage } from "@/features/assets/pages/sql-sources-page";
import { WalletPage } from "@/features/wallet/components/wallet-page";
import { OPEN_TOPUP_EVENT } from "@/features/topup/open-topup";
import { TopupPage } from "@/features/topup/topup-page";
import { GeneratorPage } from "@/features/generator/generator-page";
import { ModeBar } from "@/app/mode-bar";
import { type AppMode, isMediaMode } from "@/app/modes";
import { SessionHistoryDialog } from "@/features/chat/components/session-history-dialog";
import { ShortcutsDialog } from "@/components/shared/shortcuts-dialog";
import { Dialog, DialogContent, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";

export default function App() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  // Two orthogonal axes. `mode` is the top-level surface the mode bar owns —
  // `text` IS the Workbench, the other four are the generation lanes. `view`
  // is an ASSET page, a deeper layer opened from the account cluster; it wins
  // the center pane while set, and the bar then shows no active mode (an asset
  // is not a mode — lighting up "Text" there would claim the Workbench shows).
  const [mode, setMode] = useState<AppMode>("text");
  const [view, setView] = useState<AssetViewId | null>(null);
  const [codeGraphSeed, setCodeGraphSeed] = useState<{ query: string; result: string } | null>(null);
  // The backend compiles Monad support behind the opt-in `monad` feature; probe
  // once so the wallet nav entry only appears in builds that have it.
  const [walletAvailable, setWalletAvailable] = useState(false);
  useEffect(() => {
    void tauriWalletAdapter.isAvailable().then(setWalletAvailable);
  }, []);
  const [codegraphAvailable, setCodegraphAvailable] = useState(false);
  useEffect(() => {
    void codegraphIsAvailable()
      .then(setCodegraphAvailable)
      .catch(() => {});
  }, []);
  const [mobileDrawer, setMobileDrawer] = useState<null | "agents">(null);
  // Workbench publishes its selectSession here (App owns the dialog; the
  // workbench keeps its own session state separate from the chat hook).
  const workbenchSelectRef = useRef<((id: number) => void) | null>(null);
  // Workbench publishes its own reset here (App owns the "New" button +
  // Cmd/Ctrl+N; the workbench keeps its runs/session/view state, so the chat
  // hook's newChat() alone is invisible on that surface).
  const workbenchNewRef = useRef<(() => void) | null>(null);
  // Workbench publishes its attachFiles here (App owns the LinkDialog; a
  // successful YouTube import auto-attaches the transcript as a composer chip
  // — same UX as the file-import auto-attach).
  const workbenchAttachRef = useRef<((files: { id: string; originalName: string; ext: string }[]) => void) | null>(
    null,
  );

  // Backend-readiness gate: the shell renders once the agent catalog answers.
  // A failure surfaces as an error card with Retry — a bare catch left an
  // empty window until restart. `auto` mode has no agent picker; the catalog
  // only proves the backend is up.
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agentsAttempt, setAgentsAttempt] = useState(0);
  useEffect(() => {
    void agentsAttempt; // retry trigger — a bump refetches the catalog
    let disposed = false;
    setAgentsError(null);
    call<AgentInfo[]>("list_agents")
      .then((catalog) => {
        if (disposed) return;
        if (!catalog.length) {
          setAgentsError("The backend returned an empty agent catalog.");
          return;
        }
        setAgents(catalog);
      })
      .catch((err) => {
        logWarn("list_agents", err);
        if (!disposed) setAgentsError(errText(err));
      });
    return () => {
      disposed = true;
    };
  }, [agentsAttempt]);

  const chat = useSupervisorChat();
  const { status } = chat;
  const busy = status === "submitted" || status === "streaming";

  const ka = useKnowledgeActions(chat);

  // Empty-data onboarding (analytics only) — the "Connect database" CTA opens
  // the Databases asset page; import rides the knowledge file dialog.

  // Preview bridge: tool cards inside the vendored renderer tree emit an
  // event instead of threading app callbacks; resolve to a knowledge row
  // when the file is already listed, else synthesize one (tabular previews
  // only need id + name — data_preview does the rest).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { fileId, name } = (e as CustomEvent<OpenPreviewDetail>).detail;
      // On desktop: PDFs open directly in the OS viewer — no in-app modal needed.
      if (runningInTauri && name.split(".").pop()?.toLowerCase() === "pdf") {
        tauriOpenFile(fileId).catch((err) => logWarn("preview-bridge", errText(err)));
        return;
      }
      const known = ka.knowledge.files.find((f) => f.id === fileId);
      ka.setPreviewFile(
        known ?? {
          id: fileId,
          originalName: name,
          ext: (name.split(".").pop() ?? "").toLowerCase(),
          bytes: 0,
          createdAt: 0,
          status: "not_indexed",
          chunks: 0,
          error: null,
          inSession: true,
          raw: null,
        },
      );
    };
    window.addEventListener(OPEN_PREVIEW_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PREVIEW_EVENT, onOpen);
  }, [ka.setPreviewFile, ka.knowledge.files]);

  // Top Up navigation — the Fase 0a token gate at goal submit opens the Top
  // Up asset page (App owns `view`; same window-event bridge as previews).
  useEffect(() => {
    const onOpen = () => {
      setView("topup");
      setMobileDrawer(null);
    };
    window.addEventListener(OPEN_TOPUP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TOPUP_EVENT, onOpen);
  }, []);

  /** Mode-bar pick: leave any asset page and land on the chosen mode. Media
   *  lanes are not assets — they are modes — so this also clears `view`. */
  const selectMode = (next: AppMode) => {
    setMode(next);
    setView(null);
    setMobileDrawer(null);
  };

  // App-level "New" (rail button + Cmd/Ctrl+N): return to the Text mode, close
  // any asset view, then reset both shells — the chat hook (knowledge/
  // session-dialog binding) and the WORKBENCH's own reset (fresh session back
  // at the landing hero). No-op mid-run: the workbench handler guards an
  // in-flight plan.
  const handleNew = () => {
    setMode("text");
    setView(null);
    setMobileDrawer(null);
    void chat.newChat();
    workbenchNewRef.current?.();
  };

  useAppShortcuts({
    busy,
    onNewChat: handleNew,
    onOpenSessions: () => setSessionsOpen(true),
  });

  // "?" opens the shortcut cheat sheet — ignored while typing (editable
  // fields, including the composer where "?" is literal text) and inside
  // other dialogs.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || shortcutsOpen) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el?.closest("input, textarea, select, [contenteditable=true], [role=dialog]") != null) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutsOpen]);

  // Esc closes mobile drawer when idle
  useEffect(() => {
    if (mobileDrawer == null || busy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A dialog/menu/popup in front owns Esc; the drawer must stand down.
        if (overlayOwnsEscape()) return;
        setMobileDrawer(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileDrawer, busy]);

  // Esc leaves any non-Text surface — an asset page or a generation lane —
  // back to the Workbench (view-only switch, safe while streaming: the run
  // keeps folding into workbench state in the background). On the Workbench
  // App stands down; that page owns Esc there (two-step run stop).
  useEffect(() => {
    if (view == null && mode === "text") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A dialog/menu/popup in front owns Esc; the pane must stand down.
        if (overlayOwnsEscape()) return;
        setMode("text");
        setView(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, view]);

  const touchStartX = useRef(0);
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (dx < -60 && mobileDrawer) setMobileDrawer(null);
  };
  if (agentsError != null) {
    return (
      <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center p-6">
        <div className="bg-card border-border w-full max-w-sm space-y-3 rounded-lg border p-6 text-center">
          <p className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">
            {t("errors.startWorkbench")}
          </p>
          <p className="text-muted-foreground font-mono text-xs leading-snug break-words" role="alert">
            {agentsError}
          </p>
          <Button size="sm" variant="outline" onClick={() => setAgentsAttempt((a) => a + 1)}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }
  if (agents.length === 0) {
    return (
      <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center gap-2">
        <Icon name="loader-circle" className="text-primary size-4 animate-spin" />
        <span className="text-muted-foreground font-mono text-xs">{t("common.loading")}</span>
      </div>
    );
  }

  // Asset workspace — replaces the center pane while an asset is open (Wiki =
  // knowledge base, Databases = SQL sources, Memory = raw conversations).
  // Data comes from the same app state the workbench uses, so switching never
  // re-fetches or resets a run. Media GENERATION is not an asset — it is a
  // mode, so it renders from `mode` below, not from this switch.
  const backToText = () => {
    setMode("text");
    setView(null);
  };
  const assetWorkspace =
    view === "wiki" ? (
      <WikiAssetPage
        confirmDeleteId={ka.confirmDeleteId}
        error={ka.knowledge.error}
        files={ka.knowledge.files}
        importing={ka.importing}
        loading={ka.knowledge.loading}
        loaded={ka.knowledge.loaded}
        onRefresh={() => void ka.knowledge.refresh()}
        sessionId={chat.sessionId}
        unavailable={ka.knowledge.unavailable}
        onAdd={ka.addToSession}
        onBack={backToText}
        onDelete={ka.deleteFile}
        onImport={() => void ka.addKnowledgeFiles()}
        onRemove={ka.removeFromSession}
        onRetry={ka.retryIndex}
      />
    ) : view === "memory" ? (
      <MemoryAssetPage
        onRetrySessions={() => void chat.refreshSessions()}
        sessions={[...chat.sessions, ...chat.archivedSessions]}
        sessionsError={chat.sessionsError}
        sessionsLoading={chat.sessionsLoading}
        onBack={backToText}
      />
    ) : view === "sources" ? (
      <SqlSourcesAssetPage onBack={backToText} />
    ) : view === "skills" ? (
      <SkillsAssetPage onBack={backToText} />
    ) : view === "connections" ? (
      <ConnectionsPage onBack={backToText} />
    ) : view === "code" ? (
      <CodeAssetPage
        initialQuery={codeGraphSeed?.query}
        initialResult={codeGraphSeed?.result}
        onBack={() => {
          setCodeGraphSeed(null);
          backToText();
        }}
      />
    ) : view === "wallet" ? (
      <WalletPage onBack={backToText} />
    ) : view === "topup" ? (
      <TopupPage onBack={backToText} />
    ) : null;

  const assetChrome = {
    assetView: view,
    walletAvailable,
    codegraphAvailable,
    onSelectAsset: (id: AssetViewId) => {
      setView(id);
      setMobileDrawer(null);
    },
  };

  return (
    <div className="bg-background text-foreground flex h-dvh w-full flex-col overflow-clip">
      <ModeBar
        active={view == null ? mode : null}
        assetView={view}
        codegraphAvailable={codegraphAvailable}
        onLogout={() => void chat.logout()}
        onSelect={selectMode}
        onSelectAsset={(id) => {
          setView(id);
          setMobileDrawer(null);
        }}
        userId={chat.userId}
        walletAvailable={walletAvailable}
      />
      <div className="flex min-h-0 min-w-0 flex-1">
        {assetWorkspace ? (
          <AssetChromeContext.Provider value={assetChrome}>{assetWorkspace}</AssetChromeContext.Provider>
        ) : isMediaMode(mode) ? (
          // Lanes come and go with the bar, so the shell re-mounts per lane —
          // every lane restores its results + in-flight job from localStorage.
          <GeneratorPage key={mode} lane={mode} />
        ) : (
          <WorkbenchPage
            onAddFiles={ka.addKnowledgeFiles}
            onAddLink={ka.addKnowledgeLink}
            onImageToKnowledge={ka.imageToKnowledge}
            onOpenNav={() => setMobileDrawer("agents")}
            onOpenSessions={() => setSessionsOpen(true)}
            sessionsOpen={sessionsOpen}
            sessionSelectorRef={workbenchSelectRef}
            newSessionRef={workbenchNewRef}
            attachFilesRef={workbenchAttachRef}
          />
        )}
      </div>
      {/* Mobile drawer — the nav list under 1024px (the profile dropdown is
          desktop-side; the drawer gives small screens the same entries).
          Uses Dialog primitive for proper focus management, focus trapping,
          and accessibility (ARIA, Escape handling, portal rendering). */}
      <Dialog open={mobileDrawer !== null} onOpenChange={() => setMobileDrawer(null)}>
        <DialogPortal>
          <DialogOverlay className="lg:hidden" />
          <DialogContent
            aria-label={t("assetNav.mobileDrawerTitle")}
            className={cn(
              "fixed inset-y-0 left-0 z-50 w-[210px] max-w-[85vw] p-3 shadow-xl",
              "data-[state=open]:animate-in data-[state=open]:slide-in-from-left",
              "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left",
              "lg:hidden",
            )}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <AssetNavList {...assetChrome} orientation="vertical" />
          </DialogContent>
        </DialogPortal>
      </Dialog>
      <SessionHistoryDialog
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        groupedSessions={chat.groupedSessions}
        archivedSessions={chat.archivedSessions}
        activeSessionId={chat.sessionId}
        busy={busy}
        sessionsLoading={chat.sessionsLoading}
        sessionsError={chat.sessionsError}
        onRetrySessions={chat.refreshSessions}
        onSelectSession={(id) => {
          // Prefer the workbench session (its restore effect rehydrates runs
          // + deliverable); fall back to the chat hook when the workbench
          // isn't mounted (an asset page owns the screen).
          if (workbenchSelectRef.current) workbenchSelectRef.current(id);
          else void chat.selectSession(id);
        }}
        onSearchSessions={chat.searchSessions}
        onDeleteSessions={(ids) => void chat.deleteSessions(ids)}
        onRenameSession={(id, title) => void chat.renameSession(id, title)}
        onArchiveSessions={(ids, archived) => chat.setSessionsArchived(ids, archived)}
        onExportSession={async (session) => {
          const file = await chat.exportSession(session);
          if (file) {
            ka.setPreviewFile({
              id: file.id,
              originalName: file.originalName,
              ext: "md",
              bytes: file.bytes,
              createdAt: Math.floor(Date.now() / 1000),
              status: "not_indexed",
              chunks: 0,
              error: null,
              inSession: true,
              raw: null,
            });
          }
          return file;
        }}
      />
      <PreviewDialog file={ka.previewFile} onClose={() => ka.setPreviewFile(null)} />
      <ShortcutsDialog onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
      <LinkDialog
        open={ka.linkPromptOpen}
        onOpenChange={ka.setLinkPromptOpen}
        linking={ka.linking}
        linkUrl={ka.linkUrl}
        setLinkUrl={ka.setLinkUrl}
        error={ka.linkError}
        onSubmit={async () => {
          const file = await ka.submitKnowledgeLink();
          if (file) workbenchAttachRef.current?.([file]);
        }}
      />
    </div>
  );
}
