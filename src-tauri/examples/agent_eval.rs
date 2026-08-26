// H1 orchestration-quality eval (PLAN-local-llm-orchestrator.md L12/H9): a
// fixed 20-scenario office workload run against a .litertlm model, scored on
// tool selection, arguments, aliases, ordering, and refusal shape. One model
// load, one conversation reset per scenario. Baseline: E4B 20/20 (100%).
// Usage: cargo run --release --example agent_eval --features litert,office -- /path/to/model.litertlm
// (needs `office` for the regex crate; the scenario set mirrors the crates office schema)
use futures_util::StreamExt;
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
///   "==value"      — string equality
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
Examples of the exact reply format — ONE call:<name>{...} line per reply:\n\
User: Show the top 3 products by total revenue.\ncall:data_query{\"fileId\":\"doc1\",\"groupBy\":[\"produk\"],\"aggregations\":[{\"column\":\"pendapatan\",\"function\":\"sum\",\"alias\":\"total\"}],\"sortBy\":\"total\",\"descending\":true}\n\
User: Show me the first 5 rows with only produk and pendapatan.\ncall:data_query{\"fileId\":\"doc1\",\"columns\":[\"produk\",\"pendapatan\"],\"limit\":5}\n\
User: Compute RSI(14).\ncall:data_ta{\"fileId\":\"doc3\",\"timestamp\":\"ts\",\"close\":\"close\",\"indicators\":[{\"kind\":\"rsi\"}]}\n";

const ANALYTICS_TOOLS: &str = r#"[
  {"type":"function","function":{"name":"data_schema","description":"REQUIRED before the first data_query on a file. Returns the column names, data types, sample values and row count of a stored tabular file (csv/parquet/Excel), plus the sheet names for Excel files.","parameters":{"type":"object","properties":{"fileId":{"type":"string","description":"File id from office_list_files or the attachment block"},"sheet":{"type":"string","description":"Excel sheet name. Optional — defaults to the first sheet with data."}},"required":["fileId"]}}},
  {"type":"function","function":{"name":"data_query","description":"Run a structured query on a stored tabular file (csv/parquet/Excel): filter rows, optionally group, aggregate (sum/avg/min/max/count/count_distinct), sort, and limit. Call data_schema first to learn the columns.","parameters":{"type":"object","properties":{"fileId":{"type":"string"},"sheet":{"type":"string"},"columns":{"type":"array","items":{"type":"string"}},"filters":{"type":"array","items":{"type":"object","properties":{"column":{"type":"string"},"operator":{"type":"string","enum":["eq","neq","gt","gte","lt","lte","contains"]},"value":{"type":"string"}},"required":["column","operator","value"]}},"groupBy":{"type":"array","items":{"type":"string"}},"aggregations":{"type":"array","items":{"type":"object","properties":{"column":{"type":"string"},"function":{"type":"string","enum":["sum","avg","min","max","count","count_distinct"]},"alias":{"type":"string"}},"required":["column","function","alias"]}},"sortBy":{"type":"string"},"descending":{"type":"boolean"},"limit":{"type":"integer"}},"required":["fileId"]}}},
  {"type":"function","function":{"name":"data_ta","description":"Compute technical-analysis indicators (EMA/SMA/WMA, RSI, MACD, PPO, Bollinger, Keltner, ChandelierExit, ATR, TrueRange, CCI, stochastic, MFI, OBV, ROC, SD, MAD, ER, rolling max/min) over a numeric time series in a stored tabular file. Indicators are stateful — pass timestamp (a date column to sort ascending by) unless rows are already ordered. Returns only each indicator's final value plus skip reasons; call data_schema first to learn the columns.","parameters":{"type":"object","properties":{"fileId":{"type":"string"},"sheet":{"type":"string"},"timestamp":{"type":"string","description":"Column to sort ascending by before folding"},"close":{"type":"string","description":"Required numeric input column"},"high":{"type":"string","description":"Required when using atr/tr/cci/stoch/kc/ce/mfi"},"low":{"type":"string","description":"Required when using atr/tr/cci/stoch/kc/ce/mfi"},"volume":{"type":"string","description":"Required when using obv/mfi"},"indicators":{"type":"array","minItems":1,"items":{"type":"object","properties":{"kind":{"type":"string","enum":["ema","sma","wma","rsi","roc","sd","mad","er","max","min","macd","ppo","bb","atr","tr","cci","stoch","stoch_slow","kc","ce","obv","mfi"]},"column":{"type":"string"},"period":{"type":"integer"},"fast":{"type":"integer"},"slow":{"type":"integer"},"signal":{"type":"integer"},"multiplier":{"type":"number"},"alias":{"type":"string"}},"required":["kind"]}}},"required":["fileId","close","indicators"]}}},
  {"type":"function","function":{"name":"office_list_files","description":"List the user's stored files. Returns id, originalName, ext, bytes, createdAt.","parameters":{"type":"object","properties":{},"required":[]}}}
]"#;

