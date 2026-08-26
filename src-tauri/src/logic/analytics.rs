//! Data analysis agent tools (`builtin.analytics`): structured queries over
//! the user's stored tabular files (csv, tsv, parquet, xlsx/xlsm), a
//! technical-analysis suite over their numeric column series, and svg chart
//! rendering of query results (saved into the office store).
//!
//! Thin `AgentTool` wrappers — ALL query logic lives in the
//! `analytics` crate (pure functions over a path); these structs only bind
//! the server-side user id, resolve file ids through the office store, and
//! push the CPU-bound work onto the blocking pool. Same layering as
//! `KnowledgeSearchTool`: the model can never supply a user id or escape
//! its own store.

use std::fmt;

use kawai_tools::AgentTool;
use serde::Deserialize;
use serde_json::{json, Value};

use super::office::store;

/// Error type for every tool here. One string — the agent loop feeds it
/// back to the model verbatim as the tool result.
#[derive(Debug)]
pub struct DataToolError(pub String);

impl fmt::Display for DataToolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DataToolError {}

fn derr(e: analytics::ToolError) -> DataToolError {
    DataToolError(e.0)
}

/// Tabular extensions the data tools accept (everything else gets a
/// guidance error naming the supported set).
const TABULAR_EXTS: [&str; 5] = ["csv", "tsv", "parquet", "xlsx", "xlsm"];

fn resolve_tabular(
    user_id: &str,
    file_id: &str,
) -> Result<std::path::PathBuf, analytics::ToolError> {
    let (path, info) = store::resolve(user_id, file_id).map_err(analytics::ToolError)?;
    let ext = info.ext.to_ascii_lowercase();
    if !TABULAR_EXTS.contains(&ext.as_str()) {
        return Err(analytics::ToolError(format!(
            "file {file_id} is .{ext} — data tools accept {}",
            TABULAR_EXTS.join(", ")
        )));
    }
    Ok(path)
}

/// CPU-bound polars work never runs on the async runtime threads.
async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, analytics::ToolError> + Send + 'static,
) -> Result<T, DataToolError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| DataToolError(format!("join: {e}")))?
        .map_err(derr)
}

// -- data_schema ---------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaArgs {
    pub file_id: String,
    pub sheet: Option<String>,
}

/// REQUIRED before the first data_query on a file. Returns column names,
/// dtypes, sample values and (for Excel) the sheet list.
pub struct DataTableSchemaTool(pub String);

impl AgentTool for DataTableSchemaTool {
    const NAME: &'static str = "data_schema";
    type Args = SchemaArgs;
    type Output = String;
    type Error = DataToolError;

    fn description(&self) -> String {
        "REQUIRED before the first data_query on a file. Returns the column names, data types, sample values and row count of a stored tabular file (csv/parquet/Excel), plus the sheet names for Excel files.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files or the attachment block" },
                "sheet": { "type": "string", "description": "Excel sheet name. Optional — defaults to the first sheet with data." }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, DataToolError> {
        let user = self.0.clone();
        run_blocking(move || {
            let path = resolve_tabular(&user, &args.file_id)?;
            let info = analytics::discover(&path, args.sheet.as_deref())?;
            serde_json::to_string(&info)
                .map_err(|e| analytics::ToolError(format!("serialize failed: {e}")))
        })
        .await
    }
}

// -- data_query ----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryArgs {
    pub file_id: String,
    pub sheet: Option<String>,
    #[serde(flatten)]
    pub q: analytics::QueryArgs,
}

/// Structured query over one stored tabular file: filters → group_by →
/// aggregations → sort → limit (or plain row selection). Numeric/date
/// filter values are always strings — parsed to the column's real type.
pub struct DataQueryTool(pub String);

impl AgentTool for DataQueryTool {
    const NAME: &'static str = "data_query";
    type Args = QueryArgs;
    type Output = String;
    type Error = DataToolError;

    fn description(&self) -> String {
        "Run a structured query on a stored tabular file (csv/parquet/Excel): filter rows, optionally group, aggregate (sum/avg/min/max/count/count_distinct), sort, and limit. Call data_schema first to learn the columns.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files or the attachment block" },
                "sheet": { "type": "string", "description": "Excel sheet name. Optional — defaults to the first sheet with data." },
                "columns": {
                    "type": "array", "items": { "type": "string" },
                    "description": "Row-selection mode: columns to return without aggregation. Omit when using aggregations."
                },
                "filters": {
                    "type": "array",
                    "description": "WHERE conditions, AND-combined.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string" },
                            "operator": { "type": "string", "enum": ["eq","neq","gt","gte","lt","lte","contains","in"] },
                            "value": { "type": "string", "description": "Always a string; parsed to the column's real type (\"1500\", \"2026-01-31\", \"true\"). For operator \"in\": a comma-separated list (\"laptop, mouse\")." },
                            "datePart": { "type": "string", "enum": ["year","month","day"], "description": "Compare a calendar part of a date/datetime column instead of the raw value — e.g. January = {column: tanggal, operator: eq, value: \"1\", datePart: month}. Value must be an integer string." }
                        },
                        "required": ["column","operator","value"]
                    }
                },
                "groupBy": {
                    "type": "array", "items": { "type": "string" },
                    "description": "Columns to group by. With no aggregations this returns row_count per group."
                },
                "aggregations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string" },
                            "function": { "type": "string", "enum": ["sum","avg","min","max","count","count_distinct"] },
                            "alias": { "type": "string" }
                        },
                        "required": ["column","function","alias"]
                    }
                },
                "having": {
                    "type": "array",
                    "description": "Post-aggregation filter over the OUTPUT (aggregate mode only): columns are group_by keys or aggregation aliases (incl. implicit row_count). Same shape as filters; contains/datePart not supported.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string" },
                            "operator": { "type": "string", "enum": ["eq","neq","gt","gte","lt","lte","in"] },
                            "value": { "type": "string", "description": "Always a string; parsed to the output column's type." }
                        },
                        "required": ["column","operator","value"]
                    }
                },
                "sortBy": { "type": "string", "description": "Output column to sort by (a group_by column or an aggregation alias; in row mode any column)." },
                "descending": { "type": "boolean", "description": "Default false." },
                "limit": { "type": "integer", "description": "Max rows returned. Default 10, max 100." },
                "offset": { "type": "integer", "description": "Rows to skip AFTER sorting — paginate with offset+limit (page 2 of 10-row pages = offset 10). Default 0." }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, DataToolError> {
        let user = self.0.clone();
        run_blocking(move || {
            let path = resolve_tabular(&user, &args.file_id)?;
            analytics::query(&path, args.sheet.as_deref(), args.q)
        })
        .await
    }
}

// -- data_ta -------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaToolArgs {
    pub file_id: String,
    pub sheet: Option<String>,
    #[serde(flatten)]
    pub ta: analytics::ta_suite::TaArgs,
}

