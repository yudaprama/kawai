//! Cloud subagent client — the remote tier of the hybrid LLM design
//! (`PLAN-hybrid-llm-subagents.md`).
//!
//! Pure module (no transport types). One stateless streaming completion per
//! call: a fixed system persona + a task brief + locally-curated materials.
//! Chat history is NEVER sent — continuity is the local orchestrator's job;
//! the cloud only ever sees the delegation package the model curated.
//!
//! ## Wire client
//!
//! A hand-rolled OpenAI-compatible streaming client: `POST
//! {base_url}/chat/completions` with `stream: true` +
//! `stream_options.include_usage`, decoded incrementally from the
//! `text/event-stream` body. Recognized delta fields: `content` (string or
//! content-parts array), `refusal` (structured-output refusals stream as
//! visible text), and the two reasoning spellings `reasoning_content`
//! (GLM/DeepSeek) and `reasoning` (Groq/OpenRouter), with OpenRouter's
//! `reasoning_details` fragments as a last resort (only when both string
//! spellings are absent, so tokens are never counted twice). `[DONE]`
//! terminates; the terminal chunk's `usage` (OpenAI `prompt_tokens` /
//! `completion_tokens` spelling) feeds the `Done` event. Mid-stream
//! `{error: …}` objects surface like transport failures.
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
//! KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS  default 16384
//! ```
//!
//! No keys in the vault ⇒ `from_env() -> None` disables subagents entirely —
//! every agent then behaves exactly as pure-local.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::RwLock;

use futures_core::Stream;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};

/// Default cap on the `materials` string sent to the cloud (chars ≈ /4
/// tokens). Enforced server-side so no caller can blow the request budget.
const DEFAULT_MATERIALS_CHARS: usize = 24_000;
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
        let guard = self.cooldowns.read();
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
        self.cooldowns.write().insert(label.to_string(), until);
    }

    /// Clear a provider's cooldown (e.g. after a successful stream open).
    fn mark_healthy(&self, label: &str) {
        self.cooldowns.write().remove(label);
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
            let guard = self.cooldowns.read();
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
}

/// Fixed priority order (index 0 tried first while healthy).
const ENDPOINTS: &[EndpointDef] = &[
    EndpointDef {
        label: "zai",
        base_url: ZAI_BASE_URL,
        model: ZAI_MODEL,
        key: kawai_constants::llm::get_zai,
    },
    EndpointDef {
        label: "venice",
        base_url: VENICE_BASE_URL,
        model: VENICE_MODEL,
        key: kawai_constants::llm::get_venice,
    },
    EndpointDef {
        label: "opencode",
        base_url: OPENCODE_BASE_URL,
        model: OPENCODE_MODEL,
        key: kawai_constants::llm::get_opencode,
    },
    EndpointDef {
        label: "openrouter",
        base_url: OPENROUTER_BASE_URL,
        model: OPENROUTER_MODEL,
        key: kawai_constants::llm::get_openrouter,
    },
    EndpointDef {
        label: "ollama",
        base_url: OLLAMA_BASE_URL,
        model: OLLAMA_MODEL,
        key: kawai_constants::llm::get_ollama,
    },
];

/// One failover candidate: endpoint coordinates + credential + the extra
/// request headers the provider expects. Clone so the failover loop can run
/// inside the returned stream ('static).
#[derive(Clone)]
struct Candidate {
    label: &'static str,
    base_url: &'static str,
    model: &'static str,
    api_key: Arc<str>,
    /// Per-provider request headers (OpenCode client identification).
    headers: Arc<[(String, String)]>,
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
    Token { text: String },
    /// Provider reasoning (thinking) text, surfaced for live display.
    /// `provider` = the candidate actually streaming (failover may switch
    /// mid-call). `reset` carries replace semantics: `true` ⇒ `text` is the
    /// FULL corrected reasoning buffer (a cleared buffer after a failover);
    /// `false` ⇒ `text` is a delta to append. Never counts toward the
    /// failover boundary — only a `Token` commits a candidate.
    Reasoning { provider: String, text: String, reset: bool },
    /// `hit_cap` = the provider stopped at max_tokens (answer is truncated
    /// mid-flight); surfaced so consumers can flag it honestly.
    Done { usage: RemoteUsage, provider: String, hit_cap: bool },
}

