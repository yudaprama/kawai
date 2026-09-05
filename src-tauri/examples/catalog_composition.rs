//! Shared composition root for the tool-catalog examples (seed + drift
//! check): builds the same merged supervisor toolset the planner's `auto`
//! registry uses, with the same stubs and exclusions. Included by both
//! examples via `#[path]` — there must be exactly ONE copy of this logic.

#![cfg(feature = "litert")]

use kawai_tools::ToolDefinition;

/// RPC-only tools ride some builders' toolsets but can never be dispatched by
/// the supervisor — kept out of the catalog (seed) and expected absent in it
/// (drift check).
pub const RPC_ONLY_TOOLS: &[&str] = &["graph_search", "graph_list"];

/// Tools whose catalog `kind` mirrors `ToolKind::Subagent`.
pub const SUBAGENT_TOOLS: &[&str] = &["deep_write", "draft_document", "plan_task", "plan_revise"];

/// Catalog `kind` for a tool name (mirrors `kawai_router::ToolKind`).
pub fn catalog_kind(name: &str) -> &'static str {
    if SUBAGENT_TOOLS.contains(&name) {
        "subagent"
    } else {
        "pure"
    }
}

/// Build the merged supervisor toolset's definitions: office first, then the
/// specialists fill in their exclusive tools (first-wins), RPC-only tools
/// excluded. A stub SQL profile is injected so `data_tables`/`data_import`
/// register (never invoked — the runtime bakes each user's real profiles per
/// turn). Fails fast when a domain toolset cannot be built.
pub async fn merged_definitions() -> Result<Vec<ToolDefinition>, String> {
    let remote_configured = remote_llm::RemoteLlm::from_env().is_some();
    let mut sql_profiles = kawai_analytics::effective_profiles("catalog-check").await;
    sql_profiles.push(kawai_agent_contract::SqlProfile {
        name: "catalog-stub".into(),
        source: "postgres://catalog-stub.invalid/db".into(),
    });
    let context = kawai_agent_contract::AgentContext {
        user_id: "catalog-check",
        session_id: 0,
        sql_profiles: Some(sql_profiles.as_slice()),
    };

    let mut merged: Option<kawai_tools::ToolSet> = None;
    for (label, set) in [
        (
            "office",
            kawai_lib::agent_registry::office_tools(&context, remote_configured),
        ),
        (
            "presentation",
            kawai_lib::agent_registry::presentation_tools_for_supervisor(
                &context,
                remote_configured,
            ),
        ),
        (
            "binance",
            kawai_lib::agent_registry::binance_tools_for_supervisor(&context, remote_configured),
        ),
        (
            "analytics",
            kawai_lib::agent_registry::analytics_tools_for_supervisor(&context, remote_configured),
        ),
        (
            "finance",
            kawai_lib::agent_registry::finance_tools_for_supervisor(&context, remote_configured),
        ),
    ]
    .into_iter()
    {
        // Fail fast on a missing domain toolset — a silently skipped domain
        // is exactly how the catalog drifted out of coverage before.
        let set = set.ok_or_else(|| format!(
            "domain toolset `{label}` could not be built — check that its cargo feature is enabled \
             (expected: --features litert,binance,codegraph) and its env is present"
        ))?;
        match &mut merged {
            Some(base) => base.merge(&mut { set }),
            None => merged = Some(set),
        }
    }
    let toolset = merged.ok_or("no domain toolset could be built (check env/vault)")?;
    let mut definitions: Vec<ToolDefinition> = toolset.get_tool_definitions().to_vec();
    let before = definitions.len();
    definitions.retain(|d| !RPC_ONLY_TOOLS.contains(&d.name.as_str()));
    if definitions.len() != before {
        eprintln!(
            "[catalog] excluded {} RPC-only tool(s): {:?}",
            before - definitions.len(),
            RPC_ONLY_TOOLS
        );
    }
    Ok(definitions)
}
