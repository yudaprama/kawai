/**
 * Decoupled bridge from tool-renderer cards (inside the vendored
 * ai-elements tree, which must not thread app callbacks) to the app-level
 * preview state: a card emits, App listens and opens the PreviewDialog.
 */
export const OPEN_PREVIEW_EVENT = "kawai:open-file-preview";

export interface OpenPreviewDetail {
  fileId: string;
  name: string;
}

export function emitOpenPreview(fileId: string, name: string): void {
  window.dispatchEvent(new CustomEvent<OpenPreviewDetail>(OPEN_PREVIEW_EVENT, { detail: { fileId, name } }));
}
