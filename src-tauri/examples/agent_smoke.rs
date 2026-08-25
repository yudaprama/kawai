// Headless smoke test for the FULL hybrid turn: on-device model → fence
// decision → subagent interception → cloud stream → persist + turn_log.
// This is the production path end-to-end — remote_smoke/draft_smoke bypass
// the local model; this one exercises it.
//
// Usage (needs the LiteRT dylibs; mirrors the manual dev recipe):
//   cd src-tauri && env \
//     RUSTFLAGS="-C link-arg=-Wl,-rpath,<ABS>/cognee-litert-lm/native" \
//     LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
//     LLVM_PROFILE_FILE=/dev/null \
//     KAWAI_DATA_DIR=/tmp/kawai-agent-smoke \
//     cargo run --example agent_smoke --features litert,office
//
// Remote tier: zero-config cloud — keys are compiled into the vault, so
// delegation assertions run unconditionally. An empty vault is a broken
// environment and SHOULD fail loudly here.
use futures_util::StreamExt;
use kawai_lib::logic::agent::{agent_chat, AgentChatEvent};
use kawai_lib::logic::{db, local_llm};

const SMOKE_USER: &str = "smoke";

async fn run_turn(
    agent_id: &str,
    session_id: Option<i64>,
    message: &str,
) -> (Option<i64>, Vec<String>) {
    let mut saw_cloud_call = false;
    let mut cloud_summary = String::new();
    let mut answer_chars = 0usize;
    let mut events = Vec::new();
    let mut sid = session_id;
    let mut stream = Box::pin(agent_chat(
        SMOKE_USER.into(),
        agent_id.into(),
        session_id,
        message.into(),
        Vec::new(),
    ));
    while let Some(ev) = stream.next().await {
        match ev {
            AgentChatEvent::Started { session_id } => {
                sid = Some(session_id);
                events.push(format!("started session={session_id}"));
            }
            AgentChatEvent::Token { text } => {
                answer_chars += text.chars().count();
            }
            AgentChatEvent::Thinking { .. } => {
                // Local-model thinking deltas — not tracked by this smoke.
            }
            AgentChatEvent::ToolCall { tool, .. } => {
                if tool.starts_with("deep_write") || tool.starts_with("draft_document") {
                    saw_cloud_call = true;
                }
                events.push(format!("tool_call {tool}"));
            }
            AgentChatEvent::SubagentThinking { provider, text } => {
                events.push(format!(
                    "subagent_thinking {provider} +{} chars",
                    text.chars().count()
                ));
            }
            AgentChatEvent::ToolResult { tool, ok, summary } => {
                if saw_cloud_call && tool == "deep_write" {
                    cloud_summary = summary;
                }
                events.push(format!("tool_result {tool} ok={ok}"));
            }
            AgentChatEvent::Finished => events.push("finished".into()),
            AgentChatEvent::Error { message } => events.push(format!("ERROR: {message}")),
        }
    }
    println!("  answer: {answer_chars} chars · cloud_call={saw_cloud_call}");
    if !cloud_summary.is_empty() {
        println!("  cloud result: {cloud_summary}");
    }
    for e in &events {
        println!("  [{e}]");
    }
    (sid, events)
}

