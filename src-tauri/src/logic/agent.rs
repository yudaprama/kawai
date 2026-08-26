//! Prompt-based tool-calling agent loop (the Roadmap-5 slice).
//!
//! The LiteRT-LM Conversation API has no native function calling, so tools are
//! declared in the prompt and the model replies with a `call:NAME{json}` line —
//! the compact tool-call body Gemma 4 was trained on. The loop: send user
//! message → stream tokens → on completion, parse the call (the parser also
//! accepts the Gemma special-token wrappers and the legacy ```tool fence) →
//! dispatch via a rig `ToolSet` → feed the result back as a `response:NAME:`
//! message → repeat until a call-free reply (final answer), a malformed-call
//! failure after one repair, or the tool budget runs out.
//!
//! # Context economy (the conversation is stateful!)
//!
//! Every token prefilled into the Conversation API occupies a K/V state entry
//! permanently — repeating content is a leak. The loop therefore runs an
//! opener/delta protocol keyed by a manifest key (`agent:session`), tracked in
//! `local_llm` alongside the conversation epoch:
//!
//! - **Opener** (only when the manifest is NOT in the current conversation
//!   state): persona + tool manifest + call protocol + a compacted transcript
//!   of the session's prior turns (rebuilt from SQLite — the DB is the source
//!   of truth, the conversation is a disposable cache). This covers the first
//!   turn, a session/agent switch (frontend resets), an app restart, and
//!   recovery below.
//! - **Delta** (manifest already injected): just the message / tool result.
//!
//! **Overflow recovery:** when a generation fails with a prefill-overflow
//! error (context full), the conversation is reset (fresh epoch) and the turn
//! retried ONCE with a smaller transcript budget. If that still overflows the
//! turn fails with the original error.
//!
//! Persistence: the user message and the FINAL assistant answer are appended
//! to the sessions/messages tables (same schema as the plain chat); tool
//! chatter is ephemeral UI events.
//!
//! # Hybrid tier: cloud subagents (`remote`)
//!
//! When the remote tier is configured (`logic::remote::RemoteLlm::from_env`),
//! every tool-carrying agent also gets the `deep_write` subagent — a tool
//! whose implementation streams one stateless cloud completion (PLAN
//! `PLAN-hybrid-llm-subagents.md`). Division of labor: local plans (emits
//! short call: lines; `materials` stays a one-line pointer — the loop
//! attaches the turn's full tool results deterministically); cloud writes
//! the long-form answer. A `deep_write` result is FINAL (`final:true`
//! passthrough): its tokens stream straight to the user, are persisted as
//! the assistant message, and local never rewrites them. Chat history is
//! never sent — only the task + materials package. On cloud failure the
//! turn degrades to local (fed back as a normal response: error), and a
//! twice-malformed call on a heavy turn escalates to `deep_write` instead
//! of failing.

#[cfg(feature = "litert")]
use crate::logic::db;
#[cfg(feature = "litert")]
use futures_core::Stream;
#[cfg(feature = "litert")]
use futures_util::StreamExt;
#[cfg(feature = "litert")]
#[cfg(feature = "litert")]
use kawai_tools::ToolSet;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(feature = "litert")]
/// Max tool dispatches per user turn before forcing a final answer. Sized for
/// multi-step workflows (list → read → read → delegate) without letting a
/// tool-looping model spin forever.
const MAX_TOOL_CALLS: usize = 8;
#[cfg(feature = "litert")]
/// How many chars of a tool result are echoed into the UI event.
const TOOL_RESULT_UI_CHARS: usize = 500;

/// Upper bound on the structured `data` payload riding a ToolResult event.
/// Generous enough for a full `data_query` row set (engine-capped at 30k
/// chars), small enough to keep IPC trivial.
const TOOL_RESULT_DATA_CHARS: usize = 32_000;

/// Parse a successful tool body into a structured UI payload. Only whole
/// JSON objects/arrays qualify (scalar strings render fine as summaries);
/// oversized documents fall back to the summary path.
fn ui_payload(body: &str) -> Option<serde_json::Value> {
    let v = serde_json::from_str::<serde_json::Value>(body).ok()?;
    if !v.is_object() && !v.is_array() {
        return None;
    }
    if serde_json::to_string(&v).ok()?.len() > TOOL_RESULT_DATA_CHARS {
        return None;
    }
    Some(v)
}
#[cfg(feature = "litert")]
/// Cap on a tool result fed BACK into the conversation (chars). Tool outputs
/// reach 60k chars (office_read_document) — uncapped, a single call
/// permanently burns the K/V budget. When capped, the model is told to
/// narrow its query.
    const TOOL_RESULT_MODEL_CHARS: usize = 4000;
    #[cfg(feature = "litert")]
    /// Fallback/floor budget for the cloud-materials package when no remote
    /// pool is configured to ask for a bigger one. The REAL package budget
    /// comes from `RemoteLlm::materials_budget()` (per-provider floors).
    const TOOL_RESULT_MATERIALS_CHARS: usize = 32_000;
    #[cfg(feature = "litert")]
    /// Per-entry storage cap in the turn log (chars). Deliberately larger
    /// than any single package budget: entries are stored WHOLE so a
    /// whole-doc read survives verbatim for the cloud writer; the package
    /// selection decides what fits, not the recorder.
    const TOOL_RESULT_ENTRY_MAX_CHARS: usize = 96_000;
#[cfg(feature = "litert")]
/// Per-message cap inside a replayed transcript (all but the newest message).
const TRANSCRIPT_MSG_CHARS: usize = 2000;
#[cfg(feature = "litert")]
/// Cap for the NEWEST message in a replayed transcript — usually the previous
/// assistant answer (often a long cloud-written artifact). Follow-ups like
/// "shorten what you just wrote" need far more of it than 2000 chars.
const TRANSCRIPT_LAST_MSG_CHARS: usize = 6000;
#[cfg(feature = "litert")]
/// Char budget for the replayed transcript when opening a conversation epoch
/// (first turn, session switch, restart).
const TRANSCRIPT_BUDGET_CHARS: usize = 6000;
#[cfg(feature = "litert")]
/// Smaller budget for the retry after an overflow — it MUST fit.
const TRANSCRIPT_BUDGET_RETRY_CHARS: usize = 3000;

/// Cloud subagent budget per user turn (v1: one delegation per turn, shared
/// across all subagent tools).
#[cfg(feature = "litert")]
const MAX_SUBAGENT_CALLS: usize = 1;
/// The deep_write subagent tool name (dispatch is special-cased in the loop).
#[cfg(feature = "litert")]
const DEEP_WRITE_TOOL: &str = "deep_write";
/// The draft_document subagent tool name (office-gated; writes a real file).
#[cfg(feature = "litert")]
const DRAFT_DOCUMENT_TOOL: &str = "draft_document";
/// The turn-memory recall tool name (dispatch is special-cased in the loop).
#[cfg(feature = "litert")]
const ARTIFACT_RECALL_TOOL: &str = "artifact_recall";
/// The SQL snapshot tool name (analytics-gated; dispatch is intercepted
/// behind an explicit user confirmation).
#[cfg(all(feature = "litert", feature = "analytics"))]
const DATA_IMPORT_TOOL: &str = "data_import";
/// Overall wall-clock deadline for one cloud subagent call.
#[cfg(feature = "litert")]
const REMOTE_TIMEOUT_SECS: u64 = 600;
/// Cap on the draft JSON the cloud may return (chars) — guards absurd output.
#[cfg(feature = "litert")]
const DRAFT_JSON_MAX_CHARS: usize = 120_000;
/// Cap on the cloud-subagent reasoning text surfaced to the UI (chars).
/// Display-only: never persisted, never fed into the local conversation.
#[cfg(feature = "litert")]
const SUBAGENT_THINKING_MAX_CHARS: usize = 16_000;
#[cfg(feature = "litert")]
/// Inline excerpt in the handle response for an oversized tool result.
const ARTIFACT_EXCERPT_CHARS: usize = 3_200;
#[cfg(feature = "litert")]
/// Chars served per `artifact_recall` page.
const ARTIFACT_PAGE_CHARS: usize = 3_600;
#[cfg(feature = "litert")]
/// Memory-log payload (chars) a turn must gather before the end-of-turn cloud
/// close is offered. Keeps trivial turns (list files, price checks) local.
const CLOUD_CLOSE_MIN_CHARS: usize = 6_000;
#[cfg(feature = "litert")]
    /// Headroom carved out of the materials package for the omission note whenever
    /// any artifact doesn't fit. Worst case ≈ MAX_TOOL_CALLS entries × ~50 chars
    /// of listing each — far below this reserve.
    const MATERIALS_NOTE_RESERVE: usize = 600;
    #[cfg(feature = "litert")]
    /// Marker identifying a package that omitted stored artifacts — also the
    /// trigger for the deep_write staging round (the writer may fetch what
    /// was omitted before composing).
    const MATERIALS_NOTE_MARKER: &str = "[MATERIALS NOTE:";
    #[cfg(feature = "litert")]
    /// Max slices one deep_write staging round may request (each page is
    /// ARTIFACT_PAGE_CHARS) — bounds the extra latency + prompt growth.
    const STAGING_MAX_REQUESTS: usize = 6;

/// One "--- tool ---" block of the cloud-materials package.
#[cfg(feature = "litert")]
fn artifact_block(a: &TurnArtifact) -> String {
    format!("--- {} ---\n{}", a.tool, a.content)
}

/// Distinct lowercase terms (≥3 alphanumeric chars) from the user's message —
/// the relevance signal for materials packing. Order-preserving and capped;
/// pure heuristic on purpose.
#[cfg(feature = "litert")]
fn focus_terms(message: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for term in message.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if term.chars().count() >= 3 && !out.iter().any(|t| t == term) {
            out.push(term.to_string());
            if out.len() >= 32 {
                break;
            }
        }
    }
    out
}

/// Relevance score of one artifact for the package: distinct focus-term hits
/// dominate, recency breaks ties (later entries carry more of the turn's
/// conclusion). Deterministic — same log + message ⇒ same package.
#[cfg(feature = "litert")]
fn relevance_score(a: &TurnArtifact, terms: &[String], idx: usize) -> usize {
    if terms.is_empty() {
        return idx;
    }
    let body = a.content.to_lowercase();
    let tool = a.tool.to_lowercase();
    let hits = terms
        .iter()
        .filter(|t| body.contains(t.as_str()) || tool.contains(t.as_str()))
        .count();
    hits * 8 + idx
}

/// Does the user's message ask for a whole-content summary? Keyword gate
/// (id + en) — deliberately cheap; it only gates an in-context NUDGE, never
/// a silent auto-action, so a false positive just makes the model re-check.
#[cfg(feature = "litert")]
fn is_summary_request(message: &str) -> bool {
    let m = message.to_lowercase();
    ["ringkas", "rangkum", "summar", "tldr", "tl;dr"]
        .iter()
        .any(|k| m.contains(k))
}

/// Does the user's message affirmatively agree to proceed? Word-token gate
/// (id + en) backing the data_import confirmation: "ya, lanjutkan" passes,
/// "yang" does not. Only gates a tool that re-asks when wrong — a miss just
/// means one extra confirmation round.
#[cfg(all(feature = "litert", feature = "analytics"))]
fn is_affirmative(message: &str) -> bool {
    const WORDS: [&str; 15] = [
        "ya", "yes", "y", "ok", "oke", "okay", "setuju", "lanjut", "lanjutkan", "confirm",
        "proceed", "sure", "silakan", "silahkan", "gas",
    ];
    message
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|t| WORDS.contains(&t))
}

/// Directive appended to a successful knowledge_search response: when the
/// user asked for a summary, excerpts are not enough — the model must read
/// the full document (file id resolved from the hit) and delegate the
/// writing to deep_write. In-context + id-resolved beats a persona rule the
/// small model ignores.
#[cfg(feature = "litert")]
fn summary_directive(first_file_id: &str) -> String {
    format!(
        "\n\nSUMMARY DIRECTIVE: the user asked for a summary — these excerpts are NOT enough. \
         Next: call:office_read_document{{\"fileId\": \"{first_file_id}\"}} to get the full text, \
         then call:deep_write with a clear task brief (keep materials a one-line pointer or omit it — \
         the full text is attached to the writer automatically). Do NOT answer from excerpts."
    )
}

