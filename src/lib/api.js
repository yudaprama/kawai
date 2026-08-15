const { invoke } = window.__TAURI__.core;

// Request-response: Tauri invoke (desktop/mobile, in-process IPC).
// Web target dropped — this is Tauri-only (see kawai-vanilla reference).
export async function call(command, args) {
  return invoke(command, args ?? {});
}
