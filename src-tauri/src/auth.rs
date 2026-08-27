//! Compatibility shim — implementation lives in `crates/foundation/auth` (kawai-auth crate).
//!
//! Re-exported so `crate::auth::*` and `crate::logic::remote`-style imports
//! remain stable after Phase 1 extraction. New code should prefer
//! `kawai_auth::*` directly.

pub use kawai_auth::*;