/// First `fileId` inside a knowledge_search result body (the tool returns
/// `{"hits":[{"fileId": ...}, ...]}` as a JSON string).
#[cfg(feature = "litert")]
fn first_file_id(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("hits")?
        .as_array()?
        .iter()
        .find_map(|h| {
            h.get("fileId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
}

/// Prompt block listing user-attached files (@-mentions). Ids are resolved
/// server-side (never trusted raw) and exposed to the model as short alias
/// handles (`doc1`, …) — the model copies these reliably, unlike the real
/// 23-char store ids. Dispatch resolves the handle back to the real id.
#[cfg(feature = "litert")]
#[allow(unused_variables)]
fn attachment_prompt_block(sid: i64, ids: &[String]) -> String {
    #[cfg(feature = "office")]
    if !ids.is_empty() {
        let lines: Vec<String> = ids
            .iter()
            .map(|id| format!("- {}", alias_assign(sid, id)))
            .collect();
        return format!(
            "[files attached by the user for THIS message — use these exact handles \
             with the file tools; no need to search for them]\n{}",
            lines.join("\n")
        );
    }
    #[allow(unreachable_code)]
    String::new()
}

/// Did the model's `materials` already embed the turn's tool results
/// verbatim? Probes a mid-slice of the accumulation — a paraphrase never
/// contains the raw probe, a verbatim paste always does.
#[cfg(feature = "litert")]
fn materials_embeds_results(materials: &str, results: &str) -> bool {
    let r_chars: Vec<char> = results.chars().collect();
    if r_chars.len() < 400 {
        return materials.contains(results);
    }
    let probe: String = r_chars[r_chars.len() / 2..r_chars.len() / 2 + 200]
        .iter()
        .collect();
    materials.contains(&probe)
}

/// Parse `artifact_recall` args into (handle, offset). `None` when the handle
/// is missing/blank — the caller feeds a teaching error back to the model.
#[cfg(feature = "litert")]
fn recall_args(args: &Value) -> Option<(String, usize)> {
    let handle = args
        .get("handle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|h| !h.is_empty())?;
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    Some((handle.to_string(), offset))
}

/// End-of-turn cloud close eligibility (PLAN-turn-scoped-tool-memory §3.4):
/// the turn's process log carries real payload, the cloud tier is configured,
/// and the per-turn subagent budget is untouched. When eligible, the
/// tool-result feedback and budget-exhausted prompts direct the model to
/// deliver the final answer via `deep_write` — the cloud writer synthesizes
/// from the full log (rendered as materials), not from the excerpts local saw.
#[cfg(feature = "litert")]
fn cloud_close_eligible(
    remote_configured: bool,
    subagent_calls_used: usize,
    memory: &TurnMemory,
) -> bool {
    remote_configured
        && subagent_calls_used == 0
        && memory.total_content_chars() >= CLOUD_CLOSE_MIN_CHARS
}

/// Persona of the deep_write subagent (the cloud writer). Runs on the remote
/// model — it never sees the chat history, only the task + materials package.
#[cfg(feature = "litert")]
const DEEP_WRITE_SYSTEM: &str = "You are a long-form analytical writer embedded in an on-device assistant. \
Write the requested artifact from the task brief and the provided materials. \
Rules:\n\
- Ground every claim in the materials when they are provided; use general knowledge only to fill gaps.\n\
- If the materials are insufficient for part of the task, complete the rest and note the gap briefly.\n\
- Output ONLY the requested artifact in clean markdown. No preamble, no meta commentary, no code fences around the whole answer.\n\
- Match the requested structure, audience and length from the task brief.";

/// Staging persona for the deep_write two-phase round. When the base package
/// carried omissions, the cloud writer FIRST states what else it needs (or
/// that it is ready) — the resolved slices ride into the real writing call,
/// so composition never starts from a knowingly incomplete package.
#[cfg(feature = "litert")]
const DEEP_WRITE_STAGING_SYSTEM: &str = "You are staging context for a long-form writing task. You receive the task brief \
and PARTIAL materials; a [MATERIALS NOTE] lists stored results that were omitted from this package. \
Reply with ONLY one JSON object, nothing else:\n\
- Need more context? {\"requests\": [{\"handle\": \"memN\", \"offset\": 0}]} — up to 6 entries; each returns ~3600 chars read forward from offset (offset 0 = the start).\n\
- The included materials already suffice? {\"ready\": true}";

/// Parse a staging response into (handle, offset) requests. Returns `None`
/// for prose, {"ready": true}, or any non-conforming payload — every such
/// case degrades to the plain single-shot write against the base package.
#[cfg(feature = "litert")]
fn parse_staging_requests(raw: &str) -> Option<Vec<(String, usize)>> {
    let trimmed = raw.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end < start {
        return None;
    }
    let value: Value = serde_json::from_str(&trimmed[start..=end]).ok()?;
    let reqs = value.get("requests")?.as_array()?;
    let mut out = Vec::new();
    for r in reqs {
        let handle = r.get("handle")?.as_str()?.trim();
        if handle.is_empty() {
            return None;
        }
        let offset = r.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        out.push((handle.to_string(), offset));
    }
    (!out.is_empty()).then_some(out)
}

/// Extra persona rule for agents carrying the deep_write subagent: tells the
/// local model WHEN to delegate (the core quality lever of the hybrid tier).
#[cfg(feature = "litert")]
const DEEP_WRITE_RULE: &str = "- Long, analytical, comparative or creative answers (reports, comparisons, drafts, syntheses across sources) MUST be delegated to the deep_write tool: task = the complete brief (audience, structure, focus). materials = a ONE-LINE pointer naming what to use (e.g. \"the video transcript read this turn\") or omit it — the system AUTOMATICALLY attaches the full tool results you gathered this turn. NEVER paste excerpts, documents, or long text into materials (slow and error-prone). The deep_write result is streamed to the user as your final answer. Short factual replies you write yourself — do NOT delegate those.";

/// Extra persona rule for the office agent: document creation with real
/// content goes through the draft_document subagent, which composes the
/// document in the cloud and writes the file itself. `office_create_document`
/// is only for exact-content files (the user supplied the literal text).
#[cfg(all(feature = "litert", feature = "office"))]
const DRAFT_DOCUMENT_RULE: &str = "- Document-content rule (STRICT): when the document's content must be WRITTEN or COMPOSED (the user describes what it should contain or say — reports, proposals, summaries, updates, decks from their files), you MUST call draft_document. Do NOT compose document content yourself and do NOT pass your own made-up content to office_create_document — that tool is ONLY for files whose exact text the user already gave you (transcribe verbatim, e.g. 'a docx containing exactly these lines'). If you are writing ANY of the document's body yourself, that is a draft_document turn.";

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
- Chart requests (\"show/graph/plot/visualize ...\") → data_chart: same filters/groupBy/aggregations/sortBy as data_query plus mark (\"bar\" for comparisons, \"line\" for trends, \"point\" for relationships, \"area\" for cumulative volume), x (category/date column), y (numeric column — an aggregation alias when aggregated), optional color (grouping column) and title. It saves an svg the user sees rendered — afterwards explain the key takeaways in words; never re-dump the charted numbers as a table.\n\
- \"How many per X\" with no metric → groupBy [\"X\"] alone (row_count is implicit).\n\
- Files are addressed by their handle (doc1, doc2 …) exactly as shown in the attachment list or office_list_files. If unsure which file holds the data, ask or call office_list_files.\n\
- SQL sources (only when data_tables is offered): databases are pre-configured server-side and addressed by PROFILE NAME — never ask for connection strings or credentials. data_tables(profile) lists tables; before data_import(profile, table), state which profile/table you will snapshot and wait for the user's confirmation. After an import, run data_schema on the returned fileId.\n\
- If a response: message reports an error (unknown column, bad value), fix the arguments from the valid-columns list it shows and call again — do not give up after one failure.\n\
- Compute NOTHING yourself: sums, averages, growth rates, comparisons all come from data_query results.\n\
- After each response: message, either call another tool or give the final answer.\n\
- Final answers: short, factual, cite the numbers you queried; no JSON dumps.";

#[cfg(feature = "litert")]
fn persona_for(agent_id: &str) -> Option<&'static str> {
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
/// a subagent-only toolset (so the fence protocol + manifest are actually
/// rendered; a persona rule without a manifest would teach the model a tool
/// it cannot call). The office agent additionally gets `draft_document`.
/// These are registered for MANIFEST visibility — the loop intercepts both
/// before `ToolSet::execute` (rig tools return final values; the subagents
/// need per-token streaming / the artifact+receipt flow).
#[cfg(feature = "litert")]
fn toolset_for(
    agent_id: &str,
    user_id: &str,
    session_id: i64,
    remote: Option<&crate::logic::remote::RemoteLlm>,
    // The calling user's SQL-profile snapshot, fetched per turn by agent_chat
    // (analytics feature only — see the ANALYTICS_AGENT_ID arm).
    #[cfg(feature = "analytics")] sql_profiles: &[crate::logic::analytics::SqlProfile],
) -> Option<ToolSet> {
    let mut set = match agent_id {
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => crate::logic::office::toolset(user_id, session_id),
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        BINANCE_AGENT_ID => {
            let mut set = ::binance::registry::all_tools();
            // Web read/search reuse from the webread crate — same engine
            // chain + daily budgets as the office agent; registered only
            // when an engine exists (capability probe). Enable with the
            // `webread` cargo feature.
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
    // Turn-memory recall rides with every toolset that can produce
    // oversized outputs — pure-local agents included (the loop intercepts
    // it before rig dispatch; see ArtifactRecall).
    match agent_id {
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => {
            set.add_tool(ArtifactRecall);
        }
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        BINANCE_AGENT_ID => {
            set.add_tool(ArtifactRecall);
        }
        #[cfg(feature = "analytics")]
        ANALYTICS_AGENT_ID => {
            set.add_tool(ArtifactRecall);
        }
        _ => {}
    }
    if remote.is_none() {
        // Pure-local: only agents with domain tools get a toolset (the
        // pre-hybrid behavior, byte-for-byte).
        return match agent_id {
            #[cfg(feature = "office")]
            OFFICE_AGENT_ID => Some(set),
            #[cfg(all(feature = "binance", not(target_os = "android")))]
            BINANCE_AGENT_ID => Some(set),
            #[cfg(feature = "analytics")]
            ANALYTICS_AGENT_ID => Some(set),
            _ => None,
        };
    }
    set.add_tool(DeepWrite);
    #[cfg(feature = "office")]
    if agent_id == OFFICE_AGENT_ID {
        set.add_tool(DraftDocument);
    }
    Some(set)
}

/// # File-id alias handles
///
/// The office store mints long, opaque file ids (`f87366129058607000-0000`).
/// The on-device model reliably transcribes short, stable handles but
/// corrupts 23-char ids (session 20: `f873…0000` → `f7`). So the loop hides
/// the real id behind a per-session, short alias (`doc1`, `doc2`, …) shown in
/// tool results, and resolves the alias back to the real id only at dispatch
/// (so the underlying rig tool still sees the real id). The map is keyed by
/// session id and persists for the session's lifetime.
#[cfg(feature = "litert")]
struct AliasState {
    order: Vec<(String, String)>,
    seen: std::collections::HashSet<String>,
}

#[cfg(feature = "litert")]
fn alias_registry() -> &'static std::sync::Mutex<std::collections::HashMap<i64, AliasState>> {
    use std::sync::{Mutex, OnceLock};
    static REG: OnceLock<Mutex<std::collections::HashMap<i64, AliasState>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Assign (or reuse) a short alias for a real file id and return it.
#[cfg(feature = "litert")]
fn alias_assign(sid: i64, real: &str) -> String {
    if real.is_empty() {
        return String::new();
    }
    let mut reg = alias_registry().lock().unwrap();
    let st = reg.entry(sid).or_insert(AliasState {
        order: Vec::new(),
        seen: std::collections::HashSet::new(),
    });
    if let Some((a, _)) = st.order.iter().find(|(_, r)| r == real) {
        return a.clone();
    }
    let a = format!("doc{}", st.order.len() + 1);
    st.seen.insert(real.to_string());
    st.order.push((a.clone(), real.to_string()));
    a
}

/// Reverse lookup: real id → its alias (if previously assigned).
#[cfg(feature = "litert")]
fn alias_of(sid: i64, real: &str) -> Option<String> {
    let reg = alias_registry().lock().unwrap();
    reg.get(&sid)?
        .order
        .iter()
        .find(|(_, r)| r == real)
        .map(|(a, _)| a.clone())
}

/// Resolve a possibly-aliased value to its real id. Tries exact alias, then a
/// case-insensitive match (the model occasionally lowercases the handle,
/// e.g. `Doc1`). Returns the original value unchanged when no alias matches —
/// downstream arg validation / the repair round still handle genuine misses.
#[cfg(feature = "litert")]
fn alias_resolve(sid: i64, value: &str) -> String {
    let reg = alias_registry().lock().unwrap();
    let st = match reg.get(&sid) {
        Some(s) => s,
        None => return value.to_string(),
    };
    let v = value.trim();
    for (a, r) in &st.order {
        if a == v || a.eq_ignore_ascii_case(v) {
            return r.clone();
        }
    }
    value.to_string()
}

/// Rewrite a tool result body so any real file ids it exposes become short
/// aliases before the model sees them. Only the two result shapes that carry
/// ids are touched: `office_list_files` (`files[].id`) and `knowledge_search`
/// (`hits[].fileId`). Other tools pass through unchanged.
#[cfg(feature = "litert")]
fn alias_rewrite_body(sid: i64, tool: &str, body: &str) -> String {
    let mut v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return body.to_string(),
    };
    let touch = |map: &mut serde_json::Map<String, Value>, key: &str| {
        if let Some(id) = map.get(key).and_then(Value::as_str) {
            if !id.is_empty() {
                let a = alias_assign(sid, id);
                map.insert(key.to_string(), Value::String(a));
            }
        }
    };
    match tool {
        "office_list_files" => {
            if let Some(files) = v.get_mut("files").and_then(Value::as_array_mut) {
                for f in files.iter_mut().filter_map(Value::as_object_mut) {
                    touch(f, "id");
                }
            }
        }
        "knowledge_search" => {
            if let Some(hits) = v.get_mut("hits").and_then(Value::as_array_mut) {
                for h in hits.iter_mut().filter_map(Value::as_object_mut) {
                    touch(h, "fileId");
                }
            }
        }
        _ => {}
    }
    serde_json::to_string(&v).unwrap_or_else(|_| body.to_string())
}

/// Resolve any `fileId` / `file_id` argument from an alias to its real id,
/// returning a new args object (the original is preserved for the UI event).
#[cfg(feature = "litert")]
fn alias_resolve_args(sid: i64, args: &Value) -> Value {
    let mut out = args.clone();
    if let Some(obj) = out.as_object_mut() {
        for key in ["fileId", "file_id"] {
            if let Some(Value::String(s)) = obj.get(key) {
                let resolved = alias_resolve(sid, s);
                if resolved != *s {
                    obj.insert(key.to_string(), Value::String(resolved));
                }
            }
        }
    }
    out
}

/// Manifest entry + arg schema for the `deep_write` cloud subagent. The
/// registered `call` is never reached — the agent loop dispatches the name
/// itself (see `toolset_for`); this impl exists so the tool manifest and
/// arg validation see a normal tool.
#[cfg(feature = "litert")]
struct DeepWrite;

#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[allow(dead_code)] // fields are validated by the loop's interception; `call` is never reached
struct DeepWriteArgs {
    task: String,
    materials: Option<String>,
}

#[cfg(feature = "litert")]
impl kawai_tools::AgentTool for DeepWrite {
    const NAME: &'static str = DEEP_WRITE_TOOL;
    type Args = DeepWriteArgs;
    type Output = String;
    type Error = std::convert::Infallible;

    fn description(&self) -> String {
        "Delegate long-form writing to a powerful cloud writer. Use for reports, comparisons, \
         drafts, long analyses — anything needing depth beyond a short reply. The result is \
         streamed to the user as the final answer; you will not write it yourself."
            .into()
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What to write: the complete brief — audience, structure, focus, approximate length." },
                "materials": { "type": "string", "description": "Optional one-line pointer (tool results are attached automatically — never paste excerpts or long text). Omit for general-knowledge writing." }
            },
            "required": ["task"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        // Reached only if the loop's interception is bypassed (should not
        // happen); fail soft so the model learns the tool is unavailable.
        Ok(
            "ERROR: deep_write is dispatched internally and is unavailable here. Answer directly."
                .into(),
        )
    }
}

/// Manifest entry + arg schema for the `draft_document` cloud subagent
/// (office-gated). The cloud composes STRUCTURED content JSON (`blocks`,
/// the same vocabulary `office_create_document` uses) and the loop writes
/// the file in-process — big data flows cloud → Rust → disk, never through
/// local's K/V context. Local only ever sees the short receipt.
#[cfg(all(feature = "litert", feature = "office"))]
struct DraftDocument;

#[cfg(all(feature = "litert", feature = "office"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftDocumentArgs {
    task: String,
    filename: String,
    materials: Option<String>,
}

#[cfg(all(feature = "litert", feature = "office"))]
impl kawai_tools::AgentTool for DraftDocument {
    const NAME: &'static str = DRAFT_DOCUMENT_TOOL;
    type Args = DraftDocumentArgs;
    type Output = String;
    type Error = std::convert::Infallible;

    fn description(&self) -> String {
        "Compose a real document (docx/xlsx/pptx) in the cloud and write it to the user's store. \
Use for documents with real composed content: reports, proposals, summaries, decks built from the user's files. \
You provide the brief, the gathered materials and the filename; the writer composes the full content and the file is created for you."
            .into()
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What to write: audience, structure, focus, approximate length." },
                "filename": { "type": "string", "description": "Output filename ending in .docx, .xlsx or .pptx, e.g. report.docx" },
                "materials": { "type": "string", "description": "Optional one-line pointer (tool results are attached automatically — never paste excerpts or long text). Omit for general-knowledge documents." }
            },
            "required": ["task", "filename"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        Ok("ERROR: draft_document is dispatched internally and is unavailable here. Use office_create_document or answer directly.".into())
    }
}

/// Manifest entry + arg schema for `artifact_recall` — pages the turn's
/// stored process log (`TurnMemory`). The registered `call` is never reached
/// (the agent loop dispatches the name itself, before the rig ToolSet); this
/// impl exists so the tool manifest and arg validation see a normal tool.
#[cfg(feature = "litert")]
struct ArtifactRecall;

#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[allow(dead_code)] // fields are read by the loop's interception; `call` is never reached
struct ArtifactRecallArgs {
    handle: String,
    offset: Option<u64>,
}

#[cfg(feature = "litert")]
impl kawai_tools::AgentTool for ArtifactRecall {
    const NAME: &'static str = ARTIFACT_RECALL_TOOL;
    type Args = ArtifactRecallArgs;
    type Output = String;
    type Error = std::convert::Infallible;

    fn description(&self) -> String {
        "Read a stored slice of an oversized tool result from THIS turn. When a tool response says \
         '[stored as memN — N chars total]', call this with that handle to page through the full \
         content (3600 chars per call)."
            .into()
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "handle": { "type": "string", "description": "Stored-output handle, e.g. mem1" },
                "offset": { "type": "integer", "description": "Char offset to read from (default 0)" }
            },
            "required": ["handle"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        Ok("ERROR: artifact_recall is dispatched internally and is unavailable here. Answer directly.".into())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentChatEvent {
    Started {
        session_id: i64,
    },
    Token {
        text: String,
    },
    ToolCall {
        tool: String,
        args: Value,
    },
    /// On-device model reasoning (thinking mode), streamed live for display.
    /// `text` is a DELTA (append, unlike `SubagentThinking`'s full-buffer
    /// replace). Display-only: never persisted, never enters the conversation.
    Thinking {
        text: String,
    },
    /// Cloud-subagent reasoning (thinking), streamed live for display.
    /// `text` is the FULL visible buffer so far (replace, not append);
    /// `provider` labels the cloud candidate currently streaming.
    /// Display-only: never persisted, never enters the local conversation.
    SubagentThinking {
        provider: String,
        text: String,
    },
    ToolResult {
        tool: String,
        ok: bool,
        summary: String,
        /// Structured payload for rich UI rendering (tables, cards). Only
        /// set on success paths where the full tool body is available and it
        /// parses as a bounded JSON object/array — otherwise absent and the
        /// frontend renders the summary.
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
    /// A tool call was intercepted pending explicit user confirmation
    /// (data_import). The UI renders a confirm/cancel card; the user's
    /// reply arrives as the next normal message (the button texts are
    /// backend-composed so the accept wording always satisfies the gate).
    ConfirmationRequest {
        tool: String,
        /// Human-readable summary of what needs confirming.
        prompt: String,
        /// Pre-built reply for the UI's accept button.
        accept_text: String,
        /// Pre-built reply for the UI's decline button.
        decline_text: String,
    },
    Finished,
    Error {
        message: String,
    },
}

/// Render the conversation opener: persona + (when the agent has tools) the
/// fence protocol + tool manifest + (optionally) a compacted transcript of
/// prior turns + the user request. Sent as ONE user message (the Conversation
/// API only takes user turns; its templating owns the system role). Sent only
/// when the manifest is not already in the conversation state — see the
/// module docs. Tool-less agents get a bare persona — no fence protocol to
/// learn, no tool manifest to carry.
#[cfg(feature = "litert")]
fn build_prompt(
    persona: &str,
    toolset: Option<&ToolSet>,
    transcript: &str,
    message: &str,
) -> String {
    let recap = if transcript.is_empty() {
        String::new()
    } else {
        format!(
            "<prior_conversation>\n{transcript}\n</prior_conversation>\n\
             (conversation continues below)\n\n"
        )
    };
    // The full rig JSON parameter schemas are large; for a small on-device
    // model they blow the prefill budget. We emit a compact manifest instead:
    // name + description + a per-arg "type, required|optional — description"
    // map. Arg NAMES must stay visible — the model cannot supply (and must
    // never invent) parameters it has never seen, and the persona forbids
    // inventing arguments, so a name-less manifest makes every tool call
    // unanswerable and the model degenerates into asking the user instead.
    let has_tools = toolset
        .map(|set| !set.get_tool_definitions().is_empty())
        .unwrap_or(false);
    let protocol = if has_tools {
        let defs: Vec<Value> = toolset
            .unwrap()
            .get_tool_definitions()
            .iter()
            .map(|d| {
                serde_json::json!({
                    "name": d.name,
                    "description": d.description,
                    "args": compact_args(&d.parameters),
                })
            })
            .collect();
        let tools = serde_json::to_string_pretty(&defs).unwrap_or_else(|_| "[]".into());
        format!(
            "<agent_context>\n{persona}\n\nAvailable tools (name, what it does, and its args):\n{tools}\n\n\
             To call a tool, reply with exactly ONE line in this format:\n\
             call:<name>{{\"arg\": \"value\", ...}}\n\
             Supply exactly the parameters listed for that tool (omit optional ones). After the call: line, STOP — the result arrives as a response:<name>{{...}} message in the next turn.\n\
             If no tool is needed, answer the user directly in plain text with NO call: line.\n\n\
             Example of the format (illustration only — never repeat it verbatim, and ALWAYS emit the call: line yourself when a tool is needed):\n\
             User: create a docx named hello.docx containing \"hello world\"\n\
             call:office_create_document{{\"filename\": \"hello.docx\", \"blocks\": [{{\"type\": \"paragraph\", \"text\": \"hello world\"}}]}}\n\
             response:office_create_document{{\"success\": true, \"file\": {{\"id\": \"f9\", \"originalName\": \"hello.docx\"}}}}\n\
             Created hello.docx (id f9).\n\
             </agent_context>\n\n"
        )
    } else {
        format!("<agent_context>\n{persona}\n</agent_context>\n\n")
    };
    format!("{protocol}{recap}<user_request>\n{message}\n</user_request>")
}

/// Compact a tool's JSON-Schema `parameters` into a small name → summary map
/// for the prompt manifest: `"filename": "string, required — Output filename,
/// e.g. report.docx"`. Full schemas blow the prefill budget of the on-device
/// model; this keeps every arg NAME, type, requiredness and a trimmed
/// description visible at a fraction of the size.
#[cfg(feature = "litert")]
fn compact_args(params: &Value) -> Value {
    let Some(props) = params.get("properties").and_then(Value::as_object) else {
        return serde_json::json!({});
    };
    let required: Vec<&str> = params
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    for (name, spec) in props {
        let ty = spec.get("type").and_then(Value::as_str).unwrap_or("value");
        let req = if required.contains(&name.as_str()) {
            "required"
        } else {
            "optional"
        };
        let desc = spec
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(|d| format!(" — {}", truncate_chars(d, 120)));
        let text = match desc {
            Some(d) => format!("{ty}, {req}{d}"),
            None => format!("{ty}, {req}"),
        };
        out.insert(name.clone(), Value::String(text));
    }
    Value::Object(out)
}

/// Compact a session's prior messages into a transcript, newest-first within
/// a char budget (oldest turns drop first). Each message is individually
/// capped; the NEWEST message gets the larger [`TRANSCRIPT_LAST_MSG_CHARS`]
/// cap and is ALWAYS included (partially if needed) — follow-up turns center
/// on it. The evidence digest always ships too: its room is reserved before
/// any message claims budget. Empty string when there is nothing (left) to
/// replay.
#[cfg(feature = "litert")]
fn compact_transcript(rows: &[db::ChatMessage], budget: usize, evidence_digest: &str) -> String {
    if rows.is_empty() || budget == 0 {
        return String::new();
    }
    let digest_block = if evidence_digest.is_empty() {
        String::new()
    } else {
        format!("\n\n{evidence_digest}")
    };
    let msg_budget = budget.saturating_sub(digest_block.chars().count());
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut dropped_older = false;
    for (i, row) in rows.iter().enumerate().rev() {
        let role = if row.role == "user" {
            "USER"
        } else {
            "ASSISTANT"
        };
        // Clamp every per-message cap so one line (role prefix + possible
        // ellipsis included) can never exceed `msg_budget` — the digest
        // reservation then keeps the grand total within `budget`, which the
        // overflow-retry transcript MUST fit.
        let cap = (if i == rows.len() - 1 {
            TRANSCRIPT_LAST_MSG_CHARS
        } else {
            TRANSCRIPT_MSG_CHARS
        })
        .min(msg_budget.saturating_sub("ASSISTANT: ".len() + 1));
        let line = format!("{role}: {}", truncate_chars(row.content.trim(), cap));
        let add = line.chars().count() + 1;
        // The newest message is always kept — even when it alone fills the
        // budget (older turns then drop, which is the right trade). The clamp
        // above keeps it within `msg_budget`, so the digest reservation can
        // never push the total past `budget` (the overflow-retry transcript
        // MUST fit).
        if !kept.is_empty() && used + add > msg_budget {
            dropped_older = true;
            break;
        }
        used += add;
        kept.push(line);
    }
    if kept.is_empty() {
        return String::new();
    }
    kept.reverse();
    let mut body = kept.join("\n");
    if dropped_older {
        body = format!("(older turns omitted)\n{body}");
    }
    body.push_str(&digest_block);
    body
}

/// Does this generation error mean "the prompt does not fit the conversation's
/// remaining K/V budget" (prefill overflow) — recoverable by reset + replay?
#[cfg(feature = "litert")]
fn is_prefill_overflow(msg: &str) -> bool {
    // Static executor: exceeds remaining state entries. tasks.cc: the prompt
    // alone exceeds max_num_tokens. Both mean "too long" — same recovery.
    msg.contains("exceeds available state entries")
        || msg.contains("Exceeding the maximum number of tokens")
}

/// Parse a fenced tool call from a completed generation.
///
/// - `None` → no ```tool fence and no native markup (final answer)
/// - `Some(Ok((tool, args)))` → dispatchable call
/// - `Some(Err(detail))` → markup present but malformed (one repair allowed)
pub fn parse_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    if let Some(fenced) = parse_fenced_tool_call(text) {
        return Some(fenced);
    }
    parse_native_tool_call(text)
}

/// Parse the taught ```tool fence protocol. Tolerates the inline form the
/// model emits under pressure (JSON glued to the opener: ```tool{"tool":…}```
/// with no newline) as well as an info-string line (```tool json).
fn parse_fenced_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    let lower = text.to_lowercase();
    let start = lower.find("```tool")? + "```tool".len();
    let rest = text[start..].trim_start();
    let end = match rest.find("```") {
        Some(e) => e,
        None => return Some(Err("unterminated ```tool block".into())),
    };
    let mut raw = rest[..end].trim();
    if !raw.starts_with('{') {
        // Info string on its own line (```tool json\n{...}) — drop it, but
        // only when a JSON body actually follows (a lone bare name stays).
        if let Some(nl) = raw.find('\n') {
            let next = raw[nl + 1..].trim_start();
            if next.starts_with('{') {
                raw = next.trim_end();
            }
        }
    }
    if raw.is_empty() {
        return Some(Err("empty ```tool block".into()));
    }
    // Leniency: a fence containing ONLY a bare tool name (the model forgot the
    // JSON wrapper) dispatches with empty args. Arg validation then fails as a
    // TOOL_RESULT the model can answer with a complete call — instead of the
    // turn dying on a malformed-fence error.
    if !raw.contains('\n')
        && raw.starts_with(|c: char| c.is_ascii_alphabetic())
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Some(Ok((raw.to_string(), serde_json::json!({}))));
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v) => {
            // Accept the documented "tool" plus the aliases small models
            // commonly emit ("tool_name", "name").
            let tool = ["tool", "tool_name", "name"]
                .iter()
                .find_map(|k| v.get(k).and_then(|t| t.as_str()).map(str::to_string))
                .filter(|t| !t.is_empty());
            match tool {
                Some(t) => {
                    let args = v.get("args").cloned().unwrap_or(serde_json::json!({}));
                    Some(Ok((t, args)))
                }
                None => Some(Err("tool block missing the \"tool\" field".into())),
            }
        }
        Err(e) => Some(Err(format!("tool block is not valid JSON: {e}"))),
    }
}

/// Parse the Gemma native tool-call markup the model sometimes emits instead
/// of the taught ```tool fence:
/// `<|tool_call>call:NAME{ARGS}<tool_call|>` — opener tolerates the closed
/// `<|tool_call|>` form, terminator accepts `<tool_call|>` or
/// `<|tool_call_end|>`, and quotes may be escaped as `<|"|>` / `<|'|>`.
/// Keys may be bare (`{mode:"keyword"}`) — [`quote_bare_keys`] fixes that.
fn parse_native_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    if let Some(start) = text.find("<|tool_call") {
        let after = &text[start..];
        let name_start = after.find("call:")? + "call:".len();
        let rest = &after[name_start..];
        let end = ["<tool_call|>", "<|tool_call_end|>"]
            .iter()
            .filter_map(|m| rest.find(m))
            .min()
            .unwrap_or(rest.len());
        return parse_native_body(rest[..end].trim());
    }
    // Marker-less bare form: `call:NAME{args}` with no special tokens at all
    // (observed degradation when the model drops the wrapper entirely). A
    // candidate that does not validate is treated as prose (final answer),
    // NOT an error — "call:" inside ordinary language must not kill a turn.
    // Exception: a valid name + balanced braces whose args fail to parse is
    // clearly an attempted call — surfaced as malformed for the repair round.
    let mut first_broken: Option<String> = None;
    let mut from = 0usize;
    while let Some(rel) = text[from..].find("call:") {
        let at = from + rel;
        from = at + "call:".len();
        // Word boundary: "recall:" / "we call:" are not tool calls.
        if at > 0 {
            let prev = text[..at].chars().next_back().unwrap();
            if prev.is_alphanumeric() || prev == '_' {
                continue;
            }
        }
        let body = &text[at + "call:".len()..];
        // Arg extent: balanced braces from the first `{` (strings respected).
        let Some(open) = body.find('{') else {
            continue;
        };
        let name = body[..open].trim().trim_end_matches(':').trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        let args_span = balanced_braces(body, open);
        let parsed = args_span.and_then(|raw| parse_native_body(&format!("{name} {raw}")));
        if let Some(Ok((n, v))) = parsed {
            return Some(Ok((n, v)));
        }
        // Retry after syntax repair: a key missing its opening quote desyncs
        // the string tracker above, so unbalanced here may still be a valid
        // call once bare keys are re-quoted.
        let fixed = quote_bare_keys(body);
        if let Some(open2) = fixed.find('{') {
            let name2 = fixed[..open2]
                .trim()
                .trim_end_matches(':')
                .trim()
                .to_string();
            if name2 == name {
                let reparsed = balanced_braces(&fixed, open2)
                    .and_then(|raw| parse_native_body(&format!("{name} {raw}")));
                if let Some(Ok((n, v))) = reparsed {
                    return Some(Ok((n, v)));
                }
            }
        }
        // Recognizable but broken (valid name + BALANCED braces, args won't
        // parse): NOT prose — remember the first failure. If no candidate
        // parses, surface it as a malformed call so the loop's ONE repair
        // round teaches the correct shape (raw-persisting the line is the
        // worst outcome). Unbalanced braces stay prose ("call:" + garbage).
        if args_span.is_some() && first_broken.is_none() {
            first_broken = Some(format!("call:{name}{{...}} — args are not valid JSON"));
        }
    }
    first_broken.map(Err)
}

/// Extract `{...}` starting at `body[open]`, honouring string literals, to the
/// matching close brace. `None` when unbalanced.
fn balanced_braces(body: &str, open: usize) -> Option<&str> {
    let bytes = body.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(&body[open..=i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Validate `NAME {json}` (or bare `NAME`) from a native call body.
fn parse_native_body(body: &str) -> Option<Result<(String, Value), String>> {
    let (name, args_raw) = match body.find('{') {
        Some(i) => (
            body[..i].trim().trim_end_matches(':').trim(),
            body[i..].trim(),
        ),
        None => (body.trim(), ""),
    };
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        let shown: String = name.chars().take(60).collect();
        return Some(Err(format!("native tool call has no valid name: {shown}")));
    }
    if args_raw.is_empty() {
        return Some(Ok((name.to_string(), serde_json::json!({}))));
    }
    let unescaped = args_raw.replace("<|\"|>", "\"").replace("<|'|>", "'");
    let fixed = quote_bare_keys(&unescaped);
    match serde_json::from_str::<Value>(&fixed) {
        Ok(v) => Some(Ok((name.to_string(), v))),
        Err(e) => Some(Err(format!("native tool call args not valid JSON: {e}"))),
    }
}

/// Quote bare object keys so serde accepts near-JSON args:
/// `{mode:"keyword"}` → `{"mode":"keyword"}`. Only identifiers directly after
/// `{` or `,` (modulo whitespace) that are followed by `:` get quoted —
/// string values and already-quoted keys pass through untouched.
fn quote_bare_keys(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            // Copy the string literal verbatim (escape-aware).
            out.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                out.push(ch);
                i += 1;
                if ch == '\\' && i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                } else if ch == '"' {
                    break;
                }
            }
            continue;
        }
        if c == '{' || c == ',' || (out.is_empty() && (c.is_ascii_alphabetic() || c == '_')) {
            // At a key position: scan an identifier, quote it if a `:` follows.
            out.push(c);
            i += 1;
            while i < chars.len() && chars[i] == ' ' {
                out.push(' ');
                i += 1;
            }
            if i < chars.len() && (chars[i].is_ascii_alphabetic() || chars[i] == '_') {
                let ks = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[ks..i].iter().collect();
                let mut j = i;
                while j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ':' {
                    out.push('"');
                    out.push_str(&ident);
                    out.push('"');
                } else if j < chars.len() && chars[j] == '"' && {
                    // Missing OPENING quote (`..."`,task": "x`) — the model
                    // dropped one side of the key. The closing quote is right
                    // here; supply the opener.
                    let mut k = j + 1;
                    while k < chars.len() && chars[k] == ' ' {
                        k += 1;
                    }
                    k < chars.len() && chars[k] == ':'
                } {
                    out.push('"');
                    out.push_str(&ident);
                } else {
                    out.push_str(&ident);
                }
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Strip protocol markers the model may echo back into streamed tokens.
/// Covers the taught fence markers plus the Gemma 4 native special tokens
/// (tool-call lifecycle, thought channel, turn end) so they never reach the
/// UI as prose. Escaped string delimiters un-escape to real quotes.
#[cfg(feature = "litert")]
fn strip_markers(t: &str) -> String {
    t.replace("<agent_context>", "")
        .replace("</agent_context>", "")
        .replace("<user_request>", "")
        .replace("</user_request>", "")
        .replace("<|tool_call>", "")
        .replace("<|tool_call|>", "")
        .replace("<tool_call|>", "")
        .replace("<|tool_call_end|>", "")
        .replace("<|tool_response>", "")
        .replace("<|tool_response|>", "")
        .replace("<|channel>thought>", "")
        .replace("<|message|>", "")
        .replace("<|end|>", "")
        .replace("<|\"|>", "\"")
        .replace("<|'|>", "'")
}

#[cfg(feature = "litert")]
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

/// Render a ToolResult into the text fed back to the model.
#[cfg(feature = "litert")]
fn tool_result_body(result: &kawai_tools::ToolResult) -> String {
    if let Some(text) = result.text() {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    if let Some(err) = result.error_message() {
        return format!("ERROR: {err}");
    }
    "<non-text output>".to_string()
}

// ── Turn memory: the turn's process log ─────────────────────────────────────
//
// Every completed process this user message (plain tool result, recall page,
// subagent receipt) appends one entry. The log lives only for the duration of
// the `agent_chat` stream — dropped when the turn ends, never persisted. It
// serves three consumers: the cloud-subagent `materials` package (rendered on
// demand via `materials()`), the chain digest fed back on budget exhaustion,
// and `artifact_recall` paging for oversized bodies.

/// Canonical serialization of tool-call args for turn-memory dedup keys.
/// Object keys are sorted RECURSIVELY — required because `schemars` (via
/// rig) enables serde_json's `preserve_order`, making `Value::to_string()`
/// keep the model's insertion order: the same semantic call written with a
/// different key order would otherwise dedup-fail. Whitespace never
/// survives parsing, so only key order needs normalizing here. Numeric-form
/// differences (`5` vs `5.0`) remain distinct keys — acceptable: one model,
/// one phrasing per turn.
#[cfg(feature = "litert")]
fn canonical_args_key(value: &Value) -> String {
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    write(&map[*k], out);
                }
                out.push('}');
            }
            Value::Array(arr) => {
                out.push('[');
                for (i, item) in arr.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut s = String::new();
    write(value, &mut s);
    s
}

/// One stored process result. `content` is the tool's verbatim output body,
/// already capped at `TOOL_RESULT_ENTRY_MAX_CHARS`.
#[cfg(feature = "litert")]
#[derive(Clone)]
struct TurnArtifact {
    handle: String,
    tool: String,
    /// Canonical (tool, resolved-args) string — exact-match dedup key.
    args_key: String,
    content: String,
}

/// Session-scoped append-only log of completed processes. Restored from the
/// per-session SQLite table at stream start, so handles stay valid across
/// turns and restarts; new records flush back to the DB as they are made.
/// Touched only inside the single `agent_chat` stream — no locking needed.
#[cfg(feature = "litert")]
#[derive(Default)]
struct TurnMemory {
    artifacts: Vec<TurnArtifact>,
    /// Artifacts already flushed to the DB this stream (`take_unpersisted`
    /// advances it).
    persisted: usize,
}

#[cfg(feature = "litert")]
impl TurnMemory {
    /// Seed the log with prior turns' stored results so recall handles keep
    /// working after an epoch break; numbering continues from here.
    fn restore(&mut self, prior: Vec<TurnArtifact>) {
        self.persisted = prior.len();
        self.artifacts = prior;
    }

    /// Clone out the artifacts recorded since the last flush and advance the
    /// cursor — the caller persists them to the session's DB rows.
    fn take_unpersisted(&mut self) -> Vec<TurnArtifact> {
        let fresh = self.artifacts[self.persisted.min(self.artifacts.len())..].to_vec();
        self.persisted = self.artifacts.len();
        fresh
    }

    /// One-line inventory of stored results for the replayed transcript: the
    /// model learns WHICH handles exist across epoch breaks even though the
    /// bodies do not replay. Oldest-first, capped.
    fn evidence_digest(&self) -> String {
        if self.artifacts.is_empty() {
            return String::new();
        }
        const MAX_ITEMS: usize = 24;
        let mut parts: Vec<String> = self
            .artifacts
            .iter()
            .take(MAX_ITEMS)
            .map(|a| {
                format!(
                    "{} {} {} chars",
                    a.handle,
                    a.tool,
                    a.content.chars().count()
                )
            })
            .collect();
        if self.artifacts.len() > MAX_ITEMS {
            parts.push(format!("… {} more", self.artifacts.len() - MAX_ITEMS));
        }
        format!(
            "[Stored tool results from this session's earlier work — call \
             artifact_recall to read any of them: {}]",
            parts.join("; ")
        )
    }

    /// Append one completed process. A repeat of the same tool + resolved args
    /// returns the existing handle — the log grows per DISTINCT step, never
    /// per repeat. Returns the handle ("mem1", "mem2", … sequential).
    fn record(&mut self, tool: &str, args_key: &str, content: String) -> String {
        if let Some(existing) = self
            .artifacts
            .iter()
            .find(|a| a.tool == tool && a.args_key == args_key)
        {
            return existing.handle.clone();
        }
        let handle = format!("mem{}", self.artifacts.len() + 1);
        self.artifacts.push(TurnArtifact {
            handle: handle.clone(),
            tool: tool.to_string(),
            args_key: args_key.to_string(),
            content: truncate_chars(&content, TOOL_RESULT_ENTRY_MAX_CHARS),
        });
        handle
    }

    /// The whole chain as a compact block (valid handles + chars + tool) —
    /// fed on budget exhaustion so the model closes the turn knowing what it
    /// already gathered.
    fn chain_digest(&self) -> String {
        self.artifacts
            .iter()
            .map(|a| {
                format!(
                    "{} {} {} chars",
                    a.handle,
                    a.tool,
                    a.content.chars().count()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Paged slice for `artifact_recall`: (page_text, next_offset). `None`
    /// next_offset = no more content. Err carries a teaching message (valid
    /// handles / valid range) — errors are prompts, not failures.
    fn page(&self, handle: &str, offset: usize) -> Result<(String, Option<usize>), String> {
        let Some(a) = self
            .artifacts
            .iter()
            .find(|a| a.handle.eq_ignore_ascii_case(handle))
        else {
            let valid = self
                .artifacts
                .iter()
                .map(|a| format!("{} ({} chars)", a.handle, a.content.chars().count()))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "unknown handle {handle:?}. Valid handles this turn: {}",
                if valid.is_empty() {
                    "none — no tool output is stored".to_string()
                } else {
                    valid
                }
            ));
        };
        let total = a.content.chars().count();
        if offset >= total {
            return Err(format!(
                "offset {offset} is past the end of {} ({} chars). Valid range: 0..{}",
                a.handle,
                total,
                total.saturating_sub(1)
            ));
        }
        let page: String = a
            .content
            .chars()
            .skip(offset)
            .take(ARTIFACT_PAGE_CHARS)
            .collect();
        let served = page.chars().count();
        let next = if offset + served < total {
            Some(offset + served)
        } else {
            None
        };
        Ok((page, next))
    }

    /// The cloud-materials package: whole "--- tool ---" blocks joined in turn
    /// order under `budget` (per-provider — see `RemoteLlm::materials_budget`).
    /// Selection is RELEVANCE-ranked — distinct terms from the user's message
    /// dominate, recency breaks ties — but rendering stays chronological, so a
    /// giant early read can no longer crowd out a small decisive one. Blocks
    /// ship WHOLE; artifacts that do not fit are omitted EXPLICITLY via a
    /// trailing note (handles + tools + sizes) — the writer must never receive
    /// a silently truncated package.
    fn materials(&self, focus: &str, budget: usize) -> String {
        let n = self.artifacts.len();
        if n == 0 {
            return String::new();
        }
        let terms = focus_terms(focus);
        let block_chars: Vec<usize> = self
            .artifacts
            .iter()
            .map(|a| artifact_block(a).chars().count())
            .collect();
        let mut ranked: Vec<usize> = (0..n).collect();
        ranked.sort_by_key(|&i| {
            std::cmp::Reverse((relevance_score(&self.artifacts[i], &terms, i), i))
        });
        // First-fit over the ranking; kept blocks stay WHOLE (no mid-body cut).
        let fits = |avail: usize| -> Vec<usize> {
            let mut used = 0usize;
            let mut sel = Vec::new();
            for &i in &ranked {
                let sep = if sel.is_empty() { 0 } else { 2 };
                if used + sep + block_chars[i] <= avail {
                    used += sep + block_chars[i];
                    sel.push(i);
                }
            }
            sel
        };
        let mut selected = fits(budget);
        if selected.len() < n {
            // Refit reserving room for the omission note so the final package
            // (note included) stays within budget.
            selected = fits(budget.saturating_sub(MATERIALS_NOTE_RESERVE));
        }
        // A single giant read can leave the selection empty — always ship at
        // least the top-ranked head block rather than an empty package; its
        // tail gets the standard ellipsis marker below.
        if selected.is_empty() {
            selected.push(ranked[0]);
        }
        selected.sort_unstable(); // chronological render

        let note = if selected.len() == n {
            None
        } else {
            let listed = self
                .artifacts
                .iter()
                .enumerate()
                .filter(|(i, _)| !selected.contains(i))
                .map(|(_, a)| {
                    format!(
                        "{} {} {} chars",
                        a.handle,
                        a.tool,
                        a.content.chars().count()
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            Some(format!(
                "[MATERIALS NOTE: {} of {} stored results did not fit this package \
                 ({}-char cap). Omitted: {}. Ground the answer ONLY in the included \
                 results; do not imply coverage of the omitted ones.]",
                n - selected.len(),
                n,
                budget,
                listed,
            ))
        };
        let note_text = note.map(|m| format!("\n\n{m}")).unwrap_or_default();
        let avail = budget.saturating_sub(note_text.chars().count());
        let joined = selected
            .iter()
            .map(|&i| artifact_block(&self.artifacts[i]))
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut out = if joined.chars().count() > avail {
            truncate_chars(&joined, avail)
        } else {
            joined
        };
        out.push_str(&note_text);
        out
    }

    /// Resolve deep_write staging requests into "[ADDITIONAL SLICES …]" blocks
    /// of verbatim pages from this log. Invalid handles/offsets are skipped —
    /// the writer asked, we serve what exists; duplicates dedup on
    /// (handle, offset); bounded by STAGING_MAX_REQUESTS pages total.
    fn staging_slices(&self, reqs: &[(String, usize)]) -> String {
        let mut seen: std::collections::HashSet<(String, usize)> = Default::default();
        let mut blocks: Vec<String> = Vec::new();
        for (handle, offset) in reqs.iter().take(STAGING_MAX_REQUESTS) {
            if !seen.insert((handle.to_lowercase(), *offset)) {
                continue;
            }
            if let Ok((page_text, _)) = self.page(handle, *offset) {
                blocks.push(format!(
                    "--- requested slice {} @{} ---\n{}",
                    handle, offset, page_text
                ));
            }
            if blocks.len() >= STAGING_MAX_REQUESTS {
                break;
            }
        }
        if blocks.is_empty() {
            String::new()
        } else {
            format!(
                "[ADDITIONAL SLICES fetched at this writer's request]\n{}",
                blocks.join("\n\n")
            )
        }
    }

    /// Total stored content chars — the cloud-close trigger metric.
    fn total_content_chars(&self) -> usize {
        self.artifacts
            .iter()
            .map(|a| a.content.chars().count())
            .sum()
    }
}

/// Flush artifacts recorded since the last flush to the session's persistent
/// log (best-effort: a failed write only degrades those entries to
/// turn-scoped visibility; the turn never dies).
#[cfg(feature = "litert")]
async fn flush_new_artifacts(user_id: &str, sid: i64, memory: &mut TurnMemory) {
    for a in memory.take_unpersisted() {
        if let Err(e) = db::append_session_artifact(
            user_id,
            sid,
            &a.handle,
            &a.tool,
            &a.args_key,
            &a.content,
        )
        .await
        {
            eprintln!("[agent_chat] artifact persist {} failed: {e}", a.handle);
        }
    }
}

/// A cloud subagent delegation queued for the next loop iteration.
#[cfg(feature = "litert")]
struct PendingSubagent {
    tool: String,
    task: String,
    materials: String,
    /// draft_document only — output filename (validated by the office store).
    filename: Option<String>,
    escalated: bool,
}

/// Persona of the draft_document subagent (the cloud composer). Returns
/// STRUCTURED JSON only — never prose; the block vocabulary is identical to
/// `office_create_document` so the office writer consumes it directly.
#[cfg(feature = "litert")]
const DRAFT_DOCUMENT_SYSTEM: &str = "You compose document content as structured JSON for an office file writer. \
Rules:\n\
- Output ONLY one JSON object, exactly {\"blocks\": [...]}. No markdown, no code fence, no commentary.\n\
- Block types (in document order): {\"type\":\"title\",\"text\":\"...\"} | {\"type\":\"heading\",\"text\":\"...\",\"level\":1} | {\"type\":\"paragraph\",\"text\":\"...\"} | {\"type\":\"bullets\",\"items\":[\"...\"]} | {\"type\":\"table\",\"rows\":[[\"a\",\"b\"]]}\n\
- Ground content in the provided materials when given; use general knowledge only to fill gaps.\n\
- Be substantive: full paragraphs, real headings, complete tables — the writer will not edit or extend your content.\n\
- Ground every claim in the materials when they are provided; use general knowledge only to fill gaps.\n\
- If materials are insufficient for part of the task, complete the rest and add a short paragraph noting the gap.";

/// Strip code fences / prose and parse the draft JSON into document blocks.
/// Accepts {\"blocks\":[...]} or a bare top-level [...] array.
#[cfg(all(feature = "litert", feature = "office"))]
pub fn extract_draft_blocks(
    raw: &str,
) -> Result<Vec<crate::logic::office::ooxml::DocBlock>, String> {
    let unfenced = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    // Parse the whole payload first; only carve a substring when the model
    // wrapped the JSON in prose (which breaks whole-string parsing).
    let value: Value = match parse_with_brace_repair(unfenced) {
        Ok(v) => v,
        Err(e) => return Err(format!("not valid JSON: {e}")),
    };
    let blocks_value = match &value {
        Value::Array(_) => value.clone(),
        Value::Object(_) => value.get("blocks").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };
    serde_json::from_value::<Vec<crate::logic::office::ooxml::DocBlock>>(blocks_value)
        .map_err(|e| format!("blocks failed schema validation: {e}"))
}

/// Parse a draft payload, recovering from a recurring provider quirk: an
/// extra `}` emitted right after a nested block (observed as `…items":[…]}},`
/// — the stray brace closes the root object early and the rest of the blocks
/// become unparseable). Whole-string first; then prose-carve (first `{` to
/// last `}`); then try deleting one `}` from each `}}` pair in turn. Returns
/// the last serde error when nothing parses (for diagnosis).
#[cfg(all(feature = "litert", feature = "office"))]
fn parse_with_brace_repair(unfenced: &str) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str::<Value>(unfenced) {
        return Ok(v);
    }
    let carved = match (unfenced.find('{'), unfenced.rfind('}')) {
        (Some(a), Some(b)) if b > a => &unfenced[a..=b],
        _ => unfenced,
    };
    let mut last_err = match serde_json::from_str::<Value>(carved) {
        Ok(v) => return Ok(v),
        Err(e) => e.to_string(),
    };
    let mut repaired = carved.to_string();
    while let Some(pos) = repaired.rfind("}}") {
        repaired.remove(pos + 1);
        match serde_json::from_str::<Value>(&repaired) {
            Ok(v) => return Ok(v),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

/// The agent chat loop. Requires `litert` (the on-device model is the only
/// v1 backend); wrappers gate the op accordingly.
#[cfg(feature = "litert")]
pub fn agent_chat(
    user_id: String,
    agent_id: String,
    session_id: Option<i64>,
    message: String,
    #[allow(unused_variables)] file_ids: Vec<String>,
) -> impl Stream<Item = AgentChatEvent> {
    use crate::logic::local_llm::LocalChatEvent;
    use async_stream::stream;

    stream! {
        let Some(base_persona) = persona_for(&agent_id) else {
            yield AgentChatEvent::Error { message: format!("unknown agent: {agent_id}") };
            return;
        };
        // Hybrid tier: the remote subagent client. None ⇒ pure-local turn
        // (identical to pre-hybrid behavior).
        let remote = crate::logic::remote::RemoteLlm::from_env();
        let persona_owned;
        let persona = if remote.is_some() {
            persona_owned = match agent_id.as_str() {
                #[cfg(feature = "office")]
                OFFICE_AGENT_ID => format!("{base_persona}\n{DEEP_WRITE_RULE}\n{DRAFT_DOCUMENT_RULE}"),
                _ => format!("{base_persona}\n{DEEP_WRITE_RULE}"),
            };
            persona_owned.as_str()
        } else {
            base_persona
        };

        // Lazy session creation, then persist the user turn (seeds the title).
        let sid = match session_id {
            Some(id) => id,
            None => match db::create_chat_session(&user_id, Some(&agent_id)).await {
                Ok(s) => s.id,
                Err(e) => {
                    yield AgentChatEvent::Error { message: e.to_string() };
                    return;
                }
            },
        };
        // Built after `sid` exists: the knowledge tool binds the session id.
        // Analytics: fetch THIS user's SQL profiles now, so a source saved
        // moments ago registers its tools this very turn — and so the tools
        // resolve only sources baked for the calling user (no process-global
        // cache that a concurrent turn could cross-contaminate in web mode).
        #[cfg(feature = "analytics")]
        let toolset = {
            let sql_profiles = crate::logic::analytics::effective_profiles(&user_id).await;
            toolset_for(&agent_id, &user_id, sid, remote.as_ref(), &sql_profiles)
        };
        #[cfg(not(feature = "analytics"))]
        let toolset = toolset_for(&agent_id, &user_id, sid, remote.as_ref());
        eprintln!(
            "[agent_chat] toolset for agent={agent_id} remote.is_some()={} has_toolset={}",
            remote.is_some(),
            toolset.is_some()
        );
        yield AgentChatEvent::Started { session_id: sid };

        // User-attached files (@-mentions from the composer): resolve + bind
        // them to the session so the knowledge tools see them, and expose the
        // ids in the prompt — deterministic intent binding, no guessing via
        // search. Office-gated: without the office feature there is no store
        // to resolve against (mentions are then ignored).
        #[allow(unused_mut)]
        let mut attached_ids: Vec<String> = Vec::new();
        #[cfg(feature = "office")]
        {
            for fid in &file_ids {
                match crate::logic::office::store::resolve(&user_id, fid) {
                    Ok((_, info)) => attached_ids.push(info.id),
                    Err(e) => eprintln!("[agent_chat] attached file {fid} unresolved: {e}"),
                }
            }
            if !attached_ids.is_empty() {
                if let Err(e) = crate::logic::rag::knowledge_add_to_session(
                    &user_id,
                    sid,
                    &attached_ids,
                )
                .await
                {
                    eprintln!("[agent_chat] attach to session failed: {e}");
                }
            }
        }
        let attachment_block = attachment_prompt_block(sid, &attached_ids);
        let message_for_model = if attachment_block.is_empty() {
            message.clone()
        } else {
            format!("{message}\n\n{attachment_block}")
        };

        // Snapshot the prior turns BEFORE appending the current user message,
        // so a replayed transcript never contains the message being answered.
        let prior_turns = db::list_chat_messages(&user_id, sid).await.unwrap_or_default();
        if let Err(e) = db::append_chat_message(&user_id, sid, "user", &message).await {
            yield AgentChatEvent::Error { message: e.to_string() };
            return;
        }
        // First turn seeds the title AFTER the message is in the DB, so the
        // (remote) title generator can actually read it — no insert race.
        // Fire-and-forget: failures keep the offline substr fallback title.
        if prior_turns.is_empty() {
            let uid = user_id.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::logic::generate_session_title(&uid, sid).await {
                    eprintln!("[agent_chat] generate_session_title: {e}");
                }
            });
        }

        // Opener/delta protocol — see module docs. The manifest is re-sent
        // whenever it is not in the CURRENT conversation state (first turn of
        // the epoch, a reset by the frontend, a reload, or overflow recovery).
        let manifest_key = format!("{agent_id}:{sid}");
        let mut manifest_pending = false;
        let mut recovered = false;
        let mut prompt = String::new();
        let mut calls_used = 0usize;
        let mut repairs_used = 0usize;
        let mut empty_retries = 0usize;
        let mut budget_notified = false;
        // Hybrid-tier state: a pending subagent delegation (set by the
        // dispatch arm or the escalation path) runs at the top of the next
        // loop iteration — one code path for both entry points.
        let mut pending_subagent: Option<PendingSubagent> = None;
        let mut subagent_calls_used = 0usize;
        // The process log: every completed process (tool result, recall
        // page) appends one entry. Cloud-subagent materials are rendered from
        // it on demand — the cloud subagents are stateless and this is the
        // deterministic hand-off so a delegation never loses what the model
        // gathered. Oversized bodies page back via artifact_recall.
        // Prior turns' entries are restored from the DB so handles survive
        // epoch breaks (restart / session switch); new records flush back.
        let mut memory = TurnMemory::default();
        match db::list_session_artifacts(&user_id, sid).await {
            Ok(rows) => {
                memory.restore(
                    rows.into_iter()
                        .map(|r| TurnArtifact {
                            handle: r.handle,
                            tool: r.tool,
                            args_key: r.args_key,
                            content: r.content,
                        })
                        .collect(),
                );
                if !memory.artifacts.is_empty() {
                    eprintln!(
                        "[agent_chat] restored {} stored result(s) for session {sid}",
                        memory.artifacts.len()
                    );
                }
            }
            Err(e) => eprintln!("[agent_chat] artifact restore failed: {e}"),
        }
        let turn_started = std::time::Instant::now();

        let final_answer = loop {
            // ── Cloud subagents (deep_write / draft_document) ─────────────
            // deep_write: final:true passthrough — cloud tokens stream to
            // the user, are persisted as the assistant message, turn ends.
            // draft_document: artifact + receipt — the cloud JSON never
            // enters local's context; the file is written in-process and a
            // short receipt is fed back so local closes the turn.
            // On failure either degrades to local, the turn never dies.
            if let Some(call) = pending_subagent.take() {
                if subagent_calls_used >= MAX_SUBAGENT_CALLS {
                    prompt = format!(
                        "response:{}:\nERROR: the cloud call for this turn was already used. \
                         Answer the user directly now with what you have (NO call: line).",
                        call.tool
                    );
                    continue;
                }
                subagent_calls_used += 1;
                let is_draft = call.tool == DRAFT_DOCUMENT_TOOL;
                if !is_draft && call.tool != DEEP_WRITE_TOOL {
                    prompt = format!(
                        "response:{}:\nERROR: unknown cloud tool. Answer directly (NO call: line).",
                        call.tool
                    );
                    continue;
                }
                let args = serde_json::json!({
                    "task": call.task,
                    "filename": call.filename,
                    "materials": call.materials,
                });
                eprintln!(
                    "[agent_chat] {} ({}): task={}",
                    call.tool,
                    if call.escalated { "escalated" } else { "delegated" },
                    truncate_chars(&call.task, 200)
                );
                yield AgentChatEvent::ToolCall { tool: call.tool.clone(), args };

                // One streamed cloud completion (shared by both subagents).
                // NOTE: the async_stream stream is !Unpin — box it first
                // (AGENTS.md landmine). An errored start degrades to an
                // empty stream so the shared loop sees `failed`.
                let started = std::time::Instant::now();
                let system = if is_draft { DRAFT_DOCUMENT_SYSTEM } else { DEEP_WRITE_SYSTEM };
                // deep_write staging round: when the base package omitted
                // stored artifacts ([MATERIALS NOTE]), give the writer ONE
                // bounded round to fetch what it needs before composing. Any
                // non-conforming response degrades to the plain single-shot
                // write against the base package — the turn never dies here.
                let mut materials_for_call = call.materials.clone();
                if !is_draft && call.materials.contains(MATERIALS_NOTE_MARKER) {
                    let stage_started = std::time::Instant::now();
                    let mut raw = String::new();
                    let mut stage_failed: Option<String> = None;
                    match remote
                        .as_ref()
                        .expect("pending_subagent implies remote")
                        .stream(DEEP_WRITE_STAGING_SYSTEM, &call.task, &call.materials)
                        .await
                    {
                        Ok(s) => {
                            let mut s = Box::pin(s);
                            loop {
                                if stage_started.elapsed()
                                    > std::time::Duration::from_secs(REMOTE_TIMEOUT_SECS)
                                {
                                    stage_failed = Some("staging round timed out".into());
                                    break;
                                }
                                match s.next().await {
                                    Some(Ok(crate::logic::remote::RemoteEvent::Token { text })) => {
                                        // Requests are tiny JSON; the cap only
                                        // guards a runaway model.
                                        if raw.chars().count() < 4_000 {
                                            raw.push_str(&text);
                                        }
                                    }
                                    Some(Ok(_)) => {}
                                    Some(Err(e)) => {
                                        stage_failed = Some(e);
                                        break;
                                    }
                                    None => break,
                                }
                            }
                        }
                        Err(e) => stage_failed = Some(e),
                    }
                    match stage_failed {
                        Some(e) => eprintln!(
                            "[agent_chat] deep_write staging unavailable ({e}) — single-shot fallback"
                        ),
                        None => match parse_staging_requests(&raw) {
                            Some(reqs) => {
                                let slices = memory.staging_slices(&reqs);
                                if slices.is_empty() {
                                    eprintln!(
                                        "[agent_chat] deep_write staging: no valid slice for {} request(s)",
                                        reqs.len()
                                    );
                                } else {
                                    eprintln!(
                                        "[agent_chat] deep_write staging: +{} chars from {} request(s)",
                                        slices.chars().count(),
                                        reqs.len()
                                    );
                                    materials_for_call =
                                        format!("{}\n\n{slices}", call.materials);
                                }
                            }
                            None => eprintln!(
                                "[agent_chat] deep_write staging: writer ready with the base package"
                            ),
                        },
                    }
                }
                let mut answer = String::new();
                // Mirror of the cloud reasoning buffer (capped) — the
                // authoritative display text re-emitted per event.
                let mut reasoning_buf = String::new();
                let mut usage: Option<crate::logic::remote::RemoteUsage> = None;
                let mut hit_cap = false;
                // Label of the candidate that actually served the stream
                // (failover may skip the preferred primary).
                let mut cloud_provider: Option<String> = None;
                let mut failed: Option<String> = None;
                let mut stream: std::pin::Pin<
                    Box<dyn futures_core::Stream<Item = Result<crate::logic::remote::RemoteEvent, String>> + Send>,
                > = match remote
                    .as_ref()
                    .expect("pending_subagent implies remote")
                    .stream(system, &call.task, &materials_for_call)
                    .await
                {
                    Ok(s) => Box::pin(s),
                    Err(e) => {
                        failed = Some(e);
                        Box::pin(futures_util::stream::empty::<
                            Result<crate::logic::remote::RemoteEvent, String>,
                        >())
                    }
                };
                loop {
                    if started.elapsed() > std::time::Duration::from_secs(REMOTE_TIMEOUT_SECS) {
                        failed = Some("cloud request timed out".into());
                        break;
                    }
                    match stream.next().await {
                        Some(Ok(crate::logic::remote::RemoteEvent::Token { text })) => {
                            if is_draft {
                                // Draft JSON is machine payload, not user
                                // prose — accumulate silently (capped).
                                if answer.chars().count() < DRAFT_JSON_MAX_CHARS {
                                    answer.push_str(&text);
                                }
                            } else {
                                let t = strip_markers(&text);
                                if !t.is_empty() {
                                    answer.push_str(&t);
                                    yield AgentChatEvent::Token { text: t };
                                }
                            }
                        }
                        Some(Ok(crate::logic::remote::RemoteEvent::Reasoning { provider, text, reset })) => {
                            if reset {
                                reasoning_buf = text;
                            } else {
                                reasoning_buf.push_str(&text);
                            }
                            if reasoning_buf.chars().count() > SUBAGENT_THINKING_MAX_CHARS {
                                reasoning_buf = truncate_chars(
                                    &reasoning_buf,
                                    SUBAGENT_THINKING_MAX_CHARS,
                                );
                            }
                            yield AgentChatEvent::SubagentThinking {
                                provider,
                                text: reasoning_buf.clone(),
                            };
                        }
                        Some(Ok(crate::logic::remote::RemoteEvent::Done { usage: u, provider: p, hit_cap: c })) => {
                            usage = Some(u);
                            cloud_provider = Some(p);
                            hit_cap = c;
                            break;
                        }
                        Some(Err(e)) => {
                            failed = Some(e);
                            break;
                        }
                        None => break, // stream end without Done — treat as complete
                    }
                }

                let latency = started.elapsed().as_millis() as i64;
                // Owned: the draft-JSON retry below may still set the winner.
                let provider = cloud_provider.clone().unwrap_or_else(|| {
                    remote
                        .as_ref()
                        .map(|r| r.provider_label().to_string())
                        .unwrap_or_else(|| "cloud".to_string())
                });

                // ── draft_document: parse JSON → write file → receipt ────
                #[cfg(feature = "office")]
                if is_draft && failed.is_none() {
                    let raw = answer.trim();
                    let mut blocks = extract_draft_blocks(raw);
                    // One correction round for malformed draft JSON.
                    if blocks.is_err() {
                        let err = blocks.as_ref().unwrap_err().clone();
                        eprintln!("[agent_chat] draft JSON invalid ({err}) — one correction round");
                        let retry_task = format!(
                            "{task}\n\nPREVIOUS ATTEMPT FAILED: {err}. \
                             Return ONLY the corrected JSON object {{\"blocks\": [...]}} — no prose, no code fence.",
                            task = call.task
                        );
                        let mut retry_text = String::new();
                        match remote
                            .as_ref()
                            .unwrap()
                            .stream(DRAFT_DOCUMENT_SYSTEM, &retry_task, &materials_for_call)
                            .await
                        {
                            Ok(s) => {
                                let mut s = Box::pin(s);
                                while let Some(item) = s.next().await {
                                    match item {
                                        Ok(crate::logic::remote::RemoteEvent::Token { text }) => {
                                            if retry_text.chars().count() < DRAFT_JSON_MAX_CHARS {
                                                retry_text.push_str(&text);
                                            }
                                        }
                                        Ok(crate::logic::remote::RemoteEvent::Reasoning { provider, text, reset }) => {
                                            if reset {
                                                reasoning_buf = text;
                                            } else {
                                                reasoning_buf.push_str(&text);
                                            }
                                            if reasoning_buf.chars().count()
                                                > SUBAGENT_THINKING_MAX_CHARS
                                            {
                                                reasoning_buf = truncate_chars(
                                                    &reasoning_buf,
                                                    SUBAGENT_THINKING_MAX_CHARS,
                                                );
                                            }
                                            yield AgentChatEvent::SubagentThinking {
                                                provider,
                                                text: reasoning_buf.clone(),
                                            };
                                        }
                                        Ok(crate::logic::remote::RemoteEvent::Done { usage: u, provider: p, .. }) => {
                                            if usage.is_none() {
                                                usage = Some(u);
                                            }
                                            if cloud_provider.is_none() {
                                                cloud_provider = Some(p);
                                            }
                                            break;
                                        }
                                        Err(e) => {
                                            failed = Some(e);
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(e) => failed = Some(e),
                        }
                        if failed.is_none() {
                            blocks = extract_draft_blocks(retry_text.trim());
                        }
                    }
                    if failed.is_none() {
                        match blocks {
                            Ok(blocks) if !blocks.is_empty() => {
                                let filename = call
                                    .filename
                                    .clone()
                                    .filter(|f| !f.trim().is_empty())
                                    .unwrap_or_else(|| "draft.docx".into());
                                match crate::logic::office::ooxml::create_document_from_blocks(
                                    &user_id, &filename, &blocks,
                                )
                                .await
                                {
                                    Ok(file) => {
                                        let titles = blocks
                                            .iter()
                                            .filter_map(|b| match b {
                                                crate::logic::office::ooxml::DocBlock::Heading { text, .. } => {
                                                    Some(text.clone())
                                                }
                                                _ => None,
                                            })
                                            .take(6)
                                            .collect::<Vec<_>>()
                                            .join(" · ");
                                        let receipt = serde_json::json!({
                                            "success": true,
                                            "file": file,
                                            "blocks": blocks.len(),
                                            "outline": titles,
                                        });
                                        db::log_turn(
                                            &user_id,
                                            db::TurnLogEntry {
                                                session_id: sid,
                                                agent_id: &agent_id,
                                                provider: &provider,
                                                tool: Some(DRAFT_DOCUMENT_TOOL),
                                                input_tokens: usage.map(|u| u.input_tokens as i64),
                                                output_tokens: usage
                                                    .map(|u| u.output_tokens as i64)
                                                    .or(Some((answer.chars().count() / 4) as i64)),
                                                latency_ms: latency,
                                                outcome: if call.escalated {
                                                    "escalated"
                                                } else {
                                                    "answer"
                                                },
                                            },
                                        )
                                        .await;
                                        yield AgentChatEvent::ToolResult {
                                            tool: call.tool.clone(),
                                            ok: true,
                                            summary: truncate_chars(
                                                &receipt.to_string(),
                                                TOOL_RESULT_UI_CHARS,
                                            ),
                                            data: None,
                                        };
                                        // Receipt back to local — short enough to
                                        // be safe in K/V; local closes the turn.
                                        prompt = format!(
                                            "response:{DRAFT_DOCUMENT_TOOL}:\n{receipt}\n\n\
                                             The document was created and saved. Tell the user \
                                             concisely (filename + what it contains). NO call: line."
                                        );
                                        continue;
                                    }
                                    Err(e) => {
                                        failed = Some(format!("file write failed: {e}"));
                                    }
                                }
                            }
                            Ok(_) => {
                                failed = Some("draft contained no content blocks".into());
                            }
                            Err(e) => {
                                failed = Some(format!(
                                    "cloud writer returned invalid document JSON twice ({e})"
                                ));
                            }
                        }
                    }
                }
                #[cfg(not(feature = "office"))]
                if is_draft {
                    failed = Some("draft_document requires the office feature".into());
                }

                // ── deep_write: final passthrough ─────────────────────────
                // A provider-side max_tokens cut leaves the answer hanging
                // mid-sentence — append an honest marker so the user knows.
                let answer = if hit_cap && !is_draft {
                    format!("{}\n\n_[output truncated at the provider token cap]_", answer.trim())
                } else {
                    answer.trim().to_string()
                };
                if failed.is_none() && !is_draft {
                    failed = answer
                        .is_empty()
                        .then(|| "cloud writer returned an empty answer".to_string());
                }
                if let Some(err) = failed {
                    eprintln!("[agent_chat] {} failed: {err}", call.tool);
                    db::log_turn(
                        &user_id,
                        db::TurnLogEntry {
                            session_id: sid,
                            agent_id: &agent_id,
                            provider: &provider,
                            tool: Some(&call.tool),
                            input_tokens: None,
                            output_tokens: None,
                            latency_ms: latency,
                            outcome: "error",
                        },
                    )
                    .await;
                    yield AgentChatEvent::ToolResult {
                        tool: call.tool.clone(),
                        ok: false,
                        summary: truncate_chars(&err, TOOL_RESULT_UI_CHARS),
                        data: None,
                    };
                    prompt = format!(
                        "response:{}:\nERROR: {err}\n\nThe cloud writer is unavailable. \
                         Answer the user directly with what you have (NO call: line).",
                        call.tool
                    );
                    continue;
                }
                db::log_turn(
                    &user_id,
                    db::TurnLogEntry {
                        session_id: sid,
                        agent_id: &agent_id,
                        provider: &provider,
                        tool: Some(DEEP_WRITE_TOOL),
                        input_tokens: usage.map(|u| u.input_tokens as i64),
                        output_tokens: usage
                            .map(|u| u.output_tokens as i64)
                            .or(Some((answer.chars().count() / 4) as i64)),
                        latency_ms: latency,
                        outcome: if call.escalated { "escalated" } else { "answer" },
                    },
                )
                .await;
                let _ = db::append_chat_message(&user_id, sid, "assistant", &answer).await;
                yield AgentChatEvent::ToolResult {
                    tool: call.tool.clone(),
                    ok: true,
                    summary: format!(
                        "cloud writer produced the answer ({provider}) — streamed above"
                    ),
                    data: None,
                };
                // The cloud answer streamed to the user but never entered the
                // engine: its conversation ends on the model's own
                // `call:deep_write` line, mid tool-lifecycle. Gemma halts
                // after requesting a tool — a follow-up message appended to
                // that dangling state makes the next generation come back
                // EMPTY (immediate EOS). Reset so the next turn opens a fresh
                // epoch (opener re-sent, transcript replays the cloud answer).
                let _ = crate::logic::local_llm::reset_conversation(&user_id).await;
                eprintln!("[agent_chat] reset conversation after deep_write passthrough");
                yield AgentChatEvent::Finished;
                return;
            }

            // (Re)build the opener when the conversation state does not carry
            // this session's manifest yet; otherwise keep the delta prompt
            // prepared by the previous iteration.
            if !crate::logic::local_llm::manifest_injected(&manifest_key) {
                // Take over the engine's Conversation-API K/V cleanly. The
                // singleton conversation (keyed by user) may already carry a
                // different framing — left by `local_chat` on a session that
                // predates the agent tier, or by a prior epoch. Appending
                // agent_chat's self-contained opener (persona + transcript +
                // request) on top of that overflows the K/V budget and makes
                // generation error out, so we reset before building the opener.
                let _ = crate::logic::local_llm::reset_conversation(&user_id).await;
                eprintln!("[agent_chat] reset conversation for takeover (agent={agent_id})");
                let budget = if recovered {
                    TRANSCRIPT_BUDGET_RETRY_CHARS
                } else {
                    TRANSCRIPT_BUDGET_CHARS
                };
                let transcript =
                    compact_transcript(&prior_turns, budget, &memory.evidence_digest());
                prompt = build_prompt(persona, toolset.as_ref(), &transcript, &message_for_model);
                manifest_pending = true;
            }

            // One generation through the engine (slot take/restore inside).
            let mut text = String::new();
            let mut generation_error = None;
            {
                let mut s = Box::pin(crate::logic::local_llm::local_chat(
                    user_id.clone(),
                    prompt.clone(),
                    None,
                    None,
                ));
                while let Some(event) = s.next().await {
                    match event {
                        LocalChatEvent::Token { text: t } => {
                            let t = strip_markers(&t);
                            if !t.is_empty() {
                                text.push_str(&t);
                                yield AgentChatEvent::Token { text: t };
                            }
                        }
                        // Thinking-mode reasoning: streamed to the UI for
                        // display; never part of the answer text or persistence.
                        LocalChatEvent::Thinking { text: t } => {
                            yield AgentChatEvent::Thinking { text: t };
                        }
                        LocalChatEvent::ToolCall { id: _, tool, args } => {
                            yield AgentChatEvent::ToolCall { tool, args };
                        }
                        LocalChatEvent::ToolResult { id: _, tool, ok, summary } => {
                            yield AgentChatEvent::ToolResult { tool, ok, summary, data: None };
                        }
                        LocalChatEvent::Error { message } => {
                            generation_error = Some(message);
                            break;
                        }
                        LocalChatEvent::Started | LocalChatEvent::Finished => {}
                    }
                }
            }

            // The opener entered the conversation state as soon as prefill
            // ran — EXCEPT on a prefill overflow (it never got in). Marking
            // here (not at build time) keeps the tracker truthful across
            // failed generations.
            let overflow = generation_error.as_deref().is_some_and(is_prefill_overflow);
            if manifest_pending && !overflow {
                crate::logic::local_llm::mark_manifest_injected(&manifest_key);
                manifest_pending = false;
            }

            // Overflow recovery: reset (fresh epoch clears the manifest
            // tracker) and retry once with a smaller transcript. The next
            // iteration rebuilds the opener over an empty conversation.
            if overflow {
                if recovered {
                    yield AgentChatEvent::Error {
                        message: generation_error.unwrap_or_else(|| {
                            "prefill overflow persisted after context compaction".into()
                        }),
                    };
                    return;
                }
                recovered = true;
                let _ = crate::logic::local_llm::reset_conversation(&user_id).await;
                continue;
            }

            if let Some(message) = generation_error {
                eprintln!("[agent_chat] generation_error (no delegation): {message}");
                yield AgentChatEvent::Error { message };
                return;
            }

            match parse_tool_call(&text) {
                // Final answer: fence-free reply. An EMPTY reply is never a
                // valid final answer (observed: model halts immediately when
                // the engine state dangles mid tool-lifecycle) — nudge once,
                // then fall through and accept whatever comes back.
                None if text.trim().is_empty() && empty_retries < 1 => {
                    empty_retries += 1;
                    eprintln!("[agent_chat] empty generation — nudging once");
                    prompt = format!(
                        "SYSTEM: your previous reply was empty. Answer the user's \
                         request now. If you were waiting for a tool result, it is \
                         no longer needed — answer with what you know.\n\n\
                         The user asked: {message}"
                    );
                    continue;
                }
                None => {
                    db::log_turn(
                        &user_id,
                        db::TurnLogEntry {
                            session_id: sid,
                            agent_id: &agent_id,
                            provider: "local",
                            tool: None,
                            input_tokens: None,
                            output_tokens: Some((text.chars().count() / 4) as i64),
                            latency_ms: turn_started.elapsed().as_millis() as i64,
                            outcome: "answer",
                        },
                    )
                    .await;
                    break text;
                }

                // Malformed fence: one repair round, then escalate to the
                // cloud writer (when configured) or fail the turn.
                Some(Err(detail)) => {
                    if repairs_used >= 1 {
                        // Escalation: the local model cannot format the tool
                        // call — hand the WHOLE user request to deep_write
                        // (transcript as materials) instead of failing.
                        if remote.is_some() && subagent_calls_used < MAX_SUBAGENT_CALLS {
                            eprintln!("[agent_chat] malformed fence twice ({detail}) — escalating to deep_write");
                            let mut materials = compact_transcript(
                                &prior_turns,
                                TRANSCRIPT_BUDGET_CHARS,
                                &memory.evidence_digest(),
                            );
                            let package_budget = remote
                                .as_ref()
                                .map(|r| r.materials_budget())
                                .unwrap_or(TOOL_RESULT_MATERIALS_CHARS);
                            let gathered = memory.materials(&message, package_budget);
                            if !gathered.is_empty() {
                                materials = format!(
                                    "{materials}\n\n[tool results gathered this session]\n{gathered}"
                                )
                                .trim()
                                .to_string();
                            }
                            pending_subagent = Some(PendingSubagent {
                                tool: DEEP_WRITE_TOOL.to_string(),
                                task: message.clone(),
                                materials,
                                filename: None,
                                escalated: true,
                            });
                            continue;
                        }
                        db::log_turn(
                            &user_id,
                            db::TurnLogEntry {
                                session_id: sid,
                                agent_id: &agent_id,
                                provider: "local",
                                tool: None,
                                input_tokens: None,
                                output_tokens: None,
                                latency_ms: turn_started.elapsed().as_millis() as i64,
                                outcome: "error",
                            },
                        )
                        .await;
                        yield AgentChatEvent::Error {
                            message: format!("model produced a malformed tool call twice ({detail})"),
                        };
                        return;
                    }
                    repairs_used += 1;
                    prompt = format!(
                        "TOOL_ERROR: malformed tool call ({detail}). The call MUST be ONE line, exactly this shape:\n\
                        call:<tool_name>{{\"<arg>\": <value>, ...}}\n\
                        Rules: call: + the tool name + ONE JSON object holding every argument as \"name\": value pairs (nested arrays/objects allowed as values). Do not put a colon between two argument names. Reply with the corrected call: line, or answer the user directly WITHOUT any call: line."
                    );
                }

                // Dispatchable call.
                Some(Ok((tool, args))) => {
                    // Cloud subagents: intercepted BEFORE the generic ToolSet
                    // dispatch (and before the plain-tool budget — they have
                    // their own). The next loop iteration executes them.
                    if remote.is_some() && (tool == DEEP_WRITE_TOOL || tool == DRAFT_DOCUMENT_TOOL) {
                        let task = args
                            .get("task")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default();
                        let mut materials = args
                            .get("materials")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default();
                        // The model only ever saw the excerpt slice of each
                        // result; its `materials` is at best a paraphrase of
                        // that slice. The cloud writer needs the full text —
                        // append the session's process log unless the model
                        // already embedded it verbatim (probe a mid-slice; a
                        // paraphrase never contains it). The package budget
                        // follows the provider pool: a frontier primary gets
                        // the full-size package, not the fallback floor.
                        let package_budget = remote
                            .as_ref()
                            .map(|r| r.materials_budget())
                            .unwrap_or(TOOL_RESULT_MATERIALS_CHARS);
                        let gathered = memory.materials(&message, package_budget);
                        if !gathered.is_empty() {
                            if !materials_embeds_results(&materials, &gathered) {
                                materials = format!(
                                    "{materials}\n\n[tool results gathered this session]\n{gathered}"
                                )
                                .trim()
                                .to_string();
                            }
                        } else if !prior_turns.is_empty() {
                            // No tools ran this turn (e.g. "summarize our
                            // conversation") — the small model cannot copy
                            // the history into `materials` itself, so hand it
                            // the session transcript deterministically.
                            let replay = compact_transcript(
                                &prior_turns,
                                TRANSCRIPT_BUDGET_CHARS,
                                &memory.evidence_digest(),
                            );
                            if !replay.is_empty()
                                && !materials.contains(&replay)
                            {
                                materials = format!(
                                    "{materials}\n\n[conversation so far]\n{replay}"
                                )
                                .trim()
                                .to_string();
                            }
                        }
                        let filename = args
                            .get("filename")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if task.trim().is_empty() {
                            yield AgentChatEvent::ToolResult {
                                tool: tool.clone(),
                                ok: false,
                                summary: format!("{tool} requires a non-empty 'task'"),
                                data: None,
                            };
                            prompt = format!(
                                "response:{tool}:\nERROR: 'task' must be a non-empty \
                                 string describing what to write. Retry with a complete brief, or \
                                 answer directly (NO call: line)."
                            );
                            continue;
                        }
                        pending_subagent = Some(PendingSubagent {
                            tool,
                            task,
                            materials,
                            filename,
                            escalated: false,
                        });
                        continue;
                    }

                    if calls_used >= MAX_TOOL_CALLS {
                        if budget_notified {
                            yield AgentChatEvent::Error {
                                message: "tool budget exhausted and the model kept calling tools".into(),
                            };
                            return;
                        }
                        budget_notified = true;
                        // Same cloud-close offer as the feedback prompt, plus
                        // the chain digest — a model that paged itself out of
                        // tools still closes from the full materials.
                        let chain = memory.chain_digest();
                        prompt = if cloud_close_eligible(
                            remote.is_some(),
                            subagent_calls_used,
                            &memory,
                        ) {
                            format!(
                                "TOOL_BUDGET_EXHAUSTED — you have used all tool calls for this turn.\n\n\
                                 [work completed this turn]\n{chain}\n\n\
                                 The full content of every item above is attached automatically. \
                                 Deliver the final answer via deep_write now: ONE call:deep_write \
                                 line with a complete task brief. Do not answer inline."
                            )
                        } else if chain.is_empty() {
                            "TOOL_BUDGET_EXHAUSTED — you have used all tool calls for this turn. Answer the user now with what you have (NO call: line).".into()
                        } else {
                            format!(
                                "TOOL_BUDGET_EXHAUSTED — you have used all tool calls for this turn.\n\n\
                                 [work completed this turn]\n{chain}\n\n\
                                 Answer the user now with what you have (NO call: line)."
                            )
                        };
                        continue;
                    }

                    // Turn-memory recall: intercepted before the generic
                    // ToolSet dispatch — it pages the turn's stored process
                    // log, no rig tool runs. Counts toward the same budget.
                    if tool == ARTIFACT_RECALL_TOOL {
                        match recall_args(&args) {
                            None => {
                                yield AgentChatEvent::ToolResult {
                                    tool: tool.clone(),
                                    ok: false,
                                    summary: format!("{ARTIFACT_RECALL_TOOL} requires a 'handle'"),
                                    data: None,
                                };
                                prompt = format!(
                                    "response:{ARTIFACT_RECALL_TOOL}:\nERROR: 'handle' is required \
                                     — a memN handle from a stored tool result. Retry with a valid \
                                     handle, or answer the user directly (NO call: line)."
                                );
                            }
                            Some((handle, offset)) => {
                    // data_import confirmation gate: the snapshot is cheap
                    // and read-only, but it touches a user-named external
                    // database — require an explicit yes in the user's
                    // CURRENT message before it runs. That covers both the
                    // confirm-card reply and the model asking first ("import
                    // X, ya?" → "ya" → the call passes straight through).
                    #[cfg(feature = "analytics")]
                    if tool == DATA_IMPORT_TOOL && !is_affirmative(&message) {
                        calls_used += 1;
                        let profile = args
                            .get("profile")
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        let table = args
                            .get("table")
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        eprintln!(
                            "[agent_chat] data_import pending confirmation: {profile}/{table}"
                        );
                        yield AgentChatEvent::ConfirmationRequest {
                            tool: tool.clone(),
                            prompt: format!(
                                "Import tabel `{table}` dari database `{profile}`?"
                            ),
                            accept_text: format!(
                                "Ya, lanjutkan import tabel {table} dari {profile}."
                            ),
                            decline_text: format!(
                                "Batal, jangan import tabel {table} dari {profile}."
                            ),
                        };
                        prompt = format!(
                            "response:{tool}:\nPENDING: this import needs the user's explicit \
                             confirmation. Ask them now in ONE short sentence (database \
                             {profile}, table {table}) and stop — NO further call: lines this \
                             turn. When they agree, call {tool} again with the same arguments."
                        );
                        continue;
                    }

                    yield AgentChatEvent::ToolCall { tool: tool.clone(), args: args.clone() };
                                calls_used += 1;
                                eprintln!(
                                    "[agent_chat] recall {calls_used}/{MAX_TOOL_CALLS}: {handle}@{offset}"
                                );
                                match memory.page(&handle, offset) {
                                    Ok((page, next)) => {
                                        let end = offset + page.chars().count();
                                        let more = match next {
                                            Some(n) => format!("next offset: {n}"),
                                            None => "end of stored output".to_string(),
                                        };
                                        let body = format!("{page}\n[chars {offset}..{end} — {more}]");
                                        yield AgentChatEvent::ToolResult {
                                            tool: tool.clone(),
                                            ok: true,
                                            summary: truncate_chars(&body, TOOL_RESULT_UI_CHARS),
                                            data: None,
                                        };
                                        memory.record(
                                            ARTIFACT_RECALL_TOOL,
                                            &format!("{handle}@{offset}"),
                                            page,
                                        );
                                        flush_new_artifacts(&user_id, sid, &mut memory).await;
                                        prompt = format!(
                                            "response:{ARTIFACT_RECALL_TOOL}:\n{body}\n\nContinue. \
                                             If you need another slice, reply with a single call: line; \
                                             otherwise answer the user directly."
                                        );
                                    }
                                    Err(msg) => {
                                        yield AgentChatEvent::ToolResult {
                                            tool: tool.clone(),
                                            ok: false,
                                            summary: truncate_chars(&msg, TOOL_RESULT_UI_CHARS),
                                            data: None,
                                        };
                                        prompt = format!(
                                            "response:{ARTIFACT_RECALL_TOOL}:\nERROR: {msg}\n\n\
                                             Retry with a valid handle and offset, or answer the \
                                             user directly (NO call: line)."
                                        );
                                    }
                                }
                            }
                        }
                        continue;
                    }

                    yield AgentChatEvent::ToolCall { tool: tool.clone(), args: args.clone() };
                    calls_used += 1;
                    eprintln!("[agent_chat] tool call {calls_used}/{MAX_TOOL_CALLS}: {tool} args={}", truncate_chars(&args.to_string(), 300));

                    // Resolve any short alias (doc1) the model emitted back to
                    // the real store id before the rig tool runs — the model
                    // never sees the real id. The resolved args also key the
                    // turn-memory dedup.
                    let exec_args = alias_resolve_args(sid, &args);
                    let args_key = canonical_args_key(&exec_args);
                    // Session evidence cache: a LATER turn of this session
                    // re-reading an unchanged file is served from the parked
                    // cache instead of re-dispatching the tool (cross-turn
                    // memory; freshness = file fingerprint).
                    if let Some((cached_body, age_secs)) =
                        crate::logic::evidence_cache::probe(&user_id, sid, &tool, &exec_args)
                    {
                        eprintln!(
                            "[agent_chat] cache hit {calls_used}/{MAX_TOOL_CALLS}: {tool} ({age_secs}s old)"
                        );
                        yield AgentChatEvent::ToolCall { tool: tool.clone(), args: args.clone() };
                        yield AgentChatEvent::ToolResult {
                            tool: tool.clone(),
                            ok: true,
                            summary: truncate_chars(&cached_body, TOOL_RESULT_UI_CHARS),
                            data: ui_payload(&cached_body),
                        };
                        memory.record(&tool, &args_key, cached_body.clone());
                        flush_new_artifacts(&user_id, sid, &mut memory).await;
                        prompt = if cloud_close_eligible(
                            remote.is_some(),
                            subagent_calls_used,
                            &memory,
                        ) {
                            format!(
                                "response:{tool}:\n{cached_body}\n\n\
                                 You have gathered substantial materials this turn — the full content of \
                                 every stored result is attached automatically. Deliver the final answer \
                                 via deep_write now: ONE call:deep_write line with a complete task brief \
                                 (audience, structure, focus, length). Do NOT write the long answer \
                                 yourself. If one more tool call is essential, make that single call, \
                                 then delegate."
                            )
                        } else {
                            format!(
                                "response:{tool}:\n{cached_body}\n\n[Served from this session's cache — \
                                 {age_secs}s old; the underlying file is unchanged.]\n\nContinue. If you \
                                 need another tool, reply with a single call: line; otherwise answer the \
                                 user directly."
                            )
                        };
                        continue;
                    }
                    let result = match toolset.as_ref() {
                        Some(set) => set.execute(&tool, exec_args.to_string()).await,
                        None => {
                            // No tools registered for this agent: feed the
                            // hallucinated call straight back as an error.
                            let body = format!(
                                "ERROR: tool {tool:?} does not exist (no tools are available)"
                            );
                            yield AgentChatEvent::ToolResult {
                                tool: tool.clone(),
                                ok: false,
                                summary: truncate_chars(&body, TOOL_RESULT_UI_CHARS),
                                data: None,
                            };
                            prompt = format!("response:{tool}:\nERROR: tool {tool:?} does not exist (no tools are available)\n\nAnswer the user directly now — no tools are available.");
                            continue
                        }
                    };

                    let ok = result.is_success();
                    let body = alias_rewrite_body(sid, &tool, &tool_result_body(&result));
                    eprintln!("[agent_chat] tool result {tool}: ok={ok} {}", truncate_chars(&body, 300));
                    yield AgentChatEvent::ToolResult {
                        tool: tool.clone(),
                        ok,
                        summary: truncate_chars(&body, TOOL_RESULT_UI_CHARS),
                        data: if ok { ui_payload(&body) } else { None },
                    };
                    // Summary requests must not stop at excerpts: nudge the
                    // model toward full read + delegation with the file id
                    // resolved from the first hit.
                    let summary_nudge = if tool == "knowledge_search"
                        && ok
                        && is_summary_request(&message)
                    {
                        // Prefer the user's explicit attachment — it is the
                        // authoritative target; fall back to the first hit.
                        // Both are already aliases at this point (the
                        // attachment block and the rewritten result use
                        // handles), so the directive names the handle the
                        // model actually knows.
                        attached_ids
                            .first()
                            .and_then(|id| alias_of(sid, id))
                            .or_else(|| first_file_id(&body))
                            .map(|fid| summary_directive(&fid))
                    } else {
                        None
                    };
                    // Append the completed process to the turn's process log
                    // (dedup on tool + resolved args), then decide what
                    // re-enters the conversation. Oversized bodies become a
                    // handle + excerpt — the full text stays in the log for
                    // artifact_recall and the cloud-subagent materials, so
                    // truncation is recoverable, never destructive.
                    let handle = memory.record(&tool, &args_key, body.clone());
                    // Park the completed read for later turns of this session
                    // (only cacheable deterministic reads actually store).
                    if ok {
                        crate::logic::evidence_cache::store_result(
                            &user_id,
                            sid,
                            &tool,
                            &exec_args,
                            &body,
                        );
                    }
                    flush_new_artifacts(&user_id, sid, &mut memory).await;
                    let model_body = if body.chars().count() > TOOL_RESULT_MODEL_CHARS {
                        let total = body.chars().count();
                        let excerpt: String = body.chars().take(ARTIFACT_EXCERPT_CHARS).collect();
                        format!(
                            "[stored as {handle} — {total} chars total]\n{excerpt}\n\
                             [end of excerpt — the full output stays stored for this session. \
                             To read more call artifact_recall with \
                             {{\"handle\": \"{handle}\", \"offset\": {ARTIFACT_EXCERPT_CHARS}}}]"
                        )
                    } else {
                        body
                    };
                    // Cloud close: real payload gathered + cloud budget
                    // untouched → direct the model to delegate the final
                    // answer (cloud synthesizes from the full log; local
                    // only saw excerpts). A nudge, not a hard gate — the
                    // persona's short-reply rule still lets trivial answers
                    // through, and an ignoring model just answers locally.
                    prompt = if cloud_close_eligible(remote.is_some(), subagent_calls_used, &memory)
                    {
                        format!(
                            "response:{tool}:\n{model_body}\n\n\
                             You have gathered substantial materials this turn — the full content of \
                             every stored result is attached automatically. Deliver the final answer \
                             via deep_write now: ONE call:deep_write line with a complete task brief \
                             (audience, structure, focus, length). Do NOT write the long answer \
                             yourself. If one more tool call is essential, make that single call, \
                             then delegate."
                        )
                    } else {
                        format!(
                            "response:{tool}:\n{model_body}\n\nContinue. If you need another tool, reply with a single call: line; otherwise answer the user directly."
                        )
                    };
                    if let Some(nudge) = summary_nudge {
                        prompt.push_str(&nudge);
                    }
                }
            }
        };

        let _ = db::append_chat_message(&user_id, sid, "assistant", final_answer.trim()).await;
        yield AgentChatEvent::Finished;
    }
}

// Nearly every unit here exercises litert-gated machinery (TurnMemory,
// personas, toolsets, aliases) — run this module only when litert is on so
// narrower feature combos (e.g. analytics-sql) can still compile their own
// tests.
#[cfg(all(test, feature = "litert"))]
mod tests {
    use super::*;

    #[test]
    fn turn_memory_record_is_sequential_and_deduped() {
        let mut m = TurnMemory::default();
        assert_eq!(
            m.record("office_read_document", "args-a", "hello".into()),
            "mem1"
        );
        // Same tool + same args → same handle, no growth.
        assert_eq!(
            m.record("office_read_document", "args-a", "hello again".into()),
            "mem1"
        );
        // Same tool, different args → new entry.
        assert_eq!(
            m.record("office_read_document", "args-b", "other".into()),
            "mem2"
        );
        // Different tool, same args string → new entry.
        assert_eq!(
            m.record("pdf_extract_text", "args-a", "pdf text".into()),
            "mem3"
        );
        assert_eq!(m.artifacts.len(), 3);
        // Case-insensitive handle lookup (via page).
        assert!(m.page("MEM1", 0).is_ok());
        assert!(m.page("nope", 0).is_err());
    }

    #[test]
    fn turn_memory_dedup_key_ignores_key_order() {
        let mut m = TurnMemory::default();
        // Same semantic args written with different key order → same handle
        // (serde_json runs with preserve_order via schemars/rig, so plain
        // to_string would keep insertion order and dedup-fail).
        let a: Value = serde_json::from_str(r#"{"query":"btc","limit":5}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"limit":5,  "query":"btc"}"#).unwrap();
        assert_eq!(
            m.record("web_search", &canonical_args_key(&a), "r1".into()),
            "mem1"
        );
        assert_eq!(
            m.record("web_search", &canonical_args_key(&b), "r2".into()),
            "mem1",
            "key-order difference must not duplicate the entry"
        );
        // Genuinely different args still get their own entry.
        let d: Value = serde_json::from_str(r#"{"query":"eth","limit":5}"#).unwrap();
        assert_eq!(
            m.record("web_search", &canonical_args_key(&d), "r4".into()),
            "mem2"
        );
        // Nested objects are sorted recursively too — same semantics written
        // with different inner and outer key orders dedup to one entry.
        let n1: Value =
            serde_json::from_str(r#"{"opts":{"z":1,"a":2},"query":"btc","limit":5}"#).unwrap();
        let n2: Value =
            serde_json::from_str(r#"{"limit":5,"opts":{"a":2,"z":1},"query":"btc"}"#).unwrap();
        assert_eq!(
            m.record("web_search", &canonical_args_key(&n1), "r5".into()),
            "mem3"
        );
        assert_eq!(
            m.record("web_search", &canonical_args_key(&n2), "r6".into()),
            "mem3",
        );
        assert_eq!(m.artifacts.len(), 3);
    }

    #[test]
    fn turn_memory_pages_full_range() {
        let mut m = TurnMemory::default();
        let body: String = (0..10_000)
            .map(|i| char::from_digit(i % 10, 10).unwrap())
            .collect();
        m.record("office_read_document", "k", body.clone());

        let (p1, next1) = m.page("mem1", 0).unwrap();
        assert_eq!(p1.chars().count(), ARTIFACT_PAGE_CHARS);
        assert_eq!(next1, Some(ARTIFACT_PAGE_CHARS));
        // The page is the verbatim head of the body.
        let expected: String = body.chars().take(ARTIFACT_PAGE_CHARS).collect();
        assert_eq!(p1, expected);

        // Walk to the end.
        let mut offset = 0usize;
        let mut total = 0usize;
        while let Ok((page, next)) = m.page("mem1", offset) {
            total += page.chars().count();
            match next {
                Some(n) => offset = n,
                None => break,
            }
        }
        assert_eq!(total, 10_000);

        // Past-the-end offset teaches the valid range.
        let err = m.page("mem1", 10_000).unwrap_err();
        assert!(err.contains("Valid range"), "got {err}");
        // Unknown handle teaches valid handles.
        let err2 = m.page("memX", 0).unwrap_err();
        assert!(err2.contains("mem1"), "got {err2}");
    }

    #[test]
    fn restored_artifacts_continue_numbering_and_dedup() {
        let mut m = TurnMemory::default();
        m.restore(vec![TurnArtifact {
            handle: "mem1".into(),
            tool: "office_read_document".into(),
            args_key: "file:doc1".into(),
            content: "body".into(),
        }]);
        // New records continue the restored numbering…
        assert_eq!(m.record("binance_price", "sym:BTCUSDT", "{}".into()), "mem2");
        // …and re-running a restored call returns its existing handle.
        assert_eq!(
            m.record("office_read_document", "file:doc1", "other".into()),
            "mem1"
        );
        assert_eq!(m.artifacts.len(), 2);
    }

    #[test]
    fn take_unpersisted_advances_cursor_once() {
        let mut m = TurnMemory::default();
        m.record("t", "a", "one".into());
        let fresh = m.take_unpersisted();
        assert_eq!(fresh.iter().map(|a| a.handle.as_str()).collect::<Vec<_>>(), ["mem1"]);
        // Cursor advanced: nothing new since the last flush.
        assert!(m.take_unpersisted().is_empty());
        m.record("t2", "b", "two".into());
        let fresh2 = m.take_unpersisted();
        assert_eq!(fresh2.iter().map(|a| a.handle.as_str()).collect::<Vec<_>>(), ["mem2"]);
    }

    #[test]
    fn restored_entries_are_not_reflushed() {
        let mut m = TurnMemory::default();
        m.restore(vec![TurnArtifact {
            handle: "mem1".into(),
            tool: "office_read_document".into(),
            args_key: "file:doc1".into(),
            content: "body".into(),
        }]);
        // Restore marks prior entries as already persisted.
        assert!(m.take_unpersisted().is_empty());
    }

    #[test]
    fn evidence_digest_lists_handles_and_caps_items() {
        let mut m = TurnMemory::default();
        assert_eq!(m.evidence_digest(), "");
        m.record("office_read_document", "a", "x".repeat(100));
        let d = m.evidence_digest();
        assert!(d.contains("mem1 office_read_document 100 chars"), "got {d}");
        assert!(d.contains("artifact_recall"));
        for i in 0..24 {
            m.record("web_read", &format!("k{i}"), "y".into());
        }
        let d = m.evidence_digest();
        assert!(d.contains("… 1 more"), "got {d}");
        assert!(!d.contains("mem25 "), "capped items must not render");
    }

    #[test]
    fn turn_memory_materials_all_fit_has_no_note() {
        let mut m = TurnMemory::default();
        m.record("office_list_files", "a", "{\"files\":[]}".into());
        m.record("binance_price", "b", "{\"price\":\"1\"}".into());
        let materials = m.materials("", TOOL_RESULT_MATERIALS_CHARS);
        assert!(materials.contains("--- office_list_files ---"));
        assert!(materials.contains("--- binance_price ---"));
        // Everything fit → no packaging note, no ellipsis.
        assert!(!materials.contains("MATERIALS NOTE"), "got {materials}");
        assert!(!materials.contains('…'));
    }

    #[test]
    fn turn_memory_materials_overflow_lists_omitted() {
        let mut m = TurnMemory::default();
        m.record("office_list_files", "a", "{\"files\":[]}".into());
        m.record("office_read_document", "b", "x".repeat(50_000));
        m.record("pdf_extract_text", "c", "y".repeat(40_000));
        let materials = m.materials("", TOOL_RESULT_MATERIALS_CHARS);
        // Kept blocks stay WHOLE (no mid-body cut), the small head included.
        assert!(materials.contains("{\"files\":[]}"));
        assert!(!materials.contains('…'), "no silent mid-block truncation");
        // The omission is explicit and lists every dropped artifact.
        assert!(materials.contains("[MATERIALS NOTE: 2 of 3"), "got {materials}");
        assert!(materials.contains("mem2 office_read_document"), "got {materials}");
        assert!(materials.contains("mem3 pdf_extract_text"), "got {materials}");
        // The package never exceeds the cap despite the note.
        assert!(materials.chars().count() <= TOOL_RESULT_MATERIALS_CHARS);
    }

    #[test]
    fn turn_memory_materials_single_giant_head_truncates() {
        // One entry whose body alone reaches the package cap: it must still
        // ship (head block, ellipsis tail) instead of an empty package.
        let mut m = TurnMemory::default();
        m.record(
            "office_read_document",
            "a",
            format!("{}tail", "z".repeat(TOOL_RESULT_MATERIALS_CHARS)),
        );
        let materials = m.materials("", TOOL_RESULT_MATERIALS_CHARS);
        assert_eq!(m.artifacts.len(), 1);
        assert!(materials.starts_with("--- office_read_document ---"));
        assert!(materials.contains('…'), "giant head must be capped");
        assert!(materials.chars().count() <= TOOL_RESULT_MATERIALS_CHARS + 60);
    }

    #[test]
    fn turn_memory_materials_ranking_prefers_focus_match() {
        // A giant early read that has NOTHING to do with the question must
        // not crowd out the small decisive hit — selection is relevance-
        // ranked, not first-come-first-served.
        let mut m = TurnMemory::default();
        m.record("office_read_document", "a", "x".repeat(31_980));
        m.record(
            "binance_price",
            "b",
            r#"{"symbol":"BTCUSDT","price":"64000"}"#.into(),
        );
        let materials = m.materials("apa harga binance sekarang", 32_000);
        // The focus-matched small block ships whole…
        assert!(materials.contains("BTCUSDT"), "got {materials}");
        assert!(materials.contains("--- binance_price ---"));
        // …the irrelevant giant is dropped EXPLICITLY, not silently.
        assert!(materials.contains("[MATERIALS NOTE: 1 of 2"), "got {materials}");
        assert!(materials.contains("mem1 office_read_document"));
        assert!(!materials.contains('…'));
    }

    #[test]
    fn turn_memory_materials_renders_chronologically_when_all_fit() {
        let mut m = TurnMemory::default();
        m.record("web_search", "a", "alpha result".into());
        m.record("web_read", "b", "beta page body".into());
        // Focus matches BOTH blocks; chronological order must survive.
        let materials = m.materials("alpha beta page", 32_000);
        let a = materials.find("--- web_search ---").unwrap();
        let b = materials.find("--- web_read ---").unwrap();
        assert!(a < b, "blocks must render in turn order");
    }

    #[test]
    fn turn_memory_materials_budget_scales_with_provider() {
        // The same log under a frontier-sized budget ships EVERYTHING —
        // the fallback floor must not starve a big-context provider.
        let mut m = TurnMemory::default();
        m.record("office_list_files", "a", "{\"files\":[]}".into());
        m.record("office_read_document", "b", "x".repeat(50_000));
        m.record("pdf_extract_text", "c", "y".repeat(40_000));
        let materials = m.materials("", 131_072);
        assert!(materials.contains("{\"files\":[]}"));
        assert!(materials.contains("--- office_read_document ---"));
        assert!(materials.contains("--- pdf_extract_text ---"));
        assert!(!materials.contains("MATERIALS NOTE"), "got {materials}");
    }

    #[test]
    fn staging_requests_parse_and_degrade() {
        // Valid request list.
        let reqs = parse_staging_requests(
            r#"{"requests": [{"handle": "mem2", "offset": 3600}, {"handle": "mem1"}]}"#,
        )
        .unwrap();
        assert_eq!(reqs, vec![("mem2".into(), 3600), ("mem1".into(), 0)]);
        // Ready / prose / garbage all degrade to None (single-shot fallback).
        assert!(parse_staging_requests(r#"{"ready": true}"#).is_none());
        assert!(parse_staging_requests("I can write this from the given materials.").is_none());
        assert!(parse_staging_requests("").is_none());
        // Missing handle inside an entry poisons the payload → None.
        assert!(parse_staging_requests(r#"{"requests": [{"offset": 5}]}"#).is_none());
    }

    #[test]
    fn staging_slices_serve_pages_and_skip_invalid() {
        let mut m = TurnMemory::default();
        m.record("office_read_document", "a", "abcdefgh".repeat(1_000)); // 8000 chars
        m.record("pdf_extract_text", "b", "tiny".into());

        let slices = m.staging_slices(&[
            ("mem1".into(), 7_000),           // valid: tail page (1000 chars)
            ("memX".into(), 0),               // unknown handle — skipped
            ("mem1".into(), 999_999),         // past-the-end — skipped
            ("MEM1".into(), 7_000),           // case-insensitive dedup
        ]);
        assert!(slices.contains("[ADDITIONAL SLICES fetched at this writer's request]"));
        assert!(slices.contains("--- requested slice mem1 @7000 ---"));
        assert!(slices.chars().count() < 4_000);

        // Nothing resolvable → empty string (caller keeps the base package).
        assert_eq!(m.staging_slices(&[("nope".into(), 0)]), "");
    }

    #[test]
    fn turn_memory_chain_digest_and_total() {
        let mut m = TurnMemory::default();
        assert_eq!(m.total_content_chars(), 0);
        assert!(m.chain_digest().is_empty());
        m.record("office_list_files", "a", "12345".into()); // 5 chars
        m.record("binance_price", "b", "6789".into()); // 4 chars
        let digest = m.chain_digest();
        assert!(
            digest.contains("mem1 office_list_files 5 chars"),
            "got {digest}"
        );
        assert!(
            digest.contains("mem2 binance_price 4 chars"),
            "got {digest}"
        );
        assert_eq!(m.total_content_chars(), 9);
    }

    #[test]
    fn recall_args_parses_and_rejects() {
        let ok = serde_json::json!({"handle": "mem1", "offset": 2400});
        assert_eq!(recall_args(&ok), Some(("mem1".into(), 2400)));
        let no_offset = serde_json::json!({"handle": "mem2"});
        assert_eq!(recall_args(&no_offset), Some(("mem2".into(), 0)));
        // Blank/missing handle → None (teaching error path).
        assert_eq!(recall_args(&serde_json::json!({"handle": "  "})), None);
        assert_eq!(recall_args(&serde_json::json!({"offset": 5})), None);
        assert_eq!(recall_args(&serde_json::json!({})), None);
    }

    #[test]
    fn cloud_close_condition_matrix() {
        // No payload → never eligible.
        let mut m = TurnMemory::default();
        assert!(!cloud_close_eligible(true, 0, &m));
        // Real payload + remote configured + subagent budget untouched.
        m.record(
            "office_read_document",
            "a",
            "x".repeat(CLOUD_CLOSE_MIN_CHARS),
        );
        assert!(cloud_close_eligible(true, 0, &m));
        // Pure-local build (no vault keys) → never.
        assert!(!cloud_close_eligible(false, 0, &m));
        // Cloud call already spent this turn (MAX_SUBAGENT_CALLS = 1).
        assert!(!cloud_close_eligible(true, 1, &m));
        // Below threshold → trivial turns stay local.
        let mut small = TurnMemory::default();
        small.record("office_list_files", "a", "x".repeat(1_000));
        assert!(!cloud_close_eligible(true, 0, &small));
    }

    #[test]
    fn alias_assign_is_stable_and_sequential() {
        let sid = 99001;
        let a = alias_assign(sid, "f87366129058607000-0000");
        let b = alias_assign(sid, "f87328470555963000-0000");
        let a2 = alias_assign(sid, "f87366129058607000-0000");
        assert_eq!(a, "doc1");
        assert_eq!(b, "doc2");
        assert_eq!(a2, "doc1"); // reuse, not reassign
        assert_eq!(alias_resolve(sid, "doc1"), "f87366129058607000-0000");
        assert_eq!(alias_resolve(sid, "Doc1"), "f87366129058607000-0000");
        assert_eq!(alias_resolve(sid, "nope"), "nope");
    }

    #[test]
    fn alias_rewrite_body_replaces_list_and_search_ids() {
        let sid = 99002;
        let list = r#"{"files":[{"id":"f87366129058607000-0000","originalName":"a.pdf"},{"id":"f87328470555963000-0000","originalName":"b.pdf"}]}"#;
        let out = alias_rewrite_body(sid, "office_list_files", list);
        assert!(out.contains("\"id\":\"doc1\""), "got {out}");
        assert!(out.contains("\"id\":\"doc2\""), "got {out}");

        let search = r#"{"hits":[{"fileId":"f87366129058607000-0000","content":"x"}]}"#;
        let out2 = alias_rewrite_body(sid, "knowledge_search", search);
        assert!(out2.contains("\"fileId\":\"doc1\""), "got {out2}");

        // Untouched tools keep their body verbatim.
        let other = r#"{"answer":"ok"}"#;
        assert_eq!(alias_rewrite_body(sid, "some_tool", other), other);
    }

    #[cfg(feature = "litert")]
    #[test]
    fn alias_resolve_args_maps_file_id() {
        let sid = 99003;
        alias_assign(sid, "f87366129058607000-0000");
        let args = serde_json::json!({"fileId":"doc1","operations":[]});
        let out = alias_resolve_args(sid, &args);
        assert_eq!(out["fileId"], "f87366129058607000-0000");
        assert!(out["operations"].is_array());
    }

    #[test]
    fn parse_no_fence_is_final_answer() {
        assert!(parse_tool_call("Here is your answer, no tools needed.").is_none());
        assert!(parse_tool_call("").is_none());
    }

    #[test]
    fn parse_valid_tool_call() {
        let text = "Let me check.\n```tool\n{\"tool\": \"office_list_files\", \"args\": {}}\n```\n";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "office_list_files");
                assert_eq!(args, serde_json::json!({}));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_tool_call_with_args_and_prose() {
        let text = "Sure — reading the file first.\n```tool\n{\"tool\": \"office_read_document\", \"args\": {\"fileId\": \"f123\"}}\n```\nDone waiting.";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "office_read_document");
                assert_eq!(args["fileId"], "f123");
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_args_optional() {
        let text = "```tool\n{\"tool\": \"office_list_files\"}\n```";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "office_list_files");
                assert_eq!(args, serde_json::json!({}));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_unterminated_fence_is_malformed() {
        assert!(matches!(
            parse_tool_call("```tool\n{\"tool\": \"x\"}"),
            Some(Err(_))
        ));
    }

    #[test]
    fn parse_invalid_json_is_malformed() {
        assert!(matches!(
            parse_tool_call("```tool\nnot json at all\n```"),
            Some(Err(_))
        ));
    }

    #[test]
    fn parse_missing_tool_field_is_malformed() {
        assert!(matches!(
            parse_tool_call("```tool\n{\"args\": {}}\n```"),
            Some(Err(_))
        ));
    }

    #[test]
    fn parse_first_fence_wins_and_case_insensitive_opener() {
        let text = "```TOOL\n{\"tool\": \"a\"}\n```\n\n```tool\n{\"tool\": \"b\"}\n```";
        match parse_tool_call(text) {
            Some(Ok((tool, _))) => assert_eq!(tool, "a"),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_bare_tool_name_is_lenient() {
        // Model forgot the JSON wrapper entirely — dispatch with empty args so
        // arg validation can nudge it instead of failing the turn.
        match parse_tool_call("```tool\noffice_create_document\n```") {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "office_create_document");
                assert_eq!(args, serde_json::json!({}));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_native_gemma_tool_call_garbled() {
        // Exact shape observed from Gemma 4: bare keys, escaped quotes,
        // one-line collapse of the native multi-line format.
        let text = "<|tool_call>call:knowledge_search{mode:<|\"|>keyword<|\"|>,query:<|\"|>Gw Coba Trading Forex Selama 42 Hari Tanpa Pengalaman<|\"|>}<tool_call|>";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "knowledge_search");
                assert_eq!(args["mode"], "keyword");
                assert_eq!(
                    args["query"],
                    "Gw Coba Trading Forex Selama 42 Hari Tanpa Pengalaman"
                );
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_native_gemma_tool_call_multiline() {
        // The well-formed native form: closed opener, JSON on its own line,
        // `<|tool_call_end|>` terminator, already-quoted keys.
        let text = "Sure.\n<|tool_call|>\ncall:knowledge_search\n{\"query\": \"invoice total\", \"mode\": \"hybrid\"}\n<|tool_call_end|>";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "knowledge_search");
                assert_eq!(args["query"], "invoice total");
                assert_eq!(args["mode"], "hybrid");
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_native_tool_call_no_args() {
        match parse_tool_call("prefix<|tool_call>call:office_list_files<tool_call|>suffix") {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "office_list_files");
                assert_eq!(args, serde_json::json!({}));
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_bare_native_call_without_markers() {
        // Exact persisted shape: model dropped ALL special tokens and emitted
        // only the compact body, real quotes but bare keys.
        let text = r#"call:knowledge_search{mode:"keyword",query:"Gw Coba Trading Forex Selama 42 Hari Tanpa Pengalaman"}"#;
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "knowledge_search");
                assert_eq!(args["mode"], "keyword");
                assert_eq!(
                    args["query"],
                    "Gw Coba Trading Forex Selama 42 Hari Tanpa Pengalaman"
                );
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_bare_call_with_prose_around() {
        let text = "Let me search the transcript.\ncall:knowledge_search{query:\"porto terbesar\"}\nthanks";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "knowledge_search");
                assert_eq!(args["query"], "porto terbesar");
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn parse_bare_call_selftruncated_materials_and_bare_task_key() {
        // Exact persisted shape (msg id 33): the model closed a huge
        // self-truncated materials string with "... \", then wrote the next
        // key WITHOUT its opening quote — ",task": "..." — which desyncs the
        // string tracker. Repairs must recover the dispatchable call.
        let text = concat!(
            r#"call:deep_write{"materials": "Ringkasan Video: \"Gw Coba Trading Forex Selama 4 Hari Tanpa Pengalama\"\n\n"#,
            r#"> Catatan: video yang dirum berjudul \"…42 Hari…\", bukan 4 hari.\n## Perjalanan (dari Nol)\n- Kelly 8,3% vs praktik 0,2-0,4%"#,
            r#" \n- dia benar tapi \"mati di tikungan\" jika posisi keb... ",task": "Ringkaskan seluruh isi video tersebut menjadi satu paragraf tunggal yang padat dan informatif."}"#,
            "\n",
        );
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "deep_write");
                assert!(args["materials"].as_str().unwrap().contains("Kelly 8,3%"));
                assert_eq!(
                    args["task"],
                    "Ringkaskan seluruh isi video tersebut menjadi satu paragraf tunggal yang padat dan informatif."
                );
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn recognizable_broken_call_triggers_repair_not_prose() {
        // Exact persisted shape (msg id 47): THREE call: lines, all broken —
        // doubled tool name, corrupted ids, consecutive string values, a
        // missing replace key. None parses, but each has a valid name +
        // balanced braces → must surface as MALFORMED (repair round), never
        // as a silent final answer.
        let text = "I need to replace \"June\" with \"August\" in all documents.\n\ncall:office_edit_document_document{\"fileId\": \"f36.pdf\",\"operations\": [{\"type\": \"replace_text\", \"find\": \"June, \"August\"}]}\ncall:office_edit_document{\"file_Id\": \"f7\",\"operations\": [{\"type\": \"replace_text\", \"find\": \"June\", \"August\"}]}\ncall:office_edit_document{\"file_Id\": \"f\": \"operations\": [{\"type\": \"replace_text\", \"find\": \"June\", \"August\"}]}";
        match parse_tool_call(text) {
            Some(Err(detail)) => {
                assert!(
                    detail.contains("call:"),
                    "detail should name the call: {detail}"
                );
            }
            other => panic!("expected Err (malformed), got {other:?}"),
        }
    }

    #[test]
    fn healthy_line_among_broken_ones_wins() {
        // Second line valid → dispatched even though the first is broken.
        let text = "call:office_edit_document{\"fileId\": \"f7\",\"find\": \"June, \"August\"}\ncall:knowledge_search{\"query\": \"june\"}";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "knowledge_search");
                assert_eq!(args["query"], "june");
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn quote_bare_keys_supplies_missing_opening_quote() {
        assert_eq!(
            quote_bare_keys(r#"{"a": "x",b": "y"}"#),
            r#"{"a": "x","b": "y"}"#
        );
    }

    #[test]
    fn parse_inline_fence_json_glued_to_opener() {
        // Observed: no newline after ```tool, closing fence glued to the JSON.
        let text = "prose before.```tool{\"tool\": \"deep_write\", \"args\": {\"task\": \"Ringkasan\", \"materials\": \"judul saja\"}}```Mohon maaf.";
        match parse_tool_call(text) {
            Some(Ok((tool, args))) => {
                assert_eq!(tool, "deep_write");
                assert_eq!(args["task"], "Ringkasan");
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[cfg(feature = "litert")]
    #[test]
    fn summary_request_detection() {
        assert!(is_summary_request("ringkaskan youtube video \"...\""));
        assert!(is_summary_request("Tolong rangkum dokumen ini"));
        assert!(is_summary_request("give me a summary of the report"));
        assert!(is_summary_request("TLDR please"));
        assert!(!is_summary_request("berapa total invoice ini?"));
        assert!(!is_summary_request("what is the invoice code"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn first_file_id_from_search_body() {
        let body = r#"{"hits":[{"source":"yt-x.md","locator":"x","content":"...","fileId":"f123-0000"},{"fileId":"f124-0000"}]}"#;
        assert_eq!(first_file_id(body).as_deref(), Some("f123-0000"));
        assert_eq!(first_file_id(r#"{"hits":[]}"#), None);
        assert_eq!(first_file_id("not json"), None);
    }

    #[cfg(feature = "litert")]
    #[test]
    fn materials_embed_detection() {
        let results = format!(
            "--- office_read_document ---\n{}",
            "transcript line. ".repeat(200)
        );
        // Paraphrase does not embed → append needed.
        assert!(!materials_embeds_results(
            "video tentang trading forex selama 42 hari, tiga porto",
            &results
        ));
        // Verbatim paste embeds → skip append.
        let pasted = format!("judul video\n{results}");
        assert!(materials_embeds_results(&pasted, &results));
        // Short results: exact containment.
        assert!(materials_embeds_results("x: small", "small"));
        assert!(!materials_embeds_results("x: other", "small"));
    }

    #[test]
    fn parse_fence_with_info_string_still_works() {
        let text = "```tool json\n{\"tool\": \"a\"}\n```";
        match parse_tool_call(text) {
            Some(Ok((tool, _))) => assert_eq!(tool, "a"),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    #[test]
    fn bare_call_word_boundary_and_prose_ignored() {
        // "recall:" embeds "call:" — boundary check must skip it.
        assert!(parse_tool_call("I recall: the day we met. Nothing else.").is_none());
        // call: with no braces is not a tool call.
        assert!(parse_tool_call("You should call: me later today.").is_none());
        // Unbalanced braces stay prose, not a malformed-call error.
        assert!(parse_tool_call("call:knowledge_search{query:\"open").is_none());
    }

    #[test]
    fn parse_native_tool_call_bad_name_is_malformed() {
        assert!(matches!(
            parse_tool_call("<|tool_call>call:Not A Name{}<tool_call|>"),
            Some(Err(_))
        ));
    }

    #[test]
    fn parse_native_tool_call_bad_args_is_malformed() {
        assert!(matches!(
            parse_tool_call("<|tool_call>call:t{not json at all}<tool_call|>"),
            Some(Err(_))
        ));
    }

    #[test]
    fn quote_bare_keys_leaves_valid_json_alone() {
        for ok in [
            r#"{"query":"a,b: c","mode":"hybrid"}"#,
            r#"{"blocks":[{"type":"paragraph","text":"x: y"}]}"#,
            "{}",
        ] {
            assert_eq!(quote_bare_keys(ok), ok, "input: {ok}");
        }
    }

    #[test]
    fn quote_bare_keys_quotes_only_key_positions() {
        assert_eq!(
            quote_bare_keys(r#"{mode:"keyword", query:"a, b: c"}"#),
            r#"{"mode":"keyword", "query":"a, b: c"}"#
        );
        // Bare VALUE (not followed by `:`) stays bare — serde then rejects it,
        // which routes to the repair path instead of silently guessing.
        assert_eq!(quote_bare_keys(r#"{a:b}"#), r#"{"a":b}"#);
    }

    #[test]
    fn parse_accepts_tool_key_aliases() {
        for key in ["tool", "tool_name", "name"] {
            let text = format!("```tool\n{{\"{key}\": \"t\", \"args\": {{}}}}\n```");
            match parse_tool_call(&text) {
                Some(Ok((tool, _))) => assert_eq!(tool, "t", "key {key}"),
                other => panic!("key {key}: expected Ok, got {other:?}"),
            }
        }
    }

    #[cfg(feature = "litert")]
    fn msg(role: &str, content: &str) -> db::ChatMessage {
        db::ChatMessage {
            id: 0,
            session_id: 1,
            role: role.into(),
            content: content.into(),
            created_at: 0,
        }
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_empty_when_no_history() {
        assert_eq!(compact_transcript(&[], 1000, ""), "");
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_keeps_newest_and_drops_oldest_on_budget() {
        let rows = vec![
            msg("user", "oldest question"),
            msg("assistant", "oldest answer"),
            msg("user", "newest question"),
        ];
        // Budget fits only the last two lines: the oldest pair must drop and
        // the omission must be flagged.
        let out = compact_transcript(&rows, 40, "");
        assert!(out.starts_with("(older turns omitted)"));
        assert!(out.contains("USER: newest question"));
        assert!(!out.contains("oldest question"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_caps_individual_messages() {
        // The single row is the NEWEST message: capped at the larger
        // last-message cap (still truncated — the '…' marker must appear).
        let rows = vec![msg("user", &"x".repeat(10_000))];
        let out = compact_transcript(&rows, TRANSCRIPT_BUDGET_CHARS, "");
        assert!(out.chars().count() <= TRANSCRIPT_LAST_MSG_CHARS + "USER: ".len() + 2);
        assert!(out.contains('…'));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_newest_message_gets_larger_cap() {
        // A 3000-char newest answer fits whole under the last-message cap;
        // an equally long OLDER message would be cut to 2000.
        let newest = "y".repeat(3000);
        let rows = vec![
            msg("assistant", &"z".repeat(3000)),
            msg("assistant", &newest),
        ];
        let out = compact_transcript(&rows, TRANSCRIPT_BUDGET_CHARS, "");
        assert!(out.contains(&newest)); // whole, no '…' inside it
        assert!(out.matches('…').count() == 1); // only the older row truncated
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_newest_always_included_even_over_budget() {
        // Newest alone exceeds the whole budget — still included (partially),
        // never dropped to an empty transcript.
        let rows = vec![msg("user", "old"), msg("assistant", &"a".repeat(9000))];
        let out = compact_transcript(&rows, TRANSCRIPT_BUDGET_CHARS, "");
        assert!(out.contains("ASSISTANT: aaaa"));
        assert!(!out.contains("USER: old"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_appends_evidence_digest_within_budget() {
        let digest = "[Stored tool results — mem1 office_read_document 12000 chars]";
        let rows = vec![msg("user", "hello"), msg("assistant", "hi there")];
        let out = compact_transcript(&rows, TRANSCRIPT_BUDGET_CHARS, digest);
        assert!(out.ends_with(digest));
        assert!(out.contains("\n\n[Stored"));

        // The digest's room is reserved BEFORE messages claim budget: the
        // whole output (digest included) stays within the cap while the
        // newest message still survives.
        let long_newest = "a".repeat(6000);
        let rows2 = vec![msg("assistant", &long_newest)];
        let out2 = compact_transcript(&rows2, TRANSCRIPT_BUDGET_CHARS, digest);
        assert!(out2.ends_with(digest));
        assert!(out2.contains("ASSISTANT: aaa"));
        assert!(out2.chars().count() <= TRANSCRIPT_BUDGET_CHARS);

        // Empty digest renders nothing extra.
        assert_eq!(
            compact_transcript(&rows, TRANSCRIPT_BUDGET_CHARS, ""),
            "USER: hello\nASSISTANT: hi there"
        );
    }

    #[cfg(feature = "litert")]
    #[test]
    fn opener_embeds_transcript_only_when_present() {
        let with = build_prompt("p", None, "USER: hi", "hello?");
        assert!(with.contains("<prior_conversation>"));
        assert!(with.contains("USER: hi"));
        let without = build_prompt("p", None, "", "hello?");
        assert!(!without.contains("<prior_conversation>"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn toolless_opener_has_no_fence_protocol() {
        let out = build_prompt("persona text", None, "", "hi");
        assert!(out.contains("persona text"));
        assert!(out.contains("<user_request>"));
        assert!(!out.contains("```tool"));
        assert!(!out.contains("call:<name>"));
        assert!(!out.contains("Available tools"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn overflow_detection_matches_both_engine_errors() {
        assert!(is_prefill_overflow(
            "FAILED_PRECONDITION: Prefill input length exceeds available state entries (remaining capacity: 1283)."
        ));
        assert!(is_prefill_overflow(
            "Input token ids are too long. Exceeding the maximum number of tokens allowed: 9000 >= 8192"
        ));
        assert!(!is_prefill_overflow("some unrelated engine error"));
    }

    // -- compact_args / toolful opener ----------------------------------------

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn draft_blocks_parses_clean_json() {
        let raw = r#"{"blocks":[{"type":"title","text":"Report"},{"type":"heading","text":"Q3","level":2},{"type":"paragraph","text":"Revenue grew."},{"type":"bullets","items":["a","b"]},{"type":"table","rows":[["x","y"]]},{"type":"paragraph","text":"End."}]}"#;
        let blocks = extract_draft_blocks(raw).expect("parse");
        assert_eq!(blocks.len(), 6);
        assert!(
            matches!(&blocks[0], crate::logic::office::ooxml::DocBlock::Title { text } if text == "Report")
        );
        assert!(matches!(
            &blocks[1],
            crate::logic::office::ooxml::DocBlock::Heading { level: Some(2), .. }
        ));
    }

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn draft_blocks_strips_fences_and_prose() {
        let raw = "Here is the document:\n```json\n{\"blocks\":[{\"type\":\"paragraph\",\"text\":\"Hi\"}]}\n```\nDone.";
        let blocks = extract_draft_blocks(raw).expect("parse");
        assert_eq!(blocks.len(), 1);
    }

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn draft_blocks_accepts_bare_array() {
        let raw = "[{\"type\":\"paragraph\",\"text\":\"Hi\"}]";
        assert_eq!(extract_draft_blocks(raw).expect("parse").len(), 1);
    }

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn draft_blocks_rejects_garbage() {
        assert!(extract_draft_blocks("no json here").is_err());
        assert!(extract_draft_blocks("{\"blocks\": \"not an array\"}").is_err());
        assert!(extract_draft_blocks("{\"blocks\":[{\"type\":\"hologram\"}]}").is_err());
    }

    // Provider quirk (zai glm, observed 2026-08-23): a stray `}` right after
    // the first bullets block — `…items":[…]}},{"type":"heading"` — closes the
    // root object early. The brace-repair pass must recover every block.
    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn draft_blocks_repairs_stray_brace_after_nested_block() {
        let raw = "{\"blocks\":[{\"type\":\"title\",\"text\":\"Hybrid LLM Update\"},\
{\"type\":\"bullets\",\"items\":[\"deep_write subagent\",\"draft_document subagent\"]}\
},{\"type\":\"heading\",\"text\":\"Results\",\"level\":1},\
{\"type\":\"paragraph\",\"text\":\"Closing.\"}]}";
        let blocks = extract_draft_blocks(raw).expect("repair parses");
        assert_eq!(blocks.len(), 4);
    }

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn draft_blocks_repairs_stray_brace_prose_wrapped() {
        let raw = "Here you go:\n{\"blocks\":[{\"type\":\"bullets\",\"items\":[\"a\",\"b\"]}},{\"type\":\"paragraph\",\"text\":\"tail\"}]}\nEnjoy.";
        let blocks = extract_draft_blocks(raw).expect("repair parses");
        assert_eq!(blocks.len(), 2);
    }

    #[cfg(feature = "litert")]
    mod echo {
        use kawai_tools::AgentTool;
        use serde::Deserialize;
        use serde_json::{json, Value};

        pub struct EchoTool;

        #[derive(Deserialize)]
        pub struct EchoArgs {
            pub message: String,
        }

        impl AgentTool for EchoTool {
            const NAME: &'static str = "echo_tool";
            type Args = EchoArgs;
            type Output = String;
            type Error = std::convert::Infallible;

            fn description(&self) -> String {
                "Echo a message back.".into()
            }

            fn parameters(&self) -> Value {
                json!({
                    "type": "object",
                    "properties": {
                        "message": { "type": "string", "description": "The text to echo." },
                        "loud": { "type": "boolean" }
                    },
                    "required": ["message"]
                })
            }

            async fn call(&self, args: Self::Args) -> Result<String, Self::Error> {
                Ok(args.message)
            }
        }
    }

    #[cfg(feature = "litert")]
    #[test]
    fn compact_args_lists_names_types_and_requiredness() {
        let out = compact_args(&serde_json::json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "The text to echo." },
                "loud": { "type": "boolean" }
            },
            "required": ["message"]
        }));
        assert_eq!(out["message"], "string, required — The text to echo.");
        assert_eq!(out["loud"], "boolean, optional");
    }

    #[cfg(feature = "litert")]
    #[test]
    fn compact_args_handles_empty_schema() {
        assert_eq!(compact_args(&serde_json::json!({})), serde_json::json!({}));
        assert_eq!(
            compact_args(&serde_json::json!({"type": "object", "properties": {}})),
            serde_json::json!({})
        );
    }

    #[cfg(feature = "litert")]
    #[test]
    fn toolful_opener_names_args_and_shows_example() {
        let mut set = ToolSet::default();
        set.add_tool(echo::EchoTool);
        let out = build_prompt("persona text", Some(&set), "", "hi");
        // Arg names visible — the model can now construct valid `args`.
        assert!(out.contains("echo_tool"));
        assert!(out.contains("\"message\""));
        assert!(out.contains("required"));
        // Few-shot example of the taught call: protocol + response: feedback.
        assert!(out.contains("call:office_create_document{"));
        assert!(out.contains("response:"));
    }

    /// The subagent-only toolset (chat agent, remote on) must render the
    /// call protocol + deep_write manifest — a persona rule without a
    /// manifest teaches a tool the model cannot call.
    #[cfg(feature = "litert")]
    #[test]
    fn subagent_only_opener_renders_deep_write_manifest() {
        let mut set = ToolSet::default();
        set.add_tool(DeepWrite);
        let out = build_prompt("persona text", Some(&set), "", "hi");
        assert!(out.contains("deep_write"));
        assert!(out.contains("\"task\""));
        assert!(out.contains("\"materials\""));
        assert!(out.contains("call:"));
        // Materials stay a one-line pointer — the loop attaches tool results.
        assert!(out.contains("attached automatically"));
    }

    /// The data_import confirmation gate: word-token matching so Indonesian
    /// substrings ("yang", "kayak") never read as agreement.
    #[cfg(all(feature = "litert", feature = "analytics"))]
    #[test]
    fn affirmative_messages_are_token_matched() {
        assert!(is_affirmative("Ya, lanjutkan import tabel customers dari keuangan."));
        assert!(is_affirmative("oke gas"));
        assert!(is_affirmative("Yes, proceed please"));
        assert!(!is_affirmative("yang mana tabelnya?"));
        assert!(!is_affirmative("kayaknya nanti dulu deh"));
        assert!(!is_affirmative("tampilkan dulu skemanya"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn opener_teaches_call_line_protocol() {
        let mut set = ToolSet::default();
        set.add_tool(echo::EchoTool);
        let out = build_prompt("persona", Some(&set), "", "hi");
        // The taught call format is the Gemma-native body with plain quotes…
        assert!(out.contains("call:<name>{\"arg\": \"value\", ...}"));
        // …results come back in the response: shape…
        assert!(out.contains("response:<name>{...}"));
        // …and the worked example uses a real call: line, not a fence.
        assert!(out.contains("call:office_create_document{"));
        assert!(!out.contains("```tool"));
    }
}
