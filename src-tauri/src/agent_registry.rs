//! Application composition root for the built-in agent registry.
//!
//! Domain definitions live in their own crates (kawai_office, binance,
//! kawai_analytics). Cross-cutting runtime tools and per-agent toolset
//! overrides are composed here, not inside kawai-agent. The runtime crate
//! provides the loop and the contract types, but does NOT own the catalog.

use kawai_agent_contract::{
    no_capability, no_confirmation, AgentCapabilities, AgentContext, AgentDefinition, AgentRegistry,
};

#[cfg(all(feature = "codegraph", feature = "litert"))]
use codegraph::{CodegraphExploreTool, CodegraphStatusTool};

// Re-export contract types used by transport wrappers.
pub use kawai_agent_contract::AgentInfo;

/// Fallback persona for agents whose domain feature is not compiled in.
const FALLBACK_PERSONA: &str = "You are kawai, a helpful, concise personal assistant.";

// ── Agent IDs ───────────────────────────────────────────────────────────────

pub const OFFICE_AGENT_ID: &str = "builtin.office";
pub const PRESENTATION_AGENT_ID: &str = "builtin.presentation";
pub const BINANCE_AGENT_ID: &str = "builtin.binance";
pub const ANALYTICS_AGENT_ID: &str = "builtin.analytics";

/// Build the agent catalog list from the built-in registry.
pub fn list_agents() -> Vec<AgentInfo> {
    builtin().list()
}

// ── Tool builders ───────────────────────────────────────────────────────────

/// Office gets knowledge_search, graph tools, and cloud subagent tools.
#[cfg(feature = "litert")]
fn office_tools(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(feature = "office")]
    {
        let mut set = (kawai_office::agent::definition().build_tools)(context, remote_configured)?;
        set.add_tool(kawai_knowledge::tools::KnowledgeSearchTool(
            context.user_id.to_string(),
            context.session_id,
        ));
        #[cfg(feature = "graph")]
        kawai_knowledge::graph::extend_toolset(&mut set, context.user_id);
        return Some(add_runtime_tools(set, remote_configured, true));
    }
    #[cfg(not(feature = "office"))]
    {
        let _ = (context, remote_configured);
        None
    }
}

/// Presentation gets deck authoring, source reading, knowledge search, and
/// cloud synthesis — but not document editing or PDF mutation tools.
#[cfg(feature = "litert")]
fn presentation_tools(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(feature = "office")]
    {
        let mut set = (kawai_office::agent::presentation_definition().build_tools)(
            context,
            remote_configured,
        )?;
        set.add_tool(kawai_knowledge::tools::KnowledgeSearchTool(
            context.user_id.to_string(),
            context.session_id,
        ));
        return Some(add_runtime_tools(set, remote_configured, false));
    }
    #[cfg(not(feature = "office"))]
    {
        let _ = (context, remote_configured);
        None
    }
}

/// Binance gets web read/search (cross-cutting) and cloud subagent tools.
#[cfg(feature = "litert")]
fn binance_tools(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(all(feature = "binance", not(target_os = "android")))]
    {
        let mut set = (::binance::agent::definition().build_tools)(context, remote_configured)?;
        #[cfg(feature = "webread")]
        if webread::any_engine() {
            set.add_tool(webread::WebReadTool(context.user_id.to_string()));
            set.add_tool(webread::WebSearchTool(context.user_id.to_string()));
        }
        return Some(add_runtime_tools(set, remote_configured, false));
    }
    #[cfg(not(all(feature = "binance", not(target_os = "android"))))]
    {
        let _ = (context, remote_configured);
        None
    }
}

/// Analytics: delegates entirely to its own tool builder + cloud subagent tools.
#[cfg(feature = "litert")]
fn analytics_tools(
    context: &AgentContext<'_>,
    remote_configured: bool,
) -> Option<kawai_tools::ToolSet> {
    #[cfg(feature = "analytics")]
    {
        let set = (kawai_analytics::agent::definition().build_tools)(context, remote_configured)?;
        return Some(add_runtime_tools(set, remote_configured, false));
    }
    #[cfg(not(feature = "analytics"))]
    {
        let _ = (context, remote_configured);
        None
    }
}

