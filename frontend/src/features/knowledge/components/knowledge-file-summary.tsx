import type { ReactNode } from "react";
import { FileIcon } from "@/components/shared/file-icon";
import type { KnowledgeFileInfo } from "@/lib/api";

/**
 * Shared knowledge-file detail header: file-type icon + truncated original
 * name, a caller-supplied subtitle under the name, and an optional right-side
 * actions slot on the same row. Used by the Wiki source detail and the
 * knowledge library detail pane — list rows use `KnowledgeFileRow` instead.
 */
export function KnowledgeFileSummary({
  file,
  subtitle,
  actions,
}: {
  file: KnowledgeFileInfo;
  /** Rendered under the name (meta line, asset id, badges…). */
  subtitle?: ReactNode;
  /** Right-aligned action buttons on the header row. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <FileIcon className="mt-0.5 size-5 shrink-0" name={file.originalName} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold" title={file.originalName}>
          {file.originalName}
        </h3>
        {subtitle}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}
