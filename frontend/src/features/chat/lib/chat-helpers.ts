import type { UIMessage } from "@/lib/ai-types";
import type { ChatMessageInfo, ChatSessionInfo } from "@/lib/api";

export interface SessionGroup {
  label: string;
  sessions: ChatSessionInfo[];
}

export function historyToMessages(rows: ChatMessageInfo[]): UIMessage[] {
  return rows.map((row) => {
    const plan = parsePersistedPlan(row.content);
    if (plan) {
      return {
        id: `db-${row.id}`,
        role: row.role,
        parts: [{ type: "text", text: planToText(plan), state: "done" }],
      };
    }
    return {
      id: `db-${row.id}`,
      role: row.role,
      parts: [{ type: "text", text: row.content, state: "done" }],
    };
  });
}

/** Structured supervisor-plan record persisted by useSupervisorPlan. */
interface PersistedPlanRecord {
  type: "supervisor-plan";
  v: number;
  goal: string | null;
  steps: { id: string; tool: string; state: string; output?: string }[];
  output: string | null;
  /** Still in flight when last written — the run never reached a terminal
   *  event (app quit / crash). */
  partial?: boolean;
}

function parsePersistedPlan(content: string): PersistedPlanRecord | null {
  if (!content.startsWith("{")) return null;
  try {
    const value = JSON.parse(content) as Partial<PersistedPlanRecord>;
    if (value?.type !== "supervisor-plan" || !Array.isArray(value.steps)) return null;
    return value as PersistedPlanRecord;
  } catch {
    return null;
  }
}

/** Render a persisted plan record as readable history text. */
function planToText(plan: PersistedPlanRecord): string {
  const lines = plan.steps.map((s) => {
    const mark = s.state === "completed" ? "✓" : s.state === "failed" ? "✗" : s.state === "skipped" ? "→" : "·";
    return `${mark} ${s.id} [${s.tool}] — ${s.state}`;
  });
  const goal = plan.goal ? `Goal: ${plan.goal}\n` : "";
  const outline = lines.length > 0 ? `[plan]\n${lines.join("\n")}\n\n` : "";
  const tail = plan.partial ? "(run interrupted before completion)" : (plan.output ?? "(plan completed)");
  return `${goal}${outline}${tail}`;
}

export function toFriendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("already running") || lower.includes("generation is already")) {
    return "Masih memproses jawaban sebelumnya. Tunggu sebentar atau tekan Stop untuk membatalkan.";
  }
  return raw;
}

export function sessionPeriod(createdAt: number | null): "Today" | "Yesterday" | "Earlier" {
  if (!createdAt) return "Earlier";
  const date = new Date(createdAt * 1000);
  const today = new Date();
  const isSameDay = date.toDateString() === today.toDateString();
  if (isSameDay) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return "Earlier";
}

/** Compact relative time for session rows and run lists — "just now",
 *  "5m ago", "3h ago", "2d ago", then an absolute date ("Aug 12" within the
 *  current year, "Aug 12, 2024" otherwise). `now` (ms) is injectable so tests
 *  stay deterministic; a missing timestamp renders as an empty string. */
export function relativeTime(unixSeconds: number | null | undefined, now = Date.now()): string {
  if (!unixSeconds) return "";
  const delta = Math.max(0, now - unixSeconds * 1000);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(unixSeconds * 1000);
  const currentYear = new Date(now).getFullYear();
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === currentYear
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

// Tool-call markup never renders as prose: taught ```tool fences and Gemma 4 native <|tool_call>… forms are stripped to tool cards.
export function stripToolMarkup(s: string): string {
  return s
    .replace(/```tool[\s\S]*?```/gi, "")
    .replace(/<\|tool_call[^>]*>[\s\S]*?(?:<tool_call\|>|<\|tool_call_end\|>)/gi, "")
    .replace(/<\|(?:tool_call[^>]*|tool_response[^>]*|channel>[^>]*|message\||end\|)>/gi, "")
    .replace(/\b(?:call|response):[a-z0-9_]+\s*\{[^{}]*\}/gi, "")
    .trim();
}

/** The @-mention currently being typed at `caret`: its query plus the exact
 *  [start, end) span of "@query" in `value`, or null when no mention is
 *  active (@ must follow whitespace/start and the query must not contain
 *  whitespace). The span lets callers delete exactly what was typed instead
 *  of guessing with string search. */
export function activeMentionRange(value: string, caret: number): { query: string; start: number; end: number } | null {
  const upTo = value.slice(0, caret);
  const at = upTo.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? " " : upTo[at - 1];
  if (!/\s/.test(before)) return null;
  const query = upTo.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at, end: caret };
}

/** Bucket sessions into Today / Yesterday / Earlier by last activity,
 *  preserving list order; empty buckets drop out. Shared by the sessions hook
 *  and the switcher (server-side search results group through this too). */
export function groupSessions(sessions: ChatSessionInfo[]): SessionGroup[] {
  if (sessions.length === 0) return [];
  return (["Today", "Yesterday", "Earlier"] as const)
    .map((label) => ({
      label,
      sessions: sessions.filter((s) => sessionPeriod(s.updatedAt ?? s.createdAt) === label),
    }))
    .filter((g) => g.sessions.length > 0);
}

/** Markdown transcript of a session — the export payload. One `##` section
 *  per message (plan records render through the same `planToText` the history
 *  view uses; plain text strips tool markup). Times and the export stamp are
 *  UTC; `exportedAt` (ms) is injectable so tests stay deterministic. */
export function sessionToMarkdown(title: string | null, rows: ChatMessageInfo[], exportedAt = Date.now()): string {
  const stamp = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const lines: string[] = [
    `# ${title?.trim() || "Untitled session"}`,
    "",
    `_Exported ${stamp(new Date(exportedAt))} UTC_`,
    "",
  ];
  for (const row of rows) {
    const plan = parsePersistedPlan(row.content);
    const body = plan ? planToText(plan) : stripToolMarkup(row.content);
    const who = row.role === "user" ? "You" : "Assistant";
    const at = row.createdAt ? ` · ${stamp(new Date(row.createdAt * 1000))}` : "";
    lines.push(`## ${who}${at}`, "", body, "");
  }
  return lines.join("\n");
}
