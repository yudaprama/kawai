import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The WEB branch of `streamOperation`: `kawai-web` answers the streaming ops
 * with `text/event-stream` (Axum `Sse`), so the browser reads frames instead
 * of receiving a Tauri `Channel`. Regression: this branch did not exist —
 * `streamOperation` called `invoke` unconditionally, which throws when
 * `window.__TAURI_INTERNALS__` is absent, so every plan/execute call died in a
 * browser while plain RPC worked.
 */
vi.mock("@/platform", () => ({ runningInTauri: false }));

import { streamOperation } from "@/lib/stream";

type Ev = { type: string; message?: string };

const encoder = new TextEncoder();

/** A 200 with an SSE body that emits `chunks` then ends. */
function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const frame = (type: string) => `data: {"type":"${type}"}\n\n`;

/** Let the fetch/reader microtasks drain. */
const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamOperation over HTTP/SSE", () => {
  it("posts to /api/<operation> and delivers frames to the event handler", async () => {
    const fetchMock = vi.fn(async () => sseResponse([frame("planStarted"), frame("finished")]));
    vi.stubGlobal("fetch", fetchMock);

    const onEvent = vi.fn();
    const onDone = vi.fn();
    streamOperation<Ev>("execute_supervisor_plan", { sessionId: 7 }, { onEvent, onDone }, "s1");
    await flush();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/execute_supervisor_plan");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
    // The stream id rides the body: it keys the backend's pending
    // confirmations, and the request carries no Tauri channel to ride.
    expect(JSON.parse(String(init.body))).toMatchObject({ sessionId: 7, streamId: "s1" });

    expect(onEvent).toHaveBeenCalledWith({ type: "planStarted" });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("honours a domain-terminal event without a second onDone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([frame("stepStarted"), frame("planCompleted"), frame("finished")])),
    );

    const onEvent = vi.fn();
    const onDone = vi.fn();
    streamOperation<Ev>(
      "execute_supervisor_plan",
      {},
      { onEvent, onDone, isTerminal: (ev) => ev.type === "planCompleted" },
      "s2",
    );
    await flush();

    // The terminal event still reaches `onEvent` (the hook persists the run
    // from it); what must NOT happen is a second terminal — the trailing
    // `finished` is dropped and `onDone` never fires.
    expect(onEvent.mock.calls.map(([ev]) => (ev as Ev).type)).toEqual(["stepStarted", "planCompleted"]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("decodes frames split across chunk boundaries", async () => {
    const whole = frame("stepCompleted") + frame("finished");
    const cut = whole.indexOf('"finished"') - 6;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([whole.slice(0, cut), whole.slice(cut)])),
    );

    const onEvent = vi.fn();
    streamOperation<Ev>("execute_supervisor_plan", {}, { onEvent }, "s3");
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: "stepCompleted" });
  });

  it("reports a failed response with the body's own message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("session not found", { status: 404, statusText: "Not Found" })),
    );

    const onError = vi.fn();
    const onDone = vi.fn();
    streamOperation<Ev>("execute_supervisor_plan", {}, { onError, onDone }, "s4");
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("session not found");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("aborts the request on cancel and settles the run as stopped", async () => {
    const seen: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            seen.push(signal);
            signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      ),
    );

    const onError = vi.fn();
    const onDone = vi.fn();
    const control = streamOperation<Ev>("execute_supervisor_plan", {}, { onError, onDone }, "s5");
    await flush();

    control.cancel();
    control.cancel(); // idempotent
    await flush();

    expect(seen[0].aborted).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
