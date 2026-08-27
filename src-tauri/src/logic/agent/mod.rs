//! Compatibility shim — implementation lives in `crates/engines/agent` (kawai-agent crate).

#[cfg(feature = "litert")]
pub use kawai_agent::*;

#[cfg(not(feature = "litert"))]
mod catalog;
#[cfg(not(feature = "litert"))]
pub use catalog::{list_agents, AgentInfo, OFFICE_AGENT_ID, BINANCE_AGENT_ID, ANALYTICS_AGENT_ID};
