// Headless smoke test for the kawai local-LLM path.
// Usage: cargo run --example local_llm_smoke --features litert -- /path/to/model.litertlm
use futures_util::StreamExt;
use kawai_lib::logic::local_llm;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let model = std::env::args()
        .nth(1)
        .expect("usage: local_llm_smoke <model.litertlm>");
    let gpu = std::env::args().any(|a| a == "--gpu");

    let kv = std::env::var("KAWAI_LLM_MAX_TOKENS").unwrap_or_else(|_| "16384 (default)".into());
    println!(
        "loading {model} ({}) K/V={kv} ...",
        if gpu { "gpu" } else { "cpu" }
    );
    let t_load = std::time::Instant::now();
    let info = local_llm::load_model("smoke", &model, gpu, false, 1, None)
        .await
        .expect("load_model");
    println!(
        "loaded: {} [{}] in {:.1}s (RSS: measure via /usr/bin/time -l or scripts/kv_sweep.sh)",
        info.model_path,
        info.backend,
        t_load.elapsed().as_secs_f64()
    );

    let t0 = std::time::Instant::now();
    let mut ttft: Option<f64> = None;
    let mut tokens = 0usize;
    let mut chars = 0usize;
    let mut stream = Box::pin(local_llm::local_chat(
        "smoke".into(),
        "Say hello and introduce yourself in one sentence.".into(),
        None,
        None,
        true, // turn 1: fresh context
    ));
    while let Some(ev) = stream.next().await {
        match ev {
            local_llm::LocalChatEvent::Started => print!("\n[stream] "),
            local_llm::LocalChatEvent::Token { text } => {
                if ttft.is_none() {
                    ttft = Some(t0.elapsed().as_secs_f64());
                }
                tokens += 1;
                chars += text.chars().count();
                print!("{text}")
            }
            local_llm::LocalChatEvent::Finished => println!("\n[finished]"),
            local_llm::LocalChatEvent::Error { message } => println!("\n[error] {message}"),
            local_llm::LocalChatEvent::Thinking { .. } => {}
            local_llm::LocalChatEvent::ToolCall { .. } => {}
            local_llm::LocalChatEvent::ToolResult { .. } => {}
        }
    }
    let elapsed = t0.elapsed().as_secs_f64();
    println!(
        "[smoke] turn1: TTFT {:.2}s, {} tokens (est) / {} chars, total {:.1}s, decode ~{:.1} tok/s",
        ttft.unwrap_or(elapsed),
        tokens,
        chars,
        elapsed,
        if elapsed > 0.0 {
            tokens as f64 / elapsed
        } else {
            0.0
        }
    );

    // Second turn: proves the conversation history survives restoration and
    // that the generation gate still serializes calls.
    let mut stream = Box::pin(local_llm::local_chat(
        "smoke".into(),
        "Repeat your name exactly.".into(),
        None,
        None,
        false, // turn 2: prove conversation history survives
    ));
    while let Some(ev) = stream.next().await {
        if let local_llm::LocalChatEvent::Token { text } = ev {
            print!("{text}");
        }
    }
    println!("\n[turn 2 done]");
}
