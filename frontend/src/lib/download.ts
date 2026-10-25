import { platform } from "@/platform";

/**
 * Downloads a string or Blob. Spreadsheet exports get a UTF-8 BOM so Excel
 * reads non-ASCII text correctly; the actual save goes through the platform
 * adapter, which needs a user-chosen destination on mobile.
 */
export function triggerDownload(filename: string, content: string | Blob, mimeType: string) {
  const bom = typeof content === "string" && mimeType.startsWith("text/csv") ? "\uFEFF" : "";
  const blob = typeof content === "string" ? new Blob([bom + content], { type: mimeType }) : content;
  void platform.saveBlob(blob, filename);
}
