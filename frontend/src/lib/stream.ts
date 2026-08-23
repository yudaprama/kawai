import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Streaming RPC to the Tauri backend. A `Channel<T>` is passed to the invoked
 * command; the backend streams events back via `channel.send(...)`. The
 * `streamId` allows early cancellation via the `cancel_stream` command.
 *
 * Terminals: `event.type === "finished" | "error"`.
 */

export interface StreamControl {
  cancel: () => void;
}

export interface StreamHandlers<E> {
  onEvent?: (event: E) => void;
  onDone?: () => void;
  onError?: (err: Error) => void;
}

export function streamOperation<E extends { type: string }>(
  operation: string,
  input: Record<string, unknown> | undefined,
  handlers: StreamHandlers<E>,
): StreamControl {
  const { onEvent, onDone, onError } = handlers;
  const channel = new Channel<E>();
  const streamId = crypto.randomUUID();

  channel.onmessage = (msg: E) => {
    switch (msg.type) {
      case "finished":
        onDone?.();
        break;
      case "error": {
        const message = (msg as unknown as { message?: string }).message ?? "stream error";
        onError?.(new Error(message));
        break;
      }
      default:
        onEvent?.(msg);
        break;
    }
  };

  let cancelled = false;
  invoke(operation, { ...(input ?? {}), streamId, onEvent: channel }).catch((err) => {
    if (!cancelled) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      invoke("cancel_stream", { streamId }).catch(() => {});
    },
  };
}
