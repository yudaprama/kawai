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
  /** Load the downscaled preview JPEG instead of the full file. Grid tiles
   *  set this; the click-to-preview overlay never does. */
  thumb?: boolean;
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
 * (`office_read_file`, or `office_read_thumbnail` for grid tiles). Returns a
 * `data:` URL for media embeds and a decoded `text` for text/markdown
 * rendering.
 *
 * One network fetch per cache key per session: results are cached at module
 * level and concurrent callers share a single in-flight promise. This keeps
 * the preview stable under React StrictMode's double-mounted effects and
 * remounts (reopen the same file → instant, no loading flash).
 *
 * The cache is a bounded LRU, not a plain map: a generator gallery mounting
 * dozens of tiles would otherwise pin every full file it ever opened in memory
 * for the life of the window.
 */
const PREVIEW_CACHE_MAX = 64;
type CachedBytes = { mime: string; dataBase64: string };
/** Insertion order doubles as recency: a re-read moves the key to the end. */
const previewCache = new Map<string, CachedBytes>();
const previewInflight = new Map<string, Promise<CachedBytes>>();

/** Thumbnail and full read of the same document must never share an entry. */
function cacheKey(file: PreviewFile): string {
  return `${file.id}:${file.thumb ? "t" : "f"}`;
}

function cacheRead(key: string): CachedBytes | undefined {
  const hit = previewCache.get(key);
  if (!hit) return undefined;
  previewCache.delete(key);
  previewCache.set(key, hit);
  return hit;
}

function cacheWrite(key: string, value: CachedBytes): void {
  previewCache.set(key, value);
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next();
    if (oldest.done) break;
    previewCache.delete(oldest.value);
  }
}

function fetchPreviewBytes(key: string, fileId: string, thumb: boolean | undefined): Promise<CachedBytes> {
  const hit = cacheRead(key);
  if (hit) return Promise.resolve(hit);
  const inflight = previewInflight.get(key);
  if (inflight) return inflight;
  const op = thumb ? "office_read_thumbnail" : "office_read_file";
  const p = call<CachedBytes>(op, { fileId })
    .then((res) => {
      cacheWrite(key, res);
      return res;
    })
    .finally(() => {
      previewInflight.delete(key);
    });
  previewInflight.set(key, p);
  return p;
}

export function useFilePreview(file: PreviewFile) {
  const key = cacheKey(file);
  const { id: fileId, thumb } = file;
  const [data, setData] = useState<CachedBytes | undefined>(() => cacheRead(key));
  const [isLoading, setIsLoading] = useState(() => cacheRead(key) === undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = cacheRead(key);
    if (cached) {
      setData(cached);
      setIsLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetchPreviewBytes(key, fileId, thumb)
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
  }, [key, fileId, thumb]);

  const preview = data != null ? toPreviewData(data) : undefined;
  return { data: preview, isLoading, error };
}

function errTextSafe(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
