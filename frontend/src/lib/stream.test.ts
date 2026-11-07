import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `streamOperation` is the Tauri streaming seam. Two things can end a stream:
 * an event, or the command future resolving. Regression: a user Stop cancels
 * the token and the backend returns WITHOUT a terminal event, so before the
 * resolution path existed the supervisor run stayed pinned on "stopping" and
 * its workbench journal row spun forever.
 */
vi.mock("@tauri-apps/api/core", () => {
  type Handler = ((msg: unknown) => void) | null;
  const channels: Array<{ onmessage: Handler }> = [];
  const state: {
    resolve?: (value?: unknown) => void;
    reject?: (err?: unknown) => void;
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
  } = { calls: [] };

  class Channel {
    onmessage: Handler = null;
    constructor() {
      channels.push(this);
    }
  }

  return {
    Channel,
    invoke: (cmd: string, args: Record<string, unknown>) => {
      state.calls.push({ cmd, args });
      if (cmd === "cancel_stream") return Promise.resolve();
      return new Promise((resolve, reject) => {
        state.resolve = resolve;
        state.reject = reject;
      });
    },
    __channels: channels,
    __state: state,
  };
});

import * as core from "@tauri-apps/api/core";
import { streamOperation } from "@/lib/stream";

const mock = core as unknown as {
  __channels: Array<{ onmessage: ((msg: unknown) => void) | null }>;
  __state: {
    resolve?: (value?: unknown) => void;
    reject?: (err?: unknown) => void;
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
  };
};

type Ev = { type: string; message?: string };

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const lastChannel = () => mock.__channels[mock.__channels.length - 1];

describe("streamOperation settlement", () => {
  beforeEach(() => {
    mock.__state.calls.length = 0;
  });

  it("delivers events and settles once on a `finished` event", async () => {
    const onEvent = vi.fn();
    const onDone = vi.fn();
    streamOperation<Ev>("op", { a: 1 }, { onEvent, onDone }, "s1");

    lastChannel().onmessage?.({ type: "progress" });
    expect(onEvent).toHaveBeenCalledWith({ type: "progress" });

    lastChannel().onmessage?.({ type: "finished" });
    // The command future resolving afterwards must not fire `onDone` again.
    mock.__state.resolve?.();
    await flush();

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("settles a stop that ends without a terminal event", async () => {
    const onDone = vi.fn();
    const control = streamOperation<Ev>("execute_supervisor_plan", {}, { onDone }, "s2");

    control.cancel();
    // Backend returns after the cancellation token fires — no event arrives.
    mock.__state.resolve?.();
    await flush();

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("lets a declared domain-terminal event win over the command resolution", async () => {
    const onDone = vi.fn();
    streamOperation<Ev>(
      "execute_supervisor_plan",
      {},
      {
        onDone,
        isTerminal: (ev) => ev.type === "planCompleted" || ev.type === "planFailed",
      },
      "s3",
    );

    lastChannel().onmessage?.({ type: "planCompleted" });
    mock.__state.resolve?.();
    await flush();

    // The hook handles planCompleted itself; a second onDone would persist
    // the run twice.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports a command failure as an error", async () => {
    const onError = vi.fn();
    const onDone = vi.fn();
    streamOperation<Ev>("op", {}, { onDone, onError }, "s4");

    mock.__state.reject?.(new Error("boom"));
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("settles (as stopped) when a cancelled command ends in an error", async () => {
    const onError = vi.fn();
    const onDone = vi.fn();
    const control = streamOperation<Ev>("op", {}, { onDone, onError }, "s5");

    control.cancel();
    mock.__state.reject?.(new Error("channel closed"));
    await flush();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("cancels the right stream id", () => {
    const control = streamOperation<Ev>("op", {}, {}, "stream-abc");
    control.cancel();
    control.cancel(); // idempotent

    const cancels = mock.__state.calls.filter((c) => c.cmd === "cancel_stream");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].args.streamId).toBe("stream-abc");
  });
});
