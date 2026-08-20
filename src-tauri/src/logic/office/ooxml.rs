use serde::Deserialize;
use serde_json::Value;

use super::cli::{self, CLI_TIMEOUT};
use super::store;
use super::store::OfficeFile;

// ── structured document blocks (model-friendly create path) ─────────────────
//
// The agent model writes simple JSON blocks; the docbuilder JS below is
// generated deterministically in Rust. Nested "code inside a JSON string"
// was beyond a small on-device model (escaping broke the JSON every time).

/// One content block for `office_create_document`.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocBlock {
    #[serde(rename = "title")]
    Title { text: String },
    #[serde(rename = "heading")]
    Heading { text: String, #[serde(default)] level: Option<u8> },
    #[serde(rename = "paragraph")]
    Paragraph { text: String, #[serde(default)] bold: Option<bool> },
    #[serde(rename = "bullets")]
    Bullets { items: Vec<String> },
    #[serde(rename = "table")]
    Table { rows: Vec<Vec<String>> },
}

/// Create a document from structured content blocks (see [`DocBlock`]).
///
/// Renders the blocks to markdown and creates the file in-process via
/// office_oxide (`create_from_markdown`) — no docbuilder engine needed.
/// Markdown semantics carry across formats: an H1 (`title` block) starts a
/// new section, which the xlsx/pptx writers map to a new sheet/slide with
/// that title; other blocks flow in document order.
pub async fn create_document_from_blocks(
    user_id: &str,
    filename: &str,
    blocks: &[DocBlock],
) -> Result<OfficeFile, String> {
    use std::io::Cursor;

    let ext = store::allowed_ext(filename)
        .filter(|e| matches!(e.as_str(), "docx" | "xlsx" | "pptx"))
        .ok_or_else(|| format!("unsupported output type: {filename} (docx/xlsx/pptx)"))?;
    let format = match ext.as_str() {
        "docx" => office_oxide::format::DocumentFormat::Docx,
        "xlsx" => office_oxide::format::DocumentFormat::Xlsx,
        "pptx" => office_oxide::format::DocumentFormat::Pptx,
        _ => unreachable!(),
    };
    let markdown = blocks_to_markdown(blocks)?;
    let mut bytes = Cursor::new(Vec::new());
    office_oxide::create::create_from_markdown_to_writer(&markdown, format, &mut bytes)
        .map_err(|e| format!("office_oxide create failed: {e}"))?;
    store::import_bytes(user_id, filename, &bytes.into_inner())
}

/// Render content blocks to the markdown dialect office_oxide ingests
/// (ATX headings, pipe tables, `-` bullets, `**bold**`).
fn blocks_to_markdown(blocks: &[DocBlock]) -> Result<String, String> {
    if blocks.is_empty() {
        return Err("blocks must not be empty — add at least one title/paragraph/bullets/table block".into());
    }
    let mut md = String::new();
    for b in blocks {
        match b {
            DocBlock::Title { text } => {
                md.push_str(&format!("# {}\n\n", md_text(text)));
            }
            DocBlock::Heading { text, level } => {
                let hashes = "#".repeat((level.unwrap_or(1).clamp(1, 3) as usize) + 1);
                md.push_str(&format!("{hashes} {}\n\n", md_text(text)));
            }
            DocBlock::Paragraph { text, bold } => {
                if bold.unwrap_or(false) {
                    md.push_str(&format!("**{}**\n\n", md_text(text)));
                } else {
                    md.push_str(&format!("{}\n\n", md_text(text)));
                }
            }
            DocBlock::Bullets { items } => {
                // Plain "• item" paragraphs (not markdown lists): the xlsx
                // writer does not render List elements, and one rendering for
                // all three formats keeps output predictable.
                for item in items {
                    md.push_str(&format!("• {}\n\n", md_text(item)));
                }
            }
            DocBlock::Table { rows } => {
                if rows.is_empty() || rows[0].is_empty() {
                    return Err("table block needs at least one non-empty row".into());
                }
                let cols = rows.iter().map(Vec::len).max().unwrap_or(1);
                let mut row_line = |cells: &[String]| -> String {
                    let padded: Vec<String> = (0..cols)
                        .map(|i| cell_text(cells.get(i).map(String::as_str).unwrap_or("")))
                        .collect();
                    format!("| {} |\n", padded.join(" | "))
                };
                md.push_str(&row_line(&rows[0]));
                md.push_str(&format!("|{}|\n", vec![" --- "; cols].join("|")));
                for row in &rows[1..] {
                    md.push_str(&row_line(row));
                }
                md.push('\n');
            }
        }
    }
    Ok(md)
}

/// One-line plain text for markdown: strip newlines (a paragraph must stay
/// one block) and escape markdown-active leading characters.
fn md_text(s: &str) -> String {
    let flat: String = s.replace(['\r', '\n'], " ");
    let trimmed = flat.trim();
    if trimmed.starts_with(['#', '-', '*', '>']) {
        format!("\\ {}", trimmed)
    } else {
        trimmed.to_string()
    }
}

/// Table cell text: newlines out, pipes escaped.
fn cell_text(s: &str) -> String {
    s.replace(['\r', '\n'], " ").replace('|', "\\|")
}

fn allowed_ops(ext: &str) -> Option<&'static [&'static str]> {
    match ext {
        "docx" => Some(&[
            "replace_text",
            "append_paragraphs",
            "append_table",
            "delete_paragraph",
            "format_paragraph",
        ]),
        "xlsx" => Some(&["replace_text", "append_rows", "set_cell"]),
        "pptx" => Some(&["replace_text", "append_slides", "remove_slide"]),
        _ => None,
    }
}

