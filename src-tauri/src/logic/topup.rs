//! QRIS top-up + token-balance worker proxies.
//!
//! Pure layer — `reqwest` only, no tauri/axum: BOTH transports (Tauri
//! commands in `commands.rs`, Axum routes in `web.rs`) call these same fns.
//! The Ed25519 session bearer is supplied by the wrapper (desktop reads the
//! stored `auth.token`, web reads the raw `kawai_session` cookie) — the
//! frontend never sends a token or user id.
//!
//! Wire shape = the batch contract: camelCase JSON on both transports, so
//! every struct is `rename_all = "camelCase"` for BOTH directions (worker
//! response parsing and wrapper response emission).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::de::DeserializeOwned;

use super::local_auth::{worker_base_url, worker_client};

/// GET a worker endpoint with the session bearer. Non-2xx → the worker's
/// `{error}` text (e.g. `qr_payload_not_configured`, `insufficient_balance`).
async fn get(token: &str, path: &str) -> std::result::Result<serde_json::Value, String> {
    let url = format!("{}{path}", worker_base_url());
    let resp = worker_client()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("worker unreachable: {e}"))?;
    read_body(resp).await
}

/// POST a worker endpoint with the session bearer. Same error contract as
/// [`get`].
async fn post(
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> std::result::Result<serde_json::Value, String> {
    let url = format!("{}{path}", worker_base_url());
    let resp = worker_client()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("worker unreachable: {e}"))?;
    read_body(resp).await
}

/// 2xx → parsed body JSON; non-2xx → Err of the worker's `{error}` text.
/// 5xx keeps the `worker error (HTTP …)` shape (with the detail appended) so
/// `worker_unreachable` classifies it as an outage regardless of body: a
/// worker-internal fault surfaces as JSON `{error}` — and it IS an outage,
/// unlike a 4xx rejection, which keeps the worker's own text (fail closed).
async fn read_body(resp: reqwest::Response) -> std::result::Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(if status.is_server_error() {
            // 5xx = outage: keep the classifier-matched shape, detail appended.
            let detail = json["error"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(200).collect());
            format!("worker error (HTTP {status}): {detail}")
        }
        else {
            // 4xx = the worker answered with a rejection: its own text.
            json["error"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("worker error (HTTP {status})"))
        });
    }
    Ok(json)
}

fn parsed<T: DeserializeOwned>(json: serde_json::Value) -> std::result::Result<T, String> {
    serde_json::from_value(json).map_err(|e| format!("unexpected worker response: {e}"))
}

// ── Wire structs ────────────────────────────────────────────────────────────
//
// Defined once in `kawai_api_types` (the single source the TS generator
// reads) and re-exported here under their original names, matching the
// sibling logic modules. Keeping the old names means every op signature and
// call site below is untouched.
pub use kawai_api_types::{
    TopupBalance as Balance, TopupClaim as Claim, TopupHistory as History,
    TopupHistoryEntry as HistoryEntry, TopupPreview as Preview,
    TopupStatusInfo as Status, TopupVoucherRedeem as VoucherRedeem,
};

/// Riwayat ledger — halaman batas section Riwayat (source-hardcoded, no env).
const HISTORY_LIMIT: u64 = 50;

#[cfg(test)]
mod tests {
    use super::worker_unreachable;

    #[test]
    fn grace_applies_only_to_unreachability() {
        // Transport failures and edge-outage statuses → grace eligible.
        assert!(worker_unreachable(
            "worker unreachable: error sending request"
        ));
        assert!(worker_unreachable("worker error (HTTP 502)"));
        assert!(worker_unreachable("worker error (HTTP 521)"));
        // Worker-internal 5xx surfaces WITH the JSON detail appended — still
        // an outage (read_body keeps the classifier-matched prefix).
        assert!(worker_unreachable(
            "worker error (HTTP 500): internal server error"
        ));
        // The worker ANSWERED → fail closed, never launder into grace.
        assert!(!worker_unreachable("worker error (HTTP 401)"));
        assert!(!worker_unreachable("invalid_code_format"));
        assert!(!worker_unreachable("worker error (HTTP 404)"));
        assert!(!worker_unreachable(""));
    }
}

