// Throwaway probe: exercise `binance_futures_positions` end-to-end against the
// live Binance USDⓈ-M API (signed, read-only) and assert the local mirrors
// match what the tool reported. NOT part of the CI smoke gate — signed futures
// routes are not reachable from hosting regions.
use binance::{FuturesPositionsArgs, FuturesPositionsTool};
use kawai_tools::AgentTool;
use serde_json::Value;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    let dir = std::env::temp_dir().join(format!("binance_futures_live_{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    kawai_lib::logic::db::set_data_root(dir.clone());
    let user = "probe@example.com";

    let tool = FuturesPositionsTool(user.to_string());
    let raw = match tool.call(FuturesPositionsArgs {}).await {
        Ok(text) => text,
        Err(e) => {
            println!("[probe] live call failed: {e}");
            std::process::exit(2);
        }
    };
    let out: Value = serde_json::from_str(&raw).expect("tool output must be JSON");
    let positions = out["positions"].as_array().expect("positions array");
    let orders = out["openOrders"].as_array().expect("openOrders array");
    assert_eq!(
        out["synced"].as_u64().expect("synced count") as usize,
        positions.len(),
        "synced must match positions"
    );

    println!("[probe] {} open positions", positions.len());
    for p in positions.iter().take(5) {
        println!(
            "[probe]   {} {} {} amt={} entry={} mark={} pnl={}",
            p["margin"].as_str().unwrap_or("?"),
            p["symbol"].as_str().unwrap_or("?"),
            p["positionSide"].as_str().unwrap_or("?"),
            p["positionAmt"],
            p["entryPrice"],
            p["markPrice"],
            p["unRealizedProfit"],
        );
    }
    println!("[probe] total unrealized PnL (USDⓈ-M) {}", out["totalUnrealizedPnl"]);
    println!(
        "[probe] COIN-M PnL by asset: {}",
        out["coinmUnrealizedPnlByAsset"]
    );
    let coinm_n = positions
        .iter()
        .filter(|p| p["margin"].as_str() == Some("COINM"))
        .count();
    println!("[probe] COIN-M positions: {coinm_n}");

    println!("[probe] {} open orders", orders.len());
    for o in orders.iter().take(12) {
        println!(
            "[probe]   {} {} {} {} intent={} qty={} stop={} price={} reduceOnly={}",
            o["margin"].as_str().unwrap_or("?"),
            o["symbol"].as_str().unwrap_or("?"),
            o["side"].as_str().unwrap_or("?"),
            o["type"].as_str().unwrap_or("?"),
            o["intent"].as_str().unwrap_or("?"),
            o["origQty"],
            o["stopPrice"],
            o["price"],
            o["reduceOnly"],
        );
    }
    let kinds: std::collections::BTreeSet<&str> =
        orders.iter().filter_map(|o| o["intent"].as_str()).collect();
    println!("[probe] order intents present: {kinds:?}");

    let conn = kawai_lib::logic::db::db_connection(user).await.unwrap();

    // Positions mirror: every reported row must be present, amount and stamp intact.
    let mut rows = conn
        .query(
            "SELECT symbol, position_side, position_amt FROM binance_futures_positions
             ORDER BY symbol, position_side",
            libsql::params![],
        )
        .await
        .unwrap();
    let mut pos_rows = Vec::new();
    while let Some(r) = rows.next().await.unwrap() {
        pos_rows.push((
            r.get::<String>(0).unwrap(),
            r.get::<String>(1).unwrap(),
            r.get::<f64>(2).unwrap(),
        ));
    }
    assert_eq!(pos_rows.len(), positions.len(), "mirror must hold every position");
    let mut sorted: Vec<_> = positions.iter().collect();
    sorted.sort_by(|a, b| {
        (a["symbol"].as_str(), a["positionSide"].as_str()).cmp(&(
            b["symbol"].as_str(),
            b["positionSide"].as_str(),
        ))
    });
    for (i, p) in sorted.iter().enumerate() {
        assert_eq!(
            pos_rows[i],
            (
                p["symbol"].as_str().unwrap().to_string(),
                p["positionSide"].as_str().unwrap().to_string(),
                p["positionAmt"].as_f64().unwrap(),
            ),
            "position {i} must round-trip through the mirror"
        );
    }

    // Orders mirror: every reported order must be present with its
    // classification intact — that is the stop-loss / take-proof.
    let mut rows = conn
        .query(
            "SELECT order_id, symbol, intent FROM binance_futures_open_orders ORDER BY order_id",
            libsql::params![],
        )
        .await
        .unwrap();
    let mut order_rows = Vec::new();
    while let Some(r) = rows.next().await.unwrap() {
        order_rows.push((
            r.get::<i64>(0).unwrap(),
            r.get::<String>(1).unwrap(),
            r.get::<String>(2).unwrap(),
        ));
    }
    assert_eq!(order_rows.len(), orders.len(), "mirror must hold every open order");
    let mut by_id: std::collections::BTreeMap<i64, &Value> = std::collections::BTreeMap::new();
    for o in orders {
        by_id.insert(o["orderId"].as_i64().unwrap(), o);
    }
    for (id, symbol, intent) in &order_rows {
        let reported = by_id.get(id).unwrap_or_else(|| panic!("order {id} missing from output"));
        assert_eq!(*symbol, reported["symbol"].as_str().unwrap());
        assert_eq!(
            intent,
            reported["intent"].as_str().unwrap(),
            "order {id} intent must survive the round trip"
        );
    }

    // Re-sync must upsert, not duplicate.
    tool.call(FuturesPositionsArgs {}).await.unwrap();
    let mut rows = conn
        .query(
            "SELECT (SELECT COUNT(*) FROM binance_futures_positions),
                    (SELECT COUNT(*) FROM binance_futures_open_orders)",
            libsql::params![],
        )
        .await
        .unwrap();
    let r = rows.next().await.unwrap().unwrap();
    let (p2, o2): (i64, i64) = (r.get::<i64>(0).unwrap(), r.get::<i64>(1).unwrap());
    assert_eq!(p2 as usize, positions.len(), "re-sync must not duplicate positions");
    assert_eq!(o2 as usize, orders.len(), "re-sync must not duplicate orders");
    println!("[probe] idempotent re-sync: {p2} positions / {o2} orders");

    std::fs::remove_dir_all(&dir).ok();
    println!("[probe] PASS");
}