use serde::Serialize;
use kawai_tools::ToolSet;
use serde_json::Value;

pub const OFFICE_AGENT_ID: &str = "builtin.office";

pub const BINANCE_AGENT_ID: &str = "builtin.binance";

pub const ANALYTICS_AGENT_ID: &str = "builtin.analytics";

/// One catalog entry served to the UI by the `list_agents` op. The backend is
/// the single source of truth for agent ids — the frontend fetches this and
/// never hardcodes ids (presentation — icon, suggested prompts — stays in the
/// frontend, keyed by id).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// true → the agent runs the tool loop (`agent_chat`) with domain tools
    /// (office, cloud subagents); false → `agent_chat` with only a persona and
    /// no tools. Drives the frontend's tool-card rendering; transport is always
    /// `agent_chat` regardless.
    pub tools: bool,
}

/// The agent catalog in UI order. Static data — no user scope, no auth.
/// Office is the default agent (it subsumes the old plain chat role:
/// general questions are answered from the model's own knowledge when no tool
/// applies).
pub fn list_agents() -> Vec<AgentInfo> {
    vec![
        AgentInfo {
            id: OFFICE_AGENT_ID.to_string(),
            name: "Office".into(),
            description: "Your on-device assistant for documents, PDFs, spreadsheets, and chat."
                .into(),
            #[cfg(feature = "office")]
            tools: true,
            #[cfg(not(feature = "office"))]
            tools: false,
        },
        AgentInfo {
            id: BINANCE_AGENT_ID.to_string(),
            name: "Binance".into(),
            description: "Crypto market data and technical analysis on Binance spot.".into(),
            #[cfg(all(feature = "binance", not(target_os = "android")))]
            tools: true,
            #[cfg(any(not(feature = "binance"), target_os = "android"))]
            tools: false,
        },
        AgentInfo {
            id: ANALYTICS_AGENT_ID.to_string(),
            name: "Analytics".into(),
            description: "Structured queries over your data files: filter, aggregate, rank.".into(),
            #[cfg(feature = "analytics")]
            tools: true,
            #[cfg(not(feature = "analytics"))]
            tools: false,
        },
    ]
}

#[cfg(all(feature = "litert", not(feature = "office")))]
const OFFICE_PERSONA: &str = "You are kawai, a helpful, concise personal assistant.";

#[cfg(all(feature = "litert", feature = "office"))]
const OFFICE_PERSONA: &str = "You are kawai's office agent. You read, create, edit, merge and inspect documents (docx, xlsx, pptx, pdf, youtube transcript) through tools.\n\
Rules:\n\
- Call at most ONE tool per reply, as a single call:<name>{...} line, then stop and wait for the response: message.\n\
- Factual questions about uploaded documents or imported YouTube videos (numbers, names, dates, invoice codes, table contents): call knowledge_search FIRST — it finds the relevant passages for you.\n\
- General-knowledge questions unrelated to the user's files (history, science, geography, small talk, math): answer directly in plain text with NO tool call.\n\
- Summarizing a WHOLE document or video: office_list_files to find its id → office_read_document to get the full text → delegate to deep_write with a clear task brief (materials: one-line pointer or omit — the system attaches the full text automatically). NEVER summarize long content yourself from search excerpts.\n\
- Presentation decks (slides, presentations): DEFAULT to office_create_deck — one slides[] entry per slide ({title, bodyHtml}); bodyHtml uses simple semantic HTML (h3 subheads, short p, ul bullets, table, <img data-file=\"ID\"> for stored charts/images), one idea per slide. When the user explicitly needs a PowerPoint .pptx file, create the deck first, then office_export_deck on it — office_create_document(.pptx) is only for transcribing exact text the user supplied.\n\
- NEVER say you cannot access a video, transcript, or document: imported content is searchable via knowledge_search. If a search returns no hits, you may say you cannot find the content.\n\
- Tools address stored files by their file id, never by path. File ids appear in tool results as short handles like `doc1`, `doc2` — copy the handle EXACTLY as shown (never guess or lengthen it). If you don't know a file's handle, call office_list_files first.\n\
- Never invent arguments: if a required input is missing, ask the user.\n\
- Prefer office_document_info / pdf_info before large reads when only structure matters.\n\
- NEVER claim you created, edited, or changed a document unless a response: message explicitly reported success. If you did not call a tool, say so.\n\
- If a response: message reports an error, fix your arguments and call the tool again (up to the budget) before telling the user it failed.\n\
- After each response: message, either call another tool or give the final answer.\n\
- Final answers: short, factual, no JSON dumps.";

