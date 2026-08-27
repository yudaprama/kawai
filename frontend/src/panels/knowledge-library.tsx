import { CheckIcon, PlusIcon, RotateCcwIcon, TrashIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
  AssetBadge,
  AssetItemBadges,
  AssetItemHeader,
  AssetItemId,
  AssetItemMeta,
  AssetItemName,
  AssetItemTime,
  AssetListPanel,
} from "@/components/asset/asset-list-panel";
import { AssetSplitLayout } from "@/components/asset/asset-split-layout";
import { FileIcon } from "@/components/file-icon";
import { FilePreview } from "@/components/file-preview";
import { KnowledgeStatusBadge } from "@/components/knowledge-file-row";
import { Button } from "@/components/ui/button";
import type { KnowledgeFileInfo } from "@/lib/api";
import { isTabularExt } from "@/lib/extensions";
import { knowledgeFileToPreview } from "@/lib/preview-file";
import { formatBytes } from "@/lib/utils";

/**
 * The knowledge library as an asset manager (Tea-style, vendored primitives):
 * file list on the left, selected file detail with inline preview on the
 * right. All data and mutations come from the parent — this component only
 * owns selection state.
 */
export function KnowledgeLibrary({
  files,
  loaded,
  sessionId,
  confirmDeleteId,
  onAdd,
  onRemove,
  onRetry,
  onDelete,
}: {
  files: KnowledgeFileInfo[];
  loaded: boolean;
  sessionId: number | null;
  confirmDeleteId: string | null;
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keep a valid selection across refreshes/deletes; fall back to the first file.
  const active = files.find((f) => f.id === selectedId) ?? files[0] ?? null;
  const inSession = (file: KnowledgeFileInfo) => file.inSession && sessionId != null;

  return (
    <AssetSplitLayout
      detail={
        active ? (
          <LibraryDetail
            confirmDelete={confirmDeleteId === active.id}
            file={active}
            inSession={inSession(active)}
            onAdd={onAdd}
            onDelete={onDelete}
            onRemove={onRemove}
            onRetry={onRetry}
            sessionId={sessionId}
          />
        ) : (
          <div className="_alp-detail-empty">Select a document to inspect it</div>
        )
      }
      sidebar={
        <AssetListPanel
          count={files.length}
          emptyText="No sources yet — import files with “Add files”, or paste a YouTube link with “Link”."
          getItemId={(file) => file.id}
          items={files}
          loading={!loaded}
          onSelect={(file) => setSelectedId(file.id)}
          renderItem={(file) => (
            <>
              <AssetItemHeader>
                <AssetItemName title={file.originalName}>{file.originalName}</AssetItemName>
                {inSession(file) && (
                  <CheckIcon
                    aria-label="In this session"
                    className="size-3.5 shrink-0 text-[var(--tea-color-text-success-default)]"
                  />
                )}
              </AssetItemHeader>
              <AssetItemBadges>
                <AssetBadge>
                  <KnowledgeStatusBadge file={file} />
                </AssetBadge>
              </AssetItemBadges>
              <AssetItemMeta>
                <span>{formatBytes(file.bytes)}</span>
                <AssetItemTime>{new Date(file.createdAt * 1000).toLocaleDateString()}</AssetItemTime>
              </AssetItemMeta>
            </>
          )}
          selectedId={active?.id ?? null}
          title={sessionId != null ? "Library" : "Documents"}
        />
      }
      storageKey="kawai:knowledge:splitWidth"
    />
  );
}

function LibraryDetail({
  file,
  inSession,
  sessionId,
  confirmDelete,
  onAdd,
  onRemove,
  onRetry,
  onDelete,
}: {
  file: KnowledgeFileInfo;
  inSession: boolean;
  sessionId: number | null;
  confirmDelete: boolean;
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
}) {
  const tabular = isTabularExt(file.ext);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="shrink-0">
        <div className="flex items-start gap-2.5">
          <FileIcon className="mt-0.5 size-5 shrink-0" name={file.originalName} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold" title={file.originalName}>
              {file.originalName}
            </h3>
            <AssetItemId>{file.id}</AssetItemId>
          </div>
        </div>
        <AssetItemBadges>
          <KnowledgeStatusBadge file={file} />
          <AssetBadge>{formatBytes(file.bytes)}</AssetBadge>
          <AssetBadge>{new Date(file.createdAt * 1000).toLocaleString()}</AssetBadge>
        </AssetItemBadges>
        {file.status === "failed" && file.error && (
          <p className="text-destructive mt-2 text-xs" title={file.error}>
            {file.error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {sessionId != null &&
            (inSession ? (
              <Button
                onClick={() => onRemove(file)}
                size="xs"
                title={
                  tabular
                    ? "Remove from this session — the agent stops seeing this data file here"
                    : "Remove from this session — the agent stops searching it here"
                }
                variant="outline"
              >
                <XIcon className="size-3" />
                Remove from session
              </Button>
            ) : (
              <Button
                onClick={() => onAdd(file)}
                size="xs"
                title={
                  tabular
                    ? "Add to this session — makes this data file queryable by the agent in this chat"
                    : "Add to this session — makes this document searchable by the agent in this chat"
                }
                variant="outline"
              >
                <PlusIcon className="size-3" />
                Add to session
              </Button>
            ))}
          {file.status === "failed" && (
            <Button
              onClick={() => onRetry(file)}
              size="xs"
              title={file.error ? `Retry indexing — last error: ${file.error}` : "Retry indexing"}
              variant="outline"
            >
              <RotateCcwIcon className="size-3" />
              Retry indexing
            </Button>
          )}
          <Button
            className={confirmDelete ? "" : "text-destructive hover:text-destructive"}
            onClick={() => onDelete(file)}
            size="xs"
            title={confirmDelete ? "Click again to confirm — deletes the document everywhere" : "Delete document"}
            variant="outline"
          >
            <TrashIcon className="size-3" />
            {confirmDelete ? "Confirm delete" : "Delete"}
          </Button>
        </div>
      </div>
      <div className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <FilePreview file={knowledgeFileToPreview(file)} />
      </div>
    </div>
  );
}
