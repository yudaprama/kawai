// H1 orchestration-quality eval (PLAN-local-llm-orchestrator.md L12/H9): a
// fixed 20-scenario office workload run against a .litertlm model, scored on
// tool selection, arguments, aliases, ordering, and refusal shape. One model
// load, one conversation reset per scenario. Baseline: E4B 20/20 (100%).
// Usage: cargo run --release --example agent_eval --features litert,office -- /path/to/model.litertlm
// (needs `office` for the regex crate; the scenario set mirrors the rig-components office schema)
use futures_util::StreamExt;
use kawai_lib::logic::local_llm;
use serde_json::Value;

const SYSTEM: &str = "You are a document assistant. The user's library contains these files:\n- doc1 = invoice_Q3.pdf\n- doc2 = annual_report_2025.pdf\n- doc3 = contract_v2.pdf\n";

const TOOLS: &str = r#"[
  {"type": "function", "function": {
    "name": "office_list_files",
    "description": "List all documents available in the user's knowledge library.",
    "parameters": {"type": "object", "properties": {}, "required": []}
  }},
  {"type": "function", "function": {
    "name": "knowledge_search",
    "description": "Search the user's indexed documents for relevant passages. Use for any question about document contents.",
    "parameters": {"type": "object", "properties": {
      "query": {"type": "string", "description": "Search query derived from the user's question."},
      "mode": {"type": "string", "enum": ["hybrid", "semantic", "keyword"], "description": "Retrieval mode. hybrid=default, semantic=conceptual paraphrases, keyword=exact codes/numbers/names."}
    }, "required": ["query"]}
  }},
  {"type": "function", "function": {
    "name": "pdf_replace_text",
    "description": "Replace text inside a PDF document using a regular expression. The file must be referenced by its short handle, never a raw id.",
    "parameters": {"type": "object", "properties": {
      "file": {"type": "string", "enum": ["doc1", "doc2", "doc3"], "description": "Short handle of the PDF to edit."},
      "find": {"type": "string", "description": "Regular expression matching the text to replace."},
      "replacement": {"type": "string", "description": "Replacement text."}
    }, "required": ["file", "find", "replacement"]}
  }},
  {"type": "function", "function": {
    "name": "office_create_document",
    "description": "Create a new document (docx/xlsx/pptx) from content blocks.",
    "parameters": {"type": "object", "properties": {
      "filename": {"type": "string", "description": "Output filename with extension, e.g. report.docx"},
      "blocks": {"type": "array", "items": {"type": "object"}, "description": "Content blocks: {type: paragraph|heading|bullet, text}."}
    }, "required": ["filename", "blocks"]}
  }},
  {"type": "function", "function": {
    "name": "pdf_merge",
    "description": "Merge multiple PDF documents into one, in the given order.",
    "parameters": {"type": "object", "properties": {
      "files": {"type": "array", "items": {"type": "string", "enum": ["doc1", "doc2", "doc3"]}, "description": "Ordered list of file handles to merge."},
      "output": {"type": "string", "description": "Output filename, e.g. combined.pdf"}
    }, "required": ["files", "output"]}
  }}
]"#;

/// (id, prompt, expected tool, arg asserts). Assert spec grammar:
///   "==value"      — string equality
///   "==[a,b,c]"    — list equality
///   "re:pattern"   — regex over the JSON-encoded value (for arrays/objects)
///   "in:a|b|None"  — membership; "None" accepts a missing field
struct Scenario(&'static str, &'static str, Option<&'static str>, &'static [(&'static str, &'static str)]);

const NONE: &[(&str, &str)] = &[];