/// Technical-analysis indicators over an ordered numeric series in one
/// stored tabular file. The crate returns only the FINAL value per
/// indicator (plus warm-up skips), so output stays small regardless of row
/// count — same contract as `binance_ta_analyze`, but the series comes from
/// any stored csv/tsv/parquet/xlsx column instead of Binance klines.
pub struct DataTaTool(pub String);

impl AgentTool for DataTaTool {
    const NAME: &'static str = "data_ta";
    type Args = TaToolArgs;
    type Output = String;
    type Error = DataToolError;

    fn description(&self) -> String {
        "Compute technical-analysis indicators (EMA/SMA/WMA, RSI, MACD, PPO, Bollinger, Keltner, ChandelierExit, ATR, TrueRange, CCI, stochastic, MFI, OBV, ROC, SD, MAD, ER, rolling max/min) over a numeric time series in a stored tabular file (csv/parquet/Excel). Indicators are stateful — rows are folded in order, so pass \"timestamp\" (a date/datetime/epoch column to sort ascending by) unless rows are already ordered. Returns only each indicator's final value plus skip reasons; call data_schema first to learn the columns.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files or the attachment block" },
                "sheet": { "type": "string", "description": "Excel sheet name. Optional — defaults to the first sheet with data." },
                "timestamp": { "type": "string", "description": "Column to sort ascending by before folding (recommended: your date/time column). Without it, file row order is used as-is." },
                "close": { "type": "string", "description": "Required. Numeric input column for close-only indicators." },
                "high": { "type": "string", "description": "High-price column. Required when using atr/tr/cci/stoch/kc/ce/mfi." },
                "low": { "type": "string", "description": "Low-price column. Required when using atr/tr/cci/stoch/kc/ce/mfi." },
                "volume": { "type": "string", "description": "Volume column. Required when using obv/mfi." },
                "indicators": {
                    "type": "array",
                    "minItems": 1,
                    "description": "Indicators to compute over the series.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": { "type": "string", "enum": ["ema","sma","wma","rsi","roc","sd","mad","er","max","min","macd","ppo","bb","atr","tr","cci","stoch","stoch_slow","kc","ce","obv","mfi"] },
                            "column": { "type": "string", "description": "Input column override for close-only kinds; defaults to close." },
                            "period": { "type": "integer", "description": "Window period. Defaults per kind (ema 9, sma 9, wma 9, rsi 14, roc 9, sd 20, mad 9, er 14, max/min 14, bb 20, atr 14, cci 20, stoch 14, stoch_slow 14, kc 10, ce 22)." },
                            "fast": { "type": "integer", "description": "macd/ppo fast period (default 12). Must be < slow." },
                            "slow": { "type": "integer", "description": "macd/ppo slow period (default 26)." },
                            "signal": { "type": "integer", "description": "macd/ppo signal EMA period (default 9); stoch_slow smoothing EMA (default 3)." },
                            "multiplier": { "type": "number", "description": "bb/kc band width and ce distance (defaults 2.0, 2.0, 3.0)." },
                            "alias": { "type": "string", "description": "Output key override; defaults like rsi14, macd12_26_9, bb20_2." }
                        },
                        "required": ["kind"]
                    }
                }
            },
            "required": ["fileId", "close", "indicators"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, DataToolError> {
        let user = self.0.clone();
        run_blocking(move || {
            let path = resolve_tabular(&user, &args.file_id)?;
            analytics::ta_suite::analyze(&path, args.sheet.as_deref(), args.ta)
        })
        .await
    }
}

/// Re-exported so the transport wrappers can name the preview's return type.
pub use analytics::SchemaInfo;

// -- data_chart ----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartToolArgs {
    pub file_id: String,
    pub sheet: Option<String>,
    #[serde(flatten)]
    pub q: analytics::QueryArgs,
    pub mark: analytics::chart::ChartMark,
    pub x: String,
    pub y: Option<String>,
    pub color: Option<String>,
    pub stack: Option<analytics::chart::StackMode>,
    pub x_scale: Option<analytics::chart::XScale>,
    pub y_scale: Option<analytics::chart::YScale>,
    pub title: Option<String>,
}

/// Render one chart from a stored tabular file and save it into the office
/// store as an svg (associated with the session, so the preview bridge can
/// render it inline). The data pipeline is the same `data_query` AST —
/// filters/aggregations shape the DataFrame; `mark`/`x`/`y`/`color` map it
/// onto the chart.
pub struct DataChartTool(pub String, pub i64);

impl AgentTool for DataChartTool {
    const NAME: &'static str = "data_chart";
    type Args = ChartToolArgs;
    type Output = String;
    type Error = DataToolError;

