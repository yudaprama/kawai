import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./transport";

// Request-response abstraction.
//
// Desktop/Mobile: Tauri `invoke` (in-process IPC).
// Web:            HTTP POST to `/api/<command>` returning JSON.
//
// Both paths resolve to the same value, so components never branch on platform.
export async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) {
    return invoke<T>(command, args);
  }

  const res = await fetch(`/api/${command}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: args ? JSON.stringify(args) : "{}",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}
