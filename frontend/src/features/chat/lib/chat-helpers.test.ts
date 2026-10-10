import { describe, expect, it } from "vitest";
import {
  activeMentionRange,
  groupSessions,
  historyToMessages,
  relativeTime,
  sessionPeriod,
  sessionToMarkdown,
  stripToolMarkup,
  toFriendlyError,
} from "@/features/chat/lib/chat-helpers";
import type { ChatSession } from "@/lib/api";
import { setLocale } from "@/lib/i18n";

describe("stripToolMarkup", () => {
  it("keeps plain prose untouched", () => {
    expect(stripToolMarkup("Hello world")).toBe("Hello world");
  });

  it("strips ```tool fences", () => {
    const s = 'before\n```tool\n{"name":"web_read"}\n```\nafter';
    expect(stripToolMarkup(s)).toBe("before\n\nafter");
  });

  it("strips Gemma native tool_call frames", () => {
    const s = 'text<|tool_call>{"name":"f"}<|tool_call_end|>more';
    expect(stripToolMarkup(s)).toBe("textmore");
  });

  it("trims surrounding whitespace", () => {
    expect(stripToolMarkup("  hi  ")).toBe("hi");
  });
});

describe("relativeTime", () => {
  // Fixed clock so bucket assertions never flake.
  const now = 1_800_000_000_000;
  const ago = (ms: number) => Math.floor((now - ms) / 1000);

  it("returns empty for a missing timestamp", () => {
    expect(relativeTime(null)).toBe("");
    expect(relativeTime(undefined)).toBe("");
  });

  it("collapses the first minute", () => {
    expect(relativeTime(ago(30_000), now)).toBe("just now");
    expect(relativeTime(ago(59_000), now)).toBe("just now");
  });

  it("buckets minutes, hours, and days", () => {
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3h ago");
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe("2d ago");
  });

  it("switches to an absolute date past a week", () => {
    const label = relativeTime(ago(10 * 86_400_000), now);
    expect(label).not.toMatch(/^(just now|\d+[mhd] ago)$/);
    expect(label.length).toBeGreaterThan(0);
  });

  it("never reports a future timestamp as negative age", () => {
    expect(relativeTime(Math.floor(now / 1000) + 600, now)).toBe("just now");
  });

  it("formats the absolute-date tail in the APP locale, not the OS one", () => {
    // Past a week it stops bucketing and prints a date. That date used to be
    // rendered with `toLocaleDateString(undefined, …)`, so the same session
    // read "Aug 12" on one machine and "12 Agu" on another while the rest of
    // the app followed the in-app switch.
    const old = ago(10 * 86_400_000);
    setLocale("en");
    const en = relativeTime(old, now);
    setLocale("id");
    const id = relativeTime(old, now);
    setLocale("en");
    expect(en).not.toBe("");
    // Indonesian abbreviates months differently ("Agu" vs "Aug"); had the
    // formatter ignored the app locale these would be byte-identical.
    expect(id).not.toBe(en);
  });
});

describe("activeMentionRange", () => {
  it("finds a mention at start of input", () => {
    expect(activeMentionRange("@rep", 4)).toEqual({
      query: "rep",
      start: 0,
      end: 4,
    });
  });

  it("finds a mention after whitespace", () => {
    expect(activeMentionRange("see @notes", 10)).toEqual({
      query: "notes",
      start: 4,
      end: 10,
    });
  });

  it("returns null when @ follows a non-space char (email)", () => {
    expect(activeMentionRange("mail me@example", 15)).toBeNull();
  });

  it("returns null when query contains whitespace", () => {
    expect(activeMentionRange("@foo bar", 8)).toBeNull();
  });

  it("returns null without @", () => {
    expect(activeMentionRange("plain", 5)).toBeNull();
  });

  it("span covers exactly the typed token for surgical removal", () => {
    const value = "say @x then done";
    const m = activeMentionRange(value, 6);
    expect(m).toEqual({ query: "x", start: 4, end: 6 });
    if (!m) return;
    // removing [start,end) surgically — an earlier "@" elsewhere stays intact
    expect(value.slice(0, m.start) + value.slice(m.end)).toBe("say  then done");
  });

  it("returns null when @ directly follows a word character", () => {
    expect(activeMentionRange("a@x", 3)).toBeNull();
  });
});

describe("sessionPeriod", () => {
  it("classifies today", () => {
    expect(sessionPeriod(Math.floor(Date.now() / 1000))).toBe("Today");
  });

  it("classifies yesterday", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(12);
    expect(sessionPeriod(Math.floor(d.getTime() / 1000))).toBe("Yesterday");
  });

  it("classifies older dates as Earlier", () => {
    expect(sessionPeriod(Math.floor(new Date(2000, 0, 1).getTime() / 1000))).toBe("Earlier");
  });

  it("treats missing timestamps as Earlier", () => {
    expect(sessionPeriod(null)).toBe("Earlier");
  });
});

