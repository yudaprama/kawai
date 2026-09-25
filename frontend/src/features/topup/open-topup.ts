/**
 * Navigation bridge for the Top Up asset page: the Fase 0a token gate at
 * goal submit (use-workbench) asks App to open the page without threading
 * callbacks through the workbench tree — same pattern as
 * lib/preview-bridge.ts.
 */
export const OPEN_TOPUP_EVENT = "kawai:open-topup";

export function emitOpenTopup(): void {
  window.dispatchEvent(new CustomEvent(OPEN_TOPUP_EVENT));
}
