// ============================================================================
// debit-balance — endpoint debit dengan DUA jalur auth:
//
//   1. Path WORKER (billing usage otomatis):
//      Authorization: Bearer <anon/publishable key>  (sekadar utk gateway)
//      x-worker-secret: <WORKER_FN_SECRET>           (auth sebenarnya)
//      → debit atas nama user_id, reason bebas ('usage', dst).
//
//   2. Path ADMIN (koreksi/top-up manual dari admin panel):
//      Authorization: Bearer <JWT admin Supabase>  (verify_jwt=false, jadi
//      diverifikasi eksplisit via /auth/v1/user)
//      → wajib reason='manual' + admin_id; diverifikasi DI DALAM RPC
//        (app_metadata.role='admin'), bukan cuma di sini.
//
// Client user biasa: TIDAK ADA jalur debit (JWT non-admin ditolak RPC).
// Atomicity ada di Postgres RPC `private.debit_balance`.
// ============================================================================

const headers = { "Content-Type": "application/json" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** Verifikasi JWT admin via Supabase Auth (signature dicek server Auth).
 *  (verify_jwt=false di config krn worker secret bukan JWT — jadi JWT
 *  admin harus diverifikasi eksplisit di sini.) */
async function verifyAdminJwt(jwt: string): Promise<string | null> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) return null; // token invalid/expired → 401 dari Auth server
  const user = await res.json();
  const role = (user?.app_metadata as Record<string, unknown> | undefined)?.role;
  return role === "admin" && typeof user.id === "string" ? user.id : null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json(401, { error: "unauthorized" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const workerSecret = Deno.env.get("WORKER_FN_SECRET") ?? "";

  // Gateway Supabase (sistem key baru) menuntut header Authorization terisi.
  //   - Path worker : Authorization: Bearer <anon key> + x-worker-secret
  //   - Path admin  : Authorization: Bearer <JWT admin>
  const workerHdr = req.headers.get("x-worker-secret") ?? "";

  // ── Tentukan jalur auth ────────────────────────────────────────────────
  let adminId: string | null = null;

  if (workerSecret && workerHdr && workerHdr === workerSecret) {
    // Jalur 1: worker (service path) — OK, lanjut sebagai service_role
  } else {
    // Jalur 2: JWT admin — diverifikasi ke Supabase Auth (signature + exp),
    // lalu role dicek dari app_metadata (bukan user_metadata!)
    adminId = await verifyAdminJwt(token);
    if (!adminId) {
      return json(403, { error: "forbidden: admin JWT or worker secret required" });
    }
  }

  // ── Validasi input ─────────────────────────────────────────────────────
  let body: { user_id?: string; amount?: number; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }

  const { user_id, amount } = body;
  let { reason = "usage" } = body;

  if (!user_id || !amount || amount <= 0) {
    return json(400, { error: "user_id and positive amount required" });
  }

  // Path admin: paksa aturan audit (RPC memvalidasi ulang — defense in depth)
  const rpcArgs: Record<string, unknown> = { p_user_id: user_id, p_amount: amount };
  if (adminId) {
    reason = "manual";
    rpcArgs.p_reason = reason;
    rpcArgs.p_admin_id = adminId;
  } else {
    rpcArgs.p_reason = reason;
  }

  // ── Debit atomic via RPC (service_role client) ─────────────────────────
  const rpc = await fetch(`${supabaseUrl}/rest/v1/rpc/debit_balance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(rpcArgs),
  });

  if (!rpc.ok) {
    const detail = await rpc.text();
    const insufficient = detail.includes("insufficient balance");

    // catat debt hanya utk path worker (gagal debit setelah layanan terpakai);
    // koreksi admin yang gagal krn saldo kurang tidak perlu debt record
    if (!adminId) {
      await fetch(`${supabaseUrl}/rest/v1/rpc/record_debt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          p_user_id: user_id,
          p_amount: amount,
          p_reason: `debit failed: ${reason}`,
        }),
      });
    }

    return json(insufficient ? 409 : 500, {
      error: insufficient ? "insufficient_balance" : "debit_failed",
      detail,
    });
  }

  const newBalance = await rpc.json();
  return json(200, { ok: true, balance: newBalance });
});
