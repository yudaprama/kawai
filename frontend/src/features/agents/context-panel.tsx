import { PlusIcon, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileIcon } from "@/components/shared/file-icon";
import { KnowledgeFileRow, KnowledgeSectionLabel } from "@/features/knowledge/components/knowledge-file-row";
import { SqlProfilesSection } from "@/features/analytics/components/sql-profiles-section";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KnowledgeFileInfo } from "@/lib/api";
import type { ContextTabId, ContextTabSpec } from "@/features/agents/registry";
import { KnowledgeLibrary } from "@/features/knowledge/components/knowledge-library";

/**
 * The right context pane: per-agent tab composition arrives via the registry
 * (`contextTabsFor`) — this shell only renders whatever tabs it is given.
 * Office/analytics share the file lists (one store backs both); analytics
 * additionally gets the SQL sources tab its tools are built on.
 */
export function ContextPanel({
  tabs,
  knowledge,
  sessionId,
  sessionFiles,
  importing,
  linking,
  confirmDeleteId,
  focus,
  onAddFiles,
  onAddLink,
  onAddToSession,
  onRemoveFromSession,
  onRetryIndex,
  onDeleteFile,
  onPreview,
}: {
  /** Registry-driven composition — an empty list never reaches here (App hides the pane). */
  tabs: ContextTabSpec[];
  knowledge: {
    unavailable: boolean;
    loaded: boolean;
    files: KnowledgeFileInfo[];
  };
  sessionId: number | null;
  sessionFiles: KnowledgeFileInfo[];
  importing: boolean;
  linking: boolean;
  confirmDeleteId: string | null;
  /** Imperative tab switch (e.g. the onboarding's "Connect database" CTA) —
   *  increment `n` to re-fire for the same tab; ignored when the agent's
   *  composition has no such tab. */
  focus?: { tab: ContextTabId; n: number };
  onAddFiles: () => void;
  onAddLink: () => void;
  onAddToSession: (file: KnowledgeFileInfo) => void;
  onRemoveFromSession: (file: KnowledgeFileInfo) => void;
  onRetryIndex: (file: KnowledgeFileInfo) => void;
  onDeleteFile: (file: KnowledgeFileInfo) => void;
  onPreview: (file: KnowledgeFileInfo) => void;
}) {
  const [tab, setTab] = useState<ContextTabId>(sessionId != null ? "session" : "library");
  const prevSessionId = useRef(sessionId);
  useEffect(() => {
    // The panel is already mounted when a lazy first message creates the
    // session — follow that null → non-null transition to the session tab,
    // but never yank the user away from a tab they picked themselves.
    if (sessionId != null && prevSessionId.current == null) setTab("session");
    prevSessionId.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    if (focus && focus.n > 0 && tabs.some((t) => t.id === focus.tab)) {
      setTab(focus.tab);
    }
  }, [focus, tabs]);
  // Agent switches preserve this component's state — clamp to a tab the
  // current composition actually offers.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id as ContextTabId | undefined);
  if (!activeTab) return null;

  return (
    <section className="border-l flex min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b px-3">
        <span className="text-sm font-semibold">Knowledge</span>
        <div className="flex items-center gap-1">
          <Button
            disabled={linking || importing}
            onClick={onAddLink}
            size="xs"
            title="Ingest a YouTube video transcript into your knowledge base"
            variant="ghost"
          >
            {linking ? <Spinner className="size-3" /> : <VideoIcon className="size-3" />}
            Add link
          </Button>
          <Button
            disabled={importing || linking}
            onClick={onAddFiles}
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
              <FileIcon name="file" className="text-muted-foreground/40 mb-3 size-5" />
              <p className="text-muted-foreground text-sm">Knowledge is unavailable</p>
              <p className="text-muted-foreground/70 mt-1 text-xs">Document tools are not enabled in this build.</p>
            </div>
          ) : !knowledge.loaded ? (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <Spinner className="size-4" />
              Loading knowledge…
            </div>
          ) : (
            <Tabs onValueChange={(v) => setTab(v as ContextTabId)} value={activeTab}>
              <TabsList className="mb-3">
                {tabs.map((t) => (
                  <TabsTrigger key={t.id} value={t.id}>
                    {/* Pre-session the library IS the whole document list. */}
                    {t.id === "library" && sessionId == null ? "Documents" : t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="sources">
                <SqlProfilesSection />
              </TabsContent>
              <TabsContent value="session">
                {sessionId != null && (
                  <div>
                    <KnowledgeSectionLabel count={sessionFiles.length} label="In this session" />
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
                                onAdd: onAddToSession,
                                onDelete: onDeleteFile,
                                onPreview: onPreview,
                                onRemove: onRemoveFromSession,
                                onRetry: onRetryIndex,
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
                        No documents in this session yet — press <span className="font-medium">+</span> on a library
                        document below, or import new files; the agent can then search them in this chat.
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>
              <TabsContent value="library">
                <KnowledgeLibrary
                  confirmDeleteId={confirmDeleteId}
                  files={knowledge.files}
                  loaded={knowledge.loaded}
                  sessionId={sessionId}
                  onAdd={onAddToSession}
                  onDelete={onDeleteFile}
                  onRemove={onRemoveFromSession}
                  onRetry={onRetryIndex}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </section>
  );
}
