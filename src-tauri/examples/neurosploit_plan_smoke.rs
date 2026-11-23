//! Offline probe of the NeuroSploit Deep Audit pipeline wiring.
//!
//! Builds the SAME plan the workbench form and the router template build
//! (`neurosploit_tools::plan::build_neurosploit_audit_plan`), validates it
//! against the SAME merged registry the supervisor executes
//! (`supervisor::build_registry_for_plan` → `validate_plan`), and checks the
//! confirmation policy the executor enforces (the single deep-audit step
//! MUST carry the gate — the spend prompt IS the price path).
//!
//! Unlike `security_plan_smoke` this probe does NOT execute the plan: the
//! deep audit is an autonomous remote-gateway engagement (minutes, real
//! token spend), and the harness's offline lane is not reachable through the
//! plan step args yet (the toolset's `offline` flag lives on `AuditParams`,
//! below the tool's camelCase arg struct). Wiring an `offline: true` step
//! arg is the follow-up that turns this into a full e2e smoke; the builder +
//! merged-registry half is pinned here.
//!
//! Run from `src-tauri/`:
//!   cargo run --example neurosploit_plan_smoke --features neurosploit

#[tokio::main]
async fn main() {
    let dir = tempfile::tempdir().expect("temp data root");
    kawai_db::set_data_root(dir.path());
    // The temp dir must outlive the run: the store re-opens the path per op.
    std::mem::forget(dir);

    let user = format!("ns-smoke-{}", std::process::id());
    let session = kawai_db::create_chat_session(&user)
        .await
        .expect("chat session")
        .id;

    let workdir = dir.path().join("ns-runs/ns-1-t_local");
    let agents_base = dir.path().join("agents-root");
    // The builder validates that the library root contains `agents_md/`.
    std::fs::create_dir_all(agents_base.join("agents_md")).expect("mkdir agents_md");

    let mut plan = neurosploit_tools::plan::build_neurosploit_audit_plan(
        "http://127.0.0.1:8099/search?q=1",
        None, // eco budget
        workdir,
        agents_base,
        Some("Bahasa Indonesia"),
    )
    .expect("plan");

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

    let step = plan.steps.first().expect("single step");
    assert_eq!(step.tool.as_deref(), Some("neurosploit_audit"));
    assert_eq!(step.arguments["budget"], "eco");
    assert_eq!(step.arguments["voteN"], 1);
    assert!(step.arguments.get("nonce").is_some(), "run nonce present");
    assert!(
        step.requires_confirmation == Some(true),
        "the deep-audit step is confirmation-gated: the spend prompt IS the price path"
    );
    assert_eq!(plan.template.as_deref(), Some("neurosploit_audit"));

    println!("\nOK — plan builds, validates against the merged registry, gate enforced");
}
