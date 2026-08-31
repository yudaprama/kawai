import type { UIMessage } from "@/lib/ai-types";
import type { ChatMessageInfo } from "@/lib/api";

export function historyToMessages(rows: ChatMessageInfo[]): UIMessage[] {
  return rows.map((row) => ({
    id: `db-${row.id}`,
    role: row.role,
    parts: [{ type: "text", text: row.content, state: "done" }],
  }));
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
