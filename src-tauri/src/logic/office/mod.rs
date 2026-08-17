//! Office document tooling backed by external CLI engines.
//!
//! Pure logic — no tauri/axum imports. Engines are subprocess binaries
//! resolved at first use:
//!   - `ooxcli`   (github.com/yudaprama/gooxml)  — OOXML read/edit/info
//!   - `pdfcli`   (github.com/yudaprama/pdf)     — PDF text/merge/split/…
//!   - `docbuilder` (office-runtime tarball from
//!     github.com/yudaprama/Docker-DocumentServer) — document CREATE via
//!     docbuilder JS.
//!
//! Files live in a per-user on-disk store addressed ONLY by opaque file ids —
//! path traversal is impossible by construction.
//!
//! Tools implement rig's `PortableTool` so the agent loop dispatches them
//! through a `rig::tool::ToolSet`.

pub mod cli;
pub mod error;
pub mod ooxml;
pub mod pdf;
pub mod store;
pub mod tools;

use rig::tool::ToolSet;
use serde::Serialize;

pub use error::OfficeToolError;
pub use ooxml::read_document;
pub use store::{export_file, import_base64, import_bytes, import_path, list_files};
pub use store::{OfficeFile, ReadDocumentResult};

// ── capability probe ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCapabilities {
    pub available: bool,
    pub ooxcli: bool,
    pub pdfcli: bool,
    pub docbuilder: bool,
    pub bin_dir: Option<String>,
    pub runtime_dir: Option<String>,
}

/// Probe which engines are present.
pub fn capabilities() -> OfficeCapabilities {
    let oox = cli::ooxcli_path().is_some();
    let pdf = cli::pdfcli_path().is_some();
    let db = cli::docbuilder_path().is_some();
    OfficeCapabilities {
        available: oox || pdf || db,
        ooxcli: oox,
        pdfcli: pdf,
        docbuilder: db,
        bin_dir: cli::bin_dir_str(),
        runtime_dir: cli::runtime_dir_str(),
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

// ── toolset builder ─────────────────────────────────────────────────────────

pub struct OfficeTools {
    user_id: String,
}

/// Build the office ToolSet for one user, filtered by the capability probe —
/// tools without engines are never registered (never offered to the model).
pub fn toolset(user_id: &str) -> ToolSet {
    let caps = capabilities();
    let t = OfficeTools {
        user_id: user_id.to_string(),
    };
    let mut set = ToolSet::default();
    set.add_tool(tools::ListFilesTool(t.user_id.clone()));
    if caps.ooxcli {
        set.add_tool(tools::ReadDocumentTool(t.user_id.clone()));
        set.add_tool(tools::DocumentInfoTool(t.user_id.clone()));
        set.add_tool(tools::EditDocumentTool(t.user_id.clone()));
        if caps.docbuilder {
            set.add_tool(tools::CreateDocumentTool(t.user_id.clone()));
        }
    }
    if caps.pdfcli {
        set.add_tool(tools::PdfExtractTextTool(t.user_id.clone()));
        set.add_tool(tools::PdfSearchTextTool(t.user_id.clone()));
        set.add_tool(tools::PdfReplaceTextTool(t.user_id.clone()));
        set.add_tool(tools::PdfMergeTool(t.user_id.clone()));
        set.add_tool(tools::PdfSplitTool(t.user_id.clone()));
        set.add_tool(tools::PdfInfoTool(t.user_id));
    }
    set
}

pub use cli::set_bin_dir;
pub use cli::set_runtime_dir;
pub use store::set_docs_dir;
