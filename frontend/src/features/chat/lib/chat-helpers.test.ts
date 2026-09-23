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
import type { ChatSessionInfo } from "@/lib/api";

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
    const msgs = historyToMessages([{ id: 7, sessionId: 1, role: "user", content: "hi", createdAt: null }]);
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
  const sess = (id: number, updatedAt: number | null): ChatSessionInfo => ({
    id,
    title: `s${id}`,
    createdAt: updatedAt,
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
        { id: 2, sessionId: 1, role: "assistant", content: "answer", createdAt: null },
      ],
      Date.UTC(2026, 8, 23, 10, 30),
    );
    expect(md).toMatch(/^# My Session$/m);
    expect(md).toMatch(/^_Exported 2026-09-23 10:30 UTC_$/m);
    expect(md).toMatch(/^## You · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    expect(md).toMatch(/^## Assistant$/m);
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
    const md = sessionToMarkdown("t", [{ id: 7, sessionId: 1, role: "assistant", content: record, createdAt: null }]);
    expect(md).toContain("Ship it");
    expect(md).toContain("DONE");
    expect(md).not.toContain("supervisor-plan");
  });

  it("strips tool markup and titles null sessions", () => {
    const md = sessionToMarkdown(null, [
      { id: 3, sessionId: 1, role: "assistant", content: "hi ```tool{secret}``` there", createdAt: null },
    ]);
    expect(md).toMatch(/^# Untitled session$/m);
    expect(md).not.toContain("secret");
    expect(md).toContain("there");
  });
});
