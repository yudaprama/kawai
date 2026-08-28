// One-shot reproduction of the user's exact chat prompt through the production
// `agent_chat` path: does the on-device model (E4B) delegate to deep_write, or
// answer locally? Prints the tool call (if any) so we can see routing fire.
//
//   cd src-tauri && env \
//     RUSTFLAGS="-C link-arg=-Wl,-rpath,<ABS>/cognee-litert-lm/native" \
//     LITERT_LM_LIB_DIR=<ABS>/cognee-litert-lm/native \
//     LLVM_PROFILE_FILE=/dev/null \
//     KAWAI_DATA_DIR=/tmp/kawai-route-check \
//     cargo run --example chat_route_check --features litert,office
use futures_util::StreamExt;
use kawai_lib::logic::agent::{agent_chat_with_registry, AgentChatEvent};
use kawai_lib::logic::{db, local_llm};

const SMOKE_USER: &str = "route-check";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    std::env::set_var("KAWAI_DATA_DIR", "/tmp/kawai-route-check");

    let model = kawai_lib::logic::resolve_model_path().expect("model path");
    println!("loading {model}…");
    let info = local_llm::load_model(SMOKE_USER, &model, false, false, 0, None)
        .await
        .expect("load_model");
    println!("loaded: {} [{}]\n", info.model_path, info.backend);

    let prompt = "Tolong buatkan analisis mendalam tentang tren AI agent 2026, sekitar 3 paragraf";

    let mut stream = Box::pin(agent_chat_with_registry(
        kawai_lib::agent_registry::builtin(),
        SMOKE_USER.into(),
        "builtin.office".into(),
        None,
        prompt.into(),
        Vec::new(),
    ));
    let mut answer = String::new();
    let mut tool: Option<String> = None;
    let mut thinking = 0usize;
    let mut thinking_provider = String::new();
    while let Some(ev) = stream.next().await {
        match ev {
            AgentChatEvent::ToolCall { tool: t, .. } => {
                println!("[tool_call {t}]");
                tool = Some(t);
            }
            AgentChatEvent::SubagentThinking { provider, text } => {
                if thinking == 0 {
                    thinking_provider = provider.clone();
                    println!("[subagent_thinking streaming ({provider})]");
                }
                thinking = text.chars().count();
            }
            AgentChatEvent::Token { text } => answer.push_str(&text),
            AgentChatEvent::Finished => println!("[finished]"),
            AgentChatEvent::Error { message } => println!("[ERROR {message}]"),
            _ => {}
        }
    }
    println!("── RESULT ──");
    println!("delegated_to_cloud = {}", tool.as_deref().unwrap_or("-"));
    println!("subagent thinking = {thinking} chars (last provider: {thinking_provider})",);
    println!(
        "local answer ({} chars): {}",
        answer.chars().count(),
        &answer.chars().take(200).collect::<String>()
    );

    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
        - 3600;
    for r in db::list_turn_log(SMOKE_USER, since)
        .await
        .unwrap_or_default()
    {
        println!(
            "turn_log: {} / {} · {} · {:?}ms",
            r.provider,
            r.tool.as_deref().unwrap_or("-"),
            r.outcome,
            r.latency_ms
        );
    }
}
