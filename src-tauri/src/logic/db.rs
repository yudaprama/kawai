//! Compatibility shim — implementation lives in `crates/db` (kawai-db crate).
//!
//! Re-exported so `crate::logic::db::*` and `crate::logic::DbError` (via
//! `logic.rs: pub use db::*`) remain stable after Phase 2 extraction.

pub use kawai_db::db::*;
pub use kawai_db::*;
