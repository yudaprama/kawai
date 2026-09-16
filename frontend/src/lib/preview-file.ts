import { base64ToText } from "@/lib/base64";
import type { KnowledgeFileInfo } from "@/lib/api";
import { call } from "@/lib/api";
import { useEffect, useState } from "react";

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
 * `text` for text/markdown rendering.
 *
 * One network fetch per `file.id` per session: results are cached at module
 * level and concurrent callers share a single in-flight promise. This keeps
 * the preview stable under React StrictMode's double-mounted effects and
 * remounts (reopen the same file → instant, no loading flash).
 */
const previewCache = new Map<string, { mime: string; dataBase64: string }>();
const previewInflight = new Map<string, Promise<{ mime: string; dataBase64: string }>>();

function fetchPreviewBytes(fileId: string): Promise<{ mime: string; dataBase64: string }> {
  const hit = previewCache.get(fileId);
  if (hit) return Promise.resolve(hit);
  const inflight = previewInflight.get(fileId);
  if (inflight) return inflight;
  const p = call<{ mime: string; dataBase64: string }>("office_read_file", { fileId })
    .then((res) => {
      previewCache.set(fileId, res);
      return res;
    })
    .finally(() => {
      previewInflight.delete(fileId);
    });
  previewInflight.set(fileId, p);
  return p;
}

export function useFilePreview(file: PreviewFile) {
  const [data, setData] = useState<{ mime: string; dataBase64: string } | undefined>(
    // warm start: a cached file renders instantly on mount
    () => previewCache.get(file.id),
  );
  const [isLoading, setIsLoading] = useState(() => !previewCache.has(file.id));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = previewCache.get(file.id);
    if (cached) {
      setData(cached);
      setIsLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetchPreviewBytes(file.id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(errTextSafe(e));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  const preview = data != null ? toPreviewData(data) : undefined;
  return { data: preview, isLoading, error };
}

function errTextSafe(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
