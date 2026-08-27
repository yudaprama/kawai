//! Cloud subagent tool implementations: DeepWrite, DraftDocument, ArtifactRecall.
//!
//! Registered in the agent's `ToolSet` manifest but `call()` is NEVER reached —
//! the agent loop intercepts by name before rig dispatch. Implementations exist
//! only so the tool manifest and arg schemas render correctly.

use kawai_tools::AgentTool;
use serde::Deserialize;
use serde_json::Value;

use super::constants::*;

// ── DeepWrite ───────────────────────────────────────────────────────────────

#[cfg(feature = "litert")]
pub struct DeepWrite;

#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct DeepWriteArgs {
    pub task: String,
    pub materials: Option<String>,
}

#[cfg(feature = "litert")]
impl AgentTool for DeepWrite {
    const NAME: &'static str = DEEP_WRITE_TOOL;
    type Args = DeepWriteArgs;
    type Output = String;
    type Error = std::convert::Infallible;

    fn description(&self) -> String {
        "Delegate long-form writing to a powerful cloud writer. Use for reports, comparisons, \
         drafts, long analyses — anything needing depth beyond a short reply. The result is \
         streamed to the user as the final answer; you will not write it yourself."
            .into()
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What to write: the complete brief — audience, structure, focus, approximate length." },
                "materials": { "type": "string", "description": "Optional one-line pointer (tool results are attached automatically — never paste excerpts or long text). Omit for general-knowledge writing." }
            },
            "required": ["task"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        Ok(
            "ERROR: deep_write is dispatched internally and is unavailable here. Answer directly."
                .into(),
        )
    }
}

// ── DraftDocument ───────────────────────────────────────────────────────────

#[cfg(all(feature = "litert", feature = "office"))]
pub struct DraftDocument;

#[cfg(all(feature = "litert", feature = "office"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftDocumentArgs {
    pub task: String,
    pub filename: String,
    pub materials: Option<String>,
}

#[cfg(all(feature = "litert", feature = "office"))]
impl AgentTool for DraftDocument {
    const NAME: &'static str = DRAFT_DOCUMENT_TOOL;
    type Args = DraftDocumentArgs;
    type Output = String;
    type Error = std::convert::Infallible;

    fn description(&self) -> String {
        "Compose a real document (docx/xlsx/pptx) in the cloud and write it to the user's store. \
Use for documents with real composed content: reports, proposals, summaries built from the user's files (NOT presentation decks — those go to office_create_deck). \
You provide the brief, the gathered materials and the filename; the writer composes the full content and the file is created for you."
            .into()
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What to write: audience, structure, focus, approximate length." },
                "filename": { "type": "string", "description": "Output filename ending in .docx, .xlsx or .pptx, e.g. report.docx" },
                "materials": { "type": "string", "description": "Optional one-line pointer (tool results are attached automatically — never paste excerpts or long text). Omit for general-knowledge documents." }
            },
            "required": ["task", "filename"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        Ok("ERROR: draft_document is dispatched internally and is unavailable here. Use office_create_document or answer directly.".into())
    }
}

// ── ArtifactRecall ──────────────────────────────────────────────────────────

#[cfg(feature = "litert")]
pub struct ArtifactRecall;

#[cfg(feature = "litert")]
#[derive(Deserialize)]
#[allow(dead_code)]
pub struct ArtifactRecallArgs {
    pub handle: String,
    pub offset: Option<u64>,
}

#[cfg(feature = "litert")]
impl AgentTool for ArtifactRecall {
    const NAME: &'static str = ARTIFACT_RECALL_TOOL;
    type Args = ArtifactRecallArgs;
    type Output = String;
    type Error = std::convert::Infallible;

    fn description(&self) -> String {
        "Read a stored slice of an oversized tool result from THIS turn. When a tool response says \
         '[stored as memN — N chars total]', call this with that handle to page through the full \
         content (3600 chars per call)."
            .into()
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "handle": { "type": "string", "description": "Stored-output handle, e.g. mem1" },
                "offset": { "type": "integer", "description": "Char offset to read from (default 0)" }
            },
            "required": ["handle"]
        })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
        Ok("ERROR: artifact_recall is dispatched internally and is unavailable here. Answer directly.".into())
    }
}

// ── PendingSubagent ─────────────────────────────────────────────────────────

#[cfg(feature = "litert")]
pub struct PendingSubagent {
    pub tool: String,
    pub task: String,
    pub materials: String,
    /// draft_document only — output filename (validated by the office store).
    pub filename: Option<String>,
    pub escalated: bool,
}

// ── extract_draft_blocks + parse_with_brace_repair ──────────────────────────

/// Strip code fences / prose and parse the draft JSON into document blocks.
#[cfg(all(feature = "litert", feature = "office"))]
pub fn extract_draft_blocks(
    raw: &str,
) -> Result<Vec<crate::logic::office::ooxml::DocBlock>, String> {
    let unfenced = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: Value = match parse_with_brace_repair(unfenced) {
        Ok(v) => v,
        Err(e) => return Err(format!("not valid JSON: {e}")),
    };
    let blocks_value = match &value {
        Value::Array(_) => value.clone(),
        Value::Object(_) => value.get("blocks").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    };
    serde_json::from_value::<Vec<crate::logic::office::ooxml::DocBlock>>(blocks_value)
        .map_err(|e| format!("blocks failed schema validation: {e}"))
}

