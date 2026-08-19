use serde_json::{json, Value};
use std::path::PathBuf;

use super::cli::{self, CLI_TIMEOUT};
use super::store;
use super::store::OfficeFile;

fn require_pdf(user_id: &str, file_id: &str) -> Result<(PathBuf, OfficeFile), String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    if info.ext != "pdf" {
        return Err(format!("not a PDF: .{}", info.ext));
    }
    Ok((path, info))
}

fn pages_arg(spec: Option<&str>) -> Vec<String> {
    match spec {
        Some(p) if !p.is_empty() => vec!["--pages".to_string(), p.to_string()],
        _ => Vec::new(),
    }
}

/// `pdfcli extract --md` → markdown.
pub async fn pdf_extract_text(
    user_id: &str,
    file_id: &str,
    pages: Option<&str>,
) -> Result<String, String> {
    let (path, info) = store::resolve(user_id, file_id)?;
    if info.ext != "pdf" {
        return Err(format!("not a PDF: .{}", info.ext));
    }
    let bin = cli::pdfcli_path().ok_or_else(|| cli::missing_engine("pdfcli"))?;
    let mut args = vec!["extract".to_string(), "--md".to_string()];
    args.extend(pages_arg(pages));
    args.push(path.display().to_string());
    let out = cli::run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    Ok(out.stdout)
}

/// `pdfcli search` → JSON value.
pub async fn pdf_search_text(
    user_id: &str,
    file_id: &str,
    pattern: &str,
    pages: Option<&str>,
) -> Result<Value, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let bin = cli::pdfcli_path().ok_or_else(|| cli::missing_engine("pdfcli"))?;
    let mut args = vec!["search".to_string(), pattern.to_string()];
    args.extend(pages_arg(pages));
    args.push(path.display().to_string());
    let out = cli::run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    let raw = out.stdout.trim();
    if raw.is_empty() {
        return Ok(json!([]));
    }
    serde_json::from_str(raw).map_err(|e| format!("pdfcli search returned invalid JSON: {e}"))
}

/// `pdfcli replace` → replaces the stored file.
pub async fn pdf_replace_text(
    user_id: &str,
    file_id: &str,
    pattern: &str,
    replacement: &str,
    pages: Option<&str>,
) -> Result<(), String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let bin = cli::pdfcli_path().ok_or_else(|| cli::missing_engine("pdfcli"))?;
    let tmp = path.with_extension("replaced.tmp.pdf");
    let mut args = vec![
        "replace".to_string(),
        pattern.to_string(),
        replacement.to_string(),
    ];
    args.extend(pages_arg(pages));
    args.push(path.display().to_string());
    args.push(tmp.display().to_string());
    cli::run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    if !tmp.is_file() {
        return Err("pdfcli replace produced no output".into());
    }
    store::replace_stored(user_id, file_id, &tmp)
}

/// `pdfcli merge` → new stored file.
pub async fn pdf_merge(
    user_id: &str,
    file_ids: &[String],
    output_name: &str,
) -> Result<OfficeFile, String> {
    let bin = cli::pdfcli_path().ok_or_else(|| cli::missing_engine("pdfcli"))?;
    if file_ids.len() < 2 {
        return Err("pdf_merge needs at least two file ids".into());
    }
    let name = if store::allowed_ext(output_name).as_deref() == Some("pdf") {
        output_name.to_string()
    } else {
        format!("{}.pdf", store::sanitize_component(output_name))
    };
    let mut args = vec!["merge".to_string()];
    for id in file_ids {
        let (path, _) = require_pdf(user_id, id)?;
        args.push(path.display().to_string());
    }
    let tmp = std::env::temp_dir().join(format!("kawai-merge-{}", store::new_file_id()));
    args.push(tmp.display().to_string());
    cli::run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    if !tmp.is_file() {
        return Err("pdfcli merge produced no output".into());
    }
    let data = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    store::import_bytes(user_id, &name, &data)
}

/// `pdfcli split` → new stored files (one per part).
pub async fn pdf_split(
    user_id: &str,
    file_id: &str,
    ranges: Option<&str>,
) -> Result<Vec<OfficeFile>, String> {
    let (path, info) = require_pdf(user_id, file_id)?;
    let bin = cli::pdfcli_path().ok_or_else(|| cli::missing_engine("pdfcli"))?;
    let out_dir = std::env::temp_dir().join(format!("kawai-split-{}", store::new_file_id()));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut args = vec!["split".to_string()];
    if let Some(r) = ranges.filter(|r| !r.is_empty()) {
        args.extend(["--ranges".to_string(), r.to_string()]);
    }
    args.push(path.display().to_string());
    args.push(format!("{}/", out_dir.display()));
    cli::run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;

    let mut parts: Vec<PathBuf> = std::fs::read_dir(&out_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("pdf"))
        .collect();
    parts.sort();
    if parts.is_empty() {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err("pdfcli split produced no parts".into());
    }

    let base = info.original_name.trim_end_matches(".pdf");
    let mut files = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let data = std::fs::read(part).map_err(|e| e.to_string())?;
        let name = format!("{base} part {:02}.pdf", i + 1);
        files.push(store::import_bytes(user_id, &name, &data)?);
    }
    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(files)
}

/// `pdfcli info` → parsed JSON.
pub async fn pdf_info(user_id: &str, file_id: &str) -> Result<Value, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let bin = cli::pdfcli_path().ok_or_else(|| cli::missing_engine("pdfcli"))?;
    let out = cli::run_cli(
        &bin,
        &["info".to_string(), path.display().to_string()],
        None,
        None,
        CLI_TIMEOUT,
    )
    .await?;
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("pdfcli info returned invalid JSON: {e}"))
}
