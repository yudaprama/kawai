//! CI drift gate: the remote Turso tool catalog must contain EXACTLY the
//! supervisor's merged toolset (same composition the planner's `auto` mode
//! validates against). Fails when the catalog is missing a tool (planner can
//! never discover it) or carries an extra/stale one (planner emits steps that
//! fail plan validation).
//!
//! Read-only end to end: credentials resolve via `RemoteConfig::from_env()` —
//! env override first, then the baked read-only constants in
//! `kawai-vault/constants` — so no CI secret is needed.
//!
//! Toolset composition lives in `catalog_composition.rs` (shared with
//! `seed_tool_catalog.rs` — exactly one copy).
//!
//! Usage:
//!   cargo run --example tool_catalog_drift_check --features litert,binance,codegraph

#[path = "catalog_composition.rs"]
mod composition;

fn main() {
    kawai_lib::auth::load_dotenv();

    #[cfg(feature = "litert")]
    {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(run()) {
            eprintln!("[drift_check] FAIL: {e}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[drift_check] FAIL: rebuild with --features litert (domain tool builders are litert-gated)");
        std::process::exit(1);
    }
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    let cfg = kawai_tool_catalog::RemoteConfig::from_env()
        .ok_or("tool catalog config unresolvable (no KAWAI_TURSO_* env and no baked constants)")?;
    let catalog = kawai_tool_catalog::Catalog::open_default(&cfg).await?;
    match catalog.sync().await {
        Ok(n) => println!("[drift_check] sync: {n} frames"),
        Err(e) => return Err(format!("catalog unreachable — cannot verify drift: {e}")),
    }

    let local: Vec<String> = composition::merged_definitions()
        .await?
        .iter()
        .map(|d| d.name.clone())
        .collect();
    let mut local_sorted = local.clone();
    local_sorted.sort();

    let remote = catalog.list_names().await?;

    let missing: Vec<&String> = local_sorted
        .iter()
        .filter(|n| !remote.contains(*n))
        .collect();
    let stale: Vec<&String> = remote.iter().filter(|n| !local.contains(*n)).collect();

    println!(
        "[drift_check] local merged toolset: {} tools; remote catalog: {} tools",
        local.len(),
        remote.len()
    );
    if !missing.is_empty() {
        eprintln!("[drift_check] MISSING from catalog (re-seed): {missing:?}");
    }
    if !stale.is_empty() {
        eprintln!("[drift_check] STALE in catalog (re-seed with --prune): {stale:?}");
    }
    if missing.is_empty() && stale.is_empty() {
        println!("[drift_check] OK — catalog covers the merged toolset exactly");
        return Ok(());
    }
    Err(format!(
        "tool catalog drifted: {} missing, {} stale. Fix:\n  KAWAI_TURSO_WRITE_TOKEN=$(turso db tokens create kawai-tool-catalog) \\\n    cargo run --example seed_tool_catalog --features litert,binance,codegraph -- --prune",
        missing.len(),
        stale.len()
    ))
}
