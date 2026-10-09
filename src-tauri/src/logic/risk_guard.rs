// logic/risk_guard — the in-process futures risk guard (feature `binance`).
//
// `spawn` starts a tokio timer that every 15 minutes reads the ACTIVE user's
// toggle (`risk_guard_settings`, via the last_session pointer) and, when ON,
// runs one audit cycle (`binance::risk_audit::guard_cycle`) logging the
// verdict. Desktop-only today (spawned from the Tauri setup hook); the cron
// binary (`kawai-riskguard`) covers closed periods with the SAME cycle
// function — one policy, two schedulers.
//
// Errors are never fatal and never panic the app: a cycle that fails
// (credentials missing, exchange down, rate budget) logs one line and waits
// for the next tick.

/// Seconds between guard cycles. Mirrors `binance::risk_audit::GUARD_INTERVAL_SECS`
/// (compile-time checked in the test below). Hardcoded: one honest value
/// beats a knob nobody tunes.
pub const INTERVAL_SECS: u64 = 900;

#[cfg(all(test, feature = "binance"))]
mod interval_parity {
    #[test]
    fn matches_the_binance_crate_constant() {
        assert_eq!(super::INTERVAL_SECS, ::binance::risk_audit::GUARD_INTERVAL_SECS);
    }
}

/// The guard loop — a PURE future: no transport types, and critically NO
/// `tokio::spawn` inside. The Tauri setup hook runs on the MAIN thread
/// outside any tokio reactor context (`tokio::spawn` there panics with
/// "there is no reactor running" and aborts the app, since the tao launch
/// delegate cannot unwind). The caller owns the reactor: `lib.rs` spawns
/// this via `tauri::async_runtime::spawn`.
///
/// Without the `binance` feature the loop completes immediately (no-op).
pub async fn run_loop() {
    #[cfg(feature = "binance")]
    {
        // Let the app settle (window, migrations) before the first cycle.
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        loop {
            run_cycle().await;
            tokio::time::sleep(std::time::Duration::from_secs(INTERVAL_SECS)).await;
        }
    }
}

/// One guard cycle: active user → toggle → audit → log. Never panics.
#[cfg(feature = "binance")]
async fn run_cycle() {
    // The app's real data root is already injected by the Tauri setup.
    let Some(user) = active_user() else {
        return; // never signed in on this machine — nothing to guard
    };
    if !::binance::risk_audit::guard_enabled(&user).await {
        return; // opted out this cycle — silent, not even a log line
    }
    match ::binance::risk_audit::guard_cycle(&user, 15).await {
        Ok(report) => match report.alert {
            Some(line) => println!("[risk-guard] {line}"),
            None => println!("[risk-guard] semua posisi terlindungi — OK"),
        },
        // Credential/config errors are guidance, not incidents — one quiet
        // line, the next tick retries.
        Err(e) => eprintln!("[risk-guard] skip: {e}"),
    }
}

/// The ACTIVE user from `<data_root>/last_session` (the same pointer the app
/// writes at sign-in).
#[cfg(feature = "binance")]
fn active_user() -> Option<String> {
    let email = std::fs::read_to_string(kawai_paths::last_session())
        .ok()?
        .trim()
        .to_lowercase();
    (!email.is_empty()).then_some(email)
}

// ---- toggle ops (Settings switch; both wrappers) ------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskGuardStatus {
    pub enabled: bool,
}

#[cfg(feature = "binance")]
pub async fn risk_guard_get(user_id: &str) -> Result<RiskGuardStatus, String> {
    Ok(RiskGuardStatus {
        enabled: ::binance::risk_audit::guard_enabled(user_id).await,
    })
}

#[cfg(feature = "binance")]
pub async fn risk_guard_set(user_id: &str, enabled: bool) -> Result<(), String> {
    ::binance::risk_audit::set_guard_enabled(user_id, enabled)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(not(feature = "binance"))]
pub async fn risk_guard_get(_user_id: &str) -> Result<RiskGuardStatus, String> {
    Ok(RiskGuardStatus { enabled: false })
}

#[cfg(not(feature = "binance"))]
pub async fn risk_guard_set(_user_id: &str, _enabled: bool) -> Result<(), String> {
    Err("binance feature not enabled (build with --features binance)".into())
}