/**
 * kawai platform adapter — the desktop webview (WKWebView) is a full browser
 * engine, so every capability is implemented with the standard Web APIs from
 * `shared-media`. No `@tauri-apps/*` plugins are needed here.
 */

import { open } from "@tauri-apps/plugin-dialog";

import type { Platform, PickFilesOptions } from './types'
import {
  capturePhotoViaUserMedia,
  captureScreenshotViaDisplayMedia,
  detectDictationMode,
  hasClipboardRead,
  hasGetDisplayMedia,
  hasGetUserMedia,
  pickFilesViaInput,
  promptForUrlViaBrowser,
  readClipboardImageViaBrowser,
  shareViaBrowser,
  writeClipboardTextViaBrowser,
} from './shared-media'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** `.ext`/mime accept list → tauri-plugin-dialog `filters` shape. */
function toDialogFilters(accept?: string[]): { name: string; extensions: string[] }[] {
  if (!accept?.length) return []
  const exts = accept
    .map((a) => (a.startsWith('.') ? a.slice(1) : null))
    .filter((e): e is string => !!e && /^[a-z0-9]+$/i.test(e))
  if (!exts.length) return []
  return [{ name: 'Accepted files', extensions: [...new Set(exts)] }]
}

/**
 * Native open dialog → absolute paths (desktop). `null` when cancelled or
 * when running outside Tauri (fall back to the browser picker there).
 */
async function pickFilePathsViaDialog(options?: PickFilesOptions): Promise<string[] | null> {
  if (!isTauri) return null
  try {
    const result = await open({
      multiple: options?.multiple ?? false,
      directory: false,
      filters: toDialogFilters(options?.accept),
    })
    if (result == null) return null
    return Array.isArray(result) ? result : [result]
  } catch (err) {
    console.warn('[dialog:open]', err)
    return null
  }
}

export const platform: Platform = {
  // kawai is desktop-only for now (macOS MVP); mobile arrives with the Tauri
  // mobile shells.
  target: 'desktop',
  canDictate: detectDictationMode() !== 'none',
  canCapturePhoto: hasGetUserMedia(),
  canCaptureScreenshot: hasGetDisplayMedia(),
  canReadClipboardImage: hasClipboardRead(),
  pickFiles: (options) => pickFilesViaInput(options),
  pickFilePaths: pickFilePathsViaDialog,
  promptForUrl: promptForUrlViaBrowser,
  capturePhoto: () => capturePhotoViaUserMedia('user'),
  captureScreenshot: captureScreenshotViaDisplayMedia,
  writeClipboardText: writeClipboardTextViaBrowser,
  readClipboardImage: readClipboardImageViaBrowser,
  share: shareViaBrowser,
}

export const runningInTauri = isTauri
