//! Cloud subagent client — the remote tier of the hybrid LLM design
//! (`PLAN-hybrid-llm-subagents.md`).
//!
//! Pure module (no transport types). One stateless streaming completion per
//! call: a fixed system persona + a task brief + locally-curated materials.
//! Chat history is NEVER sent — continuity is the local orchestrator's job;
//! the cloud only ever sees the delegation package the model curated.
//!
//! ## Provider pool + failover
//!
//! Every provider with a vault key forms the pool, tried in fixed priority
//! order (`zai` first — best quality; heterogeneous models are NOT peers, so
//! no shuffle). A candidate whose handshake fails with a retryable status
//! (429/5xx, or 401/404 = target withdrawn upstream) or a transport error is
//! marked unhealthy (cooldown from `Retry-After` when the provider sent one)
//! and the next candidate is tried. Cooled candidates stay last in line, so
//! the request never hard-fails just because every backend is cooling down.
//! The failover boundary is the first TEXT token handed to the consumer: a
//! candidate that handshakes cleanly but streams zero text (empty completion,
//! reasoning-only) has committed nothing and the next candidate is tried.
//! Once a token has been handed over, mid-stream errors propagate as-is
//! (retrying would duplicate output).
//!
//! Providers, base URLs, models, and API keys are all hardcoded.
//! API keys come from `kawai_constants::llm` (vault pool).
//!
//! Configuration (`.env`):
//! ```text
//! KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS  default 8192
//! KAWAI_REMOTE_LLM_MATERIALS_CHARS    optional absolute ceiling on every
//!                                     provider's materials budget (fuse)
//! ```
//!
//! No keys in the vault ⇒ `from_env() -> None` disables subagents entirely —
//! every agent then behaves exactly as pure-local.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use futures_core::Stream;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue};

/// Per-provider cap on the `materials` string (chars ≈ /3–4 tokens). These
/// are CONSERVATIVE prompt-capacity floors, not measured model maxima — the
/// point is that a frontier-context backend must not be starved by a number
/// sized for the weakest fallback. The orchestrator builds its package
/// against the budget of the candidate expected to serve
/// ([`RemoteLlm::materials_budget`]); at request time every candidate
/// truncates the package to ITS OWN floor, so a failover to a smaller
/// backend can never overflow it.
const ZAI_MATERIALS_CHARS: usize = 131_072; // glm-5.3 — frontier-class context
const VENICE_MATERIALS_CHARS: usize = 49_152; // stealth model — unknown window
const OPENCODE_MATERIALS_CHARS: usize = 49_152; // stealth model — unknown window
const OPENROUTER_MATERIALS_CHARS: usize = 49_152; // stealth model — unknown window
const OLLAMA_MATERIALS_CHARS: usize = 32_768; // cloud-hosted compact model
/// Default output-token cap for one subagent call. Generous on purpose:
/// hitting the cap truncates the answer mid-sentence (provider stops at
/// max_tokens), and a summary that runs long must still finish.
const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 16_384;

/// Z.AI — GLM Coding Plan gateway.
const ZAI_BASE_URL: &str = "https://api.z.ai/api/coding/paas/v4";
const ZAI_MODEL: &str = "glm-5.3";

/// OpenRouter — OpenAI-compatible gateway.
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL: &str = "stealth/ox-alpha";

/// Ollama Cloud — OpenAI-compatible endpoint.
const OLLAMA_BASE_URL: &str = "https://ollama.com/v1";
const OLLAMA_MODEL: &str = "nemotron-3-nano:30b";

/// Venice AI — OpenAI-compatible gateway.
const VENICE_BASE_URL: &str = "https://api.venice.ai/api/v1";
const VENICE_MODEL: &str = "stealth-ox-alpha";

/// OpenCode Zen — OpenAI-compatible gateway.
const OPENCODE_BASE_URL: &str = "https://opencode.ai/zen/v1";
const OPENCODE_MODEL: &str = "x-preview-f-free";

// ---------------------------------------------------------------------------
// Health tracker (failover state)
// ---------------------------------------------------------------------------

/// Default cooldown applied to a provider after a retryable failure when the
/// upstream doesn't supply a `Retry-After` header.
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(30);
/// Upper bound on any cooldown, so a hostile/large `Retry-After` can't park a
/// provider for an unreasonable amount of time.
const MAX_COOLDOWN: Duration = Duration::from_secs(300);

/// Tracks which providers are temporarily "unhealthy" (recently returned a
/// retryable status or failed to connect) so new requests steer away from
/// them until a cooldown elapses. In-memory and process-local.
struct ModelHealthTracker {
    /// provider label -> instant at which the cooldown expires.
    cooldowns: RwLock<HashMap<String, Instant>>,
    default_cooldown: Duration,
    max_cooldown: Duration,
}