    fn description(&self) -> String {
        "Render a chart (bar/line/point/area/histogram/pie) from a stored tabular file and save it as an svg the user sees rendered. Takes the same filters/groupBy/aggregations/sortBy as data_query, plus mark, x (category/time column; numeric for histogram), y (numeric column or aggregation alias — omit for histogram, which counts rows itself), optional color (grouping column — omit for pie), stack (bar/area composition of color series), xScale (temporal — parse x as ISO dates and space proportionally; line/area/point/bar only), yScale (log — y must be >0) and title. x and y must appear in the query result — for aggregates use the group_by column as x and the aggregation alias as y. Pie: one row per category (aggregate with groupBy + sum first; ≤20 slices), largest slice sorted first; single-series bar slices are auto-sorted descending by y when no sortBy is given. Charts plot at most 2000 rows — aggregate or filter long series first.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files or the attachment block" },
                "sheet": { "type": "string", "description": "Excel sheet name. Optional — defaults to the first sheet with data." },
                "mark": { "type": "string", "enum": ["bar","line","point","area","histogram","pie"], "description": "bar: category comparisons (auto-sorted descending by y when single-series and no sortBy); line: trends over time; point: relationships; area: cumulative volume; histogram: distribution of one numeric column (omit y — row counts are computed); pie: share of a total per category (aggregate with groupBy + sum first; ≤20 slices; largest slice sorted first)." },
                "x": { "type": "string", "description": "Horizontal-axis column in the query result (category, label, or date; numeric for histogram)." },
                "y": { "type": "string", "description": "Vertical-axis NUMERIC column in the query result — often an aggregation alias (e.g. \"total\" from sum). OMIT for histogram; REQUIRED for pie (the slice value)." },
                "color": { "type": "string", "description": "Optional grouping column — draws one series per distinct value. Omit for pie (category x is the slice label)." },
                "stack": { "type": "string", "enum": ["stacked","normalized","grouped"], "description": "How bar/area composes the color series: stacked (cumulative), normalized (100% share), grouped (side by side). Needs color." },
                "xScale": { "type": "string", "enum": ["temporal"], "description": "Set to \"temporal\" to parse x as ISO dates (YYYY-MM-DD) and space proportionally; implies chronological sort. Line/point/area/bar only." },
                "yScale": { "type": "string", "enum": ["log"], "description": "Set to \"log\" for logarithmic y (all y values must be >0); useful for skewed distributions." },
                "title": { "type": "string", "description": "Chart title. Optional — defaults to \"<y> by <x>\" (\"distribution of <x>\" for histogram)." },
                "filters": {
                    "type": "array",
                    "description": "WHERE conditions, AND-combined (same as data_query).",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string" },
                            "operator": { "type": "string", "enum": ["eq","neq","gt","gte","lt","lte","contains"] },
                            "value": { "type": "string" },
                            "datePart": { "type": "string", "enum": ["year","month","day"] }
                        },
                        "required": ["column","operator","value"]
                    }
                },
                "groupBy": { "type": "array", "items": { "type": "string" }, "description": "Columns to group by (same as data_query)." },
                "aggregations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string" },
                            "function": { "type": "string", "enum": ["sum","avg","min","max","count","count_distinct"] },
                            "alias": { "type": "string" }
                        },
                        "required": ["column","function","alias"]
                    }
                },
                "sortBy": { "type": "string", "description": "Output column to sort by." },
                "descending": { "type": "boolean", "description": "Default false." },
                "limit": { "type": "integer", "description": "Max rows plotted. Default 500, max 2000." }
            },
            "required": ["fileId", "mark", "x"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, DataToolError> {
        let user = self.0.clone();
        let x_col = args.x.clone();
        let mark = match args.mark {
            analytics::chart::ChartMark::Bar => "bar",
            analytics::chart::ChartMark::Line => "line",
            analytics::chart::ChartMark::Point => "point",
            analytics::chart::ChartMark::Area => "area",
            analytics::chart::ChartMark::Histogram => "histogram",
            analytics::chart::ChartMark::Pie => "pie",
        };
        let name = chart_file_name(args.title.as_deref(), args.y.as_deref(), &args.x);
        let rendered = run_blocking(move || {
            let path = resolve_tabular(&user, &args.file_id)?;
            let spec = analytics::chart::ChartSpec {
                mark: args.mark,
                x: args.x,
                y: args.y,
                color: args.color,
                stack: args.stack,
                x_scale: args.x_scale,
                y_scale: args.y_scale,
                title: args.title,
            };
            analytics::chart::render(&path, args.sheet.as_deref(), &args.q, &spec)
        })
        .await?;
        let file = store::import_bytes(&self.0, &name, rendered.svg.as_bytes())
            .map_err(DataToolError)?;
        if let Err(e) =
            super::rag::knowledge_add_to_session(&self.0, self.1, &[file.id.clone()]).await
        {
            eprintln!("[analytics] session association skipped: {e}");
        }
        Ok(json!({
            "fileId": file.id,
            "fileName": file.original_name,
            "mark": mark,
            "x": x_col,
            "rows": rendered.rows,
            "note": "chart saved as svg — the user sees it rendered; explain the key takeaways in your final answer",
        })
        .to_string())
    }
}

/// Timestamped store name: re-rendering the same chart creates a fresh file
/// instead of colliding with the previous one.
fn chart_file_name(title: Option<&str>, y: Option<&str>, x: &str) -> String {
    let base = title.map(str::to_string).unwrap_or_else(|| match y {
        Some(y) => format!("{y} by {x}"),
        None => format!("distribution of {x}"),
    });
    let slug: String = base
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let bounded: String = slug.chars().take(40).collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("chart-{bounded}-{ts}.svg")
}

/// Schema preview for the Knowledge panel: the same discovery the
/// `data_schema` tool runs (columns, dtypes, samples, row count), minus the
/// agent-loop indirection. Excel files preview their first sheet with data.
pub async fn data_preview(user_id: &str, file_id: &str) -> Result<SchemaInfo, String> {
    let user = user_id.to_string();
    let fid = file_id.to_string();
    run_blocking(move || {
        let path = resolve_tabular(&user, &fid)?;
        analytics::discover(&path, None)
    })
    .await
    .map_err(|e| e.to_string())
}

// ── SQL sources: named-profile snapshots ────────────────────────────────────
//
// Credential pattern copied from `crates/binance/src/account.rs`:
// credentials live in the environment, NEVER in model-supplied arguments.
// The user configures one env var per source (`KAWAI_SQL_PROFILE_<NAME>` =
// local SQLite path / `sqlite:` URL); the model only ever sees and passes
// back the NAME. An unknown name is an error listing the valid ones — host/
// path selection is structurally out of the model's reach. The tools
// REGISTER only when ≥1 profile exists (capability probe, like the binance
// account tools and the web-read engines), so without configuration the
// model never even sees them.
//
// v1 scope: local SQLite via the existing libsql dep (fully offline,
// unit-testable). External Postgres/MySQL via sqlx stays deferred — see
// PLAN-analytics-agent.md Phase 4.

use libsql::Value as SqlValue;

/// Env-var prefix for user-configured database sources.
pub const PROFILE_ENV_PREFIX: &str = "KAWAI_SQL_PROFILE_";

/// Hard cap on rows per snapshot — the dump runs as a synchronous agent-tool
/// call and must stay bounded. Override with `KAWAI_SQL_MAX_ROWS`.
const DEFAULT_MAX_ROWS: usize = 100_000;

fn max_rows() -> usize {
    std::env::var("KAWAI_SQL_MAX_ROWS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_MAX_ROWS)
}

/// One saved data source, as shown in the settings UI. Also the unit baked
/// into the SQL tools per turn — the model can only ever reach sources from
/// this set.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlProfile {
    pub name: String,
    pub source: String,
}

