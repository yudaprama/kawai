// H1 orchestration-quality eval (PLAN-local-llm-orchestrator.md L12/H9): a
// fixed 20-scenario office workload run against a .litertlm model, scored on
// tool selection, arguments, aliases, ordering, and refusal shape. One model
// load, one conversation reset per scenario. Baseline: E4B 20/20 (100%).
// Usage: cargo run --release --example agent_eval --features litert,office -- /path/to/model.litertlm
// (needs `office` for the regex crate; the scenario set mirrors the crates office schema)
#[cfg(feature = "litert")]
use futures_util::StreamExt;
#[cfg(feature = "litert")]
use kawai_lib::logic::local_llm;
use serde_json::Value;

const SYSTEM: &str = "You are a document assistant. The user's library contains these files:\n- doc1 = invoice_Q3.pdf\n- doc2 = annual_report_2025.pdf\n- doc3 = contract_v2.pdf\n";

const TOOLS: &str = r#"[
  {"type": "function", "function": {
    "name": "office_list_files",
    "description": "List all documents available in the user's knowledge library.",
    "parameters": {"type": "object", "properties": {}, "required": []}
  }},
  {"type": "function", "function": {
    "name": "knowledge_search",
    "description": "Search the user's indexed documents for relevant passages. Use for any question about document contents.",
    "parameters": {"type": "object", "properties": {
      "query": {"type": "string", "description": "Search query derived from the user's question."},
      "mode": {"type": "string", "enum": ["hybrid", "semantic", "keyword"], "description": "Retrieval mode. hybrid=default, semantic=conceptual paraphrases, keyword=exact codes/numbers/names."}
    }, "required": ["query"]}
  }},
  {"type": "function", "function": {
    "name": "pdf_replace_text",
    "description": "Replace text inside a PDF document using a regular expression. The file must be referenced by its short handle, never a raw id.",
    "parameters": {"type": "object", "properties": {
      "file": {"type": "string", "enum": ["doc1", "doc2", "doc3"], "description": "Short handle of the PDF to edit."},
      "find": {"type": "string", "description": "Regular expression matching the text to replace."},
      "replacement": {"type": "string", "description": "Replacement text."}
    }, "required": ["file", "find", "replacement"]}
  }},
  {"type": "function", "function": {
    "name": "office_create_document",
    "description": "Create a new document (docx/xlsx/pptx) from content blocks.",
    "parameters": {"type": "object", "properties": {
      "filename": {"type": "string", "description": "Output filename with extension, e.g. report.docx"},
      "blocks": {"type": "array", "items": {"type": "object"}, "description": "Content blocks: {type: paragraph|heading|bullet, text}."}
    }, "required": ["filename", "blocks"]}
  }},
  {"type": "function", "function": {
    "name": "pdf_merge",
    "description": "Merge multiple PDF documents into one, in the given order.",
    "parameters": {"type": "object", "properties": {
      "files": {"type": "array", "items": {"type": "string", "enum": ["doc1", "doc2", "doc3"]}, "description": "Ordered list of file handles to merge."},
      "output": {"type": "string", "description": "Output filename, e.g. combined.pdf"}
    }, "required": ["files", "output"]}
  }}
]"#;

/// (id, prompt, expected tool, arg asserts). Assert spec grammar:
///   "==value"      — scalar equality (string, bool, or number)
///   "==[a,b,c]"    — list equality
///   "re:pattern"   — regex over the JSON-encoded value (for arrays/objects)
///   "in:a|b|None"  — membership; "None" accepts a missing field
struct Scenario(
    &'static str,
    &'static str,
    Option<&'static str>,
    &'static [(&'static str, &'static str)],
);

const NONE: &[(&str, &str)] = &[];

const SCENARIOS: &[Scenario] = &[
    Scenario("T01 alias", "Replace every occurrence of 2025 with 2026 in the annual report.", Some("pdf_replace_text"),
        &[("file", "==doc2"), ("find", "==2025"), ("replacement", "==2026")]),
    Scenario("T02 regex-date", "In the annual report, change all dates written like 12/31/2025 into ISO format 2025-12-31.", Some("pdf_replace_text"),
        &[("file", "==doc2"), ("find", "re:\\d"), ("replacement", "re:.*")]),
    Scenario("T03 search-sem", "What does the annual report say about renewable energy?", Some("knowledge_search"),
        &[("query", "re:renewable|energy"), ("mode", "in:semantic|hybrid|None")]),
    Scenario("T04 search-code", "Find the invoice number INV-88421 in my documents.", Some("knowledge_search"),
        &[("query", "re:INV-88421|88421"), ("mode", "in:keyword|hybrid|None")]),
    Scenario("T05 list", "Which documents do I have in my library?", Some("office_list_files"), NONE),
    Scenario("T06 create-doc", "Create a Word file named summary.docx with a paragraph saying 'Q3 revenue exceeded targets'.", Some("office_create_document"),
        &[("filename", "==summary.docx"), ("blocks", "re:revenue|exceeded")]),
    Scenario("T07 merge-order", "Combine the invoice and the contract into merged.pdf, invoice first.", Some("pdf_merge"),
        &[("files", "==[doc1,doc3]"), ("output", "==merged.pdf")]),
    Scenario("T08 alias-3", "In the contract, replace the word 'Vendor' with 'Supplier' everywhere.", Some("pdf_replace_text"),
        &[("file", "==doc3"), ("find", "==Vendor"), ("replacement", "==Supplier")]),
    Scenario("T09 paraphrase", "The report discusses environmentally friendly power sources — what exactly?", Some("knowledge_search"),
        &[("query", "re:renewable|environment|power|energy")]),
    Scenario("T10 no-tool", "Who wrote the play Hamlet?", None, NONE),
    Scenario("T11 two-step-a", "First check what documents I have.", Some("office_list_files"), NONE),
    Scenario("T12 case-find", "Change 'confidential' to 'internal use only' in the contract.", Some("pdf_replace_text"),
        &[("file", "==doc3"), ("find", "re:confidential"), ("replacement", "==internal use only")]),
    Scenario("T13 filename-infer", "Make a spreadsheet called budget.xlsx with a bullet 'reduce marketing spend'.", Some("office_create_document"),
        &[("filename", "==budget.xlsx"), ("blocks", "re:marketing")]),
    Scenario("T14 search-name", "Anything in my files about payment terms?", Some("knowledge_search"),
        &[("query", "re:payment|terms")]),
    Scenario("T15 merge-3", "Merge everything into one file called all.pdf with the contract last.", Some("pdf_merge"),
        &[("files", "==[doc1,doc2,doc3]"), ("output", "==all.pdf")]),
    Scenario("T16 regex-num", "In the invoice, replace every euro amount like EUR 1.234,56 with plain 1234.56.", Some("pdf_replace_text"),
        &[("file", "==doc1"), ("find", "re:EUR|\\d"), ("replacement", "re:.*")]),
    // No delete tool exists: the correct behavior is to answer/ask, not fabricate a call.
    Scenario("T17 wrong-tool-bait", "Delete the annual report.", None, NONE),
    Scenario("T18 create-pptx", "Create pitch.pptx with the heading 'Kawai 2026'.", Some("office_create_document"),
        &[("filename", "==pitch.pptx"), ("blocks", "re:Kawai")]),
    Scenario("T19 search-sem2", "How is the company doing financially per the latest report?", Some("knowledge_search"),
        &[("query", "re:financ|revenue|result|performance")]),
    Scenario("T20 alias-1", "Show me the invoice contents about late fees.", Some("knowledge_search"),
        &[("query", "re:late|fee|invoice")]),
];

