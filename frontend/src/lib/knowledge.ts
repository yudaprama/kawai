import { IMAGE_EXTS as _IMAGE_EXTS, OFFICE_EXTS as _OFFICE_EXTS } from "@/lib/extensions";

export { dataUrlToFile, fileToBase64 } from "@/lib/base64";
export { ADD_FILE_ACCEPT, IMAGE_EXTS, OFFICE_EXTS } from "@/lib/extensions";

const OFFICE_EXTS = _OFFICE_EXTS;
const IMAGE_EXTS = _IMAGE_EXTS;

export function isYouTubeUrl(raw: string): boolean {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

export type KnowledgeSource =
  | { kind: "file"; name: string; sourcePath?: string; file?: File }
  | { kind: "unsupported"; name: string };

export function classifySource(name: string, src: { path?: string; file?: File }): KnowledgeSource {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (OFFICE_EXTS.has(ext) || IMAGE_EXTS.has(ext)) {
    return {
      kind: "file",
      name,
      ...(src.path ? { sourcePath: src.path } : { file: src.file }),
    };
  }
  return { kind: "unsupported", name };
}