// ─── Usage replay (sync-when-online) ────────────────────────────────────────

/// Rows per flush call — the worker's own per-call fuse.
const REPLAY_BATCH_ROWS: u32 = 500;

/// True when a `get`/`post` error string means the worker (or its edge) could
/// not be reached — the ONLY error class the offline grace may serve.
/// Transport failures are prefixed `worker unreachable:` in [`get`]/[`post`];
/// Cloudflare reports an origin-less edge as HTTP 5xx through `read_body`'s
/// `worker error (HTTP …)` text. Everything else — 401 (expired bearer),
/// 4xx contract errors, malformed responses — is the worker ANSWERING, and
/// answering with a rejection is not an outage: the gate fails closed.
fn worker_unreachable(err: &str) -> bool {
    err.starts_with("worker unreachable") || err.starts_with("worker error (HTTP 5")
}
/// Minimum spacing between flush attempts, PER USER (kawai-web serves many
/// users from one process — a process-wide gate would let user A's submits
/// starve user B's replay). The gate fires one flush per successful submit;
/// a worker that errors on replay must not turn every submit into an extra
/// request cycle.
const REPLAY_MIN_INTERVAL_SECS: i64 = 60;

static REPLAY_LAST_ATTEMPT: LazyLock<std::sync::Mutex<HashMap<String, i64>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Push locally-recorded offline usage to the worker (`POST
/// /billing/usage-replay`), advancing the per-user replay cursor. Best-effort
/// by contract: any failure leaves the cursor where it was and the next
/// gate success retries — per-row worker dedupe makes re-pushes free.
///
/// First run on a device bootstraps the cursor at the LEDGER HEAD: replay
/// starts from NOW. Historical rows predate the replay lane, and their recap
/// windows have already passed — the offset could never apply, so replaying
/// them would double-bill what the recap (online by definition) charged.
pub async fn flush_usage_replay(user_id: &str, token: &str) -> Result<(), String> {
    let now = kawai_db::unix_now() as i64;
    {
        let mut last = REPLAY_LAST_ATTEMPT
            .lock()
            .map_err(|_| "replay rate-limit lock poisoned".to_string())?;
        if now
            - last.get(user_id).copied().unwrap_or(0)
            < REPLAY_MIN_INTERVAL_SECS
        {
            return Ok(());
        }
        last.insert(user_id.to_string(), now);
    }

    let mut cursor = match kawai_db::usage_sync_cursor_get(user_id)
        .await
        .map_err(|e| format!("cursor unreadable: {e}"))?
    {
        Some(seq) => seq,
        None => {
            let head = kawai_db::usage_ledger_max_seq(user_id)
                .await
                .map_err(|e| format!("ledger head unreadable: {e}"))?;
            kawai_db::usage_sync_cursor_set(user_id, head)
                .await
                .map_err(|e| format!("cursor bootstrap failed: {e}"))?;
            return Ok(());
        }
    };

    loop {
        let rows = kawai_db::usage_replay_pending(user_id, cursor, REPLAY_BATCH_ROWS)
            .await
            .map_err(|e| format!("ledger unreadable: {e}"))?;
        if rows.is_empty() {
            return Ok(());
        }
        let body = serde_json::json!({
            "rows": rows
                .iter()
                .map(|r| serde_json::json!({ "at": r.at, "seq": r.seq, "tokens": r.tokens }))
                .collect::<Vec<_>>(),
        });
        let resp: serde_json::Value = post(token, "/billing/usage-replay", body).await?;
        if resp["applied"].is_null() {
            return Err("unexpected worker response".to_string());
        }
        // The worker either applied or had already seen every row — advance
        // to the last one sent; per-row dedupe makes a partial-failure retry
        // free either way.
        cursor = rows[rows.len() - 1].seq;
        kawai_db::usage_sync_cursor_set(user_id, cursor)
            .await
            .map_err(|e| format!("cursor write failed: {e}"))?;
        if rows.len() < REPLAY_BATCH_ROWS as usize {
            return Ok(());
        }
    }
}

// ─── Ops (auth-required thin proxies) ─────────────────────────────────────────

