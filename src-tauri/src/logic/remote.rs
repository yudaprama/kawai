//! Cloud subagent client — the remote tier of the hybrid LLM design
//! (`PLAN-hybrid-llm-subagents.md`).
//!
//! Pure module (no transport types). One stateless streaming completion per
//! call: a fixed system persona + a task brief + locally-curated materials.
//! Chat history is NEVER sent — continuity is the local orchestrator's job;
//! the cloud only ever sees the delegation package the model curated.
//!
//! All providers ride the OpenAI-compatible Chat Completions API via rig's
//! `openai::CompletionsClient` (the same client the in-tree `zai` provider
//! wraps), so one code path covers z.ai / OpenAI / OpenRouter / any
//! compatible endpoint.
//!
//! Configuration (`.env`):
//! ```text
//! KAWAI_REMOTE_LLM_PROVIDER           zai (default) | openai | openrouter | custom | off
//! KAWAI_REMOTE_LLM_API_KEY            bearer token; zai falls back to the kawai-vault pool
//! KAWAI_REMOTE_LLM_MODEL              model id (required for non-zai providers)
//! KAWAI_REMOTE_LLM_BASE_URL           endpoint override
//! KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS  default 8192
//! ```
//!
//! `from_env() -> None` (unset, `off`, or no resolvable key) disables
//! subagents entirely — every agent then behaves exactly as pure-local.

use futures_core::Stream;
use futures_util::StreamExt;
use rig::client::CompletionClient;
use rig::completion::CompletionModel;
use rig::providers::openai;

/// Default cap on the `materials` string sent to the cloud (chars ≈ /4
/// tokens). Enforced server-side so no caller can blow the request budget.
const DEFAULT_MATERIALS_CHARS: usize = 24_000;
/// Default output-token cap for one subagent call.
const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 8192;
/// Default endpoint for the `zai` provider — the GLM coding-plan gateway the
/// kawai-vault key pool is provisioned for.
const ZAI_BASE_URL: &str = "https://api.z.ai/api/coding/paas/v4";
/// Default model for the `zai` provider.
const ZAI_MODEL: &str = "glm-5.3";

/// Per-call token usage captured from the stream's terminal record
/// (telemetry for `turn_log`). Zeros mean "provider reported none".
#[derive(Clone, Copy, Debug, Default)]
pub struct RemoteUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Events from one remote streaming call. `Done` terminates a successful
/// stream and carries the provider-reported usage.
pub enum RemoteEvent {
    Token { text: String },
    Done { usage: RemoteUsage },
}

/// A configured remote completion model.
pub struct RemoteLlm {
    model: openai::CompletionModel,
    /// Telemetry label (provider name, not a secret).
    provider: String,
    max_output_tokens: u64,
    materials_cap: usize,
}

impl RemoteLlm {
    /// Build from env vars (see module docs). `None` ⇒ the remote tier is
    /// disabled; callers degrade to pure-local behavior.
    pub fn from_env() -> Option<Self> {
        let provider = std::env::var("KAWAI_REMOTE_LLM_PROVIDER")
            .ok()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "zai".to_string());
        if matches!(provider.as_str(), "off" | "none" | "disabled") {
            return None;
        }

