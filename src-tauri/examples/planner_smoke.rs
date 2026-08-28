// Headless smoke for the planner subagent (PLAN-planner-subagent.md): a
// multi-step task through the production agent_chat loop, watching for
// plan_task engagement, the plan receipt, plan_revise, and the synthesis
// close. Planning is MODEL-CHOSEN (persona rule) — engagement is reported,
// never hard-asserted; the smoke fails only if the turn itself fails.
//
// Usage (mirrors agent_smoke's env recipe):
//   cd src-tauri && env \
//     RUSTFLAGS="-C link-arg=-Wl,-rpath,<ABS>/cognee-litert-lm/native" \
//     LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
//     LLVM_PROFILE_FILE=/dev/null \
//     KAWAI_DATA_DIR=/tmp/kawai-planner-smoke \
//     KAWAI_BINANCE_REST_BASE=https://data-api.binance.vision \
//     cargo run --example planner_smoke --features litert,binance
use futures_util::StreamExt;
use kawai_lib::logic::agent::{agent_chat_with_registry, AgentChatEvent};
use kawai_lib::logic::{db, local_llm};

const SMOKE_USER: &str = "smoke-planner";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    std::env::set_var("KAWAI_DATA_DIR", "/tmp/kawai-planner-smoke");

    let model = kawai_lib::logic::resolve_model_path().expect("model path");
    println!("loading {model}…");
    let info = local_llm::load_model(SMOKE_USER, &model, false, false, 0, None)
        .await
        .expect("load_model");
    println!("loaded: {} [{}]\n", info.model_path, info.backend);

    println!("── binance agent · multi-step turn (watch for plan_task) ──");
    let mut saw_plan = false;
    let mut saw_revise = false;
    let mut saw_thinking = false;
    let mut saw_close = false;
    let mut plan_receipt = String::new();
    let mut errored = false;
    let mut events: Vec<String> = Vec::new();
    let mut stream = Box::pin(agent_chat_with_registry(
        kawai_lib::agent_registry::builtin(),
        SMOKE_USER.into(),
        "builtin.binance".into(),
        None,
        "Pull 30 days of daily klines for BTCUSDT and ETHUSDT, compare their volatility over \
         that window, then deliver a thorough comparative report with sections."
            .into(),
        Vec::new(),
    ));
    while let Some(ev) = stream.next().await {
        match ev {
            AgentChatEvent::ToolCall { tool, .. } => {
                if tool == "plan_task" {
                    saw_plan = true;
                }
                if tool == "plan_revise" {
                    saw_revise = true;
                }
                if tool == "deep_write" {
                    saw_close = true;
                }
                events.push(format!("tool_call {tool}"));
            }
            AgentChatEvent::SubagentThinking { provider, text } => {
                saw_thinking = true;
                events.push(format!("subagent_thinking {provider} +{} chars", text.chars().count()));
            }
            AgentChatEvent::ToolResult { tool, ok, summary, .. } => {
                if tool == "plan_task" && ok {
                    plan_receipt = summary;
                }
                events.push(format!("tool_result {tool} ok={ok}"));
            }
            AgentChatEvent::Error { message } => {
                errored = true;
                events.push(format!("ERROR: {message}"));
            }
            AgentChatEvent::Finished => events.push("finished".into()),
            _ => {}
        }
    }

    let mut pass = true;
    println!("  plan_task called:      {saw_plan}");
    println!("  plan_revise called:    {saw_revise}");
    println!("  subagent thinking:     {saw_thinking}");
    println!("  closed via deep_write: {saw_close}");
    println!("  turn errored:          {errored}");
    if saw_plan {
        println!("  plan receipt: {plan_receipt}");
    }
    for e in &events {
        println!("  [{e}]");
    }
    pass &= !errored;
    println!(
        "\n{}",
        if pass {
            "PLANNER SMOKE: turn completed (engagement = informational, see above)"
        } else {
            "PLANNER SMOKE: TURN FAILED"
        }
    );

    println!("── turn_log rows from this smoke ──");
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        - 3600;
    let rows = db::list_turn_log(SMOKE_USER, since).await.unwrap_or_default();
    for r in rows {
        println!(
            "  {} / {} · {} {} · {:?}ms",
            r.agent_id,
            r.provider,
            r.tool.as_deref().unwrap_or("-"),
            r.outcome,
            r.latency_ms
        );
    }
    if !pass {
        std::process::exit(1);
    }
}