/// Append the runtime-owned cross-cutting tools: artifact_recall (always),
/// deep_write (when remote is configured), and draft_document (only for
/// agents whose definition says they support it).
#[cfg(feature = "litert")]
fn add_runtime_tools(
    mut set: kawai_tools::ToolSet,
    remote_configured: bool,
    supports_draft_document: bool,
) -> kawai_tools::ToolSet {
    #[cfg(not(feature = "office"))]
    let _ = supports_draft_document;
    set.add_tool(kawai_agent::ArtifactRecall);
    #[cfg(feature = "codegraph")]
    {
        // Hot-path agent tools — LRU-cached sidecar (phase0), native (phase1) when available.
        // Added to every agent so explore is always one call away.
        set.add_tool(CodegraphExploreTool);
        set.add_tool(CodegraphStatusTool);
    }
    if remote_configured {
        set.add_tool(kawai_agent::DeepWrite);
        set.add_tool(kawai_agent::PlanTask);
        set.add_tool(kawai_agent::PlanRevise);
        #[cfg(feature = "office")]
        if supports_draft_document {
            set.add_tool(kawai_agent::DraftDocument);
        }
    }
    set
}

/// Tool builder for disabled/unavailable agents.
fn unavailable_tools(_: &AgentContext<'_>, _: bool) -> Option<kawai_tools::ToolSet> {
    None
}

/// Create a disabled placeholder definition for agents whose domain
/// feature is not compiled in.
fn unavailable_definition(
    id: &'static str,
    name: &'static str,
    description: &'static str,
    enabled: bool,
) -> AgentDefinition {
    AgentDefinition {
        id,
        name,
        description,
        tools: false,
        enabled,
        persona: FALLBACK_PERSONA,
        build_tools: unavailable_tools,
        capabilities: AgentCapabilities::default(),
        capability_for_tool: no_capability,
        confirmation_for_tool: no_confirmation,
        summary_directive: None,
    }
}

// ── Registry construction ───────────────────────────────────────────────────

/// Build the built-in agent registry by composing domain definitions with
/// cross-cutting tools and capability overrides.
#[cfg(feature = "litert")]
pub fn builtin() -> AgentRegistry {
    let office = {
        #[cfg(feature = "office")]
        {
            let mut d = kawai_office::agent::definition();
            d.build_tools = office_tools;
            d
        }
        #[cfg(not(feature = "office"))]
        unavailable_definition(
            OFFICE_AGENT_ID,
            "Office",
            "Your on-device assistant for documents, PDFs, spreadsheets, and chat.",
            true,
        )
    };

    let presentation = {
        #[cfg(feature = "office")]
        {
            let mut d = kawai_office::agent::presentation_definition();
            d.build_tools = presentation_tools;
            d
        }
        #[cfg(not(feature = "office"))]
        unavailable_definition(
            PRESENTATION_AGENT_ID,
            "Presentation",
            "Create clear presentation decks from your documents, data, and research.",
            false,
        )
    };

    let binance = {
        #[cfg(all(feature = "binance", not(target_os = "android")))]
        {
            let mut d = ::binance::agent::definition();
            d.build_tools = binance_tools;
            d
        }
        #[cfg(not(all(feature = "binance", not(target_os = "android"))))]
        unavailable_definition(
            BINANCE_AGENT_ID,
            "Binance",
            "Crypto market data and technical analysis on Binance spot.",
            false,
        )
    };

    let analytics = {
        #[cfg(feature = "analytics")]
        {
            let mut d = kawai_analytics::agent::definition();
            d.build_tools = analytics_tools;
            d
        }
        #[cfg(not(feature = "analytics"))]
        unavailable_definition(
            ANALYTICS_AGENT_ID,
            "Analytics",
            "Structured queries over your data files: filter, aggregate, rank.",
            false,
        )
    };

    AgentRegistry::new(vec![office, presentation, binance, analytics])
}

