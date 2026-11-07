import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Streaming RPC to the Tauri backend. A `Channel<T>` is passed to the invoked
 * command; the backend streams events back via `channel.send(...)`. The
 * `streamId` allows early cancellation via the `cancel_stream` command.
 *
 * Terminals: `event.type === "finished" | "error"`, a domain-terminal event
 * declared through `isTerminal`, or the command future resolving. A stream
 * settles exactly once — first terminal wins.
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
   * Declaring it stops `onDone` from firing a second time when the command
   * future resolves after the terminal event.
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
  const channel = new Channel<E>();
  const streamId = requestedStreamId ?? crypto.randomUUID();

  // A stream ends in exactly one of two ways: an event, or the command future
  // resolving. Resolution is the safety net — a user Stop cancels the token
  // and the backend returns WITHOUT a terminal event, so before this the
  // caller was never told and a supervisor run stayed pinned on "stopping".
  let settled = false;

  channel.onmessage = (msg: E) => {
    switch (msg.type) {
      case "finished":
        if (settled) return;
        settled = true;
        onDone?.();
        return;
      case "error": {
        if (settled) return;
        settled = true;
        const message = (msg as unknown as { message?: string }).message ?? "stream error";
        onError?.(new Error(message));
        return;
      }
      default:
        onEvent?.(msg);
        if (!settled && isTerminal?.(msg)) settled = true;
        return;
    }
  };

  let cancelled = false;
  invoke(operation, { ...(input ?? {}), streamId, onEvent: channel })
    .then(() => {
      // The command future finished. Settle only if no event already closed
      // the stream (the terminal event wins; this covers the silent end).
      if (settled) return;
      settled = true;
      onDone?.();
    })
    .catch((err) => {
      if (settled) return;
      settled = true;
      if (cancelled) {
        // A stop whose command ended in an error still ends the run — the
        // caller's `onDone` path reports it as stopped, not failed.
        onDone?.();
        return;
      }
      onError?.(err instanceof Error ? err : new Error(String(err)));
    });

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      invoke("cancel_stream", { streamId }).catch(() => {});
    },
  };
}
