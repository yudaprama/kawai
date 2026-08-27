//! Compatibility shim — implementation lives in `crates/knowledge` (kawai-knowledge crate).

#[cfg(feature = "office")]
pub use kawai_knowledge::*;
