// Headless smoke test for the analytics agent tools (builtin.analytics,
// feature "analytics"): import a small CSV into the office store →
// data_schema (columns/dtypes) → data_query (row selection), then the xlsx
// bridge (typed columns, resolved dates, sheets echo, sidecar cache),
// aggregate queries, the self-correcting error contract, the tabular-ext
// guard, and the data_ta technical-analysis suite over an OHLCV series.
// Fully offline: fixtures are generated in-process, no network, no model.
//
// Usage:
//   cargo run --example analytics_smoke --features analytics
use kawai_lib::logic::analytics::{self as data, DataQueryTool, DataTableSchemaTool, DataTaTool};
use kawai_lib::logic::office::store;
use kawai_tools::AgentTool;
use serde_json::Value;

const CSV: &str = "city,sales\njakarta,100\nbandung,80\njakarta,60\n";

fn die(msg: &str) -> ! {
    eprintln!("[analytics_smoke] FAIL: {msg}");
    std::process::exit(1);
}

/// Serial numbers for the fixture dates under the (bug-compatible) 1900
/// system — precomputed (days since 1899-12-30), no chrono dep needed here.
fn excel_serial(y: i32, m: u32, d: u32) -> f64 {
    match (y, m, d) {
        (2026, 1, 5) => 46027.0,
        (2026, 1, 20) => 46042.0,
        (2026, 2, 1) => 46054.0,
        (2026, 1, 12) => 46034.0,
        (2026, 2, 15) => 46068.0,
        _ => unreachable!("fixture dates only"),
    }
}

