import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./transport";

// Streaming abstraction.
//
// Desktop/Mobile: Tauri `Channel<T>` passed to an `invoke` command that streams
//                 events back via `channel.send(...)`. A `streamId` lets the
//                 client request early cancellation via the `cancel_stream`
//                 command (backend `CancellationToken` registry).
// Web:            `fetch` + ReadableStream reader that parses SSE frames.
//                 Cancellation is automatic: `AbortController` drops the
//                 connection, which drops the Axum response future, which drops
//                 the stream and cancels any pending `sleep`.
//
// `input` carries the command's business arguments; the channel/abort wiring is
// added internally. Stream completion is encoded in the event `type`
// (`finished` / `error`), not in the transport.
export interface StreamHandlers<E> {
  onEvent: (event: E) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
}

export interface StreamController {
  cancel: () => void;
}

export function streamOperation<E extends { type: string }>(
  operation: string,
  input: Record<string, unknown> | undefined,
  handlers: StreamHandlers<E>,
): StreamController {
  return isTauri
    ? viaChannel<E>(operation, input, handlers)
    : viaSse<E>(operation, input, handlers);
}

function viaChannel<E extends { type: string }>(
  operation: string,
  input: Record<string, unknown> | undefined,
  { onEvent, onDone, onError }: StreamHandlers<E>,
): StreamController {
  const channel = new Channel<E>();
  const streamId = newStreamId();
  channel.onmessage = (message: E) => {
    const e = message as E & { message?: string };
    if (e.type === "finished") onDone?.();
    else if (e.type === "error") onError?.(new Error(e.message ?? "stream error"));
    else onEvent(message);
  };

  let cancelled = false;
  invoke(operation, { ...(input ?? {}), streamId, onEvent: channel }).catch(
    (err: unknown) => {
      if (!cancelled) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
  );

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      // Tell the backend to abort the stream loop (desktop/mobile only).
      invoke("cancel_stream", { streamId }).catch(() => {});
    },
  };
}

function viaSse<E extends { type: string }>(
  operation: string,
  input: Record<string, unknown> | undefined,
  { onEvent, onDone, onError }: StreamHandlers<E>,
): StreamController {
  const controller = new AbortController();

  void (async () => {
    try {
      const res = await fetch(`/api/${operation}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(input ?? {}),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          onDone?.();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const parsed = parseFrame<E>(raw);
          if (!parsed) continue;
          if (parsed.type === "finished") {
            onDone?.();
            return;
          }
          if (parsed.type === "error") {
            onError?.(
              new Error(
                (parsed as { message?: string }).message ?? "stream error",
              ),
            );
            return;
          }
          onEvent(parsed);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return { cancel: () => controller.abort() };
}

// Parse a single SSE frame: look for a `data:` line and JSON-decode it.
function parseFrame<E>(raw: string): E | null {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim()) as E;
  } catch {
    return null;
  }
}

// Unique id so the backend can locate a stream's cancellation token.
// `crypto.randomUUID` is available in Tauri webviews and secure browser
// contexts (localhost / https); the fallback covers insecure contexts.
function newStreamId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