/// Analytics suite (`EVAL_SUITE=analytics`): data_schema/data_query selection
/// and argument composition over a FIXED schema stated in the system prompt
/// (single-turn eval — there is no real discovery round-trip). Kept separate
/// from the office suite so its manifest/context never shifts the T01-T20
/// baseline.
const ANALYTICS_SYSTEM: &str = "You are a data analysis assistant. The user's library contains these files:\n\
- doc1 = sales_2026.csv (columns: produk [text], kategori [text], pendapatan [integer], jumlah [integer], tanggal [date YYYY-MM-DD])\n\
- doc2 = transactions.xlsx (sheets: Sales, Returns; Sales columns: produk [text], kategori [text], pendapatan [integer], tanggal [date YYYY-MM-DD])\n\
- doc3 = prices_2026.csv (columns: ts [date YYYY-MM-DD], open [float], high [float], low [float], close [float], volume [float]; one row per trading day, row order NOT guaranteed)\n\
Rules:\n\
- fileId is ALWAYS the docN handle from the list above (\"doc1\", \"doc2\", \"doc3\") — never a filename.\n\
- Questions asking FOR data (sums, counts, averages, rows) go straight to data_query or data_ta — no discovery round-trip. Only literal column/sheet questions get data_schema.\n\
- Ranking asks (\"top N\", \"highest first\") need sortBy + descending=true; \"first N rows\" needs limit; indicator folds always pass timestamp, plus the role columns each indicator needs (high/low for atr/tr/cci/stoch/kc/ce, volume for obv/mfi).\n\
- More query power: operator \"in\" takes a comma-separated list (\"laptop, mouse\"); \"having\" filters the aggregated output (columns = groupBy keys or aggregation aliases, e.g. keep total > 2000); \"offset\" skips rows after sorting — paginate with offset+limit.\n\
- Chart asks (\"show/graph/plot/visualize\") go to data_chart with the same filters/groupBy/aggregations as data_query plus mark (bar for comparisons — single-series auto-sorted descending by y when no sortBy, line for time trends, histogram for the distribution of one numeric column — omit y there, pie for share/breakdown — aggregate with groupBy+sum so one row per category; ≤20 slices), x (category/date column), y (numeric column — the aggregation alias when aggregated), xScale \"temporal\" for proportional dates on a line and yScale \"log\" for skewed y (>0 only).\n\
Examples of the exact reply format — ONE call:<name>{...} line per reply:\n\
User: Show the top 3 products by total revenue.\ncall:data_query{\"fileId\":\"doc1\",\"groupBy\":[\"produk\"],\"aggregations\":[{\"column\":\"pendapatan\",\"function\":\"sum\",\"alias\":\"total\"}],\"sortBy\":\"total\",\"descending\":true}\n\
User: Show me the first 5 rows with only produk and pendapatan.\ncall:data_query{\"fileId\":\"doc1\",\"columns\":[\"produk\",\"pendapatan\"],\"limit\":5}\n\
User: Compute RSI(14).\ncall:data_ta{\"fileId\":\"doc3\",\"timestamp\":\"ts\",\"close\":\"close\",\"indicators\":[{\"kind\":\"rsi\"}]}\n\
User: Graph total revenue per product.\ncall:data_chart{\"fileId\":\"doc1\",\"mark\":\"bar\",\"x\":\"produk\",\"y\":\"total\",\"groupBy\":[\"produk\"],\"aggregations\":[{\"column\":\"pendapatan\",\"function\":\"sum\",\"alias\":\"total\"}]}\n\
User: Show the distribution of the pendapatan values.\ncall:data_chart{\"fileId\":\"doc1\",\"mark\":\"histogram\",\"x\":\"pendapatan\"}\n\
User: Show revenue share per kategori as a pie.\ncall:data_chart{\"fileId\":\"doc1\",\"mark\":\"pie\",\"x\":\"kategori\",\"y\":\"total\",\"groupBy\":[\"kategori\"],\"aggregations\":[{\"column\":\"pendapatan\",\"function\":\"sum\",\"alias\":\"total\"}]}\n";

const ANALYTICS_TOOLS: &str = r#"[
  {"type":"function","function":{"name":"data_schema","description":"REQUIRED before the first data_query on a file. Returns the column names, data types, sample values and row count of a stored tabular file (csv/parquet/Excel), plus the sheet names for Excel files.","parameters":{"type":"object","properties":{"fileId":{"type":"string","description":"File id from office_list_files or the attachment block"},"sheet":{"type":"string","description":"Excel sheet name. Optional — defaults to the first sheet with data."}},"required":["fileId"]}}},
  {"type":"function","function":{"name":"data_query","description":"Run a structured query on a stored tabular file (csv/parquet/Excel): filter rows, optionally group, aggregate (sum/avg/min/max/count/count_distinct), sort, and limit. Call data_schema first to learn the columns.","parameters":{"type":"object","properties":{"fileId":{"type":"string"},"sheet":{"type":"string"},"columns":{"type":"array","items":{"type":"string"}},"filters":{"type":"array","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string","enum":["eq","neq","gt","gte","lt","lte","contains","in"]},"value":{"type":"string"}},"required":["column","operator","value"]}},"groupBy":{"type":"array","items":{"type":"string"}},"aggregations":{"type":"array","items":{"type":"object","properties":{"column":{"type":"string"},"function":{"type":"string","enum":["sum","avg","min","max","count","count_distinct"]},"alias":{"type":"string"}},"required":["column","function","alias"]}},"having":{"type":"array","description":"Post-aggregation filter over the OUTPUT (aggregate mode only): columns are groupBy keys or aggregation aliases. Same shape as filters.","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string","enum":["eq","neq","gt","gte","lt","lte","in"]},"value":{"type":"string"}},"required":["column","operator","value"]}},"sortBy":{"type":"string"},"descending":{"type":"boolean"},"limit":{"type":"integer"},"offset":{"type":"integer","description":"Rows to skip AFTER sorting — paginate with offset+limit. Default 0."}},"required":["fileId"]}}},
  {"type":"function","function":{"name":"data_ta","description":"Compute technical-analysis indicators (EMA/SMA/WMA, RSI, MACD, PPO, Bollinger, Keltner, ChandelierExit, ATR, TrueRange, CCI, stochastic, MFI, OBV, ROC, SD, MAD, ER, rolling max/min) over a numeric time series in a stored tabular file. Indicators are stateful — pass timestamp (a date column to sort ascending by) unless rows are already ordered. Returns only each indicator's final value plus skip reasons; call data_schema first to learn the columns.","parameters":{"type":"object","properties":{"fileId":{"type":"string"},"sheet":{"type":"string"},"timestamp":{"type":"string","description":"Column to sort ascending by before folding"},"close":{"type":"string","description":"Required numeric input column"},"high":{"type":"string","description":"Required when using atr/tr/cci/stoch/kc/ce/mfi"},"low":{"type":"string","description":"Required when using atr/tr/cci/stoch/kc/ce/mfi"},"volume":{"type":"string","description":"Required when using obv/mfi"},"indicators":{"type":"array","minItems":1,"items":{"type":"object","properties":{"kind":{"type":"string","enum":["ema","sma","wma","rsi","roc","sd","mad","er","max","min","macd","ppo","bb","atr","tr","cci","stoch","stoch_slow","kc","ce","obv","mfi"]},"column":{"type":"string"},"period":{"type":"integer"},"fast":{"type":"integer"},"slow":{"type":"integer"},"signal":{"type":"integer"},"multiplier":{"type":"number"},"alias":{"type":"string"}},"required":["kind"]}}},"required":["fileId","close","indicators"]}}},
  {"type":"function","function":{"name":"data_chart","description":"Render a chart (bar/line/point/area/histogram/pie) from a stored tabular file and save it as an svg the user sees rendered. Takes the same filters/groupBy/aggregations/sortBy as data_query, plus mark, x (category/time column; numeric for histogram), y (numeric column or aggregation alias — omit for histogram, which counts rows itself; required for pie — the slice value), optional color (grouping column; omit for pie), stack (stacked/normalized/grouped — bar/area composition of the color series), xScale (temporal — ISO dates, proportional spacing) and yScale (log — y must be >0) and title. x and y must appear in the query result — for aggregates use the group_by column as x and the aggregation alias as y. Pie: one row per category (aggregate groupBy+sum first; ≤20 slices).","parameters":{"type":"object","properties":{"fileId":{"type":"string"},"sheet":{"type":"string"},"mark":{"type":"string","enum":["bar","line","point","area","histogram","pie"]},"x":{"type":"string"},"y":{"type":"string"},"color":{"type":"string"},"stack":{"type":"string","enum":["stacked","normalized","grouped"]},"xScale":{"type":"string","enum":["temporal"]},"yScale":{"type":"string","enum":["log"]},"title":{"type":"string"},"filters":{"type":"array","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string","enum":["eq","neq","gt","gte","lt","lte","contains","in"]},"value":{"type":"string"}},"required":["column","operator","value"]}},"groupBy":{"type":"array","items":{"type":"string"}},"aggregations":{"type":"array","items":{"type":"object","properties":{"column":{"type":"string"},"function":{"type":"string","enum":["sum","avg","min","max","count","count_distinct"]},"alias":{"type":"string"}},"required":["column","function","alias"]}},"sortBy":{"type":"string"},"descending":{"type":"boolean"},"limit":{"type":"integer"}},"required":["fileId","mark","x"]}}},
  {"type":"function","function":{"name":"office_list_files","description":"List the user's stored files. Returns id, originalName, ext, bytes, createdAt.","parameters":{"type":"object","properties":{},"required":[]}}}
]"#;

