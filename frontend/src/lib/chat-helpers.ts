import type { ChatMessageInfo } from "@/lib/api";
import type { UIMessage } from "@/lib/ai-types";

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
