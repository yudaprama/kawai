//! E2E probe for the search-loop planner (`plan_task`, mode A): runs the
//! real loop — LLM searches the shared tool catalog across bounded rounds,
//! then emits a plan validated against the full registry. Prints each round
//! implicitly via the final plan + usage.
//!
//! Fidelity rules (both were violated before, and both produced false
//! failures):
//!   1. The registry is built from `catalog_composition::merged_definitions`
//!      — the SAME composition the app dispatches against and the seeder
//!      writes. `common::build_stub_registry` merges only four domains, which
//!      made every other domain's tools invisible to the planner here.
//!   2. A `TaskPlan.template` (deterministic template router, zero planner
//!      rounds) dispatches against the pipeline's own registry, so its steps
//!      are NOT asserted against this one.
//!
//! Requires: --features litert, remote LLM configured, catalog seeded
//! (`--example seed_tool_catalog`).
//!
//! Usage:
//!   cargo run --example plan_loop_probe --features litert -- "goal optional"

#[path = "common/mod.rs"]
mod common;
#[path = "catalog_composition.rs"]
mod composition;

fn main() {
    common::run_async("plan_loop_probe", run());
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    // Read the SAME catalog replica the desktop app reads (tauri app data
    // dir), not the headless /tmp default — otherwise this probe searches a
    // never-seeded replica and "proves" a problem the app does not have.
    if let Some(dir) = kawai_paths::tauri_app_data_dir(kawai_paths::APP_IDENTIFIER) {
        kawai_paths::set_data_root(dir);
    }
    let goal = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "buatkan deck presentasi penjualan dari data analytics".to_string());

    let definitions = composition::merged_definitions().await?;
    let registry = stub_registry(&definitions);
    println!(
        "[probe] registry: {} tools (invisible to the planner, app composition)",
        registry.len()
    );

    let started = std::time::Instant::now();
    let (plan, usage) = kawai_lib::supervisor::plan_task(
        "seed",
        0,
        &goal,
        None, // dev probe — no billing identity, so the balance gate is off
        None, // template-path language: probe goals are planner cases
        &registry,
        |event| {
            // Diagnostic: what each planning search round found — separates
            // "planner never saw the tool" from "saw it and chose something
            // else".
            if let kawai_events::SupervisorEvent::PlanningToolSearch { queries, tools } = &event {
                println!("[probe] search {queries:?} -> {tools:?}");
            }
        },
    )
    .await?;
    let elapsed = started.elapsed();

    println!("\n[probe] GOAL: {goal}");

    if let Some(template) = plan.template.as_deref() {
        println!(
            "[probe] TEMPLATE PATH ({template}) — authored by the deterministic router, zero \
             planner rounds; its steps dispatch against the pipeline registry, so no catalog \
             assertion applies"
        );
        return Ok(());
    }

    println!(
        "[probe] plan: {} steps in {:.1}s ({} in / {} out tokens)",
        plan.steps.len(),
        elapsed.as_secs_f32(),
        usage.input_tokens,
        usage.output_tokens
    );

    for step in &plan.steps {
        println!(
            "  [{}] tool={} depends_on={:?} arguments={} task={}",
            step.id,
            step.dispatch_key(),
            step.depends_on,
            serde_json::to_string(&step.arguments).unwrap_or_default(),
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

/// Registry with a stub dispatch: the planner only reads names, descriptions
/// and schemas, so nothing executes in this probe. Infallible by construction.
#[cfg(feature = "litert")]
fn stub_registry(definitions: &[kawai_tools::ToolDefinition]) -> kawai_router::ToolRegistry {
    use kawai_router::{ToolCall, ToolDispatch, ToolKind, ToolMeta, ToolRegistry};

    let dispatch: ToolDispatch = std::sync::Arc::new(|_call: ToolCall| {
        Box::pin(async move {
            Err(kawai_router::RouterError::UnknownTool(String::new(), String::new()))
        })
    });
    let mut registry = ToolRegistry::new(dispatch);
    for def in definitions {
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
    registry
}