const NONE_A: &[(&str, &str)] = &[];

#[allow(clippy::type_complexity)]
const ANALYTICS_SCENARIOS: &[Scenario] = &[
    // Discovery-first discipline.
    Scenario(
        "A01 schema-first",
        "What columns does sales_2026.csv have?",
        Some("data_schema"),
        &[("fileId", "==doc1")],
    ),
    // Single aggregate without grouping → plain select.
    Scenario(
        "A02 sum-all",
        "What is the total revenue across all rows?",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("aggregations/0/function", "==sum"),
            ("aggregations/0/column", "==pendapatan"),
        ],
    ),
    // Group + rank: top-N shape (descending true, bounded).
    Scenario(
        "A03 group-rank",
        "Show the top 3 products by total revenue.",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("groupBy/0", "==produk"),
            ("aggregations/0/function", "==sum"),
            ("descending", "==true"),
        ],
    ),
    // Implicit row_count: group_by alone, no metric invented.
    Scenario(
        "A04 count-per-group",
        "How many rows are there for each kategori?",
        Some("data_query"),
        &[("fileId", "==doc1"), ("groupBy/0", "==kategori")],
    ),
    // Date range from a natural-language month (gte the month start). Names
    // the dataset ("sales") — "transactions" would collide with doc2's name.
    // contains("2026-01") is accepted alongside range ops: production
    // data_query supports it and it answers the question on ISO dates.
    Scenario(
        "A05 date-filter",
        "Show only the January 2026 rows from the sales CSV.",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("filters/0/value", "re:2026-01"),
            ("filters/0/operator", "in:gte|gt|eq|contains"),
        ],
    ),
    // Avg per group, ranked.
    Scenario(
        "A06 avg-per-group",
        "Average revenue per product, highest first.",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("groupBy/0", "==produk"),
            ("aggregations/0/function", "==avg"),
            ("descending", "==true"),
        ],
    ),
    // Row-selection mode: projected columns + limit, no aggregation.
    Scenario(
        "A07 row-select",
        "Show me the first 5 rows of sales_2026.csv with only produk and pendapatan.",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("columns/0", "==produk"),
            ("columns/1", "==pendapatan"),
            ("limit", "==5"),
        ],
    ),
    // Excel sheet targeting through data_schema.
    Scenario(
        "A08 sheet-select",
        "What columns are in the Returns sheet of transactions.xlsx?",
        Some("data_schema"),
        &[("fileId", "==doc2"), ("sheet", "==Returns")],
    ),
    // Technical-analysis selection: momentum on the close series, with the
    // timestamp-sort discipline the stateful folds require.
    Scenario(
        "A09 ta-rsi",
        "Is prices_2026.csv overbought or oversold right now? Compute RSI(14).",
        Some("data_ta"),
        &[
            ("fileId", "==doc3"),
            ("close", "==close"),
            ("timestamp", "==ts"),
            ("indicators/0/kind", "==rsi"),
        ],
    ),
    // Volatility needs the high/low role columns, not just close.
    Scenario(
        "A10 ta-atr",
        "How volatile is the price in prices_2026.csv? Compute ATR(14).",
        Some("data_ta"),
        &[
            ("fileId", "==doc3"),
            ("indicators/0/kind", "==atr"),
            ("high", "==high"),
            ("low", "==low"),
        ],
    ),
    // Multi-param momentum default (fast/slow/signal omitted → defaults).
    Scenario(
        "A11 ta-macd",
        "Compute MACD on the close prices of prices_2026.csv.",
        Some("data_ta"),
        &[
            ("fileId", "==doc3"),
            ("close", "==close"),
            ("indicators/0/kind", "==macd"),
        ],
    ),
    // Set-membership filter: comma-separated list coerced to the column dtype.
    Scenario(
        "A12 in-filter",
        "Show rows for the laptop and mouse products only.",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("filters/0/operator", "==in"),
            ("filters/0/value", "re:laptop"),
        ],
    ),
    // Post-aggregation threshold on an alias (HAVING).
    Scenario(
        "A13 having",
        "Which products have total revenue above 2000?",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("groupBy/0", "==produk"),
            ("aggregations/0/function", "==sum"),
            ("having/0/column", "re:total"),
            ("having/0/operator", "==gt"),
            ("having/0/value", "==2000"),
        ],
    ),
    // Pagination: page 2 of a sorted list = offset past page 1.
    Scenario(
        "A14 offset-page",
        "Show products ranked 3rd to 5th by total revenue.",
        Some("data_query"),
        &[
            ("fileId", "==doc1"),
            ("groupBy/0", "==produk"),
            ("aggregations/0/function", "==sum"),
            ("sortBy", "re:total"),
            ("descending", "==true"),
            ("offset", "==2"),
            ("limit", "==3"),
        ],
    ),
    // Chart selection + aggregation composition: a comparison ask maps to a
    // bar chart whose x is the group column and y the aggregation alias.
    Scenario(
        "A15 chart-bar",
        "Graph total revenue per product as a bar chart.",
        Some("data_chart"),
        &[
            ("fileId", "==doc1"),
            ("mark", "==bar"),
            ("x", "==produk"),
            ("y", "re:total|pendapatan"),
            ("aggregations/0/function", "==sum"),
        ],
    ),
    // Time-trend ask maps to a line chart; x is the date column.
    Scenario(
        "A16 chart-line",
        "Plot the closing price over time as a line chart.",
        Some("data_chart"),
        &[
            ("fileId", "==doc3"),
            ("mark", "==line"),
            ("x", "==ts"),
            ("y", "==close"),
        ],
    ),
    // Distribution ask maps to a histogram: numeric x, NO y (count is implied).
    Scenario(
        "A17 chart-hist",
        "Show the distribution of the pendapatan values.",
        Some("data_chart"),
        &[
            ("fileId", "==doc1"),
            ("mark", "==histogram"),
            ("x", "==pendapatan"),
            ("y", "absent"),
        ],
    ),
    // Share/breakdown ask maps to a pie: aggregate so one row per category.
    Scenario(
        "A18 chart-pie",
        "Show revenue share per kategori as a pie chart.",
        Some("data_chart"),
        &[
            ("fileId", "==doc1"),
            ("mark", "==pie"),
            ("x", "==kategori"),
            ("y", "re:total|pendapatan"),
            ("aggregations/0/function", "==sum"),
        ],
    ),
];

/// Accounting suite (`EVAL_SUITE=accounting`): trading-books tool selection,
/// argument composition and ordering over the user's Binance futures fills
/// ledger. Kept separate from the office suite so its manifest/context never
/// shifts the T01-T20 baseline. Tool descriptions/args mirror the real
/// crates/toolsets/accounting + toolsets/binance tools.
const ACCOUNTING_SYSTEM: &str = "You are a trading assistant. The user keeps ONE double-entry ledger of exchange futures fills, with one wallet account per exchange:\n\
- binance-wallet (asset — the exchange wallet)\n\
- trading-gains, trading-losses (realized PnL), trading-fees (commissions)\n\
Fills import is IDEMPOTENT: each fill posts exactly once, keyed by the exchange trade id — re-running an import over the same range is safe.\n\
The user's library holds one statement file:\n\
- stmt1 = bank_statement_march.csv (bank statement for the binance-wallet account)\n\
Rules:\n\
- Dates are ISO YYYY-MM-DD. A month means its exact boundaries (March 2026 = from 2026-03-01, to 2026-03-31).\n\
- Performance questions (win rate, expectancy, profit factor) go to crypto_futures_trade_stats, which takes a look-back in DAYS (1-365), not dates.\n\
- Reconciliation uses file_id (the stmtN handle from the library) — never paste statement text.\n\
- Before a books review, run ledger_integrity_check and report issues instead of proceeding when is_valid is false.\n\
- If a question lacks a period, ask which period — never invent dates.\n\
Examples of the exact reply format — ONE call:<name>{...} line per reply:\n\
User: Import my March 2026 fills.\ncall:venue_fills_import{\"from\":\"2026-03-01\",\"to\":\"2026-03-31\"}\n\
User: PnL per pair for March 2026?\ncall:trading_pnl_by_symbol{\"from\":\"2026-03-01\",\"to\":\"2026-03-31\"}\n\
User: Win rate on BTCUSDT over the last 90 days?\ncall:crypto_futures_trade_stats{\"symbol\":\"BTCUSDT\",\"days\":90}\n";

