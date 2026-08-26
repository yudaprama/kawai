/**
 * File classification for the Knowledge preview pane. Categories are chosen by
 * extension (parsed from `name`) and map to render strategies in
 * `components/file-preview.tsx`. The sets are subsets of
 * `FILEPROCESSOR_SUPPORTED_EXTENSIONS` in `lib/rag.ts` — anything not listed
 * here falls through to `unknown`, which renders a fallback card with a
 * download link.
 */

export type FileKind =
  | "image"
  | "video-native"
  | "video-fallback"
  | "pdf"
  | "html"
  | "text"
  | "markdown"
  | "office"
  | "unknown";

export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "tiff", "tif"]);

// Browser-native playable video (HTML5 <video>). mkv/avi/mov/etc. are not
// reliably decodable across browsers → fallback.
const VIDEO_NATIVE_EXTENSIONS = new Set(["mp4", "webm", "m4v", "ogg", "ogv"]);

const VIDEO_FALLBACK_EXTENSIONS = new Set(["mkv", "avi", "mov", "wmv", "flv", "mpeg", "mpg", "3gp"]);

const OFFICE_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);

// Decks (reveal.js html from the office agent) render in a sandboxed iframe;
// other html files preview the same way.
const HTML_EXTENSIONS = new Set(["html", "htm"]);

// Markdown is rendered with streamdown; everything else below goes through
// shiki via the CodeBlock component.
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "json",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "cpp",
  "c",
  "h",
  "hpp",
  "cs",
  "php",
  "rb",
  "go",
  "rs",
  "sh",
  "bash",
  "zsh",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "csv",
  "tsv",
  "env",
  "sql",
  "vue",
  "svelte",
  "dart",
  "kt",
  "swift",
  "lua",
  "r",
  "scala",
  "pl",
  "ps1",
  "dockerfile",
]);

/** Lowercase extension without the leading dot, or '' if none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function fileKind(name: string): FileKind {
  const ext = fileExtension(name);
  if (!ext) return "unknown";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_NATIVE_EXTENSIONS.has(ext)) return "video-native";
  if (VIDEO_FALLBACK_EXTENSIONS.has(ext)) return "video-fallback";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unknown";
}

/**
 * Map a filename to a shiki BundledLanguage id. Falls back to `'text'` for
 * anything shiki does not bundle. Filenames like `Dockerfile` are matched
 * explicitly.
 */
export function shikiLanguage(name: string): string {
  const base = name.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = fileExtension(name);
  // Most shiki language ids coincide with the extension; the few that don't
  // are remapped here.
  const remap: Record<string, string> = {
    htm: "html",
    hpp: "cpp",
    cs: "csharp",
    rs: "rust",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    py: "python",
    rb: "ruby",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    yml: "yaml",
    conf: "ini",
    cfg: "ini",
  };
  return remap[ext] ?? ext ?? "text";
}

export function isTextLike(kind: FileKind): boolean {
  return kind === "text" || kind === "markdown";
}

/** Best-effort MIME type from a filename's extension (for icon/renderer hints). */
export function guessMimeType(filename: string): string {
  const ext = fileExtension(filename);
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    md: "text/markdown",
  };
  return map[ext] ?? "application/octet-stream";
}
