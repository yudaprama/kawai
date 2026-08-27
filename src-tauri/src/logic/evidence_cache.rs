//! Compatibility shim — implementation lives in `crates/agent` (kawai-agent crate).

#[cfg(feature = "litert")]
pub use kawai_agent::evidence_cache::*;

#[cfg(not(feature = "litert"))]
/// No-op when the on-device LLM is not compiled — the agent loop never runs.
pub fn drop_session(_user_id: &str, _sid: i64) {}