const SCENARIOS: &[Scenario] = &[
    Scenario("T01 alias", "Replace every occurrence of 2025 with 2026 in the annual report.", Some("pdf_replace_text"),
        &[("file", "==doc2"), ("find", "==2025"), ("replacement", "==2026")]),
    Scenario("T02 regex-date", "In the annual report, change all dates written like 12/31/2025 into ISO format 2025-12-31.", Some("pdf_replace_text"),
        &[("file", "==doc2"), ("find", "re:\\d"), ("replacement", "re:.*")]),
    Scenario("T03 search-sem", "What does the annual report say about renewable energy?", Some("knowledge_search"),
        &[("query", "re:renewable|energy"), ("mode", "in:semantic|hybrid|None")]),
    Scenario("T04 search-code", "Find the invoice number INV-88421 in my documents.", Some("knowledge_search"),
        &[("query", "re:INV-88421|88421"), ("mode", "in:keyword|hybrid|None")]),
    Scenario("T05 list", "Which documents do I have in my library?", Some("office_list_files"), NONE),
    Scenario("T06 create-doc", "Create a Word file named summary.docx with a paragraph saying 'Q3 revenue exceeded targets'.", Some("office_create_document"),
        &[("filename", "==summary.docx"), ("blocks", "re:revenue|exceeded")]),
    Scenario("T07 merge-order", "Combine the invoice and the contract into merged.pdf, invoice first.", Some("pdf_merge"),
        &[("files", "==[doc1,doc3]"), ("output", "==merged.pdf")]),
    Scenario("T08 alias-3", "In the contract, replace the word 'Vendor' with 'Supplier' everywhere.", Some("pdf_replace_text"),
        &[("file", "==doc3"), ("find", "==Vendor"), ("replacement", "==Supplier")]),
    Scenario("T09 paraphrase", "The report discusses environmentally friendly power sources — what exactly?", Some("knowledge_search"),
        &[("query", "re:renewable|environment|power|energy")]),
    Scenario("T10 no-tool", "Who wrote the play Hamlet?", None, NONE),
    Scenario("T11 two-step-a", "First check what documents I have.", Some("office_list_files"), NONE),
    Scenario("T12 case-find", "Change 'confidential' to 'internal use only' in the contract.", Some("pdf_replace_text"),
        &[("file", "==doc3"), ("find", "re:confidential"), ("replacement", "==internal use only")]),
    Scenario("T13 filename-infer", "Make a spreadsheet called budget.xlsx with a bullet 'reduce marketing spend'.", Some("office_create_document"),
        &[("filename", "==budget.xlsx"), ("blocks", "re:marketing")]),
    Scenario("T14 search-name", "Anything in my files about payment terms?", Some("knowledge_search"),
        &[("query", "re:payment|terms")]),
    Scenario("T15 merge-3", "Merge everything into one file called all.pdf with the contract last.", Some("pdf_merge"),
        &[("files", "==[doc1,doc2,doc3]"), ("output", "==all.pdf")]),
    Scenario("T16 regex-num", "In the invoice, replace every euro amount like EUR 1.234,56 with plain 1234.56.", Some("pdf_replace_text"),
        &[("file", "==doc1"), ("find", "re:EUR|\\d"), ("replacement", "re:.*")]),
    // No delete tool exists: the correct behavior is to answer/ask, not fabricate a call.
    Scenario("T17 wrong-tool-bait", "Delete the annual report.", None, NONE),
    Scenario("T18 create-pptx", "Create pitch.pptx with the heading 'Kawai 2026'.", Some("office_create_document"),
        &[("filename", "==pitch.pptx"), ("blocks", "re:Kawai")]),
    Scenario("T19 search-sem2", "How is the company doing financially per the latest report?", Some("knowledge_search"),
        &[("query", "re:financ|revenue|result|performance")]),
    Scenario("T20 alias-1", "Show me the invoice contents about late fees.", Some("knowledge_search"),
        &[("query", "re:late|fee|invoice")]),
];

fn prompt_for(message: &str) -> String {
    format!(
        "<agent_context>\n{SYSTEM}\nAvailable tools (JSON schemas):\n{TOOLS}\n\n\
         To call a tool, reply with exactly ONE line in this format:\n\
         call:<name>{{\"arg\": \"value\", ...}}\n\
         Supply exactly the parameters listed for that tool (omit optional ones). After the call: line, STOP.\n\
         General-knowledge questions unrelated to the user's files: answer directly in plain text with NO tool call.\n\
         If no tool is needed, answer the user directly in plain text with NO call: line.\n\
         </agent_context>\n\n<user_request>\n{message}\n</user_request>"
    )
}

