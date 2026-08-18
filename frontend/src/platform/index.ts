/**
 * kawai platform adapter — the desktop webview (WKWebView) is a full browser
 * engine, so every capability is implemented with the standard Web APIs from
 * `shared-media`. No `@tauri-apps/*` plugins are needed here.
 */

import type { Platform } from './types'
import {
  capturePhotoViaUserMedia,
  captureScreenshotViaDisplayMedia,
  detectDictationMode,
  hasClipboardRead,
  hasGetDisplayMedia,
  hasGetUserMedia,
  pickFilesViaInput,
  readClipboardImageViaBrowser,
  shareViaBrowser,
  writeClipboardTextViaBrowser,
} from './shared-media'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const platform: Platform = {
  // kawai is desktop-only for now (macOS MVP); mobile arrives with the Tauri
  // mobile shells.
  target: 'desktop',
  canDictate: detectDictationMode() !== 'none',
  canCapturePhoto: hasGetUserMedia(),
  canCaptureScreenshot: hasGetDisplayMedia(),
  canReadClipboardImage: hasClipboardRead(),
  pickFiles: (options) => pickFilesViaInput(options),
  capturePhoto: () => capturePhotoViaUserMedia('user'),
  captureScreenshot: captureScreenshotViaDisplayMedia,
  writeClipboardText: writeClipboardTextViaBrowser,
  readClipboardImage: readClipboardImageViaBrowser,
  share: shareViaBrowser,
}

export const runningInTauri = isTauri
