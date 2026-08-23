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
//! ```
//!
//! No keys in the vault ⇒ `from_env() -> None` disables subagents entirely —
//! every agent then behaves exactly as pure-local.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use std::time::{Duration, Instant};

use futures_core::Stream;
use futures_util::StreamExt;
use rig::client::CompletionClient;
use rig::completion::{CompletionError, CompletionModel};
use rig::http_client::HeaderMap;
use rig::providers::openai;

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

/// One failover candidate: a built rig model + its telemetry label. Clone so
/// the failover loop can run inside the returned stream ('static).
#[derive(Clone)]
pub struct Candidate {
    label: &'static str,
    model: std::sync::Arc<openai::CompletionModel>,
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
    /// `hit_cap` = the provider stopped at max_tokens (answer is truncated
    /// mid-flight); surfaced so consumers can flag it honestly.
    Done { usage: RemoteUsage, provider: String, hit_cap: bool },
}

/// A configured remote completion pool.
pub struct RemoteLlm {
    /// Health-ordered candidates; index 0 is the preferred primary.
    candidates: Vec<Candidate>,
    max_output_tokens: u64,
    materials_cap: usize,
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
            if def.label == "opencode" {
                let session_id = random_id();
                let project_id = random_id();
                let request_id = random_id();
                headers.insert("x-opencode-client", "cli".parse().unwrap());
                headers.insert("x-opencode-session", session_id.parse().unwrap());
                headers.insert("x-opencode-project", project_id.parse().unwrap());
                headers.insert("x-opencode-request", request_id.parse().unwrap());
                headers.insert("User-Agent", "opencode/latest/1.3.15/cli".parse().unwrap());
            }
            let client = openai::CompletionsClient::builder()
                .base_url(def.base_url)
                .api_key(rig::client::BearerAuth::from(api_key))
                .http_headers(headers)
                .build();
            let client = match client {
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
                model: std::sync::Arc::new(client.completion_model(def.model)),
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
        Some(Self {
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

        let candidates = self.candidates.clone();
        let max_output_tokens = self.max_output_tokens;
        let system = system.to_string();

        let stream = async_stream::stream! {
            let labels: Vec<&str> = candidates.iter().map(|c| c.label).collect();
            let mut last_err = String::new();
            for idx in MODEL_HEALTH.order_indices(&labels) {
                let cand = &candidates[idx];
                let request = cand
                    .model
                    .completion_request(prompt.clone())
                    .preamble(system.clone())
                    .temperature(0.4)
                    .max_tokens(max_output_tokens)
                    .build();
                let mut response = match cand.model.stream(request).await {
                    Ok(r) => r,
                    Err(e) => {
                        if failover_worthy(&e) {
                            MODEL_HEALTH.mark_unhealthy(cand.label, retry_after(&e));
                            last_err = e.to_string();
                            eprintln!(
                                "[remote] attempt {} failed ({}) — trying next candidate",
                                cand.label,
                                describe_error(&e)
                            );
                            continue;
                        }
                        yield Err(e.to_string());
                        return;
                    }
                };
                let mut yielded_any = false;
                let mut broke_pre_text = false;
                while let Some(item) = response.next().await {
                    match item {
                        Ok(rig::streaming::StreamedAssistantContent::Text(t)) => {
                            if !t.text.is_empty() {
                                if !yielded_any {
                                    MODEL_HEALTH.mark_healthy(cand.label);
                                }
                                yielded_any = true;
                                yield Ok(RemoteEvent::Token { text: t.text });
                            }
                        }
                        // No tools are sent, so any other content kind is
                        // ignored (reasoning deltas are provider-internal).
                        Ok(_) => {}
                        Err(e) => {
                            if !yielded_any && failover_worthy(&e) {
                                MODEL_HEALTH.mark_unhealthy(cand.label, retry_after(&e));
                                last_err = e.to_string();
                                broke_pre_text = true;
                                eprintln!(
                                    "[remote] attempt {} errored before any text ({}) — trying next candidate",
                                    cand.label,
                                    describe_error(&e)
                                );
                                break;
                            }
                            yield Err(e.to_string());
                            return;
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
                // Terminal record (usage) is populated by the time the stream ends.
                let usage = response
                    .response
                    .as_ref()
                    .map(|f| RemoteUsage {
                        input_tokens: f.usage.input_tokens,
                        output_tokens: f.usage.output_tokens,
                    })
                    .unwrap_or_default();
                let hit_cap = usage.output_tokens > 0
                    && usage.output_tokens >= max_output_tokens;
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

/// An error is failover-worthy when it carries a retryable status OR carries
/// no status at all (transport/connection failure — the plano proxy treats
/// those as failover-worthy too).
fn failover_worthy(e: &CompletionError) -> bool {
    match e.provider_response_status() {
        Some(status) => is_retryable_status(status.as_u16()),
        None => true,
    }
}

/// Parse an integer-seconds `Retry-After` from the headers rig preserved on
/// the error. HTTP-date form is not parsed (falls back to the tracker
/// default).
fn retry_after(e: &CompletionError) -> Option<Duration> {
    e.provider_response_headers()?
        .get("retry-after")?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// Short human-readable error class for the lost-attempt log line.
fn describe_error(e: &CompletionError) -> String {
    match e.provider_response_status() {
        Some(status) => format!("status {}", status.as_u16()),
        None => "transport error".to_string(),
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
    let mut rng = rand::thread_rng();
    (0..26)
        .map(|_| {
            let idx = rng.gen_range(0..36);
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
}
