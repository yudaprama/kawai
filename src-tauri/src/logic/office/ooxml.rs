use serde::Deserialize;
use serde_json::Value;

use office_oxide::edit::{
    DocxAlign, DocxBlock, DocxBlockKind, DocxFormat, DocxRun, EditableDocument, PptxSlideSpec,
    XlsxCellValue,
};
use office_oxide::ir::Element;
use office_oxide::xlsx::edit::CellValue as XlsxEditCellValue;
use office_oxide::{Document, DocumentFormat};

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

/// Extract a document to Markdown, in-process via `office_oxide`.
///
/// The `baseurl` keeps parity with the old image-serving endpoint rooted at
/// `/office-files/<file_id>/…` (e.g. `/office-files/<file_id>/word/media/image1.png`)
/// so embedded pictures resolve to servable URLs.
pub async fn read_document(user_id: &str, file_id: &str) -> Result<String, String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    if info.ext == "pdf" {
        return Err("use pdf_extract_text for PDF files".into());
    }
    let doc = office_oxide::Document::open(&path)
        .map_err(|e| format!("office_oxide read failed: {e}"))?;
    Ok(doc.to_markdown_with_baseurl(Some(&format!("/office-files/{file_id}"))))
}

/// `office_document_info` — pure-Rust document inspection via `office_oxide`.
/// Returns a JSON object describing counts and core properties, no engine.
pub async fn document_info(user_id: &str, file_id: &str) -> Result<Value, String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    if info.ext == "pdf" {
        return Err("use pdf_info for PDF files".into());
    }
    let doc = Document::open(&path)
        .map_err(|e| format!("office_oxide read failed: {e}"))?;
    let ir = doc.to_ir();
    let words = doc.plain_text().split_whitespace().count();

    let (paragraphs, slides, sheets) = match doc.format() {
        DocumentFormat::Pptx => (None, doc.as_pptx().map(|d| d.slides.len()), None),
        DocumentFormat::Xlsx => (None, None, doc.as_xlsx().map(|d| d.worksheets.len())),
        _ => {
            let p = ir
                .sections
                .iter()
                .flat_map(|s| s.elements.iter())
                .filter(|e| matches!(e, Element::Paragraph(_) | Element::Heading(_)))
                .count();
            (Some(p), None, None)
        },
    };

    let m = ir.metadata;
    Ok(serde_json::json!({
        "format": info.ext,
        "wordCount": words,
        "paragraphCount": paragraphs,
        "slideCount": slides,
        "sheetCount": sheets,
        "metadata": {
            "title": m.title,
            "author": m.author,
            "subject": m.subject,
            "keywords": m.keywords,
            "created": m.created,
            "modified": m.modified,
            "description": m.description,
        },
    }))
}

/// Per-operation outcome from `office_edit_document`.
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

/// Structured edit summary from `office_edit_document`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EditOutcome {
    pub success: bool,
    pub rows_modified: u64,
    #[serde(default)]
    pub operations: Vec<EditOpOutcome>,
    #[serde(default)]
    pub error_summary: Option<String>,
}

/// `office_edit_document` — pure-Rust edit via `office_oxide::EditableDocument`.
/// Each op is applied in order; per-op status is recorded and the final
/// document replaces the stored file.
pub async fn edit_document(
    user_id: &str,
    file_id: &str,
    operations: &[Value],
) -> Result<EditOutcome, String> {
    let (path, info) = store::resolve(user_id, file_id)?;
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
    let ext = info.ext.clone();
    let tmp = path.with_extension(format!("{}.tmp", info.ext));
    let mut doc = EditableDocument::open(&path)
        .map_err(|e| format!("open for edit failed: {e}"))?;

    let mut op_results = Vec::new();
    let mut rows_modified = 0u64;
    for (i, op) in operations.iter().enumerate() {
        let ty = op
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string();
        let (status, modified, error) = match apply_edit_op(&mut doc, &ext, op) {
            Ok(n) => ("applied".to_string(), n, None),
            Err(e) => ("error".to_string(), 0, Some(e)),
        };
        rows_modified += modified;
        op_results.push(EditOpOutcome {
            index: i as u64,
            op_type: ty,
            status,
            modified,
            error,
        });
    }

    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    doc.write_to(file)
        .map_err(|e| format!("write edited document: {e}"))?;
    store::replace_stored(user_id, file_id, &tmp)?;
    Ok(EditOutcome {
        success: true,
        rows_modified,
        operations: op_results,
        error_summary: None,
    })
}