/// A configured remote completion pool.
pub struct RemoteLlm {
    /// Shared HTTP client (connection pooling across candidates).
    client: reqwest::Client,
    /// Health-ordered candidates; index 0 is the preferred primary.
    candidates: Vec<Candidate>,
    max_output_tokens: u64,
    materials_cap: usize,
}

impl RemoteLlm {
    /// Build the pool from the vault (see module docs). `None` ⇒ the remote
    /// tier is disabled (no vault keys); callers degrade to pure-local.
    pub fn from_env() -> Option<Self> {
        let client = match reqwest::Client::builder()
            // Bounded handshake: a dead endpoint fails over instead of hanging
            // until the consumer's own timeout. No overall/read timeout —
            // generation streams can idle between tokens for a long time.
            .connect_timeout(Duration::from_secs(30))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(component = "remote", "HTTP client build failed — remote tier disabled: {e}");
                return None;
            }
        };
        let mut candidates = Vec::new();
        for def in ENDPOINTS {
            let api_key = (def.key)();
            if api_key.is_empty() {
                continue;
            }
            let headers: Vec<(String, String)> = if def.label == "opencode" {
                vec![
                    ("x-opencode-client".into(), "cli".into()),
                    ("x-opencode-session".into(), random_id()),
                    ("x-opencode-project".into(), random_id()),
                    ("x-opencode-request".into(), random_id()),
                    ("User-Agent".into(), "opencode/latest/1.3.15/cli".into()),
                ]
            } else {
                Vec::new()
            };
            candidates.push(Candidate {
                label: def.label,
                base_url: def.base_url,
                model: def.model,
                api_key: Arc::from(api_key.as_str()),
                headers: headers.into(),
            });
        }
        if candidates.is_empty() {
            tracing::warn!(component = "remote", "no vault keys configured — remote tier disabled");
            return None;
        }

        let max_output_tokens = std::env::var("KAWAI_REMOTE_LLM_MAX_OUTPUT_TOKENS")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
        Some(Self {
            client,
            candidates,
            max_output_tokens,
            materials_cap: DEFAULT_MATERIALS_CHARS,
        })
    }

    /// Telemetry label for `turn_log` fallbacks and smoke tests: the
    /// preferred primary. The ACTUAL winner of a call is reported per-stream
    /// via [`RemoteEvent::Done::provider`].
    pub fn provider_label(&self) -> &str {
        self.candidates[0].label
    }

    /// Server-side materials cap (exposed for the manifest description).
    pub fn materials_cap(&self) -> usize {
        self.materials_cap
    }

    /// One stateless streaming completion with provider failover (see module
    /// docs). `system` is the subagent persona; `task` is the model-written
    /// brief; `materials` is the curated context package (truncated to the
    /// cap here — never trust the caller). The whole candidate loop runs
    /// INSIDE the returned stream: the failover boundary is the first TEXT
    /// token yielded, so a zero-text completion (empty answer, reasoning-only
    /// stream) transparently retries the next candidate. Returns a boxed
    /// `Send` stream (the consumer lives inside Tauri command futures, which
    /// must be `Send`).
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

        let client = self.client.clone();
        let candidates = self.candidates.clone();
        let max_output_tokens = self.max_output_tokens;
        let system = system.to_string();

        let stream = async_stream::stream! {
            let labels: Vec<&str> = candidates.iter().map(|c| c.label).collect();
            let mut last_err = String::new();
            // Whether the PREVIOUS candidate streamed any reasoning — its
            // visible thinking is cleared when the next candidate takes over
            // so the display tracks the candidate that actually serves the
            // call.
            let mut streamed_reasoning = false;
            for idx in MODEL_HEALTH.order_indices(&labels) {
                let cand = &candidates[idx];
                if streamed_reasoning {
                    streamed_reasoning = false;
                    yield Ok(RemoteEvent::Reasoning {
                        provider: cand.label.to_string(),
                        text: String::new(),
                        reset: true,
                    });
                }

                let mut body = json!({
                    "model": cand.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.4,
                    "max_tokens": max_output_tokens,
                    "stream": true,
                    // Terminal usage record. Providers that ignore the field
                    // simply never report usage (zeros in the Done event).
                    "stream_options": {"include_usage": true},
                });
                if cand.label == "zai" {
                    // GLM keeps thinking OFF by default on this endpoint;
                    // enable it so the reasoning channel streams. The field
                    // is zai-specific — never sent to other providers.
                    body["thinking"] = json!({"type": "enabled"});
                }
                let mut request = client
                    .post(format!("{}/chat/completions", cand.base_url.trim_end_matches('/')))
                    .bearer_auth(&*cand.api_key)
                    .json(&body);
                for (key, value) in cand.headers.iter() {
                    request = request.header(key.as_str(), value.as_str());
                }

                let response = match request.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        let err = AttemptError::transport(e.to_string());
                        MODEL_HEALTH.mark_unhealthy(cand.label, None);
                        last_err = err.message.clone();
                        eprintln!(
                            "[remote] attempt {} failed ({}) — trying next candidate",
                            cand.label,
                            err.describe()
                        );
                        continue;
                    }
                };
                let status = response.status();
                if !status.is_success() {
                    let retry_after = retry_after_header(response.headers());
                    let detail = response.text().await.unwrap_or_default();
                    let err = AttemptError {
                        status: Some(status.as_u16()),
                        retry_after,
                        message: format!(
                            "HTTP {}: {}",
                            status.as_u16(),
                            truncate_chars(detail.trim(), 300)
                        ),
                    };
                    if err.failover_worthy() {
                        MODEL_HEALTH.mark_unhealthy(cand.label, err.retry_after);
                        last_err = err.message.clone();
                        eprintln!(
                            "[remote] attempt {} failed ({}) — trying next candidate",
                            cand.label,
                            err.describe()
                        );
                        continue;
                    }
                    yield Err(err.message);
                    return;
                }

                // Decode the SSE body incrementally. Failover boundary: the
                // first TEXT token — before it, any failure (transport, bad
                // chunk, empty stream) tries the next candidate; after it,
                // errors propagate (retrying would duplicate output).
                let mut decoder = SseDecoder::new();
                let mut frames: Vec<String> = Vec::new();
                let mut yielded_any = false;
                let mut broke_pre_text = false;
                let mut hit_length = false;
                let mut usage = RemoteUsage::default();
                let mut byte_stream = response.bytes_stream();
                'read: while let Some(item) = byte_stream.next().await {
                    let bytes = match item {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            let err = AttemptError::transport(e.to_string());
                            if !yielded_any {
                                MODEL_HEALTH.mark_unhealthy(cand.label, None);
                                last_err = err.message.clone();
                                broke_pre_text = true;
                                eprintln!(
                                    "[remote] attempt {} errored before any text ({}) — trying next candidate",
                                    cand.label,
                                    err.describe()
                                );
                                break 'read;
                            }
                            yield Err(err.message);
                            return;
                        }
                    };
                    frames.clear();
                    decoder.push(&bytes, &mut frames);
                    for frame in frames.drain(..) {
                        let events = match decode_chunk(&frame) {
                            Ok(events) => events,
                            Err(e) => {
                                let err = AttemptError::transport(e);
                                if !yielded_any {
                                    MODEL_HEALTH.mark_unhealthy(cand.label, None);
                                    last_err = err.message.clone();
                                    broke_pre_text = true;
                                    eprintln!(
                                        "[remote] attempt {} errored before any text ({}) — trying next candidate",
                                        cand.label,
                                        err.describe()
                                    );
                                    break 'read;
                                }
                                yield Err(err.message);
                                return;
                            }
                        };
                        for event in events {
                            match event {
                                WireEvent::Reasoning(text) => {
                                    streamed_reasoning = true;
                                    yield Ok(RemoteEvent::Reasoning {
                                        provider: cand.label.to_string(),
                                        text,
                                        reset: false,
                                    });
                                }
                                WireEvent::Text(text) => {
                                    if !yielded_any {
                                        MODEL_HEALTH.mark_healthy(cand.label);
                                    }
                                    yielded_any = true;
                                    yield Ok(RemoteEvent::Token { text });
                                }
                                WireEvent::Finished { hit_cap } => {
                                    hit_length |= hit_cap;
                                }
                                WireEvent::Usage(u) => usage = u,
                                WireEvent::Terminal => break 'read,
                            }
                        }
                    }
                }
                if !yielded_any {
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
                // `length` finish is the provider saying it truncated;
                // usage-based detection covers providers that stop at
                // max_tokens without reporting the finish reason.
                let hit_cap =
                    hit_length || (usage.output_tokens > 0 && usage.output_tokens >= max_output_tokens);
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

// ---------------------------------------------------------------------------
// Wire client (OpenAI-compatible SSE)
// ---------------------------------------------------------------------------

/// One failed candidate attempt: either an HTTP rejection (status known) or a
/// transport/decode failure (no status). Carries the upstream `Retry-After`
/// hint when the provider sent one.
struct AttemptError {
    status: Option<u16>,
    retry_after: Option<Duration>,
    message: String,
}

impl AttemptError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            status: None,
            retry_after: None,
            message: message.into(),
        }
    }

    /// An error is failover-worthy when it carries a retryable status OR
    /// carries no status at all (transport/connection failure — the plano
    /// proxy treats those as failover-worthy too).
    fn failover_worthy(&self) -> bool {
        self.status.map_or(true, is_retryable_status)
    }

    /// Short human-readable error class for the lost-attempt log line.
    fn describe(&self) -> String {
        match self.status {
            Some(status) => format!("status {status}"),
            None => "transport error".to_string(),
        }
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

/// Parse an integer-seconds `Retry-After` header. HTTP-date form is not
/// parsed (falls back to the tracker default).
fn retry_after_header(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// One OpenAI-compatible streaming chunk, decoded leniently: provider
/// extensions (`service_tier`, `provider`, …) are ignored, `choices` is
/// defaulted (the terminal usage chunk carries an empty array), and unknown
/// delta fields are skipped.
#[derive(Deserialize)]
struct WireChunk {
    #[serde(default)]
    choices: Vec<WireChoice>,
    #[serde(default)]
    usage: Option<WireUsage>,
    /// Some gateways report mid-stream failures as a 200 + error object
    /// instead of an HTTP error status; decoded as a stream failure.
    #[serde(default)]
    error: Option<Value>,
}

#[derive(Deserialize)]
struct WireChoice {
    #[serde(default)]
    delta: WireDelta,
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct WireDelta {
    /// String on every pooled provider; content-parts arrays accepted too.
    #[serde(default)]
    content: Option<Value>,
    /// A structured-output refusal streams here, on its own key, with
    /// `content` held at null — its deltas are the turn's visible text.
    #[serde(default)]
    refusal: Option<String>,
    /// Reasoning (thinking) deltas — GLM/DeepSeek spell it
    /// `reasoning_content`.
    #[serde(default)]
    reasoning_content: Option<String>,
    /// The same payload under `reasoning` on other providers (Groq,
    /// OpenRouter). A separate field, not a serde alias, so a delta carrying
    /// BOTH keys is not a duplicate-field error that drops the whole chunk.
    #[serde(default)]
    reasoning: Option<String>,
    /// Structured reasoning fragments (OpenRouter). Consulted only when both
    /// string spellings are absent — the fragments repeat the same tokens.
    #[serde(default)]
    reasoning_details: Option<Vec<Value>>,
}

/// Provider-reported token usage (OpenAI spelling) from the terminal chunk.
#[derive(Deserialize, Default, Debug)]
struct WireUsage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
}

/// One decoded chunk contribution, in wire order.
#[derive(Debug)]
enum WireEvent {
    Text(String),
    Reasoning(String),
    Finished { hit_cap: bool },
    Usage(RemoteUsage),
    /// The `[DONE]` sentinel.
    Terminal,
}

/// Decode one SSE `data:` payload. `[DONE]` → [`WireEvent::Terminal`]; a JSON
/// object → the text/reasoning/finish/usage events it carries (reasoning
/// before text — the model thinks before it speaks). An empty payload yields
/// nothing; an undecodable payload is an error.
fn decode_chunk(data: &str) -> Result<Vec<WireEvent>, String> {
    let payload = data.trim();
    if payload.is_empty() {
        return Ok(Vec::new());
    }
    if payload == "[DONE]" {
        return Ok(vec![WireEvent::Terminal]);
    }
    let chunk: WireChunk =
        serde_json::from_str(payload).map_err(|e| format!("undecodable stream chunk: {e}"))?;
    if let Some(err) = &chunk.error {
        return Err(match err.get("message").and_then(Value::as_str) {
            Some(message) => format!("provider stream error: {message}"),
            None => format!("provider stream error: {err}"),
        });
    }

    let mut out = Vec::new();
    for choice in &chunk.choices {
        // Reasoning first, one source per chunk: the `reasoning_content`
        // spelling wins, then `reasoning`, then the structured fragments.
        let reasoning = choice
            .delta
            .reasoning_content
            .clone()
            .filter(|text| !text.is_empty())
            .or_else(|| choice.delta.reasoning.clone().filter(|text| !text.is_empty()))
            .or_else(|| {
                let text = choice
                    .delta
                    .reasoning_details
                    .iter()
                    .flatten()
                    .filter_map(|detail| {
                        detail
                            .get("text")
                            .and_then(Value::as_str)
                            .or_else(|| detail.get("summary").and_then(Value::as_str))
                    })
                    .collect::<Vec<_>>()
                    .join("");
                (!text.is_empty()).then_some(text)
            });
        if let Some(text) = reasoning {
            out.push(WireEvent::Reasoning(text));
        }
        // Visible text: `content`, falling back to the refusal deltas.
        let text = content_text(choice.delta.content.clone())
            .or_else(|| choice.delta.refusal.clone().filter(|text| !text.is_empty()));
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            out.push(WireEvent::Text(text));
        }
        if let Some(reason) = choice.finish_reason.as_deref() {
            out.push(WireEvent::Finished {
                hit_cap: reason == "length",
            });
        }
    }
    if let Some(usage) = chunk.usage {
        out.push(WireEvent::Usage(RemoteUsage {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
        }));
    }
    Ok(out)
}

/// Flatten a wire `content` value (string, or an array of content parts on
/// some providers) into text.
fn content_text(value: Option<Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text),
        Value::Array(parts) => {
            let text = parts
                .into_iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
                .join("");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// Incremental `text/event-stream` decoder: buffers raw bytes, emits one
/// concatenated-`data:` payload per blank-line-terminated event. Comment
/// lines (`:` prefix) and non-`data` fields (`event:`, `id:`, `retry:`) are
/// skipped; CRLF line endings are tolerated; a multi-line `data:` field
/// rejoins with `\n` per the SSE spec.
struct SseDecoder {
    /// Raw bytes not yet terminated by a newline (a UTF-8 character may split
    /// across network chunks, so decoding waits for complete lines).
    buf: Vec<u8>,
    data: String,
    seen_data: bool,
}

impl SseDecoder {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            data: String::new(),
            seen_data: false,
        }
    }

    /// Feed one network chunk; complete event payloads are appended to `out`.
    fn push(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        self.buf.extend_from_slice(bytes);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            self.consume_line(&line[..pos], out);
        }
    }

    fn consume_line(&mut self, raw: &[u8], out: &mut Vec<String>) {
        let line = String::from_utf8_lossy(raw);
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if self.seen_data {
                out.push(std::mem::take(&mut self.data));
                self.seen_data = false;
            }
            return;
        }
        if let Some(field) = line.strip_prefix("data:") {
            if self.seen_data {
                self.data.push('\n');
            }
            // One leading space after the field colon is removed per spec.
            self.data.push_str(field.strip_prefix(' ').unwrap_or(field));
            self.seen_data = true;
        }
        // `event:` / `id:` / `retry:` / comments carry nothing this client needs.
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
            if idx < 10 { (b'0' + idx as u8) as char } else { (b'a' + idx as u8 - 10) as char }
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
        // (stream() yields Err directly). This is verified by the `!yielded_any && failover_worthy` guard.
    }

    // ── wire decoding ───────────────────────────────────────────────────────

    #[test]
    fn sse_decoder_splits_frames_on_blank_lines() {
        let mut dec = SseDecoder::new();
        let mut out = Vec::new();
        dec.push(
            b": ping\n\n\
             event: x\ndata: {\"a\":1}\n\n\
             data: partial",
            &mut out,
        );
        assert_eq!(out, vec!["{\"a\":1}".to_string()]);
        dec.push(b" continuation\n\n", &mut out);
        assert_eq!(out, vec!["{\"a\":1}".to_string(), "partial continuation".to_string()]);
        // CRLF tolerated.
        let mut out2 = Vec::new();
        dec.push(b"data: one\r\n\r\ndata: two\r\n\r\n", &mut out2);
        assert_eq!(out2, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn sse_decoder_holds_unterminated_final_frame() {
        // SSE frames dispatch on the blank-line terminator only; a trailing
        // `data:` line without one is never emitted (pooled providers always
        // send the terminator).
        let mut dec = SseDecoder::new();
        let mut out = Vec::new();
        dec.push(b"data: {\"usage\":{}}\n", &mut out);
        assert!(out.is_empty());
        dec.push(b"\n", &mut out);
        assert_eq!(out, vec!["{\"usage\":{}}".to_string()]);
    }

    #[test]
    fn sse_decoder_survives_split_multibyte_characters() {
        let mut dec = SseDecoder::new();
        let mut out = Vec::new();
        // 'é' is two bytes — split the pair across two pushes.
        dec.push(b"data: caf", &mut out);
        dec.push(&[0xc3, 0xa9, b'\n', b'\n'], &mut out);
        assert_eq!(out, vec!["café".to_string()]);
    }

    #[test]
    fn chunk_decodes_text_reasoning_finish_and_usage() {
        let events = decode_chunk(
            r#"{"choices":[{"delta":{"reasoning_content":"think","content":"hi"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], WireEvent::Reasoning(t) if t == "think"));
        assert!(matches!(&events[1], WireEvent::Text(t) if t == "hi"));

        let events = decode_chunk(
            r#"{"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}"#,
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], WireEvent::Finished { hit_cap: true }));
        assert!(matches!(&events[1], WireEvent::Usage(u) if u.input_tokens == 10 && u.output_tokens == 5));
    }

    #[test]
    fn chunk_decodes_alternate_reasoning_spellings_and_done() {
        // `reasoning` spelling (Groq/OpenRouter), content-parts array content.
        let events = decode_chunk(
            r#"{"choices":[{"delta":{"reasoning":"hmm","content":[{"type":"text","text":"he"}]},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], WireEvent::Reasoning(t) if t == "hmm"));
        assert!(matches!(&events[1], WireEvent::Text(t) if t == "he"));

        // reasoning_details only when both string spellings are absent.
        let events = decode_chunk(
            r#"{"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"frag"}]},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert!(matches!(&events[0], WireEvent::Reasoning(t) if t == "frag"));

        assert!(matches!(
            decode_chunk("[DONE]").unwrap().as_slice(),
            [WireEvent::Terminal]
        ));
        // Terminal usage-only chunk: empty choices, usage present.
        let events = decode_chunk(
            r#"{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}"#,
        )
        .unwrap();
        assert!(matches!(&events[0], WireEvent::Usage(u) if u.output_tokens == 2));
    }

    #[test]
    fn chunk_error_object_is_a_stream_failure() {
        let err = decode_chunk(r#"{"error":{"message":"overloaded"}}"#).unwrap_err();
        assert!(err.contains("overloaded"));
    }

    #[test]
    fn refusal_deltas_stream_as_text() {
        let events = decode_chunk(
            r#"{"choices":[{"delta":{"content":null,"refusal":"I cannot"},"finish_reason":null}]}"#,
        )
        .unwrap();
        assert!(matches!(&events[0], WireEvent::Text(t) if t == "I cannot"));
    }
}
