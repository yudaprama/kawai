//! Backward-compatibility re-export for the GraphRAG subsystem.
//!
//! All implementation now lives in `logic/knowledge/graph/`. This module
//! re-exports every public symbol so existing `logic::graph::*` call sites
//! remain valid.

#[cfg(feature = "graph")]
pub use super::knowledge::graph::*;
