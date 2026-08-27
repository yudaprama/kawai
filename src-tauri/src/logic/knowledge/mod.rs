//! Compatibility shim — implementation lives in `crates/engines/knowledge` (kawai-knowledge crate).

#[cfg(any(feature = "office", feature = "graph"))]
pub use kawai_knowledge::*;
