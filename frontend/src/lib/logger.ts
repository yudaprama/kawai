import * as Sentry from "@sentry/react";
import { call, errText } from "@/lib/api";

/**
 * Unified logger — single source of truth for all error reporting.
 * Every call goes to 3 places at once (where appropriate):
 *  1. console (dev — visible in DevTools / Tauri WebView console)
 *  2. Sentry (prod — dashboard, alerting)
 *  3. frontend_log (Tauri — ~/Library/Logs/kawai/app.log on macOS)
 *
 * This fixes the confusion: previously `console.error` didn't send to Sentry,
 * and Sentry auto-captures didn't print to console. Now every path is explicit.
 */

// Messages that are expected transient noise — never send to Sentry as errors.
// They become breadcrumbs/warnings only, so they don't flood the dashboard.
const IGNORED_SUBSTRINGS = ["not authenticated", "no model loaded", "already running"];

function isIgnored(msg: string): boolean {
  const lower = msg.toLowerCase();
  return IGNORED_SUBSTRINGS.some((s) => lower.includes(s));
}

function messageFrom(tag: string, err: unknown): string {
  return `[${tag}] ${errText(err)}`;
}

/** Fire-and-forget mirror to Tauri backend log file. */
function toFrontendLog(level: "error" | "warn" | "info", message: string): void {
  call("frontend_log", { level, message }).catch(() => {});
}

/**
 * Log an error — prints to console AND sends to Sentry AND mirrors to backend log.
 * Ignored messages (see IGNORED_SUBSTRINGS) are downgraded to warn + breadcrumb only.
 */
export function logError(tag: string, err: unknown, extra?: Record<string, unknown>): void {
  const msg = messageFrom(tag, err);

  if (isIgnored(msg)) {
    console.warn(msg, extra ?? "");
    Sentry.addBreadcrumb({
      category: tag,
      message: msg,
      level: "warning",
      data: extra,
    });
    toFrontendLog("warn", msg);
    return;
  }

  console.error(msg, err, extra ?? "");
  const exception = err instanceof Error ? err : new Error(msg);
  Sentry.captureException(exception, {
    tags: { tag },
    extra: { message: msg, ...extra },
  });
  toFrontendLog("error", msg);
}

/** Log a warning — console.warn + Sentry breadcrumb + backend log. */
export function logWarn(tag: string, err: unknown, extra?: Record<string, unknown>): void {
  const msg = messageFrom(tag, err);
  console.warn(msg, extra ?? "");
  Sentry.addBreadcrumb({
    category: tag,
    message: msg,
    level: "warning",
    data: extra,
  });
  toFrontendLog("warn", msg);

  // Also send to Sentry as low-severity event if not ignored, so it shows up
  // in dashboard without being an "error".
  if (!isIgnored(msg)) {
    Sentry.captureMessage(msg, {
      level: "warning",
      tags: { tag },
      extra,
    });
  }
}

/** Log info — console + breadcrumb only (no Sentry event). */
export function logInfo(tag: string, message: string, extra?: Record<string, unknown>): void {
  console.log(`[${tag}] ${message}`, extra ?? "");
  Sentry.addBreadcrumb({
    category: tag,
    message,
    level: "info",
    data: extra,
  });
  toFrontendLog("info", `[${tag}] ${message}`);
}
