import { Icon } from "@/components/shared/icon";
import { FileIcon } from "@/components/shared/file-icon";
import { Spinner } from "@/components/ui/spinner";
import type { KnowledgeFileInfo } from "@/lib/api";

/** Inline chip bar showing session-attached files above the composer.
 *  Each chip shows the file icon, name, and a spinner while RAG indexing
 *  runs in the background. An ✕ button removes the file from the session. */
export function AttachedFilesChips({
  files,
  onRemove,
}: {
  files: KnowledgeFileInfo[];
  onRemove?: (file: KnowledgeFileInfo) => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-1.5">
      {files.map((f) => {
        const indexing = f.status === "indexing";
        const failed = f.status === "failed";
        return (
          <span
            className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${
              failed
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : indexing
                  ? "border-primary/30 bg-primary/5 text-primary"
                  : "border-border/60 bg-accent/50 text-foreground/80"
            }`}
            key={f.id}
            title={
              failed
                ? `Index failed${f.error ? `: ${f.error}` : ""}`
                : indexing
                  ? "RAG indexing in progress…"
                  : f.chunks > 0
                    ? `${f.chunks} chunks indexed`
                    : "Ready"
            }
          >
            <FileIcon name={f.originalName} className="size-3 shrink-0" />
            <span className="truncate">{f.originalName}</span>
            {indexing && <Spinner className="size-3 shrink-0" />}
            {!indexing && f.chunks > 0 && <span className="text-muted-foreground shrink-0">{f.chunks}</span>}
            {onRemove && (
              <button
                aria-label={`Remove ${f.originalName}`}
                className="hover:bg-foreground/10 -mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-full"
                onClick={() => onRemove(f)}
                type="button"
              >
                <Icon name="x" className="size-2.5" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