/// `ooxcli extract` → markdown.
pub async fn read_document(user_id: &str, file_id: &str) -> Result<String, String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    let bin = cli::ooxcli_path().ok_or_else(|| cli::missing_engine("ooxcli"))?;
    if info.ext == "pdf" {
        return Err("use pdf_extract_text for PDF files".into());
    }
    let out = cli::run_cli(
        &bin,
        &[
            "extract".to_string(),
            "--baseurl".to_string(),
            "/office-files".to_string(),
            path.display().to_string(),
        ],
        None,
        None,
        CLI_TIMEOUT,
    )
    .await?;
    Ok(out.stdout)
}

/// `ooxcli info` → parsed JSON.
pub async fn document_info(user_id: &str, file_id: &str) -> Result<Value, String> {
    let (path, _info) = store::resolve(user_id, file_id)?;
    let bin = cli::ooxcli_path().ok_or_else(|| cli::missing_engine("ooxcli"))?;
    let out = cli::run_cli(
        &bin,
        &["info".to_string(), path.display().to_string()],
        None,
        None,
        CLI_TIMEOUT,
    )
    .await?;
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("ooxcli info returned invalid JSON: {e}"))
}

/// Per-operation outcome from `ooxcli edit --json` (gooxml >= v0.1.5).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EditOpOutcome {
    pub index: u64,
    #[serde(rename = "type")]
    pub op_type: String,
    /// "applied", "no_match", or "error"
    pub status: String,
    pub modified: u64,
    #[serde(default)]
    pub error: Option<String>,
}

/// Structured edit summary from `ooxcli edit --json` (gooxml >= v0.1.5).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EditOutcome {
    pub success: bool,
    pub rows_modified: u64,
    #[serde(default)]
    pub operations: Vec<EditOpOutcome>,
    #[serde(default)]
    pub error_summary: Option<String>,
}

