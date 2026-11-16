import { afterEach, describe, expect, it, vi } from "vitest";

// The HTTP bridge only runs outside Tauri (the web build / a plain browser).
vi.mock("@/platform", () => ({ runningInTauri: false }));

import { call } from "@/lib/api";

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("call() over HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Regression: every op with nothing to return answers 204, and `res.json()`
  // on an empty body throws `Unexpected end of JSON input` — `auth_reset_request`
  // reported failure *while* the worker had already mailed the code, so users
  // retried and burned the 3/hour quota.
  it("resolves 204 No Content without trying to parse a body", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));

    await expect(call<void>("auth_reset_request", { email: "a@b.c" })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth_reset_request", expect.objectContaining({ method: "POST" }));
  });

  it("returns the parsed JSON body of a 200", async () => {
    stubFetch(
      new Response(JSON.stringify({ email: "a@b.c" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(call<{ email: string }>("whoami")).resolves.toEqual({ email: "a@b.c" });
  });

  it("rejects with the server's { error } text, not the status line", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "too many reset requests — try again later" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(call("auth_reset_request", { email: "a@b.c" })).rejects.toThrow(
      "too many reset requests — try again later",
    );
  });
});

describe("call() over HTTP — error body shapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Regression: most Axum handlers answer `(StatusCode, String)`, which
  // serializes as text/plain. Reading only JSON threw that body away, so every
  // backend message (wrong password, reset-code cooldown, "Token habis")
  // reached the UI as the bare status text — "Unauthorized".
  it("surfaces a plain-text body instead of the status line", async () => {
    stubFetch(new Response("incorrect email or password", { status: 401, statusText: "Unauthorized" }));

    await expect(call("auth_sign_in", { email: "a@b.c", password: "x" })).rejects.toThrow(
      "incorrect email or password",
    );
  });

  it("keeps a JSON body with no `error` field rather than the status line", async () => {
    stubFetch(
      new Response(JSON.stringify({ detail: "nope" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(call("some_op")).rejects.toThrow('{"detail":"nope"}');
  });

  it("falls back to the status text on an empty body", async () => {
    stubFetch(new Response("", { status: 500, statusText: "Internal Server Error" }));

    await expect(call("some_op")).rejects.toThrow("Internal Server Error");
  });

  it("caps a runaway body — an HTML error page is not a chat message", async () => {
    stubFetch(new Response(`<html>${"x".repeat(4000)}</html>`, { status: 404, statusText: "Not Found" }));

    const err = await call("some_op").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toHaveLength(500);
  });
});
