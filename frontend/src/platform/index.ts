/**
 * kawai platform adapter — the desktop webview (WKWebView) is a full browser
 * engine, so every capability is implemented with the standard Web APIs from
 * `shared-media`. The same adapter serves the future web target (identical
 * browser APIs); `target` is detected from the runtime. Only native-dialog
 * paths (Tauri desktop) differ, gated by `runningInTauri`.
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  capturePhotoViaUserMedia,
  captureScreenshotViaDisplayMedia,
  detectDictationMode,
  detectPlatformTarget,
  hasClipboardRead,
  hasGetDisplayMedia,
  hasGetUserMedia,
  pickFilesViaInput,
  promptForUrlViaBrowser,
  readClipboardImageViaBrowser,
  saveBlobViaBrowser,
  shareViaBrowser,
  writeClipboardTextViaBrowser,
} from "./shared-media";
import type { PickFilesOptions, Platform, SaveResult } from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const target = detectPlatformTarget();

/** `.ext`/mime accept list → tauri-plugin-dialog `filters` shape. */
function toDialogFilters(accept?: string[]): { name: string; extensions: string[] }[] {
  if (!accept?.length) return [];
  const exts = accept
    .map((a) => (a.startsWith(".") ? a.slice(1) : null))
    .filter((e): e is string => !!e && /^[a-z0-9]+$/i.test(e));
  if (!exts.length) return [];
  return [{ name: "Accepted files", extensions: [...new Set(exts)] }];
}

/**
 * Native open dialog → absolute paths (desktop). `null` when cancelled or
 * when running outside Tauri (fall back to the browser picker there).
 */
async function pickFilePathsViaDialog(options?: PickFilesOptions): Promise<string[] | null> {
  if (!isTauri) return null;
  try {
    const result = await open({
      multiple: options?.multiple ?? false,
      directory: false,
      filters: toDialogFilters(options?.accept),
    });
    if (result == null) return null;
    return Array.isArray(result) ? result : [result];
  } catch (err) {
    console.warn("[dialog:open]", err);
    return null;
  }
}

/**
 * Save bytes to the device. Android/iOS have no download handler — a blob
 * anchor is a silent no-op there — so mobile goes through the system save
 * sheet: `save()` returns the destination (on Android a SAF `content://` URI)
 * and `plugin-fs` writes through ContentResolver. Desktop/web keep the
 * browser download.
 */
async function saveBlobToDevice(blob: Blob, name: string): Promise<SaveResult> {
  if (target === "mobile") {
    try {
      const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
      const path = await save({
        defaultPath: name,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
      });
      if (path == null) return "cancelled";
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return "saved";
    } catch (err) {
      console.error("[platform:save]", err);
      return "failed";
    }
  }
  return saveBlobViaBrowser(blob, name);
}

export const platform: Platform = {
  target,
  canDictate: detectDictationMode() !== "none",
  canCapturePhoto: hasGetUserMedia(),
  canCaptureScreenshot: hasGetDisplayMedia(),
  canReadClipboardImage: hasClipboardRead(),
  pickFiles: (options) => pickFilesViaInput(options),
  pickFilePaths: pickFilePathsViaDialog,
  promptForUrl: promptForUrlViaBrowser,
  capturePhoto: () => capturePhotoViaUserMedia("user"),
  captureScreenshot: captureScreenshotViaDisplayMedia,
  writeClipboardText: writeClipboardTextViaBrowser,
  readClipboardImage: readClipboardImageViaBrowser,
  share: shareViaBrowser,
  saveBlob: saveBlobToDevice,
};

export const runningInTauri = isTauri;
