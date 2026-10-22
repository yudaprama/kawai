//! End-to-end probe of the Trading Performance pipeline.
//!
//! It builds the SAME plan the workbench chip and the router template build
//! (`accounting_tools::plan::build_trading_performance_plan`), resolves it
//! against the SAME merged registry the supervisor executes
//! (`supervisor::build_registry_for_plan`), and runs it through the real
//! scheduler — so what it prints is the payload the step cards actually read.
//!
//! Deterministic: the fills are seeded into a TEMP data root, so the ledger,
//! the reports and the card shapes are exercised without touching real books.
//! The only network traffic is the fill sync's read-only history fetch (and
//! with no keys configured it simply reports a skipped sync).
//!
//! Run from `src-tauri/`:
//!   cargo run --example trading_plan_smoke --features litert,accounting,binance,mexc

use std::str::FromStr;

use chrono::{Datelike, NaiveDate};
use kawai_router::SchedulerLimits;

/// The month before today — the review's natural default period (the current
/// month is incomplete, and a period must have started to be reviewable).
fn last_month(today: NaiveDate) -> (String, NaiveDate, NaiveDate) {
    let (year, month) = if today.month() == 1 {
        (today.year() - 1, 12)
    } else {
        (today.year(), today.month() - 1)
    };
    let period = format!("{year}-{month:02}");
    let (from, to) = accounting_tools::plan::month_bounds(year, month);
    (period, from, to)
}

fn midnight_ms(date: NaiveDate) -> i64 {
    date.and_hms_opt(0, 0, 0)
        .expect("midnight is a valid time")
        .and_utc()
        .timestamp_millis()
}

