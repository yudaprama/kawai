//! LIVE gateway smoke for the NeuroSploit deep audit — the §8.4 acceptance
//! step. One real `eco`-budget run against a user-owned target (default
//! https://kawai.pro), asserting: confirmed findings OR an honest empty
//! result, `usage` > 0 (the live differentiator — the offline smoke pins
//! zero), and a matching `usage_ledger` delta for the signed-in user.
//!
//! SPENDS REAL GATEWAY TOKENS (eco ceiling ≤120k) and can run for many
//! minutes (recon → parallel specialists → exploitation → report). Manual,
//! dev-only — never wired into CI:
//!
//! ```sh
//! cd src-tauri && cargo run --example neurosploit_live_smoke \
//!   --features litert,security,neurosploit
//! ```
//!
//! Sign-in: `KAWAI_LIVE_SMOKE_EMAIL` / `KAWAI_LIVE_SMOKE_PASSWORD`, falling
//! back to `KAWAI_ADMIN_EMAIL` / `KAWAI_ADMIN_PASSWORD` (from .env). Target
//! override: `KAWAI_LIVE_SMOKE_TARGET`. Wall-clock backstop:
//! `KAWAI_NEUROSPLOIT_BACKSTOP_SECS` (default 45 min; a backstopped run is
//! resumable — re-invoke with the same env to continue, not re-spend).

use std::future::Future;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kawai_db::usage::{usage_window, UsageCursor};
use kawai_router::SchedulerLimits;

/// Confirmation handler standing in for the user: the same gate the workbench
/// shows is approved explicitly here, so the scheduler path under test is the
/// real one (a gated step with no handler fails with `ConfirmationRequired`).
fn approve() -> kawai_router::ConfirmationHandler {
    std::sync::Arc::new(|step_id: String, task: String| {
        Box::pin(async move {
            println!("  ⌨ approved: {step_id}\n    {task}");
            Ok(())
        }) as std::pin::Pin<Box<dyn Future<Output = Result<(), kawai_router::RouterError>> + Send>>
    })
}

fn credentials() -> Option<(String, String)> {
    if let (Ok(e), Ok(p)) = (
        std::env::var("KAWAI_LIVE_SMOKE_EMAIL"),
        std::env::var("KAWAI_LIVE_SMOKE_PASSWORD"),
    ) {
        return Some((e, p));
    }
    if let (Ok(e), Ok(p)) = (
        std::env::var("KAWAI_ADMIN_EMAIL"),
        std::env::var("KAWAI_ADMIN_PASSWORD"),
    ) {
        return Some((e, p));
    }
    None
}

