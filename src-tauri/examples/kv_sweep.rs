// H7 K/V budget sweep — measures load time + turn latency at 16384 / 24576 / 32000 (ceiling 32003).
// Usage: cargo run --release --example kv_sweep --features litert -- /path/to/model.litertlm [budgets]
//   budgets: comma-separated list e.g. "16384,24576,32000" (default all three)
// Needs: same dylibs as local_llm_smoke (bundle:litert). For TRUE peak RSS use the wrapper:
//   bash scripts/kv_sweep.sh /path/to/model.litertlm
// That wrapper runs each budget as a separate process under /usr/bin/time -l and captures max RSS.
use futures_util::StreamExt;
use kawai_lib::logic::local_llm;

const DEFAULT_BUDGETS: &[i32] = &[16384, 24576, 31999];

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let model = args
        .next()
        .expect("usage: kv_sweep <model.litertlm> [budgets_csv]");
    let budgets: Vec<i32> = args
        .next()
        .map(|s| {
            s.split(',')
                .filter_map(|v| v.trim().parse().ok())
                .filter(|&v| v > 0 && v < 32003) // model ceiling 32003; keep strictly below
                .collect()
        })
        .unwrap_or_else(|| DEFAULT_BUDGETS.to_vec());

    println!("# kv_sweep — model: {model}");
    println!("# budgets: {budgets:?} (env KAWAI_LLM_MAX_TOKENS per iteration)");
    println!("# For peak RSS (macOS): /usr/bin/time -l cargo run --release --example kv_sweep --features litert -- {model} 16384");
    println!();

    for budget in budgets {
        // SAFETY: single-threaded tokio current_thread, no concurrent readers of this env.
        unsafe { std::env::set_var("KAWAI_LLM_MAX_TOKENS", budget.to_string()) };
        println!("## budget {budget}");
        let t_load = std::time::Instant::now();
        match local_llm::load_model("kv_sweep", &model, false, false, 1, None).await {
            Ok(info) => {
                let load_s = t_load.elapsed().as_secs_f64();
                println!(
                    "  load: {} [{}] in {load_s:.2}s",
                    info.model_path, info.backend
                );

                // Single-turn latency probe (same prompt as local_llm_smoke)
                let t0 = std::time::Instant::now();
                let mut ttft: Option<f64> = None;
                let mut tokens = 0usize;
                let mut stream = Box::pin(local_llm::local_chat(
                    "kv_sweep".into(),
                    "Say hello in one sentence.".into(),
                    None,
                    None,
                ));
                while let Some(ev) = stream.next().await {
                    if let local_llm::LocalChatEvent::Token { .. } = ev {
                        if ttft.is_none() {
                            ttft = Some(t0.elapsed().as_secs_f64());
                        }
                        tokens += 1;
                    }
                    if matches!(
                        ev,
                        local_llm::LocalChatEvent::Finished
                            | local_llm::LocalChatEvent::Error { .. }
                    ) {
                        break;
                    }
                }
                let total = t0.elapsed().as_secs_f64();
                let ttft = ttft.unwrap_or(total);
                let decode_tps = if tokens > 1 && total > ttft {
                    (tokens - 1) as f64 / (total - ttft)
                } else {
                    0.0
                };
                println!(
                    "  turn: TTFT {ttft:.2}s, ~{tokens} tokens, total {total:.1}s, decode ~{decode_tps:.1} tok/s"
                );
                // Unload so next budget starts from clean state (frees K/V).
                let _ = local_llm::unload_model("kv_sweep").await;
                println!("  -> OK (unloaded)");
            }
            Err(e) => {
                println!("  load FAILED: {e}");
                // Ensure no half-state leaks to next iteration.
                let _ = local_llm::unload_model("kv_sweep").await;
            }
        }
        println!();
    }
    println!("# sweep done — compare load times and decode; for RSS compare /usr/bin/time -l 'maximum resident set size' per budget.");
}
