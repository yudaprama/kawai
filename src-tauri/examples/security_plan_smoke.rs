//! End-to-end probe of the Security Audit pipeline.
//!
//! It builds the SAME plan the workbench form and the router template build
//! (`security_tools::plan::build_security_audit_plan`), validates it against
//! the SAME merged registry the supervisor executes
//! (`supervisor::build_registry_for_plan` → `validate_plan`), checks the
//! confirmation policy the executor enforces, and runs it through the real
//! scheduler against a REAL vulnerable localhost target — so what it prints
//! is the payload the step cards actually read.
//!
//! The smoke IS the operator: it dispatches the confirmation-gated scan step
//! directly (the interactive gate pauses for a human; a headless probe has
//! one). The only network traffic is against 127.0.0.1.
//!
//! Run from `src-tauri/`:
//!   cargo run --example security_plan_smoke --features litert,security

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

use kawai_router::SchedulerLimits;

fn pct_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The deliberately vulnerable target: reflects the DECODED path + query into
/// an HTML body with zero escaping — the textbook reflected-XSS setup the XSS
/// modules must find.
fn serve() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind localhost");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let first_line = req.lines().next().unwrap_or("GET / HTTP/1.1");
            let path = first_line.split_whitespace().nth(1).unwrap_or("/");
            let body = format!(
                "<html><head><title>Vulnerable App</title></head><body>\
                 <h1>Results for {}</h1><p>No results found.</p></body></html>",
                pct_decode(path)
            );
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    port
}

#[tokio::main]
async fn main() {
    let dir = tempfile::tempdir().expect("temp data root");
    kawai_db::set_data_root(dir.path());
    // The temp dir must outlive the run: the store re-opens the path per op.
    std::mem::forget(dir);

    let user = format!("security-smoke-{}", std::process::id());
    let session = kawai_db::create_chat_session(&user)
        .await
        .expect("chat session")
        .id;

    let port = serve();
    // Seed a query parameter: with crawling disabled the XSS scanners test
    // the parameters the target URL already carries.
    let target = format!("http://127.0.0.1:{port}/search?q=kawai");
    println!("user={user} session={session} target={target}");

    // The real plan: same builder the form and the template call.
    let mut plan = security_tools::plan::build_security_audit_plan(
        &target,
        &["xss".to_string()],
        Some("minimal"),
        None,
    )
    .expect("plan");
    println!(
        "\nsteps: {:?}\ngoal:\n{}\n",
        plan.steps
            .iter()
            .map(|s| format!("{} -> {}", s.id, s.dispatch_key()))
            .collect::<Vec<_>>(),
        plan.goal
    );

    // The registry EVERY entry path executes against. Same order as the
    // supervisor: the policy pass first (the registry is authoritative — a
    // gated tool's flag is forced on, whatever the plan authored), THEN
    // validation. Validating first would reject the plan the executor would
    // have accepted.
    let registry = kawai_lib::supervisor::build_registry_for_plan(&user, session, &plan)
        .await
        .expect("merged registry");
    registry.enforce_confirmation_policy(&mut plan);
    // The completeness property: every step dispatches a tool the merged
    // catalog actually carries.
    registry.validate_plan(&plan).expect("plan must be dispatchable");
    // The policy is authoritative: recon stays passive, the active scan must
    // be gated — an ungated attack step here would be the bug.
    let gated: Vec<bool> = plan
        .steps
        .iter()
        .map(|s| s.requires_confirmation == Some(true))
        .collect();
    assert_eq!(
        gated,
        vec![false, true],
        "recon must stay ungated; the active scan must be gated by policy"
    );
    // The smoke IS the operator: the interactive gate pauses for a human
    // (`confirmation_handler: None` fails the gated step), and a headless
    // probe approves on the spot.
    let approve: kawai_router::ConfirmationHandler = std::sync::Arc::new(|step_id, task| {
        println!("[confirmation] approved step={step_id} task={task}");
        Box::pin(async { Ok(()) })
    });
    let limits = SchedulerLimits {
        confirmation_handler: Some(approve),
        ..Default::default()
    };

    let result = kawai_router::run_plan(plan, registry.step_dispatch(), limits)
        .await
        .expect("the plan must execute");

    let mut failures: Vec<String> = Vec::new();
    for step in &result.results {
        let payload: serde_json::Value =
            serde_json::from_str(&step.output).unwrap_or(serde_json::Value::Null);
        println!(
            "\n── {} [{}] {}",
            step.step_id,
            format!("{:?}", step.status),
            step.error.clone().unwrap_or_default()
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&payload)
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect::<String>()
        );

        // Structural assertions on purpose: the smoke proves the WIRING
        // (plan → registry → tool → the payload the card reads). Finding
        // exactness is pinned by the crate tests; a scan is probabilistic by
        // nature, the ENVELOPE is not.
        match step.step_id.as_str() {
            "recon" => {
                if payload["kind"] != serde_json::json!("security_recon") {
                    failures.push(format!("recon envelope kind drifted: {payload}"));
                }
                if !payload["findings"].is_array() {
                    failures.push(format!("recon must carry a findings array: {payload}"));
                }
            }
            "scan-xss" => {
                if payload["kind"] != serde_json::json!("security_scan") {
                    failures.push(format!("scan envelope kind drifted: {payload}"));
                }
                let findings = payload["findings"].as_array().cloned().unwrap_or_default();
                let xss = findings.iter().any(|f| {
                    let t = f["vulnType"].as_str().unwrap_or("").to_lowercase();
                    let cwe = f["cwe"].as_str().unwrap_or("");
                    (t.contains("xss") || t.contains("cross-site") || cwe.contains("79"))
                        && matches!(
                            f["severity"].as_str(),
                            Some("HIGH") | Some("CRITICAL") | Some("MEDIUM")
                        )
                });
                if !xss {
                    failures.push(format!(
                        "the reflected-XSS target must yield an XSS-class finding: {payload}"
                    ));
                }
                if payload["testsRun"].as_u64().unwrap_or(0) == 0 {
                    failures.push(format!("the scan must report its test count: {payload}"));
                }
            }
            _ => {}
        }
    }

    if failures.is_empty() {
        println!(
            "\nOK — {} steps, all_completed={}",
            result.results.len(),
            result.all_completed()
        );
    } else {
        eprintln!("\nFAILED:");
        for f in &failures {
            eprintln!("  - {f}");
        }
        std::process::exit(1);
    }
}
