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
        description: "A helpful, concise personal assistant running fully on-device.".into(),
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
    "You are kawai, a helpful, concise personal assistant running fully on-device.";

#[cfg(feature = "office")]
const OFFICE_PERSONA: &str = "You are kawai's office agent. You read, create, edit, merge and inspect documents (docx, xlsx, pptx, pdf) through tools.\n\
Rules:\n\
- Call at most ONE tool per reply, as a single ```tool block, then stop and wait for the TOOL_RESULT message.\n\
- When the user asks ANYTHING about their uploaded documents (numbers, names, dates, invoice codes, table contents), call knowledge_search FIRST — it finds the relevant passages for you.\n\
- Tools address stored files by their file id, never by path. If the user refers to a document and you don't know its id, call office_list_files first.\n\
- Never invent arguments: if a required input is missing, ask the user.\n\
- Prefer office_document_info / pdf_info before large reads when only structure matters.\n\
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
#[cfg(feature = "litert")]
fn toolset_for(agent_id: &str, user_id: &str, session_id: i64) -> Option<ToolSet> {
    match agent_id {
        #[cfg(feature = "office")]
        OFFICE_AGENT_ID => Some(crate::logic::office::toolset(user_id, session_id)),
        _ => {
            let _ = user_id;
            None
        }
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
    // model they blow the prefill budget. The descriptions already name every
    // argument and its format, so we emit a compact name+description manifest
    // only — roughly halving the prompt while keeping tool-calling intact.
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
                })
            })
            .collect();
        let tools = serde_json::to_string_pretty(&defs).unwrap_or_else(|_| "[]".into());
        format!(
            "<agent_context>\n{persona}\n\nAvailable tools (name + what each does):\n{tools}\n\n\
            To call a tool, reply with exactly ONE fenced block:\n\
            ```tool\n{{\"tool\": \"<name>\", \"args\": {{ ... }}}}\n```\n\
            In `args`, supply the parameters described for that tool. After a tool block, STOP — the result arrives as a TOOL_RESULT message in the next turn.\n\
            If no tool is needed, answer the user directly in plain text with NO fenced block.\n\
            </agent_context>\n\n"
        )
    } else {
        format!("<agent_context>\n{persona}\n</agent_context>\n\n")
    };
    format!("{protocol}{recap}<user_request>\n{message}\n</user_request>")
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
    match serde_json::from_str::<Value>(raw) {
        Ok(v) => {
            let tool = v.get("tool").and_then(|t| t.as_str()).map(str::to_string);
            match tool {
                Some(t) if !t.is_empty() => {
                    let args = v.get("args").cloned().unwrap_or(serde_json::json!({}));
                    Some(Ok((t, args)))
                }
                _ => Some(Err("tool block missing the \"tool\" field".into())),
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
        let Some(persona) = persona_for(&agent_id) else {
            yield AgentChatEvent::Error { message: format!("unknown agent: {agent_id}") };
            return;
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
        let toolset = toolset_for(&agent_id, &user_id, sid);
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

        let final_answer = loop {
            // (Re)build the opener when the conversation state does not carry
            // this session's manifest yet; otherwise keep the delta prompt
            // prepared by the previous iteration.
            if !crate::logic::local_llm::manifest_injected(&manifest_key) {
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
                yield AgentChatEvent::Error { message };
                return;
            }

            match parse_tool_call(&text) {
                // Final answer: fence-free reply.
                None => break text,

                // Malformed fence: one repair round, then fail the turn.
                Some(Err(detail)) => {
                    if repairs_used >= 1 {
                        yield AgentChatEvent::Error {
                            message: format!("model produced a malformed tool call twice ({detail})"),
                        };
                        return;
                    }
                    repairs_used += 1;
                    prompt = format!(
                        "TOOL_ERROR: malformed tool call ({detail}). Reply with exactly ONE fenced ```tool block containing valid JSON {{\"tool\": \"<name>\", \"args\": {{...}}}}, or answer the user directly WITHOUT any tool block."
                    );
                }

                // Dispatchable call.
                Some(Ok((tool, args))) => {
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
}
