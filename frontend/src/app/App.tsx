import { useEffect, useState } from "react";
import { LinkDialog, PreviewDialog } from "@/features/knowledge/components/knowledge-dialogs";
import { useAppShortcuts } from "@/hooks/use-app-shortcuts";
import { useKnowledgeActions } from "@/features/knowledge/hooks/use-knowledge-actions";
import { useSupervisorChat } from "@/features/chat/hooks/use-supervisor-chat";
import { WorkbenchPage } from "@/features/workbench/components/workbench-page";
import { type AgentInfo, call, tauriOpenFile, errText } from "@/lib/api";
import { logWarn } from "@/lib/logger";
import { OPEN_PREVIEW_EVENT, type OpenPreviewDetail } from "@/lib/preview-bridge";
import { runningInTauri } from "@/platform";
import { AssetsRail } from "@/features/agents/assets-rail";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { CodeAssetPage } from "@/features/codegraph/components/code-page";
import { MemoryAssetPage } from "@/features/memory/components/memory-page";
import { SkillsAssetPage } from "@/features/skills/components/skills-page";
import { WikiAssetPage } from "@/features/assets/pages/wiki-page";
import { SqlSourcesAssetPage } from "@/features/assets/pages/sql-sources-page";
import { WalletPage } from "@/features/wallet/components/wallet-page";
import { SessionHistoryDialog } from "@/features/chat/components/session-history-dialog";

export default function App() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsRail, setAgentsRail] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [assetView, setAssetView] = useState<AssetViewId | null>(null);
  const [codeGraphSeed, setCodeGraphSeed] = useState<{ query: string; result: string } | null>(null);
  const [mobileDrawer, setMobileDrawer] = useState<null | "agents">(null);

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

  // No agent picker: every request runs in `auto` mode (merged all-domain
  // registry — the planner picks tools itself). The first catalog agent only
  // drives presentation/context UI.
  const agent = agents[0] ?? null;
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
      if (runningInTauri && (name.split(".").pop()?.toLowerCase() === "pdf")) {
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

  useAppShortcuts({
    busy,
    onToggleAgentsRail: () => setAgentsRail((v) => !v),
    onNewChat: () => void chat.newChat(),
    onOpenSessions: () => setSessionsOpen(true),
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

  if (!agent) {
    return <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center" />;
  }

  // Asset workspace — replaces the chat center pane while an asset view is
  // open (Wiki = knowledge base, Databases = SQL sources, Memory = raw
  // conversations; Skills/Code have no backend tier yet and state that
  // plainly). Data comes from the same app state the chat uses, so switching
  // views never re-fetches or resets chat. Tool results do NOT live here —
  // they render on the canvas (see CanvasPanel).
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
      <MemoryAssetPage sessions={[...chat.sessions, ...chat.archivedSessions]} onBack={() => setAssetView(null)} />
    ) : assetView === "sources" ? (
      <SqlSourcesAssetPage onBack={() => setAssetView(null)} />
    ) : assetView === "skills" ? (
      <SkillsAssetPage onBack={() => setAssetView(null)} />
    ) : assetView === "code" ? (
      <CodeAssetPage
        initialQuery={codeGraphSeed?.query}
        initialResult={codeGraphSeed?.result}
        onBack={() => {
          setCodeGraphSeed(null);
          setAssetView(null);
        }}
      />
    ) : assetView === "wallet" ? (
      <WalletPage onBack={() => setAssetView(null)} />
    ) : null;

  return (
    <div className="bg-background text-foreground flex h-dvh w-full overflow-hidden">
      <div className="hidden shrink-0 lg:flex">
        <AssetsRail
          assetView={assetView}
          collapsed={agentsRail}
          userId={chat.userId}
          onSelectAsset={(id) => {
            setAssetView(id);
          }}
          onToggle={() => setAgentsRail((v) => !v)}
          onLogout={() => void chat.logout()}
          onNew={() => {
            setAssetView(null);
            void chat.newChat();
          }}
        />
      </div>

      {assetWorkspace ?? (
        <WorkbenchPage
          onAddFiles={ka.addKnowledgeFiles}
          onAddLink={ka.submitKnowledgeLink}
          onImageToKnowledge={ka.imageToKnowledge}
        />
      )}

      {/* Mobile drawers — replace hidden rails under 768px */}
      {mobileDrawer && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileDrawer(null)}
            type="button"
          />
          {mobileDrawer === "agents" && (
            <div className="bg-background relative flex h-full w-[210px] max-w-[85vw] flex-col shadow-xl">
              <AssetsRail
                assetView={assetView}
                collapsed={false}
                userId={chat.userId}
                onSelectAsset={(id) => {
                  setAssetView(id);
                  setMobileDrawer(null);
                }}
                onToggle={() => setMobileDrawer(null)}
                onLogout={() => void chat.logout()}
                onNew={() => {
                  setAssetView(null);
                  setMobileDrawer(null);
                  void chat.newChat();
                }}
              />
            </div>
          )}
        </div>
      )}

      <SessionHistoryDialog
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        groupedSessions={chat.groupedSessions}
        archivedSessions={chat.archivedSessions}
        activeSessionId={chat.sessionId}
        busy={busy}
        onSelectSession={(id) => void chat.selectSession(id)}
        onDeleteSession={(id) => void chat.deleteSession(id)}
        onRenameSession={(id, title) => void chat.renameSession(id, title)}
        onArchiveSession={(id, archived) => chat.setSessionArchived(id, archived)}
      />
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
