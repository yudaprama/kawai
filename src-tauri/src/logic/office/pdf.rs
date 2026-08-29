use pdf_oxide::converters::ConversionOptions;
use pdf_oxide::editor::{DocumentEditor, EditableDocument};
use pdf_oxide::search::{SearchOptions, TextSearcher};
use pdf_oxide::PdfDocument;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::task::spawn_blocking;

use super::store;
use super::store::OfficeFile;

/// Structured OCR result for one PDF page.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PdfOcrPage {
    /// 1-based page number.
    pub page_number: u32,
    /// Page width in pixels at the render DPI.
    pub width: u32,
    /// Page height in pixels at the render DPI.
    pub height: u32,
    /// Flat text for embedding/RAG.
    pub text: String,
    /// Structured OCR lines with per-line bbox + confidence.
    pub ocr_lines: Vec<kawai_vision::OcrLine>,
}

fn require_pdf(user_id: &str, file_id: &str) -> Result<(PathBuf, OfficeFile), String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    if info.ext != "pdf" {
        return Err(format!("not a PDF: .{}", info.ext));
    }
    Ok((path, info))
}

/// Run a synchronous pdf_oxide operation off the async runtime.
async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(f)
        .await
        .map_err(|e| format!("pdf blocking task join: {e}"))?
}

/// Parse a page-spec string ("1,3,5-7") into 0-indexed page indices.
fn resolve_pages(pages: Option<&str>, count: usize) -> Result<Vec<usize>, String> {
    match pages {
        None | Some("") | Some("*") => Ok((0..count).collect()),
        Some(spec) => {
            let mut out = Vec::new();
            for part in spec.split(',') {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                if let Some((a, b)) = part.split_once('-') {
                    let s: usize = a.trim().parse().map_err(|_| format!("bad page: '{a}'"))?;
                    let e: usize = b.trim().parse().map_err(|_| format!("bad page: '{b}'"))?;
                    if s == 0 || e == 0 {
                        return Err("pdf page numbers start at 1".into());
                    }
                    if s > e {
                        return Err(format!("invalid range {s}-{e}"));
                    }
                    for p in s..=e {
                        out.push(p - 1);
                    }
                } else {
                    let p: usize = part.parse().map_err(|_| format!("bad page: '{part}'"))?;
                    if p == 0 {
                        return Err("pdf page numbers start at 1".into());
                    }
                    out.push(p - 1);
                }
            }
            out.sort();
            out.dedup();
            if out.is_empty() {
                return Err("no pages specified".into());
            }
            Ok(out)
        }
    }
}

/// Extract markdown text from a stored PDF. Output is prefixed per page:
/// `--- page N ---`. For scanned PDFs where native text is empty, falls back
/// to rendering the page to an image and OCR-ing via PaddleOCR (when the
/// `paddle-ocr` feature is enabled).
pub async fn pdf_extract_text(
    user_id: &str,
    file_id: &str,
    pages: Option<&str>,
) -> Result<String, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let pages_spec = pages.map(|s| s.to_string());
    let path_clone = path.clone();
    let extracted: Vec<(usize, String)> = run_blocking(move || {
        let doc = PdfDocument::open(&path_clone).map_err(|e| format!("pdf open: {e}"))?;
        let count = doc
            .page_count()
            .map_err(|e| format!("pdf page_count: {e}"))?;
        let options = ConversionOptions::default();
        let indices = resolve_pages(pages_spec.as_deref(), count)?;
        let mut out = Vec::with_capacity(indices.len());
        for &i in &indices {
            let md = doc
                .to_markdown(i, &options)
                .map_err(|e| format!("pdf to_markdown: {e}"))?;
            out.push((i, md));
        }
        Ok(out)
    })
    .await?;

    // Per-page OCR fallback for pages where native extraction is blank.
    #[cfg(feature = "paddle-ocr")]
    let extracted = {
        let mut out = Vec::with_capacity(extracted.len());
        for (idx, md) in extracted {
            if !md.trim().is_empty() {
                out.push((idx, md, None));
                continue;
            }
            match render_and_ocr_page(&path, idx).await {
                Ok((desc, _width, _height)) if !desc.content.trim().is_empty() => {
                    out.push((idx, desc.content, desc.ocr_lines));
                }
                Ok(_) => out.push((idx, md, None)),
                Err(e) => {
                    eprintln!("pdf ocr fallback failed for page {}: {e}", idx + 1);
                    out.push((idx, md, None));
                }
            }
        }
        out
    };

    #[cfg(not(feature = "paddle-ocr"))]
    let extracted: Vec<(usize, String, Option<Vec<kawai_vision::OcrLine>>)> =
        extracted.into_iter().map(|(i, s)| (i, s, None)).collect();

    let mut out = String::new();
    for (idx, md) in extracted {
        out.push_str(&format!("--- page {} ---\n{}\n", idx + 1, md));
    }
    Ok(out)
}

