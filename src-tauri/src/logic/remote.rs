//! Compatibility shim — implementation lives in `crates/foundation/remote-llm` (remote-llm crate).
//!
//! Re-exported so `crate::logic::remote::*` remains stable after Phase 1
//! extraction. New code should prefer `remote_llm::*` directly.

pub use remote_llm::*;
