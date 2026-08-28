//! Compatibility shim — implementation lives in `crates/engines/agent` (kawai-agent crate).

#[cfg(feature = "litert")]
pub use crate::agent_registry::{
    list_agents, AgentInfo, ANALYTICS_AGENT_ID, BINANCE_AGENT_ID, OFFICE_AGENT_ID,
    PRESENTATION_AGENT_ID,
};
#[cfg(feature = "litert")]
pub use kawai_agent::{agent_chat_with_registry, AgentChatEvent, AgentDefinition, AgentRegistry};

#[cfg(not(feature = "litert"))]
mod catalog;
#[cfg(not(feature = "litert"))]
pub use catalog::{
    list_agents, AgentInfo, ANALYTICS_AGENT_ID, BINANCE_AGENT_ID, OFFICE_AGENT_ID,
    PRESENTATION_AGENT_ID,
};
