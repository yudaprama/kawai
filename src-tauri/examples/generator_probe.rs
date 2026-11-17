// THROWAWAY probe for the builtin.generator toolset — delete after the
// real-path proof. NOT registered in Cargo.toml; runs on default features.
//
// 1. builds the toolset for the signed-in desktop user (bearer gate),
// 2. prints the chat confirmation prompt the user would see,
// 3. runs ONE cheap image generation end-to-end (submit → poll → store),
// 4. runs the video two-phase lane: whatif cost → submit → fetch (poll to
//    terminal, store the artifact), skipped when the whatif exceeds 100 Buzz.
use kawai_lib::logic::civitai_tools;
use kawai_paths::{auth_token, data_root};

fn user_from_last_session() -> String {
    // Headless: the Tauri shell normally injects the app-data dir — do it
    // here, pointed at the real install.
    kawai_paths::set_data_root(std::env::var("KAWAI_APP_DATA")
        .expect("KAWAI_APP_DATA (the app's Application Support dir)"));
    let pointer = data_root().join("last_session");
    let email = std::fs::read_to_string(&pointer).expect("last_session pointer").trim().to_string();
    assert!(auth_token(&email).exists(), "no stored bearer for {email}");
    email
}

fn main() {
    let user = user_from_last_session();
    println!("user: {user}");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        let set = civitai_tools::toolset(&user).expect("generation toolset (key + bearer)");
        println!("tools: {:?}", set.get_tool_definitions().iter().map(|d| d.name.clone()).collect::<Vec<_>>());

        // The chat confirmation surface, verbatim.
        let def = civitai_tools::definition();
        let image_args = serde_json::json!({
            "prompt": "a tiny red paper boat on a calm blue sea, minimalist",
            "width": 512,
            "height": 512,
            "steps": 20,
        });
        if let Some(c) = (def.confirmation_for_tool)("civitai_generate_image", &image_args) {
            println!("confirmation: {}\n  accept={} decline={}", c.prompt, c.accept_text, c.decline_text);
        } else {
            panic!("image tool lost its confirmation prompt");
        }

        // ── lane 1: one-shot image ──────────────────────────────────────
        let image = set.execute("civitai_generate_image", image_args.to_string()).await;
        println!("image ok={} body={}", image.is_success(), image.text().unwrap_or_else(|| image.error_message().unwrap_or("")));

        // ── lane 2: video submit → fetch ────────────────────────────────
        let video_req = serde_json::json!({
            "ecosystem": "minimax",
            "prompt": "the paper boat drifts left as a wave passes under it",
            "duration": 5,
        });
        let cost = kawai_lib::logic::civitai::civitai_video_cost(
            serde_json::from_value(video_req.clone()).unwrap(),
        )
        .await
        .expect("video whatif");
        println!("video whatif: {:?} buzz, {} tokens, ready={}", cost.total_buzz, cost.total_tokens, cost.ready);
        if cost.total_buzz > 100.0 {
            println!("SKIP video submit — whatif above the 100-Buzz guard");
            return;
        }

        let submitted = set.execute("civitai_video_submit", video_req.to_string()).await;
        let submit_body = submitted.text().expect("video submit ok").to_string();
        println!("video submit: {submit_body}");
        let workflow_id = serde_json::from_str::<serde_json::Value>(&submit_body)
            .expect("submit json")["workflowId"]
            .as_str()
            .expect("workflowId")
            .to_string();

        // Second "turn": the fetch takes ONLY the workflowId.
        let fetched = set
            .execute("civitai_video_fetch", serde_json::json!({ "workflowId": workflow_id }).to_string())
            .await;
        println!(
            "video fetch ok={} body={}",
            fetched.is_success(),
            fetched.text().unwrap_or_else(|| fetched.error_message().unwrap_or(""))
        );
    });
}
