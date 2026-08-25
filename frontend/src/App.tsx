import { useCallback, useEffect, useState } from "react";
import { useLocalChat } from "@/hooks/use-local-chat";
import { useKnowledgeActions } from "@/hooks/use-knowledge-actions";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import { call, type AgentInfo } from "@/lib/api";
import { logWarn } from "@/lib/logger";
import { LinkDialog, PreviewDialog } from "@/components/knowledge-dialogs";
import { AgentsRail, agentPresentation } from "@/panels/agents-rail";
import { ConversationPanel } from "@/panels/conversation-panel";
import { KnowledgePanel } from "@/panels/knowledge-panel";
import { SessionsPanel } from "@/panels/sessions-panel";

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentsRail, setAgentsRail] = useState(false);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(true);
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

  const agent =
    (activeAgentId != null && agents.find((a) => a.id === activeAgentId)) || agents[0] || null;
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

  useEffect(() => {
    void chat.selectAgent();
  }, [activeAgentId]);

  useAppShortcuts({
    busy,
    onToggleAgentsRail: () => setAgentsRail((v) => !v),
    onToggleCanvas: () => setCanvasOpen((v) => !v),
    onToggleSessions: () => setSessionsCollapsed((v) => !v),
    onNewChat: () => void chat.newChat(),
  });

  // Esc stops generation (global, mirrors web/ chat-composer.tsx:450-461)
  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        chat.stop();
      }
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

  // Reusable knowledge props for desktop + mobile drawer
  const knowledgePanel = (
    <KnowledgePanel
      knowledge={ka.knowledge}
      sessionId={chat.sessionId}
      sessionFiles={ka.sessionFiles}
      importing={ka.importing}
      linking={ka.linking}
      confirmDeleteId={ka.confirmDeleteId}
      onAddFiles={() => void ka.addKnowledgeFiles()}
      onAddLink={ka.addKnowledgeLink}
      onAddToSession={ka.addToSession}
      onRemoveFromSession={ka.removeFromSession}
      onRetryIndex={ka.retryIndex}
      onDeleteFile={ka.deleteFile}
      onPreview={ka.openPreview}
    />
  );

  return (
    <div className="bg-background text-foreground flex h-dvh w-full overflow-hidden">
      <div className="hidden shrink-0 md:flex">
        <AgentsRail
          agents={agents}
          activeAgentId={activeAgentId}
          collapsed={agentsRail}
          userId={chat.userId}
          busy={busy}
          onSelectAgent={(id) => {
            if (busy && id !== activeAgentId) return;
            setActiveAgentId(id);
          }}
          onToggle={() => setAgentsRail((v) => !v)}
        />
      </div>

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
        canvasOpen={canvasOpen}
        inSession={inSession}
        sessionsCollapsed={sessionsCollapsed}
        onToggleCanvas={() => setCanvasOpen((v) => !v)}
        onToggleSessions={() => setSessionsCollapsed((v) => !v)}
        onImageToKnowledge={ka.imageToKnowledge}
        onOpenMobileAgents={() => setMobileDrawer("agents")}
        onOpenMobileSessions={() => setMobileDrawer("sessions")}
        onOpenMobileKnowledge={() => setMobileDrawer("knowledge")}
        canvas={canvasOpen ? knowledgePanel : null}
      />

      {!sessionsCollapsed && (
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
          />
          {mobileDrawer === "agents" && (
            <div className="bg-background relative flex h-full w-[210px] max-w-[85vw] flex-col shadow-xl">
              <AgentsRail
                agents={agents}
                activeAgentId={activeAgentId}
                collapsed={false}
                userId={chat.userId}
                busy={busy}
                onSelectAgent={(id) => {
                  if (busy && id !== activeAgentId) return;
                  setActiveAgentId(id);
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
          {mobileDrawer === "knowledge" && (
            <div className="bg-background relative ml-auto flex h-full w-[360px] max-w-[90vw] flex-col shadow-xl">
              <button
                aria-label="Close knowledge"
                className="bg-background/80 hover:bg-accent absolute top-2 right-2 z-10 rounded-md border px-2 py-1 text-xs shadow-sm"
                onClick={() => setMobileDrawer(null)}
              >
                Close
              </button>
              <div className="min-h-0 flex-1 overflow-hidden pt-0">{knowledgePanel}</div>
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
