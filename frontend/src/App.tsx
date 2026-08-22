import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useKnowledgeFiles } from "@/hooks/use-knowledge-files";
import { useLocalChat } from "@/hooks/use-local-chat";
import { platform, runningInTauri } from "@/platform";
import { call, errText, type AgentInfo, type KnowledgeFileInfo, type OfficeFileInfo } from "@/lib/api";
import { showErrorToast } from "@/lib/toast-utils";
import { useRetryableToast } from "@/hooks/use-retryable-toast";
import { knowledgeFileToPreview } from "@/lib/preview-file";
import { FilePreview } from "@/components/file-preview";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileTextIcon, PlusIcon, VideoIcon } from "lucide-react";
import { AgentsRail, agentPresentation } from "@/panels/agents-rail";
import { ConversationPanel } from "@/panels/conversation-panel";
import { SessionsPanel } from "@/panels/sessions-panel";
import {
  ADD_FILE_ACCEPT,
  classifySource,
  dataUrlToFile,
  fileToBase64,
  isYouTubeUrl,
  KnowledgeFileRow,
  KnowledgeSectionLabel,
} from "@/lib/knowledge-utils";
import type { KnowledgeSource } from "@/lib/knowledge-utils";

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
      .catch((err) => console.error("[list_agents]", errText(err)));
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

  const knowledge = useKnowledgeFiles(true);
  const sessionFiles =
    chat.sessionId != null ? knowledge.files.filter((f) => f.inSession) : [];
  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<KnowledgeFileInfo | null>(null);
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const runWithRetry = useRetryableToast();

  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const importKnowledgeFiles = useCallback(
    async (items: { sourcePath?: string; file?: File; name: string }[]) => {
      const importedIds: string[] = [];
      for (const item of items) {
        let imported: OfficeFileInfo | undefined;
        if (item.sourcePath) {
          imported = await call<OfficeFileInfo>("office_import_file", { sourcePath: item.sourcePath });
        } else if (item.file) {
          const dataBase64 = await fileToBase64(item.file);
          imported = await call<OfficeFileInfo>("office_import_file", { dataBase64, name: item.name });
        }
        if (imported?.id) importedIds.push(imported.id);
      }
      if (importedIds.length) {
        const runs = importedIds.map((fileId) =>
          call<number>("office_index_file", {
            sessionId: chat.sessionId,
            fileId,
          })
            .catch((e) => console.warn("[office_index_file]", errText(e)))
            .finally(() => void knowledge.refresh()),
        );
        await knowledge.refresh();
        knowledge.markIndexing(importedIds);
        void Promise.allSettled(runs);
      }
    },
    [chat.sessionId, knowledge],
  );

  const addKnowledgeFiles = useCallback(async () => {
    setImporting(true);
    const toImport: { sourcePath?: string; file?: File; name: string }[] = [];
    let picked: KnowledgeSource[];
    try {
      if (runningInTauri) {
        const paths = await platform.pickFilePaths({ accept: ADD_FILE_ACCEPT, multiple: true });
        if (!paths?.length) return;
        picked = paths.map((p) =>
          classifySource(p.split(/[\\/]/).pop() ?? p, { path: p }),
        );
      } else {
        const pickedFiles = await platform.pickFiles({
          accept: ADD_FILE_ACCEPT,
          multiple: true,
        });
        if (!pickedFiles?.length) return;
        picked = pickedFiles.map((f) => classifySource(f.name, { file: f }));
      }
      for (const item of picked) {
        if (item.kind === "file") {
          toImport.push({ name: item.name, sourcePath: item.sourcePath, file: item.file });
        } else {
          showErrorToast(`Unsupported file type: ${item.name}`);
        }
      }
      await importKnowledgeFiles(toImport);
      if (toImport.length) {
        toast.success(`Imported ${toImport.length} file${toImport.length > 1 ? "s" : ""}`, {
          description: "Indexing runs in the background.",
        });
      }
    } catch (err) {
      console.warn("[office_import_file]", errText(err));
      showErrorToast(err);
    } finally {
      setImporting(false);
    }
  }, [importKnowledgeFiles]);

  const imageToKnowledge = useCallback(
    async (dataUrl: string, name: string) => {
      const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
      const ext = mime.split("/")[1] ?? "png";
      try {
        await importKnowledgeFiles([
          { name: `${name}.${ext}`, file: dataUrlToFile(dataUrl, `${name}.${ext}`) },
        ]);
        toast.success("Image saved to knowledge", {
          description: "Indexing runs in the background.",
        });
      } catch (err) {
        showErrorToast(err);
      }
    },
    [importKnowledgeFiles],
  );

  const addToSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      let sid = chat.sessionId;
      if (sid == null) {
        sid = await chat.ensureSessionId(file.originalName);
        if (sid == null) return;
        knowledge.setSessionId(sid);
      }
      knowledge.markInSession([file.id], true);
      if (file.chunks === 0 || file.status === "failed") knowledge.markIndexing([file.id]);
      try {
        await call<number>("knowledge_add_to_session", {
          sessionId: sid,
          fileIds: [file.id],
        });
      } catch (err) {
        showErrorToast(err);
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, chat.ensureSessionId, knowledge],
  );

  const removeFromSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (chat.sessionId == null) return;
      knowledge.markInSession([file.id], false);
      try {
        await call<number>("knowledge_forget", {
          sessionId: chat.sessionId,
          fileIds: [file.id],
        });
      } catch (err) {
        showErrorToast(err);
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  const retryIndex = useCallback(
    async (file: KnowledgeFileInfo) => {
      knowledge.markIndexing([file.id]);
      try {
        await call<number>("office_index_file", {
          sessionId: chat.sessionId,
          fileId: file.id,
        });
      } catch (err) {
        console.warn("[office_index_file]", errText(err));
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  const deleteFile = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (confirmDeleteId !== file.id) {
        setConfirmDeleteId(file.id);
        return;
      }
      setConfirmDeleteId(null);
      knowledge.remove([file.id]);
      try {
        await call("office_delete_file", { fileId: file.id });
      } catch (err) {
        showErrorToast(err);
        await knowledge.refresh();
      }
    },
    [confirmDeleteId, knowledge],
  );

  const openPreview = useCallback((file: KnowledgeFileInfo) => {
    setPreviewFile(file);
  }, []);

  /** Opens the themed URL prompt; the ingest itself runs in submitKnowledgeLink. */
  const addKnowledgeLink = useCallback(() => {
    setLinkUrl("");
    setLinkPromptOpen(true);
  }, []);

  /** Ingests the URL from the prompt dialog into the knowledge base. */
  const submitKnowledgeLink = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url) return;
    if (!isYouTubeUrl(url)) {
      showErrorToast("Only YouTube URLs are supported for now");
      setLinkPromptOpen(false);
      return;
    }
    setLinkPromptOpen(false);
    setLinking(true);
    const importVideo = async () => {
      const info = await call<OfficeFileInfo>("knowledge_import_youtube", {
        url,
        sessionId: chat.sessionId,
      });
      await knowledge.refresh();
      return info;
    };
    try {
      const info = await importVideo();
      toast.success(`Imported ${info.originalName}`, {
        description: "Indexing runs in the background.",
      });
    } catch (err) {
      console.warn("[knowledge_import_youtube]", errText(err));
      runWithRetry(`Couldn't import the YouTube video — ${errText(err)}`, importVideo);
    } finally {
      setLinking(false);
    }
  }, [chat.sessionId, knowledge.refresh, linkUrl, runWithRetry]);

  useEffect(() => {
    void chat.selectAgent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId]);

  useEffect(() => {
    knowledge.setSessionId(chat.sessionId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "1") {
        e.preventDefault();
        setAgentsRail((v) => !v);
      } else if (e.key === "2") {
        e.preventDefault();
        setCanvasOpen((v) => !v);
      } else if (e.key === "3") {
        e.preventDefault();
        setSessionsCollapsed((v) => !v);
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        if (!busy) void chat.newChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, chat]);

  if (!agent) {
    return <div className="bg-background text-foreground flex h-dvh w-full items-center justify-center" />;
  }

  return (
    <div className="bg-background text-foreground flex h-dvh w-full overflow-hidden">
      {/* ══════════ PANE 1: AGENTS ══════════ */}
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

      {/* ══════════ PANE 2: WORKSPACE ══════════ */}
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
        onImageToKnowledge={(dataUrl, name) => void imageToKnowledge(dataUrl, name)}
        canvas={
          canvasOpen ? (
            <section className="hidden min-w-0 flex-1 flex-col border-l md:flex">
              <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b px-3">
                <span className="text-sm font-medium">Knowledge</span>
                <div className="flex items-center gap-1">
                  <Button
                    disabled={linking || importing}
                    onClick={addKnowledgeLink}
                    size="xs"
                    title="Ingest a YouTube video transcript into your knowledge base"
                    variant="ghost"
                  >
                    {linking ? <Spinner className="size-3" /> : <VideoIcon className="size-3" />}
                    Link
                  </Button>
                  <Button
                    disabled={importing || linking}
                    onClick={() => void addKnowledgeFiles()}
                    size="xs"
                    title="Import documents & images (.docx .xlsx .pptx .pdf .png .jpg …)"
                    variant="ghost"
                  >
                    {importing ? <Spinner className="size-3" /> : <PlusIcon className="size-3" />}
                    Add files
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="p-3 pt-5">
                  {knowledge.unavailable ? (
                    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                      <FileTextIcon className="text-muted-foreground/40 mb-3 size-5" />
                      <p className="text-muted-foreground text-sm">Knowledge store unavailable</p>
                      <p className="text-muted-foreground/70 mt-1 text-xs">
                        The office feature isn&apos;t enabled in this build
                      </p>
                    </div>
                  ) : !knowledge.loaded ? (
                    <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
                      <Spinner className="size-4" />
                      Loading knowledge…
                    </div>
                  ) : (
                    <Tabs defaultValue={chat.sessionId != null ? "session" : "library"}>
                      <TabsList className="mb-3">
                        <TabsTrigger value="session">In this session</TabsTrigger>
                        <TabsTrigger value="library">
                          {chat.sessionId != null ? "Library" : "Documents"}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="session">
                        {chat.sessionId != null && (
                          <div>
                            <KnowledgeSectionLabel
                              count={sessionFiles.length}
                              label="In this session"
                            />
                            {sessionFiles.length > 0 ? (
                              <>
                                <div className="flex flex-col gap-1.5">
                                  {sessionFiles.map((file) => (
                                    <KnowledgeFileRow
                                      confirmDelete={confirmDeleteId === file.id}
                                      file={file}
                                      inSessionList
                                      key={file.id}
                                      actions={{
                                        onAdd: addToSession,
                                        onDelete: deleteFile,
                                        onPreview: openPreview,
                                        onRemove: removeFromSession,
                                        onRetry: retryIndex,
                                      }}
                                    />
                                  ))}
                                </div>
                                <p className="text-muted-foreground/70 mt-1.5 px-1 text-xs">
                                  The agent can search these documents in this chat.
                                </p>
                              </>
                            ) : (
                              <div className="text-muted-foreground/70 rounded-lg border border-dashed px-3 py-3 text-xs">
                                No documents in this session yet — press{" "}
                                <span className="font-medium">+</span> on a library document
                                below, or import new files; the agent can then search them in
                                this chat.
                              </div>
                            )}
                          </div>
                        )}
                      </TabsContent>
                      <TabsContent value="library">
                        <div>
                          <KnowledgeSectionLabel
                            count={knowledge.files.length}
                            label={chat.sessionId != null ? "Library" : "Documents"}
                          />
                          {knowledge.files.length === 0 ? (
                            <div className="text-muted-foreground/70 rounded-lg border border-dashed px-3 py-3 text-xs">
                              No sources yet — import .docx, .xlsx, .pptx, .pdf or images with
                              "Add files", or paste a YouTube link with "Link".
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {knowledge.files.map((file) => (
                                <KnowledgeFileRow
                                  confirmDelete={confirmDeleteId === file.id}
                                  file={file}
                                  inSessionList={file.inSession && chat.sessionId != null}
                                  key={file.id}
                                  actions={{ onAdd: addToSession, onDelete: deleteFile, onPreview: openPreview, onRemove: removeFromSession, onRetry: retryIndex }}/>
                              ))}
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    </Tabs>
                  )}
                </div>
              </div>
            </section>
          ) : null
        }
      />

      {/* ══════════ PANE 3: SESSIONS ══════════ */}
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

      <Dialog open={previewFile != null} onOpenChange={(open) => !open && setPreviewFile(null)}>
        <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b px-4 py-3">
            <DialogTitle className="truncate text-sm font-medium">
              {previewFile?.originalName}
            </DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col bg-background">
            {previewFile && <FilePreview file={knowledgeFileToPreview(previewFile)} />}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={linkPromptOpen} onOpenChange={setLinkPromptOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a YouTube link</DialogTitle>
            <DialogDescription>
              Paste a YouTube video URL to ingest its transcript into your
              knowledge base.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            disabled={linking}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !linking) void submitKnowledgeLink();
            }}
            placeholder="https://www.youtube.com/watch?v=…"
            type="url"
            value={linkUrl}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={linking} variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={linking || !linkUrl.trim()}
              onClick={() => void submitKnowledgeLink()}
            >
              {linking ? <Spinner className="size-3" /> : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