const ACCOUNTING_TOOLS: &str = r#"[
  {"type":"function","function":{"name":"venue_fills_import","description":"Import executed exchange futures fills from the locally synced trade history into the double-entry ledger, per venue. Per fill: realized PnL credits trading-gains or debits trading-losses, commission debits trading-fees, both netting that venue's wallet account (binance-wallet / mexc-wallet). Each fill posts exactly once, keyed by the exchange trade id; already-imported fills are skipped, so re-running over the same range is safe.","parameters":{"type":"object","properties":{"from":{"type":"string","description":"Start date, YYYY-MM-DD (fills executed this day or later, UTC)."},"to":{"type":"string","description":"End date, YYYY-MM-DD (inclusive, UTC)."},"wallet_account_id":{"type":"string","description":"Optional id of the exchange wallet account; default binance-wallet."}},"required":["from","to"]}}},
  {"type":"function","function":{"name":"crypto_futures_trade_stats","description":"Realized trading performance for your Binance futures positions: win rate, average win/loss, expectancy, profit factor, largest win/loss and total realized PnL — optionally scoped to one symbol. Counts are PER TRADE; PnL is net of commission; open positions are excluded. Read-only.","parameters":{"type":"object","properties":{"symbol":{"type":"string","description":"Optional single symbol, e.g. \"BTCUSDT\". Omit for the whole book."},"days":{"type":"integer","description":"How far back to fetch new fills from the exchange (1-365). Existing history is always included."},"market":{"type":"string","enum":["USDM","COINM"],"description":"Which futures market. Defaults to USDM."}}}}},
  {"type":"function","function":{"name":"trading_pnl_by_symbol","description":"Realized PnL per symbol over a period, from the imported exchange futures fills (run venue_fills_import first so the mirror is current). Rows sorted by absolute PnL contribution; totals included. Exact decimals, no rounding.","parameters":{"type":"object","properties":{"from":{"type":"string","description":"Period start, YYYY-MM-DD (inclusive, UTC)."},"to":{"type":"string","description":"Period end, YYYY-MM-DD (inclusive, UTC)."}},"required":["from","to"]}}},
  {"type":"function","function":{"name":"trading_fee_summary","description":"Commission totals over a period from the imported exchange futures fills: total, per venue + symbol, and traded volume per symbol (fee-to-volume = commission_total / volume_total). Run venue_fills_import first so the mirror is current. Exact decimals.","parameters":{"type":"object","properties":{"from":{"type":"string","description":"Period start, YYYY-MM-DD (inclusive, UTC)."},"to":{"type":"string","description":"Period end, YYYY-MM-DD (inclusive, UTC)."}},"required":["from","to"]}}},
  {"type":"function","function":{"name":"ledger_integrity_check","description":"Check the user's local ledger for integrity as of a date: verifies that the trial balance and the balance sheet both balance. is_valid is true when every check passed; issues lists one line per failure (empty when valid).","parameters":{"type":"object","properties":{"as_of":{"type":"string","description":"Date, YYYY-MM-DD. Transactions after it are ignored."}},"required":["as_of"]}}},
  {"type":"function","function":{"name":"reconcile_csv","description":"Reconcile one ledger account against a CSV/TSV bank or gateway statement — pass either file_id (a statement uploaded to the Library) or statement_csv (the full CSV text including the header row), not both. Runs the same four-pass matching as reconcile_run; at most 1000 rows.","parameters":{"type":"object","properties":{"file_id":{"type":"string","description":"Stored statement file id (csv/tsv) from office_list_files — the Library upload. Use this OR statement_csv, not both."},"statement_csv":{"type":"string","description":"Full CSV text including the header row. Use this OR file_id, not both."},"account_id":{"type":"string","description":"Ledger account to reconcile (e.g. the bank account)."},"from":{"type":"string","description":"Period start, YYYY-MM-DD (inclusive)."},"to":{"type":"string","description":"Period end, YYYY-MM-DD (inclusive)."},"source":{"type":"object","description":"{\"type\":\"bank\",\"bank_name\",\"account_number\"} or {\"type\":\"gateway\",\"name\",\"merchant_id\"}.","properties":{"type":{"type":"string","enum":["bank","gateway"]},"bank_name":{"type":"string"},"account_number":{"type":"string"},"name":{"type":"string"},"merchant_id":{"type":"string"}},"required":["type"]}},"required":["account_id","from","to","source"]}}},
  {"type":"function","function":{"name":"ledger_trial_balance","description":"Generate a trial balance from the user's local ledger as of a date: every account on its debit or credit column, totals, and whether the books balance. Amounts are decimal strings.","parameters":{"type":"object","properties":{"as_of":{"type":"string","description":"Date, YYYY-MM-DD. Transactions after it are ignored."}},"required":["as_of"]}}}
]"#;

const NONE_C: &[(&str, &str)] = &[];

#[allow(clippy::type_complexity)]
const ACCOUNTING_SCENARIOS: &[Scenario] = &[
    // Month → exact ISO boundaries, no discovery round-trip.
    Scenario(
        "F01 import-month",
        "Import my Binance futures fills for March 2026.",
        Some("venue_fills_import"),
        &[("from", "==2026-03-01"), ("to", "==2026-03-31")],
    ),
    // Indonesian phrasing, same month boundaries.
    Scenario(
        "F02 pnl-indonesian",
        "Berapa PnL per pair Maret 2026?",
        Some("trading_pnl_by_symbol"),
        &[("from", "==2026-03-01"), ("to", "==2026-03-31")],
    ),
    // Fee question → fee summary, not pnl or stats.
    Scenario(
        "F03 fees",
        "How much did I pay in commissions for March 2026?",
        Some("trading_fee_summary"),
        &[("from", "==2026-03-01"), ("to", "==2026-03-31")],
    ),
    // Stats take a look-back in DAYS, not dates — "last 90 days" maps to 90.
    Scenario(
        "F04 winrate-days",
        "What's my win rate on BTCUSDT over the last 90 days?",
        Some("crypto_futures_trade_stats"),
        &[
            ("symbol", "==BTCUSDT"),
            ("days", "==90"),
            ("market", "in:USDM|None"),
        ],
    ),
    // Library statement → file_id handle, never pasted CSV text.
    Scenario(
        "F05 reconcile-file",
        "Reconcile the bank statement stmt1 from my library against the binance-wallet account for March 2026.",
        Some("reconcile_csv"),
        &[
            ("file_id", "==stmt1"),
            ("statement_csv", "absent"),
            ("account_id", "==binance-wallet"),
            ("from", "==2026-03-01"),
            ("to", "==2026-03-31"),
            ("source/type", "==bank"),
        ],
    ),
    // Integrity gate before a books review.
    Scenario(
        "F06 integrity-first",
        "I want to review my books as of 2026-04-01 — check everything balances first.",
        Some("ledger_integrity_check"),
        &[("as_of", "==2026-04-01")],
    ),
    // No period given: the correct behavior is to ask, not invent dates.
    Scenario("F07 no-period-refusal", "Berapa PnL saya?", None, NONE_C),
    // Ordering: a combined import+stats ask must emit the import FIRST. The
    // harness scores the first call: line, so import-before-stats discipline
    // means the import is the emitted call, with the month boundaries intact.
    Scenario(
        "F08 import-then-stats",
        "Import my March 2026 Binance fills and then show me my trading stats.",
        Some("venue_fills_import"),
        &[("from", "==2026-03-01"), ("to", "==2026-03-31")],
    ),
];