#[cfg(feature = "paddle-ocr")]
async fn render_and_ocr_page(
    path: &PathBuf,
    page_idx: usize,
) -> Result<(kawai_vision::ImageDescription, u32, u32), String> {
    let path = path.clone();
    let png_bytes = spawn_blocking(move || {
        let doc = PdfDocument::open(&path).map_err(|e| format!("pdf open for render: {e}"))?;
        let opts = pdf_oxide::rendering::RenderOptions::with_dpi(150);
        let rendered =
            pdf_oxide::rendering::render_page(&doc, page_idx, &opts).map_err(|e| {
                format!("pdf render page {}: {e}", page_idx + 1)
            })?;
        Ok::<_, String>((rendered.data, rendered.width, rendered.height))
    })
    .await
    .map_err(|e| format!("render join: {e}"))??;

    let (png_bytes, width, height) = png_bytes;
    let source = kawai_vision::ImageSource::local(format!("page_{}.png", page_idx + 1));
    let desc = kawai_vision::default_chain()
        .describe(&source, &png_bytes)
        .await
        .map_err(|e| format!("ocr page {}: {e}", page_idx + 1))?;
    Ok((desc, width, height))
}

/// Extract text from a stored PDF with structured per-page OCR results.
/// Returns [`PdfOcrPage`] for every page that was processed — native pages
/// have empty `ocr_lines`, scanned pages have PaddleOCR `ocr_lines` with
/// bbox + confidence.
pub async fn pdf_extract_text_structured(
    user_id: &str,
    file_id: &str,
    pages: Option<&str>,
) -> Result<Vec<PdfOcrPage>, String> {
    #[cfg(feature = "paddle-ocr")]
    {
        let (path, _) = require_pdf(user_id, file_id)?;
        let pages_spec = pages.map(|s| s.to_string());
        let path_clone = path.clone();
        let extracted: Vec<(usize, String)> = run_blocking(move || {
            let doc = PdfDocument::open(&path_clone).map_err(|e| format!("pdf open: {e}"))?;
            let count = doc
                .page_count()
                .map_err(|e| format!("pdf page_count: {e}"))?;
            let options = ConversionOptions::default();
            let indices = resolve_pages(pages_spec.as_deref(), count)?;
            let mut out = Vec::with_capacity(indices.len());
            for &i in &indices {
                let md = doc
                    .to_markdown(i, &options)
                    .map_err(|e| format!("pdf to_markdown: {e}"))?;
                out.push((i, md));
            }
            Ok(out)
        })
        .await?;

        let mut result = Vec::with_capacity(extracted.len());
        for (idx, md) in extracted {
            if !md.trim().is_empty() {
                result.push(PdfOcrPage {
                    page_number: (idx + 1) as u32,
                    width: 0,
                    height: 0,
                    text: md,
                    ocr_lines: Vec::new(),
                });
                continue;
            }
            match render_and_ocr_page(&path, idx).await {
                Ok((desc, width, height)) => {
                    result.push(PdfOcrPage {
                        page_number: (idx + 1) as u32,
                        width,
                        height,
                        text: desc.content,
                        ocr_lines: desc.ocr_lines.unwrap_or_default(),
                    });
                }
                Err(e) => {
                    eprintln!("pdf ocr structured failed for page {}: {e}", idx + 1);
                    result.push(PdfOcrPage {
                        page_number: (idx + 1) as u32,
                        width: 0,
                        height: 0,
                        text: md,
                        ocr_lines: Vec::new(),
                    });
                }
            }
        }
        Ok(result)
    }
    #[cfg(not(feature = "paddle-ocr"))]
    {
        let _ = (user_id, file_id, pages);
        Err("pdf_extract_text_structured requires paddle-ocr feature".into())
    }
}

