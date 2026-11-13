//! Shared helpers for examples: common `main()` boilerplate and toolset
//! construction. Eliminates the copy-paste `load_dotenv` + cfg gate + runtime
//! setup across every example binary.

/// Run an async example with standard setup (load_dotenv + tokio runtime).
/// Prints the error and exits with code 1 on failure.
pub fn run_async(name: &str, f: impl std::future::Future<Output = Result<(), String>>) {
    kawai_lib::auth::load_dotenv();
    init_tracing();

    #[cfg(feature = "litert")]
    {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(f) {
            eprintln!("[{name}] FAIL: {e}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[{name}] FAIL: rebuild with --features litert");
        std::process::exit(1);
    }
}

/// Opt-in `tracing` subscriber for examples (`KAWAI_EXAMPLE_LOG=1`).
///
/// The interesting half of an example is usually a `tracing` event, not the
/// stdout summary: the catalog sync gate logs why it skipped a sync, the
/// supervisor logs a stale replica, the remote tier logs a failover. Without a
/// subscriber all of it is dropped and a headless probe looks like the code
/// never ran. Off by default because the JSON app subscriber writes to stdout
/// (it would interleave with what the example prints) and because `RUST_LOG`
/// is only meaningful once something consumes it.
pub fn init_tracing() {
    if std::env::var("KAWAI_EXAMPLE_LOG").as_deref() != Ok("1") {
        return;
    }
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(true)
        .with_ansi(false)
        .try_init();
}

/// Build a merged supervisor toolset from the standard domain builders
/// (office, presentation, binance, analytics) with a stub SQL profile.
/// Returns the toolset definitions.
#[cfg(feature = "litert")]
pub async fn build_merged_definitions() -> Result<Vec<kawai_tools::ToolDefinition>, String> {
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
    Ok(toolset.get_tool_definitions().to_vec())
}

/// Build a merged supervisor toolset and convert it into a `ToolRegistry`
/// with a stub dispatch (all tools register as `Pure`, none actually execute).
#[cfg(feature = "litert")]
pub async fn build_stub_registry() -> Result<kawai_router::ToolRegistry, String> {
    use kawai_router::{ToolCall, ToolDispatch, ToolKind, ToolMeta, ToolRegistry};

    let definitions = build_merged_definitions().await?;
    let dispatch: ToolDispatch = std::sync::Arc::new(|_call: ToolCall| {
        Box::pin(async move {
            Err(kawai_router::RouterError::UnknownTool(String::new(), String::new()))
        })
    });
    let mut registry = ToolRegistry::new(dispatch);
    for def in &definitions {
        registry.register(ToolMeta {
            name: def.name.clone(),
            kind: ToolKind::Pure,
            description: def.description.clone(),
            input_schema: def.parameters.clone(),
            output_schema: serde_json::json!({}),
            produces: vec![],
            requires_confirmation: false,
        });
    }
    Ok(registry)
}
