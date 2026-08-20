//! Prompt-based tool-calling agent loop (the Roadmap-5 slice).
//!
//! The LiteRT-LM Conversation API has no native function calling, so tools are
//! declared in the prompt and the model replies with a fenced ```tool block.
//! The loop: send user message → stream tokens → on completion, parse the
//! fence → dispatch via a rig `ToolSet` → feed the result back as the next
//! user message → repeat until a fence-free reply (final answer), a
//! malformed-fence failure after one repair, or the tool budget runs out.
//!
//! # Context economy (the conversation is stateful!)
//!
//! Every token prefilled into the Conversation API occupies a K/V state entry
//! permanently — repeating content is a leak. The loop therefore runs an
//! opener/delta protocol keyed by a manifest key (`agent:session`), tracked in
//! `local_llm` alongside the conversation epoch:
//!
//! - **Opener** (only when the manifest is NOT in the current conversation
//!   state): persona + tool manifest + fence protocol + a compacted transcript
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
//! short ```tool fences), compresses and curates `materials`; cloud writes
//! the long-form answer. A `deep_write` result is FINAL (`final:true`
//! passthrough): its tokens stream straight to the user, are persisted as
//! the assistant message, and local never rewrites them. Chat history is
//! never sent — only the task + materials package. On cloud failure the
//! turn degrades to local (fed back as a normal TOOL_RESULT error), and a
//! twice-malformed fence on a heavy turn escalates to `deep_write` instead
//! of failing.

#[cfg(feature = "litert")]
use crate::logic::db;
#[cfg(feature = "litert")]
use futures_core::Stream;
#[cfg(feature = "litert")]
use futures_util::StreamExt;
#[cfg(feature = "litert")]
use rig::tool::ToolContext;
use rig::tool::ToolSet;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Max tool dispatches per user turn before forcing a final answer.
const MAX_TOOL_CALLS: usize = 5;
/// How many chars of a tool result are echoed into the UI event.
const TOOL_RESULT_UI_CHARS: usize = 500;
/// Cap on a tool result fed BACK into the conversation (chars). Tool outputs
/// reach 60k chars (office_read_document) — uncapped, a single call
/// permanently burns the K/V budget. When capped, the model is told to
/// narrow its query.
const TOOL_RESULT_MODEL_CHARS: usize = 4000;
/// Per-message cap inside a replayed transcript.
const TRANSCRIPT_MSG_CHARS: usize = 2000;
/// Char budget for the replayed transcript when opening a conversation epoch
/// (first turn, session switch, restart).
const TRANSCRIPT_BUDGET_CHARS: usize = 6000;
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
/// Overall wall-clock deadline for one cloud subagent call.
#[cfg(feature = "litert")]
const REMOTE_TIMEOUT_SECS: u64 = 600;
/// Cap on the draft JSON the cloud may return (chars) — guards absurd output.
#[cfg(feature = "litert")]
const DRAFT_JSON_MAX_CHARS: usize = 120_000;

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

/// Extra persona rule for agents carrying the deep_write subagent: tells the
/// local model WHEN to delegate (the core quality lever of the hybrid tier).
#[cfg(feature = "litert")]
const DEEP_WRITE_RULE: &str = "- Long, analytical, comparative or creative answers (reports, comparisons, drafts, syntheses across sources) MUST be delegated to the deep_write tool: task = the complete brief (audience, structure, focus); materials = the relevant excerpts you gathered from TOOL_RESULTs. The deep_write result is streamed to the user as your final answer. Short factual replies you write yourself — do NOT delegate those.";

/// Extra persona rule for the office agent: document creation with real
/// content goes through the draft_document subagent, which composes the
/// document in the cloud and writes the file itself. `office_create_document`
/// is only for exact-content files (the user supplied the literal text).
#[cfg(all(feature = "litert", feature = "office"))]
const DRAFT_DOCUMENT_RULE: &str = "- Document-content rule (STRICT): when the document's content must be WRITTEN or COMPOSED (the user describes what it should contain or say — reports, proposals, summaries, updates, decks from their files), you MUST call draft_document. Do NOT compose document content yourself and do NOT pass your own made-up content to office_create_document — that tool is ONLY for files whose exact text the user already gave you (transcribe verbatim, e.g. 'a docx containing exactly these lines'). If you are writing ANY of the document's body yourself, that is a draft_document turn.";

