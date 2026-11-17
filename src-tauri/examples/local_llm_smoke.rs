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

    // Third: cancel mid-generation. Start a long generation, drop the stream
    // after the first token, and prove the backend recovers: the detached
    // blocking task issues the native cancel_process, replaces the
    // cancelled-turn conversation with a fresh one (conversation epoch bump —
    // a cancelled turn leaves a partial assistant prefix in the KV cache),
    // and the next request streams normally instead of erroring with
    // "a generation is already running". fresh=false so the epoch bump below
    // can only come from the cancel-replacement swap.
    let epoch_before = local_llm::conversation_epoch();
    let mut cancelled_run = false;
    {
        let mut stream = Box::pin(local_llm::local_chat(
            "smoke".into(),
            "Write a 400-word story about a lighthouse keeper. Be thorough and descriptive."
                .into(),
            None,
            None,
            false,
        ));
        while let Some(ev) = stream.next().await {
            if matches!(ev, local_llm::LocalChatEvent::Token { .. }) {
                cancelled_run = true;
                // Break + drop the pinned stream: consumer gone mid-generation.
                break;
            }
        }
    }
    let t_cancel = std::time::Instant::now();
    let mut replaced = false;
    for _ in 0..150 {
        if local_llm::conversation_epoch() > epoch_before {
            replaced = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    println!(
        "[cancel] dropped stream mid-generation={cancelled_run}; conversation replaced in {:.1}s (replaced={replaced})",
        t_cancel.elapsed().as_secs_f64()
    );
    if cancelled_run && !replaced {
        // The cancel path is deterministic once a token arrived before the
        // drop — a 15s window is generous for cancel_process + terminal
        // callback + fresh swap. Fail loudly rather than silently skip.
        panic!("[cancel] stream was dropped mid-generation but the conversation was never replaced (epoch stuck at {epoch_before})");
    }
    if !cancelled_run {
        println!("[cancel] generation finished before the drop landed; cancel path not exercised");
    }

    // Fourth: prove the pipeline still streams after the cancelled turn.
    let mut stream = Box::pin(local_llm::local_chat(
        "smoke".into(),
        "Say OK.".into(),
        None,
        None,
        false,
    ));
    while let Some(ev) = stream.next().await {
        match ev {
            local_llm::LocalChatEvent::Error { message } => {
                panic!("[cancel] post-cancel turn errored: {message}")
            }
            local_llm::LocalChatEvent::Token { text } => print!("{text}"),
            _ => {}
        }
    }
    println!("\n[turn 3 done]");
}
