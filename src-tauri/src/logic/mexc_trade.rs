// logic/mexc_trade — the workbench's DIRECT placement ops for MEXC (no
// planner, no plan): the post-audit offer forwards the audit's own presets and
// the click IS the confirmation. Levels are engine-computed by the SAME
// venue-neutral policies the audit grades with, so the user approves an action,
// never hand-typed numbers. Every guard (close-side + reduce-only, tick/lot
// rounding, coverage check against BOTH the book and the plan-order family)
// lives inside the `mexc` crate.
//
// Pure logic: no tauri/axum imports.

/// Place a protective stop on every approved MEXC position that has none.
#[cfg(feature = "mexc")]
pub async fn mexc_auto_protect_positions(
    user_id: &str,
    interval: &str,
    risk: &str,
    limit: usize,
    symbols: Option<Vec<String>>,
) -> Result<String, String> {
    ::mexc::protect::auto_protect_naked(user_id, interval, risk, limit, symbols)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_auto_protect_positions(
    _user_id: &str,
    _interval: &str,
    _risk: &str,
    _limit: usize,
    _symbols: Option<Vec<String>>,
) -> Result<String, String> {
    Err("mexc feature not enabled (build with --features mexc)".into())
}

/// Place the advised take-profit ladder on every approved MEXC position that
/// has none.
#[cfg(feature = "mexc")]
pub async fn mexc_auto_take_profit_positions(
    user_id: &str,
    interval: &str,
    style: &str,
    limit: usize,
    symbols: Option<Vec<String>>,
) -> Result<String, String> {
    ::mexc::protect::auto_take_profit_naked(user_id, interval, style, limit, symbols)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_auto_take_profit_positions(
    _user_id: &str,
    _interval: &str,
    _style: &str,
    _limit: usize,
    _symbols: Option<Vec<String>>,
) -> Result<String, String> {
    Err("mexc feature not enabled (build with --features mexc)".into())
}

/// Open the user-approved screener hits on MEXC, each with its protective
/// stop (plan order) and, when requested, the take-profit ladder.
#[cfg(feature = "mexc")]
pub async fn mexc_open_screened_positions(
    user_id: &str,
    picks: Vec<(String, String, f64)>,
    interval: &str,
    risk: &str,
    place_tp: bool,
) -> Result<String, String> {
    let picks = picks
        .into_iter()
        .map(|(symbol, screen, notional)| ::mexc::screened::EntryPick { symbol, screen, notional })
        .collect();
    ::mexc::screened::mexc_open_screened_positions(user_id, picks, interval, risk, place_tp)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_open_screened_positions(
    _user_id: &str,
    _picks: Vec<(String, String, f64)>,
    _interval: &str,
    _risk: &str,
    _place_tp: bool,
) -> Result<String, String> {
    Err("mexc feature not enabled (build with --features mexc)".into())
}

/// Pre-approval stop preview for MEXC hits — keyless fold over public candles.
#[cfg(feature = "mexc")]
pub async fn mexc_screened_stop_preview(
    picks: Vec<(String, String)>,
    interval: &str,
    risk: &str,
) -> Result<String, String> {
    ::mexc::screened::mexc_screened_stop_preview(picks, interval, risk)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "mexc"))]
pub async fn mexc_screened_stop_preview(
    _picks: Vec<(String, String)>,
    _interval: &str,
    _risk: &str,
) -> Result<String, String> {
    Err("mexc feature not enabled (build with --features mexc)".into())
}
