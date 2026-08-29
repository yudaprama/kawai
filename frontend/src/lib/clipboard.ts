import { writeClipboardTextViaBrowser } from "@/platform/shared-media";

/**
 * Copy text to the clipboard. Delegates to the platform's browser fallback
 * implementation (async Clipboard API + hidden-textarea execCommand).
 *
 * @returns `true` when the copy succeeded, otherwise `false`.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  return writeClipboardTextViaBrowser(text);
}

/**
 * Collects every `File` item carried by a paste/drop `DataTransfer`. Returns an
 * empty array when there are none (or no clipboard data), so callers can decide
 * whether to fall back to plain-text handling.
 */
export function extractFilesFromDataTransfer(data: DataTransfer | null): File[] {
  const items = data?.items;
  if (!items) return [];

  const files: File[] = [];
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}