pub const CHAT_AGENT_ID: &str = crate::logic::BUILTIN_CHAT_AGENT_ID;
pub const OFFICE_AGENT_ID: &str = "builtin.office";

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
    /// true → the agent runs the tool loop (`agent_chat`); false → plain
    /// `local_chat` (no persona/tool injection). Drives the frontend's
    /// transport choice, so the chat agent id is never duplicated client-side.
    pub tools: bool,
}

/// The agent catalog in UI order. Static data — no user scope, no auth.
pub fn list_agents() -> Vec<AgentInfo> {
    let mut out = vec![AgentInfo {
        id: CHAT_AGENT_ID.to_string(),
        name: "Chat".into(),
        description: "A helpful, concise personal assistant.".into(),
        tools: false,
    }];
    #[cfg(feature = "office")]
    out.push(AgentInfo {
        id: OFFICE_AGENT_ID.to_string(),
        name: "Office".into(),
        description: "Documents, PDFs, spreadsheets — created and edited locally.".into(),
        tools: true,
    });
    out
}

const CHAT_PERSONA: &str =
    "You are kawai, a helpful, concise personal assistant.";

#[cfg(feature = "office")]
const OFFICE_PERSONA: &str = "You are kawai's office agent. You read, create, edit, merge and inspect documents (docx, xlsx, pptx, pdf) through tools.\n\
Rules:\n\
- Call at most ONE tool per reply, as a single ```tool block, then stop and wait for the TOOL_RESULT message.\n\
- When the user asks ANYTHING about their uploaded documents (numbers, names, dates, invoice codes, table contents), call knowledge_search FIRST — it finds the relevant passages for you.\n\
- Tools address stored files by their file id, never by path. If the user refers to a document and you don't know its id, call office_list_files first.\n\
- Never invent arguments: if a required input is missing, ask the user.\n\
- Prefer office_document_info / pdf_info before large reads when only structure matters.\n\
- NEVER claim you created, edited, or changed a document unless a TOOL_RESULT explicitly reported success. If you did not call a tool, say so.\n\
- If a TOOL_RESULT reports an error, fix your arguments and call the tool again (up to the budget) before telling the user it failed.\n\
- After each TOOL_RESULT, either call another tool or give the final answer.\n\
- Final answers: short, factual, no JSON dumps.";