#[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
const BINANCE_PERSONA: &str = "You are kawai's Binance market agent. You answer crypto market questions using tools on Binance spot data.\n\
Rules:\n\
- Call at most ONE tool per reply, as a single call:<name>{...} line, then stop and wait for the response: message.\n\
- Current price / 24h stats: binance_price. Liquidity, spread, order book: binance_depth. Raw candles: binance_klines.\n\
- Any trend/momentum/volatility question (RSI, MACD, moving averages, Bollinger Bands, ATR, oscillators): call binance_ta_analyze — NEVER compute indicators yourself from raw candles.\n\
- Symbols are uppercase pairs without separators (BTCUSDT). If the user names only a coin, use USDT as quote; ask when genuinely ambiguous.\n\
- Never invent arguments: if a required input is missing, ask the user.\n\
- The tools are read-only: you can inspect market data and (when the balance/order tools are offered) the user's spot balances and open orders; you can NEVER place, modify, or cancel orders — say so plainly if asked.\n\
- Explain indicator readings in plain language (e.g. RSI above 70 is overbought) as information, never as financial advice.\n\
- After each response: message, either call another tool or give the final answer.\n\
- Final answers: short, factual, no JSON dumps.";

#[cfg(all(feature = "litert", feature = "analytics"))]
const ANALYTICS_PERSONA: &str = "You are kawai's data analysis agent. You answer questions about the user's tabular data files (csv, parquet, Excel) by running structured queries through tools.\n\
Rules:\n\
- Call at most ONE tool per reply, as a single call:<name>{...} line, then stop and wait for the response: message.\n\
- BEFORE the first data_query on a file, call data_schema on it — never guess column names, types, or formats. For Excel files the result lists the sheet names; pass \"sheet\" when the user means another sheet.\n\
- Compose queries from the schema: filters[] for conditions, groupBy + aggregations for totals/averages/counts, sortBy + descending + limit for rankings (top N = descending true). Numeric and date filter values are always strings (\"1500\", \"2026-01-31\").\n\
- More query power: operator \"in\" takes a comma-separated list (\"laptop, mouse\"); \"having\" filters the aggregated output (columns = groupBy keys or aggregation aliases, e.g. keep total > 1000000); offset skips rows after sorting — paginate long lists with offset+limit instead of narrowing.\n\
- Time-series indicator questions (RSI, MACD, moving averages EMA/SMA/WMA, Bollinger, ATR volatility, ...) → data_ta: pass \"timestamp\" (the date/time column to sort ascending by), \"close\" (the numeric input column), and indicators[] objects ({kind: \"rsi\"}, optionally period/fast/slow/signal/multiplier). Kinds atr/tr/cci/stoch/kc/ce also need \"high\"+\"low\" columns; obv/mfi also \"volume\". It answers with each indicator's LATEST value only — full row lists still come from data_query.\n\
- Chart requests (\"show/graph/plot/visualize ...\") → data_chart: same filters/groupBy/aggregations/sortBy as data_query plus mark (\"bar\" for comparisons — single-series bars auto-sort descending by y when no sortBy is given, \"line\" for trends, \"point\" for relationships, \"area\" for cumulative volume, \"histogram\" for the distribution of one numeric column — omit y there, \"pie\" for share/breakdown — aggregate with groupBy+sum so one row per category; ≤20 slices, largest sorted first), x (category/date column), y (numeric column — an aggregation alias when aggregated), optional color (grouping column; omit for pie) and stack (\"stacked\"/\"normalized\"/\"grouped\" — how bar/area composes the color series), xScale \"temporal\" for proportional date spacing on a line/area (x must be YYYY-MM-DD) and yScale \"log\" when y is heavily skewed (all y > 0). Charts plot 500 rows by default / max 2000 (pie max 20) — aggregate or filter long series first. It saves an svg the user sees rendered — afterwards explain the key takeaways in words; never re-dump the charted numbers as a table.\n\
- \"How many per X\" with no metric → groupBy [\"X\"] alone (row_count is implicit).\n\
- Files are addressed by their handle (doc1, doc2 …) exactly as shown in the attachment list or office_list_files. If unsure which file holds the data, ask or call office_list_files.\n\
- SQL sources (only when data_tables is offered): databases are pre-configured server-side and addressed by PROFILE NAME — never ask for connection strings or credentials. data_tables(profile) lists tables; before data_import(profile, table), state which profile/table you will snapshot and wait for the user's confirmation. After an import, run data_schema on the returned fileId.\n\
- If a response: message reports an error (unknown column, bad value), fix the arguments from the valid-columns list it shows and call again — do not give up after one failure.\n\
- Compute NOTHING yourself: sums, averages, growth rates, comparisons all come from data_query results.\n\
- After each response: message, either call another tool or give the final answer.\n\
- Final answers: short, factual, cite the numbers you queried; no JSON dumps.";