/// All configured profiles for ONE user, sorted by name. Two sources merge
/// here: the per-user DB table (managed by the in-app Settings UI via
/// [`sql_profile_save`] / [`sql_profile_delete`]) and env vars — env wins on
/// a name clash so ops can always override. Fetched per turn and baked into
/// the SQL tool constructors (see [`toolset`]); there is deliberately NO
/// process-global cache, so one user's turn can never resolve another
/// user's sources in multi-user web mode. A DB error degrades to env-only
/// (same failure shape the old cache had, minus the staleness).
pub async fn effective_profiles(user_id: &str) -> Vec<SqlProfile> {
    let mut out: Vec<SqlProfile> = std::env::vars()
        .filter_map(|(k, v)| {
            k.strip_prefix(PROFILE_ENV_PREFIX)
                .filter(|_| !v.trim().is_empty())
                .map(|name| SqlProfile {
                    name: name.to_ascii_lowercase(),
                    source: v,
                })
        })
        .collect();
    if let Ok(list) = sql_profile_list(user_id).await {
        for p in list {
            if !out.iter().any(|e| e.name == p.name) {
                out.push(p);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// List the user's saved data sources (DB rows only — env profiles are ops
/// overrides, not user data).
pub async fn sql_profile_list(user_id: &str) -> Result<Vec<SqlProfile>, String> {
    let conn = crate::logic::db_connection(user_id).await.map_err(|e| e.to_string())?;
    let mut rows = conn
        .query("SELECT name, source FROM sql_profiles ORDER BY name", libsql::params![])
        .await
        .map_err(|e| format!("sql_profiles: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("sql_profiles row: {e}"))? {
        let name = val_text(row.get_value(0).map_err(|e| format!("{e}"))?).unwrap_or_default();
        let source = val_text(row.get_value(1).map_err(|e| format!("{e}"))?).unwrap_or_default();
        out.push(SqlProfile { name, source });
    }
    Ok(out)
}

/// Normalize a profile name: lowercase, `[a-z0-9_-]`, ≤32 chars.
fn normalize_profile_name(name: &str) -> Result<String, String> {
    let n = name.trim().to_ascii_lowercase();
    if n.is_empty() || n.len() > 32 {
        return Err("profile name must be 1–32 characters".into());
    }
    if !n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') {
        return Err(
            "profile name may only contain lowercase letters, digits, '-' and '_'".into(),
        );
    }
    Ok(n)
}

/// Validate a source string: a local SQLite path / `sqlite:` URL whose file
/// must exist right now, or a remote Postgres/MySQL URL (existence is only
/// checkable at connect time). Remote URLs require the `analytics-sql`
/// feature — saving still works without it so users can stage profiles
/// before switching builds.
fn validate_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if s.is_empty() || s.len() > 1024 {
        return Err("source must be a non-empty path or URL (max 1024 chars)".into());
    }
    if looks_remote(s) {
        return Ok(s.to_string());
    }    let path = sqlite_path(s);
    let path_str = path.as_os_str().to_string_lossy();
    if path_str.contains("://") && !s.starts_with("sqlite:") {
        return Err(format!(
            "unsupported scheme: only sqlite paths and postgres://mysql:// URLs are accepted (got {s})"
        ));
    }
    if !path.is_file() {
        return Err(format!("database file not found: {}", path.display()));
    }
    Ok(s.to_string())
}

/// Save (insert or update) one named data source for this user.
pub async fn sql_profile_save(user_id: &str, name: &str, source: &str) -> Result<SqlProfile, String> {
    let name = normalize_profile_name(name)?;
    let source = validate_source(source)?;
    let conn = crate::logic::db_connection(user_id).await.map_err(|e| e.to_string())?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO sql_profiles (name, source, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET source = excluded.source",
        libsql::params![name.clone(), source.clone(), created_at],
    )
    .await
    .map_err(|e| format!("save profile: {e}"))?;
    // No cache to refresh — the next agent turn fetches effective_profiles
    // fresh, so the new source registers its tools on that turn.
    Ok(SqlProfile { name, source })
}

/// Delete one named data source. Unknown names are fine (idempotent).
pub async fn sql_profile_delete(user_id: &str, name: &str) -> Result<(), String> {
    let name = normalize_profile_name(name)?;
    let conn = crate::logic::db_connection(user_id).await.map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sql_profiles WHERE name = ?", libsql::params![name])
        .await
        .map_err(|e| format!("delete profile: {e}"))?;
    Ok(())
}

/// Capability probe for the settings UI: whether any source is configured
/// at all (env + this user's saved rows).
pub async fn has_any_profile(user_id: &str) -> bool {
    !effective_profiles(user_id).await.is_empty()
}

/// Result of a `sql_profile_test` probe, as shown in the settings UI.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlProfileTest {
    pub ok: bool,
    /// "sqlite" | "remote" | "unknown" — how the source was reached.
    pub engine: String,
    pub tables: usize,
    /// First few table names, for a quick glance in the UI.
    pub sample: Vec<String>,
    /// Failure reason when `ok` is false.
    pub error: Option<String>,
}

/// Probe one saved data source: open a connection and list its tables. The
/// RPC itself never fails on a bad source — connection problems come back as
/// `ok: false` so the UI can render the reason inline.
pub async fn sql_profile_test(user_id: &str, name: &str) -> Result<SqlProfileTest, String> {
    fn fail(engine: &str, error: String) -> SqlProfileTest {
        SqlProfileTest {
            ok: false,
            engine: engine.to_string(),
            tables: 0,
            sample: Vec::new(),
            error: Some(error),
        }
    }

    let name = normalize_profile_name(name)?;
    let profiles = effective_profiles(user_id).await;
    let src = match profile_value(&profiles, &name) {
        Ok(v) => v,
        Err(e) => return Ok(fail("unknown", e.0)),
    };
    let (engine, items) = if looks_remote(&src) {
        #[cfg(feature = "analytics-sql")]
        {
            match super::sql_remote::list_objects(&src)
                .await
                .map_err(|e| fail("remote", e))
            {
                Ok(items) => ("remote", items),
                Err(res) => return Ok(res),
            }
        }
        #[cfg(not(feature = "analytics-sql"))]
        {
            return Ok(fail(
                "remote",
                "remote SQL sources (postgres://mysql://) need a build with the \
                 analytics-sql feature"
                    .into(),
            ));
        }
    } else {
        let conn = match open_sqlite_source(&src).await {
            Ok(c) => c,
            Err(e) => return Ok(fail("sqlite", e.0)),
        };
        match list_objects(&conn).await {
            Ok(items) => ("sqlite", items),
            Err(e) => return Ok(fail("sqlite", e.0)),
        }
    };
    Ok(SqlProfileTest {
        ok: true,
        engine: engine.to_string(),
        tables: items.len(),
        sample: items.iter().take(5).map(|(n, _)| n.clone()).collect(),
        error: None,
    })
}

/// Resolve one profile by name (case-insensitive) against the caller-baked
/// set — the ONLY path from a model-supplied profile name to a connection
/// source. Unknown names error with the valid list so the turn self-corrects.
fn profile_value<'a>(profiles: &'a [SqlProfile], name: &str) -> Result<&'a str, analytics::ToolError> {
    let lower = name.to_ascii_lowercase();
    profiles
        .iter()
        .find(|p| p.name == lower)
        .map(|p| p.source.as_str())
        .ok_or_else(|| {
            let list = if profiles.is_empty() {
                "(none — configure KAWAI_SQL_PROFILE_<NAME> in .env)".to_string()
            } else {
                profiles
                    .iter()
                    .map(|p| p.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            analytics::ToolError(format!(
                "unknown SQL profile {name:?}; configured profiles: {list}"
            ))
        })
}

/// Profile value → local SQLite path (`sqlite:` URL forms accepted).
fn sqlite_path(value: &str) -> std::path::PathBuf {
    let v = value.trim();
    let v = v
        .strip_prefix("sqlite://")
        .or_else(|| v.strip_prefix("sqlite:"))
        .unwrap_or(v);
    std::path::PathBuf::from(v)
}

/// Scheme-only remote detection, compiled regardless of the `analytics-sql`
/// feature so remote profiles can be saved on any build; the TOOLS then
/// error with a rebuild hint when the feature is missing.
fn looks_remote(source: &str) -> bool {
    let s = source.trim().to_ascii_lowercase();
    ["postgres://", "postgresql://", "mysql://", "mariadb://"]
        .iter()
        .any(|p| s.starts_with(p))
}

async fn open_sqlite_source(src: &str) -> Result<libsql::Connection, analytics::ToolError> {
    let path = sqlite_path(src);
    if !path.is_file() {
        return Err(analytics::ToolError(format!(
            "database file not found: {}",
            path.display()
        )));
    }
    let db = libsql::Builder::new_local(&path)
        .build()
        .await
        .map_err(|e| analytics::ToolError(format!("open {}: {e}", path.display())))?;
    db.connect()
        .map_err(|e| analytics::ToolError(format!("connect {}: {e}", path.display())))
}

/// Quote an identifier for embedding in SQL TEXT (PRAGMA / SELECT). Only
/// ever called on names that were first verified against `sqlite_master`
/// via a bound parameter — interpolation happens after validation, with
/// embedded quotes escaped.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn sql_err(context: &str, e: impl std::fmt::Display) -> analytics::ToolError {
    analytics::ToolError(format!("{context}: {e}"))
}

fn val_text(v: SqlValue) -> Option<String> {
    match v {
        SqlValue::Text(s) => Some(s),
        _ => None,
    }
}

async fn list_objects(
    conn: &libsql::Connection,
) -> Result<Vec<(String, String)>, analytics::ToolError> {
    let mut rows = conn
        .query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            libsql::params![],
        )
        .await
        .map_err(|e| sql_err("listing tables failed", e))?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| sql_err("table listing", e))? {
        let name = val_text(row.get_value(0).map_err(|e| sql_err("row", e))?).unwrap_or_default();
        let kind = val_text(row.get_value(1).map_err(|e| sql_err("row", e))?)
            .unwrap_or_else(|| "table".into());
        items.push((name, kind));
    }
    Ok(items)
}

