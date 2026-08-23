import { useEffect, useState } from "react";
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

  const ka = useKnowledgeActions(chat);

  useEffect(() => {
    void chat.selectAgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

  useAppShortcuts({
    busy,
    onToggleAgentsRail: () => setAgentsRail((v) => !v),
    onToggleCanvas: () => setCanvasOpen((v) => !v),
    onToggleSessions: () => setSessionsCollapsed((v) => !v),
    onNewChat: () => void chat.newChat(),
  });

  if (!agent) {
    return <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center" />;
  }

  return (
    <div className="bg-background text-foreground flex h-dvh w-full overflow-hidden">
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
        chatError={chat.error}
        onStop={chat.stop}
        onSend={(text, fileIds) => void chat.send(text, undefined, fileIds)}
        canvasOpen={canvasOpen}
        inSession={inSession}
        sessionsCollapsed={sessionsCollapsed}
        onToggleCanvas={() => setCanvasOpen((v) => !v)}
        onToggleSessions={() => setSessionsCollapsed((v) => !v)}
        onImageToKnowledge={(dataUrl, name) => void ka.imageToKnowledge(dataUrl, name)}
        canvas={
          canvasOpen ? (
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
          ) : null
        }
      />

      {!sessionsCollapsed && (
        <SessionsPanel
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