impl Default for ModelHealthTracker {
    fn default() -> Self {
        Self::new(DEFAULT_COOLDOWN)
    }
}

impl ModelHealthTracker {
    fn new(default_cooldown: Duration) -> Self {
        Self {
            cooldowns: RwLock::new(HashMap::new()),
            default_cooldown,
            max_cooldown: MAX_COOLDOWN,
        }
    }

    #[cfg(test)]
    /// True if the provider is not currently in cooldown.
    fn is_available(&self, label: &str) -> bool {
        let guard = self.cooldowns.read().unwrap();
        match guard.get(label) {
            Some(until) => *until <= Instant::now(),
            None => true,
        }
    }

    /// Put a provider into cooldown after a retryable failure. `retry_after`
    /// (parsed from the upstream `Retry-After` header) overrides the default
    /// when present, capped at `max_cooldown`.
    fn mark_unhealthy(&self, label: &str, retry_after: Option<Duration>) {
        let cd = retry_after
            .unwrap_or(self.default_cooldown)
            .min(self.max_cooldown);
        let until = Instant::now() + cd;
        self.cooldowns
            .write()
            .unwrap()
            .insert(label.to_string(), until);
    }

    /// Clear a provider's cooldown (e.g. after a successful stream open).
    fn mark_healthy(&self, label: &str) {
        self.cooldowns.write().unwrap().remove(label);
    }

    /// Candidate order for an attempt: currently-available ones first, then
    /// cooled-down ones as a last resort so a request never hard-fails just
    /// because every provider is cooling down. Unlike a peer pool, the
    /// relative order inside each group is PRESERVED — the pool is a priority
    /// list of heterogeneous models (glm-5.3 ≠ nemotron ≠ deepseek), so
    /// shuffling would trade answer quality for load spreading we don't need.
    fn order_indices(&self, labels: &[&str]) -> Vec<usize> {
        let now = Instant::now();
        let (mut available, mut cooled): (Vec<usize>, Vec<usize>) = {
            let guard = self.cooldowns.read().unwrap();
            let mut avail = Vec::new();
            let mut cool = Vec::new();
            for (i, label) in labels.iter().enumerate() {
                let healthy = match guard.get(*label) {
                    Some(until) => *until <= now,
                    None => true,
                };
                if healthy {
                    avail.push(i);
                } else {
                    cool.push(i);
                }
            }
            (avail, cool)
        };
        available.append(&mut cooled);
        available
    }
}

/// Process-global tracker — `RemoteLlm::from_env()` runs per turn, so the
/// cooldown state must outlive any single instance.
static MODEL_HEALTH: LazyLock<ModelHealthTracker> = LazyLock::new(ModelHealthTracker::default);

// ---------------------------------------------------------------------------
// Provider pool
// ---------------------------------------------------------------------------

/// One hardcoded provider endpoint. `key` reads the vault pool; an empty key
/// removes the provider from the candidate list.
struct EndpointDef {
    label: &'static str,
    base_url: &'static str,
    model: &'static str,
    key: fn() -> String,
    /// Server-side floor on the materials package this candidate accepts.
    materials_budget: usize,
}

/// Fixed priority order (index 0 tried first while healthy).
const ENDPOINTS: &[EndpointDef] = &[
    EndpointDef {
        label: "zai",
        base_url: ZAI_BASE_URL,
        model: ZAI_MODEL,
        key: kawai_constants::llm::get_zai,
        materials_budget: ZAI_MATERIALS_CHARS,
    },
    EndpointDef {
        label: "venice",
        base_url: VENICE_BASE_URL,
        model: VENICE_MODEL,
        key: kawai_constants::llm::get_venice,
        materials_budget: VENICE_MATERIALS_CHARS,
    },
    EndpointDef {
        label: "opencode",
        base_url: OPENCODE_BASE_URL,
        model: OPENCODE_MODEL,
        key: kawai_constants::llm::get_opencode,
        materials_budget: OPENCODE_MATERIALS_CHARS,
    },
    EndpointDef {
        label: "openrouter",
        base_url: OPENROUTER_BASE_URL,
        model: OPENROUTER_MODEL,
        key: kawai_constants::llm::get_openrouter,
        materials_budget: OPENROUTER_MATERIALS_CHARS,
    },
    EndpointDef {
        label: "ollama",
        base_url: OLLAMA_BASE_URL,
        model: OLLAMA_MODEL,
        key: kawai_constants::llm::get_ollama,
        materials_budget: OLLAMA_MATERIALS_CHARS,
    },
];

