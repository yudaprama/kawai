import { Icon } from "@/components/shared/icon";
import { useMemo, useState } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemHeader,
  AssetItemMeta,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/features/assets/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/features/assets/components/asset/asset-split-layout";
import { EmptyPane } from "@/features/assets/components/asset-shell";
import { FileIcon } from "@/components/shared/file-icon";
import { KnowledgeStatusBadge } from "@/features/knowledge/components/knowledge-file-row";
import { KnowledgeFileSummary } from "@/features/knowledge/components/knowledge-file-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KnowledgeFileInfo } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { FilePreview } from "@/components/shared/file-preview";
import { knowledgeFileToPreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import { fmtDateUS, fmtTimestamp } from "@/features/workbench/components/tool-views/format";

/**
 * Wiki asset page — WikiSourcesPanel structure (Tea asset-management UI) over
 * the real knowledge store: each document is a wiki source (status = index
 * lifecycle, pages = chunk count), the detail pane gets the Pages | Graph
 * tabs — Pages is the live document preview, Graph is the page-graph view the
 * build doesn't have an indexing tier for yet.
 */
export function WikiAssetPage({
  files,
  loaded,
  unavailable,
  error,
  loading,
  sessionId,
  confirmDeleteId,
  importing,
  onAdd,
  onRemove,
  onRetry,
  onDelete,
  onImport,
  onRefresh,
  onBack,
}: {
  files: KnowledgeFileInfo[];
  loaded: boolean;
  /** `useKnowledgeFiles.unavailable` — the backend rejected `knowledge_list`. */
  unavailable?: boolean;
  /** `useKnowledgeFiles.error` — the failure message; replaces the empty state. */
  error?: string | null;
  /** `useKnowledgeFiles.loading`; defaults to `!loaded` for callers that only pass `loaded`. */
  loading?: boolean;
  sessionId: number | null;
  confirmDeleteId: string | null;
  importing?: boolean;
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
  onImport: () => void;
  /** `useKnowledgeFiles.refresh` — re-runs the failed `knowledge_list` read. */
  onRefresh?: () => void;
  onBack: () => void;
}) {
  // Three settled states, never the empty CTA on a failed load.
  const isLoading = loading ?? !loaded;
  // `useOp` flags EVERY failed fetch `unavailable`, so the "not enabled in
  // this build" claim is only honest when the message actually says the
  // tooling is missing (the backend's literal gate strings — cf. the
  // "codegraph feature not enabled …" checks in code-page.tsx). Any other
  // failure renders its real message with a Retry.
  const gateMessage = error != null && /not enabled|not compiled|unknown command|feature|disabled/i.test(error);
  const showUnavailable = !!unavailable && !isLoading && (error == null || gateMessage);
  const failed = !isLoading && error != null && !showUnavailable;
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.originalName.toLowerCase().includes(q));
  }, [files, query]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = filtered.find((f) => f.id === selectedId) ?? files.find((f) => f.id === selectedId) ?? null;
  const { t } = useI18n();

  return (
    <AssetShell onBack={onBack} subtitle="knowledge base" title={t("assetNav.wiki")}>
      <AssetPageHeader
        actions={
          <Button disabled={importing} onClick={onImport} size="sm">
            {importing ? <Spinner className="size-3" /> : <Icon name="plus" className="size-3.5" />}
            Add source
          </Button>
        }
        subtitle={`${files.length} ${files.length === 1 ? "document" : "documents"} in the knowledge base`}
        title={t("assetNav.wiki")}
      />
      <div className="mb-3 mt-3 flex shrink-0 items-center">
        <Input
          className="max-w-xs"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sources…"
          type="search"
          value={query}
        />
        <span className="text-muted-foreground ml-3 text-xs">
          {filtered.length}/{files.length}
        </span>
      </div>
      <AssetSplitLayout
        detail={
          active ? (
            <SourceDetail
              confirmDelete={confirmDeleteId === active.id}
              file={active}
              inSession={active.inSession && sessionId != null}
              onAdd={onAdd}
              onDelete={onDelete}
              onRemove={onRemove}
              onRetry={onRetry}
            />
          ) : (
            <div className="_alp-detail-empty">Select a source to browse its pages</div>
          )
        }
        sidebar={
          <AssetListPanel
            count={`${filtered.length}`}
            emptyText={
              showUnavailable ? (
                // Exact pattern/copy of context-panel.tsx:108-113.
                <span className="flex flex-col items-center">
                  <FileIcon className="text-muted-foreground/40 mb-3 size-5" name="file" />
                  <span className="text-muted-foreground text-sm">Knowledge is unavailable</span>
                  <span className="text-muted-foreground mt-1 text-xs">
                    Document tools are not enabled in this build.
                  </span>
                </span>
              ) : failed ? (
                <span className="flex flex-col items-center gap-2">
                  <span className="text-muted-foreground" role="alert">
                    Couldn&apos;t load sources — {error}
                  </span>
                  {onRefresh != null && (
                    <Button onClick={onRefresh} size="xs" variant="outline">
                      {t("common.retry")}
                    </Button>
                  )}
                </span>
              ) : (
                "No sources yet — add documents with “Add source”, or paste a YouTube link from the chat composer's attachment (@) menu."
              )
            }
            getItemId={(f) => f.id}
            items={filtered}
            loading={isLoading && files.length === 0}
            onSelect={(f) => setSelectedId(f.id)}
            renderItem={(f) => (
              <>
                <AssetItemHeader>
                  <FileIcon className="mr-1.5 size-4 shrink-0" name={f.originalName} />
                  <AssetItemName title={f.originalName}>{f.originalName}</AssetItemName>
                </AssetItemHeader>
                <AssetItemBadges>
                  <AssetBadge>
                    <KnowledgeStatusBadge file={f} />
                  </AssetBadge>
                  {!["indexing", "not_indexed"].includes(f.status) && <AssetBadge>{f.chunks} pages</AssetBadge>}
                </AssetItemBadges>
                <AssetItemMeta>
                  <span>{formatBytes(f.bytes)}</span>
                  <AssetItemTime>{fmtDateUS(f.createdAt * 1000)}</AssetItemTime>
                </AssetItemMeta>
              </>
            )}
            selectedId={active?.id ?? null}
            title="Sources"
          />
        }
        storageKey="kawai:wiki:splitWidth"
      />
    </AssetShell>
  );
}