/// Search text in a stored PDF. Returns an array of `{page, matches}` entries
/// (empty array = no hits).
pub async fn pdf_search_text(
    user_id: &str,
    file_id: &str,
    pattern: &str,
    pages: Option<&str>,
) -> Result<Value, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let pattern = pattern.to_string();
    let pages = pages.map(|s| s.to_string());
    run_blocking(move || -> Result<Value, String> {
        let doc = PdfDocument::open(&path).map_err(|e| format!("pdf open: {e}"))?;
        let count = doc
            .page_count()
            .map_err(|e| format!("pdf page_count: {e}"))?;
        let indices = resolve_pages(pages.as_deref(), count)?;
        let page_range = indices
            .first()
            .zip(indices.last())
            .map(|(&min, &max)| (min, max));
        let options = SearchOptions {
            case_insensitive: false,
            page_range,
            ..Default::default()
        };
        let results = TextSearcher::search(&doc, &pattern, &options)
            .map_err(|e| format!("pdf search: {e}"))?;

        // Group matches by 1-based page number.
        let mut by_page: std::collections::BTreeMap<usize, Vec<Value>> = Default::default();
        for r in results {
            if !indices.contains(&r.page) {
                continue;
            }
            by_page.entry(r.page + 1).or_default().push(json!({
                "text": r.text,
                "start_index": r.start_index,
                "end_index": r.end_index,
            }));
        }
        let entries: Vec<Value> = by_page
            .into_iter()
            .map(|(page, matches)| json!({ "page": page, "matches": matches }))
            .collect();
        Ok(Value::Array(entries))
    })
    .await
}

/// Replace text in a stored PDF in place; the stored file is swapped for the
/// edited copy.
pub async fn pdf_replace_text(
    user_id: &str,
    file_id: &str,
    pattern: &str,
    replacement: &str,
    pages: Option<&str>,
) -> Result<(), String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let pattern = pattern.to_string();
    let replacement = replacement.to_string();
    let pages = pages.map(|s| s.to_string());
    let tmp = path.with_extension("replaced.tmp.pdf");
    let tmp_out = tmp.clone();
    run_blocking(move || {
        let re = regex::Regex::new(&pattern).map_err(|e| format!("bad regex '{pattern}': {e}"))?;
        let doc = PdfDocument::open(&path).map_err(|e| format!("pdf open: {e}"))?;
        let count = doc
            .page_count()
            .map_err(|e| format!("pdf page_count: {e}"))?;
        drop(doc);
        let indices = resolve_pages(pages.as_deref(), count)?;

        let mut editor =
            DocumentEditor::open(&path).map_err(|e| format!("pdf open editor: {e}"))?;
        for &i in &indices {
            let mut page = editor
                .get_page(i)
                .map_err(|e| format!("pdf get_page: {e}"))?;
            let matches = page.find_text(|t| re.is_match(t.text()));
            for t in matches {
                let old = t.text().to_string();
                let id = t.id();
                let updated = re.replace_all(&old, &replacement);
                page.set_text(id, updated.into_owned())
                    .map_err(|e| format!("pdf set_text: {e}"))?;
            }
            editor
                .save_page(page)
                .map_err(|e| format!("pdf save_page: {e}"))?;
        }
        editor.save(&tmp_out).map_err(|e| format!("pdf save: {e}"))
    })
    .await
    .map_err(|e| format!("pdf replace: {e}"))?;
    store::replace_stored(user_id, file_id, &tmp)
}

/// Merge a list of stored PDFs into a NEW stored file.
pub async fn pdf_merge(
    user_id: &str,
    file_ids: &[String],
    output_name: &str,
) -> Result<OfficeFile, String> {
    if file_ids.len() < 2 {
        return Err("pdf_merge needs at least two file ids".into());
    }
    let name = if store::allowed_ext(output_name).as_deref() == Some("pdf") {
        output_name.to_string()
    } else {
        format!("{}.pdf", store::sanitize_component(output_name))
    };
    let mut paths: Vec<PathBuf> = Vec::new();
    for id in file_ids {
        let (path, _) = require_pdf(user_id, id)?;
        paths.push(path);
    }
    let data = run_blocking(move || {
        let mut editor = DocumentEditor::open(&paths[0]).map_err(|e| format!("pdf open: {e}"))?;
        for src in &paths[1..] {
            editor
                .merge_from(src)
                .map_err(|e| format!("pdf merge_from: {e}"))?;
        }
        editor
            .save_to_bytes()
            .map_err(|e| format!("pdf save_to_bytes: {e}"))
    })
    .await?;
    store::import_bytes(user_id, &name, &data)
}

