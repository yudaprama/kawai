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

#[path = "common/mod.rs"]
mod common;

fn main() {
    common::run_async("plan_loop_probe", run());
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    let goal = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "buatkan deck presentasi penjualan dari data analytics".to_string());

    let registry = common::build_stub_registry().await?;
    println!("[probe] registry: {} tools (invisible to the planner)", registry.len());

    let started = std::time::Instant::now();
    let (plan, usage) =
        kawai_lib::supervisor::plan_task("seed", 0, &goal, &registry, |_| {}).await?;
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
