//! Office document tooling.
//!
//! Pure logic — no tauri/axum imports.
//!   - `pdf_oxide`   (vendored ../pdf_oxide)     — PDF ops, pure Rust, in-process
//!   - `office_oxide`(vendored ../office_oxide)  — document CREATE + READ +
//!     EDIT + INFO, pure Rust, in-process (markdown → IR → docx/xlsx/pptx,
//!     and raw-part surgery for in-place edits). No external engine.
//!
//! Files live in a per-user on-disk store addressed ONLY by opaque file ids —
//! path traversal is impossible by construction.
//!
//! Tools implement rig's `PortableTool` so the agent loop dispatches them
//! through a `rig::tool::ToolSet`.

pub mod error;
pub mod ooxml;
pub mod pdf;
pub mod store;
pub mod tools;

use rig::tool::ToolSet;
use serde::Serialize;

pub use error::OfficeToolError;
pub use ooxml::read_document;
pub use store::{export_file, file_path, import_base64, import_bytes, import_path, list_files, read_file_b64};
pub use store::{OfficeFile, ReadFileResult, ReadDocumentResult};

// ── capability probe ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCapabilities {
    pub available: bool,
    pub pdfcli: bool,
}

/// Probe which engines are present. Document creation, reading, editing, and
/// info are all pure Rust via `office_oxide` (in-process). PDF is in-process
/// via `pdf_oxide` — always available.
pub fn capabilities() -> OfficeCapabilities {
    OfficeCapabilities {
        available: true,
        pdfcli: true,
    }
}

// ── helpers shared by tools ─────────────────────────────────────────────────

macro_rules! schema {
    ($($json:tt)*) => {
        json!($($json)*)
    };
}
pub(crate) use schema;

pub(crate) fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

// ── knowledge context (composer @-mention injection) ────────────────────────

/// Per-file and total character caps for injected document context. Local
/// models have small context windows; these keep one @-mentioned document (or
/// a handful) usable without silently blowing the prompt.
const KNOWLEDGE_PER_FILE_CAP: usize = 12_000;
const KNOWLEDGE_TOTAL_CAP: usize = 36_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeContext {
    /// Ready-to-prepend context block (empty string when nothing was resolved).
    pub context: String,
    /// The files actually included, in the order they appear in the block.
    pub files: Vec<OfficeFile>,
}

/// Extract and concatenate the text of the given stored files into a single
/// context block for prompt injection. PDFs go through `pdf_extract_text`,
/// OOXML through `read_document` (markdown). Files that fail to resolve are
/// skipped (a missing engine or file must not block the chat turn).
pub async fn knowledge_context(
    user_id: &str,
    file_ids: &[String],
) -> Result<KnowledgeContext, String> {
    let mut files = Vec::new();
    let mut sections = Vec::new();
    let mut used = 0usize;

    for id in file_ids {
        if used >= KNOWLEDGE_TOTAL_CAP {
            break;
        }
        let (_, info) = match store::resolve(user_id, id) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let text = if info.ext == "pdf" {
            pdf::pdf_extract_text(user_id, id, None).await.ok()
        } else {
            ooxml::read_document(user_id, id).await.ok()
        };
        let Some(text) = text else { continue };
        let remaining_total = KNOWLEDGE_TOTAL_CAP - used;
        let cap = KNOWLEDGE_PER_FILE_CAP.min(remaining_total);
        let body = truncate_chars(&text, cap);
        used += body.chars().count();
        sections.push(format!(
            "── {} (.{}) ──\n{}",
            info.original_name, info.ext, body
        ));
        files.push(info);
    }

    let context = if sections.is_empty() {
        String::new()
    } else {
        format!(
            "Reference documents follow (user-selected):\n\n{}\n\nEnd of reference documents.",
            sections.join("\n\n")
        )
    };
    Ok(KnowledgeContext { context, files })
}

// ── toolset builder ─────────────────────────────────────────────────────────

pub struct OfficeTools {
    user_id: String,
}

/// Build the office ToolSet for one user + session, filtered by the capability
/// probe — tools without engines are never registered (never offered to the
/// model). Create is always available (pure Rust). `knowledge_search` is
/// session-scoped: it only sees documents this session uploaded
/// (`session_files`).
pub fn toolset(user_id: &str, session_id: i64) -> ToolSet {
    let t = OfficeTools {
        user_id: user_id.to_string(),
    };
    let mut set = ToolSet::default();
    set.add_tool(tools::ListFilesTool(t.user_id.clone()));
    set.add_tool(tools::KnowledgeSearchTool(
        t.user_id.clone(),
        session_id,
    ));
    set.add_tool(tools::CreateDocumentTool(t.user_id.clone()));
    // ReadDocumentTool is pure-Rust (office_oxide); always available.
    set.add_tool(tools::ReadDocumentTool(t.user_id.clone()));
    // Document info + edit are pure-Rust via office_oxide — always available.
    set.add_tool(tools::DocumentInfoTool(t.user_id.clone()));
    set.add_tool(tools::EditDocumentTool(t.user_id.clone()));
    // Edit undo — swaps the stored file with its pre-edit snapshot.
    set.add_tool(tools::RestoreBackupTool(t.user_id.clone()));
    // PDF tools are in-process (pdf_oxide) — always available.
    set.add_tool(tools::PdfExtractTextTool(t.user_id.clone()));
    set.add_tool(tools::PdfSearchTextTool(t.user_id.clone()));
    set.add_tool(tools::PdfReplaceTextTool(t.user_id.clone()));
    set.add_tool(tools::PdfMergeTool(t.user_id.clone()));
    set.add_tool(tools::PdfSplitTool(t.user_id.clone()));
    set.add_tool(tools::PdfInfoTool(t.user_id.clone()));
    // Web read + search tiering: hidden webview first, Cloudflare fallback.
    // Registered only when at least one engine exists (never offered to the
    // model otherwise) — same capability-probe rule as the engines above.
    if webread::any_engine() {
        set.add_tool(webread::WebReadTool(t.user_id.clone()));
        set.add_tool(webread::WebSearchTool(t.user_id.clone()));
    }
    set
}

pub use store::set_docs_dir;
