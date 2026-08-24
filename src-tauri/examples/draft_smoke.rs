// Headless smoke test for the draft_document cloud subagent path: cloud
// composes structured blocks JSON → extract_draft_blocks validates → the
// office writer creates the real file → receipt. Exercises everything except
// the local-model fence (the loop dispatch is covered by unit tests).
//
// Usage: cargo run --example draft_smoke --features litert,office
use futures_util::StreamExt;
use kawai_lib::logic::agent::extract_draft_blocks;
use kawai_lib::logic::remote::{RemoteEvent, RemoteLlm};

// Mirrors DRAFT_DOCUMENT_SYSTEM in logic/agent.rs (kept in sync by hand).
const DRAFT_SYSTEM: &str = "You compose document content as structured JSON for an office file writer. \
Rules:\n\
- Output ONLY one JSON object, exactly {\"blocks\": [...]}. No markdown, no code fence, no commentary.\n\
- Block types (in document order): {\"type\":\"title\",\"text\":\"...\"} | {\"type\":\"heading\",\"text\":\"...\",\"level\":1} | {\"type\":\"paragraph\",\"text\":\"...\"} | {\"type\":\"bullets\",\"items\":[\"...\"]} | {\"type\":\"table\",\"rows\":[[\"a\",\"b\"]]}\n\
- Ground content in the provided materials when given; use general knowledge only to fill gaps.\n\
- Be substantive: full paragraphs, real headings, complete tables — the writer will not edit or extend your content.\n\
- If materials are insufficient for part of the task, complete the rest and add a short paragraph noting the gap.";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    kawai_lib::auth::load_dotenv();
    // Office store under /tmp — keeps the smoke test out of real user data.
    std::env::set_var("KAWAI_DATA_DIR", "/tmp/kawai-smoke");

    let Some(remote) = RemoteLlm::from_env() else {
        println!("[draft_smoke] remote tier DISABLED — nothing to test, OK");
        return;
    };
    println!("[draft_smoke] pool primary: {}", remote.provider_label());

    let task = "Compose a one-page project-update document titled 'Hybrid LLM Update' with sections: \
What Shipped (bullets), Results (table with metric/value rows), Next Steps (bullets), and a closing paragraph.";
    let materials = "Shipped: deep_write subagent, draft_document subagent, turn_log telemetry. \
Results: cloud smoke 3.6s, 193 output tokens; local tests 40/40. Next: calibration, GUI badge.";

    let t0 = std::time::Instant::now();
    // One retry: a cloud stream can drop mid-generation after the failover
    // boundary (first text token) — truncated JSON is a transient provider
    // flake, not a regression.
    let mut blocks = None;
    for attempt in 1..=2 {
        let mut raw = String::new();
        let mut usage = None;
        let mut winner = String::new();
        let mut hit_cap = false;
        let stream = remote
            .stream(DRAFT_SYSTEM, task, materials)
            .await
            .expect("stream");
        let mut stream = Box::pin(stream);
        while let Some(ev) = stream.next().await {
            match ev {
                Ok(RemoteEvent::Token { text }) => raw.push_str(&text),
                Ok(RemoteEvent::Reasoning { .. }) => {}
                Ok(RemoteEvent::Done {
                    usage: u,
                    provider,
                    hit_cap: c,
                }) => {
                    usage = Some(u);
                    winner = provider;
                    hit_cap = c;
                }
                Err(e) => {
                    println!("[draft_smoke] stream error: {e}");
                    std::process::exit(1);
                }
            }
        }
        println!(
            "[draft_smoke] attempt {attempt} done in {:.1}s · served by {winner} · {} chars · usage in={:?} out={:?} · hit_cap={hit_cap}",
            t0.elapsed().as_secs_f64(),
            raw.chars().count(),
            usage.map(|u| u.input_tokens),
            usage.map(|u| u.output_tokens)
        );

        match extract_draft_blocks(raw.trim()) {
            Ok(b) => {
                blocks = Some(b);
                break;
            }
            Err(e) if attempt == 1 => {
                println!("[draft_smoke] JSON invalid ({e}) — retrying once\n--- raw ---\n{raw}");
            }
            Err(e) => {
                println!("[draft_smoke] JSON invalid after retry: {e}\n--- raw ---\n{raw}");
                std::process::exit(1);
            }
        }
    }
    let blocks = blocks.expect("blocks parsed");
    println!("[draft_smoke] parsed {} blocks", blocks.len());

    let file = kawai_lib::logic::office::ooxml::create_document_from_blocks(
        "smoke",
        "hybrid-update.docx",
        &blocks,
    )
    .await
    .expect("write docx");
    println!(
        "[draft_smoke] receipt: {{\"success\":true,\"file\":{{\"id\":\"{}\",\"name\":\"{}\"}},\"blocks\":{}}}",
        file.id, file.original_name, blocks.len()
    );
}
