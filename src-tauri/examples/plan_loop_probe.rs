//! E2E probe for the search-loop planner (`plan_task`, mode A): runs the
//! real loop — LLM searches the Turso tool catalog across bounded rounds,
//! then emits a plan validated against the full registry. Prints each round
//! implicitly via the final plan + usage.
//!
//! Requires: --features litert, remote LLM configured, KAWAI_TURSO_* in .env
//! (katalog seeded via seed_tool_catalog).
//!
//! Usage:
//!   cargo run --example plan_loop_probe --features litert -- "goal optional"

fn main() {
    kawai_lib::auth::load_dotenv();

    #[cfg(feature = "litert")]
    {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(run()) {
            eprintln!("[plan_loop_probe] FAIL: {e}");
            std::process::exit(1);
        }
    }

    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[plan_loop_probe] FAIL: rebuild with --features litert");
        std::process::exit(1);
    }
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    use kawai_router::{ToolCall, ToolDispatch, ToolKind, ToolMeta, ToolRegistry};

    let goal = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "buatkan deck presentasi penjualan dari data analytics".to_string());

    // Same merged `auto` registry the real planner validates against.
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
    let dispatch: ToolDispatch = std::sync::Arc::new(|_call: ToolCall| {
        Box::pin(async move { Err(kawai_router::RouterError::UnknownTool(String::new(), String::new())) })
    });
    let mut registry = ToolRegistry::new(dispatch);
    for def in toolset.get_tool_definitions() {
        registry.register(ToolMeta {
            name: def.name.clone(),
            kind: ToolKind::Pure,
            description: def.description.clone(),
            input_schema: def.parameters.clone(),
            output_schema: serde_json::json!({}),
            requires_confirmation: false,
        });
    }
    println!("[probe] registry: {} tools (invisible to the planner)", registry.len());

    let started = std::time::Instant::now();
    let (plan, usage) = kawai_lib::supervisor::plan_task("seed", &goal, &registry).await?;
    let elapsed = started.elapsed();

    println!("\n[probe] GOAL: {goal}");
    println!(
        "[probe] plan: {} steps in {:.1}s ({} in / {} out tokens)",
        plan.steps.len(),
        elapsed.as_secs_f32(),
        usage.input_tokens,
        usage.output_tokens
    );
    for step in &plan.steps {
        println!(
            "  [{}] tool={} depends_on={:?} task={}",
            step.id,
            step.dispatch_key(),
            step.depends_on,
            step.task.chars().take(80).collect::<String>()
        );
    }

    // Sanity: every step's tool must exist in the (invisible) full registry —
    // validate_plan already ran inside plan_task, but assert it again here.
    for step in &plan.steps {
        if registry.get(step.dispatch_key()).is_none() {
            return Err(format!(
                "plan step {} used unknown tool {}",
                step.id,
                step.dispatch_key()
            ));
        }
    }
    println!("\n[probe] DONE: all steps dispatchable in the full registry");
    Ok(())
}
