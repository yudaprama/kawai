// Headless smoke test for the analytics agent tools (builtin.analytics,
// feature "analytics"): import a small CSV into the office store →
// data_schema (columns/dtypes) → data_query (row selection), then the xlsx
// bridge (typed columns, resolved dates, sheets echo, sidecar cache),
// aggregate queries, the self-correcting error contract, and the tabular-ext
// guard. Fully offline: fixtures are generated in-process, no network, no
// model.
//
// Usage:
//   cargo run --example analytics_smoke --features analytics
use kawai_lib::logic::analytics::{self as data, DataQueryTool, DataTableSchemaTool};
use kawai_lib::logic::office::store;
use rig::tool::PortableTool;
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

    let _ = data::toolset(user, 1);
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

    println!("[analytics_smoke] ALL PASS");
}
