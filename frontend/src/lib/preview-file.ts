import { useEffect, useState } from "react";
import { call, type KnowledgeFileInfo } from "@/lib/api";

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

import { base64ToText } from "@/lib/base64";

export interface FilePreviewData {
  mime: string;
  dataBase64: string;
  /** `data:` URL suitable for `<img>`/`<video>`/`<iframe>` embeds. */
  dataUrl: string;
  /** Decoded text body, only for `text/*` MIME types. */
  text?: string;
}

/**
 * Resolves the raw bytes for a preview file via the office store read command
 * (`office_read_file`). Returns a `data:` URL for media embeds and a decoded
 * `text` for text/markdown rendering. One fetch per `file.id` (the preview
 * switch mounts a single renderer, so only that renderer calls this hook).
 */
export function useFilePreview(file: PreviewFile) {
  const [data, setData] = useState<FilePreviewData | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setError(null);
    setIsLoading(true);
    call<{ mime: string; dataBase64: string }>("office_read_file", {
      fileId: file.id,
    })
      .then((res) => {
        if (cancelled) return;
        const dataUrl = `data:${res.mime};base64,${res.dataBase64}`;
        const isText = res.mime.startsWith("text/");
        setData({
          mime: res.mime,
          dataBase64: res.dataBase64,
          dataUrl,
          text: isText ? base64ToText(res.dataBase64) : undefined,
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  return { data, isLoading, error };
}