/// Screener suite (`EVAL_SUITE=screener`): market-wide screening + structural
/// narrowing tool selection over the real Binance toolset. Kept separate from
/// the other suites so its manifest never shifts their baselines. This is the
/// gate for the structure vocabulary in particular: `structure_side` /
/// `max_distance_pct` / `min_touches` are the narrowing args, `min_trades` is
/// NOT one of them (it belongs to `rank_by: "myPerformance"`), and a single
/// pair's swings must go to `crypto_market_structure`, never to the screener.
const SCREENER_SYSTEM: &str = "You are a crypto market assistant. You have read-only Binance market-data tools; there is NO order-placement tool and you never pretend to have one.\n\
Rules:\n\
- A market-wide screen (\"scan/screen the market\", \"which coins\", \"find setups\") goes to crypto_screener: `screen` for ONE setup, `screens` for several over one shared scan. Screens: oversold_rebound, macd_golden_cross, macd_death_cross, midband_reclaim, uptrend_pullback, squeeze_watch, rsi_overbought_uptrend. `universe` is spot or usdm (default usdm); `interval` is the candle timeframe the user names (default 1d).\n\
- Structure narrowing is ONLY these three args: structure_side (\"support\" = a pivot-low cluster BELOW price, \"resistance\" = a pivot-high cluster ABOVE it), max_distance_pct (a percent, so \"within 2%\" = 2), min_touches (integer pivot touches, so \"at least 3 touches\" = 3). Omit them unless the user asks for a level condition.\n\
- min_trades is NOT a structure filter — it pairs with rank_by \"myPerformance\" and counts the user's OWN completed trades on a symbol.\n\
- One pair's swing pivots and support/resistance levels go to crypto_market_structure. One pair's indicators go to crypto_ta_analyze; a quote goes to crypto_price; raw candles go to crypto_klines.\n\
Examples of the exact reply format — ONE call:<name>{...} line per reply:\n\
User: Scan the perp market for squeeze setups.\ncall:crypto_screener{\"screen\":\"squeeze_watch\",\"universe\":\"usdm\",\"interval\":\"1d\"}\n\
User: Only symbols pressing resistance within 2% with at least 3 touches.\ncall:crypto_screener{\"screen\":\"squeeze_watch\",\"structure_side\":\"resistance\",\"max_distance_pct\":2,\"min_touches\":3}\n\
User: Where are the swing levels on BTCUSDT?\ncall:crypto_market_structure{\"symbol\":\"BTCUSDT\"}\n";

/// Property sets/args mirror the REAL toolsets/binance schemas (checked by
/// `screener_suite_manifest_matches_the_binance_tools` when the `binance`
/// feature is on).
const SCREENER_TOOLS: &str = r#"[
  {"type":"function","function":{"name":"crypto_screener","description":"Screen the whole Binance market for ONE setup or SEVERAL at once: ranks the top-liquidity USDT pairs by 24h quote volume, folds indicators over candles per symbol once, and evaluates every requested screen over those same folds. Returns per screen the symbols where it fires with a conviction score, per-hit reasons, and each hit's structure (trend, nearest confirmed support/resistance with touch count and distance, last break). Optional structural narrowing: structure_side / max_distance_pct / min_touches.","parameters":{"type":"object","properties":{
    "screen":{"type":"string","enum":["oversold_rebound","macd_golden_cross","macd_death_cross","midband_reclaim","uptrend_pullback","squeeze_watch","rsi_overbought_uptrend"],"description":"One setup to scan for. Pass this OR screens, never both."},
    "screens":{"type":"array","items":{"type":"string"},"description":"Several setups over ONE scan. 1-7 entries, duplicates ignored. Pass this OR screen, never both."},
    "universe":{"type":"string","enum":["spot","usdm"],"description":"Market family. Default \"usdm\"."},
    "interval":{"type":"string","description":"Candle interval, e.g. 15m, 1h, 4h, 1d. Default \"1d\"."},
    "top_n":{"type":"integer","description":"Hits returned PER screen, 1-25. Default 10."},
    "scan_size":{"type":"integer","description":"How many top-liquidity symbols to scan, 1-2000. Omit for the entire filtered universe."},
    "structure_side":{"type":"string","enum":["support","resistance"],"description":"Structural filter: keep only hits with a confirmed level on this side of price — resistance = a pivot-high cluster ABOVE the close, support = a pivot-low cluster BELOW it."},
    "max_distance_pct":{"type":"number","description":"Structural filter: keep only hits whose nearest confirmed level sits within this percent of the last close (2 = pressed into a level)."},
    "min_touches":{"type":"integer","description":"Structural filter: minimum pivot touches on the nearest level (1-50)."},
    "rank_by":{"type":"string","enum":["score","liquidity","myPerformance"],"description":"How to order hits. Leave unset to use the user's own realized history automatically; \"myPerformance\" ranks by that history."},
    "min_trades":{"type":"integer","description":"Completed trades a symbol needs before rank_by \"myPerformance\" will rank it. Default 3."}
  },"required":[]}}},
  {"type":"function","function":{"name":"crypto_market_structure","description":"Read the market structure of ONE Binance spot pair from its candles: confirmed swing pivots, clustered support/resistance levels (with touches and side), the trend regime and the most recent structural break.","parameters":{"type":"object","properties":{
    "symbol":{"type":"string","description":"Trading pair, e.g. \"BTCUSDT\"."},
    "interval":{"type":"string","description":"Candle interval. Default \"4h\"."},
    "limit":{"type":"integer","description":"Candles to analyse, 64-1000. Default 300."},
    "half_width":{"type":"integer","description":"Bars required on each side of a pivot, 1-10. Default 2."},
    "max_levels":{"type":"integer","description":"Levels to report, strongest first, 1-50. Default 8."}
  },"required":["symbol"]}}},
  {"type":"function","function":{"name":"crypto_ta_analyze","description":"Fetch Binance spot candles for ONE pair and compute technical indicators in one step (RSI, MACD, Bollinger, ATR, stochastic, Ichimoku, ...).","parameters":{"type":"object","properties":{
    "symbol":{"type":"string","description":"Trading pair, e.g. \"BTCUSDT\"."},
    "interval":{"type":"string","description":"Candle interval. Default \"1d\"."},
    "limit":{"type":"integer","description":"Candles to fetch, 30-1000. Default 200."},
    "indicators":{"type":"array","items":{"type":"string"},"description":"Indicator names (preset windows), e.g. [\"rsi\"], [\"macd\"], [\"bb\",\"atr\"]."}
  },"required":["symbol"]}}},
  {"type":"function","function":{"name":"crypto_price","description":"Get current spot market stats for one trading pair (24h change, last/bid/ask, high/low, volume).","parameters":{"type":"object","properties":{
    "symbol":{"type":"string","description":"Trading pair, uppercase, e.g. \"BTCUSDT\"."}
  },"required":["symbol"]}}},
  {"type":"function","function":{"name":"crypto_klines","description":"Get historical spot OHLCV candles for one pair, oldest first.","parameters":{"type":"object","properties":{
    "symbol":{"type":"string","description":"Trading pair, e.g. \"BTCUSDT\"."},
    "interval":{"type":"string","description":"Candle interval. Default \"1d\"."},
    "limit":{"type":"integer","description":"Number of candles, 1-1000. Default 90."}
  },"required":["symbol"]}}}
]"#;

const NONE_S: &[(&str, &str)] = &[];

