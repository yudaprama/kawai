//! End-to-end check of the planner prompt narrowing against the live Turso
//! tool catalog (`narrow_registry_for_goal_with`).
//!
//! Verifies the three contracts without needing a >60-tool install:
//!   1. Narrowing activates below the production threshold when driven
//!      directly (parametrized `min_tools`).
//!   2. The narrowed set is a strict subset of the dispatchable registry,
//!      and a tool outside the narrowed set remains dispatchable in the
//!      full registry (narrowing is advisory-only).
//!   3. An unreachable remote errors at the catalog layer — the same
//!      failure the supervisor's `ok()?` chain converts into a full-catalog
//!      fallback.
//!
//! Requires `--features litert` and a seeded catalog (see
//! `seed_tool_catalog.rs`). Read-only — uses the client env (`.env`).
//!
//! Usage:
//!   cargo run --example tool_catalog_narrow_check --features litert

fn main() {
    kawai_lib::auth::load_dotenv();

    #[cfg(feature = "litert")]
    {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(run()) {
            eprintln!("[narrow_check] FAIL: {e}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[narrow_check] FAIL: rebuild with --features litert");
        std::process::exit(1);
    }
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    use kawai_router::{ToolCall, ToolDispatch, ToolKind, ToolMeta, ToolRegistry};

    // The same merged `auto` toolset the planner uses (32 tools today —
    // below the production threshold of 60, hence the parametrized call).
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
    let toolset = merged.ok_or("no domain toolset could be built")?;
    let definitions = toolset.get_tool_definitions().to_vec();

    // Stub dispatch: narrowing never executes anything; only the catalog
    // metadata matters here.
    let dispatch: ToolDispatch = std::sync::Arc::new(|_call: ToolCall| {
        Box::pin(async move { Err(kawai_router::RouterError::UnknownTool(String::new(), String::new())) })
    });
    let mut registry = ToolRegistry::new(dispatch);
    for def in &definitions {
        registry.register(ToolMeta {
            name: def.name.clone(),
            kind: ToolKind::Pure,
            description: def.description.clone(),
            input_schema: def.parameters.clone(),
            output_schema: serde_json::json!({}),
            requires_confirmation: false,
        });
    }
    let full_len = registry.len();
    println!("[narrow_check] full registry: {full_len} tools");

    if kawai_tool_catalog::RemoteConfig::from_env().is_none() {
        return Err("KAWAI_TURSO_* not configured in .env — nothing to check".to_string());
    }

    // ── Contract 1: narrowing activates (parametrized) and returns ≤ top_k.
    const MIN_TOOLS: usize = 10;
    const TOP_K: usize = 10;
    let goal = "buatkan deck presentasi penjualan dari data analytics";
    // Diagnose the chain explicitly first (the supervisor's version swallows
    // errors by design): open → sync → search.
    {
        let cfg = kawai_tool_catalog::RemoteConfig::from_env()
            .ok_or("KAWAI_TURSO_* missing")?;
        let model = kawai_embedding::build_providers_from_env();
        let qvec = model
            .embed_strings(vec![goal.to_string()])
            .await
            .map_err(|e| format!("embed: {e}"))?
            .into_iter()
            .next()
            .ok_or("embed: empty")?;
        println!("[narrow_check] query embedding dim: {}", qvec.len());
        let catalog = kawai_tool_catalog::Catalog::open_default(&cfg).await?;
        match catalog.sync().await {
            Ok(n) => println!("[narrow_check] sync: {n} frames"),
            Err(e) => println!("[narrow_check] sync (best-effort) failed: {e}"),
        }
        match catalog.search(goal, &qvec, TOP_K).await {
            Ok(hits) => println!("[narrow_check] search: {} hits", hits.len()),
            Err(e) => return Err(format!("search failed: {e}")),
        }
    }
    let mut narrowed = None;
    for attempt in 1..=3 {
        match kawai_lib::supervisor::narrow_registry_for_goal_with(
            &registry,
            goal,
            MIN_TOOLS,
            TOP_K,
        )
        .await
        {
            Some(n) => {
                narrowed = Some(n);
                break;
            }
            None if attempt < 3 => {
                println!(
                    "[narrow_check] attempt {attempt} degraded (remote embedder flake) — retrying"
                );
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            }
            None => break,
        }
    }
    let narrowed =
        narrowed.ok_or("narrowing returned None after retries — expected Some with min_tools=10")?;
    let narrow_len = narrowed.len();
    println!("[narrow_check] narrowed registry: {narrow_len} tools (≤ {TOP_K})");
    if narrow_len == 0 || narrow_len > TOP_K {
        return Err(format!("narrowed size {narrow_len} outside (0, {TOP_K}]"));
    }

    // ── Contract 2: narrowed ⊆ dispatchable; excluded tools stay dispatchable.
    let mut subset_fail: Option<String> = None;
    for meta in narrowed.metas() {
        if registry.get(&meta.name).is_none() {
            subset_fail = Some(meta.name.clone());
        }
    }
    if let Some(name) = subset_fail {
        return Err(format!("narrowed registry contains non-dispatchable {name:?}"));
    }
    let excluded = definitions
        .iter()
        .map(|d| d.name.clone())
        .find(|name| narrowed.get(name).is_none())
        .ok_or("narrowing excluded nothing — cannot prove advisory-only")?;
    if registry.get(&excluded).is_none() {
        return Err(format!("excluded tool {excluded:?} missing from full registry"));
    }
    println!(
        "[narrow_check] advisory-only: {excluded:?} excluded from the prompt but still dispatchable in the full registry"
    );

    // Show what the narrowing picked for this goal (prompt-order preview).
    let picked: Vec<String> = definitions
        .iter()
        .filter(|d| narrowed.get(&d.name).is_some())
        .map(|d| d.name.clone())
        .collect();
    println!("[narrow_check] picked for goal {goal:?}: {picked:?}");

    // ── Contract 3: unreachable remote errors (supervisor falls back).
    let bad = kawai_tool_catalog::RemoteConfig {
        url: "libsql://does-not-exist.invalid".to_string(),
        auth_token: "invalid".to_string(),
    };
    // Offline can surface at either stage: `open` (DNS/TLS) or `search`
    // (connection refused mid-query). Both map to the same supervisor
    // fallback via its `ok()?` chain.
    match kawai_tool_catalog::Catalog::open_default(&bad).await {
        Err(e) => println!(
            "[narrow_check] offline path errors at open, as expected ({e}); supervisor falls back to the full catalog"
        ),
        Ok(catalog) => match catalog.search(goal, &vec![0.0; 1024], 5).await {
            Err(e) => println!(
                "[narrow_check] offline path errors at search, as expected ({e}); supervisor falls back to the full catalog"
            ),
            Ok(_) => return Err("expected an error against an unreachable remote".to_string()),
        },
    }

    println!("[narrow_check] DONE: all three narrowing contracts hold");
    Ok(())
}
