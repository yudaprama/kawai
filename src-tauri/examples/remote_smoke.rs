// Headless smoke test for the hybrid-tier cloud subagent path (logic::remote).
// Exercises: env resolution (vault-fallback zai or explicit env) → one streamed
// completion → per-token deltas → terminal usage record. No local model needed.
//
// Usage:
//   cargo run --example remote_smoke                # default tiny task
//   cargo run --example remote_smoke -- "your task" # custom task
//   KAWAI_REMOTE_LLM_PROVIDER=off cargo run --example remote_smoke  # expect: disabled
use futures_util::StreamExt;
use kawai_lib::logic::remote::{RemoteEvent, RemoteLlm};

const SYSTEM: &str = "You are a terse technical writer. Answer in clean markdown, no preamble.";
const DEFAULT_TASK: &str =
    "In exactly two sentences, explain why an on-device LLM might delegate long-form writing to a cloud model.";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();

    let Some(remote) = RemoteLlm::from_env() else {
        println!("[remote_smoke] remote tier DISABLED (unset/off/no key) — this is the graceful-degradation path: OK");
        return;
    };
    println!("[remote_smoke] provider: {}", remote.provider_label());

    let task = std::env::args().nth(1).unwrap_or_else(|| DEFAULT_TASK.into());
    let materials = "Context: the on-device model is a 2B-parameter CPU model; the cloud model is a large hosted model.";

    let t0 = std::time::Instant::now();
    let stream = remote
        .stream(SYSTEM, &task, materials)
        .await
        .expect("stream() failed to start");
    let mut stream = Box::pin(stream);
    let mut chars = 0;
    let mut usage = None;
    while let Some(ev) = stream.next().await {
        match ev {
            Ok(RemoteEvent::Token { text }) => {
                chars += text.chars().count();
                print!("{text}");
            }
            Ok(RemoteEvent::Done { usage: u }) => usage = Some(u),
            Err(e) => {
                println!("\n[remote_smoke] stream error: {e}");
                std::process::exit(1);
            }
        }
    }
    println!();
    match usage {
        Some(u) => println!(
            "[remote_smoke] done in {:.1}s · {chars} chars · usage: in={} out={} tokens (zeros = provider reported none)",
            t0.elapsed().as_secs_f64(),
            u.input_tokens,
            u.output_tokens
        ),
        None => println!("[remote_smoke] stream ended without a terminal record"),
    }
}
