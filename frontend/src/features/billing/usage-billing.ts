/**
 * Interim billing gate — pra-turn balance check.
 *
 * ⚠️ HONOR SYSTEM. Billing nyata terjadi di Rust core (desktop) setelah
 * plan selesai dengan RemoteUsage nyata. Frontend hanya pre-check saldo
 * (blokir kalau 0).
 *
 * Jalur web: pre-check saja, tidak ada debit flat. Billing web → nanti
 * via backend web server (sama seperti desktop). Sekarang web user
 * bisa pakai app tanpa saldo (interim, belum ada pemakai).
 */

import { supabase } from "@/features/auth/supabase";

export interface BillTurnResult {
  ok: boolean;
  insufficient: boolean;
  balance?: string;
}

/** Pre-check saldo. Panggil di planAndRun SEBELUM plan_task.
 *  Blokir hanya kalau saldo terkonfirmasi 0. */
export async function gateTurn(): Promise<BillTurnResult> {
  try {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) return { ok: true, insufficient: false };
    const bal = await getMyBalance();
    if (bal === null) return { ok: true, insufficient: false }; // fail-open
    return { ok: bal !== "0", insufficient: bal === "0", balance: bal };
  } catch {
    return { ok: true, insufficient: false };
  }
}

/** Baca saldo user sendiri. */
export async function getMyBalance(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("get_my_balance");
    if (error || !data) return null;
    return String((data as { usdt_balance?: string | number }).usdt_balance ?? "0");
  } catch {
    return null;
  }
}
