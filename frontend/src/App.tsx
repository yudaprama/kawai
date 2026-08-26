import { useCallback, useEffect, useState } from "react";
import { LinkDialog, PreviewDialog } from "@/components/knowledge-dialogs";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import { useKnowledgeActions } from "@/hooks/use-knowledge-actions";
import { useLocalChat } from "@/hooks/use-local-chat";
import { type AgentInfo, call } from "@/lib/api";
import { isTabularExt } from "@/lib/extensions";
import { logWarn } from "@/lib/logger";
import { OPEN_PREVIEW_EVENT, type OpenPreviewDetail } from "@/lib/preview-bridge";
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
  const [dbFocus, setDbFocus] = useState(0);
  const [profileCount, setProfileCount] = useState<number | null>(null);

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

  // Analytics onboarding: count SQL profiles while the analytics agent sits
  // on an empty session — the onboarding card shows only when the user has
  // no tabular files AND no profiles. Canvas/drawer toggles re-run it so a
  // just-connected database is picked up.
  const analyticsActive = agent?.id === "builtin.analytics" && agent.tools;
  // biome-ignore lint/correctness/useExhaustiveDependencies: canvasOpen/mobileDrawer are deliberate refresh triggers (pick up a just-connected database)
  useEffect(() => {
    if (!analyticsActive || inSession) return;
    let disposed = false;
    call<{ name: string }[]>("sql_profile_list")
      .then((list) => {
        if (!disposed) setProfileCount(list.length);
      })
      .catch(() => {
        if (!disposed) setProfileCount(null);
      });
    return () => {
      disposed = true;
    };
  }, [analyticsActive, inSession, canvasOpen, mobileDrawer]);

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

  const hasTabular = ka.knowledge.files.some((f) => isTabularExt(f.ext));
  const onboarding =
    analyticsActive && !inSession && ka.knowledge.loaded && profileCount === 0 && !hasTabular
      ? {
          onImport: () => void ka.addKnowledgeFiles(),
          onConnect: () => {
            setCanvasOpen(true);
            setMobileDrawer((d) => d ?? "knowledge");
            setDbFocus((n) => n + 1);
          },
        }
      : null;

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
  const showDatabases = agents.some((a) => a.id === "builtin.analytics" && a.tools);
  const knowledgePanel = (
    <KnowledgePanel
      knowledge={ka.knowledge}
      sessionId={chat.sessionId}
      sessionFiles={ka.sessionFiles}
      importing={ka.importing}
      linking={ka.linking}
      confirmDeleteId={ka.confirmDeleteId}
      showDatabases={showDatabases}
      focusTab={dbFocus ? { tab: "databases", n: dbFocus } : undefined}
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
        confirmation={chat.confirmation}
        canvasOpen={canvasOpen}
        inSession={inSession}
        sessionsCollapsed={sessionsCollapsed}
        onToggleCanvas={() => setCanvasOpen((v) => !v)}
        onToggleSessions={() => setSessionsCollapsed((v) => !v)}
        onImageToKnowledge={ka.imageToKnowledge}
        onboarding={onboarding}
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
            type="button"
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
                type="button"
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
