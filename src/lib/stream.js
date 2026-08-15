const { Channel, invoke } = window.__TAURI__.core;

// Streaming: Tauri Channel<T> passed to an invoke that streams events back
// via channel.send(...). A streamId allows early cancellation via cancel_stream.
//
// Terminals: event.type === "finished" | "error"

export function streamOperation(operation, input, handlers) {
  const { onEvent, onDone, onError } = handlers;
  const channel = new Channel();
  const streamId = crypto.randomUUID();

  channel.onmessage = (msg) => {
    if (msg.type === "finished") {
      onDone?.();
    } else if (msg.type === "error") {
      onError?.(new Error(msg.message ?? "stream error"));
    } else {
      onEvent(msg);
    }
  };

  let cancelled = false;
  invoke(operation, { ...(input ?? {}), streamId, onEvent: channel }).catch(
    (err) => {
      if (!cancelled) onError?.(err instanceof Error ? err : new Error(String(err)));
    },
  );

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      invoke("cancel_stream", { streamId }).catch(() => {});
    },
  };
}