/// Extract the first `call:NAME{json}` line (same protocol the agent loop parses).
fn parse_call(text: &str) -> Option<Result<(String, Value), String>> {
    let line = text.lines().find(|l| l.starts_with("call:"))?;
    let rest = &line["call:".len()..];
    let open = rest.find('{')?;
    let name = rest[..open].trim().to_string();
    let json_part = &rest[open..];
    match serde_json::from_str::<Value>(json_part) {
        Ok(v) => Some(Ok((name, v))),
        Err(_) => Some(Err(format!("malformed json: {}", json_part.chars().take(60).collect::<String>()))),
    }
}

fn get<'a>(args: &'a Value, path: &str) -> Option<&'a Value> {
    args.as_object().and_then(|m| m.get(path))
}

fn check_asserts(args: &Value, asserts: &[(&str, &str)]) -> Result<(), String> {
    for (path, spec) in asserts {
        let v = get(args, path);
        if let Some(spec) = spec.strip_prefix("re:") {
            let hay = v.map(|v| v.to_string()).unwrap_or_default();
            let re = regex::Regex::new(spec).unwrap();
            if !re.is_match(&hay) {
                return Err(format!("{path}={hay} !~ {spec}"));
            }
        } else if let Some(list) = spec.strip_prefix("in:") {
            let ok: Vec<&str> = list.split('|').collect();
            let got = v.and_then(Value::as_str).unwrap_or("None");
            if !ok.contains(&got) {
                return Err(format!("{path}={got:?} not in {ok:?}"));
            }
        } else if let Some(list) = spec.strip_prefix("==[").and_then(|s| s.strip_suffix(']')) {
            let want: Vec<&str> = list.split(',').map(str::trim).collect();
            let got: Vec<String> = v
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if got != want {
                return Err(format!("{path}={got:?} != {want:?}"));
            }
        } else if let Some(want) = spec.strip_prefix("==") {
            let got = v.and_then(Value::as_str);
            if got != Some(want) {
                return Err(format!("{path}={got:?} != {want:?}"));
            }
        }
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let model = std::env::args()
        .nth(1)
        .expect("usage: agent_eval <model.litertlm>");
    let info = local_llm::load_model("eval", &model, false, false, 1, None)
        .await
        .expect("load_model");
    println!("model {} [{}]\n", info.model_path, info.backend);

    let mut pass = 0usize;
    for Scenario(id, prompt, want_tool, asserts) in SCENARIOS {
        let _ = local_llm::reset_conversation("eval").await;
        let mut text = String::new();
        let mut stream = Box::pin(local_llm::local_chat("eval".into(), prompt_for(prompt), None, None));
        while let Some(ev) = stream.next().await {
            match ev {
                local_llm::LocalChatEvent::Token { text: t } => text.push_str(&t),
                local_llm::LocalChatEvent::Finished => break,
                local_llm::LocalChatEvent::Error { message } => {
                    text.push_str(&format!("[STREAM_ERROR] {message}"));
                    break;
                }
                _ => {}
            }
        }
        let call = parse_call(&text);
        let (ok, note) = match (want_tool, &call) {
            (None, Some(c)) => (
                false,
                match c {
                    Ok((name, _)) => format!("no-call expected, got call:{name}"),
                    Err(e) => format!("no-call expected, got malformed ({e})"),
                },
            ),
            (None, None) => (true, "no call, as expected".into()),
            (Some(want), None) => (false, format!("no call emitted (want {want})")),
            (Some(want), Some(Err(e))) => (false, format!("malformed call: {e}")),
            (Some(want), Some(Ok((name, args)))) => {
                if name != *want {
                    (false, format!("tool={name} want={want}"))
                } else {
                    match check_asserts(args, asserts) {
                        Ok(()) => (true, "args ok".into()),
                        Err(e) => (false, e),
                    }
                }
            }
        };
        if ok {
            pass += 1;
        }
        println!("{} {id:18} {note}", if ok { "PASS" } else { "FAIL" });
    }
    println!("\n== {pass}/{} pass ({:.0}%)", SCENARIOS.len(), 100.0 * pass as f64 / SCENARIOS.len() as f64);
}