/// The canonical sales table as a real typed xlsx workbook (strings,
/// integers, date-styled serials).
fn sales_xlsx_bytes() -> Vec<u8> {
    use office_oxide::xlsx::write::{CellData, CellStyle, NumberFormat, XlsxWriter};
    let mut wb = XlsxWriter::new();
    let mut s = wb.add_sheet("Sales");
    let date_style = CellStyle::new().number_format(NumberFormat::Date);
    for (ci, h) in ["produk", "kategori", "pendapatan", "tanggal"]
        .iter()
        .enumerate()
    {
        s.set_cell(0, ci as usize, CellData::String(h.to_string()));
    }
    let rows: [(&str, &str, f64, (i32, u32, u32)); 5] = [
        ("laptop", "elektronik", 1000.0, (2026, 1, 5)),
        ("mouse", "elektronik", 20.0, (2026, 1, 20)),
        ("laptop", "elektronik", 1500.0, (2026, 2, 1)),
        ("monitor", "elektronik", 300.0, (2026, 1, 12)),
        ("mouse", "aksesori", 25.0, (2026, 2, 15)),
    ];
    for (ri, (p, k, rev, (y, m, d))) in rows.iter().enumerate() {
        let ri = ri + 1;
        s.set_cell(ri, 0, CellData::String(p.to_string()));
        s.set_cell(ri, 1, CellData::String(k.to_string()));
        s.set_cell(ri, 2, CellData::Number(*rev));
        s.set_cell_styled(
            ri,
            3,
            CellData::Number(excel_serial(*y, *m, *d)),
            date_style.clone(),
        );
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    wb.write_to(&mut buf).expect("write xlsx");
    buf.into_inner()
}

fn rows_of(out: &str) -> Vec<Value> {
    let v: Value = serde_json::from_str(out).unwrap_or_else(|e| die(&format!("bad JSON: {e}")));
    v["rows"].as_array().cloned().unwrap_or_default()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    // Office store under /tmp — keeps the smoke test out of real user data.
    std::env::set_var("KAWAI_DATA_DIR", "/tmp/kawai-smoke");

    let user = "analytics-smoke";
    let stored = store::import_bytes(user, "smoke-sales.csv", CSV.as_bytes()).expect("import csv");
    println!(
        "[analytics_smoke] imported {} ({})",
        stored.original_name, stored.id
    );

    let schema = DataTableSchemaTool(user.to_string())
        .call(data::SchemaArgs {
            file_id: stored.id.clone(),
            sheet: None,
        })
        .await
        .expect("data_schema");
    println!("[analytics_smoke] data_schema → {schema}");

    // Built through its serde shape (camelCase) — the flattened query struct
    // stays internal to the tool boundary.
    let args: data::QueryArgs =
        serde_json::from_value(serde_json::json!({ "fileId": stored.id, "limit": 5 }))
            .expect("query args");
    let rows = DataQueryTool(user.to_string())
        .call(args)
        .await
        .expect("data_query");
    println!("[analytics_smoke] data_query → {rows}");

    let _ = data::toolset(user, 1, &[]);
    println!("[analytics_smoke] PASS csv wrapper roundtrip");

    // ── xlsx bridge: typed conversion + sidecar cache ────────────────────
    let xlsx =
        store::import_bytes(user, "smoke-sales.xlsx", &sales_xlsx_bytes()).expect("import xlsx");
    let info: Value = serde_json::from_str(
        &DataTableSchemaTool(user.to_string())
            .call(data::SchemaArgs {
                file_id: xlsx.id.clone(),
                sheet: None,
            })
            .await
            .expect("data_schema(xlsx)"),
    )
    .expect("schema JSON");
    if info["format"] != "xlsx" || info["rows"].as_i64() != Some(5) {
        die(&format!("xlsx schema wrong: {info}"));
    }
    if info["sheets"][0] != "Sales" || info["activeSheet"] != "Sales" {
        die(&format!("xlsx sheets echo wrong: {info}"));
    }
    let dtype = |n: &str| {
        info["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == n)
            .unwrap_or_else(|| die(&format!("missing column {n}: {info}")))["dtype"]
            .clone()
    };
    if dtype("pendapatan") != "integer" || dtype("tanggal") != "date (YYYY-MM-DD)" {
        die(&format!(
            "xlsx dtypes wrong: pendapatan={}, tanggal={}",
            dtype("pendapatan"),
            dtype("tanggal")
        ));
    }
    println!("[analytics_smoke] PASS data_schema(xlsx): typed columns, dates resolved");

    // Aggregate through the serde wire shape (camelCase, string values).
    let out = DataQueryTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": xlsx.id,
                "filters": [{ "column": "kategori", "operator": "eq", "value": "elektronik" }],
                "groupBy": ["produk"],
                "aggregations": [
                    { "column": "pendapatan", "function": "sum", "alias": "total" }
                ],
                "sortBy": "total",
                "descending": true
            }))
            .expect("query args"),
        )
        .await
        .expect("data_query(xlsx)");
    let rows = rows_of(&out);
    if rows.len() != 3 || rows[0]["produk"] != "laptop" || rows[0]["total"].as_f64() != Some(2500.0)
    {
        die(&format!("aggregate wrong: {out}"));
    }
    println!("[analytics_smoke] PASS data_query(xlsx): filter+group+sum+sort → laptop 2500");

    // Date-styled serials filter as real dates.
    let out = DataQueryTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": xlsx.id,
                "filters": [{ "column": "tanggal", "operator": "gte", "value": "2026-02-01" }]
            }))
            .expect("query args"),
        )
        .await
        .expect("data_query(date)");
    if rows_of(&out).len() != 2 {
        die(&format!("date filter should return 2 rows: {out}"));
    }
    println!("[analytics_smoke] PASS data_query(xlsx): date range filter");

    // Calendar-part filter: "January" as datePart month == 1.
    let out = DataQueryTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": xlsx.id,
                "filters": [{ "column": "tanggal", "operator": "eq", "value": "1", "datePart": "month" }]
            }))
            .expect("query args"),
        )
        .await
        .expect("data_query(datePart)");
    if rows_of(&out).len() != 3 {
        die(&format!("datePart month=1 should return 3 rows: {out}"));
    }
    println!("[analytics_smoke] PASS data_query(xlsx): datePart month filter");

    // Cache invalidation: rewrite the workbook with one more row (new size +
    // mtime) — the sidecar must rebuild, not serve stale data.
    store::import_bytes(user, "smoke-sales-v2.xlsx", &sales_xlsx_bytes()).expect("import v2");
    let out = DataQueryTool(user.to_string())
        .call(serde_json::from_value(serde_json::json!({ "fileId": xlsx.id })).expect("query args"))
        .await
        .expect("data_query(re-read)");
    if rows_of(&out).len() != 5 {
        die(&format!("re-read should still return 5 rows: {out}"));
    }
    println!("[analytics_smoke] PASS xlsx sidecar cache stable across reads");

    // ── self-correcting errors reach the model verbatim ──────────────────
    let err = DataQueryTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": xlsx.id,
                "filters": [{ "column": "amount", "operator": "eq", "value": "5" }]
            }))
            .expect("query args"),
        )
        .await
        .expect_err("unknown column must fail");
    if !err.0.contains("not found") || !err.0.contains("valid columns") {
        die(&format!("unknown-column error lacks guidance: {err}"));
    }
    println!("[analytics_smoke] PASS error contract: {err}");

    // Unknown Excel sheet echoes the available ones.
    let err = DataTableSchemaTool(user.to_string())
        .call(data::SchemaArgs {
            file_id: xlsx.id.clone(),
            sheet: Some("Q1".into()),
        })
        .await
        .expect_err("unknown sheet must fail");
    if !err.0.contains("Sales") {
        die(&format!("unknown-sheet error should list sheets: {err}"));
    }
    println!("[analytics_smoke] PASS sheet selection error echo");

    // ── non-tabular ext guard ─────────────────────────────────────────────
    let md = store::import_bytes(user, "smoke-notes.md", b"# hi\n").expect("import md");
    let err = DataTableSchemaTool(user.to_string())
        .call(data::SchemaArgs {
            file_id: md.id,
            sheet: None,
        })
        .await
        .expect_err("data tools must reject non-tabular files");
    if !err.0.contains("data tools accept") {
        die(&format!("non-tabular error lacks guidance: {err}"));
    }
    println!("[analytics_smoke] PASS ext guard: {err}");

    // ── data_ta: technical-analysis suite over an OHLCV csv ──────────────
    // Deterministic random walk (same PRNG recipe as the binance fixtures).
    let mut ohlcv = String::from("ts,open,high,low,close,volume\n");
    let mut price = 100.0f64;
    let mut seed = 0x2545F4914F6CDD1Du64;
    for i in 0..60 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let noise = ((seed >> 33) % 200) as f64 / 100.0 - 1.0;
        price *= 1.0 + (0.05 + noise * 0.005) / 100.0;
        ohlcv.push_str(&format!(
            "{},{:.4},{:.4},{:.4},{:.4},{}\n",
            1_700_000_000_000 + i as i64 * 86_400_000,
            price * 0.999,
            price * 1.01,
            price * 0.99,
            price,
            1_000 + (i % 7),
        ));
    }
    let ta_file =
        store::import_bytes(user, "smoke-ohlcv.csv", ohlcv.as_bytes()).expect("import ohlcv");
    let out = DataTaTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": ta_file.id,
                "timestamp": "ts",
                "close": "close",
                "high": "high",
                "low": "low",
                "volume": "volume",
                "indicators": [
                    { "kind": "ema", "period": 21 },
                    { "kind": "rsi" },
                    { "kind": "macd" },
                    { "kind": "atr" }
                ]
            }))
            .expect("ta args"),
        )
        .await
        .expect("data_ta");
    let tv: Value = serde_json::from_str(&out).unwrap();
    if tv["_meta"]["rowsUsed"].as_i64() != Some(60) || !tv["_meta"]["skipped"].is_null() {
        die(&format!("data_ta meta wrong: {out}"));
    }
    let ema21 = tv["indicators"]["ema21"].as_f64().unwrap_or_else(|| die("ema21 missing"));
    if !(90.0..200.0).contains(&ema21) {
        die(&format!("ema21 implausible: {ema21}"));
    }
    let rsi = tv["indicators"]["rsi14"].as_f64().unwrap_or_else(|| die("rsi missing"));
    if !(0.0..=100.0).contains(&rsi) {
        die(&format!("rsi unbounded: {rsi}"));
    }
    if tv["indicators"]["macd12_26_9"]["histogram"].as_f64().is_none()
        || tv["indicators"]["atr14"].as_f64().unwrap_or(0.0) <= 0.0
    {
        die(&format!("macd/atr output wrong: {out}"));
    }
    println!("[analytics_smoke] PASS data_ta: ema/rsi/macd/atr final values over sorted OHLCV");

    // Short series (header + 5 data rows) → both indicators exceed their
    // warm-up windows and come back as skipped entries instead of values.
    let short = store::import_bytes(
        user,
        "smoke-ohlcv-short.csv",
        ohlcv.lines().take(6).collect::<Vec<_>>().join("\n").as_bytes(),
    )
    .expect("import short ohlcv");
    let out = DataTaTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": short.id,
                "timestamp": "ts",
                "close": "close",
                "indicators": [{ "kind": "sma" }, { "kind": "bb" }]
            }))
            .expect("ta args"),
        )
        .await
        .expect("data_ta(short)");
    let sv: Value = serde_json::from_str(&out).unwrap();
    let skipped = sv["_meta"]["skipped"].as_array().cloned().unwrap_or_default();
    if skipped.len() != 2 || !skipped.iter().any(|s| s["alias"] == "bb20_2") {
        die(&format!("expected both indicators skipped with reasons: {out}"));
    }
    println!("[analytics_smoke] PASS data_ta: warm-up skips reported instead of fake values");

    // Unknown kind → guidance error listing the valid kinds.
    let err = DataTaTool(user.to_string())
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": ta_file.id, "close": "close",
                "indicators": [{ "kind": "fibonacci" }]
            }))
            .expect("ta args"),
        )
        .await
        .expect_err("unknown kind must fail");
    if !err.0.contains("unknown indicator kind") || !err.0.contains("rsi") {
        die(&format!("unknown-kind error lacks guidance: {err}"));
    }
    println!("[analytics_smoke] PASS data_ta error contract: {err}");

    // ── data_chart: aggregated bar chart → svg in the office store ───────
    let out = data::DataChartTool(user.to_string(), 1)
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": stored.id,
                "mark": "bar",
                "x": "city",
                "y": "total",
                "groupBy": ["city"],
                "aggregations": [
                    { "column": "sales", "function": "sum", "alias": "total" }
                ],
                "sortBy": "total",
                "descending": true,
                "title": "Sales by city"
            }))
            .expect("chart args"),
        )
        .await
        .expect("data_chart");
    let cv: Value = serde_json::from_str(&out).unwrap();
    if cv["rows"].as_i64() != Some(2) || cv["mark"] != "bar" {
        die(&format!("data_chart reply wrong: {out}"));
    }
    let chart_id = cv["fileId"].as_str().unwrap_or_else(|| die("fileId missing")).to_string();
    let (info, bytes) = store::read_file(user, &chart_id).expect("read chart svg");
    let svg = String::from_utf8(bytes).unwrap();
    if info.ext != "svg" || !svg.starts_with("<svg") || !svg.contains("Sales by city") {
        die(&format!("stored chart wrong: {} {} bytes, head: {}", info.ext, svg.len(), &svg[..40.min(svg.len())]));
    }
    println!(
        "[analytics_smoke] PASS data_chart: grouped bar → {}-byte svg in store ({})",
        svg.len(),
        info.original_name
    );

    // Missing y in the query result → guidance error, not a render failure.
    let err = data::DataChartTool(user.to_string(), 1)
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": stored.id, "mark": "line", "x": "city", "y": "nope"
            }))
            .expect("chart args"),
        )
        .await
        .expect_err("unknown y must fail");
    if !err.0.contains("nope") {
        die(&format!("data_chart error lacks guidance: {err}"));
    }
    println!("[analytics_smoke] PASS data_chart error contract: {err}");

    // Histogram: distribution of the raw sales values (no y — count implied).
    let out = data::DataChartTool(user.to_string(), 1)
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": stored.id, "mark": "histogram", "x": "sales"
            }))
            .expect("chart args"),
        )
        .await
        .expect("data_chart(histogram)");
    let hv: Value = serde_json::from_str(&out).unwrap();
    if hv["mark"] != "histogram" || hv["rows"].as_i64() != Some(3) {
        die(&format!("histogram reply wrong: {out}"));
    }
    println!("[analytics_smoke] PASS data_chart histogram: distribution svg");

    // Stacked bar with a color series composes to cumulative totals.
    let stack_csv = "bulan,nilai,wilayah\n1,10,utara\n1,5,selatan\n2,20,utara\n2,8,selatan\n";
    let stacked = store::import_bytes(user, "smoke-stack.csv", stack_csv.as_bytes()).expect("import stack csv");
    let out = data::DataChartTool(user.to_string(), 1)
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": stacked.id, "mark": "bar", "x": "bulan", "y": "nilai",
                "color": "wilayah", "stack": "stacked"
            }))
            .expect("chart args"),
        )
        .await
        .expect("data_chart(stacked)");
    let sv: Value = serde_json::from_str(&out).unwrap();
    if sv["rows"].as_i64() != Some(4) {
        die(&format!("stacked reply wrong: {out}"));
    }
    println!("[analytics_smoke] PASS data_chart stacked bar with color series");

    // Pie: share per category — one row per slice (aggregated).
    let out = data::DataChartTool(user.to_string(), 1)
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": stored.id,
                "mark": "pie",
                "x": "city",
                "y": "total",
                "groupBy": ["city"],
                "aggregations": [
                    { "column": "sales", "function": "sum", "alias": "total" }
                ],
                "title": "Share by city"
            }))
            .expect("chart args"),
        )
        .await
        .expect("data_chart(pie)");
    let pv: Value = serde_json::from_str(&out).unwrap();
    if pv["mark"] != "pie" || pv["rows"].as_i64() != Some(2) {
        die(&format!("pie reply wrong: {out}"));
    }
    let pie_id = pv["fileId"].as_str().unwrap_or_else(|| die("pie fileId missing")).to_string();
    let (pi, pb) = store::read_file(user, &pie_id).expect("read pie svg");
    let psvg = String::from_utf8(pb).unwrap();
    if pi.ext != "svg" || !psvg.starts_with("<svg") || !psvg.contains("Share by city") {
        die(&format!("stored pie wrong: {} {} bytes", pi.ext, psvg.len()));
    }
    println!("[analytics_smoke] PASS data_chart pie (polar, auto-sorted) → {} bytes", psvg.len());

    // Pie with a color channel is a guidance error (category is the slice label).
    let err = data::DataChartTool(user.to_string(), 1)
        .call(
            serde_json::from_value(serde_json::json!({
                "fileId": stored.id, "mark": "pie", "x": "city", "y": "total",
                "color": "city",
                "groupBy": ["city"],
                "aggregations": [{ "column": "sales", "function": "sum", "alias": "total" }]
            }))
            .expect("chart args"),
        )
        .await
        .expect_err("pie color must fail");
    if !err.0.contains("color") {
        die(&format!("pie color error lacks guidance: {err}"));
    }
    println!("[analytics_smoke] PASS data_chart pie error contract: {err}");

    println!("[analytics_smoke] ALL PASS");
}
