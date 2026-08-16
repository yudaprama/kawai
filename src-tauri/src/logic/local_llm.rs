// ── On-device LLM (LiteRT-LM) ─────────────────────────────────────────────
//
// Pure: no tauri/axum types here. The engine/session pair lives in process
// globals; wrappers pass `user_id` (unused for now — reserved for per-user
// model prefs / quotas). The C inference calls are blocking and stream tokens
// through a callback, so they run on the blocking pool and are bridged onto
// an async stream via an unbounded channel. Cancellation: dropping the
// consumer stops forwarding tokens; the blocking task always finishes and
// restores the session, so the engine never deadlocks on a cancelled stream.

use async_stream::stream;
use cognee_litert_lm::{
    Backend, Conversation, ConversationConfig, Engine, EngineSettings, OptionalArgs,
};
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LocalChatEvent {
    Started,
    Token { text: String },
    Finished,
    Error { message: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub model_path: String,
    pub backend: String,
}

fn engine_slot() -> &'static Mutex<Option<Engine>> {
    static SLOT: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn conversation_slot() -> &'static Mutex<Option<Conversation>> {
    static SLOT: OnceLock<Mutex<Option<Conversation>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn thinking_slot() -> &'static Mutex<bool> {
    static SLOT: OnceLock<Mutex<bool>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(false))
}