/// Split a stored PDF into NEW stored PDFs (one per range, or per page).
pub async fn pdf_split(
    user_id: &str,
    file_id: &str,
    ranges: Option<&str>,
) -> Result<Vec<OfficeFile>, String> {
    let (path, info) = require_pdf(user_id, file_id)?;
    let ranges = ranges.map(|s| s.to_string());
    let parts = run_blocking(move || {
        let doc = PdfDocument::open(&path).map_err(|e| format!("pdf open: {e}"))?;
        let count = doc
            .page_count()
            .map_err(|e| format!("pdf page_count: {e}"))?;
        drop(doc);

        let groups: Vec<Vec<usize>> = match ranges.as_deref() {
            Some(r) if !r.is_empty() => {
                let mut g: Vec<Vec<usize>> = Vec::new();
                for part in r.split(',') {
                    let part = part.trim();
                    if part.is_empty() {
                        continue;
                    }
                    if let Some((a, b)) = part.split_once('-') {
                        let s: usize = a.trim().parse().map_err(|_| format!("bad range '{a}'"))?;
                        let e: usize = b.trim().parse().map_err(|_| format!("bad range '{b}'"))?;
                        if s == 0 || e == 0 {
                            return Err("pdf page numbers start at 1".into());
                        }
                        if s > e {
                            return Err(format!("invalid range {s}-{e}"));
                        }
                        g.push((s..=e).map(|p| p - 1).collect());
                    } else {
                        let p: usize = part.parse().map_err(|_| format!("bad page '{part}'"))?;
                        if p == 0 {
                            return Err("pdf page numbers start at 1".into());
                        }
                        g.push(vec![p - 1]);
                    }
                }
                g
            }
            _ => (0..count).map(|i| vec![i]).collect(),
        };

        let mut out: Vec<Vec<u8>> = Vec::new();
        for group in &groups {
            let mut editor = DocumentEditor::open(&path).map_err(|e| format!("pdf open: {e}"))?;
            let keep: std::collections::HashSet<usize> = group.iter().copied().collect();
            for i in (0..count).rev() {
                if !keep.contains(&i) {
                    editor
                        .remove_page(i)
                        .map_err(|e| format!("pdf remove_page: {e}"))?;
                }
            }
            out.push(
                editor
                    .save_to_bytes()
                    .map_err(|e| format!("pdf save_to_bytes: {e}"))?,
            );
        }
        Ok(out)
    })
    .await?;

    let base = info.original_name.trim_end_matches(".pdf");
    let mut files = Vec::new();
    for (i, data) in parts.iter().enumerate() {
        let name = format!("{base} part {:02}.pdf", i + 1);
        files.push(store::import_bytes(user_id, &name, data)?);
    }
    Ok(files)
}

/// Inspect a stored PDF: page count plus per-page size/rotation.
pub async fn pdf_info(user_id: &str, file_id: &str) -> Result<Value, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    run_blocking(move || -> Result<Value, String> {
        let doc = PdfDocument::open(&path).map_err(|e| format!("pdf open: {e}"))?;
        let count = doc
            .page_count()
            .map_err(|e| format!("pdf page_count: {e}"))?;
        let (major, minor) = doc.version();
        drop(doc);

        let mut editor =
            DocumentEditor::open(&path).map_err(|e| format!("pdf open editor: {e}"))?;
        let mut pages = Vec::new();
        for i in 0..count {
            let mb = editor
                .get_page_media_box(i)
                .map_err(|e| format!("pdf media_box: {e}"))?;
            let rot = editor
                .get_page_rotation(i)
                .map_err(|e| format!("pdf rotation: {e}"))?;
            pages.push(json!({ "page": i + 1, "width": mb[2], "height": mb[3], "rotation": rot }));
        }
        Ok(json!({
            "pageCount": count,
            "version": format!("{major}.{minor}"),
            "pages": pages,
        }))
    })
    .await
}