/// Parse a draft payload, recovering from a recurring provider quirk: an
/// extra `}` emitted right after a nested block. Whole-string first; then
/// prose-carve (first `{` to last `}`); then try deleting one `}` from each
/// `}}` pair in turn.
#[cfg(all(feature = "litert", feature = "office"))]
fn parse_with_brace_repair(unfenced: &str) -> Result<Value, String> {
    if let Ok(v) = serde_json::from_str::<Value>(unfenced) {
        return Ok(v);
    }
    let carved = match (unfenced.find('{'), unfenced.rfind('}')) {
        (Some(a), Some(b)) if b > a => &unfenced[a..=b],
        _ => unfenced,
    };
    let mut last_err = match serde_json::from_str::<Value>(carved) {
        Ok(v) => return Ok(v),
        Err(e) => e.to_string(),
    };
    let mut repaired = carved.to_string();
    while let Some(pos) = repaired.rfind("}}") {
        repaired.remove(pos + 1);
        match serde_json::from_str::<Value>(&repaired) {
            Ok(v) => return Ok(v),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

/// Parse a staging response into (handle, offset) requests.
#[cfg(feature = "litert")]
pub fn parse_staging_requests(raw: &str) -> Option<Vec<(String, usize)>> {
    let trimmed = raw.trim();
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end < start {
        return None;
    }
    let value: Value = serde_json::from_str(&trimmed[start..=end]).ok()?;
    let reqs = value.get("requests")?.as_array()?;
    let mut out = Vec::new();
    for r in reqs {
        let handle = r.get("handle")?.as_str()?.trim();
        if handle.is_empty() {
            return None;
        }
        let offset = r.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
        out.push((handle.to_string(), offset));
    }
    (!out.is_empty()).then_some(out)
}

// ── System prompt constants ─────────────────────────────────────────────────

/// Persona of the deep_write subagent (the cloud writer). Runs on the remote
/// model — it never sees the chat history, only the task + materials package.
#[cfg(feature = "litert")]
pub const DEEP_WRITE_SYSTEM: &str = "You are a long-form analytical writer embedded in an on-device assistant. \
Write the requested artifact from the task brief and the provided materials. \
Rules:\n\
- Ground every claim in the materials when they are provided; use general knowledge only to fill gaps.\n\
- If the materials are insufficient for part of the task, complete the rest and note the gap briefly.\n\
- Output ONLY the requested artifact in clean markdown. No preamble, no meta commentary, no code fences around the whole answer (inner ```mermaid fences for diagrams are allowed and required when a diagram is needed).\n\
- Diagrams/flowcharts (flowchart, sequence, class, state, ER, gantt, pie, mindmap, timeline, etc.): output a valid ```mermaid code fence — it renders as SVG in the UI. Never use ASCII art.\n\
- Math (KaTeX): use LaTeX — \\(...\\) for inline, $$...$$ or \\[...\\] for display. Single $...$ is NOT supported for inline — use \\(...\\) instead.\n\
- Match the requested structure, audience and length from the task brief.";

/// Staging persona for the deep_write two-phase round. When the base package
/// carried omissions, the cloud writer FIRST states what else it needs (or
/// that it is ready) — the resolved slices ride into the real writing call,
/// so composition never starts from a knowingly incomplete package.
#[cfg(feature = "litert")]
pub const DEEP_WRITE_STAGING_SYSTEM: &str = "You are staging context for a long-form writing task. You receive the task brief \
and PARTIAL materials; a [MATERIALS NOTE] lists stored results that were omitted from this package. \
Reply with ONLY one JSON object, nothing else:\n\
- Need more context? {\"requests\": [{\"handle\": \"memN\", \"offset\": 0}]} — up to 6 entries; each returns ~3600 chars read forward from offset (offset 0 = the start).\n\
- The included materials already suffice? {\"ready\": true}";

/// Persona of the draft_document subagent (the cloud composer). Returns
/// STRUCTURED JSON only — never prose; the block vocabulary is identical to
/// `office_create_document` so the office writer consumes it directly.
#[cfg(feature = "litert")]
pub const DRAFT_DOCUMENT_SYSTEM: &str = "You compose document content as structured JSON for an office file writer. \
Rules:\n\
- Output ONLY one JSON object, exactly {\"blocks\": [...]}. No markdown, no code fence, no commentary.\n\
- Block types (in document order): {\"type\":\"title\",\"text\":\"...\"} | {\"type\":\"heading\",\"text\":\"...\",\"level\":1} | {\"type\":\"paragraph\",\"text\":\"...\"} | {\"type\":\"bullets\",\"items\":[\"...\"]} | {\"type\":\"table\",\"rows\":[[\"a\",\"b\"]]}
\
- Ground content in the provided materials when given; use general knowledge only to fill gaps.\n\
- Be substantive: full paragraphs, real headings, complete tables — the writer will not edit or extend your content.\n\
- Ground every claim in the materials when they are provided; use general knowledge only to fill gaps.\n\
- If materials are insufficient for part of the task, complete the rest and add a short paragraph noting the gap.";
