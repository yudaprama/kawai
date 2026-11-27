//! End-to-end probe of the NeuroSploit Deep Audit pipeline.
//!
//! Builds the SAME plan the workbench form, the fixed `run_neurosploit_audit`
//! op and the router template build (`neurosploit_tools::plan`), validates it
//! against the SAME merged registry the supervisor executes
//! (`supervisor::build_registry_for_plan` → `validate_plan`), checks the
//! confirmation policy the executor enforces (the single deep-audit step MUST
//! carry the gate — the spend prompt IS the price path), and then RUNS it
//! through the real scheduler with the harness in OFFLINE mode.
//!
//! Offline mode exercises the harness's full pipeline — library load, agent
//! ranking/selection, artifact persistence, progress lines, the `RunOutput`
//! fold into the flat envelope — with ZERO model calls, so this is a real
//! wiring gate that costs no gateway tokens. Structural assertions only: the
//! envelope shape (kind, summary, findings, usage, progress, offline) is what
//! the result card reads, and offline runs produce no findings by design.
//!
//! The agent library here is SYNTHETIC (one `.md` per required category) — the
//! smoke's subject is the wiring, not the 493-file upstream content. The real
//! library's completeness is `neurosploit_agents::verify_local`, which
//! `run_audit` calls before any spend.
//!
//! Run from `src-tauri/`:
//!   cargo run --example neurosploit_plan_smoke --features litert,neurosploit

use std::path::Path;

use kawai_router::{SchedulerLimits, TaskPlan};

/// A structurally complete agent library: `REGISTRY.md` plus ≥1 `.md` in every
/// category `verify_local` requires. The harness treats each file as an agent
/// (first `#` heading = title, `CWE-<n>` = weakness).
fn seed_library(base: &Path) {
    let dir = base.join("agents_md");
    std::fs::create_dir_all(&dir).expect("mkdir agents_md");
    std::fs::write(
        dir.join("REGISTRY.md"),
        "# Registry\n\nSynthetic library for the offline deep-audit smoke.\n",
    )
    .expect("write REGISTRY.md");
    for category in neurosploit_agents::REQUIRED_CATEGORIES {
        let category_dir = dir.join(category);
        std::fs::create_dir_all(&category_dir).expect("mkdir category");
        std::fs::write(
            category_dir.join("smoke-agent.md"),
            "# Smoke Agent\n\nCWE-79\n\n## System Prompt\n\nYou are a smoke agent.\n",
        )
        .expect("write agent md");
    }
}

/// Confirmation handler standing in for the user: the same gate the workbench
/// shows is approved explicitly here, so the scheduler path under test is the
/// real one (a gated step with no handler fails with `ConfirmationRequired`).
fn approve() -> kawai_router::ConfirmationHandler {
    std::sync::Arc::new(|step_id: String, task: String| {
        Box::pin(async move {
            println!("  ⌨ approved: {step_id}\n    {task}");
            Ok(())
        })
            as std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<(), kawai_router::RouterError>> + Send>,
            >
    })
}

