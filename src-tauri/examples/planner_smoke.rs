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

// ── --plan-only mode ─────────────────────────────────────────────────────
// Cloud-only planner quality check: NO on-device model, NO agent loop.
// Streams PLAN_SYSTEM completions from the remote pool for a few multi-step
// tasks and validates each plan with the production parser
// (extract_plan_steps) against the binance tool catalog. Scores what a local
// machine can measure cheaply: parse-validity, tool accuracy, step counts,
// latency. Execution quality stays with the full-loop smoke / real usage.

const PLAN_TASKS: [&str; 3] = [
    "Pull 30 days of daily klines for BTCUSDT and ETHUSDT, compare their volatility over that \
     window, then deliver a thorough comparative report with sections.",
    "Fetch the current average prices of BTCUSDT and ETHUSDT, then write a short advisory note \
     for a first-time buyer comparing the two assets.",
    "Analyze 14 days of hourly klines for SOLUSDT: compute trend and momentum, then draft an \
     executive summary a portfolio manager can read in one minute.",
];

const BINANCE_TOOLS: [&str; 8] = [
    "binance_klines",
    "binance_ticker",
    "binance_ta_analyze",
    "binance_trades",
    "binance_depth",
    "binance_exchange_info",
    "artifact_recall",
    "deep_write",
];

async fn plan_only_mode() {
    use kawai_agent::subagents::PLAN_SYSTEM;
    use kawai_lib::logic::remote::RemoteLlm;

    let Some(remote) = RemoteLlm::from_env() else {
        eprintln!("[plan-only] remote pool unavailable (no vault keys) — nothing to test.");
        std::process::exit(1);
    };
    let tools: Vec<String> = BINANCE_TOOLS.iter().map(|s| s.to_string()).collect();
    // Mirror the production loop: the planner MUST see the executing agent's
    // tool catalog, else it invents plausible tool names (observed: with an
    // empty package zai produced "get_klines"/"fetch_klines").
    let materials = format!(
        "[tools available to the executing assistant]\n{}",
        BINANCE_TOOLS
            .iter()
            .map(|t| format!("- {t}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let mut pass = 0usize;
    for (i, task) in PLAN_TASKS.iter().enumerate() {
        print!("\n── task {} — {}… ", i + 1, &task[..48]);
        let started = std::time::Instant::now();
        let mut raw = String::new();
        let mut provider = String::new();
        match remote.stream(PLAN_SYSTEM, task, &materials).await {
            Ok(s) => {
                let mut s = Box::pin(s);
                while let Some(item) = s.next().await {
                    match item {
                        Ok(remote_llm::RemoteEvent::Token { text }) => {
                            raw.push_str(&text);
                        }
                        Ok(remote_llm::RemoteEvent::Done { provider: p, .. }) => {
                            provider = p;
                        }
                        Ok(_) => {}
                        Err(e) => {
                            println!("STREAM ERROR: {e}");
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                println!("POOL ERROR: {e}");
            }
        }
        let latency = started.elapsed().as_secs_f32();
        match kawai_agent::subagents::extract_plan_steps(raw.trim(), &tools) {
            Ok(steps) => {
                pass += 1;
                println!("VALID via {provider} in {latency:.1}s — {} steps", steps.len());
                for (n, s) in steps.iter().enumerate() {
                    println!(
                        "   {}. [{:>18}] {}",
                        n + 1,
                        s.tool.as_deref().unwrap_or("(reason)"),
                        &s.goal[..s.goal.len().min(80)]
                    );
                }
            }
            Err(e) => {
                println!("INVALID via {provider} in {latency:.1}s — {e}");
                println!("   raw head: {}", &raw.chars().take(160).collect::<String>());
            }
        }
    }
    println!(
        "\nPLAN-ONLY: {pass}/{} plans valid — this checks plan QUALITY, not execution \
         (full-loop smoke / real usage covers that).",
        PLAN_TASKS.len()
    );
    if pass < PLAN_TASKS.len() {
        std::process::exit(1);
    }
}


#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    if std::env::args().any(|a| a == "--plan-only") {
        plan_only_mode().await;
        return;
    }
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