/// Apply a single edit op to the open document, returning the number of
/// affected units (paragraphs, cells, slides, …).
fn apply_edit_op(
    doc: &mut EditableDocument,
    ext: &str,
    op: &Value,
) -> Result<u64, String> {
    let ty = op.get("type").and_then(|t| t.as_str()).unwrap_or_default();
    match (ext, ty) {
        ("docx", "replace_text") => {
            let find = op.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let replace = op.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            Ok(doc.replace_text(find, replace) as u64)
        }
        ("docx", "append_paragraphs") => {
            let blocks = parse_docx_blocks(op)?;
            doc.append_docx_blocks(&blocks)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("docx", "append_table") => {
            let rows = parse_docx_table(op)?;
            doc.append_docx_table(&rows)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("docx", "delete_paragraph") => {
            let find = op.get("find").and_then(|v| v.as_str()).unwrap_or("");
            doc.delete_docx_paragraphs(find)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("docx", "format_paragraph") => {
            let find = op.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let fmt = parse_docx_format(op)?;
            doc.format_docx_paragraph(find, &fmt)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("xlsx", "replace_text") => {
            let find = op.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let replace = op.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            doc.xlsx_replace_text(find, replace)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("xlsx", "append_rows") => {
            let sheet = op.get("sheet").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let rows = parse_xlsx_rows(op)?;
            doc.append_xlsx_rows(sheet, &rows)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("xlsx", "set_cell") => {
            let cells = op
                .get("cells")
                .and_then(|v| v.as_array())
                .ok_or("set_cell requires cells[]")?;
            let mut count = 0u64;
            for c in cells {
                let cell = c.get("cell").and_then(|v| v.as_str()).ok_or("cell ref missing")?;
                let value = parse_xlsx_edit_cell_value(c.get("value"))?;
                doc.set_cell(0, cell, value)
                    .map_err(|e| e.to_string())?;
                count += 1;
            }
            Ok(count)
        }
        ("pptx", "replace_text") => {
            let find = op.get("find").and_then(|v| v.as_str()).unwrap_or("");
            let replace = op.get("replace").and_then(|v| v.as_str()).unwrap_or("");
            Ok(doc.replace_text(find, replace) as u64)
        }
        ("pptx", "append_slides") => {
            let slides = parse_pptx_slides(op)?;
            doc.append_pptx_slides(&slides)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        ("pptx", "remove_slide") => {
            let find = op.get("find").and_then(|v| v.as_str()).unwrap_or("");
            doc.remove_pptx_slide(find)
                .map_err(|e| e.to_string())
                .map(|n| n as u64)
        }
        _ => Err(format!("unsupported operation {ty:?} for .{ext}")),
    }
}

fn parse_docx_blocks(op: &Value) -> Result<Vec<DocxBlock>, String> {
    let arr = op
        .get("paragraphs")
        .and_then(|v| v.as_array())
        .ok_or("append_paragraphs requires paragraphs[]")?;
    let mut blocks = Vec::new();
    for p in arr {
        let kind = match p.get("type").and_then(|v| v.as_str()).unwrap_or("paragraph") {
            "paragraph" => DocxBlockKind::Paragraph,
            "title" => DocxBlockKind::Title,
            "heading1" => DocxBlockKind::Heading1,
            "heading2" => DocxBlockKind::Heading2,
            "heading3" => DocxBlockKind::Heading3,
            "bullet" => DocxBlockKind::Bullet,
            other => return Err(format!("unknown paragraph type {other:?}")),
        };
        let runs = p
            .get("runs")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut docx_runs = Vec::new();
        for r in runs {
            docx_runs.push(DocxRun {
                text: r.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                bold: r.get("bold").and_then(|v| v.as_bool()).unwrap_or(false),
                italic: r.get("italic").and_then(|v| v.as_bool()).unwrap_or(false),
                size: r.get("size").and_then(|v| v.as_f64()),
                color: r.get("color").and_then(|v| v.as_str()).map(|s| s.to_string()),
                font: r.get("font").and_then(|v| v.as_str()).map(|s| s.to_string()),
            });
        }
        blocks.push(DocxBlock { kind, runs: docx_runs });
    }
    Ok(blocks)
}

fn parse_docx_table(op: &Value) -> Result<Vec<Vec<String>>, String> {
    let rows = op
        .get("rows")
        .and_then(|v| v.as_array())
        .ok_or("append_table requires rows[]")?;
    let mut out = Vec::new();
    for row in rows {
        let cells = row
            .get("cells")
            .and_then(|v| v.as_array())
            .ok_or("row missing cells[]")?;
        let mut r = Vec::new();
        for c in cells {
            r.push(c.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string());
        }
        out.push(r);
    }
    Ok(out)
}

fn parse_docx_format(op: &Value) -> Result<DocxFormat, String> {
    let mut fmt = DocxFormat::default();
    if let Some(a) = op.get("alignment").and_then(|v| v.as_str()) {
        fmt.alignment = Some(match a {
            "left" => DocxAlign::Left,
            "center" => DocxAlign::Center,
            "right" => DocxAlign::Right,
            "justify" => DocxAlign::Justify,
            other => return Err(format!("unknown alignment {other:?}")),
        });
    }
    fmt.spacing_before = op.get("spacing_before").and_then(|v| v.as_u64()).map(|v| v as u32);
    fmt.spacing_after = op.get("spacing_after").and_then(|v| v.as_u64()).map(|v| v as u32);
    fmt.indent_left = op.get("indent_left").and_then(|v| v.as_u64()).map(|v| v as u32);
    fmt.indent_right = op.get("indent_right").and_then(|v| v.as_u64()).map(|v| v as u32);
    Ok(fmt)
}

fn parse_xlsx_rows(op: &Value) -> Result<Vec<Vec<XlsxCellValue>>, String> {
    let rows = op
        .get("cell_rows")
        .and_then(|v| v.as_array())
        .ok_or("append_rows requires cell_rows[]")?;
    let mut out = Vec::new();
    for row in rows {
        let values = row
            .get("values")
            .and_then(|v| v.as_array())
            .ok_or("row missing values[]")?;
        let mut r = Vec::new();
        for v in values {
            r.push(parse_xlsx_cell_value(Some(v))?);
        }
        out.push(r);
    }
    Ok(out)
}

fn parse_xlsx_cell_value(v: Option<&Value>) -> Result<XlsxCellValue, String> {
    let v = v.ok_or("missing cell value")?;
    if let Some(n) = v.as_f64() {
        return Ok(XlsxCellValue::Number(n));
    }
    if let Some(b) = v.as_bool() {
        return Ok(XlsxCellValue::Boolean(b));
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<f64>() {
            return Ok(XlsxCellValue::Number(n));
        }
        if s == "true" {
            return Ok(XlsxCellValue::Boolean(true));
        }
        if s == "false" {
            return Ok(XlsxCellValue::Boolean(false));
        }
        return Ok(XlsxCellValue::String(s.to_string()));
    }
    Ok(XlsxCellValue::String(v.to_string()))
}

fn parse_xlsx_edit_cell_value(v: Option<&Value>) -> Result<XlsxEditCellValue, String> {
    let v = v.ok_or("missing cell value")?;
    if let Some(n) = v.as_f64() {
        return Ok(XlsxEditCellValue::Number(n));
    }
    if let Some(b) = v.as_bool() {
        return Ok(XlsxEditCellValue::Boolean(b));
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<f64>() {
            return Ok(XlsxEditCellValue::Number(n));
        }
        if s == "true" {
            return Ok(XlsxEditCellValue::Boolean(true));
        }
        if s == "false" {
            return Ok(XlsxEditCellValue::Boolean(false));
        }
        return Ok(XlsxEditCellValue::String(s.to_string()));
    }
    Ok(XlsxEditCellValue::String(v.to_string()))
}

fn parse_pptx_slides(op: &Value) -> Result<Vec<PptxSlideSpec>, String> {
    let slides = op
        .get("slides")
        .and_then(|v| v.as_array())
        .ok_or("append_slides requires slides[]")?;
    let mut out = Vec::new();
    for s in slides {
        let title = s.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let body = s
            .get("body")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        out.push(PptxSlideSpec { title, body });
    }
    Ok(out)
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