// -- data_tables ---------------------------------------------------------------

#[derive(Deserialize)]
pub struct SqlTablesArgs {
    pub profile: String,
}

/// List the tables/views of one configured SQL source. The baked profile set
/// is captured at turn start for the CALLING user — the model can only ever
/// list sources from it, never another user's.
pub struct DataTablesTool(pub std::sync::Arc<Vec<SqlProfile>>);

impl AgentTool for DataTablesTool {
    const NAME: &'static str = "data_tables";
    type Args = SqlTablesArgs;
    type Output = String;
    type Error = DataToolError;

    fn description(&self) -> String {
        "List the tables and views of a pre-configured SQL database (SQLite) by profile name. Profiles are configured server-side by the user — you can only reference them by name.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "profile": { "type": "string", "description": "Configured database profile name (from KAWAI_SQL_PROFILE_<NAME>)" }
            },
            "required": ["profile"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, DataToolError> {
        let src = profile_value(&self.0, &args.profile).map_err(derr)?;
        let items = if looks_remote(&src) {
            #[cfg(feature = "analytics-sql")]
            {
                super::sql_remote::list_objects(&src)
                    .await
                    .map_err(|e| DataToolError(e))?
            }
            #[cfg(not(feature = "analytics-sql"))]
            return Err(derr(analytics::ToolError(
                "remote SQL sources (postgres://mysql://) need a build with the \
                 analytics-sql feature"
                    .into(),
            )));
        } else {
            let conn = open_sqlite_source(&src).await.map_err(derr)?;
            list_objects(&conn).await.map_err(derr)?
        };
        let tables: Vec<Value> = items
            .into_iter()
            .map(|(name, kind)| json!({ "name": name, "kind": kind }))
            .collect();
        Ok(json!({ "profile": args.profile, "tables": tables }).to_string())
    }
}

// -- data_import ---------------------------------------------------------------

#[derive(Deserialize)]
pub struct SqlImportArgs {
    pub profile: String,
    pub table: String,
}

/// Snapshot one SQL table/view into a typed parquet file in the office store
/// and associate it with the current session, so `data_schema`/`data_query`
/// take over from there. The SOURCE DATABASE IS NEVER WRITTEN — this is a
/// read-only dump behind a validated identifier, a hard row cap, and the
/// per-turn baked profile set (user-scoped: only the calling user's sources
/// are resolvable).
pub struct DataImportTool(
    pub String,
    pub i64,
    pub std::sync::Arc<Vec<SqlProfile>>,
);

/// Convert raw libsql rows to the crate's neutral cell type and serialize a
/// typed parquet snapshot. BLOB columns are a guidance error (they have no
/// faithful scalar representation in this pipeline). ALL polars knowledge
/// lives in the crate — this is only value mapping.
fn build_parquet_bytes(
    columns: &[String],
    rows: &[Vec<SqlValue>],
) -> Result<(Vec<u8>, usize), analytics::ToolError> {
    for (ci, name) in columns.iter().enumerate() {
        if rows.iter().any(|r| matches!(r[ci], SqlValue::Blob(_))) {
            return Err(analytics::ToolError(format!(
                "column {name:?} holds BLOB values — snapshot export supports scalar types only"
            )));
        }
    }
    let mapped: Vec<Vec<analytics::RawCell>> = rows
        .iter()
        .map(|r| {
            r.iter()
                .map(|v| match v {
                    SqlValue::Null => analytics::RawCell::Null,
                    SqlValue::Integer(i) => analytics::RawCell::Int(*i),
                    SqlValue::Real(f) => analytics::RawCell::Float(*f),
                    SqlValue::Text(t) => analytics::RawCell::Text(t.clone()),
                    SqlValue::Blob(_) => unreachable!("rejected above"),
                })
                .collect()
        })
        .collect();
    analytics::rows_to_parquet(columns, &mapped)
}

impl AgentTool for DataImportTool {
    const NAME: &'static str = "data_import";
    type Args = SqlImportArgs;
    type Output = String;
    type Error = DataToolError;

