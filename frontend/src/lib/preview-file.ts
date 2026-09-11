import { base64ToText } from "@/lib/base64";
import type { KnowledgeFileInfo } from "@/lib/api";
import { useOp } from "@/hooks/use-op";

/** A source-agnostic file the preview can render. */
export interface PreviewFile {
  id: string;
  name: string;
  /** Byte size, when known — shown in the preview header. */
  size?: number;
}

/** Adapts a knowledge panel row to the preview model. */
export function knowledgeFileToPreview(f: KnowledgeFileInfo): PreviewFile {
  return { id: f.id, name: f.originalName, size: f.bytes };
}

export interface FilePreviewData {
  mime: string;
  dataBase64: string;
  /** `data:` URL suitable for `<img>`/`<video>`/`<iframe>` embeds. */
  dataUrl: string;
  /** Decoded text body, only for `text/*` MIME types. */
  text?: string;
}

function toPreviewData(res: { mime: string; dataBase64: string }): FilePreviewData {
  const dataUrl = `data:${res.mime};base64,${res.dataBase64}`;
  const isText = res.mime.startsWith("text/") && !res.mime.includes("html");
  return {
    mime: res.mime,
    dataBase64: res.dataBase64,
    dataUrl,
    text: isText ? base64ToText(res.dataBase64) : undefined,
  };
}

/**
 * Resolves the raw bytes for a preview file via the office store read command
 * (`office_read_file`). Returns a `data:` URL for media embeds and a decoded
 * `text` for text/markdown rendering. One fetch per `file.id` (the preview
 * switch mounts a single renderer, so only that renderer calls this hook).
 */
export function useFilePreview(file: PreviewFile) {
  const op = useOp<{ mime: string; dataBase64: string }>("office_read_file", { fileId: file.id }, { onError: "log" });

  const data = op.data != null ? toPreviewData(op.data) : undefined;

  return { data, isLoading: op.loading, error: op.error };
}