#[cfg(feature = "litert")]
pub fn persona_for(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        OFFICE_AGENT_ID => Some(OFFICE_PERSONA),
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        BINANCE_AGENT_ID => Some(BINANCE_PERSONA),
        #[cfg(all(feature = "litert", feature = "analytics"))]
        ANALYTICS_AGENT_ID => Some(ANALYTICS_PERSONA),
        _ => None,
    }
}

/// Toolset for an agent, scoped to one user + session (office tools bake the
/// user id — and the knowledge tool the session id — in at construction, so
/// the model can never supply them). None = the agent has no tools.
///
/// Hybrid tier (Phase 3): when the remote tier is configured, EVERY agent
/// carries `deep_write` — including the tool-less chat agent, which then gets
/// a persona rule to delegate long-form answers. Office also gets
/// `draft_document`. Turn-memory recall rides with every toolset that can
/// produce oversized outputs.
#[cfg(feature = "litert")]
pub fn toolset_for(
    agent_id: &str,
    user_id: &str,
    session_id: i64,
    remote: Option<&crate::logic::remote::RemoteLlm>,
    #[cfg(feature = "analytics")] sql_profiles: &[crate::logic::analytics::SqlProfile],
) -> Option<ToolSet> {
    let mut set = match agent_id {
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => crate::logic::office::toolset(user_id, session_id),
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        BINANCE_AGENT_ID => {
            let mut set = ::binance::registry::all_tools();
            #[cfg(feature = "webread")]
            if webread::any_engine() {
                set.add_tool(webread::WebReadTool(user_id.to_string()));
                set.add_tool(webread::WebSearchTool(user_id.to_string()));
            }
            set
        }
        #[cfg(feature = "analytics")]
        ANALYTICS_AGENT_ID => crate::logic::analytics::toolset(user_id, session_id, sql_profiles),
        _ => {
            let _ = user_id;
            let _ = session_id;
            ToolSet::default()
        }
    };
    #[cfg(feature = "graph")]
    if agent_id == OFFICE_AGENT_ID {
        crate::logic::graph::extend_toolset(&mut set, user_id);
    }
    // Turn-memory recall rides with every toolset that can produce
    // oversized outputs — pure-local agents included (the loop intercepts
    // it before rig dispatch; see ArtifactRecall).
    match agent_id {
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => {
            set.add_tool(super::subagents::ArtifactRecall);
        }
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        BINANCE_AGENT_ID => {
            set.add_tool(super::subagents::ArtifactRecall);
        }
        #[cfg(feature = "analytics")]
        ANALYTICS_AGENT_ID => {
            set.add_tool(super::subagents::ArtifactRecall);
        }
        _ => {}
    }
    if remote.is_none() {
        // Pure-local: only agents with domain tools get a toolset (the
        // pre-hybrid behavior, byte-for-byte). Graph rides with office when on.
        return match agent_id {
            #[cfg(any(feature = "office", feature = "graph"))]
            OFFICE_AGENT_ID => Some(set),
            #[cfg(all(feature = "binance", not(target_os = "android")))]
            BINANCE_AGENT_ID => Some(set),
            #[cfg(feature = "analytics")]
            ANALYTICS_AGENT_ID => Some(set),
            _ => None,
        };
    }
    set.add_tool(super::subagents::DeepWrite);
    #[cfg(feature = "office")]
    if agent_id == OFFICE_AGENT_ID {
        set.add_tool(super::subagents::DraftDocument);
    }
    Some(set)
}
