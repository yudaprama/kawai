import { PlusIcon, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FileIcon } from "@/components/file-icon";
import { KnowledgeFileRow, KnowledgeSectionLabel } from "@/components/knowledge-file-row";
import { SqlProfilesSection } from "@/components/sql-profiles-section";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KnowledgeFileInfo } from "@/lib/api";

type KnowledgeTab = "session" | "library" | "databases";

export function KnowledgePanel({
  knowledge,
  sessionId,
  sessionFiles,
  importing,
  linking,
  confirmDeleteId,
  showDatabases,
  focusTab,
  onAddFiles,
  onAddLink,
  onAddToSession,
  onRemoveFromSession,
  onRetryIndex,
  onDeleteFile,
  onPreview,
}: {
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
  /** Whether the analytics agent is available (catalog-driven) — gates the Databases tab. */
  showDatabases: boolean;
  /** Imperative tab switch (e.g. the analytics onboarding's "Connect
   *  database" CTA) — increment `n` to re-fire for the same tab. */
  focusTab?: { tab: KnowledgeTab; n: number };
  onAddFiles: () => void;
  onAddLink: () => void;
  onAddToSession: (file: KnowledgeFileInfo) => void;
  onRemoveFromSession: (file: KnowledgeFileInfo) => void;
  onRetryIndex: (file: KnowledgeFileInfo) => void;
  onDeleteFile: (file: KnowledgeFileInfo) => void;
  onPreview: (file: KnowledgeFileInfo) => void;
}) {
  const [tab, setTab] = useState<KnowledgeTab>(sessionId != null ? "session" : "library");
  const prevSessionId = useRef(sessionId);
  useEffect(() => {
    // The panel is already mounted when a lazy first message creates the
    // session — follow that null → non-null transition to the session tab,
    // but never yank the user away from a tab they picked themselves.
    if (sessionId != null && prevSessionId.current == null) setTab("session");
    prevSessionId.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    if (focusTab && focusTab.n > 0 && (focusTab.tab !== "databases" || showDatabases)) {
      setTab(focusTab.tab);
    }
  }, [focusTab, showDatabases]);
  return (
    <section className="flex min-w-0 flex-1 flex-col border-l">
      <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-b px-3">
        <span className="text-sm font-medium">Knowledge</span>
        <div className="flex items-center gap-1">
          <Button
            disabled={linking || importing}
            onClick={onAddLink}
            size="xs"
            title="Ingest a YouTube video transcript into your knowledge base"
            variant="ghost"
          >
            {linking ? <Spinner className="size-3" /> : <VideoIcon className="size-3" />}
            Link
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
            <Tabs
              onValueChange={(v) => setTab(v as KnowledgeTab)}
              value={tab === "databases" && !showDatabases ? "library" : tab}
            >
              <TabsList className="mb-3">
                <TabsTrigger value="session">In this session</TabsTrigger>
                <TabsTrigger value="library">{sessionId != null ? "Library" : "Documents"}</TabsTrigger>
                {showDatabases && <TabsTrigger value="databases">Databases</TabsTrigger>}
              </TabsList>
              <TabsContent value="databases">
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
                <div>
                  <KnowledgeSectionLabel
                    count={knowledge.files.length}
                    label={sessionId != null ? "Library" : "Documents"}
                  />
                  {knowledge.files.length === 0 ? (
                    <div className="text-muted-foreground/70 rounded-lg border border-dashed px-3 py-3 text-xs">
                      No sources yet — import .docx, .xlsx, .pptx, .pdf or images with &quot;Add files&quot;, or paste a
                      YouTube link with &quot;Link&quot;.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {knowledge.files.map((file) => (
                        <KnowledgeFileRow
                          confirmDelete={confirmDeleteId === file.id}
                          file={file}
                          inSessionList={file.inSession && sessionId != null}
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
                  )}
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </section>
  );
}