        let key_env = std::env::var("KAWAI_REMOTE_LLM_API_KEY")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let model_env = std::env::var("KAWAI_REMOTE_LLM_MODEL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let base_env = std::env::var("KAWAI_REMOTE_LLM_BASE_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        let (base_url, default_model, fallback_key) = match provider.as_str() {
            "zai" => (ZAI_BASE_URL.to_string(), Some(ZAI_MODEL.to_string()), {
                // Vault pool (kawai-vault constants crate) — same source the
                // in-tree zai provider uses.
                let k = kawai_constants::llm::get_zai();
                if k.is_empty() { None } else { Some(k) }
            }),
            "openai" => ("https://api.openai.com/v1".to_string(), None, None),
            "openrouter" => ("https://openrouter.ai/api/v1".to_string(), None, None),
            "custom" => (String::new(), None, None),
            other => {
                eprintln!("[remote] unknown KAWAI_REMOTE_LLM_PROVIDER {other:?} — remote tier disabled");
                return None;
            }
        };
        let base_url = base_env.unwrap_or(base_url);
        let model_id = match model_env.or(default_model) {
            Some(m) => m,
            None => {
                eprintln!("[remote] KAWAI_REMOTE_LLM_MODEL is required for provider {provider:?} — remote tier disabled");
                return None;
            }
        };
        if base_url.is_empty() {
            eprintln!("[remote] KAWAI_REMOTE_LLM_BASE_URL is required for provider \"custom\" — remote tier disabled");
            return None;
        }
        let Some(api_key) = key_env.or(fallback_key) else {
            eprintln!("[remote] no API key for provider {provider:?} (set KAWAI_REMOTE_LLM_API_KEY) — remote tier disabled");
            return None;
        };

        let client = openai::CompletionsClient::builder()
            .base_url(&base_url)
            .api_key(rig::client::BearerAuth::from(api_key))
            .build();
        let client = match client {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[remote] client build failed: {e} — remote tier disabled");
                return None;
            }
        };
        let max_output_tokens = std::env::var("KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
        Some(Self {
            model: client.completion_model(&model_id),
            provider,
            max_output_tokens,
            materials_cap: DEFAULT_MATERIALS_CHARS,
        })
    }

    /// Telemetry label for `turn_log`.
    pub fn provider_label(&self) -> &str {
        &self.provider
    }

    /// Server-side materials cap (exposed for the manifest description).
    pub fn materials_cap(&self) -> usize {
        self.materials_cap
    }

    /// One stateless streaming completion. `system` is the subagent persona;
    /// `task` is the model-written brief; `materials` is the curated context
    /// package (truncated to the cap here — never trust the caller).
    /// Returns a boxed `Send` stream (the consumer lives inside Tauri
    /// command futures, which must be `Send`).
    pub async fn stream(
        &self,
        system: &str,
        task: &str,
        materials: &str,
    ) -> Result<
        std::pin::Pin<
            Box<dyn Stream<Item = Result<RemoteEvent, String>> + Send>,
        >,
        String,
    > {
        let materials = truncate_chars(materials, self.materials_cap);
        let prompt = if materials.trim().is_empty() {
            format!("Task:\n{task}")
        } else {
            format!(
                "Task:\n{task}\n\n\
                 Materials (curated by the on-device orchestrator — the ONLY context you have; \
                 no chat history is included):\n<materials>\n{materials}\n</materials>"
            )
        };
        let request = self
            .model
            .completion_request(prompt)
            .preamble(system.to_string())
            .temperature(0.4)
            .max_tokens(self.max_output_tokens)
            .build();
        let mut response = self
            .model
            .stream(request)
            .await
            .map_err(|e| e.to_string())?;

        let stream = async_stream::stream! {
            while let Some(item) = response.next().await {
                match item {
                    Ok(rig::streaming::StreamedAssistantContent::Text(t)) => {
                        if !t.text.is_empty() {
                            yield Ok(RemoteEvent::Token { text: t.text });
                        }
                    }
                    // deep_write sends no tools, so any other content kind is
                    // ignored (reasoning deltas are provider-internal).
                    Ok(_) => {}
                    Err(e) => {
                        yield Err(e.to_string());
                        return;
                    }
                }
            }
            // Terminal record (usage) is populated by the time the stream ends.
            let usage = response
                .response
                .as_ref()
                .map(|f| RemoteUsage {
                    input_tokens: f.usage.input_tokens,
                    output_tokens: f.usage.output_tokens,
                })
                .unwrap_or_default();
            yield Ok(RemoteEvent::Done { usage });
        };
        Ok(Box::pin(stream))
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}\n[materials truncated at {max} chars by the server]")
    }
}
