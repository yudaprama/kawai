import { CheckIcon, EyeIcon, PlusIcon, RotateCcwIcon, TrashIcon, XIcon } from "lucide-react";
import { FileIcon } from "@/components/file-icon";
import { Spinner } from "@/components/ui/spinner";
import type { KnowledgeFileInfo } from "@/lib/api";
import { formatBytes } from "@/lib/utils";

export function KnowledgeStatusBadge({ file }: { file: KnowledgeFileInfo }) {
  if (file.status === "indexing") {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <Spinner className="size-3" />
        Indexing…
      </span>
    );
  }
  if (file.status === "failed") {
    return (
      <span className="text-destructive text-xs" title={file.error ?? undefined}>
        Index failed
      </span>
    );
  }
  if (file.status === "ready") {
    return file.chunks > 0 ? (
      <span className="text-muted-foreground text-xs">{file.chunks} chunks</span>
    ) : (
      <span className="text-muted-foreground/70 text-xs" title="No extractable text found">
        no text
      </span>
    );
  }
  return <span className="text-muted-foreground/70 text-xs">not indexed</span>;
}

export function KnowledgeSectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between px-1 pb-1.5">
      <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{label}</p>
      <span className="font-mono text-[11px] text-muted-foreground/70">{count}</span>
    </div>
  );
}

export type KnowledgeRowActions = {
  onAdd: (file: KnowledgeFileInfo) => void;
  onRemove: (file: KnowledgeFileInfo) => void;
  onRetry: (file: KnowledgeFileInfo) => void;
  onDelete: (file: KnowledgeFileInfo) => void;
  onPreview: (file: KnowledgeFileInfo) => void;
};

export const KnowledgeFileRow = function KnowledgeFileRow({
  file,
  inSessionList,
  confirmDelete,
  actions,
}: {
  file: KnowledgeFileInfo;
  inSessionList: boolean;
  confirmDelete: boolean;
  actions: KnowledgeRowActions;
}) {
  return (
    <div className="bg-card group/file flex items-center gap-2.5 rounded-lg border px-2.5 py-2">
      {inSessionList ? (
        <CheckIcon className="text-green-500 size-4 shrink-0" />
      ) : (
        <FileIcon name={file.originalName} className="size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <button
          className="block w-full truncate text-left text-sm hover:underline"
          onClick={() => actions.onPreview(file)}
          title={`Preview ${file.originalName}`}
          type="button"
        >
          {file.originalName}
        </button>
        <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span>{formatBytes(file.bytes)}</span>
          <span aria-hidden>·</span>
          <span>{new Date(file.createdAt * 1000).toLocaleDateString()}</span>
          <span aria-hidden>·</span>
          <KnowledgeStatusBadge file={file} />
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/file:opacity-100">
        <button
          aria-label={`Preview ${file.originalName}`}
          className="text-muted-foreground hover:text-foreground rounded p-1"
          onClick={() => actions.onPreview(file)}
          title="Preview file"
          type="button"
        >
          <EyeIcon className="size-3.5" />
        </button>
        {file.status === "failed" && (
          <button
            aria-label={`Retry indexing ${file.originalName}`}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => actions.onRetry(file)}
            title={file.error ? `Retry indexing — last error: ${file.error}` : "Retry indexing"}
            type="button"
          >
            <RotateCcwIcon className="size-3.5" />
          </button>
        )}
        {inSessionList ? (
          <button
            aria-label={`Remove ${file.originalName} from this session`}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => actions.onRemove(file)}
            title="Remove from this session — the agent stops searching it here"
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : (
          <button
            aria-label={`Add ${file.originalName} to this session`}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            onClick={() => actions.onAdd(file)}
            title="Add to this session — makes this document searchable by the agent in this chat"
            type="button"
          >
            <PlusIcon className="size-3.5" />
          </button>
        )}
        <button
          aria-label={`Delete ${file.originalName}`}
          className={`rounded p-1 ${confirmDelete ? "text-destructive" : "text-muted-foreground hover:text-destructive"}`}
          onClick={() => actions.onDelete(file)}
          title={confirmDelete ? "Click again to confirm — deletes the document everywhere" : "Delete document"}
          type="button"
        >
          <TrashIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
};
