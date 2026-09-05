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
//! Toolset composition lives in `catalog_composition.rs` (shared with
//! `tool_catalog_drift_check.rs` — exactly one copy).
//!
//! Requires:
//!   --features litert,binance,codegraph
//!                            (the domain tool builders are feature-gated;
//!                             every feature that the runtime registry can
//!                             include MUST be on here, or its tools silently
//!                             drop out of the catalog)
//!   KAWAI_TURSO_DB_URL       (from .env; env overrides the baked read-only
//!                             constants — only needed if the DB differs)
//!   KAWAI_TURSO_WRITE_TOKEN  (full-access token — NEVER baked; generate with
//!                             `turso db tokens create kawai-tool-catalog`)
//!
//! Usage:
//!   KAWAI_TURSO_WRITE_TOKEN=$(turso db tokens create kawai-tool-catalog) \
//!     cargo run --example seed_tool_catalog --features litert,binance,codegraph -- --prune

#[path = "catalog_composition.rs"]
mod composition;

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
    use kawai_tool_catalog::RemoteConfig;

    let prune = std::env::args().any(|a| a == "--prune");

    let url = std::env::var("KAWAI_TURSO_DB_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            let baked = kawai_constants::turso::get_db_url();
            (!baked.trim().is_empty()).then_some(baked)
        })
        .ok_or("KAWAI_TURSO_DB_URL not set and no baked constant")?;
    let write_token = std::env::var("KAWAI_TURSO_WRITE_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or("KAWAI_TURSO_WRITE_TOKEN not set — generate a full-access token:\n  turso db tokens create kawai-tool-catalog")?;

    let definitions = composition::merged_definitions().await?;
    let names: Vec<String> = definitions.iter().map(|d| d.name.clone()).collect();
    println!(
        "[seed] merged catalog: {} tools (remote LLM configured: {}, prune: {prune})",
        names.len(),
        remote_llm::RemoteLlm::from_env().is_some()
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
                    kind: composition::catalog_kind(&def.name).to_string(),
                    name: def.name,
                    description: def.description,
                    input_schema: def.parameters.to_string(),
                },
                embedding,
            )
        })
        .collect();

    let cfg = RemoteConfig { url, auth_token: write_token };
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