/// Load (or replace) the on-device model and start a fresh conversation.
/// Heavy C init runs on the blocking pool. The Conversation API is used
/// (not bare Session): it owns chat history and prompt templating inside
/// the engine, and its streaming path is the one verified on macOS.
pub async fn load_model(
    _user_id: &str,
    model_path: &str,
    gpu: bool,
    speculative_decoding: bool,
    max_num_images: i32,
) -> Result<LocalModelInfo, String> {
    let model_path = model_path.to_string();
    tokio::task::spawn_blocking(move || {
        // A loaded engine with a missing conversation means a generation
        // is in flight (local_chat holds it). Replacing the engine now
        // would drop the C engine underneath the running generation and
        // make the end-of-generation restore point at freed memory.
        // Sequential locks — never nested (lock order: engine first).
        let engine_loaded = engine_slot().lock().unwrap().is_some();
        if engine_loaded && conversation_slot().lock().unwrap().is_none() {
            return Err("a generation is already running".into());
        }
        let backend = if gpu { Backend::Gpu } else { Backend::Cpu };
        let mut settings = EngineSettings::new(&model_path, backend, None, None)
            .map_err(|e| e.to_string())?;
        if speculative_decoding {
            settings.enable_speculative_decoding(true);
        }
        if max_num_images > 0 {
            settings.set_max_num_images(max_num_images);
        }
        let engine = settings.build().map_err(|e| e.to_string())?;
        let config = ConversationConfig::new().map_err(|e| e.to_string())?;
        let conversation =
            Conversation::new(&engine, Some(config)).map_err(|e| e.to_string())?;
        *engine_slot().lock().unwrap() = Some(engine);
        *conversation_slot().lock().unwrap() = Some(conversation);
        Ok(LocalModelInfo {
            model_path,
            backend: backend_name(gpu).to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backend_name(gpu: bool) -> &'static str {
    if gpu { "gpu" } else { "cpu" }
}

/// Reset the conversation history, creating a fresh conversation from the
/// already-loaded engine. The model stays loaded.
///
/// Rejected while a generation is running: `local_chat` takes the
/// conversation out of its slot for the duration, and an unconditional
/// reset mid-generation would be overwritten by the restore at the end
/// of `local_chat` (silently resurrecting the old history).
///
/// Both guards are held across the check+write so the swap is atomic
/// against `local_chat`'s take. Lock order is engine → conversation
/// everywhere — never invert it.
pub async fn reset_conversation(_user_id: &str) -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let engine = engine_slot().lock().unwrap();
        if engine.is_none() {
            return Err("no model loaded".into());
        }
        let mut conversation = conversation_slot().lock().unwrap();
        if conversation.is_none() {
            return Err("a generation is already running".into());
        }
        let config = ConversationConfig::new().map_err(|e| e.to_string())?;
        let fresh =
            Conversation::new(engine.as_ref().unwrap(), Some(config)).map_err(|e| e.to_string())?;
        *conversation = Some(fresh);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Enable or disable thinking mode for subsequent chat messages.
pub fn set_thinking(_user_id: &str, enabled: bool) {
    *thinking_slot().lock().unwrap() = enabled;
}

/// Unload the model and conversation, freeing all resources.
///
/// Rejected while a generation is running: dropping the engine (or the
/// conversation it backs) mid-generation segfaults the C runtime, and the
/// restore at the end of `local_chat` would resurrect the unloaded state.
pub async fn unload_model(_user_id: &str) -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        {
            let engine = engine_slot().lock().unwrap();
            if engine.is_none() {
                return Err("no model loaded".into());
            }
            let mut conversation = conversation_slot().lock().unwrap();
            if conversation.is_none() {
                return Err("a generation is already running".into());
            }
            // Drop the conversation while both guards are held, so no
            // `local_chat` can start between the check and the teardown.
            *conversation = None;
        }
        *engine_slot().lock().unwrap() = None;
        *thinking_slot().lock().unwrap() = false;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extract the text from a streamed chunk. The Conversation stream path
/// emits one JSON envelope per chunk:
/// `{"role":"assistant","content":[{"type":"text","text":"..."}]}`.
/// Fall back to the raw chunk if it does not parse (defensive).
fn chunk_text(chunk: &str) -> String {
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        content: Vec<Part>,
    }
    #[derive(Deserialize)]
    struct Part {
        #[serde(default)]
        text: Option<String>,
    }
    serde_json::from_str::<Envelope>(chunk)
        .ok()
        .map(|e| {
            e.content
                .into_iter()
                .filter_map(|p| p.text)
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| chunk.to_string())
}

/// On-device chat. The conversation is taken out of its slot for the
/// duration of a generation (a concurrent call sees `None` and errors)
/// and restored by the blocking task itself — even if the consumer was
/// cancelled. History is preserved across calls (multi-turn).
/// NOTE: the C `send_message_stream` is fire-and-forget async; the
/// blocking task must not return before the final callback (or an error)
/// — dropping the engine mid-generation segfaults.
pub fn local_chat(
    _user_id: String,
    prompt: String,
    image_b64: Option<String>,
    audio_b64: Option<String>,
) -> impl Stream<Item = LocalChatEvent> {
    stream! {
        let conversation = conversation_slot().lock().unwrap().take();
        if conversation.is_none() {
            yield LocalChatEvent::Error {
                message: "no local model loaded (or a generation is already running)".into(),
            };
            return;
        }
        yield LocalChatEvent::Started;

        let message = {
            let mut content = Vec::new();
            if let Some(img) = &image_b64 {
                content.push(serde_json::json!({ "type": "image", "blob": img }));
            }
            if let Some(aud) = &audio_b64 {
                content.push(serde_json::json!({ "type": "audio", "blob": aud }));
            }
            content.push(serde_json::json!({ "type": "text", "text": prompt }));
            serde_json::json!({
                "role": "user",
                "content": content
            })
        }
        .to_string();

        let use_thinking = *thinking_slot().lock().unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel::<LocalChatEvent>();
        let handle = tokio::task::spawn_blocking(move || {
            let Some(conversation) = conversation else { unreachable!("checked above") };
            let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let done_tx = Mutex::new(done_tx);
            let callback = move |chunk: &str, is_final: bool, err: Option<&str>| {
                let event = if let Some(e) = err {
                    LocalChatEvent::Error { message: e.to_string() }
                } else {
                    let text = chunk_text(chunk);
                    if text.is_empty() && !is_final {
                        return;
                    }
                    LocalChatEvent::Token { text }
                };
                let _ = tx.send(event);
                if is_final {
                    let _ = done_tx.lock().unwrap().send(Ok(()));
                }
            };
            let result = if use_thinking {
                // No unwrap: a failure here must return Err (not panic) so
                // the restore below still runs and the slot isn't lost.
                OptionalArgs::new()
                    .and_then(|mut args| {
                        args.set_thinking(true)?;
                        Ok(args)
                    })
                    .and_then(|args| {
                        conversation.send_message_stream_with_args(&message, Some(&args), callback)
                    })
            } else {
                conversation.send_message_stream(&message, callback)
            };
            let outcome = match result {
                Ok(()) => {
                    // Block until the final callback: the generation runs
                    // on an engine thread and outlives this call.
                    match done_rx.recv_timeout(Duration::from_secs(600)) {
                        Ok(res) => res,
                        Err(_) => Err("timed out waiting for generation".into()),
                    }
                }
                Err(e) => Err(e.to_string()),
            };
            // Restore unconditionally: reset/unload/reload all reject
            // while the conversation is taken (generation in flight), so
            // nothing can have invalidated the slot meanwhile. The
            // session is consistent: either generation finished or errored.
            *conversation_slot().lock().unwrap() = Some(conversation);
            outcome
        });

        let mut errored = false;
        while let Some(event) = rx.recv().await {
            if matches!(event, LocalChatEvent::Error { .. }) {
                errored = true;
            }
            yield event;
        }
        if errored {
            return;
        }
        match handle.await {
            Ok(Ok(())) => yield LocalChatEvent::Finished,
            Ok(Err(e)) => yield LocalChatEvent::Error { message: e },
            Err(e) => yield LocalChatEvent::Error { message: e.to_string() },
        }
    }
}
