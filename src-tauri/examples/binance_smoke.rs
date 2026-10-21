// Headless smoke test for the Binance agent tools (builtin.binance, feature
// "binance"). Keyless public spot market data + TA — no credentials needed.
// Trading/account activity (signed account reads, stock routes) is NOT
// exercised here — those live on api.binance.com only and geo-block CI.
//
// Exercises: crypto_price → crypto_depth → crypto_klines → the composite
// crypto_ta_analyze (klines fetch + in-process `ta` indicator suite) →
// crypto_market_structure (the shared pivot scan: swings, levels, trend,
// last break), plus server-side input validation.
//
// Geo-skip: api.binance.com answers 451/403 to some hosting regions (e.g.
// US-based CI runners). When NOTHING has succeeded yet and the failure looks
// like a transport/geo block, this smoke exits 0 with a SKIP notice instead
// of failing. Set KAWAI_BINANCE_REST_BASE=https://data-api.binance.vision to
// point it at the market-data-only mirror (works from most regions).
//
// Usage:
//   cargo run --example binance_smoke --features binance
use binance::{
    DepthArgs, DepthTool, KlinesArgs, KlinesTool, MarketStructureArgs, MarketStructureTool,
    PriceArgs, PriceTool, TaAnalyzeArgs, TaAnalyzeTool,
};
use kawai_tools::AgentTool;
use serde_json::Value;

/// Tools return compact JSON text — parse once per step.
fn parse(step: &str, raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or_else(|e| die(&format!("{step}: bad JSON output: {e}")))
}

fn transportish(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    [
        "451",
        "403",
        "geo",
        "legal",
        "connect",
        "timed out",
        "timeout",
        "dns",
        "unreachable",
    ]
    .iter()
    .any(|m| e.contains(m))
}

