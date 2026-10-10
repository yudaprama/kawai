//! QRIS top-up + token-balance worker proxies (PLAN-qris-topup.md Fase 3).
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

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::local_auth::worker_base_url;

/// GET a worker endpoint with the session bearer. Non-2xx → the worker's
/// `{error}` text (e.g. `qr_payload_not_configured`, `insufficient_balance`).
async fn get(token: &str, path: &str) -> std::result::Result<serde_json::Value, String> {
    let url = format!("{}{path}", worker_base_url());
    let resp = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "worker unreachable".to_string())?;
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
    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| "worker unreachable".to_string())?;
    read_body(resp).await
}

/// 2xx → parsed body JSON; non-2xx → Err of the worker's `{error}` text.
async fn read_body(resp: reqwest::Response) -> std::result::Result<serde_json::Value, String> {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(json["error"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("worker error (HTTP {status})")));
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

// ── Ops (auth-required thin proxies) ─────────────────────────────────────────

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
