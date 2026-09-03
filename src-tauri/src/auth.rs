//! Compatibility shim — implementation lives in `crates/foundation/auth` (kawai-auth crate).
//!
//! Re-exported so `crate::auth::*` imports remain stable after extraction.
//! New code should prefer `kawai_auth::*` directly.

pub use kawai_auth::*;
