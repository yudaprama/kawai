import { GitBranchIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemHeader,
  AssetItemMeta,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/components/asset/asset-split-layout";
import { FileIcon } from "@/components/file-icon";
import { KnowledgeStatusBadge } from "@/components/knowledge-file-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KnowledgeFileInfo } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { AssetShell } from "@/panels/assets/asset-shell";
import { FilePreview } from "@/components/file-preview";
import { knowledgeFileToPreview } from "@/lib/preview-file";

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
  sessionId,
  confirmDeleteId,
  importing,
  onAdd,
  onRemove,
  onRetry,
  onDelete,
  onImport,
  onBack,
}: {
  files: KnowledgeFileInfo[];
  loaded: boolean;
  sessionId: number | null;
  confirmDeleteId: string | null;
  importing?: boolean;
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.originalName.toLowerCase().includes(q));
  }, [files, query]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = filtered.find((f) => f.id === selectedId) ?? files.find((f) => f.id === selectedId) ?? null;

  return (
    <AssetShell onBack={onBack} subtitle="knowledge base" title="Wiki">
      <AssetPageHeader
        actions={
          <Button disabled={importing} onClick={onImport} size="sm">
            {importing ? <Spinner className="size-3" /> : <PlusIcon className="size-3.5" />}
            Add source
          </Button>
        }
        subtitle={`${files.length} ${files.length === 1 ? "document" : "documents"} in the knowledge base`}
        title="Wiki"
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
            emptyText="No sources yet — add documents with “Add source”, or paste a YouTube link from the chat's Knowledge pane."
            getItemId={(f) => f.id}
            items={filtered}
            loading={!loaded}
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
                  <AssetItemTime>{new Date(f.createdAt * 1000).toLocaleDateString()}</AssetItemTime>
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <div className="flex items-start gap-2.5">
          <FileIcon className="mt-0.5 size-5 shrink-0" name={file.originalName} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold" title={file.originalName}>
              {file.originalName}
            </h3>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {formatBytes(file.bytes)} · {new Date(file.createdAt * 1000).toLocaleString()}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {file.status === "failed" && (
              <Button onClick={() => onRetry(file)} size="xs" title="Retry indexing" variant="outline">
                Retry
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
              {confirmDelete ? "Confirm" : "Delete"}
            </Button>
          </div>
        </div>
      </div>
      <Tabs className="flex min-h-0 flex-1 flex-col gap-0" value="pages">
        <div className="shrink-0 border-b px-4">
          <TabsList className="h-9">
            <TabsTrigger value="pages">Pages</TabsTrigger>
            <TabsTrigger value="graph">
              <GitBranchIcon className="size-3.5" />
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
            label="No page graph for this source"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function EmptyPane({ label, description }: { label: string; description: string }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">
        <GitBranchIcon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="max-w-md text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
