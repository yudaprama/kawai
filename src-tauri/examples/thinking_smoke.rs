// Headless experiment: does enabling thinking improve tool-call arg fidelity
// for the local Gemma model? Feeds the exact failure scenario from session 20
// (copy a long file id into a call: argument) with thinking ON and OFF and
// prints the model's emitted text + any Thinking events, so we can compare
// id-accuracy and latency.
//
// Usage:
//   cargo run --example thinking_smoke --features litert -- /path/to/model.litertlm [--think]
use futures_util::StreamExt;
use kawai_lib::logic::local_llm;
use std::time::Instant;

const PROMPT: &str = "You are an office assistant. A tool result gave you a file id. \
Call the tool office_read_document with that exact id.
Tool result: office_list_files returned file id \"f87366129058607000-0000\" (name 06.pdf).
Now call office_read_document with that id. Reply with ONLY a tool call: call:office_read_document{\"fileId\":\"<the id>\"}";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = args
        .get(1)
        .expect("usage: thinking_smoke <model.litertlm> [--think]")
        .clone();
    let think = args.iter().any(|a| a == "--think");

    println!("loading {model} ...");
    let info = local_llm::load_model("smoke", &model, false, false, 1, None)
        .await
        .expect("load_model");
    println!("loaded: {} [{}]", info.model_path, info.backend);

    println!(
        "\n=== thinking = {} ===\n",
        if think { "ON" } else { "OFF" }
    );
    if think {
        local_llm::set_thinking("smoke", true);
    }
    // Fresh conversation so the toggle state is applied from the first turn.
    local_llm::reset_conversation("smoke").await.ok();

    let start = Instant::now();
    let mut stream = Box::pin(local_llm::local_chat(
        "smoke".into(),
        PROMPT.into(),
        None,
        None,
        false, // already reset explicitly above
    ));
    let mut saw_thinking = false;
    let mut saw_call = false;
    while let Some(ev) = stream.next().await {
        match ev {
            local_llm::LocalChatEvent::Thinking { text } => {
                saw_thinking = true;
                eprintln!("[thinking] {text}");
            }
            local_llm::LocalChatEvent::Token { text } => {
                if text.contains("call:") {
                    saw_call = true;
                }
                print!("{text}");
                use std::io::Write;
                std::io::stdout().flush().ok();
            }
            local_llm::LocalChatEvent::Finished => println!("\n[finished]"),
            local_llm::LocalChatEvent::Error { message } => println!("\n[error] {message}"),
            _ => {}
        }
    }
    let elapsed = start.elapsed();
    println!(
        "\n--- result: thinking_seen={saw_thinking} call_emitted={saw_call} elapsed={elapsed:?} ---"
    );
}