#[tokio::main]
async fn main() {
    let dir = tempfile::tempdir().expect("temp data root");
    kawai_db::set_data_root(dir.path());
    // The temp dir must outlive the run: the store re-opens the path per op.
    std::mem::forget(dir);

    let user = format!("trading-smoke-{}", std::process::id());
    let session = kawai_db::create_chat_session(&user)
        .await
        .expect("chat session")
        .id;

    let today = chrono::Local::now().date_naive();
    let (period, from, to) = last_month(today);
    println!("user={user} session={session} period={period} ({from} .. {to})");

    // Seed the fill mirror exactly as a venue sync would: two USDT-settled
    // fills (they belong in the books) and one COIN-M fill (settles in the
    // coin — must be reported, never posted).
    let conn = kawai_db::db_connection(&user).await.expect("db");
    let day1 = midnight_ms(from) + 3_600_000;
    let day2 = midnight_ms(from) + 86_400_000 + 3_600_000;
    let seeded = [
        ("USDM", "BTCUSDT", 9_001i64, 25.5f64, day1),
        ("USDM", "ETHUSDT", 9_002, -10.25, day2),
        ("COINM", "BTCUSD_PERP", 9_003, 100.0, day2),
    ];
    for (market, symbol, trade_id, pnl, at) in seeded {
        conn.execute(
            "INSERT INTO venue_fills (venue, market, trade_id, symbol, position_side, side, \
             price, qty, quote_qty, realized_pnl, commission, commission_asset, order_id, maker, traded_at) \
             VALUES ('binance', ?, ?, ?, 'LONG', 'SELL', 50000.0, 0.01, 500.0, ?, 0.5, 'USDT', 0, 0, ?)",
            libsql::params![market, trade_id, symbol, pnl, at],
        )
        .await
        .expect("seed fill");
    }

    // The real plan: same builder, same sync-venue list the templates use.
    let mut plan = accounting_tools::plan::build_trading_performance_plan(
        &period,
        today,
        None,
        kawai_lib::templates::TRADING_SYNC_VENUES,
        Some("id-ID"),
    )
    .expect("plan");
    println!(
        "\nsteps: {:?}\ngoal:\n{}\n",
        plan.steps
            .iter()
            .map(|s| format!("{} -> {}", s.id, s.dispatch_key()))
            .collect::<Vec<_>>(),
        plan.goal
    );

    // The registry EVERY entry path executes against, and the policy pass the
    // executor performs before dispatch.
    let registry = kawai_lib::supervisor::build_registry_for_plan(&user, session, &plan)
        .await
        .expect("merged registry");
    registry.validate_plan(&plan).expect("plan must be dispatchable");
    registry.enforce_confirmation_policy(&mut plan);

    let result = kawai_router::run_plan(plan, registry.step_dispatch(), SchedulerLimits::default())
        .await
        .expect("the plan must execute");

    let mut failures: Vec<String> = Vec::new();
    for step in &result.results {
        let payload: serde_json::Value =
            serde_json::from_str(&step.output).unwrap_or(serde_json::Value::Null);
        println!(
            "\n── {} [{}] {}",
            step.step_id,
            format!("{:?}", step.status),
            step.error.clone().unwrap_or_default()
        );
        println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());

        // Structural assertions on purpose: the smoke proves the WIRING (plan →
        // registry → tool → the payload the card reads). Exact arithmetic is
        // pinned by the crate tests, and a machine with live exchange keys
        // legitimately adds real fills to this run.
        match step.step_id.as_str() {
            // The stats card is SCOPED to the period and the USDT market — the
            // bug this pins is "asked for one month, reported the lifetime".
            "fetch-binance" => {
                if payload["market"] != serde_json::json!("USDM") {
                    failures.push(format!("the stats read must stay USDM: {payload}"));
                }
                let p = &payload["period"];
                if p["from"] != serde_json::json!(from.to_string())
                    || p["to"] != serde_json::json!(to.to_string())
                {
                    failures.push(format!("the stats read must echo the period: {payload}"));
                }
            }
            // The gate is measured BEFORE the reads and must pass on a freshly
            // written ledger.
            "integrity-gate" => {
                if payload["is_valid"] != serde_json::json!(true) {
                    failures.push(format!("integrity gate: {payload}"));
                }
            }
            "sync" => {
                let posted = payload["posted_ids"].as_array().cloned().unwrap_or_default();
                if !posted.contains(&serde_json::json!("binance_USDM_9001")) {
                    failures.push(format!("the USDT fill must post: {payload}"));
                }
                if payload["skipped_other_settlement"].as_u64().unwrap_or(0) < 1 {
                    failures.push(format!("the COIN-M fill must be reported as skipped: {payload}"));
                }
                if !payload["posted_ids_truncated"].is_boolean() {
                    failures.push(format!("truncation must be reported as a bool: {payload}"));
                }
            }
            "pnl" => {
                let rows = payload["rows"].as_array().cloned().unwrap_or_default();
                let symbols: Vec<&str> = rows.iter().filter_map(|r| r["symbol"].as_str()).collect();
                if symbols.contains(&"BTCUSD_PERP") {
                    failures.push(format!("a coin-settled symbol leaked into the USDT book: {symbols:?}"));
                }
                if !rows.iter().any(|r| r["symbol"] == "BTCUSDT" && r["realized_pnl"] == "25.5") {
                    failures.push(format!("the seeded USDT fill must appear: {payload}"));
                }
                if !payload["totals"]["realized_pnl"].is_string() {
                    failures.push(format!("totals must stay exact decimal strings: {payload}"));
                }
            }
            "fees" => {
                if !payload["commission_total"].is_string() || payload["rows"].as_array().is_none() {
                    failures.push(format!("the fee card payload shape changed: {payload}"));
                }
            }
            _ => {}
        }
    }

    if failures.is_empty() {
        println!(
            "\nOK — {} steps, all_completed={}",
            result.results.len(),
            result.all_completed()
        );
    } else {
        eprintln!("\nFAILED:");
        for f in &failures {
            eprintln!("  - {f}");
        }
        std::process::exit(1);
    }
}