const SCREENER_SCENARIOS: &[Scenario] = &[
    // Plain screen: the setup maps to `screen`, market family defaults to usdm.
    Scenario(
        "S01 squeeze-scan",
        "Scan the perp market for squeeze setups.",
        Some("crypto_screener"),
        &[("screen", "==squeeze_watch"), ("universe", "in:usdm|None")],
    ),
    // Structural narrowing, all three args: side + percent + touches.
    Scenario(
        "S02 resistance-narrowing",
        "Scan the perp market for squeeze setups, but only symbols pressing resistance within 2% with at least 3 touches.",
        Some("crypto_screener"),
        &[
            ("screen", "==squeeze_watch"),
            ("structure_side", "==resistance"),
            // A percent may arrive as 2 or 2.0 — both are the same arg.
            ("max_distance_pct", r"re:^2(\.0)?$"),
            ("min_touches", "==3"),
        ],
    ),
    // Same vocabulary on the other side; a bare percent must not become a fraction.
    Scenario(
        "S03 support-narrowing",
        "Find oversold rebounds on the perp market where price sits on support within 5%.",
        Some("crypto_screener"),
        &[
            ("screen", "==oversold_rebound"),
            ("structure_side", "==support"),
            ("max_distance_pct", r"re:^5(\.0)?$"),
        ],
    ),
    // Several setups in ONE call use `screens`, not repeated single screens.
    Scenario(
        "S04 multi-screen",
        "Check mid-band reclaims and MACD golden crosses on 4h spot candles, top 5 each.",
        Some("crypto_screener"),
        &[
            ("screens", "re:midband_reclaim"),
            ("screens", "re:macd_golden_cross"),
            ("universe", "==spot"),
            ("interval", "==4h"),
            ("top_n", "==5"),
        ],
    ),
    // One pair's swings/levels — NOT the market-wide screener.
    Scenario(
        "S05 pair-structure",
        "Where are the swing support and resistance levels for BTCUSDT on the 4h chart?",
        Some("crypto_market_structure"),
        // 4h is the tool default, so omitting it is equally correct.
        &[("symbol", "==BTCUSDT"), ("interval", "in:4h|None")],
    ),
    // Bait: "levels" wording must still not pull the screener.
    Scenario(
        "S06 structure-not-screener",
        "Do not scan the market — just show me ETHUSDT's structural levels on 1h.",
        Some("crypto_market_structure"),
        &[("symbol", "==ETHUSDT"), ("interval", "==1h")],
    ),
    // `min_trades` belongs to myPerformance ranking, NOT to the structure filter.
    Scenario(
        "S07 my-performance",
        "Screen for oversold rebounds, but only coins I've completed at least 5 trades on.",
        Some("crypto_screener"),
        &[
            ("screen", "==oversold_rebound"),
            ("rank_by", "==myPerformance"),
            ("min_trades", "==5"),
            ("min_touches", "absent"),
            ("structure_side", "absent"),
        ],
    ),
    // Indicator ask → ta_analyze for that pair.
    Scenario(
        "S08 indicator",
        "Is ETHUSDT overbought? Check RSI.",
        Some("crypto_ta_analyze"),
        &[("symbol", "==ETHUSDT"), ("indicators", "re:rsi")],
    ),
    // Plain quote → the cheapest tool, not a market scan.
    Scenario(
        "S09 quote",
        "What's SOLUSDT trading at right now?",
        Some("crypto_price"),
        &[("symbol", "==SOLUSDT")],
    ),
    // No order-placement tool exists: the correct reply is prose, not a call.
    Scenario(
        "S10 no-order-tool",
        "Open a 10x long on BTCUSDT for me.",
        None,
        NONE_S,
    ),
];

