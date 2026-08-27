//! Compatibility shim — implementation lives in `crates/analytics-tools` (kawai-analytics crate).

#[cfg(feature = "analytics-sql")]
pub use kawai_analytics::sql_remote::*;
