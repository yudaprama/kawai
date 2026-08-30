// Headless smoke for the supervisor planner: cloud-only planner quality
// check. NO on-device model, NO execution — streams one plan completion from
// the remote pool per multi-step task via the production supervisor path
// (`build_supervisor_registry` + `plan_task`) and validates the returned
// TaskPlan structurally (non-empty steps, tool names, done criteria).
//
// Usage (mirrors the other smokes' env recipe):
//   cd src-tauri && env \
//     LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
//     LLVM_PROFILE_FILE=/dev/null \
//     KAWAI_DATA_DIR=/tmp/kawai-planner-smoke \
//     KAWAI_BINANCE_REST_BASE=https://data-api.binance.vision \
//     cargo run --example planner_smoke --features litert,binance

use kawai_lib::agent_registry::{BINANCE_AGENT_ID, OFFICE_AGENT_ID};

const PLAN_TASKS: [(&str, &str); 3] = [
    (
        BINANCE_AGENT_ID,
        "Pull 30 days of daily klines for BTCUSDT and ETHUSDT, compare their volatility over that \
         window, then deliver a thorough comparative report with sections.",
    ),
    (
        BINANCE_AGENT_ID,
        "Fetch the current average prices of BTCUSDT and ETHUSDT, then write a short advisory note \
         for a first-time buyer comparing the two assets.",
    ),
    (
        OFFICE_AGENT_ID,
        "Create a quarterly report document summarizing last quarter's revenue growth, then export \
         it as a PDF.",
    ),
];

#[tokio::main]
async fn main() {
    let user = "smoke-planner";
    let session = kawai_lib::logic::db::create_chat_session(user, Some(BINANCE_AGENT_ID))
        .await
        .expect("create smoke session");

    let mut failures = 0usize;
    for (agent_id, goal) in PLAN_TASKS {
        println!("\n[plan] agent={agent_id} goal={goal}");
        let started = std::time::Instant::now();
        let registry = match kawai_lib::supervisor::build_supervisor_registry(
            user,
            session.id,
            agent_id,
            true,
        )
        .await
        {
            Some(r) => r,
            None => {
                eprintln!("[FAIL] registry unavailable for {agent_id}");
                failures += 1;
                continue;
            }
        };
        match kawai_lib::supervisor::plan_task(goal, &registry).await {
            Ok(plan) => {
                let tools: Vec<&str> =
                    plan.steps.iter().map(|s| s.dispatch_key()).collect();
                let ok_shape = plan
                    .steps
                    .iter()
                    .all(|s| !s.task.is_empty());
                println!(
                    "[ok] {} step(s) in {:?}: {tools:?} shape_ok={ok_shape}",
                    plan.steps.len(),
                    started.elapsed()
                );
                if plan.steps.is_empty() || !ok_shape {
                    failures += 1;
                }
            }
            Err(e) => {
                eprintln!("[FAIL] plan_task: {e}");
                failures += 1;
            }
        }
    }

    if failures > 0 {
        eprintln!("\n[planner_smoke] {failures} task(s) failed");
        std::process::exit(1);
    }
    println!("\n[planner_smoke] all tasks produced valid plans");
}
