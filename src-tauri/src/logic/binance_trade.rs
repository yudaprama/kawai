// logic/binance_trade — the workbench's DIRECT placement ops (no planner,
// no plan): the post-audit offer forwards the audit's own presets and the
// click IS the confirmation. Levels are engine-computed — the same policy
// the audit grades with — so the user approves an action, never hand-typed
// numbers. All guards live inside the engines (reduce-only, trigger-side/
// distance/liquidation checks, idempotent client order id).
// Pure logic: no tauri/axum imports.

/// Protect the whole naked book in ONE call: grade every USDⓈ-M position
/// without a protective stop with the audit's own policy and place the
/// recommended reduce-only stop. Levels are engine-computed.
#[cfg(feature = "binance")]
pub async fn binance_auto_protect_positions(
    user_id: &str,
    interval: &str,
    risk: &str,
    limit: usize,
    symbols: Option<Vec<String>>,
) -> Result<String, String> {
    ::binance::trade::auto_protect_naked(user_id, interval, risk, limit, symbols)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_auto_protect_positions(
    _user_id: &str,
    _interval: &str,
    _risk: &str,
    _limit: usize,
    _symbols: Option<Vec<String>>,
) -> Result<String, String> {
    Err("binance feature not enabled (build with --features binance)".into())
}

/// Take-profit the whole book in ONE call: compute the advised R-ladder for
/// every USDⓈ-M position without a resting take-profit and place the rungs
/// as reduce-only orders. Levels are engine-computed.
#[cfg(feature = "binance")]
pub async fn binance_auto_take_profit_positions(
    user_id: &str,
    interval: &str,
    style: &str,
    limit: usize,
    symbols: Option<Vec<String>>,
) -> Result<String, String> {
    ::binance::trade::auto_take_profit_naked(user_id, interval, style, limit, symbols)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_auto_take_profit_positions(
    _user_id: &str,
    _interval: &str,
    _style: &str,
    _limit: usize,
    _symbols: Option<Vec<String>>,
) -> Result<String, String> {
    Err("binance feature not enabled (build with --features binance)".into())
}