/// `GET /topup/qris/preview` — static QRIS payload + pay-as-you-go range
/// config (`minBase`/`maxBase`/`baseStep`/`tokensPerIdr`).
/// Errors while the merchant's EMVCo payload constant is unset (worker 503).
pub async fn topup_qris_preview(token: &str) -> std::result::Result<Preview, String> {
    parsed(get(token, "/topup/qris/preview").await?)
}

/// `POST /topup/qris/claim` — claim a unique-nominal bill for `amount` (base,
/// integer, `min_base`–`max_base`, kelipatan `base_step`). The worker adds a
/// `000–900` suffix → `idr_amount`. Idempotent per email for the SAME base
/// (an active pending row returns unchanged); a DIFFERENT base frees the old
/// pending claim (status `expired`, semantik expiry) and allocates a fresh
/// one — the returned QR always bills the requested nominal.
pub async fn topup_qris_claim(
    token: &str,
    amount: i64,
) -> std::result::Result<Claim, String> {
    let body = serde_json::json!({ "amount": amount });
    parsed(post(token, "/topup/qris/claim", body).await?)
}

/// `GET /topup/qris/active` — the owner's active pending claim (recovery on
/// page mount), `None` when there is none. Same shape as [`Claim`].
pub async fn topup_qris_active(token: &str) -> std::result::Result<Option<Claim>, String> {
    let json = get(token, "/topup/qris/active").await?;
    if json.is_null() {
        return Ok(None);
    }
    parsed(json).map(Some)
}

/// `POST /topup/qris/cancel` — free the owner's pending claim (nominal
/// kembali ke pool, status `expired`). Worker 409 `claim_no_longer_pending`
/// when the claim already moved on (crediting/credited) arrives as `Err`.
pub async fn topup_qris_cancel(token: &str, tx_id: &str) -> std::result::Result<(), String> {
    let body = serde_json::json!({ "txId": tx_id });
    post(token, "/topup/qris/cancel", body).await?;
    Ok(())
}

/// `GET /topup/qris/status/:txId` — owner-scoped (404 for foreign tx ids);
/// `None` when the tx id is absent (worker body `null` — passed through).
pub async fn topup_qris_status(
    token: &str,
    tx_id: &str,
) -> std::result::Result<Option<Status>, String> {
    let json = get(token, &format!("/topup/qris/status/{tx_id}")).await?;
    if json.is_null() {
        return Ok(None);
    }
    parsed(json).map(Some)
}

/// `GET /topup/balance` — current tokens (0 for an account never topped up).
pub async fn topup_balance(token: &str) -> std::result::Result<Balance, String> {
    parsed(get(token, "/topup/balance").await?)
}

/// [`topup_balance`] + persist the result as the offline snapshot
/// (`billing_cache`). Every real worker read goes through here — the gate,
/// the desktop balance op, the web route — so this is the ONE place that
/// owns the ordering contract: settle the replay debt BEFORE the read, or
/// the snapshot overstates the balance by the whole backlog (whose ledger
/// rows predate the snapshot's `at`, so `offline_spend_since` can never see
/// them). Rate-limited per user — most calls this is a no-op. A failed
/// settle is logged, never surfaced: the next call retries, and per-row
/// worker dedupe makes re-pushes free.
pub async fn topup_balance_cached(
    user_id: &str,
    token: &str,
) -> std::result::Result<Balance, String> {
    if let Err(e) = flush_usage_replay(user_id, token).await {
        tracing::warn!(
            component = "billing",
            user = %user_id,
            detail = %e,
            "offline usage replay deferred"
        );
    }
    let balance = topup_balance(token).await?;
    if let Err(e) = kawai_db::billing_cache_set(user_id, balance.tokens).await {
        tracing::warn!(component = "billing", user = %user_id, detail = %e, "balance snapshot write failed");
    }
    Ok(balance)
}

