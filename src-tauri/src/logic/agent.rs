//! Prompt-based tool-calling agent loop (the Roadmap-5 slice).
//!
//! The LiteRT-LM Conversation API has no native function calling, so tools are
//! declared in the prompt and the model replies with a fenced ```tool block.
//! The loop: send user message (+ manifest on the first turn) → stream tokens
//! → on completion, parse the fence → dispatch via a rig `ToolSet` → feed the
//! result back as the next user message → repeat until a fence-free reply
//! (final answer), a malformed-fence failure after one repair, or the tool
//! budget runs out.
//!
//! Each generation goes through `local_llm::local_chat`, which owns the
//! engine's conversation slot (take/restore per generation — sequential calls
//! are safe; reset/unload/load reject while a generation is in flight).
//! Multi-turn history lives inside the engine conversation; the manifest is
//! only re-sent implicitly via turn 1 (the model sees it in history).
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
/// How many chars of a tool result are echoed into the UI event (the model
/// always sees the full output).
const TOOL_RESULT_UI_CHARS: usize = 500;

pub const CHAT_AGENT_ID: &str = crate::logic::BUILTIN_CHAT_AGENT_ID;
pub const OFFICE_AGENT_ID: &str = "builtin.office";

/// Known agent ids, in UI order.
pub fn agent_ids() -> Vec<&'static str> {
    #[cfg(feature = "office")]
    {
        vec![CHAT_AGENT_ID, OFFICE_AGENT_ID]
    }
    #[cfg(not(feature = "office"))]
    {
        vec![CHAT_AGENT_ID]
    }
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

/// Render the per-turn prompt: persona + fence protocol + tool manifest +
/// the user request. Sent as ONE user message (the Conversation API only
/// takes user turns; its templating owns the system role).
#[cfg(feature = "litert")]
fn build_prompt(persona: &str, toolset: Option<&ToolSet>, message: &str) -> String {
    let tools = match toolset {
        Some(set) if !set.get_tool_definitions().is_empty() => {
            let defs: Vec<Value> = set
                .get_tool_definitions()
                .iter()
                .map(|d| {
                    serde_json::json!({
                        "name": d.name,
                        "description": d.description,
                        "parameters": d.parameters,
                    })
                })
                .collect();
            serde_json::to_string_pretty(&defs).unwrap_or_else(|_| "[]".into())
        }
        _ => "none".to_string(),
    };
    format!(
        "<agent_context>\n{persona}\n\nAvailable tools (JSON schemas):\n{tools}\n\n\
To call a tool, reply with exactly ONE fenced block:\n\
```tool\n{{\"tool\": \"<name>\", \"args\": {{ ... }}}}\n```\n\
After a tool block, STOP — the result arrives as a TOOL_RESULT message in the next turn.\n\
If no tool is needed (or tools are \"none\"), answer the user directly in plain text with NO fenced block.\n\
</agent_context>\n\n<user_request>\n{message}\n</user_request>"
    )
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
        if let Err(e) = db::append_chat_message(&user_id, sid, "user", &message).await {
            yield AgentChatEvent::Error { message: e.to_string() };
            return;
        }

        let mut prompt = build_prompt(persona, toolset.as_ref(), &message);
        let mut calls_used = 0usize;
        let mut repairs_used = 0usize;
        let mut budget_notified = false;

        let final_answer = loop {
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
                        LocalChatEvent::ToolCall { id, tool, args } => {
                            yield AgentChatEvent::ToolCall { tool, args };
                        }
                        LocalChatEvent::ToolResult { id, tool, ok, summary } => {
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
                    prompt = format!(
                        "TOOL_RESULT {tool}:\n{body}\n\nContinue. If you need another tool, reply with a single ```tool block; otherwise answer the user directly."
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
}
