//! Backward-compatibility re-export for the knowledge subsystem.
//!
//! All implementation now lives in `logic/knowledge/`. This module re-exports
//! every public symbol so existing `logic::rag::*` call sites remain valid.

pub use super::knowledge::*;