const NONE_A: &[(&str, &str)] = &[];

#[allow(clippy::type_complexity)]
const ANALYTICS_SCENARIOS: &[Scenario] = &[
    // Discovery-first discipline.
    Scenario("A01 schema-first", "What columns does sales_2026.csv have?", Some("data_schema"),
        &[("fileId", "==doc1")]),
    // Single aggregate without grouping → plain select.
    Scenario("A02 sum-all", "What is the total revenue across all rows?", Some("data_query"),
        &[("fileId", "==doc1"), ("aggregations/0/function", "==sum"), ("aggregations/0/column", "==pendapatan")]),
    // Group + rank: top-N shape (descending true, bounded).
    Scenario("A03 group-rank", "Show the top 3 products by total revenue.", Some("data_query"),
        &[("fileId", "==doc1"), ("groupBy/0", "==produk"), ("aggregations/0/function", "==sum"), ("descending", "==true")]),
    // Implicit row_count: group_by alone, no metric invented.
    Scenario("A04 count-per-group", "How many rows are there for each kategori?", Some("data_query"),
        &[("fileId", "==doc1"), ("groupBy/0", "==kategori")]),
    // Date range from a natural-language month (gte the month start). Names
    // the dataset ("sales") — "transactions" would collide with doc2's name.
    Scenario("A05 date-filter", "Show only the January 2026 rows from the sales CSV.", Some("data_query"),
        &[("fileId", "==doc1"), ("filters/0/value", "re:2026-01"), ("filters/0/operator", "in:gte|gt|eq")]),
    // Avg per group, ranked.
    Scenario("A06 avg-per-group", "Average revenue per product, highest first.", Some("data_query"),
        &[("fileId", "==doc1"), ("groupBy/0", "==produk"), ("aggregations/0/function", "==avg"), ("descending", "==true")]),
    // Row-selection mode: projected columns + limit, no aggregation.
    Scenario("A07 row-select", "Show me the first 5 rows of sales_2026.csv with only produk and pendapatan.", Some("data_query"),
        &[("fileId", "==doc1"), ("columns/0", "==produk"), ("columns/1", "==pendapatan"), ("limit", "==5")]),
    // Excel sheet targeting through data_schema.
    Scenario("A08 sheet-select", "What columns are in the Returns sheet of transactions.xlsx?", Some("data_schema"),
        &[("fileId", "==doc2"), ("sheet", "==Returns")]),
    // Technical-analysis selection: momentum on the close series, with the
    // timestamp-sort discipline the stateful folds require.
    Scenario("A09 ta-rsi", "Is prices_2026.csv overbought or oversold right now? Compute RSI(14).", Some("data_ta"),
        &[("fileId", "==doc3"), ("close", "==close"), ("timestamp", "==ts"), ("indicators/0/kind", "==rsi")]),
    // Volatility needs the high/low role columns, not just close.
    Scenario("A10 ta-atr", "How volatile is the price in prices_2026.csv? Compute ATR(14).", Some("data_ta"),
        &[("fileId", "==doc3"), ("indicators/0/kind", "==atr"), ("high", "==high"), ("low", "==low")]),
    // Multi-param momentum default (fast/slow/signal omitted → defaults).
    Scenario("A11 ta-macd", "Compute MACD on the close prices of prices_2026.csv.", Some("data_ta"),
        &[("fileId", "==doc3"), ("close", "==close"), ("indicators/0/kind", "==macd")]),
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
            let got = v.and_then(Value::as_str);
            if got != Some(want) {
                return Err(format!("{path}={got:?} != {want:?}"));
            }
        }
    }
    Ok(())
}

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
    let debug_raw = std::env::var("EVAL_DEBUG").map(|v| v == "1").unwrap_or(false);

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
            ("analytics", ANALYTICS_SYSTEM, ANALYTICS_TOOLS, ANALYTICS_SCENARIOS)
        } else {
            ("office", SYSTEM, TOOLS, SCENARIOS)
        };
    let tool_count = serde_json::from_str::<Vec<Value>>(tools_json).unwrap().len();
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
