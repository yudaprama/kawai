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
    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("worker unreachable: {e}"))?;
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

// ── Wire structs (camelCase on both transports) ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub qr_payload: String,
    /// Base minimum (inclusive) that the user may request.
    pub min_base: i64,
    /// Base maksimum (inclusive) that the user may request.
    pub max_base: i64,
    /// Base wajib kelipatan ini (1000).
    pub base_step: i64,
    /// Token per 1 IDR base — `tokens = base * tokens_per_idr`.
    pub tokens_per_idr: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub tx_id: String,
    pub idr_amount: i64,
    pub tokens: i64,
    pub qr_payload: String,
    /// Unix seconds — unique-nominal bill expiry.
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `pending | crediting | credited | rejected | expired`.
    pub status: String,
    pub idr_amount: i64,
    pub tokens: i64,
    pub created_at: u64,
    pub credited_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub tokens: i64,
}

// ── Ops (auth-required thin proxies) ─────────────────────────────────────────

/// `GET /topup/qris/preview` — static QRIS payload + pay-as-you-go range
/// config (`minBase`/`maxBase`/`baseStep`/`tokensPerIdr`).
/// Errors while the merchant's EMVCo payload constant is unset (worker 503).
pub async fn topup_qris_preview(token: &str) -> std::result::Result<Preview, String> {
    parsed(get(token, "/topup/qris/preview").await?)
}

/// `POST /topup/qris/claim` — claim a unique-nominal bill for `amount` (base,
/// integer, `min_base`–`max_base`, kelipatan `base_step`). The worker adds a
/// `000–900` suffix → `idr_amount`. Idempotent per email: an existing active
/// pending row returns unchanged.
pub async fn topup_qris_claim(
    token: &str,
    amount: i64,
) -> std::result::Result<Claim, String> {
    let body = serde_json::json!({ "amount": amount });
    parsed(post(token, "/topup/qris/claim", body).await?)
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

/// `POST /billing/debit` — Fase 0b honor-system usage debit. Worker 409
/// `insufficient_balance` arrives as `Err`; the fail-open policy lives at
/// the call site (supervisor::plan_task), not here.
pub async fn billing_debit(token: &str, amount: u64) -> std::result::Result<Balance, String> {
    let body = serde_json::json!({ "amount": amount });
    parsed(post(token, "/billing/debit", body).await?)
}