/// One failover candidate: a prebuilt HTTP client + endpoint + auth headers +
/// its telemetry label. Clone so the failover loop can run inside the returned
/// stream ('static); the reqwest client is Arc-backed (cheap).
#[derive(Clone)]
pub struct Candidate {
    label: &'static str,
    http: reqwest::Client,
    /// `{base_url}/chat/completions` — every provider in the pool is
    /// OpenAI-compatible.
    url: String,
    model: &'static str,
    /// Authorization + provider-specific headers (OpenCode session headers),
    /// prebuilt once per process.
    headers: HeaderMap,
    /// Server-side floor on the materials package this candidate accepts.
    materials_budget: usize,
}

/// Per-call token usage captured from the stream's terminal record
/// (telemetry for `turn_log`). Zeros mean "provider reported none".
#[derive(Clone, Copy, Debug, Default)]
pub struct RemoteUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Events from one remote streaming call. `Done` terminates a successful
/// stream and carries the provider-reported usage plus the label of the
/// candidate that actually won (failover may have skipped earlier ones).
pub enum RemoteEvent {
    Token {
        text: String,
    },
    /// Provider reasoning (thinking) text, surfaced for live display.
    /// `provider` = the candidate actually streaming (failover may switch
    /// mid-call). `reset` carries replace semantics: `true` ⇒ `text` is the
    /// FULL corrected reasoning buffer (a complete reasoning block
    /// superseding its deltas, or a cleared buffer after a failover);
    /// `false` ⇒ `text` is a delta to append. Never counts toward the
    /// failover boundary — only a `Token` commits a candidate.
    Reasoning {
        provider: String,
        text: String,
        reset: bool,
    },
    /// `hit_cap` = the provider stopped at max_tokens (answer is truncated
    /// mid-flight); surfaced so consumers can flag it honestly.
    Done {
        usage: RemoteUsage,
        provider: String,
        hit_cap: bool,
    },
}

/// A configured remote completion pool.
pub struct RemoteLlm {
    /// Health-ordered candidates; index 0 is the preferred primary.
    candidates: Vec<Candidate>,
    max_output_tokens: u64,
    /// Env override (`KAWAI_REMOTE_LLM_MATERIALS_CHARS`): an absolute ceiling
    /// applied to EVERY provider's budget (a dev-wallet fuse — can only
    /// lower, never raise). `None` = per-provider floors stand as defined.
    max_materials_chars: Option<usize>,
}

