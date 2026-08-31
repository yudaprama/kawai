import { invoke } from "@tauri-apps/api/core";
import { runningInTauri } from "@/platform";

export type NotificationPermissionState = "not_tauri" | "granted" | "denied" | "prompt" | "unknown";

interface ShowNativeNotificationArgs {
  title: string;
  body: string;
  tag?: string;
}

interface ShowNativeNotificationResult {
  delivered: boolean;
  reason?: "not_tauri" | "send_failed";
  error?: string;
}

// Maps the Rust commands' raw status string onto the frontend's
// three-state union. Provisional / ephemeral are treated as granted
// because the OS allows quiet delivery in those modes.
function mapBackendState(raw: string): NotificationPermissionState {
  const state = raw.toLowerCase();
  if (state === "granted" || state === "provisional" || state === "ephemeral") return "granted";
  if (state === "denied") return "denied";
  if (state === "not_determined" || state === "prompt" || state === "default") return "prompt";
  return "unknown";
}

/**
 * Get the current OS notification permission state. When `requestIfNeeded`
 * is true (default) and the state is `not_determined`, triggers the OS
 * permission prompt automatically.
 */
export async function getNotificationPermissionState(options?: {
  requestIfNeeded?: boolean;
}): Promise<NotificationPermissionState> {
  const requestIfNeeded = options?.requestIfNeeded ?? true;
  if (!runningInTauri) return "not_tauri";

  try {
    const stateRaw = await invoke<string>("notification_permission_state");
    const state = mapBackendState(String(stateRaw ?? "unknown"));

    if (state === "granted" || state === "denied") return state;
    if (!requestIfNeeded) return state;

    const requestRaw = await invoke<string>("notification_permission_request");
    return mapBackendState(String(requestRaw ?? "unknown"));
  } catch {
    return "unknown";
  }
}

/**
 * Request OS notification permission if not already granted.
 * Returns true if permission is (or was just) granted, false otherwise.
 * No-op (returns false) when running outside Tauri.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  const state = await getNotificationPermissionState();
  return state === "granted";
}

/**
 * Show a native OS notification. No-op when running outside Tauri.
 *
 * On macOS the Rust command waits for the completion handler, so a resolved
 * `{ delivered: true }` means the OS accepted the request.
 */
export async function showNativeNotification(args: ShowNativeNotificationArgs): Promise<ShowNativeNotificationResult> {
  if (!runningInTauri) {
    return { delivered: false, reason: "not_tauri" };
  }
  try {
    await invoke("show_native_notification", {
      title: args.title,
      body: args.body,
      tag: args.tag ?? null,
    });
    return { delivered: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { delivered: false, reason: "send_failed", error: message };
  }
}
