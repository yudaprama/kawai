use serde_json::Value;

use super::cli::{self, CLI_TIMEOUT};
use super::store;
use super::store::OfficeFile;

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

/// `ooxcli edit` with ops JSON on stdin; output replaces the stored file.
pub async fn edit_document(
    user_id: &str,
    file_id: &str,
    operations: &[Value],
) -> Result<usize, String> {
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
    let out = cli::run_cli(
        &bin,
        &[
            "edit".to_string(),
            path.display().to_string(),
            "--out".to_string(),
            tmp.display().to_string(),
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
    store::replace_stored(user_id, file_id, &tmp)?;
    Ok(operations.len())
}

/// Minimal JS string escaping for the `<outDir>` substitution.
fn js_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

/// docbuilder create.
pub async fn create_document(
    user_id: &str,
    filename: &str,
    script: &str,
) -> Result<OfficeFile, String> {
    let ext = store::allowed_ext(filename)
        .ok_or_else(|| format!("unsupported output type: {filename} (docx/xlsx/pptx)"))?;
    let bin = cli::docbuilder_path().ok_or_else(|| cli::missing_engine("docbuilder"))?;
    let bin_dir = bin
        .parent()
        .ok_or("docbuilder has no parent dir")?
        .to_path_buf();

    let out_dir = std::env::temp_dir().join(format!("kawai-create-{}", store::new_file_id()));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out_dir_abs = out_dir.canonicalize().unwrap_or(out_dir.clone());

    let script_escaped = js_escape(&out_dir_abs.display().to_string());
    let script_sub = script.replace("<outDir>", &script_escaped);
    let script_sub = if script_sub.contains("builder.CloseFile") {
        format!("{script_sub}\n")
    } else {
        format!("{script_sub}\nbuilder.CloseFile();\n")
    };
    let script_path = out_dir.join("script.docbuilder");
    std::fs::write(&script_path, script_sub).map_err(|e| e.to_string())?;

    let args = vec![
        "--check-fonts=0".to_string(),
        format!("--save-use-only-names={}", out_dir_abs.display()),
        script_path.display().to_string(),
    ];
    let ran = cli::run_cli(&bin, &args, None, Some(&bin_dir), cli::DOCBUILDER_TIMEOUT).await;

    let produced = out_dir.join(format!("output.{ext}"));
    let result = if !produced.is_file() {
        let stderr = ran.as_ref().map(|o| o.stderr.trim()).unwrap_or("");
        Err(format!(
            "docbuilder produced no output at {} (stderr: {stderr}; verify the script calls builder.CreateFile(\"{ext}\") first and builder.SaveFile(\"{ext}\", \"<outDir>/output.{ext}\"))",
            produced.display()
        ))
    } else {
        match std::fs::read(&produced) {
            Ok(data) => store::import_bytes(user_id, filename, &data),
            Err(e) => Err(e.to_string()),
        }
    };
    let _ = std::fs::remove_dir_all(&out_dir);
    result
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
}
