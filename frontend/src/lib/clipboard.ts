/**
 * Copy text to the clipboard. The Tauri webview supports the async Clipboard
 * API; the legacy textarea + execCommand path covers the rare denial case.
 *
 * @returns `true` when the copy succeeded, otherwise `false`.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
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