#[tokio::main]
async fn main() {
    kawai_lib::auth::load_dotenv();

    let target = std::env::var("KAWAI_LIVE_SMOKE_TARGET")
        .unwrap_or_else(|_| "https://kawai.pro".into());
    let (email, password) = credentials().unwrap_or_else(|| {
        eprintln!(
            "no credentials: set KAWAI_LIVE_SMOKE_EMAIL/KAWAI_LIVE_SMOKE_PASSWORD \
             (or KAWAI_ADMIN_EMAIL/KAWAI_ADMIN_PASSWORD in .env)"
        );
        std::process::exit(2);
    });

    // The gateway tier — and the harness pool that rides it — is armed only by
    // a real session bearer. Headless callers publish it themselves (same
    // recipe as planner_smoke / commands::establish_local_session).
    let signed = kawai_lib::logic::local_auth::auth_sign_in(&email, &password)
        .await
        .unwrap_or_else(|e| {
            eprintln!("sign-in failed: {e}");
            std::process::exit(2);
        });
    let token = kawai_lib::logic::local_auth::stored_token(&signed.email)
        .unwrap_or_else(|| {
            eprintln!("sign-in succeeded but no bearer was stored");
            std::process::exit(2);
        });
    let user = signed.email.clone();
    remote_llm::set_gateway_bearer(Some(token.clone()));
    harness::set_gateway_endpoint(Some(format!(
        "{}/v1",
        kawai_lib::logic::local_auth::worker_base_url()
    )));
    harness::set_gateway_bearer(Some(token));
    println!("[auth] signed in as {user}; gateway + harness pool armed");

    // The ledger delta is measured in an isolated data root: nothing else
    // writes LLM rows for this user here, so the window is the audit's spend.
    let dir = tempfile::tempdir().expect("temp data root");
    let root = dir.path().to_path_buf();
    std::mem::forget(dir);
    kawai_db::set_data_root(&root);
    kawai_paths::set_data_root(&root);

    let session = kawai_db::create_chat_session(&user)
        .await
        .expect("chat session")
        .id;

    // Library first — the same lazy fetch the fixed pipeline performs before
    // any plan exists (`supervisor::prepare_neurosploit_audit_run`): a
    // stale/missing `agents_md/` is downloaded at the pinned ref; an
    // incomplete library refuses the audit before any plan exists.
    let ensure = neurosploit_agents::ensure_agents_md(Some(&user))
        .await
        .expect("agent library fetch");
    println!(
        "[agents] downloaded={} files={} reason={}",
        ensure.downloaded,
        ensure.files,
        ensure.reason.as_deref().unwrap_or("")
    );
    let agents_base = neurosploit_agents::agents_md_dir(Some(&user))
        .parent()
        .expect("user data dir")
        .to_path_buf();
    let runs_root = agents_base.join("neurosploit").join("runs");
    let workdir = neurosploit_tools::paths::run_workdir(&runs_root, &target, false)
        .expect("run workdir");
    std::fs::create_dir_all(&workdir).expect("create workdir");

    // The real plan — the offline field is NOT injected; this run spends.
    let mut plan = neurosploit_tools::plan::build_neurosploit_audit_plan(
        &target,
        None, // eco budget
        workdir.clone(),
        agents_base,
        None,
    )
    .expect("plan");

    let registry = kawai_lib::supervisor::build_registry_for_plan(&user, session, &plan)
        .await
        .expect("merged registry");
    registry.enforce_confirmation_policy(&mut plan);
    registry
        .validate_plan(&plan)
        .expect("plan must be dispatchable");
    let step = plan.steps.first().expect("single step").clone();
    assert_eq!(step.tool.as_deref(), Some("neurosploit_audit"));
    assert_ne!(
        step.arguments["offline"].as_bool(),
        Some(true),
        "the live smoke must not set the offline flag"
    );

    println!(
        "[plan] target={target} budget={} backstop={}s workdir={}",
        step.arguments["budget"],
        neurosploit_tools::audit_backstop().as_secs(),
        workdir.display()
    );

    let mut limits = SchedulerLimits::default();
    limits.confirmation_handler = Some(approve());
    limits.observer = Some(std::sync::Arc::new(|event| match event {
        kawai_router::SchedulerEvent::StepStarted {
            step_id,
            tool,
            args_summary,
        } => {
            println!("  ▶ {step_id} ({tool}) args={args_summary}")
        }
        kawai_router::SchedulerEvent::StepCompleted {
            step_id,
            output,
            retries_used,
        } => println!("  ✓ {step_id} — {} chars, {retries_used} retries", output.len()),
        kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => {
            println!("  ✗ {step_id}: {error}")
        }
        _ => {}
    }));

    let started = Instant::now();
    let result = kawai_router::run_plan(plan, registry.step_dispatch(), limits)
        .await
        .expect("the plan must execute");

    let s = match result.results.first() {
        Some(s) => s,
        None => {
            eprintln!("FAILED: the plan produced no step result");
            std::process::exit(1);
        }
    };
    println!(
        "\n── {} [{:?}] {} in {:?}",
        s.step_id,
        s.status,
        s.error.clone().unwrap_or_default(),
        started.elapsed()
    );
    let payload: serde_json::Value = serde_json::from_str(&s.output).unwrap_or(serde_json::Value::Null);

    let mut failures: Vec<String> = Vec::new();
    if payload["kind"] != serde_json::json!("neurosploit_audit") {
        failures.push(format!("envelope kind drifted: {payload}"));
    }
    if payload["findings"].as_array().is_none() {
        failures.push(format!("findings must be an array: {payload}"));
    }
    for key in ["confirmed", "needsReview", "total"] {
        if payload["summary"][key].as_u64().is_none() {
            failures.push(format!("summary.{key} must be numeric: {payload}"));
        }
    }
    if payload["progress"].as_array().is_none_or(|p| p.is_empty()) {
        failures.push(format!("the harness progress tail is empty: {payload}"));
    }
    if payload["agentsRan"].as_array().is_none_or(|a| a.is_empty()) {
        // An honest empty result is an accepted outcome (§8.4): the wall-clock
        // backstop or the budget ceiling can end the engagement before a
        // specialist completes. Only a run that CLAIMS agents without spend
        // is broken — covered by the usage assertions below.
        println!("[warn] no specialist completed — backstopped or budget-bound run");
    }
    let usage = &payload["usage"];
    let calls = usage["calls"].as_u64().unwrap_or(0);
    let input = usage["input"].as_u64().unwrap_or(0);
    let output = usage["output"].as_u64().unwrap_or(0);
    if calls == 0 || input == 0 {
        failures.push(format!("a live run must spend tokens: {usage}"));
    }

    // The ledger must agree: poll past the flusher's buffering window.
    let mut ledger = kawai_db::usage::UsageWindow::default();
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        let to = UsageCursor::new(
            (SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64) - 2,
            i64::MAX,
        );
        ledger = usage_window(&user, UsageCursor::START, to).await.expect("usage window");
        if ledger.rows > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    println!(
        "[ledger] rows={} llm={} embed={} media={} tool={}",
        ledger.rows, ledger.llm_tokens, ledger.embed_tokens, ledger.media_tokens, ledger.tool_tokens
    );
    if ledger.llm_tokens == 0 {
        failures.push("usage_ledger recorded no LLM tokens for the run".into());
    } else if ledger.llm_tokens != (input + output) as i64 {
        failures.push(format!(
            "ledger delta ({}) must match the envelope spend ({input}+{output}) — metering drifted",
            ledger.llm_tokens
        ));
    }

    println!(
        "\n[audit] confirmed={} needsReview={} total={} agents={} timedOut={} resumable={}",
        payload["summary"]["confirmed"],
        payload["summary"]["needsReview"],
        payload["summary"]["total"],
        payload["agentsRan"].as_array().map_or(0, |a| a.len()),
        payload["timedOut"],
        payload["resumable"],
    );
    if let Some(findings) = payload["findings"].as_array() {
        for f in findings.iter().take(10) {
            println!(
                "  • [{}] {} ({})",
                f["severity"].as_str().unwrap_or("?"),
                f["title"].as_str().unwrap_or(f["id"].as_str().unwrap_or("?")),
                f["status"].as_str().unwrap_or("?")
            );
        }
        if findings.len() > 10 {
            println!("  … {} more", findings.len() - 10);
        }
    }

    if failures.is_empty() {
        println!(
            "\nOK — live audit accepted: {calls} calls, {input}+{output} tokens, \
             ledger agrees ({} llm tokens), findings honest, workdir kept at {}",
            ledger.llm_tokens,
            workdir.display()
        );
    } else {
        eprintln!("\nFAILED:");
        for f in &failures {
            eprintln!("  - {f}");
        }
        std::process::exit(1);
    }
}