    fn description(&self) -> String {
        "Snapshot ONE table (or view) of a pre-configured SQL database into a local parquet file you can then inspect with data_schema and query with data_query. Read-only: the source database is never modified. State which profile/table you will import and get user confirmation first.".into()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "profile": { "type": "string", "description": "Configured database profile name (from KAWAI_SQL_PROFILE_<NAME>)" },
                "table": { "type": "string", "description": "Exact table or view name as listed by data_tables" }
            },
            "required": ["profile", "table"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, DataToolError> {
        let user = self.0.clone();
        let session_id = self.1;
        let cap = max_rows();
        let src = profile_value(&self.2, &args.profile).map_err(derr)?.to_string();

        // ── remote (Postgres/MySQL) branch ────────────────────────────────
        if looks_remote(&src) {
            #[cfg(feature = "analytics-sql")]
            {
                let known = super::sql_remote::list_objects(&src)
                    .await
                    .map_err(|e| DataToolError(e))?;
                if !known.iter().any(|(n, _)| n == &args.table) {
                    return Err(derr(analytics::ToolError(format!(
                        "no table or view named {:?}; available: {}",
                        args.table,
                        if known.is_empty() {
                            "(none)".into()
                        } else {
                            known.into_iter().map(|(n, _)| n).collect::<Vec<_>>().join(", ")
                        }
                    ))));
                }
                // cap+1 fetch → truncation is exact.
                let (columns, mut cells) =
                    super::sql_remote::dump_rows(&src, &args.table, cap).await.map_err(|e| DataToolError(e))?;
                let truncated = cells.len() > cap;
                if truncated {
                    cells.truncate(cap);
                }
                let exported_at = unix_now_secs();
                let (bytes, rows) = run_blocking(move || {
                    analytics::rows_to_parquet(&columns, &cells)
                })
                .await?;
                return persist_and_reply(
                    &user, session_id, &args.profile, &args.table,
                    bytes, rows, truncated, cap, exported_at,
                )
                .await;
            }
            #[cfg(not(feature = "analytics-sql"))]
            return Err(derr(analytics::ToolError(
                "remote SQL sources (postgres://mysql://) need a build with the \
                 analytics-sql feature"
                    .into(),
            )));
        }

        // ── local SQLite branch ───────────────────────────────────────────
        let conn = open_sqlite_source(&src).await.map_err(derr)?;

        // Validate the identifier against the catalog via a BOUND PARAMETER
        // before any quoting happens.
        let mut hit = conn
            .query(
                "SELECT type FROM sqlite_master WHERE name = ?1 AND type IN ('table','view')",
                libsql::params![args.table.clone()],
            )
            .await
            .map_err(|e| derr(sql_err("lookup failed", e)))?;
        if hit
            .next()
            .await
            .map_err(|e| derr(sql_err("lookup", e)))?
            .is_none()
        {
            let known = list_objects(&conn)
                .await
                .map(|items| {
                    items
                        .into_iter()
                        .map(|(n, _)| n)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            return Err(derr(analytics::ToolError(format!(
                "no table or view named {:?}; available: {}",
                args.table,
                if known.is_empty() {
                    "(none)".into()
                } else {
                    known
                }
            ))));
        }
        drop(hit);

        // Column layout (names keep their exact case/spaces).
        let quoted = quote_ident(&args.table);
        let mut info = conn
            .query(&format!("PRAGMA table_info({quoted})"), libsql::params![])
            .await
            .map_err(|e| derr(sql_err("schema lookup failed", e)))?;
        let mut columns: Vec<String> = Vec::new();
        while let Some(row) = info.next().await.map_err(|e| derr(sql_err("schema", e)))? {
            if let Some(n) = val_text(row.get_value(1).map_err(|e| derr(sql_err("schema", e)))?) {
                columns.push(n);
            }
        }
        drop(info);
        if columns.is_empty() {
            return Err(derr(analytics::ToolError(format!(
                "table {:?} has no columns",
                args.table
            ))));
        }

        // Dump with a hard row cap: fetch cap+1 rows so truncation is exact.
        let limit = cap.saturating_add(1) as i64;
        let mut rows_q = conn
            .query(
                &format!("SELECT * FROM {quoted} LIMIT {limit}"),
                libsql::params![],
            )
            .await
            .map_err(|e| derr(sql_err("read failed", e)))?;
        let mut raw: Vec<Vec<SqlValue>> = Vec::new();
        while let Some(row) = rows_q.next().await.map_err(|e| derr(sql_err("read", e)))? {
            let mut r = Vec::with_capacity(columns.len());
            for ci in 0..columns.len() {
                r.push(
                    row.get_value(ci as i32)
                        .map_err(|e| derr(sql_err("cell", e)))?,
                );
            }
            raw.push(r);
        }
        drop(rows_q);
        let truncated = raw.len() > cap;
        if truncated {
            raw.truncate(cap);
        }
        let exported_at = unix_now_secs();
        let table = args.table.clone();
        let (bytes, rows) = run_blocking(move || build_parquet_bytes(&columns, &raw)).await?;
        persist_and_reply(
            &user, session_id, &args.profile, &table, bytes, rows, truncated, cap, exported_at,
        )
        .await
    }
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Shared tail of both dump branches: write the snapshot into the office
/// store under a timestamped name, associate it with THIS session
/// (best-effort — an association failure must not lose the imported file;
/// office_list_files still finds it), and reply with the handle + stats.
async fn persist_and_reply(
    user: &str,
    session_id: i64,
    profile: &str,
    table: &str,
    bytes: Vec<u8>,
    rows: usize,
    truncated: bool,
    cap: usize,
    exported_at: u64,
) -> Result<String, DataToolError> {
    // Timestamped name: re-importing the same table creates a fresh
    // snapshot instead of colliding with the previous one.
    let name = sanitize_snapshot_name(table, exported_at);
    let file = store::import_bytes(user, &name, &bytes).map_err(DataToolError)?;
    if let Err(e) =
        super::rag::knowledge_add_to_session(user, session_id, &[file.id.clone()]).await
    {
        eprintln!("[analytics] session association skipped: {e}");
    }
    let hint = if truncated {
        format!("TRUNCATED at the {cap}-row cap — analysis covers the FIRST {cap} rows only.")
    } else {
        "complete".to_string()
    };
    Ok(json!({
        "fileId": file.id,
        "fileName": file.original_name,
        "source": { "profile": profile, "table": table },
        "rows": rows,
        "truncated": truncated,
        "maxRows": cap,
        "exportedAtUnix": exported_at,
        "note": hint,
        "nextStep": "run data_schema on fileId, then data_query",
    })
    .to_string())
}

fn sanitize_snapshot_name(table: &str, exported_at_unix: u64) -> String {
    let slug: String = table
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    format!("{slug}-snapshot-{exported_at_unix}.parquet")
}

// ── toolset builder ──────────────────────────────────────────────────────────

/// Build the data analysis ToolSet for one user + session. File ids are
/// resolved through the office store at dispatch — the model only ever sees
/// short alias handles (`doc1`, …). `profiles` is the caller's fetched
/// [`effective_profiles`] snapshot: the SQL snapshot tools ride along only
/// when it is non-empty, and they can resolve ONLY those sources — no shared
/// state exists for another user's turn to leak in (multi-user web mode).
pub fn toolset(
    user_id: &str,
    session_id: i64,
    profiles: &[SqlProfile],
) -> kawai_tools::ToolSet {
    let mut set = kawai_tools::ToolSet::default();
    set.add_tool(DataTableSchemaTool(user_id.to_string()));
    set.add_tool(DataQueryTool(user_id.to_string()));
    set.add_tool(DataTaTool(user_id.to_string()));
    set.add_tool(DataChartTool(user_id.to_string(), session_id));
    // Id discovery: the same list tool the office agent uses.
    set.add_tool(super::office::tools::ListFilesTool(user_id.to_string()));
    if !profiles.is_empty() {
        let baked = std::sync::Arc::new(profiles.to_vec());
        set.add_tool(DataTablesTool(baked.clone()));
        set.add_tool(DataImportTool(user_id.to_string(), session_id, baked));
    }
    set
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    use std::sync::Mutex;

    /// Env vars are process-global — every test that touches profiles or the
    /// row cap takes this lock so parallel tests can't observe each other's
    /// variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvVar(String);
    impl EnvVar {
        fn set(key: &str, value: &str) -> Self {
            // SAFETY-free zone: tests are serialized by ENV_LOCK.
            std::env::set_var(key, value);
            Self(key.to_string())
        }
    }
    impl Drop for EnvVar {
        fn drop(&mut self) {
            std::env::remove_var(&self.0);
        }
    }

    async fn make_db(path: &std::path::Path) {
        let db = libsql::Builder::new_local(path).build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute(
            "CREATE TABLE sales (
                id INTEGER PRIMARY KEY,
                produk TEXT,
                harga REAL,
                qty INTEGER,
                catatan TEXT
            )",
            libsql::params![],
        )
        .await
        .unwrap();
        let rows = [
            ("laptop", 1000.0, 1, Some("promo A")),
            ("mouse", 20.0, 2, None),
            ("laptop", 1500.0, 1, Some("premium")),
            ("monitor", 300.0, 3, None),
            ("mouse", 25.0, 2, Some("bundling")),
        ];
        for (i, (produk, harga, qty, note)) in rows.iter().enumerate() {
            conn.execute(
                "INSERT INTO sales (produk, harga, qty, catatan) VALUES (?, ?, ?, ?)",
                libsql::params![*produk, *harga, *qty as i64, *note],
            )
            .await
            .unwrap();
            let _ = i;
        }
        // A view and an internal table that must NOT be listed.
        conn.execute(
            "CREATE VIEW murah AS SELECT produk, harga FROM sales WHERE harga < 100",
            libsql::params![],
        )
        .await
        .unwrap();
    }

    /// The per-turn snapshot shape the agent loop bakes into the tools.
    fn baked(name: &str, source: &str) -> std::sync::Arc<Vec<SqlProfile>> {
        std::sync::Arc::new(vec![SqlProfile {
            name: name.into(),
            source: source.into(),
        }])
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn data_tables_lists_tables_and_views_rejects_unknown_profile() {
        let dir = tempfile::tempdir().unwrap();
        make_db(dir.path().join("shop.db").as_path()).await;
        let _guard = ENV_LOCK.lock();

        let src = dir.path().join("shop.db").to_str().unwrap().to_string();
        let _env = EnvVar::set("KAWAI_SQL_PROFILE_TESTLIST", &src);
        let profiles = baked("testlist", &src);

        let out = DataTablesTool(profiles.clone())
            .call(SqlTablesArgs {
                profile: "TestList".into(),
            }) // case-insensitive
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let tables: Vec<(String, String)> = v["tables"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                (
                    t["name"].as_str().unwrap().into(),
                    t["kind"].as_str().unwrap().into(),
                )
            })
            .collect();
        assert!(tables.contains(&("sales".into(), "table".into())));
        assert!(tables.contains(&("murah".into(), "view".into())));

        let e = DataTablesTool(profiles)
            .call(SqlTablesArgs {
                profile: "nope".into(),
            })
            .await
            .unwrap_err();
        assert!(e.0.contains("unknown SQL profile"), "{}", e.0);
        assert!(e.0.contains("testlist"), "{}", e.0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn import_e2e_dump_then_discover_then_query() {
        let dir = tempfile::tempdir().unwrap();
        make_db(dir.path().join("shop.db").as_path()).await;
        let _guard = ENV_LOCK.lock();

        let _env = EnvVar::set(
            "KAWAI_SQL_PROFILE_E2E",
            dir.path().join("shop.db").to_str().unwrap(),
        );

        let tool = DataImportTool(
            "demo".into(),
            42,
            baked("e2e", dir.path().join("shop.db").to_str().unwrap()),
        );

        // Unknown table → error lists valid candidates.
        let e = tool
            .call(SqlImportArgs {
                profile: "e2e".into(),
                table: "salez".into(),
            })
            .await
            .unwrap_err();
        assert!(
            e.0.contains("no table or view named") && e.0.contains("sales"),
            "{}",
            e.0
        );

        let out = tool
            .call(SqlImportArgs {
                profile: "e2e".into(),
                table: "sales".into(),
            })
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["rows"], 5);
        assert_eq!(v["truncated"], false);
        let file_id = v["fileId"].as_str().unwrap().to_string();

        // The snapshot landed in the store as a parquet file…
        let (path, info) = store::resolve("demo", &file_id).unwrap();
        assert_eq!(info.ext, "parquet");
        assert!(info.original_name.starts_with("sales-snapshot-"));

        // …associated with the session.
        let conn = crate::logic::db_connection("demo").await.unwrap();
        let sids = super::super::rag::session_file_ids(&conn, 42)
            .await
            .unwrap();
        assert!(sids.contains(&file_id));

        // …typed correctly (INTEGER→integer, REAL→float, NULL-able TEXT→text).
        let sch = analytics::discover(&path, None).unwrap();
        let dtypes: Vec<&str> = sch.columns.iter().map(|c| c.dtype.as_str()).collect();
        assert_eq!(
            dtypes,
            ["integer", "text", "float", "integer", "text"],
            "{sch:?}"
        );

        // …and queryable: sum(harga) over the snapshot matches the DB.
        let out = analytics::query(
            &path,
            None,
            analytics::QueryArgs {
                aggregations: Some(vec![analytics::AggOp {
                    column: "harga".into(),
                    function: "sum".into(),
                    alias: "total".into(),
                }]),
                ..Default::default()
            },
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        let total = parsed["rows"][0]["total"].as_f64().unwrap();
        assert!((total - 2845.0).abs() < 1e-9, "{total}");

        // Group-by works too.
        let out = analytics::query(
            &path,
            None,
            analytics::QueryArgs {
                group_by: Some(vec!["produk".into()]),
                aggregations: Some(vec![analytics::AggOp {
                    column: "harga".into(),
                    function: "sum".into(),
                    alias: "total".into(),
                }]),
                sort_by: Some("total".into()),
                descending: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["rows"][0]["produk"], "laptop");
        assert_eq!(parsed["rows"][0]["total"].as_f64().unwrap(), 2500.0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn import_respects_row_cap_and_reports_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("big.db");
        {
            let db = libsql::Builder::new_local(&db_path).build().await.unwrap();
            let conn = db.connect().unwrap();
            conn.execute("CREATE TABLE t (n INTEGER)", libsql::params![])
                .await
                .unwrap();
            for i in 0..10 {
                conn.execute("INSERT INTO t VALUES (?)", libsql::params![i])
                    .await
                    .unwrap();
            }
        }
        let _guard = ENV_LOCK.lock();
        let _env_profile = EnvVar::set("KAWAI_SQL_PROFILE_CAP", db_path.to_str().unwrap());
        let _env_cap = EnvVar::set("KAWAI_SQL_MAX_ROWS", "4");

        let out = DataImportTool("demo".into(), 1, baked("cap", db_path.to_str().unwrap()))
            .call(SqlImportArgs {
                profile: "cap".into(),
                table: "t".into(),
            })
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["rows"], 4);
        assert_eq!(v["truncated"], true);
        assert_eq!(v["maxRows"], 4);
        assert!(v["note"].as_str().unwrap().contains("TRUNCATED"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn blob_column_is_a_guidance_error() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("blob.db");
        {
            let db = libsql::Builder::new_local(&db_path).build().await.unwrap();
            let conn = db.connect().unwrap();
            conn.execute(
                "CREATE TABLE b (id INTEGER, payload BLOB)",
                libsql::params![],
            )
            .await
            .unwrap();
            conn.execute("INSERT INTO b VALUES (1, X'0102')", libsql::params![])
                .await
                .unwrap();
        }
        let _guard = ENV_LOCK.lock();

        let _env = EnvVar::set("KAWAI_SQL_PROFILE_BLOB", db_path.to_str().unwrap());

        let e = DataImportTool("demo".into(), 1, baked("blob", db_path.to_str().unwrap()))
            .call(SqlImportArgs {
                profile: "blob".into(),
                table: "b".into(),
            })
            .await
            .unwrap_err();
        assert!(e.0.contains("BLOB") && e.0.contains("payload"), "{}", e.0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn mixed_null_and_text_columns_stay_queryable() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("nulls.db");
        {
            let db = libsql::Builder::new_local(&db_path).build().await.unwrap();
            let conn = db.connect().unwrap();
            conn.execute("CREATE TABLE n (a INTEGER, b TEXT)", libsql::params![])
                .await
                .unwrap();
            conn.execute("INSERT INTO n VALUES (NULL, 'x')", libsql::params![])
                .await
                .unwrap();
            conn.execute("INSERT INTO n VALUES (7, NULL)", libsql::params![])
                .await
                .unwrap();
        }
        let _guard = ENV_LOCK.lock();

        let _env = EnvVar::set("KAWAI_SQL_PROFILE_NULLS", db_path.to_str().unwrap());

        let out = DataImportTool("demo".into(), 1, baked("nulls", db_path.to_str().unwrap()))
            .call(SqlImportArgs {
                profile: "nulls".into(),
                table: "n".into(),
            })
            .await
            .unwrap();
        let file_id: String = serde_json::from_str::<Value>(&out).unwrap()["fileId"]
            .as_str()
            .unwrap()
            .into();
        let (path, _) = store::resolve("demo", &file_id).unwrap();
        let sch = analytics::discover(&path, None).unwrap();
        let dtypes: Vec<&str> = sch.columns.iter().map(|c| c.dtype.as_str()).collect();
        assert_eq!(dtypes, ["integer", "text"], "{sch:?}");
        // The null survived as a real null.
        let out = analytics::query(
            &path,
            None,
            analytics::QueryArgs {
                filters: Some(vec![analytics::FilterOp {
                    column: "a".into(),
                    operator: "gte".into(),
                    value: "0".into(),
                    date_part: None,
                }]),
                ..Default::default()
            },
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed["_meta"]["rows_returned"], 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn weird_identifier_names_are_handled_safely() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("weird.db");
        {
            let db = libsql::Builder::new_local(&db_path).build().await.unwrap();
            let conn = db.connect().unwrap();
            conn.execute(
                "CREATE TABLE \"order items\" (\"qty total\" INTEGER)",
                libsql::params![],
            )
            .await
            .unwrap();
            conn.execute("INSERT INTO \"order items\" VALUES (5)", libsql::params![])
                .await
                .unwrap();
        }
        let _guard = ENV_LOCK.lock();

        let _env = EnvVar::set("KAWAI_SQL_PROFILE_WEIRD", db_path.to_str().unwrap());

        let out = DataImportTool("demo".into(), 1, baked("weird", db_path.to_str().unwrap()))
            .call(SqlImportArgs {
                profile: "weird".into(),
                table: "order items".into(),
            })
            .await
            .unwrap();
        let file_id: String = serde_json::from_str::<Value>(&out).unwrap()["fileId"]
            .as_str()
            .unwrap()
            .into();
        let (path, _) = store::resolve("demo", &file_id).unwrap();
        let sch = analytics::discover(&path, None).unwrap();
        assert_eq!(sch.columns[0].name, "qty total");
    }

    /// THE leak regression: profiles saved by one user must never surface in
    /// another user's set (the old process-global cache made a concurrent
    /// turn's refresh visible to everyone in multi-user web mode). Env vars
    /// stay global by design and win a name clash.
    #[tokio::test(flavor = "multi_thread")]
    async fn effective_profiles_are_user_scoped_and_env_wins_clash() {
        let dir = tempfile::tempdir().unwrap();
        for f in ["a.db", "b.db", "env.db"] {
            make_db(dir.path().join(f).as_path()).await;
        }
        let _guard = ENV_LOCK.lock();

        sql_profile_save("scope-a", "private", dir.path().join("a.db").to_str().unwrap())
            .await
            .unwrap();
        let _env = EnvVar::set(
            "KAWAI_SQL_PROFILE_SHARED",
            dir.path().join("env.db").to_str().unwrap(),
        );
        sql_profile_save("scope-b", "shared", dir.path().join("b.db").to_str().unwrap())
            .await
            .unwrap();

        // user-c: only the env profile — never scope-a's or scope-b's rows.
        let c = effective_profiles("scope-c").await;
        assert!(!c.iter().any(|p| p.name == "private"), "{c:?}");
        assert!(
            !c.iter().any(|p| p.name == "shared" && p.source.ends_with("b.db")),
            "{c:?}"
        );

        // scope-b sees its own row only where env has no opinion; env wins.
        let b = effective_profiles("scope-b").await;
        let shared = b.iter().find(|p| p.name == "shared").expect("shared present");
        assert!(shared.source.ends_with("env.db"), "{shared:?}");

        // scope-a still resolves its own save.
        let a = effective_profiles("scope-a").await;
        assert!(a.iter().any(|p| p.name == "private"), "{a:?}");
    }
}
