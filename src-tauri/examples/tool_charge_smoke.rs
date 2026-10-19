//! Headless smoke for tool-call usage attribution (PLAN-tool-usage-charging.md
//! Fase 1). Enters the supervisor's `ToolCharge` scope around a `reason`
//! one-shot — exactly what the `ToolDispatch` closure does around a plan
//! step — and asserts the LIVE call lands in the usage ledger WITH the scope's
//! tool name and the scope's user even though the pool itself carries none
//! (the web attribution path). Also checks the scope's running totals, the
//! numbers the step's `turn_log` row would carry.
//!
//! Requires vault keys (remote tier); burns a few tokens of the primary.
//!
//! Usage:
//!   cargo run --example tool_charge_smoke
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(run());
    // Flush OTel OUTSIDE the runtime (see remote_smoke).
    kawai_telemetry::shutdown();
}

async fn run() {
    kawai_lib::auth::load_dotenv();
    kawai_telemetry::init();

    let dir = tempfile::tempdir().expect("tempdir");
    kawai_db::set_data_root(dir.path());
    std::mem::forget(dir);
    let user = format!(
        "toolcharge-smoke-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs()
    );

    // No pool user on purpose: the scope's user is the only attribution
    // available — the exact shape of a tool one-shot on the web transport.
    let charge = Arc::new(kawai_telemetry::ToolCharge::new("smoke_probe", &user));
    let answer = kawai_telemetry::scoped_tool_charge(charge.clone(), async {
        remote_llm::reason::reason_in(
            "You are terse. Reply with the single word asked for.",
            "Reply with exactly: ok",
            "toolcharge-smoke-role",
            None,
            None,
        )
        .await
        .expect("remote reason call (vault keys required; remote tier disabled otherwise)")
    })
    .await;
    assert!(answer.contains("ok"), "unexpected answer: {answer}");

    // Ledger flusher lag (FLUSH_BATCH_WAIT + connection).
    tokio::time::sleep(Duration::from_millis(1_500)).await;

    let conn = kawai_db::db_connection(&user).await.expect("per-user db");
    let mut rows = conn
        .query(
            "SELECT kind, role, provider, input_tokens, output_tokens, tool \
             FROM usage_ledger",
            (),
        )
        .await
        .expect("ledger query");
    let mut found = false;
    while let Some(r) = rows.next().await.expect("row") {
        let kind: String = r.get(0).expect("kind");
        assert_eq!(kind, kawai_db::KIND_LLM);
        let tool: Option<String> = r.get(5).expect("tool");
        assert_eq!(
            tool.as_deref(),
            Some("smoke_probe"),
            "ledger row must carry the scope's tool name"
        );
        let input: Option<i64> = r.get(3).expect("input_tokens");
        let output: Option<i64> = r.get(4).expect("output_tokens");
        assert!(
            input.unwrap_or(0) + output.unwrap_or(0) > 0,
            "provider-reported usage expected on a live call"
        );
        println!(
            "[tool_charge_smoke] ledger row: role={:?} provider={:?} in={input:?} out={output:?} tool={tool:?}",
            r.get::<String>(1).ok(),
            r.get::<String>(2).ok(),
        );
        found = true;
    }
    assert!(found, "expected at least one ledger row for {user}");

    let (step_in, step_out) = (charge.input_tokens(), charge.output_tokens());
    assert!(step_in + step_out > 0, "scope must accumulate the call's usage");
    println!("[tool_charge_smoke] scope totals: in={step_in} out={step_out}");
    println!("[tool_charge_smoke] OK — tool attribution + user fallback verified against a live provider");
}