/// Filler tools for the TOOL_INFLATE=N experiment: realistic names/descriptions
/// modeled on the crates weather/finance/news/entertainment categories.
/// Measures how manifest size affects selection accuracy + latency on E4B.
const FILLER_TOOLS: &str = r#"[
  {"type":"function","function":{"name":"weather_get_forecast","description":"Get the weather forecast for a city for up to 7 days.","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"},"days":{"type":"integer","description":"Number of forecast days"}},"required":["city"]}}},
  {"type":"function","function":{"name":"weather_get_current","description":"Get current weather conditions for a city.","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}},
  {"type":"function","function":{"name":"weather_get_alerts","description":"Get active weather alerts for a region.","parameters":{"type":"object","properties":{"region":{"type":"string"}},"required":["region"]}}},
  {"type":"function","function":{"name":"finance_get_quote","description":"Get the latest stock quote for a ticker symbol.","parameters":{"type":"object","properties":{"symbol":{"type":"string","description":"Ticker symbol, e.g. AAPL"}},"required":["symbol"]}}},
  {"type":"function","function":{"name":"finance_get_income_statement","description":"Get the annual income statement for a company.","parameters":{"type":"object","properties":{"symbol":{"type":"string"},"years":{"type":"integer"}},"required":["symbol"]}}},
  {"type":"function","function":{"name":"finance_search_tickers","description":"Search for ticker symbols by company name.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"finance_get_exchange_rate","description":"Get the exchange rate between two currencies.","parameters":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"}},"required":["from","to"]}}},
  {"type":"function","function":{"name":"news_search","description":"Search recent news articles by keyword.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"news_get_top_headlines","description":"Get the current top headlines for a category.","parameters":{"type":"object","properties":{"category":{"type":"string","enum":["business","technology","sports","world"]}},"required":["category"]}}},
  {"type":"function","function":{"name":"entertainment_search_movies","description":"Search for movies by title.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"entertainment_get_movie_detail","description":"Get details for one movie.","parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}},
  {"type":"function","function":{"name":"geospace_get_country_info","description":"Get facts about a country.","parameters":{"type":"object","properties":{"country":{"type":"string"}},"required":["country"]}}},
  {"type":"function","function":{"name":"sports_get_scores","description":"Get live scores for a sports league.","parameters":{"type":"object","properties":{"league":{"type":"string"}},"required":["league"]}}},
  {"type":"function","function":{"name":"utility_calculate","description":"Evaluate a mathematical expression.","parameters":{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}}},
  {"type":"function","function":{"name":"utility_define_word","description":"Get the dictionary definition of a word.","parameters":{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}}},
  {"type":"function","function":{"name":"browser_markdown_extract","description":"Fetch a web page and return its content as markdown.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"Full URL including https://"}},"required":["url"]}}},
  {"type":"function","function":{"name":"browser_links_extract","description":"Extract all links from a web page.","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}},
  {"type":"function","function":{"name":"browser_json_extract","description":"Fetch a JSON API endpoint and return the parsed payload.","parameters":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]}}},
  {"type":"function","function":{"name":"knowledge_search_papers","description":"Search academic papers by keyword.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"gaming_get_game_info","description":"Get details about a video game.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}},
  {"type":"function","function":{"name":"food_search_recipes","description":"Search recipes by dish name or ingredient.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}},
  {"type":"function","function":{"name":"religion_get_verse","description":"Look up a verse by reference.","parameters":{"type":"object","properties":{"reference":{"type":"string"}},"required":["reference"]}}},
  {"type":"function","function":{"name":"geospace_get_timezone","description":"Get the current time and timezone for a city.","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}},
  {"type":"function","function":{"name":"news_get_sources","description":"List available news sources.","parameters":{"type":"object","properties":{},"required":[]}}},
  {"type":"function","function":{"name":"finance_get_market_overview","description":"Get major indices and market summary.","parameters":{"type":"object","properties":{},"required":[]}}}
]"#;

fn prompt_for(message: &str, system: &str, tools_json: &str) -> String {
    let inflate: usize = std::env::var("TOOL_INFLATE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let tools = if inflate > 0 {
        let fillers: Vec<Value> = serde_json::from_str(FILLER_TOOLS).unwrap();
        let take: Vec<&Value> = fillers.iter().take(inflate.min(fillers.len())).collect();
        let base: Vec<Value> = serde_json::from_str(tools_json).unwrap();
        let all: Vec<&Value> = base.iter().chain(take.iter().copied()).collect();
        serde_json::to_string(&all).unwrap()
    } else {
        tools_json.to_string()
    };
    println!(
        "manifest tools: {}",
        serde_json::from_str::<Vec<Value>>(&tools).unwrap().len()
    );
    format!(
        "<agent_context>\n{system}\nAvailable tools (JSON schemas):\n{tools}\n\n\
         To call a tool, reply with exactly ONE line in this format:\n\
         call:<name>{{\"arg\": \"value\", ...}}\n\
         Supply exactly the parameters listed for that tool (omit optional ones). After the call: line, STOP.\n\
         General-knowledge questions unrelated to the user's files: answer directly in plain text with NO tool call.\n\
         If no tool is needed, answer the user directly in plain text with NO call: line.\n\
         </agent_context>\n\n<user_request>\n{message}\n</user_request>"
    )
}

/// Extract the first `call:NAME{json}` line (same protocol the agent loop parses).
fn parse_call(text: &str) -> Option<Result<(String, Value), String>> {
    let line = text.lines().find(|l| l.starts_with("call:"))?;
    let rest = &line["call:".len()..];
    let open = rest.find('{')?;
    let name = rest[..open].trim().to_string();
    let json_part = &rest[open..];
    match serde_json::from_str::<Value>(json_part) {
        Ok(v) => Some(Ok((name, v))),
        Err(_) => Some(Err(format!(
            "malformed json: {}",
            json_part.chars().take(60).collect::<String>()
        ))),
    }
}

/// Slash-path lookup: `aggregations/0/function` walks objects by key and
/// arrays by index (flat keys behave exactly as before).
fn get<'a>(args: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = args;
    for seg in path.split('/') {
        cur = match cur {
            Value::Object(m) => m.get(seg)?,
            Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn check_asserts(args: &Value, asserts: &[(&str, &str)]) -> Result<(), String> {
    for (path, spec) in asserts {
        let v = get(args, path);
        if let Some(spec) = spec.strip_prefix("re:") {
            let hay = v.map(|v| v.to_string()).unwrap_or_default();
            let re = regex::Regex::new(spec).unwrap();
            if !re.is_match(&hay) {
                return Err(format!("{path}={hay} !~ {spec}"));
            }
        } else if let Some(list) = spec.strip_prefix("in:") {
            let ok: Vec<&str> = list.split('|').collect();
            let got = v.and_then(Value::as_str).unwrap_or("None");
            if !ok.contains(&got) {
                return Err(format!("{path}={got:?} not in {ok:?}"));
            }
        } else if let Some(list) = spec.strip_prefix("==[").and_then(|s| s.strip_suffix(']')) {
            let want: Vec<&str> = list.split(',').map(str::trim).collect();
            let got: Vec<String> = v
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if got != want {
                return Err(format!("{path}={got:?} != {want:?}"));
            }
        } else if let Some(want) = spec.strip_prefix("==") {
            // Stringify scalars: bools (`descending==true`) and numbers
            // (`limit==5`) are legal arg values — as_str alone would read
            // them as None and fail every such assert.
            let got = v.map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) => n.to_string(),
                other => other.to_string(),
            });
            if got.as_deref() != Some(want) {
                return Err(format!("{path}={:?} != {want:?}", got.as_deref()));
            }
        } else if *spec == "absent" {
            // The key must NOT appear — e.g. histogram forbids a y channel.
            if let Some(v) = v {
                return Err(format!("{path}={v} should be absent"));
            }
        }
    }
    Ok(())
}

#[cfg(not(feature = "litert"))]
fn main() {
    eprintln!("agent_eval requires --features litert,office (litert feature missing)");
    std::process::exit(2);
}

#[cfg(feature = "litert")]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let model = args
        .next()
        .expect("usage: agent_eval <model.litertlm> [report.md]");
    // Optional second arg: write a markdown report (consumed by CI job summary
    // + artifact). Env EVAL_MIN_PASS (default: all scenarios) sets the gate —
    // exit code 1 below it, so CI fails on regressions.
    let report_path = args.next();
    let min_pass: usize = std::env::var("EVAL_MIN_PASS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(usize::MAX);
    // EVAL_DEBUG=1 → dump each failed scenario's RAW model output (truncated)
    // to stdout and into the report, so prompt-shape regressions are
    // diagnosable from CI artifacts instead of guessed at.
    let debug_raw = std::env::var("EVAL_DEBUG")
        .map(|v| v == "1")
        .unwrap_or(false);

    let t_load = std::time::Instant::now();
    let info = local_llm::load_model("eval", &model, false, false, 1, None)
        .await
        .expect("load_model");
    let load_s = t_load.elapsed().as_secs_f64();
    // Suite selection: EVAL_SUITE=analytics swaps the scenario set, system
    // context and tool manifest (the office baseline stays byte-identical).
    let suite = std::env::var("EVAL_SUITE").unwrap_or_default();
    let (suite_name, system, tools_json, scenarios): (&str, &str, &str, &[Scenario]) =
        if suite == "analytics" {
            (
                "analytics",
                ANALYTICS_SYSTEM,
                ANALYTICS_TOOLS,
                ANALYTICS_SCENARIOS,
            )
        } else if suite == "accounting" {
            (
                "accounting",
                ACCOUNTING_SYSTEM,
                ACCOUNTING_TOOLS,
                ACCOUNTING_SCENARIOS,
            )
        } else if suite == "screener" {
            (
                "screener",
                SCREENER_SYSTEM,
                SCREENER_TOOLS,
                SCREENER_SCENARIOS,
            )
        } else {
            ("office", SYSTEM, TOOLS, SCENARIOS)
        };
    let tool_count = serde_json::from_str::<Vec<Value>>(tools_json)
        .unwrap()
        .len();
    println!(
        "model {} [{}] (load {load_s:.1}s)\n",
        info.model_path, info.backend
    );

    let mut pass = 0usize;
    let mut rows: Vec<(String, bool, String, f64)> = Vec::new();
    let mut raws: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for Scenario(id, prompt, want_tool, asserts) in scenarios {
        let _ = local_llm::reset_conversation("eval").await;
        let t = std::time::Instant::now();
        let mut text = String::new();
        let mut stream = Box::pin(local_llm::local_chat(
            "eval".into(),
            prompt_for(prompt, system, tools_json),
            None,
            None,
            false, // context already cleared by reset_conversation above
        ));
        while let Some(ev) = stream.next().await {
            match ev {
                local_llm::LocalChatEvent::Token { text: t } => text.push_str(&t),
                local_llm::LocalChatEvent::Finished => break,
                local_llm::LocalChatEvent::Error { message } => {
                    text.push_str(&format!("[STREAM_ERROR] {message}"));
                    break;
                }
                _ => {}
            }
        }
        let secs = t.elapsed().as_secs_f64();
        let call = parse_call(&text);
        let (ok, note) = match (want_tool, &call) {
            (None, Some(c)) => (
                false,
                match c {
                    Ok((name, _)) => format!("no-call expected, got call:{name}"),
                    Err(e) => format!("no-call expected, got malformed ({e})"),
                },
            ),
            (None, None) => (true, "no call, as expected".into()),
            (Some(want), None) => (false, format!("no call emitted (want {want})")),
            (Some(want), Some(Err(e))) => (false, format!("malformed call: {e}")),
            (Some(want), Some(Ok((name, args)))) => {
                if name != *want {
                    (false, format!("tool={name} want={want}"))
                } else {
                    match check_asserts(args, asserts) {
                        Ok(()) => (true, "args ok".into()),
                        Err(e) => (false, e),
                    }
                }
            }
        };
        if ok {
            pass += 1;
        }
        println!(
            "{} {id:18} {note} ({secs:.1}s)",
            if ok { "PASS" } else { "FAIL" }
        );
        if debug_raw && !ok {
            let mut raw = text.trim().to_string();
            if raw.is_empty() {
                raw = "(empty stream output)".into();
            }
            let truncated = raw.chars().count() > 600;
            let mut out: String = raw.chars().take(600).collect();
            if truncated {
                out.push_str("…");
            }
            println!("[raw {id}] {out}");
            raws.insert(id, out);
        }
        rows.push((id.to_string(), ok, note, secs));
    }
    let total = scenarios.len();
    let pct = 100.0 * pass as f64 / total as f64;
    let min_pass = min_pass.min(total);
    let gate_ok = pass >= min_pass;
    // H4 latency budget — p50/p95/avg across scenarios
    let mut sorted: Vec<f64> = rows.iter().map(|(_, _, _, s)| *s).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = sorted.iter().sum::<f64>() / sorted.len() as f64;
    let p50 = sorted[sorted.len() / 2];
    let p95 = sorted[(sorted.len() as f64 * 0.95) as usize % sorted.len()];
    println!(
        "\n== {pass}/{total} pass ({pct:.0}%) — gate {min_pass}/{total} {}",
        if gate_ok { "OK" } else { "FAILED" }
    );
    println!(
        "[latency H4] load {load_s:.1}s | avg {avg:.1}s p50 {p50:.1}s p95 {p95:.1}s | E4B CPU reference: ~9-10 tok/s decode, TTFT 7-8s cold — this model may differ (see PLAN L1/L12)"
    );
    println!("[latency H4] budget suggestion: tool-routing turns <12s, long synthesis via deep_write (cloud) with 600s deadline; see logic/agent.rs REMOTE_TIMEOUT_SECS");

    if let Some(path) = report_path {
        let mut md = String::new();
        md.push_str("# agent_eval — orchestration quality report\n\n");
        md.push_str(&format!(
            "- **date**: {} (unix)\n- **suite**: {suite_name}\n- **model**: `{}` [{}]\n- **load time**: {load_s:.1}s\n- **manifest tools**: {tool_count} (E4B ceiling: 30 — see PLAN L14)\n- **score**: **{pass}/{total} ({pct:.0}%)**\n- **gate**: {min_pass}/{total} — {}\n\n",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            info.model_path,
            info.backend,
            if gate_ok { "PASS" } else { "FAIL" },
        ));
        md.push_str("| scenario | status | note | time |\n|---|---|---|---|\n");
        for (id, ok, note, secs) in &rows {
            md.push_str(&format!(
                "| {id} | {} | {} | {secs:.1}s |\n",
                if *ok { "✅" } else { "❌" },
                note.replace('|', "\\|")
            ));
        }
        if debug_raw && !raws.is_empty() {
            md.push_str("\n## Raw model outputs (failed scenarios, truncated to 600 chars)\n\n");
            for (id, _ok, _note, _) in &rows {
                if let Some(raw) = raws.get(id.as_str()) {
                    md.push_str(&format!("### {id}\n```\n{raw}\n```\n\n"));
                }
            }
        }
        std::fs::write(&path, md).expect("write report");
        println!("report written to {path}");
    }
    if !gate_ok {
        eprintln!("EVAL FAILED: {pass}/{total} below gate {min_pass}/{total}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{check_asserts, get, parse_call};
    use serde_json::json;

    #[test]
    fn get_walks_objects_and_arrays_and_reports_missing() {
        let args = json!({"fileId": "doc1", "aggregations": [{"function": "sum"}], "flag": true});
        assert_eq!(get(&args, "fileId"), Some(&json!("doc1")));
        assert_eq!(get(&args, "aggregations/0/function"), Some(&json!("sum")));
        assert_eq!(get(&args, "missing"), None);
        assert_eq!(get(&args, "aggregations/3/function"), None);
        assert_eq!(get(&args, "fileId/nested"), None);
    }

    #[test]
    fn eq_assert_matches_bool_and_number_scalars() {
        // Regression: the old as_str-only extraction read bool/number args as
        // None, so every descending/limit assert failed unconditionally and
        // A03/A06/A07 were impossible to pass.
        let args = json!({"descending": true, "limit": 5});
        check_asserts(&args, &[("descending", "==true")]).unwrap();
        check_asserts(&args, &[("limit", "==5")]).unwrap();
        assert!(check_asserts(&args, &[("descending", "==false")]).is_err());
        assert!(check_asserts(&args, &[("limit", "==7")]).is_err());
        assert!(check_asserts(&args, &[("nope", "==true")]).is_err());
    }

    #[test]
    fn eq_assert_still_matches_strings() {
        let args = json!({"fileId": "doc2"});
        check_asserts(&args, &[("fileId", "==doc2")]).unwrap();
        assert!(check_asserts(&args, &[("fileId", "==doc1")]).is_err());
    }

    #[test]
    fn membership_regex_and_list_asserts() {
        let args = json!({"operator": "contains", "count": 3, "files": ["doc1", "doc2"]});
        check_asserts(&args, &[("operator", "in:eq|gte|contains")]).unwrap();
        assert!(check_asserts(&args, &[("operator", "in:eq|lt")]).is_err());
        // A present value never satisfies the "None" escape hatch.
        assert!(check_asserts(&args, &[("operator", "in:eq|None")]).is_err());
        // A missing key does.
        check_asserts(&json!({}), &[("absent", "in:eq|None")]).unwrap();
        check_asserts(&args, &[("count", "re:3")]).unwrap();
        assert!(check_asserts(&args, &[("count", "re:^7$")]).is_err());
        check_asserts(&args, &[("files", "==[doc1,doc2]")]).unwrap();
        assert!(check_asserts(&args, &[("files", "==[doc2,doc1]")]).is_err());
    }

    #[test]
    fn parse_call_finds_the_first_call_line() {
        let text = "Sure!\ncall:data_query{\"fileId\":\"doc1\",\"limit\":5}\nextra prose";
        let (name, args) = parse_call(text).unwrap().unwrap();
        assert_eq!(name, "data_query");
        assert_eq!(args["limit"], json!(5));
        assert!(parse_call("no call here").is_none());
        assert!(matches!(parse_call("call:data_{not json"), Some(Err(_))));
    }

    #[test]
    fn accounting_suite_manifest_and_scenarios_are_consistent() {
        use super::{ACCOUNTING_SCENARIOS, ACCOUNTING_TOOLS, Scenario};
        use serde_json::Value;
        use std::collections::BTreeSet;
        let tools: Vec<Value> = serde_json::from_str(ACCOUNTING_TOOLS).unwrap();
        let names: BTreeSet<&str> = tools
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert_eq!(names.len(), tools.len(), "duplicate tool names");
        let mut ids = BTreeSet::new();
        for Scenario(id, _prompt, want_tool, _asserts) in ACCOUNTING_SCENARIOS {
            assert!(ids.insert(*id), "duplicate scenario id {id}");
            if let Some(want) = want_tool {
                assert!(names.contains(want), "{id} expects unknown tool {want}");
            }
        }
        assert_eq!(ACCOUNTING_SCENARIOS.len(), 8);
    }

    #[test]
    fn screener_suite_manifest_and_scenarios_are_consistent() {
        use super::{Scenario, SCREENER_SCENARIOS, SCREENER_TOOLS};
        use serde_json::Value;
        use std::collections::BTreeSet;
        let tools: Vec<Value> = serde_json::from_str(SCREENER_TOOLS).unwrap();
        let names: BTreeSet<&str> = tools
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert_eq!(names.len(), tools.len(), "duplicate tool names");
        // Every asserted argument must be DECLARED by its tool — an eval that
        // asserts an arg the model was never shown grades a hallucination.
        let declared = |tool: &str| -> BTreeSet<String> {
            tools
                .iter()
                .find(|t| t["function"]["name"] == tool)
                .and_then(|t| t["function"]["parameters"]["properties"].as_object())
                .map(|p| p.keys().cloned().collect())
                .unwrap_or_default()
        };
        let mut ids = BTreeSet::new();
        for Scenario(id, _prompt, want_tool, asserts) in SCREENER_SCENARIOS {
            assert!(ids.insert(*id), "duplicate scenario id {id}");
            if let Some(want) = want_tool {
                assert!(names.contains(want), "{id} expects unknown tool {want}");
                let props = declared(want);
                for (path, spec) in *asserts {
                    let key = path.split('/').next().unwrap();
                    assert!(
                        props.contains(key),
                        "{id}: assert on undeclared arg {key} of {want} (spec {spec})"
                    );
                }
            }
        }
        assert_eq!(SCREENER_SCENARIOS.len(), 10);
    }

    /// The manifest is hand-written (the other suites' convention), so the
    /// argument NAMES and enums must match the shipped toolset — drift here
    /// would grade the model against an API that does not exist.
    #[cfg(feature = "binance")]
    #[test]
    fn screener_suite_manifest_matches_the_binance_tools() {
        use serde_json::Value;
        let manifest: Vec<Value> = serde_json::from_str(super::SCREENER_TOOLS).unwrap();
        let real = binance::registry::all_tools("eval");
        for def in real.get_tool_definitions() {
            let Some(entry) = manifest.iter().find(|t| t["function"]["name"] == def.name) else {
                continue;
            };
            let shown = entry["function"]["parameters"]["properties"]
                .as_object()
                .expect("manifest properties");
            let shipped = def.parameters["properties"]
                .as_object()
                .expect("tool properties");
            for (key, prop) in shown {
                let actual = shipped
                    .get(key)
                    .unwrap_or_else(|| panic!("{}: manifest declares undeclared arg {key}", def.name));
                if let Some(want) = prop["enum"].as_array() {
                    let got: Vec<&str> = actual["enum"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                        .unwrap_or_default();
                    for v in want {
                        assert!(
                            got.contains(&v.as_str().unwrap_or_default()),
                            "{}: enum value {v} missing from the shipped schema",
                            def.name
                        );
                    }
                }
                // Same JSON type, so a number/string mix-up cannot pass.
                assert_eq!(
                    prop["type"], actual["type"],
                    "{}: arg {key} type drifted",
                    def.name
                );
            }
        }
    }
}
