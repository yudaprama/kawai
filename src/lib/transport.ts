// Platform detection.
//
// In Tauri 2 the webview always injects `window.__TAURI_INTERNALS__` (used by
// `@tauri-apps/api` under the hood). We do NOT rely on `window.__TAURI__`
// because that only exists when `withGlobalTauri` is true, and with a bundler
// it is false.
export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
