import { useCallback, useEffect, useState } from "react";
import { LinkDialog, PreviewDialog } from "@/components/knowledge-dialogs";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import { useKnowledgeActions } from "@/hooks/use-knowledge-actions";
import { useLocalChat } from "@/hooks/use-local-chat";
import { useContextOnboarding } from "@/hooks/use-context-onboarding";
import { type AgentInfo, call } from "@/lib/api";
import { logWarn } from "@/lib/logger";
import { OPEN_PREVIEW_EVENT, type OpenPreviewDetail } from "@/lib/preview-bridge";
import { AgentsRail, agentPresentation } from "@/panels/agents-rail";
import type { AssetViewId } from "@/panels/assets/asset-nav";
import { CodeAssetPage } from "@/panels/assets/code-page";
import { MemoryAssetPage } from "@/panels/assets/memory-page";
import { SkillsAssetPage } from "@/panels/assets/skills-page";
import { WikiAssetPage } from "@/panels/assets/wiki-page";
import { ContextPanel } from "@/panels/context-panel";
import { contextTabsFor } from "@/panels/registry";
import { ConversationPanel } from "@/panels/conversation-panel";
import { SessionsPanel } from "@/panels/sessions-panel";

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentsRail, setAgentsRail] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [assetView, setAssetView] = useState<AssetViewId | null>(null);
  const [mobileDrawer, setMobileDrawer] = useState<null | "agents" | "sessions" | "knowledge">(null);

  useEffect(() => {
    let disposed = false;
    call<AgentInfo[]>("list_agents")
      .then((catalog) => {
        if (!disposed && catalog.length) setAgents(catalog);
      })
      .catch((err) => logWarn("list_agents", err));
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (agents.length && activeAgentId == null) setActiveAgentId(agents[0].id);
  }, [agents, activeAgentId]);

  const agent = (activeAgentId != null && agents.find((a) => a.id === activeAgentId)) || agents[0] || null;
  const presentation = agent ? agentPresentation(agent.id) : agentPresentation("");
  const chat = useLocalChat(agent ?? { id: "", tools: false });
  const { status } = chat;
  const busy = status === "submitted" || status === "streaming";
  const inSession = chat.sessionId != null || chat.messages.length > 0;

  const onSend = useCallback(
    (text: string, fileIds?: string[]) => {
      void chat.send(text, fileIds);
    },
    [chat],
  );

  const ka = useKnowledgeActions(chat);

  // Per-agent right-pane composition + empty-data onboarding policy — both
  // registry-driven; App only wires shell capabilities (canvas/drawer) in.
  const contextTabs = contextTabsFor(agent);
  const hasContextPane = contextTabs.length > 0;
  const { onboarding, sourcesFocus } = useContextOnboarding({
    agent,
    inSession,
    knowledgeLoaded: ka.knowledge.loaded,
    files: ka.knowledge.files,
    canvasOpen,
    mobileDrawer,
    openContextPane: () => {
      setCanvasOpen(true);
      setMobileDrawer((d) => d ?? "knowledge");
    },
    importFiles: () => void ka.addKnowledgeFiles(),
  });

  // Preview bridge: tool cards inside the vendored renderer tree emit an
  // event instead of threading app callbacks; resolve to a knowledge row
  // when the file is already listed, else synthesize one (tabular previews
  // only need id + name — data_preview does the rest).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { fileId, name } = (e as CustomEvent<OpenPreviewDetail>).detail;
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
        },
      );
    };
    window.addEventListener(OPEN_PREVIEW_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PREVIEW_EVENT, onOpen);
  }, [ka.setPreviewFile, ka.knowledge.files]);

  useEffect(() => {
    if (activeAgentId == null) return;
    void chat.selectAgent();
  }, [activeAgentId, chat.selectAgent]);

  useAppShortcuts({
    busy,
    onToggleAgentsRail: () => setAgentsRail((v) => !v),
    onToggleCanvas: () => setCanvasOpen((v) => !v),
    onToggleSessions: () => setSessionsCollapsed((v) => !v),
    onNewChat: () => void chat.newChat(),
  });

  // Esc stops generation (global, mirrors web/ chat-composer.tsx:450-461) —
  // but keeps its local meaning inside other editable contexts: renaming a
  // session, dialog inputs, etc. The main chat composer opts back in via
  // data-chat-composer so Esc stops the stream from where you're typing.
  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target;
      const el = target instanceof HTMLElement ? target : null;
      const inEditable =
        el != null &&
        (el.isContentEditable ||
          el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.closest("[role=dialog]") != null);
      if (inEditable && el?.closest("[data-chat-composer]") == null) return;
      e.preventDefault();
      chat.stop();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, chat]);

  // Esc closes mobile drawer when idle
  useEffect(() => {
    if (mobileDrawer == null || busy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileDrawer(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileDrawer, busy]);

  // Esc leaves the asset workspace back to chat (view-only switch, safe while
  // streaming — the stream keeps folding into chat state in the background).
  useEffect(() => {
    if (assetView == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssetView(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assetView]);

  const lastUserText = (() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role !== "user") continue;
      const t = m.parts.find((p) => p.type === "text")?.text;
      if (t) return t;
    }
    return null;
  })();

  if (!agent) {
    return <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center" />;
  }

  // Context pane — rendered only when the agent's registry composition has
  // tabs; reused for the desktop canvas and the mobile drawer.
  // Asset workspace — replaces the chat center pane while an asset view is
  // open (Wiki = knowledge base, Memory = raw conversations; Skills/Code have
  // no backend tier yet and state that plainly). Data comes from the same app
  // state the chat uses, so switching views never re-fetches or resets chat.
  const assetWorkspace =
    assetView === "wiki" ? (
      <WikiAssetPage
        confirmDeleteId={ka.confirmDeleteId}
        files={ka.knowledge.files}
        importing={ka.importing}
        loaded={ka.knowledge.loaded}
        sessionId={chat.sessionId}
        onAdd={ka.addToSession}
        onBack={() => setAssetView(null)}
        onDelete={ka.deleteFile}
        onImport={() => void ka.addKnowledgeFiles()}
        onRemove={ka.removeFromSession}
        onRetry={ka.retryIndex}
      />
    ) : assetView === "memory" ? (
      <MemoryAssetPage
        agents={agents}
        sessions={[...chat.sessions, ...chat.archivedSessions]}
        onBack={() => setAssetView(null)}
      />
    ) : assetView === "skills" ? (
      <SkillsAssetPage onBack={() => setAssetView(null)} />
    ) : assetView === "code" ? (
      <CodeAssetPage onBack={() => setAssetView(null)} />
    ) : null;

  const contextPanel = hasContextPane ? (
    <ContextPanel
      tabs={contextTabs}
      knowledge={ka.knowledge}
      sessionId={chat.sessionId}
      sessionFiles={ka.sessionFiles}
      importing={ka.importing}
      linking={ka.linking}
      confirmDeleteId={ka.confirmDeleteId}
      focus={sourcesFocus ? { tab: "sources", n: sourcesFocus } : undefined}
      onAddFiles={() => void ka.addKnowledgeFiles()}
      onAddLink={ka.addKnowledgeLink}
      onAddToSession={ka.addToSession}
      onRemoveFromSession={ka.removeFromSession}
      onRetryIndex={ka.retryIndex}
      onDeleteFile={ka.deleteFile}
      onPreview={ka.openPreview}
    />
  ) : null;

  return (
    <div className="bg-background text-foreground flex h-dvh w-full overflow-hidden">
      <div className="hidden shrink-0 md:flex">
        <AgentsRail
          agents={agents}
          activeAgentId={activeAgentId}
          assetView={assetView}
          collapsed={agentsRail}
          userId={chat.userId}
          busy={busy}
          onSelectAgent={(id) => {
            if (busy && id !== activeAgentId) return;
            setAssetView(null);
            setActiveAgentId(id);
          }}
          onSelectAsset={(id) => setAssetView(id)}
          onToggle={() => setAgentsRail((v) => !v)}
        />
      </div>

      {assetWorkspace ?? (
        <ConversationPanel
          agent={agent}
          presentation={presentation}
          messages={chat.messages}
          status={status}
          sessionId={chat.sessionId}
          sessions={chat.sessions}
          modelLoading={chat.modelLoading}
          modelError={chat.modelError}
          modelStatus={chat.modelStatus}
          thinking={chat.thinking}
          onToggleThinking={() => void chat.toggleThinking()}
          onRetryModel={() => void chat.reloadModel()}
          chatError={chat.error}
          historyError={chat.historyError}
          onRetryHistory={() => void chat.retryHistoryLoad()}
          lastUserText={lastUserText}
          onStop={chat.stop}
          onSend={onSend}
          confirmation={chat.confirmation}
          inSession={inSession}
          sessionsCollapsed={sessionsCollapsed}
          onToggleSessions={() => setSessionsCollapsed((v) => !v)}
          onImageToKnowledge={ka.imageToKnowledge}
          onboarding={onboarding}
          onOpenMobileAgents={() => setMobileDrawer("agents")}
          onOpenMobileSessions={() => setMobileDrawer("sessions")}
          onOpenMobileKnowledge={hasContextPane ? () => setMobileDrawer("knowledge") : undefined}
          canvasOpen={canvasOpen}
          onToggleCanvas={hasContextPane ? () => setCanvasOpen((v) => !v) : undefined}
          canvas={canvasOpen ? contextPanel : null}
        />
      )}

      {!sessionsCollapsed && assetView == null && (
        <div className="hidden shrink-0 md:flex">
          <SessionsPanel
            agent={agent}
            railCollapsed={agentsRail}
            groupedSessions={chat.groupedSessions}
            archivedSessions={chat.archivedSessions.filter((s) => s.agentId === agent.id)}
            activeSessionId={chat.sessionId}
            busy={busy}
            onNewChat={() => void chat.newChat()}
            onSelectSession={(id) => void chat.selectSession(id)}
            onDeleteSession={(id) => void chat.deleteSession(id)}
            onRenameSession={(id, title) => void chat.renameSession(id, title)}
            onArchiveSession={(id, archived) => void chat.setSessionArchived(id, archived)}
          />
        </div>
      )}

      {/* Mobile drawers — replace hidden rails under 768px */}
      {mobileDrawer && (
        <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileDrawer(null)}
            type="button"
          />
          {mobileDrawer === "agents" && (
            <div className="bg-background relative flex h-full w-[210px] max-w-[85vw] flex-col shadow-xl">
              <AgentsRail
                agents={agents}
                activeAgentId={activeAgentId}
                assetView={assetView}
                collapsed={false}
                userId={chat.userId}
                busy={busy}
                onSelectAgent={(id) => {
                  if (busy && id !== activeAgentId) return;
                  setAssetView(null);
                  setActiveAgentId(id);
                  setMobileDrawer(null);
                }}
                onSelectAsset={(id) => {
                  setAssetView(id);
                  setMobileDrawer(null);
                }}
                onToggle={() => setMobileDrawer(null)}
              />
            </div>
          )}
          {mobileDrawer === "sessions" && (
            <div className="bg-background relative ml-auto flex h-full w-[240px] max-w-[85vw] flex-col shadow-xl">
              <SessionsPanel
                agent={agent}
                railCollapsed={false}
                groupedSessions={chat.groupedSessions}
                archivedSessions={chat.archivedSessions.filter((s) => s.agentId === agent.id)}
                activeSessionId={chat.sessionId}
                busy={busy}
                onNewChat={() => {
                  void chat.newChat();
                  setMobileDrawer(null);
                }}
                onSelectSession={(id) => {
                  void chat.selectSession(id);
                  setMobileDrawer(null);
                }}
                onDeleteSession={(id) => void chat.deleteSession(id)}
                onRenameSession={(id, title) => void chat.renameSession(id, title)}
                onArchiveSession={(id, archived) => void chat.setSessionArchived(id, archived)}
              />
            </div>
          )}
          {mobileDrawer === "knowledge" && contextPanel && (
            <div className="bg-background relative ml-auto flex h-full w-[360px] max-w-[90vw] flex-col shadow-xl">
              <button
                aria-label="Close knowledge"
                className="bg-background/80 hover:bg-accent absolute top-2 right-2 z-10 rounded-md border px-2 py-1 text-xs shadow-sm"
                onClick={() => setMobileDrawer(null)}
                type="button"
              >
                Close
              </button>
              <div className="min-h-0 flex-1 overflow-hidden pt-0">{contextPanel}</div>
            </div>
          )}
        </div>
      )}

      <PreviewDialog file={ka.previewFile} onClose={() => ka.setPreviewFile(null)} />
      <LinkDialog
        open={ka.linkPromptOpen}
        onOpenChange={ka.setLinkPromptOpen}
        linking={ka.linking}
        linkUrl={ka.linkUrl}
        setLinkUrl={ka.setLinkUrl}
        onSubmit={ka.submitKnowledgeLink}
      />
    </div>
  );
}
