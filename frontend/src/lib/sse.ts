/**
 * Incremental Server-Sent-Events parsing for the web transport.
 *
 * The Axum build answers the streaming ops with `Sse<...>` (`web.rs`), so a
 * browser reads a `text/event-stream` body instead of receiving a Tauri
 * `Channel`. This is the ONE place frames are split and decoded: pure over the
 * text it is fed, so the framing rules are unit-tested without a network.
 */

export interface SseFrame {
  /** The `event:` name, when the server set one. */
  event?: string;
  /** `data:` lines joined with `\n` (SSE spec §9.2.6). */
  data: string;
}

export interface SseParser {
  /** Feed one decoded chunk; returns every frame it completed. */
  push(chunk: string): SseFrame[];
  /** Frames left when the body ends without its closing blank line. */
  flush(): SseFrame[];
}

const FRAME_TERMINATOR = /\r\n\r\n|\n\n|\r\r/;
const LINE_BREAK = /\r\n|\n|\r/;

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(LINE_BREAK)) {
    // Blank separators and `:` comments (the usual keep-alive) carry nothing.
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    // `id:` / `retry:` mean nothing for these streams.
  }
  if (data.length === 0 && event === undefined) return null;
  return { event, data: data.join("\n") };
}

export function createSseParser(): SseParser {
  let buffer = "";
  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const frames: SseFrame[] = [];
      for (;;) {
        const match = FRAME_TERMINATOR.exec(buffer);
        if (!match) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame) frames.push(frame);
      }
      return frames;
    },
    flush(): SseFrame[] {
      const raw = buffer;
      buffer = "";
      const frame = parseFrame(raw);
      return frame ? [frame] : [];
    },
  };
}

/**
 * Decode a frame's JSON payload — the backend serializes every supervisor
 * event, so a non-JSON body is a keep-alive or the `[DONE]` sentinel, never a
 * dropped event. `null` means "nothing to dispatch", not "failed".
 */
export function framePayload<T>(frame: SseFrame): T | null {
  const data = frame.data.trim();
  if (data === "" || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
