import { describe, expect, it } from "vitest";
import {
  activeMentionRange,
  historyToMessages,
  sessionPeriod,
  stripToolMarkup,
  toFriendlyError,
} from "@/features/chat/lib/chat-helpers";

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
