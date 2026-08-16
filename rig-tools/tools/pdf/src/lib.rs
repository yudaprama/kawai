//! Hand-written rig.rs PDF tool crate backed by the `pdfcli` binary built
//! from `pdf/cmd/pdfcli`. Mirrors `components/tool/pdf` (the Eino Go
//! implementation) tool-for-tool: `pdf_search_replace`, `pdf_search_text`,
//! `pdf_extract_text`, `pdf_merge`, `pdf_split`, `pdf_page_info`,
//! `pdf_metadata_get`, `pdf_metadata_set`, `pdf_extract_images`.
//!
//! Each tool locates the binary at `$PDFCLI_BIN` (falling back to `pdfcli` on
//! PATH) and shells out to it. Point `ToolOptions::with_bin_path` at the
//! compiled binary to override.

pub mod generated;
pub mod pdfcli;
pub mod registry;
pub mod tools;

pub use pdfcli::{ToolBase, ToolError, ToolOptions};
pub use registry::{all_tools, is_native, native_names, toolset_for};
pub use tools::*;
