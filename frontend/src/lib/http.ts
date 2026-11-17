/**
 * HTTP helpers shared by the web transport paths (`api.ts` RPC bridge and
 * `stream.ts` SSE stream) so a failure reads identically on both.
 */

/**
 * Read a failed response's message from the body ONCE.
 *
 * Most Axum handlers answer `(StatusCode, String)`, which serializes as
 * `text/plain` — `res.json()` throws on it and a fallback would throw away the
 * only copy of the real message ("incorrect email or password" →
 * "Unauthorized"). The `{ error }` shape (`error_response`, the auth
 * middleware) still wins when present.
 */
export async function httpErrorText(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => "")).slice(0, 500);
  if (raw.trim() === "") return res.statusText || `HTTP ${res.status}`;
  try {
    const body = JSON.parse(raw) as { error?: string };
    return typeof body?.error === "string" ? body.error : raw;
  } catch {
    return raw;
  }
}