fn verdict(label: &str, pass: bool) -> bool {
    println!("  ⇒ {label}: {}\n", if pass { "PASS" } else { "FAIL" });
    pass
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    std::env::set_var("KAWAI_DATA_DIR", "/tmp/kawai-agent-smoke");

    // 1. Load the on-device model (the orchestrator under test).
    let model = kawai_lib::logic::resolve_model_path().expect("model path");
    println!("loading {model}…");
    let info = local_llm::load_model(SMOKE_USER, &model, false, false, 0, None)
        .await
        .expect("load_model");
    println!("loaded: {} [{}]\n", info.model_path, info.backend);

    let mut all_pass = true;

    // 2. LIGHT turn on the office agent — must stay local (no cloud call).
    println!("── office agent · LIGHT turn (expect local answer, no cloud) ──");
    let (sid, events) = run_turn(
        "builtin.office",
        None,
        "In one short sentence: what is 7 times 8?",
    )
    .await;
    let light_ok = events.iter().any(|e| e == "finished")
        && !events.iter().any(|e| e.starts_with("ERROR"))
        && !events.iter().any(|e| e.contains("deep_write"));
    all_pass &= verdict("light turn local", light_ok);

    // 3. HEAVY turn on the office agent — the under-delegation lens: the model
    //    SHOULD emit a deep_write fence here.
    println!("── office agent · HEAVY turn (expect deep_write delegation) ──");
    let (sid2, events2) = run_turn(
        "builtin.office",
        None,
        "Write a thorough comparative analysis of using SQLite versus PostgreSQL for a desktop-first \
         app that may later sync — structure it with sections, cover at least performance, \
         deployment, and sync story.",
    )
    .await;
    let _ = sid2;
    let heavy_ok =
        events2.iter().any(|e| e == "finished") && !events2.iter().any(|e| e.starts_with("ERROR"));
    let delegated = events2.iter().any(|e| e.contains("deep_write"));
    all_pass &= verdict("heavy turn completes", heavy_ok);
    all_pass &= verdict("heavy turn delegates to deep_write", delegated);

    // 4. Office agent heavy-with-file turn (draft_document path).
    println!("── office agent · DOCUMENT turn (expect draft_document) ──");
    let (_, events3) = run_turn(
        "builtin.office",
        None,
        "Create a docx named smoke-report.docx: a one-page project status update with sections \
         What Shipped (bullets), Risks (table), Next Steps (bullets).",
    )
    .await;
    let office_ok =
        events3.iter().any(|e| e == "finished") && !events3.iter().any(|e| e.starts_with("ERROR"));
    let drafted = events3.iter().any(|e| e.contains("draft_document"));
    all_pass &= verdict("office turn completes", office_ok);
    all_pass &= verdict("office turn uses draft_document", drafted);

    // 4b. Turn-memory e2e (binance): an oversized tool result must be STORED
    //     (not lossy-truncated) and the turn must CLOSE via deep_write from
    //     the full log. Exercises TurnMemory + artifact_recall registration +
    //     the cloud-close condition in one production turn.
    #[cfg(feature = "binance")]
    {
        println!("── binance agent · MEMORY turn (expect stored handle + deep_write close) ──");
        let (_, events4) = run_turn(
            "builtin.binance",
            None,
            "Pull the last 500 daily klines for BTCUSDT, then write a thorough trend analysis \
             report: structure, momentum, volatility, and what the candle data suggests.",
        )
        .await;
        let mem_ok = events4.iter().any(|e| e == "finished")
            && !events4.iter().any(|e| e.starts_with("ERROR"));
        let closed = events4.iter().any(|e| e.contains("deep_write"));
        all_pass &= verdict("memory turn completes", mem_ok);
        all_pass &= verdict("memory turn closes via deep_write", closed);
    }

    // 5. turn_log actually captured the turns.
    println!("── turn_log ──");
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        - 3600;
    let rows = db::list_turn_log(SMOKE_USER, since)
        .await
        .unwrap_or_default();
    println!("  {} rows", rows.len());
    for r in rows.iter().take(8) {
        println!(
            "  {} / {} · {} {} · {:?}ms · {}",
            r.agent_id,
            r.provider,
            r.tool.as_deref().unwrap_or("-"),
            r.outcome,
            r.latency_ms,
            r.output_tokens.unwrap_or(0)
        );
    }
    all_pass &= verdict("turn_log rows written", rows.len() >= 2);

    let _ = sid;
    println!(
        "{}",
        if all_pass {
            "AGENT SMOKE: ALL PASS"
        } else {
            "AGENT SMOKE: FAILURES — see above"
        }
    );
    if !all_pass {
        std::process::exit(1);
    }
}