describe("toFriendlyError", () => {
  it("maps busy-race errors to a friendly message", () => {
    expect(toFriendlyError("generation is already running")).not.toBe("generation is already running");
  });

  it("passes other errors through unchanged", () => {
    expect(toFriendlyError("boom")).toBe("boom");
  });
});

describe("historyToMessages", () => {
  it("maps DB rows to done text parts with stable ids", () => {
    const msgs = historyToMessages([{ id: 7, sessionId: 1, role: "user", content: "hi", createdAt: 1_800_000_000 }]);
    expect(msgs).toEqual([
      {
        id: "db-7",
        role: "user",
        parts: [{ type: "text", text: "hi", state: "done" }],
      },
    ]);
  });
});

describe("groupSessions", () => {
  const sess = (id: number, updatedAt: number | null): ChatSession => ({
    id,
    title: `s${id}`,
    createdAt: 1_800_000_000,
    updatedAt,
    archived: false,
    archivedAt: null,
    runCount: 0,
    lastGoal: null,
    lastFailed: false,
  });
  const now = Math.floor(Date.now() / 1000);

  it("buckets by last activity, input order preserved, empty buckets dropped", () => {
    const groups = groupSessions([
      sess(1, now),
      sess(2, now - 86_400),
      sess(3, Math.floor(new Date(2000, 0, 1).getTime() / 1000)),
      sess(4, now - 60),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual([1, 4]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual([2]);
    expect(groups[2].sessions.map((s) => s.id)).toEqual([3]);
  });

  it("passes empty input through", () => {
    expect(groupSessions([])).toEqual([]);
  });
});

describe("sessionToMarkdown", () => {
  it("renders title, UTC export stamp, and You/Assistant sections", () => {
    const md = sessionToMarkdown(
      " My Session  ",
      [
        { id: 1, sessionId: 1, role: "user", content: "question", createdAt: 1_800_000_000 },
        { id: 2, sessionId: 1, role: "assistant", content: "answer", createdAt: 1_800_000_000 },
      ],
      Date.UTC(2026, 8, 23, 10, 30),
    );
    expect(md).toMatch(/^# My Session$/m);
    expect(md).toMatch(/^_Exported 2026-09-23 10:30 UTC_$/m);
    expect(md).toMatch(/^## You · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    expect(md).toMatch(/^## Assistant · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    expect(md).toContain("question");
    expect(md).toContain("answer");
  });

  it("renders a persisted plan record, not its raw JSON", () => {
    const record = JSON.stringify({
      type: "supervisor-plan",
      v: 1,
      goal: "Ship it",
      steps: [{ id: "a", tool: "web_search", state: "completed" }],
      output: "DONE",
    });
    const md = sessionToMarkdown("t", [
      { id: 7, sessionId: 1, role: "assistant", content: record, createdAt: 1_800_000_000 },
    ]);
    expect(md).toContain("Ship it");
    expect(md).toContain("DONE");
    expect(md).not.toContain("supervisor-plan");
  });

  it("renders partial records as interrupted, not completed", () => {
    const record = JSON.stringify({
      type: "supervisor-plan",
      v: 1,
      goal: "Ship it",
      steps: [
        { id: "a", tool: "web_search", state: "completed" },
        { id: "b", tool: "data_query_nl", state: "running" },
      ],
      output: null,
      partial: true,
    });
    const md = sessionToMarkdown("t", [
      { id: 8, sessionId: 1, role: "assistant", content: record, createdAt: 1_800_000_000 },
    ]);
    expect(md).toContain("(run interrupted before completion)");
    expect(md).not.toContain("(plan completed)");
  });

  it("marks failed/skipped steps and falls back to a completed tail when output is missing", () => {
    const record = JSON.stringify({
      type: "supervisor-plan",
      v: 1,
      goal: "Ship it",
      steps: [
        { id: "a", tool: "web_search", state: "completed" },
        { id: "b", tool: "data_query_nl", state: "failed" },
        { id: "c", tool: "cli_run", state: "skipped" },
        { id: "d", tool: "deep_write", state: "running" },
      ],
    });
    const md = sessionToMarkdown("t", [
      { id: 9, sessionId: 1, role: "assistant", content: record, createdAt: 1_800_000_000 },
    ]);
    expect(md).toContain("✓ a [web_search] — completed");
    expect(md).toContain("✗ b [data_query_nl] — failed");
    expect(md).toContain("→ c [cli_run] — skipped");
    expect(md).toContain("· d [deep_write] — running");
    expect(md).toContain("(plan completed)");
  });

  it("strips tool markup and titles blank sessions", () => {
    const md = sessionToMarkdown("   ", [
      { id: 3, sessionId: 1, role: "assistant", content: "hi ```tool{secret}``` there", createdAt: 1_800_000_000 },
    ]);
    expect(md).toMatch(/^# Untitled session$/m);
    expect(md).not.toContain("secret");
    expect(md).toContain("there");
  });
});
