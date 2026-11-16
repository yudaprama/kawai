import { Channel, invoke } from "@tauri-apps/api/core";
import { runningInTauri } from "@/platform";

/**
 * Request-response RPC to the kawai backend. Desktop runs Tauri invoke
 * (in-process IPC); the Axum web build falls back to `POST /api/<command>`
 * (same one-snake_case-string contract, `{ error }` failure shape).
 * Command names are the snake_case Rust fn names; args are camelCase.
 */
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (runningInTauri) return invoke<T>(command, args ?? {});
  return httpCall<T>(command, args);
}

/** HTTP bridge for the web build — mirrors invoke's rejection shape so
 *  `errText()` keeps working unchanged. */
async function httpCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    // Read the body ONCE as text. Most Axum handlers answer `(StatusCode,
    // String)`, which serializes as `text/plain` — `res.json()` throws on it
    // and the old fallback threw away the only copy of the real message
    // ("incorrect email or password" → "Unauthorized"). The `{ error }` shape
    // (`error_response`, the auth middleware) still wins when present.
    const raw = (await res.text().catch(() => "")).slice(0, 500);
    let message = res.statusText || `HTTP ${res.status}`;
    if (raw.trim() !== "") {
      try {
        const body = JSON.parse(raw) as { error?: string };
        message = typeof body?.error === "string" ? body.error : raw;
      } catch {
        message = raw;
      }
    }
    throw new Error(message);
  }
  // 204 No Content is the success answer for every op that has nothing to
  // return (`auth_reset_request`, `delete_chat_session`, `office_delete_file`,
  // the `local_llm_*` toggles, …). `res.json()` on an empty body throws
  // `SyntaxError: Unexpected end of JSON input`, which surfaced as a failed
  // op — the reset code WAS mailed while the form reported an error.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** RPC that ALSO streams progress events over a Channel while awaiting the
 *  command's return value (e.g. `plan_task`: live planning rounds + the
 *  final plan as the resolved value). */
export function callWithEvents<T, E extends { type: string }>(
  command: string,
  args: Record<string, unknown> | undefined,
  onEvent: (event: E) => void,
): Promise<T> {
  const channel = new Channel<E>();
  channel.onmessage = onEvent;
  return invoke<T>(command, { ...(args ?? {}), onEvent: channel });
}

/** Tauri invoke rejects with a bare string, not an Error. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Open a stored file in the OS default viewer (desktop only). */
export function tauriOpenFile(fileId: string): Promise<void> {
  return call<void>("tauri_open_file", { fileId });
}

export function respondSupervisorConfirmation(streamId: string, stepId: string, approved: boolean): Promise<void> {
  return call<void>("respond_supervisor_confirmation", { streamId, stepId, approved });
}

import type { CodegraphExploreResult, CodegraphStatusResult } from "@/generated/api-types";

export type * from "@/generated/api-types";

export const MEMORY_KINDS = ["preference", "rule", "event", "fact", "goal"] as const;

export function codegraphExplore(query: string, projectPath?: string): Promise<CodegraphExploreResult> {
  return call<CodegraphExploreResult>("codegraph_explore", { query, projectPath: projectPath ?? null });
}

export function codegraphStatus(projectPath?: string): Promise<CodegraphStatusResult> {
  return call<CodegraphStatusResult>("codegraph_status", { projectPath: projectPath ?? null });
}

export function codegraphIsAvailable(): Promise<boolean> {
  return call<boolean>("codegraph_is_available");
}

export function codegraphInit(projectPath?: string): Promise<CodegraphStatusResult> {
  return call<CodegraphStatusResult>("codegraph_init", { projectPath: projectPath ?? null });
}

// ── TTS (supertonic, feature "tts") ────────────────────────────────────────

/**
 * Synthesize speech from text using the Supertonic neural TTS engine
 * (on-device, language auto-detected).
 * Returns base64-encoded WAV audio for playback.
 * @param text - Text to synthesize
 * @param voice - Supertonic voice id `M1`–`F5` (optional, defaults to M1)
 * @param lengthScale - Speech speed (1.0 = normal, <1.0 = faster, >1.0 = slower)
 */
export function synthesizeSpeech(text: string, voice?: string, lengthScale?: number): Promise<string> {
  return call<string>("synthesize_speech", {
    text,
    voice: voice ?? null,
    lengthScale: lengthScale ?? null,
  });
}
