//! Seed the remote Turso tool catalog with the supervisor's merged tool
//! definitions (same composition the planner sees in `auto` mode).
//!
//! Idempotent and incremental: re-running with a wider feature set adds the
//! missing tools; existing rows are upserted in place. Description enrichment
//! is a future pass — the tool's own description is seeded as-is.
//!
//! Embeddings use the same `build_providers_from_env()` chain the app uses
//! at plan time, so writer and reader share one vector space on this machine.
//!
//! Requires:
//!   --features litert        (the domain tool builders are litert-gated)
//!   KAWAI_TURSO_DB_URL       (from .env)
//!   KAWAI_TURSO_WRITE_TOKEN  (full-access token — NOT the client's
//!                             read-only one; generate with
//!                             `turso db tokens create kawai-tool-catalog`)
//!
//! Usage:
//!   KAWAI_TURSO_WRITE_TOKEN=$(turso db tokens create kawai-tool-catalog) \
//!     cargo run --example seed_tool_catalog --features litert

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
async fn run() -> Result<(), String> {
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
    let sql_profiles = kawai_analytics::effective_profiles("seed").await;
    let context = kawai_agent_contract::AgentContext {
        user_id: "seed",
        session_id: 0,
        sql_profiles: Some(sql_profiles.as_slice()),
    };

    let mut merged: Option<kawai_tools::ToolSet> = None;
    for set in [
        kawai_lib::agent_registry::office_tools(&context, remote_configured),
        kawai_lib::agent_registry::presentation_tools_for_supervisor(&context, remote_configured),
        kawai_lib::agent_registry::binance_tools_for_supervisor(&context, remote_configured),
        kawai_lib::agent_registry::analytics_tools_for_supervisor(&context, remote_configured),
    ]
    .into_iter()
    .flatten()
    {
        match &mut merged {
            Some(base) => base.merge(&mut { set }),
            None => merged = Some(set),
        }
    }
    let toolset = merged.ok_or("no domain toolset could be built (check env/vault)")?;
    let definitions = toolset.get_tool_definitions().to_vec();
    println!(
        "[seed] merged catalog: {} tools (remote LLM configured: {remote_configured})",
        definitions.len()
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
            (
                kawai_tool_catalog::CatalogTool {
                    name: def.name,
                    description: def.description,
                    input_schema: def.parameters.to_string(),
                    kind: "pure".to_string(),
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
    println!("[seed] DONE: upserted {} tools. Verify on the remote:\n  turso db shell kawai-tool-catalog \"SELECT COUNT(*) FROM tool_catalog\"", entries.len());
    Ok(())
}