/// The Fase 0a submit gate — the ONLY billing enforcement point (the client
/// pre-check in `use-workbench.run()` is UX). Online it is unchanged
/// fail-closed: worker balance ≤ 0 or an unreadable balance blocks the goal.
///
/// Offline tolerance: when the worker is UNREACHABLE (not when it answers 0),
/// the gate falls back to the last successful snapshot (`billing_cache`)
/// minus what the local `usage_ledger` records as spent since that snapshot,
/// within `OFFLINE_BALANCE_TTL_SECS`. The debit still happens server-side —
/// the recap path bills from telemetry once the network returns, and the
/// ledger rows it needs were written locally all along — so this grants
/// bounded credit against money already verified on this device, it does not
/// move debit authority to the client.
pub async fn billing_gate(user_id: &str, token: &str) -> Result<(), String> {
    // The balance read below settles the replay debt first (inside
    // `topup_balance_cached`) — the snapshot it persists must already include
    // the backlog debit.
    match topup_balance_cached(user_id, token).await {
        Ok(balance) if balance.tokens > 0 => Ok(()),
        Ok(_) => Err("Token habis — isi ulang lewat Top Up".to_string()),
        Err(worker_err) => {
            // Grace is for UNREACHABILITY only. A worker that ANSWERED with a
            // rejection (401 expired/invalid bearer, 4xx contract) is not an
            // outage: the session cannot be billed, replay would fail with
            // the same token, and granting credit here would launder an
            // auth failure into offline credit. Cloudflare 5xx (502/52x) is
            // the edge reporting the worker down — that IS an outage.
            if !worker_unreachable(&worker_err) {
                return Err(format!("balance check failed: {worker_err}"));
            }
            let snapshot = kawai_db::billing_cache_get(user_id)
                .await
                .map_err(|e| format!("balance check failed: {worker_err}; snapshot unreadable: {e}"))?
                .ok_or_else(|| format!("balance check failed: {worker_err}"))?;
            if snapshot.tokens <= 0 {
                // A zero answer was the worker's last word — honor it.
                return Err("Token habis — isi ulang lewat Top Up".to_string());
            }
            let spend = kawai_db::offline_spend_since(user_id, snapshot.at)
                .await
                .map_err(|e| {
                    format!("balance check failed: {worker_err}; offline spend unreadable: {e}")
                })?;
            match kawai_db::offline_billing_decision(
                snapshot.tokens,
                snapshot.at,
                spend,
                kawai_db::unix_now() as i64,
            ) {
                kawai_db::OfflineGate::Allow => {
                    tracing::warn!(
                        component = "billing",
                        user = %user_id,
                        cached_tokens = snapshot.tokens,
                        offline_spend = spend,
                        "worker unreachable — gate served from the cached balance (offline grace)"
                    );
                    Ok(())
                }
                kawai_db::OfflineGate::Stale => Err(format!(
                    "Saldo tidak terbaca dan snapshot offline sudah lebih dari \
                     {} jam — sambungkan internet untuk sinkron ({worker_err})",
                    kawai_db::OFFLINE_BALANCE_TTL_SECS / 3600
                )),
                kawai_db::OfflineGate::Exhausted => Err(format!(
                    "Jatah offline ({}) sudah terpakai — sambungkan internet \
                     untuk sinkron saldo ({worker_err})",
                    snapshot.tokens
                )),
            }
        }
    }
}

/// `GET /billing/history?limit=50` — the owner's balance ledger, newest
/// first: top-ups positive, Fase 0b usage debits negative. Read-only, so an
/// undeployed worker surfaces as `Err` and the UI shows a notice — never a
/// blocked top-up.
pub async fn topup_history(token: &str) -> std::result::Result<History, String> {
    parsed(get(token, &format!("/billing/history?limit={HISTORY_LIMIT}")).await?)
}

/// `POST /topup/voucher/redeem` — tukar kode voucher sekali-pakai jadi token.
/// Worker 400 `invalid_code_format`, 404 `voucher_not_found`, 409
/// `voucher_expired` / `voucher_revoked` / `voucher_already_redeemed`
/// arrive as `Err` with the worker's `{error}` text — the UI renders it
/// verbatim.
pub async fn topup_voucher_redeem(token: &str, code: &str) -> std::result::Result<VoucherRedeem, String> {
    let body = serde_json::json!({ "code": code });
    parsed(post(token, "/topup/voucher/redeem", body).await?)
}
