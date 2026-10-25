/**
 * Slim platform contract for the kawai frontend. The vendored ai-elements
 * components call these capabilities; kawai ships a single adapter backed by
 * the standard Web APIs (the Tauri desktop webview is a full browser engine),
 * so the same adapter serves the future web target too — only the transport
 * (`invoke`+`Channel` vs `fetch`+SSE) differs, which lives outside Platform.
 */

export type PlatformTarget = "desktop" | "mobile" | "web";

/** Outcome of handing bytes to the device: user cancelled the save sheet, or the write failed. */
export type SaveResult = "saved" | "cancelled" | "failed";

export interface PickFilesOptions {
  multiple?: boolean;
  accept?: string[];
  capture?: "user" | "environment";
}

export interface Platform {
  readonly target: PlatformTarget;
  readonly canDictate: boolean;
  readonly canCapturePhoto: boolean;
  readonly canCaptureScreenshot: boolean;
  readonly canReadClipboardImage: boolean;
  pickFiles(options?: PickFilesOptions): Promise<File[] | null>;
  /**
   * Native file open dialog returning absolute paths (Tauri desktop).
   * Resolves `null` on cancel or in non-Tauri environments — fall back to
   * `pickFiles` there.
   */
  pickFilePaths(options?: PickFilesOptions): Promise<string[] | null>;
  /** Prompts for a URL (e.g. a YouTube link) and resolves the trimmed value or null on cancel. */
  promptForUrl(label?: string): Promise<string | null>;
  capturePhoto(): Promise<File | null>;
  captureScreenshot(): Promise<File | null>;
  writeClipboardText(text: string): Promise<boolean>;
  readClipboardImage(): Promise<File | null>;
  share(text: string): Promise<void>;
  /**
   * Saves bytes to the user's device. Desktop/web use the browser download
   * path; mobile has no download handler, so it opens the system save sheet
   * and writes the bytes to the returned SAF/file-provider URI.
   */
  saveBlob(blob: Blob, name: string): Promise<SaveResult>;
}
