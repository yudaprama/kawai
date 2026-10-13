// logic/binance_trade — the workbench's DIRECT placement ops (no planner,
// no plan): the post-audit offer forwards the audit's own presets and the
// click IS the confirmation. Levels are engine-computed — the same policy
// the audit grades with — so the user approves an action, never hand-typed
// numbers. All guards live inside the engines (reduce-only, trigger-side/
// distance/liquidation checks, idempotent client order id).
// Pure logic: no tauri/axum imports.
//
// The screener's counterpart (`binance_open_screened_positions`) OPENS
// positions: the run view offers the run's own hits, the user approves a
// subset with a notional each, and the engine derives the side from the
// screen and attaches its own stop before reporting success.


/// One approved screener hit, as the transport hands it over.
///
/// Declared here rather than in the `binance` crate because this module has a
/// `not(feature = "binance")` fallback that must compile without that
/// optional dependency. `screen` is the setup that produced the hit — the
/// side is DERIVED from it inside the engine, so no transport can ask for a
/// short on a bullish setup.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ScreenedPick {
    pub symbol: String,
    /// The screen that produced the hit — the side is DERIVED from it, so a
    /// client cannot ask for a short on a bullish setup.
    pub screen: String,
    /// Position size in USDT, exactly as approved in the offer.
    pub notional: f64,
}

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

/// Open the approved screener candidates, each with its stop already resting.
///
/// The ONE op that can increase exposure, and deliberately not an
/// `AgentTool`: the planner never picks what gets bought. The direction is
/// derived from the screen that produced each hit (a neutral screen has no
/// side and is refused), and no entry is placed unless a protective stop
/// level survives the same guards the audit grades with.
#[cfg(feature = "binance")]
pub async fn binance_open_screened_positions(
    user_id: &str,
    picks: Vec<ScreenedPick>,
    interval: &str,
    risk: &str,
) -> Result<String, String> {
    ::binance::trade::open_screened_positions(
        user_id,
        picks
            .into_iter()
            .map(|p| ::binance::trade::EntryPick {
                symbol: p.symbol,
                screen: p.screen,
                notional: p.notional,
            })
            .collect(),
        interval,
        risk,
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(not(feature = "binance"))]
pub async fn binance_open_screened_positions(
    _user_id: &str,
    _picks: Vec<ScreenedPick>,
    _interval: &str,
    _risk: &str,
) -> Result<String, String> {
    Err("binance feature not enabled (build with --features binance)".into())
}
