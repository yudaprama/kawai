// Calibration report for the hybrid LLM tier: aggregates `turn_log` rows for
// one user into the numbers the plan says to tune against — delegation rate
// per agent (under-delegation lens), cloud cost/latency per tool, escalation
// and error frequency.
//
// Usage:
//   cargo run --example turn_log_report --features litert [-- user-id] [-- days]
// Data root resolution is the usual one (KAWAI_DATA_DIR / KAWAI_DB_DIR env →
// /tmp/kawai fallback). To read the desktop app's real data, point
// KAWAI_DATA_DIR at the app's per-user data root.
use kawai_lib::logic::db::{self, TurnLogRow};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    let mut user = "demo".to_string();
    let mut days: i64 = 7;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--user" => user = args.next().unwrap_or(user),
            "--days" => days = args.next().and_then(|d| d.parse().ok()).unwrap_or(days),
            other => {
                eprintln!("unknown arg {other:?} (use --user <id> --days <n>)");
                std::process::exit(2);
            }
        }
    }
    let since = chrono_like_now() - days * 86_400;

    let rows = match db::list_turn_log(&user, since).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[turn_log_report] read failed: {e}");
            std::process::exit(1);
        }
    };
    if rows.is_empty() {
        println!("[turn_log_report] no rows for user {user:?} in the last {days}d — nothing to calibrate yet.");
        return;
    }

    // Per (agent, provider) aggregates: the delegation-rate lens.
    let mut keys: Vec<String> = Vec::new();
    let mut count = std::collections::HashMap::<String, u64>::new();
    let mut escalated = std::collections::HashMap::<String, u64>::new();
    let mut errors = std::collections::HashMap::<String, u64>::new();
    let mut tokens_in = std::collections::HashMap::<String, i64>::new();
    let mut tokens_out = std::collections::HashMap::<String, i64>::new();
    let mut lat = std::collections::HashMap::<String, (u64, i64)>::new(); // (n, sum_ms)
    for r in &rows {
        let k = format!("{:>14} / {}", r.agent_id, r.provider);
        if !keys.contains(&k) {
            keys.push(k.clone());
        }
        *count.entry(k.clone()).or_default() += 1;
        match r.outcome.as_str() {
            "escalated" => *escalated.entry(k.clone()).or_default() += 1,
            "error" => *errors.entry(k.clone()).or_default() += 1,
            _ => {}
        }
        *tokens_in.entry(k.clone()).or_default() += r.input_tokens.unwrap_or(0);
        *tokens_out.entry(k.clone()).or_default() += r.output_tokens.unwrap_or(0);
        let e = lat.entry(k.clone()).or_default();
        e.0 += 1;
        e.1 += r.latency_ms;
    }

    println!(
        "turn_log report — user {user:?}, last {days}d, {} rows",
        rows.len()
    );
    println!(
        "{:<32} {:>7} {:>10} {:>10} {:>9} {:>9} {:>9}",
        "agent / provider", "calls", "in-tok", "out-tok", "avg-ms", "escal", "errors"
    );
    for k in &keys {
        let c = count[k] as f64;
        println!(
            "{:<32} {:>7} {:>10} {:>10} {:>9.0} {:>9} {:>9}",
            k,
            count[k],
            tokens_in[k],
            tokens_out[k],
            lat[k].1 as f64 / c,
            escalated.get(k).copied().unwrap_or(0),
            errors.get(k).copied().unwrap_or(0),
        );
    }

    // Per-tool cloud breakdown.
    let mut tools: Vec<String> = Vec::new();
    let mut t_count = std::collections::HashMap::<String, u64>::new();
    let mut t_out = std::collections::HashMap::<String, i64>::new();
    for r in rows.iter().filter(|r| r.provider != "local") {
        let name = r.tool.clone().unwrap_or_else(|| "?".into());
        if !tools.contains(&name) {
            tools.push(name.clone());
        }
        *t_count.entry(name.clone()).or_default() += 1;
        *t_out.entry(name).or_default() += r.output_tokens.unwrap_or(0);
    }
    if !tools.is_empty() {
        println!("\ncloud tools:");
        for t in &tools {
            println!(
                "  {:<20} {:>5} calls · {:>8} out-tokens",
                t, t_count[t], t_out[t]
            );
        }
    }

    // ── Planner lens (PLAN-planner-subagent.md §6) ────
    // Plan/revise volume, revise rate, plan errors, and whether planned
    // sessions went on to synthesize. Over-planning per TURN is not measurable
    // from turn_log (no turn id / tool-call rows) — the closest honest proxy
    // is sessions whose ONLY cloud activity is planning.
    let is_plan_tool = |t: &str| t == "plan_task" || t == "plan_revise";
    let plan_rows: Vec<&TurnLogRow> = rows
        .iter()
        .filter(|r| r.tool.as_deref().is_some_and(is_plan_tool))
        .collect();
    if plan_rows.is_empty() {
        println!("\nplanner: no plan_task/plan_revise rows in window.");
    } else {
        let plans = plan_rows
            .iter()
            .filter(|r| r.tool.as_deref() == Some("plan_task"))
            .count();
        let revisions = plan_rows.len() - plans;
        let plan_errors = plan_rows.iter().filter(|r| r.outcome == "error").count();
        let (pn, plms): (u64, i64) = plan_rows
            .iter()
            .fold((0, 0), |(n, s), r| (n + 1, s + r.latency_ms));
        let plan_sessions: std::collections::HashSet<i64> =
            plan_rows.iter().map(|r| r.session_id).collect();
        let synth_sessions: std::collections::HashSet<i64> = rows
            .iter()
            .filter(|r| {
                matches!(r.tool.as_deref(), Some("deep_write") | Some("draft_document"))
            })
            .map(|r| r.session_id)
            .collect();
        let followed = plan_sessions
            .iter()
            .filter(|s| synth_sessions.contains(s))
            .count();
        let plan_only: Vec<i64> = plan_sessions
            .iter()
            .filter(|s| {
                !rows.iter().any(|r| {
                    r.session_id == **s && r.tool.as_deref().is_some_and(|t| !is_plan_tool(t))
                })
            })
            .copied()
            .collect();
        println!("\nplanner lens:");
        println!(
            "  {:>4} plan_task · {:>4} plan_revise · {:>4} errors · avg {:>5.0} ms",
            plans,
            revisions,
            plan_errors,
            plms as f64 / pn as f64
        );
        println!(
            "  revise rate: {:>5.1}%  (>50% suggests plans go stale fast)",
            100.0 * revisions as f64 / plans.max(1) as f64
        );
        println!(
            "  planned sessions: {} · went on to synthesize: {}",
            plan_sessions.len(),
            followed
        );
        if !plan_only.is_empty() {
            println!(
                "  ⚠ sessions whose ONLY cloud activity is planning (over-planning proxy): {:?}",
                plan_only
            );
        }
    }

    // Under-delegation lens per agent: local-share of answered turns.
    println!("\ndelegation share (answer rows only):");
    let agents: Vec<String> = rows.iter().map(|r| r.agent_id.clone()).collect::<Vec<_>>();
    let mut seen = Vec::new();
    for a in agents {
        if seen.contains(&a) {
            continue;
        }
        seen.push(a.clone());
        let answers: Vec<&TurnLogRow> = rows
            .iter()
            .filter(|r| r.agent_id == a && r.outcome != "error")
            .collect();
        let cloud = answers.iter().filter(|r| r.provider != "local").count();
        if answers.is_empty() {
            continue;
        }
        println!(
            "  {:<14} {:>3}/{:>3} cloud = {:>5.1}%",
            a,
            cloud,
            answers.len(),
            100.0 * cloud as f64 / answers.len() as f64
        );
    }
}

fn chrono_like_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