#[cfg(feature = "litert")]
fn persona_for(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        CHAT_AGENT_ID => Some(CHAT_PERSONA),
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => Some(OFFICE_PERSONA),
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
) -> Option<ToolSet> {
    let mut set = match agent_id {
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => crate::logic::office::toolset(user_id, session_id),
        _ => {
            let _ = user_id;
            let _ = session_id;
            ToolSet::default()
        }
    };
    if remote.is_none() {
        // Pure-local: only agents with domain tools get a toolset (the
        // pre-hybrid behavior, byte-for-byte).
        return match agent_id {
            #[cfg(feature = "office")]
            OFFICE_AGENT_ID => Some(set),
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
impl rig::tool::PortableTool for DeepWrite {
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
                "materials": { "type": "string", "description": "Excerpts/facts the writer must use, gathered from TOOL_RESULTs. Omit for general-knowledge writing." }
            },
            "required": ["task"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        // Reached only if the loop's interception is bypassed (should not
        // happen); fail soft so the model learns the tool is unavailable.
        Ok("ERROR: deep_write is dispatched internally and is unavailable here. Answer directly.".into())
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
impl rig::tool::PortableTool for DraftDocument {
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
                "materials": { "type": "string", "description": "Excerpts/facts from TOOL_RESULTs the document must be grounded in. Omit for general-knowledge documents." }
            },
            "required": ["task", "filename"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        Ok("ERROR: draft_document is dispatched internally and is unavailable here. Use office_create_document or answer directly.".into())
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
    ToolResult {
        tool: String,
        ok: bool,
        summary: String,
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
            To call a tool, reply with exactly ONE fenced block:\n\
            ```tool\n{{\"tool\": \"<name>\", \"args\": {{ ... }}}}\n```\n\
            In `args`, supply exactly the parameters listed for that tool (omit optional ones). After a tool block, STOP — the result arrives as a TOOL_RESULT message in the next turn.\n\
            If no tool is needed, answer the user directly in plain text with NO fenced block.\n\n\
            Example of the format (illustration only — never repeat it verbatim, and ALWAYS emit the ```tool block yourself when a tool is needed):\n\
            User: create a docx named hello.docx containing \"hello world\"\n\
            ```tool\n{{\"tool\": \"office_create_document\", \"args\": {{\"filename\": \"hello.docx\", \"blocks\": [{{\"type\": \"paragraph\", \"text\": \"hello world\"}}]}}}}\n```\n\
            TOOL_RESULT office_create_document: {{\"success\": true, \"file\": {{\"id\": \"f9\", \"originalName\": \"hello.docx\"}}}}\n\
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
/// capped. Empty string when there is nothing (left) to replay.
#[cfg(feature = "litert")]
fn compact_transcript(rows: &[db::ChatMessage], budget: usize) -> String {
    if rows.is_empty() || budget == 0 {
        return String::new();
    }
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0usize;
    let mut dropped_older = false;
    for row in rows.iter().rev() {
        let role = if row.role == "user" { "USER" } else { "ASSISTANT" };
        let line = format!("{role}: {}", truncate_chars(row.content.trim(), TRANSCRIPT_MSG_CHARS));
        let add = line.chars().count() + 1;
        if used + add > budget {
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
/// - `None` → no ```tool fence (final answer)
/// - `Some(Ok((tool, args)))` → dispatchable call
/// - `Some(Err(detail))` → fence present but malformed (one repair allowed)
pub fn parse_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    let lower = text.to_lowercase();
    let start = lower.find("```tool")? + "```tool".len();
    let rest = &text[start..];
    // Skip anything to end-of-line after the opener (```tool json, etc).
    let body_start = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
    let body = &rest[body_start..];
    let end = match body.find("```") {
        Some(e) => e,
        None => return Some(Err("unterminated ```tool block".into())),
    };
    let raw = body[..end].trim();
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

/// Strip protocol markers the model may echo back into streamed tokens.
#[cfg(feature = "litert")]
fn strip_markers(t: &str) -> String {
    t.replace("<agent_context>", "")
        .replace("</agent_context>", "")
        .replace("<user_request>", "")
        .replace("</user_request>", "")
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
fn tool_result_body(result: &rig::tool::ToolResult) -> String {
    if let Some(text) = result.output().as_text() {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    if let Some(err) = result.error() {
        return format!("ERROR: {}", err.message());
    }
    "<non-text output>".to_string()
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
pub fn extract_draft_blocks(raw: &str) -> Result<Vec<crate::logic::office::ooxml::DocBlock>, String> {
    let unfenced = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    // Parse the whole payload first; only carve a substring when the model
    // wrapped the JSON in prose (which breaks whole-string parsing).
    let value: Value = match serde_json::from_str::<Value>(unfenced) {
        Ok(v) => v,
        Err(whole_err) => {
            let carved = match (unfenced.find('{'), unfenced.rfind('}')) {
                (Some(a), Some(b)) if b > a => Some(&unfenced[a..=b]),
                _ => None,
            };
            match carved
                .map(|c| serde_json::from_str::<Value>(c).ok())
                .flatten()
            {
                Some(v) => v,
                None => return Err(format!("not valid JSON: {whole_err}")),
            }
        }
    };
    let blocks_value = match &value {
        Value::Array(_) => value.clone(),
        Value::Object(_) => value.get("blocks").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };
    serde_json::from_value::<Vec<crate::logic::office::ooxml::DocBlock>>(blocks_value)
        .map_err(|e| format!("blocks failed schema validation: {e}"))
}

/// The agent chat loop. Requires `litert` (the on-device model is the only
/// v1 backend); wrappers gate the op accordingly.
#[cfg(feature = "litert")]
pub fn agent_chat(
    user_id: String,
    agent_id: String,
    session_id: Option<i64>,
    message: String,
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
        let toolset = toolset_for(&agent_id, &user_id, sid, remote.as_ref());
        eprintln!(
            "[agent_chat] toolset for agent={agent_id} remote.is_some()={} has_toolset={}",
            remote.is_some(),
            toolset.is_some()
        );
        yield AgentChatEvent::Started { session_id: sid };

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
        let mut budget_notified = false;
        // Hybrid-tier state: a pending subagent delegation (set by the
        // dispatch arm or the escalation path) runs at the top of the next
        // loop iteration — one code path for both entry points.
        let mut pending_subagent: Option<PendingSubagent> = None;
        let mut subagent_calls_used = 0usize;
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
                        "TOOL_RESULT {}:\nERROR: the cloud call for this turn was already used. \
                         Answer the user directly now with what you have (NO tool block).",
                        call.tool
                    );
                    continue;
                }
                subagent_calls_used += 1;
                let is_draft = call.tool == DRAFT_DOCUMENT_TOOL;
                if !is_draft && call.tool != DEEP_WRITE_TOOL {
                    prompt = format!(
                        "TOOL_RESULT {}:\nERROR: unknown cloud tool. Answer directly (NO tool block).",
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
                let mut answer = String::new();
                let mut usage: Option<crate::logic::remote::RemoteUsage> = None;
                // Label of the candidate that actually served the stream
                // (failover may skip the preferred primary).
                let mut cloud_provider: Option<String> = None;
                let mut failed: Option<String> = None;
                let mut stream: std::pin::Pin<
                    Box<dyn futures_core::Stream<Item = Result<crate::logic::remote::RemoteEvent, String>> + Send>,
                > = match remote
                    .as_ref()
                    .expect("pending_subagent implies remote")
                    .stream(system, &call.task, &call.materials)
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
                        Some(Ok(crate::logic::remote::RemoteEvent::Done { usage: u, provider: p })) => {
                            usage = Some(u);
                            cloud_provider = Some(p);
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
                            .stream(DRAFT_DOCUMENT_SYSTEM, &retry_task, &call.materials)
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
                                        Ok(crate::logic::remote::RemoteEvent::Done { usage: u, provider: p }) => {
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
                                        };
                                        // Receipt back to local — short enough to
                                        // be safe in K/V; local closes the turn.
                                        prompt = format!(
                                            "TOOL_RESULT {DRAFT_DOCUMENT_TOOL}:\n{receipt}\n\n\
                                             The document was created and saved. Tell the user \
                                             concisely (filename + what it contains). NO tool block."
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
                let answer = answer.trim().to_string();
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
                    };
                    prompt = format!(
                        "TOOL_RESULT {}:\nERROR: {err}\n\nThe cloud writer is unavailable. \
                         Answer the user directly with what you have (NO tool block).",
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
                };
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
                let transcript = compact_transcript(&prior_turns, budget);
                prompt = build_prompt(persona, toolset.as_ref(), &transcript, &message);
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
                        LocalChatEvent::ToolCall { id: _, tool, args } => {
                            yield AgentChatEvent::ToolCall { tool, args };
                        }
                        LocalChatEvent::ToolResult { id: _, tool, ok, summary } => {
                            yield AgentChatEvent::ToolResult { tool, ok, summary };
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
                // Final answer: fence-free reply.
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
                            let materials = compact_transcript(&prior_turns, TRANSCRIPT_BUDGET_CHARS);
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
                        "TOOL_ERROR: malformed tool call ({detail}). The fence MUST contain ONE valid JSON object, exactly this shape:\n\
                        ```tool\n{{\"tool\": \"<tool_name>\", \"args\": {{<argument objects>}}}}\n```\n\
                        Rules: the key is \"tool\" (a string), \"args\" is ONE object holding every argument as \"name\": value pairs (nested arrays/objects allowed as values). Do not put a colon between two argument names. Reply with the corrected ```tool block, or answer the user directly WITHOUT any tool block."
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
                        let materials = args
                            .get("materials")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_default();
                        let filename = args
                            .get("filename")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if task.trim().is_empty() {
                            yield AgentChatEvent::ToolResult {
                                tool: tool.clone(),
                                ok: false,
                                summary: format!("{tool} requires a non-empty 'task'"),
                            };
                            prompt = format!(
                                "TOOL_RESULT {tool}:\nERROR: 'task' must be a non-empty \
                                 string describing what to write. Retry with a complete brief, or \
                                 answer directly (NO tool block)."
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
                        prompt = "TOOL_BUDGET_EXHAUSTED — you have used all tool calls for this turn. Answer the user now with what you have (NO tool block).".into();
                        continue;
                    }
                    yield AgentChatEvent::ToolCall { tool: tool.clone(), args: args.clone() };
                    calls_used += 1;
                    eprintln!("[agent_chat] tool call {calls_used}/{MAX_TOOL_CALLS}: {tool} args={}", truncate_chars(&args.to_string(), 300));

                    let result = match toolset.as_ref() {
                        Some(set) => {
                            let mut ctx = ToolContext::default();
                            set.execute(&tool, args.to_string(), &mut ctx).await
                        }
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
                            };
                            prompt = format!("TOOL_RESULT {tool}:\n{body}\n\nAnswer the user directly now — no tools are available.");
                            continue
                        }
                    };

                    let ok = result.is_success();
                    let body = tool_result_body(&result);
                    eprintln!("[agent_chat] tool result {tool}: ok={ok} {}", truncate_chars(&body, 300));
                    yield AgentChatEvent::ToolResult {
                        tool: tool.clone(),
                        ok,
                        summary: truncate_chars(&body, TOOL_RESULT_UI_CHARS),
                    };
                    // Cap what re-enters the conversation: uncapped outputs
                    // (60k chars) permanently burn the K/V budget. Tell the
                    // model the output was cut so it can narrow the query.
                    let model_body =
                        if body.chars().count() > TOOL_RESULT_MODEL_CHARS {
                            format!(
                                "{}\n[output truncated — narrow the query or read specific pages]",
                                truncate_chars(&body, TOOL_RESULT_MODEL_CHARS)
                            )
                        } else {
                            body
                        };
                    prompt = format!(
                        "TOOL_RESULT {tool}:\n{model_body}\n\nContinue. If you need another tool, reply with a single ```tool block; otherwise answer the user directly."
                    );
                }
            }
        };

        let _ = db::append_chat_message(&user_id, sid, "assistant", final_answer.trim()).await;
        yield AgentChatEvent::Finished;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(compact_transcript(&[], 1000), "");
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
        let out = compact_transcript(&rows, 40);
        assert!(out.starts_with("(older turns omitted)"));
        assert!(out.contains("USER: newest question"));
        assert!(!out.contains("oldest question"));
    }

    #[cfg(feature = "litert")]
    #[test]
    fn transcript_caps_individual_messages() {
        let rows = vec![msg("user", &"x".repeat(10_000))];
        let out = compact_transcript(&rows, TRANSCRIPT_BUDGET_CHARS);
        assert!(out.chars().count() < TRANSCRIPT_BUDGET_CHARS);
        assert!(out.contains('…'));
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
        assert!(matches!(&blocks[0], crate::logic::office::ooxml::DocBlock::Title { text } if text == "Report"));
        assert!(matches!(&blocks[1], crate::logic::office::ooxml::DocBlock::Heading { level: Some(2), .. }));
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

    #[cfg(feature = "litert")]
    mod echo {
        use rig::tool::PortableTool;
        use serde::Deserialize;
        use serde_json::{json, Value};

        pub struct EchoTool;

        #[derive(Deserialize)]
        pub struct EchoArgs {
            pub message: String,
        }

        impl PortableTool for EchoTool {
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
        // Few-shot example of the fence format.
        assert!(out.contains("```tool"));
        assert!(out.contains("TOOL_RESULT"));
    }

    /// The subagent-only toolset (chat agent, remote on) must render the
    /// fence protocol + deep_write manifest — a persona rule without a
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
        assert!(out.contains("```tool"));
    }
}
