import { describe, expect, it } from "vitest";
import { createSseParser, framePayload } from "@/lib/sse";

const frame = (data: string, event?: string) =>
  `${event ? `event: ${event}\n` : ""}${data
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;

describe("createSseParser", () => {
  it("splits frames and keeps their data", () => {
    const parser = createSseParser();
    const frames = parser.push(frame('{"type":"stepStarted"}') + frame('{"type":"finished"}'));
    expect(frames.map((f) => f.data)).toEqual(['{"type":"stepStarted"}', '{"type":"finished"}']);
  });

  it("holds a partial frame until its terminator arrives", () => {
    const parser = createSseParser();
    const whole = frame('{"type":"planCompleted"}');
    const cut = Math.floor(whole.length / 2);

    expect(parser.push(whole.slice(0, cut))).toEqual([]);
    // A chunk boundary that falls INSIDE the blank-line terminator still
    // completes exactly one frame.
    expect(parser.push(whole.slice(cut))).toHaveLength(1);
  });

  it("accepts CRLF line endings", () => {
    const parser = createSseParser();
    const frames = parser.push('data: {"type":"finished"}\r\n\r\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('{"type":"finished"}');
  });

  it("ignores keep-alive comments and captures the event name", () => {
    const parser = createSseParser();
    const frames = parser.push(`: keep-alive\n\n${frame('{"a":1}', "step")}`);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("step");
    expect(frames[0].data).toBe('{"a":1}');
  });

  it("joins multi-line data with a newline", () => {
    const parser = createSseParser();
    const [only] = parser.push("data: line one\ndata: line two\n\n");
    expect(only.data).toBe("line one\nline two");
  });

  it("flushes a trailing frame that never got its blank line", () => {
    const parser = createSseParser();
    expect(parser.push('data: {"type":"finished"}')).toEqual([]);
    expect(parser.flush().map((f) => f.data)).toEqual(['{"type":"finished"}']);
    expect(parser.flush()).toEqual([]);
  });
});

describe("framePayload", () => {
  it("decodes JSON and passes non-events through as null", () => {
    const parser = createSseParser();
    const [event, done, junk] = parser.push(frame('{"type":"finished"}') + frame("[DONE]") + frame("not json"));
    expect(framePayload<{ type: string }>(event)).toEqual({ type: "finished" });
    expect(framePayload(done)).toBeNull();
    expect(framePayload(junk)).toBeNull();
  });
});
