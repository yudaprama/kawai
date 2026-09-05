//! Seed the remote Turso tool catalog with the supervisor's merged tool
//! definitions (same composition the planner sees in `auto` mode).
//!
//! Idempotent and incremental: re-running with a wider feature set adds the
//! missing tools; existing rows are upserted in place. Pass `--prune` to also
//! delete rows that are no longer part of the merged toolset (renames,
//! removed tools, RPC-only entries).
//!
//! Embeddings use the same `build_providers_from_env()` chain the app uses
//! at plan time, so writer and reader share one vector space on this machine.
//!
//! Requires:
//!   --features litert,binance,codegraph
//!                            (the domain tool builders are feature-gated;
//!                             every feature that the runtime registry can
//!                             include MUST be on here, or its tools silently
//!                             drop out of the catalog)
//!   KAWAI_TURSO_DB_URL       (from .env)
//!   KAWAI_TURSO_WRITE_TOKEN  (full-access token — NOT the client's
//!                             read-only one; generate with
//!                             `turso db tokens create kawai-tool-catalog`)
//!
//! A stub SQL profile is always injected so `data_tables`/`data_import`
//! register in the catalog (the analytics SQL tools only join the toolset
//! when `sql_profiles` is non-empty; the stub is never called at seed time —
//! the runtime bakes each user's real profiles per turn).
//!
//! Usage:
//!   KAWAI_TURSO_WRITE_TOKEN=$(turso db tokens create kawai-tool-catalog) \
//!     cargo run --example seed_tool_catalog --features litert,binance,codegraph -- --prune

fn main() {
    kawai_lib::auth::load_dotenv();

    #[cfg(feature = "litert")]
    {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(run()) {
            eprintln!("[seed_tool_catalog] FAIL: {e}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[seed_tool_catalog] FAIL: rebuild with --features litert (domain tool builders are litert-gated)");
        std::process::exit(1);
    }
}

#[cfg(feature = "litert")]
const RPC_ONLY_TOOLS: &[&str] = &[
    // GraphRAG tools are RPC-only (commands.rs/web.rs) — never dispatched by
    // the supervisor, so they must not appear in the planner's catalog.
    "graph_search",
    "graph_list",
];

#[cfg(feature = "litert")]
const SUBAGENT_TOOLS: &[&str] = &["deep_write", "draft_document", "plan_task", "plan_revise"];

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    let prune = std::env::args().any(|a| a == "--prune");

    let url = std::env::var("KAWAI_TURSO_DB_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or("KAWAI_TURSO_DB_URL not set (is .env loaded?)")?;
    let write_token = std::env::var("KAWAI_TURSO_WRITE_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or("KAWAI_TURSO_WRITE_TOKEN not set — generate a full-access token:\n  turso db tokens create kawai-tool-catalog")?;

    // Same composition root as the planner's `auto` catalog: office first,
    // then the specialists fill in their exclusive tools (first-wins).
    let remote_configured = remote_llm::RemoteLlm::from_env().is_some();
    // Stub profile so the analytics SQL snapshot tools (data_tables,
    // data_import) register — see module docs. Never invoked at seed time.
    let mut sql_profiles = kawai_analytics::effective_profiles("seed").await;
    sql_profiles.push(kawai_agent_contract::SqlProfile {
        name: "seed-stub".into(),
        source: "postgres://seed-stub.invalid/db".into(),
    });
    let context = kawai_agent_contract::AgentContext {
        user_id: "seed",
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
            kawai_lib::agent_registry::presentation_tools_for_supervisor(&context, remote_configured),
        ),
        (
            "binance",
            kawai_lib::agent_registry::binance_tools_for_supervisor(&context, remote_configured),
        ),
        (
            "analytics",
            kawai_lib::agent_registry::analytics_tools_for_supervisor(&context, remote_configured),
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
    let mut definitions: Vec<kawai_tools::ToolDefinition> =
        toolset.get_tool_definitions().to_vec();

    // RPC-only tools ride some builders' toolsets but can never be dispatched
    // by the supervisor — keep them out of the planner's search space.
    let before = definitions.len();
    definitions.retain(|d| !RPC_ONLY_TOOLS.contains(&d.name.as_str()));
    if definitions.len() != before {
        println!(
            "[seed] excluded {} RPC-only tool(s): {:?}",
            before - definitions.len(),
            RPC_ONLY_TOOLS
        );
    }

    let names: Vec<String> = definitions.iter().map(|d| d.name.clone()).collect();
    println!(
        "[seed] merged catalog: {} tools (remote LLM configured: {remote_configured}, prune: {prune})",
        names.len()
    );

    // Embed name + description with the app's provider chain so the seeded
    // vector space matches what plan-time narrowing queries against.
    let model = kawai_embedding::build_providers_from_env();
    let texts: Vec<String> = definitions
        .iter()
        .map(|d| format!("{}: {}", d.name, d.description))
        .collect();
    println!("[seed] embedding {} tools…", texts.len());
    let embeddings = model
        .embed_strings(texts)
        .await
        .map_err(|e| format!("embed: {e}"))?;
    if embeddings.len() != definitions.len() {
        return Err(format!(
            "embed count mismatch: {} embeddings for {} tools",
            embeddings.len(),
            definitions.len()
        ));
    }
    let dims = embeddings.first().map(|v| v.len()).unwrap_or(0);
    println!("[seed] embedding dimension: {dims}");

    let entries: Vec<(kawai_tool_catalog::CatalogTool, Vec<f64>)> = definitions
        .into_iter()
        .zip(embeddings)
        .map(|(def, embedding)| {
            let kind = if SUBAGENT_TOOLS.contains(&def.name.as_str()) {
                "subagent"
            } else {
                "pure"
            };
            (
                kawai_tool_catalog::CatalogTool {
                    name: def.name,
                    description: def.description,
                    input_schema: def.parameters.to_string(),
                    kind: kind.to_string(),
                },
                embedding,
            )
        })
        .collect();

    let cfg = kawai_tool_catalog::RemoteConfig { url, auth_token: write_token };
    let catalog = kawai_tool_catalog::Catalog::open_default(&cfg).await?;
    let synced = catalog.sync().await.unwrap_or(0);
    println!("[seed] replica sync: {synced} frames applied");

    catalog.upsert_tools(&entries).await?;
    println!("[seed] upserted {} tools", entries.len());

    if prune {
        let deleted = catalog.prune_tools(&names).await?;
        println!("[seed] pruned {deleted} stale row(s)");
    } else {
        println!("[seed] prune skipped (pass -- --prune to delete rows no longer in the merged toolset)");
    }

    println!(
        "[seed] DONE. Verify on the remote:\n  turso db shell kawai-tool-catalog \"SELECT COUNT(*) FROM tool_catalog\""
    );
    Ok(())
}