/// Run one tool call; on failure either geo-SKIP (nothing succeeded yet) or die.
macro_rules! step {
    ($succeeded:expr, $label:expr, $call:expr) => {
        match $call.await {
            Ok(v) => {
                $succeeded += 1;
                v
            }
            Err(e) => {
                if $succeeded == 0 && transportish(&e.0) {
                    println!(
                        "[binance_smoke] SKIP: exchange unreachable from this host ({}) — \
                         geo/transport block, not a code regression. Set KAWAI_BINANCE_REST_BASE \
                         to override.",
                        e.0
                    );
                    std::process::exit(0);
                }
                println!("[binance_smoke] FAIL at {}: {}", $label, e.0);
                std::process::exit(1);
            }
        }
    };
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    let t0 = std::time::Instant::now();
    let mut succeeded = 0usize;

    // ── 1. price ──
    let price = parse(
            "crypto_price",
        step!(
            succeeded,
        "crypto_price",
            PriceTool.call(PriceArgs {
                symbol: "BTCUSDT".into(),
            })
        ),
    );
    let last = price["lastPrice"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or_else(|| die("crypto_price: lastPrice missing/unparseable"));
    assert!(last > 0.0, "crypto_price: non-positive lastPrice {last}");
    println!(
        "[binance_smoke] price      BTCUSDT last={last} chg={}%",
        price["priceChangePercent"]
    );

    // ── 2. depth ──
    let depth = parse(
        "crypto_depth",
        step!(
            succeeded,
            "crypto_depth",
            DepthTool.call(DepthArgs {
                symbol: "BTCUSDT".into(),
                limit: Some(5),
            })
        ),
    );
    let bids = depth["bids"].as_array().expect("depth: bids array");
    let asks = depth["asks"].as_array().expect("depth: asks array");
    assert!(!bids.is_empty() && !asks.is_empty(), "depth: empty book");
    println!(
        "[binance_smoke] depth      BTCUSDT levels={}/{} mid={}",
        bids.len(),
        asks.len(),
        depth["book"]["mid"]
    );

    // ── 3. klines ──
    let klines = parse(
        "crypto_klines",
        step!(
            succeeded,
            "crypto_klines",
            KlinesTool.call(KlinesArgs {
                symbol: "ETHUSDT".into(),
                interval: Some("1d".into()),
                limit: Some(30),
            })
        ),
    );
    let candles = klines["candles"].as_array().expect("klines: candles array");
    assert_eq!(candles.len(), 30, "klines: expected 30 candles");
    assert!(
        candles[0].as_array().is_some_and(|r| r.len() >= 6),
        "klines: malformed row"
    );
    println!("[binance_smoke] klines     ETHUSDT 1d n={}", candles.len());

    // ── 4. ta_analyze (composite workhorse) ──
    let ta = parse(
        "crypto_ta_analyze",
        step!(
            succeeded,
            "crypto_ta_analyze",
            TaAnalyzeTool.call(TaAnalyzeArgs {
                symbol: "BTCUSDT".into(),
                interval: Some("1d".into()),
                limit: None,
                indicators: None,
            })
        ),
    );
    let rsi = ta["rsi14"]
        .as_f64()
        .unwrap_or_else(|| die("ta: rsi14 missing"));
    assert!((0.0..=100.0).contains(&rsi), "ta: rsi14 out of range {rsi}");
    let ema9 = ta["ema9"]
        .as_f64()
        .unwrap_or_else(|| die("ta: ema9 missing"));
    assert!(ema9 > 0.0, "ta: non-positive ema9");
    let hist = ta["macd12269"]["histogram"]
        .as_f64()
        .unwrap_or_else(|| die("ta: macd histogram missing"));
    let skipped = ta["skipped"].as_array().map(|a| a.len()).unwrap_or(0);
    println!(
        "[binance_smoke] ta         BTCUSDT 1d rsi14={rsi:.2} ema9={ema9:.2} macdHist={hist:.4} windowChg={} skipped={skipped}",
        ta["windowChangePct"]
    );

    // ── 5. market structure (the pivot scan the stop policy shares) ──
    let structure = parse(
        "crypto_market_structure",
        step!(
            succeeded,
            "crypto_market_structure",
            MarketStructureTool.call(MarketStructureArgs {
                symbol: "BTCUSDT".into(),
                interval: Some("1d".into()),
                limit: None,
                half_width: None,
                max_levels: None,
            })
        ),
    );
    assert_eq!(
        structure["kind"], "market_structure",
        "structure: kind discriminator"
    );
    let levels = structure["levels"]
        .as_array()
        .expect("structure: levels array");
    assert!(!levels.is_empty(), "structure: no levels on 300 daily bars");
    let level = &levels[0];
    for key in ["price", "touches", "side", "distance_pct", "last_touch_age"] {
        assert!(level.get(key).is_some(), "structure: level missing {key}");
    }
    let trend = structure["trend"].as_str().expect("structure: trend");
    assert!(
        matches!(trend, "bullish" | "bearish" | "range"),
        "structure: unexpected trend {trend}"
    );
    let swings = structure["swings"]
        .as_array()
        .expect("structure: swings array");
    assert!(!swings.is_empty(), "structure: no confirmed swings");
    // Pivots are lagged by design: the newest possible one sits `half_width`
    // bars back, so its age can never be 0.
    let newest_age = swings
        .iter()
        .filter_map(|s| s["age"].as_u64())
        .min()
        .expect("structure: swing age");
    assert!(newest_age >= 1, "structure: a pivot repainted the current bar");
    println!(
        "[binance_smoke] structure  BTCUSDT 1d trend={trend} levels={} swings={} newest_age={newest_age} break={}",
        levels.len(),
        swings.len(),
        structure["last_break"]
    );

    // ── 6. invalid input is rejected server-side ──
    let bad_interval = KlinesTool
        .call(KlinesArgs {
            symbol: "BTCUSDT".into(),
            interval: Some("monthly".into()), // invalid — must error, not panic
            limit: None,
        })
        .await;
    assert!(bad_interval.is_err(), "invalid interval must be rejected");
    succeeded += 1;
    println!("[binance_smoke] validation rejects bad intervals: OK");

    println!(
        "[binance_smoke] PASS — {} checks in {:.1}s",
        succeeded,
        t0.elapsed().as_secs_f32()
    );
}

fn die(msg: &str) -> ! {
    println!("[binance_smoke] FAIL: {msg}");
    std::process::exit(1)
}