impl RemoteLlm {
    /// Build the pool from the vault (see module docs). `None` ⇒ the remote
    /// tier is disabled (no vault keys); callers degrade to pure-local.
    pub fn from_env() -> Option<Self> {
        let mut candidates = Vec::new();
        for def in ENDPOINTS {
            let api_key = (def.key)();
            if api_key.is_empty() {
                continue;
            }
            let mut headers = HeaderMap::new();
            let bearer = format!("Bearer {api_key}");
            match HeaderValue::from_str(&bearer) {
                Ok(v) => headers.insert(reqwest::header::AUTHORIZATION, v),
                Err(e) => {
                    eprintln!(
                        "[remote] bearer header invalid for {} — skipped: {e}",
                        def.label
                    );
                    continue;
                }
            };
            if def.label == "opencode" {
                let session_id = random_id();
                let project_id = random_id();
                let request_id = random_id();
                let mut insert = |name: &'static str, value: String| {
                    if let Ok(v) = HeaderValue::from_str(&value) {
                        headers.insert(name, v);
                    }
                };
                insert("x-opencode-client", "cli".to_string());
                insert("x-opencode-session", session_id);
                insert("x-opencode-project", project_id);
                insert("x-opencode-request", request_id);
                insert("User-Agent", "opencode/latest/1.3.15/cli".to_string());
            }
            // No overall timeout: a 16k-token stream can legitimately run for
            // minutes, and the consumer (agent.rs) already enforces its own
            // REMOTE_TIMEOUT_SECS watchdog. Connect-phase failures are bounded.
            let http = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .build();
            let http = match http {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "[remote] client build failed for {} — skipped: {e}",
                        def.label
                    );
                    continue;
                }
            };
            candidates.push(Candidate {
                label: def.label,
                http,
                url: format!("{}/chat/completions", def.base_url),
                model: def.model,
                headers,
                materials_budget: def.materials_budget,
            });
        }
        if candidates.is_empty() {
            eprintln!("[remote] no vault keys configured — remote tier disabled");
            return None;
        }

        let max_output_tokens = std::env::var("KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
        let max_materials_chars = std::env::var("KAWAI_REMOTE_LLM_MATERIALS_CHARS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .filter(|&v| v > 0);
        Some(Self {
            candidates,
            max_output_tokens,
            max_materials_chars,
        })
    }

    /// Telemetry label for `turn_log` fallbacks and smoke tests: the
    /// preferred primary. The ACTUAL winner of a call is reported per-stream
    /// via [`RemoteEvent::Done::provider`].
    pub fn provider_label(&self) -> &str {
        self.candidates[0].label
    }

    /// Effective materials budget of the candidate expected to serve the next
    /// call (first in priority order among the currently healthy ones; a
    /// fully cooled pool still serves via the last-resort order, so index 0
    /// of that order is always a real candidate). The orchestrator sizes its
    /// `materials` package against this number.
    pub fn materials_budget(&self) -> usize {
        let labels: Vec<&str> = self.candidates.iter().map(|c| c.label).collect();
        let primary = MODEL_HEALTH.order_indices(&labels)[0];
        self.effective_budget(&self.candidates[primary])
    }

    /// Per-candidate budget with the env ceiling applied.
    fn effective_budget(&self, cand: &Candidate) -> usize {
        match self.max_materials_chars {
            Some(cap) => cand.materials_budget.min(cap),
            None => cand.materials_budget,
        }
    }

    /// One stateless streaming completion with provider failover (see module
    /// docs). `system` is the subagent persona; `task` is the model-written
    /// brief; `materials` is the curated context package. The package is
    /// truncated PER CANDIDATE to that backend's own materials floor — a
    /// frontier primary receives the full-size package while a failover to a
    /// smaller backend can never overflow it (never trust the caller). The
    /// whole candidate loop runs INSIDE the returned stream: the failover
    /// boundary is the first TEXT token yielded, so a zero-text completion
    /// (empty answer, reasoning-only stream) transparently retries the next
    /// candidate. Returns a boxed `Send` stream (the consumer lives inside
    /// Tauri command futures, which must be `Send`).
    pub async fn stream(
        &self,
        system: &str,
        task: &str,
        materials: &str,
    ) -> Result<std::pin::Pin<Box<dyn Stream<Item = Result<RemoteEvent, String>> + Send>>, String>
    {
        let candidates = self.candidates.clone();
        let max_output_tokens = self.max_output_tokens;
        let max_materials_chars = self.max_materials_chars;
        let system = system.to_string();
        let task = task.to_string();
        let materials = materials.to_string();

        let stream = async_stream::stream! {
            let labels: Vec<&str> = candidates.iter().map(|c| c.label).collect();
            let mut last_err = String::new();
            // Whether the current candidate attempt already streamed reasoning
            // — the next attempt opens by clearing the visible thinking so it
            // tracks the candidate that actually serves the call.
            let mut reasoning_emitted = false;
            for idx in MODEL_HEALTH.order_indices(&labels) {
                let cand = &candidates[idx];
                if reasoning_emitted {
                    reasoning_emitted = false;
                    yield Ok(RemoteEvent::Reasoning {
                        provider: cand.label.to_string(),
                        text: String::new(),
                        reset: true,
                    });
                }
                let materials_c =
                    truncate_chars(materials.trim(), cand.materials_budget.min(max_materials_chars.unwrap_or(usize::MAX)));
                let prompt = if materials_c.is_empty() {
                    format!("Task:\n{task}")
                } else {
                    format!(
                        "Task:\n{task}\n\n\
                         Materials (curated by the on-device orchestrator — the ONLY context you have; \
                         no chat history is included):\n<materials>\n{materials_c}\n</materials>"
                    )
                };
                let body = request_body(cand, &system, &prompt, max_output_tokens);
                let sent = cand
                    .http
                    .post(&cand.url)
                    .headers(cand.headers.clone())
                    .json(&body)
                    .send()
                    .await;
                let response = match sent {
                    Ok(r) => r,
                    Err(e) => {
                        // Transport/connection failure — always failover-worthy.
                        MODEL_HEALTH.mark_unhealthy(cand.label, None);
                        last_err = format!("{}: transport error: {e}", cand.label);
                        eprintln!(
                            "[remote] attempt {} failed (transport error) — trying next candidate",
                            cand.label
                        );
                        continue;
                    }
                };
                let status = response.status();
                if !status.is_success() {
                    let retry_after = response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.trim().parse::<u64>().ok())
                        .map(Duration::from_secs);
                    let snippet = response
                        .text()
                        .await
                        .unwrap_or_default();
                    let snippet: String = snippet.chars().take(200).collect();
                    let message =
                        format!("{}: status {}: {}", cand.label, status.as_u16(), snippet);
                    if is_retryable_status(status.as_u16()) {
                        MODEL_HEALTH.mark_unhealthy(cand.label, retry_after);
                        last_err = message;
                        eprintln!(
                            "[remote] attempt {} failed (status {}) — trying next candidate",
                            cand.label,
                            status.as_u16()
                        );
                        continue;
                    }
                    yield Err(message);
                    return;
                }

                // ── SSE stream: line-buffer, classify each `data:` frame ──
                let mut saw_text = false;
                let mut usage = RemoteUsage::default();
                let mut finish_length = false;
                let mut hard_err: Option<String> = None;
                let mut broke_pre_text = false;
                let mut lines = SseLineBuf::default();
                let mut byte_stream = response.bytes_stream();
                'candidate: while let Some(chunk) = byte_stream.next().await {
                    let bytes = match chunk {
                        Ok(b) => b,
                        Err(e) => {
                            if saw_text {
                                // Committed mid-stream: propagate, never retry
                                // (retrying would duplicate output).
                                hard_err = Some(format!("{}: stream error: {e}", cand.label));
                                break 'candidate;
                            }
                            MODEL_HEALTH.mark_unhealthy(cand.label, None);
                            last_err = format!("{}: stream error: {e}", cand.label);
                            broke_pre_text = true;
                            eprintln!(
                                "[remote] attempt {} errored before any text (transport error) — trying next candidate",
                                cand.label
                            );
                            break 'candidate;
                        }
                    };
                    for line in lines.push(&bytes) {
                        let Some(payload) = sse_data_payload(&line) else {
                            continue;
                        };
                        if payload == "[DONE]" {
                            break 'candidate;
                        }
                        let Ok(frame) = serde_json::from_str::<SseChunk>(payload) else {
                            // Tolerant skip: unknown/corrupt frames never kill
                            // the stream (comment/keep-alive lines are filtered
                            // in sse_data_payload).
                            continue;
                        };
                        if let Some(u) = frame.usage {
                            usage = RemoteUsage {
                                input_tokens: u.prompt_tokens,
                                output_tokens: u.completion_tokens,
                            };
                        }
                        for choice in &frame.choices {
                            if choice.finish_reason.as_deref() == Some("length") {
                                finish_length = true;
                            }
                            if let Some(text) = choice.delta.text() {
                                if !saw_text {
                                    MODEL_HEALTH.mark_healthy(cand.label);
                                }
                                saw_text = true;
                                yield Ok(RemoteEvent::Token { text });
                            }
                            if let Some(reasoning) = choice.delta.reasoning() {
                                reasoning_emitted = true;
                                yield Ok(RemoteEvent::Reasoning {
                                    provider: cand.label.to_string(),
                                    text: reasoning,
                                    reset: false,
                                });
                            }
                        }
                    }
                }
                // Flush a trailing unterminated line (tolerant: some providers
                // end the stream without a final newline).
                for line in lines.flush() {
                    if let Some(payload) = sse_data_payload(&line) {
                        if payload != "[DONE]" {
                            if let Ok(frame) = serde_json::from_str::<SseChunk>(payload) {
                                if let Some(u) = frame.usage {
                                    usage = RemoteUsage {
                                        input_tokens: u.prompt_tokens,
                                        output_tokens: u.completion_tokens,
                                    };
                                }
                                for choice in &frame.choices {
                                    if choice.finish_reason.as_deref() == Some("length") {
                                        finish_length = true;
                                    }
                                    if let Some(text) = choice.delta.text() {
                                        if !saw_text {
                                            MODEL_HEALTH.mark_healthy(cand.label);
                                        }
                                        saw_text = true;
                                        yield Ok(RemoteEvent::Token { text });
                                    }
                                    if let Some(reasoning) = choice.delta.reasoning() {
                                        reasoning_emitted = true;
                                        yield Ok(RemoteEvent::Reasoning {
                                            provider: cand.label.to_string(),
                                            text: reasoning,
                                            reset: false,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(e) = hard_err {
                    yield Err(e);
                    return;
                }
                if !saw_text {
                    if !broke_pre_text {
                        // Stream ended cleanly with ZERO text: an empty
                        // completion. Nothing was committed to the consumer —
                        // fail over just like a transport failure.
                        MODEL_HEALTH.mark_unhealthy(cand.label, None);
                        last_err = format!("{} returned an empty stream", cand.label);
                        eprintln!(
                            "[remote] attempt {} produced no text — trying next candidate",
                            cand.label
                        );
                    }
                    continue;
                }
                // hit_cap: the provider stopped at max_tokens — signaled
                // directly by finish_reason=length, with the usage-based check
                // as fallback for providers that report neither.
                let hit_cap = finish_length
                    || (usage.output_tokens > 0 && usage.output_tokens >= max_output_tokens);
                yield Ok(RemoteEvent::Done { usage, provider: cand.label.to_string(), hit_cap });
                return;
            }
            yield Err(format!(
                "all remote candidates failed{}",
                if last_err.is_empty() {
                    String::new()
                } else {
                    format!("; last error: {last_err}")
                }
            ));
        };
        Ok(Box::pin(stream))
    }
}

/// Whether an upstream HTTP status should trigger trying the next candidate.
///
/// Beyond 429/5xx we also fail over on 401/404. Every provider in the pool is
/// reached with its own server-side vault credential — so a 401/404 from a
/// specific provider is virtually always that target being withdrawn/disabled
/// upstream (e.g. a retired free model), not a per-request auth fault.
/// Failing over recovers the turn against the pool's healthy targets. A
/// globally bad credential fails every candidate anyway, so it surfaces after
/// pool exhaustion (an ops incident, not a hot-path concern).
fn is_retryable_status(status: u16) -> bool {
    matches!(status, 401 | 404 | 429 | 500 | 502 | 503 | 504)
}

// ---------------------------------------------------------------------------
// OpenAI-compatible SSE wire types
// ---------------------------------------------------------------------------

/// Build the chat-completions request body. Wire shape shared by every
/// provider in the pool; `stream_options.include_usage` requests the terminal
/// usage frame (some providers emit it unconditionally, the flag makes the
/// rest follow).
fn request_body(cand: &Candidate, system: &str, prompt: &str, max_output_tokens: u64) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cand.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": max_output_tokens,
        "stream": true,
        "stream_options": {"include_usage": true},
    });
    if cand.label == "zai" {
        // GLM keeps thinking OFF by default on this endpoint; enable it so
        // the reasoning channel streams. The field is zai-specific — never
        // sent to other providers.
        body["thinking"] = serde_json::json!({"type": "enabled"});
    }
    body
}

/// One streamed `data:` frame.
#[derive(serde::Deserialize, Default)]
struct SseChunk {
    #[serde(default)]
    choices: Vec<SseChoice>,
    #[serde(default)]
    usage: Option<SseUsage>,
}

#[derive(serde::Deserialize, Default)]
struct SseChoice {
    #[serde(default)]
    delta: SseDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(serde::Deserialize, Default)]
struct SseDelta {
    /// String on the standard wire; a few compatible providers (e.g.
    /// Mistral's reasoning models) stream an array of content parts instead.
    #[serde(default)]
    content: Option<serde_json::Value>,
    /// A structured-output refusal streams here with `content` held at
    /// `null` — its deltas are the turn's visible text.
    #[serde(default)]
    refusal: Option<String>,
    /// GLM/zai spelling of the reasoning channel.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// Groq-style spelling of the same channel. A separate field rather than
    /// a serde alias so a delta carrying BOTH keys is not a duplicate-field
    /// error that drops the whole chunk.
    #[serde(default)]
    reasoning: Option<String>,
}

impl SseDelta {
    /// Visible text: prefer non-empty `content`, fall back to `refusal`.
    fn text(&self) -> Option<String> {
        match &self.content {
            Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(serde_json::Value::Array(parts)) => {
                let joined = joined_text_parts(parts);
                (!joined.is_empty()).then_some(joined)
            }
            _ => self.refusal.clone().filter(|r| !r.is_empty()),
        }
    }

    /// Reasoning delta: `reasoning_content` first, Groq-style `reasoning`
    /// as fallback.
    fn reasoning(&self) -> Option<String> {
        self.reasoning_content
            .clone()
            .or_else(|| self.reasoning.clone())
            .filter(|r| !r.is_empty())
    }
}

/// Join an array-of-parts `content` into display text (`{"type":"text",
/// "text":…}` parts; non-text parts are skipped).
fn joined_text_parts(parts: &[serde_json::Value]) -> String {
    parts
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

#[derive(serde::Deserialize)]
struct SseUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
}

/// Extract the JSON payload of an SSE data line. Returns `None` for blank
/// lines, `: keep-alive` comments, and non-`data:` fields (event/id/retry).
fn sse_data_payload(line: &str) -> Option<&str> {
    let line = line.trim_start_matches('\u{feff}');
    if line.is_empty() || line.starts_with(':') {
        return None;
    }
    let payload = line.strip_prefix("data:")?;
    Some(payload.trim_start())
}

/// Byte-stream line splitter: feeds raw chunk bytes, returns every complete
/// `\n`-terminated line (tolerating `\r\n`), and can flush a trailing
/// unterminated line at stream end.
#[derive(Default)]
struct SseLineBuf {
    buf: Vec<u8>,
}

impl SseLineBuf {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let rest = self.buf.split_off(pos + 1);
            let mut line = std::mem::replace(&mut self.buf, rest);
            line.pop(); // the \n
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            lines.push(String::from_utf8_lossy(&line).into_owned());
        }
        lines
    }

    fn flush(&mut self) -> Vec<String> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let mut line = std::mem::take(&mut self.buf);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        vec![String::from_utf8_lossy(&line).into_owned()]
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

/// Generate a random 26-char alphanumeric ID for OpenCode headers.
fn random_id() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    (0..26)
        .map(|_| {
            let idx = rng.random_range(0..36);
            if idx < 10 {
                (b'0' + idx as u8) as char
            } else {
                (b'a' + idx as u8 - 10) as char
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn available_by_default() {
        let t = ModelHealthTracker::default();
        assert!(t.is_available("zai"));
    }

    #[test]
    fn mark_unhealthy_then_recovers() {
        let t = ModelHealthTracker::new(Duration::from_millis(20));
        t.mark_unhealthy("zai", None);
        assert!(!t.is_available("zai"));
        std::thread::sleep(Duration::from_millis(30));
        assert!(t.is_available("zai"));
    }

    #[test]
    fn mark_healthy_clears_cooldown() {
        let t = ModelHealthTracker::default();
        t.mark_unhealthy("zai", None);
        assert!(!t.is_available("zai"));
        t.mark_healthy("zai");
        assert!(t.is_available("zai"));
    }

    #[test]
    fn order_preserves_priority_and_puts_cooled_last() {
        let t = ModelHealthTracker::new(Duration::from_secs(30));
        let labels = ["zai", "openrouter", "ollama"];
        t.mark_unhealthy("zai", None);
        // zai cooled → openrouter, ollama keep relative order, zai last.
        assert_eq!(t.order_indices(&labels), vec![1, 2, 0]);
        // All healthy → exact priority order.
        t.mark_healthy("zai");
        assert_eq!(t.order_indices(&labels), vec![0, 1, 2]);
    }

    #[test]
    fn order_keeps_cooled_candidates_in_pool() {
        let t = ModelHealthTracker::new(Duration::from_secs(30));
        let labels = ["zai", "openrouter"];
        t.mark_unhealthy("zai", None);
        t.mark_unhealthy("openrouter", None);
        // Everything cooling down — still all present, priority preserved.
        assert_eq!(t.order_indices(&labels), vec![0, 1]);
    }

    #[test]
    fn retry_after_is_capped() {
        let t = ModelHealthTracker::new(Duration::from_secs(30));
        // A huge retry-after should be capped, but still marks unhealthy now.
        t.mark_unhealthy("zai", Some(Duration::from_secs(10_000)));
        assert!(!t.is_available("zai"));
    }

    #[test]
    fn retryable_statuses() {
        for s in [401u16, 404, 429, 500, 502, 503, 504] {
            assert!(is_retryable_status(s), "{s} should be retryable");
        }
        for s in [200u16, 400, 402, 403, 405, 422] {
            assert!(!is_retryable_status(s), "{s} should not be retryable");
        }
    }

    #[test]
    fn materials_budgets_frontier_first_and_all_positive() {
        for def in ENDPOINTS {
            assert!(def.materials_budget > 0, "{} must accept materials", def.label);
        }
        // The frontier primary is never starved below a fallback floor.
        assert!(ZAI_MATERIALS_CHARS >= VENICE_MATERIALS_CHARS);
    }

    // H5 failover boundary regression: empty completion (zero text) must be
    // treated as failover-worthy — it marks the candidate unhealthy and the
    // next candidate is tried. See stream() `!yielded_any` branch.
    #[test]
    fn failover_boundary_empty_stream_marks_unhealthy() {
        let t = ModelHealthTracker::new(Duration::from_secs(30));
        // Empty stream from zai → mark unhealthy (default cooldown)
        t.mark_unhealthy("zai", None);
        assert!(!t.is_available("zai"));
        // zai should now be last, openrouter first
        let labels = ["zai", "openrouter", "ollama"];
        assert_eq!(t.order_indices(&labels), vec![1, 2, 0]);
        // After recovery, priority restored
        t.mark_healthy("zai");
        assert_eq!(t.order_indices(&labels), vec![0, 1, 2]);
    }

    #[test]
    fn failover_boundary_yielded_token_commits_provider() {
        let t = ModelHealthTracker::default();
        // If at least one text token was yielded, mark_healthy is called — no cooldown
        t.mark_healthy("zai");
        assert!(t.is_available("zai"));
        let labels = ["zai", "openrouter"];
        assert_eq!(t.order_indices(&labels), vec![0, 1]);
        // Even if later mid-stream error occurs, yielded_any=true means NO failover
        // (stream() yields Err directly). This is verified by the `!saw_text` guard.
    }

    // ── SSE wire parsing ─────────────────────────────────────────────────

    #[test]
    fn sse_data_payload_filters_non_data_lines() {
        assert_eq!(sse_data_payload("data: {\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_payload("data:{\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_payload("[DONE]"), None);
        assert_eq!(sse_data_payload(""), None);
        assert_eq!(sse_data_payload(": keep-alive"), None);
        assert_eq!(sse_data_payload("event: message"), None);
    }

    #[test]
    fn sse_line_buf_splits_across_chunks_and_handles_crlf() {
        let mut buf = SseLineBuf::default();
        assert!(buf.push(b"data: {\"a\"").is_empty());
        let lines = buf.push(b":1}\r\ndata: [DONE]\n");
        assert_eq!(lines, vec!["data: {\"a\":1}", "data: [DONE]"]);
        assert!(buf.buf.is_empty());
    }

    #[test]
    fn sse_line_buf_flush_returns_trailing_unterminated_line() {
        let mut buf = SseLineBuf::default();
        buf.push(b"data: {\"z\":9}");
        assert_eq!(buf.flush(), vec!["data: {\"z\":9}"]);
        assert!(buf.flush().is_empty());
    }

    #[test]
    fn sse_chunk_maps_content_reasoning_usage_length() {
        let frame: SseChunk = serde_json::from_str(
            r#"{"choices":[{"delta":{"content":"hi","reasoning_content":"think"},"finish_reason":null}],"usage":null}"#,
        )
        .unwrap();
        assert_eq!(frame.choices[0].delta.text().as_deref(), Some("hi"));
        assert_eq!(frame.choices[0].delta.reasoning().as_deref(), Some("think"));
        assert!(frame.usage.is_none());

        let frame: SseChunk = serde_json::from_str(
            r#"{"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":64}}"#,
        )
        .unwrap();
        assert_eq!(frame.choices[0].finish_reason.as_deref(), Some("length"));
        let u = frame.usage.unwrap();
        assert_eq!((u.prompt_tokens, u.completion_tokens), (10, 64));
    }

    #[test]
    fn sse_chunk_handles_groq_reasoning_alias_and_array_content() {
        let frame: SseChunk = serde_json::from_str(
            r#"{"choices":[{"delta":{"reasoning":"groq-think","content":[{"type":"text","text":"par"},{"type":"text","text":"ts"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(frame.choices[0].delta.reasoning().as_deref(), Some("groq-think"));
        assert_eq!(frame.choices[0].delta.text().as_deref(), Some("parts"));
    }

    #[test]
    fn sse_chunk_refusal_is_visible_text() {
        let frame: SseChunk =
            serde_json::from_str(r#"{"choices":[{"delta":{"content":null,"refusal":"no"}}]}"#)
                .unwrap();
        assert_eq!(frame.choices[0].delta.text().as_deref(), Some("no"));
    }

    #[test]
    fn sse_chunk_tolerates_deltaless_choices_and_unknown_fields() {
        // Azure-style prompt-filter frame + unknown extensions never error.
        let frame: SseChunk =
            serde_json::from_str(r#"{"choices":[{}],"prompt_filter_results":[1],"new_field":true}"#)
                .unwrap();
        assert!(frame.choices[0].delta.text().is_none());
    }

    #[test]
    fn request_body_shape_and_zai_thinking_flag() {
        let mk = |label: &'static str| Candidate {
            label,
            http: reqwest::Client::new(),
            url: "https://example.invalid/chat/completions".into(),
            model: "m",
            headers: HeaderMap::new(),
            materials_budget: 1_000,
        };
        let plain = request_body(&mk("venice"), "sys", "prompt", 512);
        assert_eq!(plain["model"], "m");
        assert_eq!(plain["temperature"], 0.4);
        assert_eq!(plain["max_tokens"], 512);
        assert_eq!(plain["stream"], true);
        assert_eq!(plain["stream_options"]["include_usage"], true);
        assert_eq!(plain["messages"][0]["role"], "system");
        assert_eq!(plain["messages"][1]["content"], "prompt");
        assert!(plain.get("thinking").is_none());

        let zai = request_body(&mk("zai"), "sys", "prompt", 512);
        assert_eq!(zai["thinking"]["type"], "enabled");
    }
}
