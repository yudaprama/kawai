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

/// Subagent/internal-dispatch tools: excluded from the supervisor registry
/// entirely so the planner can neither see nor plan against them. Must stay in
/// sync with `supervisor::NON_DISPATCHABLE_TOOLS` — the catalog is the planner's
/// only discovery path, so a tool banned from the registry must also be absent
/// from the catalog (otherwise search surfaces it and validation rejects it).
pub const NON_DISPATCHABLE_TOOLS: &[&str] = &[
    "deep_write",
    "draft_document",
    "plan_task",
    "plan_revise",
    "artifact_recall",
];

/// Tools whose catalog `kind` mirrors `ToolKind::Subagent` (subset of the
/// non-dispatchable set that would be `subagent` if they were dispatchable).
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
        (
            "entertainment",
            kawai_lib::agent_registry::entertainment_tools_for_supervisor(
                &context,
                remote_configured,
            ),
        ),
        ("weather-geo", kawai_lib::agent_registry::weather_geo_tools_for_supervisor(&context, remote_configured)),
        ("news-media", kawai_lib::agent_registry::news_media_tools_for_supervisor(&context, remote_configured)),
        ("sports", kawai_lib::agent_registry::sports_tools_for_supervisor(&context, remote_configured)),
        ("food-drink", kawai_lib::agent_registry::food_drink_tools_for_supervisor(&context, remote_configured)),
        ("geospace", kawai_lib::agent_registry::geospace_tools_for_supervisor(&context, remote_configured)),
        ("knowledge", kawai_lib::agent_registry::knowledge_tools_for_supervisor(&context, remote_configured)),
        ("religion", kawai_lib::agent_registry::religion_tools_for_supervisor(&context, remote_configured)),
        ("utility", kawai_lib::agent_registry::utility_tools_for_supervisor(&context, remote_configured)),
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
    definitions.retain(|d| {
        !RPC_ONLY_TOOLS.contains(&d.name.as_str())
            && !NON_DISPATCHABLE_TOOLS.contains(&d.name.as_str())
    });
    if definitions.len() != before {
        eprintln!(
            "[catalog] excluded {} non-catalog tool(s): {} RPC-only + {} internal (non-dispatchable)",
            before - definitions.len(),
            RPC_ONLY_TOOLS.len(),
            NON_DISPATCHABLE_TOOLS.len()
        );
    }
    Ok(definitions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_dispatchable_tools_stay_in_sync_with_supervisor() {
        // Must mirror `supervisor::NON_DISPATCHABLE_TOOLS` exactly — drift there
        // caused the `draft_document` planner_smoke failure (catalog surfaced it,
        // registry rejected it).
        let supervisor = kawai_lib::supervisor::NON_DISPATCHABLE_TOOLS;
        assert_eq!(
            NON_DISPATCHABLE_TOOLS.len(),
            supervisor.len(),
            "catalog composition vs supervisor length mismatch"
        );
        for &name in NON_DISPATCHABLE_TOOLS {
            assert!(
                supervisor.contains(&name),
                "catalog NON_DISPATCHABLE_TOOLS contains {name:?} not in supervisor::NON_DISPATCHABLE_TOOLS"
            );
        }
        for &name in &supervisor {
            assert!(
                NON_DISPATCHABLE_TOOLS.contains(&name),
                "supervisor NON_DISPATCHABLE_TOOLS contains {name:?} not in catalog composition"
            );
        }
    }

    #[test]
    fn non_dispatchable_and_rpc_only_do_not_overlap() {
        for &name in NON_DISPATCHABLE_TOOLS {
            assert!(
                !RPC_ONLY_TOOLS.contains(&name),
                "{name:?} must not be in both RPC_ONLY and NON_DISPATCHABLE"
            );
        }
    }

    #[test]
    fn catalog_kind_classifies_subagent_subset() {
        for &name in SUBAGENT_TOOLS {
            assert_eq!(catalog_kind(name), "subagent", "{name} should be subagent");
            assert!(
                NON_DISPATCHABLE_TOOLS.contains(&name),
                "{name} in SUBAGENT_TOOLS must also be in NON_DISPATCHABLE_TOOLS"
            );
        }
        assert_eq!(catalog_kind("office_create_document"), "pure");
        assert_eq!(catalog_kind("web_search"), "pure");
    }

    // Full integration: merged_definitions() must never emit a non-dispatchable
    // or RPC-only tool, even when remote is configured (vault present). This is
    // the regression guard for the planner_smoke `unknown tool "draft_document"` failure.
    // Requires the same feature set as the seed binary: litert + binance + codegraph etc.
    #[tokio::test]
    async fn merged_definitions_excludes_non_dispatchable_and_rpc_only() {
        let defs = match merged_definitions().await {
            Ok(d) => d,
            Err(e) if e.contains("could not be built") => {
                // Feature set incomplete in this cargo invocation (e.g. `cargo test -p kawai --features litert`
                // without `binance`) — skip rather than false-fail. The full
                // gate runs with `--features litert,binance,codegraph`.
                eprintln!("[skip] merged_definitions_excludes_* : {e}");
                return;
            }
            Err(e) => panic!("merged_definitions failed: {e}"),
        };
        assert!(!defs.is_empty(), "merged definitions must not be empty");
        for banned in NON_DISPATCHABLE_TOOLS.iter().chain(RPC_ONLY_TOOLS.iter()) {
            assert!(
                !defs.iter().any(|d| &d.name == banned),
                "merged_definitions must not contain {banned:?} — it is not dispatchable by the supervisor"
            );
        }
        // Sanity: expected dispatchable tools must still be present
        for must in ["office_create_document", "web_search", "memory_search"] {
            assert!(
                defs.iter().any(|d| d.name == must),
                "merged_definitions missing expected dispatchable tool {must:?}"
            );
        }
    }
}