function SourceDetail({
  file,
  inSession,
  confirmDelete,
  onAdd,
  onRemove,
  onRetry,
  onDelete,
}: {
  file: KnowledgeFileInfo;
  inSession: boolean;
  confirmDelete: boolean;
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
}) {
  const [tab, setTab] = useState("pages");
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <KnowledgeFileSummary
          actions={
            <>
              {file.status === "failed" && (
                <Button onClick={() => onRetry(file)} size="xs" title="Retry indexing" variant="outline">
                  {t("common.retry")}
                </Button>
              )}
              {inSession ? (
                <Button onClick={() => onRemove(file)} size="xs" variant="outline">
                  Remove from session
                </Button>
              ) : (
                <Button onClick={() => onAdd(file)} size="xs" variant="outline">
                  Add to session
                </Button>
              )}
              <Button
                className={confirmDelete ? "" : "text-destructive hover:text-destructive"}
                onClick={() => onDelete(file)}
                size="xs"
                title={confirmDelete ? "Click again to confirm — deletes the document everywhere" : "Delete document"}
                variant="outline"
              >
                {confirmDelete ? t("common.confirm") : t("common.delete")}
              </Button>
            </>
          }
          file={file}
          subtitle={
            <p className="text-muted-foreground mt-0.5 text-xs">
              {formatBytes(file.bytes)} · {fmtTimestamp(new Date(file.createdAt * 1000))}
            </p>
          }
        />
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col gap-0" value={tab} onValueChange={setTab}>
        <div className="shrink-0 border-b px-4">
          <TabsList className="h-9">
            <TabsTrigger value="pages">Pages</TabsTrigger>
            <TabsTrigger value="graph">
              <Icon name="git-branch" className="size-3.5" />
              Graph
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent className="flex min-h-0 flex-1 flex-col" value="pages">
          <div className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden">
            <FilePreview file={knowledgeFileToPreview(file)} />
          </div>
        </TabsContent>
        <TabsContent value="graph">
          <EmptyPane
            description="The page graph links wiki pages by their references and expands search results across hops. A page-graph indexing tier isn't part of this build yet — sources are searched by chunk embeddings and BM25."
            icon={<Icon name="git-branch" className="size-5" />}
            label="No page graph for this source"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