/// `ooxcli edit` with ops JSON on stdin; output replaces the stored file.
pub async fn edit_document(
    user_id: &str,
    file_id: &str,
    operations: &[Value],
) -> Result<EditOutcome, String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    let bin = cli::ooxcli_path().ok_or_else(|| cli::missing_engine("ooxcli"))?;
    let allowed = allowed_ops(&info.ext)
        .ok_or_else(|| format!("edit does not support .{} files", info.ext))?;
    for (i, op) in operations.iter().enumerate() {
        let ty = op.get("type").and_then(|t| t.as_str()).unwrap_or_default();
        if !allowed.contains(&ty) {
            return Err(format!(
                "operations[{i}]: unknown type {ty:?} for .{} (allowed: {allowed:?})",
                info.ext
            ));
        }
    }
    let ops_json = serde_json::to_string(&operations).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", info.ext));
    // Trailing --json (gooxml >= v0.1.5) must come AFTER the positional input:
    // older binaries treat an unknown leading positional as the input file,
    // while a trailing one is safely ignored.
    let out = cli::run_cli(
        &bin,
        &[
            "edit".to_string(),
            path.display().to_string(),
            "--out".to_string(),
            tmp.display().to_string(),
            "--json".to_string(),
        ],
        Some(&ops_json),
        None,
        CLI_TIMEOUT,
    )
    .await?;
    if !tmp.is_file() {
        return Err(format!(
            "ooxcli edit produced no output: {}",
            out.stderr.trim()
        ));
    }
    // gooxml >= v0.1.5 prints an EditResult JSON summary; older binaries print
    // nothing on success — degrade to an op-count-only outcome.
    let outcome = match serde_json::from_str::<EditOutcome>(out.stdout.trim()) {
        Ok(parsed) if parsed.success => parsed,
        Ok(parsed) => {
            return Err(parsed
                .error_summary
                .unwrap_or_else(|| "ooxcli edit failed".into()));
        }
        Err(_) => EditOutcome {
            success: true,
            rows_modified: operations.len() as u64,
            operations: Vec::new(),
            error_summary: None,
        },
    };
    store::replace_stored(user_id, file_id, &tmp)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_op_allowlists() {
        assert!(allowed_ops("docx").unwrap().contains(&"replace_text"));
        assert!(allowed_ops("docx").unwrap().contains(&"format_paragraph"));
        assert!(!allowed_ops("docx").unwrap().contains(&"set_cell"));
        assert!(allowed_ops("xlsx").unwrap().contains(&"set_cell"));
        assert!(allowed_ops("pptx").unwrap().contains(&"append_slides"));
        assert!(allowed_ops("pdf").is_none());
    }

    #[test]
    fn parses_edit_outcome_json() {
        let raw = r#"{
          "file_path": "/tmp/a.docx",
          "output_path": "/tmp/a.docx.tmp",
          "success": true,
          "rows_modified": 3,
          "operations": [
            {"index": 0, "type": "replace_text", "status": "applied", "modified": 2},
            {"index": 1, "type": "remove_slide", "status": "no_match", "modified": 0}
          ]
        }"#;
        let outcome: EditOutcome = serde_json::from_str(raw).expect("parse");
        assert!(outcome.success);
        assert_eq!(outcome.rows_modified, 3);
        assert_eq!(outcome.operations.len(), 2);
        assert_eq!(outcome.operations[0].op_type, "replace_text");
        assert_eq!(outcome.operations[0].status, "applied");
        assert_eq!(outcome.operations[1].status, "no_match");
        assert!(outcome.error_summary.is_none());
    }

    #[test]
    fn parses_edit_outcome_error_summary() {
        let raw = r#"{
          "file_path": "/tmp/a.docx",
          "output_path": "/tmp/a.docx.tmp",
          "success": false,
          "rows_modified": 0,
          "operations": [
            {"index": 0, "type": "bogus", "status": "error", "modified": 0, "error": "unknown docx operation \"bogus\""}
          ],
          "error_summary": "unknown docx operation \"bogus\""
        }"#;
        let outcome: EditOutcome = serde_json::from_str(raw).expect("parse");
        assert!(!outcome.success);
        assert_eq!(
            outcome.error_summary.as_deref(),
            Some("unknown docx operation \"bogus\"")
        );
        assert_eq!(
            outcome.operations[0].error.as_deref(),
            outcome.error_summary.as_deref()
        );
    }

    // -- structured create (blocks → markdown → office_oxide) ------------------

    fn blocks() -> Vec<DocBlock> {
        vec![
            DocBlock::Title { text: "Report".into() },
            DocBlock::Heading { text: "S1".into(), level: Some(2) },
            DocBlock::Paragraph { text: "it's a \"test\"".into(), bold: Some(true) },
            DocBlock::Bullets { items: vec!["one".into(), "two".into()] },
            DocBlock::Table { rows: vec![vec!["a".into(), "b".into()], vec!["c".into(), "d".into()]] },
        ]
    }

    #[test]
    fn markdown_renders_all_blocks() {
        let md = blocks_to_markdown(&blocks()).expect("md");
        assert!(md.starts_with("# Report\n\n"));
        assert!(md.contains("### S1\n\n"));
        assert!(md.contains("**it's a \"test\"**\n\n"));
        assert!(md.contains("• one\n\n• two\n\n"));
        assert!(md.contains("| a | b |\n| --- | --- |\n| c | d |\n"));
    }

    #[test]
    fn markdown_escapes_active_characters() {
        let md = blocks_to_markdown(&[DocBlock::Paragraph {
            text: "# not a heading\nsecond line".into(),
            bold: None,
        }])
        .expect("md");
        assert!(md.contains("\\ # not a heading second line"));
    }

    #[test]
    fn markdown_rejects_empty_and_bad_tables() {
        assert!(blocks_to_markdown(&[]).is_err());
        assert!(blocks_to_markdown(&[DocBlock::Table { rows: vec![] }]).is_err());
    }

    #[test]
    fn creates_all_three_formats_and_round_trips() {
        let md = blocks_to_markdown(&blocks()).expect("md");
        for (ext, fmt) in [
            ("docx", office_oxide::format::DocumentFormat::Docx),
            ("xlsx", office_oxide::format::DocumentFormat::Xlsx),
            ("pptx", office_oxide::format::DocumentFormat::Pptx),
        ] {
            let mut w = std::io::Cursor::new(Vec::new());
            office_oxide::create::create_from_markdown_to_writer(&md, fmt, &mut w)
                .unwrap_or_else(|e| panic!("{ext}: {e}"));
            let bytes = w.into_inner();
            assert!(bytes.len() > 500, "{ext} suspiciously small");
            // Round-trip: office_oxide can read its own output back.
            let doc = office_oxide::Document::from_reader(
                std::io::Cursor::new(bytes.clone()),
                fmt,
            )
            .unwrap_or_else(|e| panic!("{ext} read-back: {e}"));
            let text = doc.plain_text();
            if ext == "xlsx" {
                // An H1 section title becomes the SHEET NAME in xlsx.
                let names: Vec<String> = doc
                    .as_xlsx()
                    .map(|x| x.workbook.sheets.iter().map(|s| s.name.clone()).collect())
                    .unwrap_or_default();
                assert!(
                    names.iter().any(|n| n.contains("Report")),
                    "{ext} lost the title (sheets: {names:?})"
                );
            } else {
                assert!(text.contains("Report"), "{ext} lost the title: {text:?}");
            }
            assert!(text.contains("one"), "{ext} lost the bullets: {text:?}");
        }
    }
}