/// Non-litert build: all agents are disabled placeholders.
#[cfg(not(feature = "litert"))]
pub fn builtin() -> AgentRegistry {
    AgentRegistry::new(vec![
        unavailable_definition(
            OFFICE_AGENT_ID,
            "Office",
            "Your on-device assistant for documents, PDFs, spreadsheets, and chat.",
            false,
        ),
        unavailable_definition(
            PRESENTATION_AGENT_ID,
            "Presentation",
            "Create clear presentation decks from your documents, data, and research.",
            false,
        ),
        unavailable_definition(
            BINANCE_AGENT_ID,
            "Binance",
            "Crypto market data and technical analysis on Binance spot.",
            false,
        ),
        unavailable_definition(
            ANALYTICS_AGENT_ID,
            "Analytics",
            "Structured queries over your data files: filter, aggregate, rank.",
            false,
        ),
    ])
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_have_stable_order_and_ids() {
        let registry = builtin();
        assert_eq!(
            registry
                .list()
                .iter()
                .map(|a| a.id.as_str())
                .collect::<Vec<_>>(),
            [
                OFFICE_AGENT_ID,
                PRESENTATION_AGENT_ID,
                BINANCE_AGENT_ID,
                ANALYTICS_AGENT_ID,
            ]
        );
    }

    #[test]
    fn office_is_resolvable_when_litert_is_available() {
        let registry = builtin();
        #[cfg(feature = "litert")]
        assert!(registry.resolve(OFFICE_AGENT_ID).is_some());
        #[cfg(not(feature = "litert"))]
        assert!(registry.resolve(OFFICE_AGENT_ID).is_none());
    }

    #[test]
    fn presentation_is_enabled_with_office_tools() {
        let registry = builtin();
        #[cfg(all(feature = "litert", feature = "office"))]
        assert!(registry.resolve(PRESENTATION_AGENT_ID).is_some());
        #[cfg(any(not(feature = "litert"), not(feature = "office")))]
        assert!(registry.resolve(PRESENTATION_AGENT_ID).is_none());
    }

    #[test]
    fn optional_agents_are_enabled_only_with_their_capability() {
        let registry = builtin();

        #[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
        assert!(registry.resolve(BINANCE_AGENT_ID).is_some());
        #[cfg(any(
            not(feature = "litert"),
            not(feature = "binance"),
            target_os = "android"
        ))]
        assert!(registry.resolve(BINANCE_AGENT_ID).is_none());

        #[cfg(all(feature = "litert", feature = "analytics"))]
        assert!(registry.resolve(ANALYTICS_AGENT_ID).is_some());
        #[cfg(any(not(feature = "litert"), not(feature = "analytics")))]
        assert!(registry.resolve(ANALYTICS_AGENT_ID).is_none());
    }

    #[test]
    fn unknown_agent_is_not_resolvable() {
        assert!(builtin().resolve("builtin.missing").is_none());
    }

    // ── tool-manifest regression tests ───────────────────────────────────────

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn office_toolset_includes_knowledge_and_runtime_tools() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let registry = builtin();
        let set = registry
            .build_tools(OFFICE_AGENT_ID, &ctx, false)
            .expect("office tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"knowledge_search"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");
        assert!(
            !names.contains(&"deep_write"),
            "remote off must not add deep_write: {names:?}"
        );
    }

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn presentation_toolset_is_focused_on_decks_and_sources() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(PRESENTATION_AGENT_ID, &ctx, false)
            .expect("presentation tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"office_create_deck"), "{names:?}");
        assert!(names.contains(&"office_export_deck"), "{names:?}");
        assert!(names.contains(&"office_read_document"), "{names:?}");
        assert!(names.contains(&"knowledge_search"), "{names:?}");
        assert!(!names.contains(&"office_edit_document"), "{names:?}");
        assert!(!names.contains(&"pdf_merge"), "{names:?}");
        assert!(!names.contains(&"draft_document"), "{names:?}");
    }

    #[cfg(all(feature = "litert", feature = "office"))]
    #[test]
    fn office_remote_toolset_adds_deep_write_and_draft() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(OFFICE_AGENT_ID, &ctx, true)
            .expect("office remote tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"deep_write"), "{names:?}");
        assert!(names.contains(&"draft_document"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");
    }

    #[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
    #[test]
    fn binance_toolset_includes_market_and_runtime_tools() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let registry = builtin();
        let set = registry
            .build_tools(BINANCE_AGENT_ID, &ctx, false)
            .expect("binance tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"binance_price"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");
        assert!(
            !names.contains(&"deep_write"),
            "remote off must not add deep_write: {names:?}"
        );
        assert!(
            !names.contains(&"draft_document"),
            "binance never carries draft_document: {names:?}"
        );
    }

    #[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
    #[test]
    fn binance_remote_adds_deep_write_no_draft() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(BINANCE_AGENT_ID, &ctx, true)
            .expect("binance remote tools");
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names.contains(&"deep_write"), "{names:?}");
        assert!(
            !names.contains(&"draft_document"),
            "binance never carries draft_document: {names:?}"
        );
    }

    #[cfg(all(feature = "litert", feature = "analytics"))]
    #[test]
    fn analytics_toolset_respects_sql_profiles_and_remote() {
        use kawai_agent_contract::SqlProfile;
        let ctx_no_profiles = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let ctx_with_profiles = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: Some(&[SqlProfile {
                name: "prod".into(),
                source: "postgresql://...".into(),
            }]),
        };
        let registry = builtin();

        let no_profiles = registry
            .build_tools(ANALYTICS_AGENT_ID, &ctx_no_profiles, false)
            .expect("analytics tools");
        let names: Vec<&str> = no_profiles
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(!names.contains(&"data_tables"), "{names:?}");
        assert!(names.contains(&"data_schema"), "{names:?}");
        assert!(names.contains(&"artifact_recall"), "{names:?}");

        let with_profiles = registry
            .build_tools(ANALYTICS_AGENT_ID, &ctx_with_profiles, false)
            .expect("analytics tools with profiles");
        let names_prof: Vec<&str> = with_profiles
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(names_prof.contains(&"data_tables"), "{names_prof:?}");
        assert!(
            !names_prof.contains(&"deep_write"),
            "remote off must not add deep_write: {names_prof:?}"
        );

        let remote = registry
            .build_tools(ANALYTICS_AGENT_ID, &ctx_with_profiles, true)
            .expect("analytics remote tools");
        let remote_names: Vec<&str> = remote
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert!(remote_names.contains(&"deep_write"), "{remote_names:?}");
        assert!(
            !remote_names.contains(&"draft_document"),
            "analytics never carries draft_document: {remote_names:?}"
        );
    }

    // Binance-only: without the feature the agent has no toolset at all
    // (build_tools returns None), so the assertions below are meaningless.
    #[cfg(all(feature = "litert", feature = "webread", feature = "binance"))]
    #[test]
    fn binance_webread_tools_present_when_engine_available() {
        let ctx = AgentContext {
            user_id: "u",
            session_id: 1,
            sql_profiles: None,
        };
        let set = builtin()
            .build_tools(BINANCE_AGENT_ID, &ctx, false)
            .expect("binance tools");
        #[cfg(feature = "binance")]
        if webread::any_engine() {
            let names: Vec<&str> = set
                .get_tool_definitions()
                .iter()
                .map(|d| d.name.as_str())
                .collect();
            assert!(
                names.contains(&"web_read"),
                "engine available, expected web_read: {names:?}"
            );
        }
    }
}
