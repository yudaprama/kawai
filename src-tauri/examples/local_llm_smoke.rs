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

    println!(
        "loading {model} ({}:())...",
        if gpu { "gpu" } else { "cpu" }
    );
    let info = local_llm::load_model("smoke", &model, gpu)
        .await
        .expect("load_model");
    println!("loaded: {} [{}]", info.model_path, info.backend);

    let mut stream = Box::pin(local_llm::local_chat(
        "smoke".into(),
        "Say hello and introduce yourself in one sentence.".into(),
    ));
    while let Some(ev) = stream.next().await {
        match ev {
            local_llm::LocalChatEvent::Started => print!("\n[stream] "),
            local_llm::LocalChatEvent::Token { text } => print!("{text}"),
            local_llm::LocalChatEvent::Finished => println!("\n[finished]"),
            local_llm::LocalChatEvent::Error { message } => println!("\n[error] {message}"),
        }
    }

    // Second turn: proves the conversation history survives restoration.
    let mut stream = Box::pin(local_llm::local_chat(
        "smoke".into(),
        "Repeat your name exactly.".into(),
    ));
    while let Some(ev) = stream.next().await {
        if let local_llm::LocalChatEvent::Token { text } = ev {
            print!("{text}");
        }
    }
    println!("\n[turn 2 done]");
}