#[tokio::main]
async fn main() {
    let dir = tempfile::tempdir().expect("temp data root");
    let root = dir.path().to_path_buf();
    kawai_db::set_data_root(&root);
    // The temp dir must outlive the run: the store re-opens the path per op.
    std::mem::forget(dir);

    let user = format!("ns-smoke-{}", std::process::id());
    let session = kawai_db::create_chat_session(&user)
        .await
        .expect("chat session")
        .id;

    let workdir = root.join("ns-runs/ns-1-t_local");
    let agents_base = root.join("agents-root");
    seed_library(&agents_base);

    // The real plan: same builder the form, the op and the template call.
    let mut plan = neurosploit_tools::plan::build_neurosploit_audit_plan(
        "http://127.0.0.1:8099/search?q=1",
        None, // eco budget
        workdir.clone(),
        agents_base,
        Some("Bahasa Indonesia"),
    )
    .expect("plan");
    // The one field production never sets: no model call, no spend. Injected
    // after the builder so the plan stays otherwise byte-identical.
    for step in plan.steps.iter_mut() {
        step.arguments["offline"] = serde_json::json!(true);
    }

    println!(
        "steps: {:?}\ngoal:\n{}\n",
        plan.steps
            .iter()
            .map(|s| format!("{} -> {}", s.id, s.dispatch_key()))
            .collect::<Vec<_>>(),
        plan.goal
    );

    // Same order as the supervisor: the policy pass first (the registry is
    // authoritative — the gated tool's flag is forced on), THEN validation.
    let registry = kawai_lib::supervisor::build_registry_for_plan(&user, session, &plan)
        .await
        .expect("merged registry");
    registry.enforce_confirmation_policy(&mut plan);
    registry
        .validate_plan(&plan)
        .expect("plan must be dispatchable");

    let step = plan.steps.first().expect("single step").clone();
    assert_eq!(step.tool.as_deref(), Some("neurosploit_audit"));
    assert_eq!(step.arguments["budget"], "eco");
    assert_eq!(step.arguments["voteN"], 1);
    assert!(step.arguments.get("nonce").is_some(), "run nonce present");
    assert_eq!(
        step.requires_confirmation,
        Some(true),
        "the deep-audit step is confirmation-gated: the spend prompt IS the price path"
    );
    assert_eq!(plan.template.as_deref(), Some("neurosploit_audit"));
    assert!(
        step.timeout_ms.is_some_and(|ms| ms > 60_000),
        "the step must outlive the scheduler's 60s default"
    );

    // Execute through the real scheduler. Offline: the harness selects agents
    // and returns without a single model call.
    let mut limits = SchedulerLimits::default();
    limits.confirmation_handler = Some(approve());
    limits.observer = Some(std::sync::Arc::new(|event| match event {
        kawai_router::SchedulerEvent::StepStarted { step_id, tool, .. } => {
            println!("  ▶ {step_id} ({tool})")
        }
        kawai_router::SchedulerEvent::StepCompleted {
            step_id,
            output,
            retries_used,
        } => {
            println!(
                "  ✓ {step_id} — {} chars, {retries_used} retries",
                output.len()
            )
        }
        kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => {
            println!("  ✗ {step_id}: {error}")
        }
        _ => {}
    }));

    let result = run(plan, registry.step_dispatch(), limits).await;

    let mut failures: Vec<String> = Vec::new();
    let payload: serde_json::Value = match result.results.first() {
        Some(s) => {
            println!(
                "\n── {} [{:?}] {}",
                s.step_id,
                s.status,
                s.error.clone().unwrap_or_default()
            );
            serde_json::from_str(&s.output).unwrap_or(serde_json::Value::Null)
        }
        None => {
            eprintln!("FAILED: the plan produced no step result");
            std::process::exit(1);
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&payload)
            .unwrap_or_default()
            .chars()
            .take(2000)
            .collect::<String>()
    );

    // Structural contract: what the result card reads, all of it.
    if payload["kind"] != serde_json::json!("neurosploit_audit") {
        failures.push(format!("envelope kind drifted: {payload}"));
    }
    if payload["offline"] != serde_json::json!(true) {
        failures.push("offline runs must be labelled offline".into());
    }
    if payload["timedOut"] != serde_json::json!(false)
        || payload["resumable"] != serde_json::json!(false)
    {
        failures.push("a completed offline run is neither timed out nor resumable".into());
    }
    if payload["findings"].as_array().is_none() {
        failures.push(format!("findings must be an array: {payload}"));
    }
    if payload["findings"]
        .as_array()
        .is_some_and(|f| !f.is_empty())
    {
        failures.push("an offline run performs no exploitation — it cannot report findings".into());
    }
    for key in ["confirmed", "needsReview", "total"] {
        if payload["summary"][key].as_u64().is_none() {
            failures.push(format!("summary.{key} must be numeric: {payload}"));
        }
    }
    // The harness selected specialists, so the run reached the agent phase.
    if payload["agentsRan"].as_array().is_none_or(|a| a.is_empty()) {
        failures.push(format!(
            "the harness must report the agents it selected: {payload}"
        ));
    }
    // Zero spend is the whole point of the offline lane.
    let usage = &payload["usage"];
    if usage["calls"].as_u64() != Some(0)
        || usage["input"].as_u64() != Some(0)
        || usage["output"].as_u64() != Some(0)
    {
        failures.push(format!("offline mode must not spend a token: {usage}"));
    }
    // The live progress bridge must have carried real harness lines.
    if payload["progress"].as_array().is_none_or(|p| p.is_empty()) {
        failures.push(format!("the harness progress tail is empty: {payload}"));
    }
    if payload["workdir"].as_str() != Some(workdir.to_string_lossy().as_ref()) {
        failures.push(format!("workdir drifted: {}", payload["workdir"]));
    }

    if failures.is_empty() {
        println!(
            "\nOK — plan → registry → gate → scheduler → harness (offline) → envelope; \
             {} agents, 0 tokens",
            payload["agentsRan"].as_array().map_or(0, |a| a.len())
        );
    } else {
        eprintln!("\nFAILED:");
        for f in &failures {
            eprintln!("  - {f}");
        }
        std::process::exit(1);
    }
}

async fn run(
    plan: TaskPlan,
    dispatch: kawai_router::StepDispatch,
    limits: SchedulerLimits,
) -> kawai_router::ExecutionResult {
    kawai_router::run_plan(plan, dispatch, limits)
        .await
        .expect("the plan must execute")
}
