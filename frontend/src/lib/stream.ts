import { Channel, invoke } from "@tauri-apps/api/core";
import { httpErrorText } from "@/lib/http";
import { createSseParser, framePayload } from "@/lib/sse";
import { runningInTauri } from "@/platform";

/**
 * Streaming RPC to the kawai backend.
 *
 * Desktop/mobile runs Tauri: a `Channel<T>` is passed to the invoked command
 * and events stream back via `channel.send(...)`; `streamId` allows early
 * cancellation via the `cancel_stream` command. The web build (`kawai-web`,
 * feature `web`) has no Channel — its streaming ops answer `text/event-stream`
 * (Axum `Sse` in `web.rs`), so the same events arrive as `data:` frames and
 * cancellation is the connection drop (`AbortController`), which the backend
 * handler observes.
 *
 * Terminals: `event.type === "finished" | "error"`, a domain-terminal event
 * declared through `isTerminal`, or the transport ending. A stream settles
 * exactly once — first terminal wins.
 */

export interface StreamControl {
  cancel: () => void;
}

export interface StreamHandlers<E> {
  onEvent?: (event: E) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
  /**
   * Domain-terminal test for streams whose terminal variant is not the
   * generic `finished`/`error` — the supervisor ends on `planCompleted` /
   * `planFailed`, onboarding on `onboardingFinished` / `onboardingError`.
   * Declaring it stops `onDone` from firing a second time when the transport
   * ends after the terminal event.
   */
  isTerminal?: (event: E) => boolean;
}

export function streamOperation<E extends { type: string }>(
  operation: string,
  input: Record<string, unknown> | undefined,
  handlers: StreamHandlers<E>,
  requestedStreamId?: string,
): StreamControl {
  const { onEvent, onDone, onError, isTerminal } = handlers;
  const streamId = requestedStreamId ?? crypto.randomUUID();

  // A stream ends in exactly one of three ways: an event, the transport
  // resolving, or an error. Resolution is the safety net — a user Stop cancels
  // the backend WITHOUT a terminal event, so before this the caller was never
  // told and a supervisor run stayed pinned on "stopping".
  let settled = false;
  let cancelled = false;

  const settle = (fn?: () => void) => {
    if (settled) return;
    settled = true;
    fn?.();
  };

  /** One backend event through the terminal rules. */
  const route = (msg: E) => {
    switch (msg.type) {
      case "finished":
        settle(onDone);
        return;
      case "error": {
        const message = (msg as unknown as { message?: string }).message ?? "stream error";
        settle(() => onError?.(new Error(message)));
        return;
      }
      default:
        if (settled) return;
        onEvent?.(msg);
        if (isTerminal?.(msg)) settled = true;
        return;
    }
  };

  /** A failure whose run the user already stopped ends as STOPPED, not failed. */
  const fail = (err: unknown) => {
    if (cancelled) {
      settle(onDone);
      return;
    }
    settle(() => onError?.(err instanceof Error ? err : new Error(String(err))));
  };

  if (runningInTauri) {
    const channel = new Channel<E>();
    channel.onmessage = route;
    invoke(operation, { ...(input ?? {}), streamId, onEvent: channel })
      .then(() => settle(onDone))
      .catch(fail);
    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        invoke("cancel_stream", { streamId }).catch(() => {});
      },
    };
  }

  // Web: POST and read the SSE body.
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`/api/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ ...(input ?? {}), streamId }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(await httpErrorText(res));
      if (!res.body) throw new Error("stream closed before any event");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = framePayload<E>(frame);
          if (event) route(event);
        }
        if (settled) break;
      }
      if (!settled) {
        for (const frame of parser.flush()) {
          const event = framePayload<E>(frame);
          if (event) route(event);
        }
        settle(onDone);
      }
      // Release the socket: a domain-terminal event can land before the
      // handler finishes writing, and an unread body pins the connection.
      void reader.cancel().catch(() => {});
    } catch (err) {
      fail(err);
    }
  })();

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
    },
  };
}
