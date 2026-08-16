//! Rig tools backed by the `ooxcli` binary built from github.com/yudaprama/gooxml.
//!
//! The binary path is resolved from `OOXCLI_BIN`, then `ooxcli` on `PATH`.

use rig::tool::PortableTool;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeEditArgs {
    pub filename: String,
    pub operations: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeEditOutput {
    pub filename: String,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeMarkdownArgs {
    pub filename: String,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeExtractTextArgs {
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeConvertArgs {
    pub input_path: String,
    pub output_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum OfficeToolError {
    #[error("filename is required")]
    MissingFilename,
    #[error("at least one operation is required")]
    MissingOperations,
    #[error("base_url must not be empty when provided")]
    EmptyBaseUrl,
    #[error("unsupported office file extension for {0:?}; expected .docx, .xlsx, or .pptx")]
    UnsupportedExtension(String),
    #[error("ooxcli binary not found; set OOXCLI_BIN or install ooxcli on PATH")]
    BinaryNotFound,
    #[error("failed to start ooxcli: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("ooxcli timed out after {0} seconds")]
    Timeout(u64),
    #[error("ooxcli failed with status {status}: {stderr}")]
    Process { status: String, stderr: String },
    #[error("ooxcli returned invalid UTF-8: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("encode operations: {0}")]
    Json(#[from] serde_json::Error),
    #[error("docbuilder binary not found; set DOCBUILDER_PATH or install docbuilder on PATH")]
    DocbuilderNotFound,
    #[error("docbuilder timed out after {0} seconds")]
    DocbuilderTimeout(u64),
    #[error("docbuilder failed with status {status}: {stderr}")]
    DocbuilderProcess { status: String, stderr: String },
    #[error("docbuilder produced no output file at {0}")]
    DocbuilderNoOutput(String),
    #[error("filename is required for create")]
    CreateMissingFilename,
    #[error("script is required for create")]
    CreateMissingScript,
    #[error("failed to write docbuilder script: {0}")]
    ScriptWrite(#[source] std::io::Error),
    #[error("failed to create temp dir: {0}")]
    TempDir(#[source] std::io::Error),
    #[error("failed to move output file: {0}")]
    MoveOutput(#[source] std::io::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum OfficeConvertError {
    #[error("file_path is required")]
    MissingFilePath,
    #[error("input_path is required")]
    MissingInputPath,
    #[error("output_path is required")]
    MissingOutputPath,
    #[error("x2t binary not found; set X2T_PATH or install x2t on PATH")]
    BinaryNotFound,
    #[error("failed to start x2t: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("x2t timed out after {0} seconds")]
    Timeout(u64),
    #[error("x2t failed with status {status}: {stderr}")]
    Process { status: String, stderr: String },
    #[error("read extracted text: {0}")]
    ReadText(#[source] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct OfficeMarkdownTool {
    binary: Option<PathBuf>,
    timeout_secs: u64,
}

impl Default for OfficeMarkdownTool {
    fn default() -> Self {
        Self {
            binary: None,
            timeout_secs: 60,
        }
    }
}

impl OfficeMarkdownTool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary = Some(path.into());
        self
    }

    pub fn with_timeout_secs(mut self, seconds: u64) -> Self {
        self.timeout_secs = seconds.max(1);
        self
    }

    fn binary(&self) -> PathBuf {
        self.binary
            .clone()
            .or_else(|| std::env::var_os("OOXCLI_BIN").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("ooxcli"))
    }

    async fn execute(&self, args: OfficeMarkdownArgs) -> Result<String, OfficeToolError> {
        validate_markdown_args(&args)?;
        let base_url = args.base_url.as_deref().unwrap_or("/files");
        let binary = self.binary();

        let mut command = Command::new(&binary);
        command
            .arg("extract")
            .arg("--baseurl")
            .arg(base_url)
            .arg(&args.filename)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let child = command.spawn().map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                OfficeToolError::BinaryNotFound
            } else {
                OfficeToolError::Spawn(err)
            }
        })?;

        let result = timeout(
            Duration::from_secs(self.timeout_secs),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| OfficeToolError::Timeout(self.timeout_secs))?
        .map_err(OfficeToolError::Spawn)?;

        let stdout = String::from_utf8(result.stdout)?;
        let stderr = String::from_utf8(result.stderr)?;
        if !result.status.success() {
            return Err(OfficeToolError::Process {
                status: result
                    .status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                stderr: if stderr.trim().is_empty() {
                    stdout.trim().to_string()
                } else {
                    stderr.trim().to_string()
                },
            });
        }

        Ok(stdout)
    }
}

impl PortableTool for OfficeMarkdownTool {
    const NAME: &'static str = "office_markdown__read";
    type Args = OfficeMarkdownArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Read a DOCX, XLSX, or PPTX office document and return its content as Markdown. Images are referenced using the configured base URL.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Path to the .docx, .xlsx, or .pptx document to read"
                },
                "base_url": {
                    "type": "string",
                    "description": "Base URL used for extracted images (defaults to /files)"
                }
            },
            "required": ["filename"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.execute(args).await
    }
}

#[derive(Debug, Clone, Default)]
pub struct OfficeEditTool {
    binary: Option<PathBuf>,
    timeout_secs: u64,
}

impl OfficeEditTool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary = Some(path.into());
        self
    }

    pub fn with_timeout_secs(mut self, seconds: u64) -> Self {
        self.timeout_secs = seconds.max(1);
        self
    }

    fn binary(&self) -> PathBuf {
        self.binary
            .clone()
            .or_else(|| std::env::var_os("OOXCLI_BIN").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("ooxcli"))
    }

    async fn execute(&self, args: OfficeEditArgs) -> Result<OfficeEditOutput, OfficeToolError> {
        validate_args(&args)?;
        let operations = serde_json::to_string(&args.operations)?;
        let binary = self.binary();

        let child = Command::new(&binary)
            .arg("edit")
            .arg(&args.filename)
            .arg("--ops")
            .arg(operations)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    OfficeToolError::BinaryNotFound
                } else {
                    OfficeToolError::Spawn(err)
                }
            })?;

        let result = timeout(
            Duration::from_secs(self.timeout_secs),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| OfficeToolError::Timeout(self.timeout_secs))?
        .map_err(OfficeToolError::Spawn)?;

        let stdout = String::from_utf8(result.stdout)?;
        let stderr = String::from_utf8(result.stderr)?;
        if !result.status.success() {
            return Err(OfficeToolError::Process {
                status: result
                    .status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                stderr: if stderr.trim().is_empty() {
                    stdout.trim().to_string()
                } else {
                    stderr.trim().to_string()
                },
            });
        }

        Ok(OfficeEditOutput {
            filename: args.filename,
            output: if stdout.trim().is_empty() {
                "Document edited successfully".to_string()
            } else {
                stdout.trim().to_string()
            },
        })
    }
}

impl PortableTool for OfficeEditTool {
    const NAME: &'static str = "office_edit";
    type Args = OfficeEditArgs;
    type Output = OfficeEditOutput;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Open an existing DOCX, XLSX, or PPTX file and apply declarative edit operations using gooxml. DOCX supports replace_text, append_paragraphs, append_table, delete_paragraph, and format_paragraph. XLSX supports replace_text, append_rows, and set_cell. PPTX supports replace_text, append_slides, and remove_slide.".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Existing .docx, .xlsx, or .pptx file to edit in place"
                },
                "operations": {
                    "type": "array",
                    "description": "Operations applied sequentially. Each item must contain a type and operation-specific fields.",
                    "items": { "type": "object" }
                }
            },
            "required": ["filename", "operations"]
        })
    }

    async fn call(&self, arguments: Self::Args) -> Result<Self::Output, Self::Error> {
        self.execute(arguments).await
    }
}

pub fn office_edit_tool() -> OfficeEditTool {
    OfficeEditTool::new()
}

pub fn office_markdown_tool() -> OfficeMarkdownTool {
    OfficeMarkdownTool::new()
}

// ---------------------------------------------------------------------------
#[derive(Debug, Clone)]
pub struct OfficeExtractTextTool {
    binary: Option<PathBuf>,
    font_dir: Option<PathBuf>,
    timeout_secs: u64,
}

impl Default for OfficeExtractTextTool {
    fn default() -> Self {
        Self {
            binary: None,
            font_dir: None,
            timeout_secs: 180,
        }
    }
}

impl OfficeExtractTextTool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary = Some(path.into());
        self
    }

    pub fn with_font_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.font_dir = Some(path.into());
        self
    }

    pub fn with_timeout_secs(mut self, seconds: u64) -> Self {
        self.timeout_secs = seconds.max(1);
        self
    }

    fn binary(&self) -> PathBuf {
        self.binary
            .clone()
            .or_else(|| std::env::var_os("X2T_PATH").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("x2t"))
    }

    fn font_dir(&self) -> Option<PathBuf> {
        self.font_dir
            .clone()
            .or_else(|| std::env::var_os("OFFICE_FONTS_DIR").map(PathBuf::from))
    }

    async fn convert_file(&self, input: &str, output: &str) -> Result<(), OfficeConvertError> {
        let mut command = Command::new(self.binary());
        command.arg(input).arg(output);
        if let Some(font_dir) = self.font_dir() {
            command.arg(font_dir);
        }
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| {
                if err.kind() == std::io::ErrorKind::NotFound {
                    OfficeConvertError::BinaryNotFound
                } else {
                    OfficeConvertError::Spawn(err)
                }
            })?;
        let result = timeout(
            Duration::from_secs(self.timeout_secs),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| OfficeConvertError::Timeout(self.timeout_secs))?
        .map_err(OfficeConvertError::Spawn)?;
        if !result.status.success() {
            return Err(OfficeConvertError::Process {
                status: result
                    .status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "signal".into()),
                stderr: String::from_utf8_lossy(&result.stderr).trim().into(),
            });
        }
        Ok(())
    }
}

impl PortableTool for OfficeExtractTextTool {
    const NAME: &'static str = "extract_text";
    type Args = OfficeExtractTextArgs;
    type Output = String;
    type Error = OfficeConvertError;

    fn description(&self) -> String {
        "Extract plain text from any office document or PDF via ONLYOFFICE x2t.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({"type":"object","properties":{"file_path":{"type":"string","description":"Path of the office document or PDF to extract"}},"required":["file_path"]})
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        if args.file_path.trim().is_empty() {
            return Err(OfficeConvertError::MissingFilePath);
        }
        let temp = tempfile::Builder::new()
            .suffix(".txt")
            .tempfile()
            .map_err(OfficeConvertError::ReadText)?;
        self.convert_file(&args.file_path, &temp.path().to_string_lossy())
            .await?;
        let text = std::fs::read_to_string(temp.path()).map_err(OfficeConvertError::ReadText)?;
        Ok(
            json!({"success": true, "text": text.trim_matches(['\0', ' ', '\t', '\r', '\n'])})
                .to_string(),
        )
    }
}

#[derive(Debug, Clone, Default)]
pub struct OfficeConvertTool {
    extractor: OfficeExtractTextTool,
}

impl OfficeConvertTool {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.extractor = self.extractor.with_binary(path);
        self
    }
    pub fn with_font_dir(mut self, path: impl Into<PathBuf>) -> Self {
        self.extractor = self.extractor.with_font_dir(path);
        self
    }
    pub fn with_timeout_secs(mut self, seconds: u64) -> Self {
        self.extractor = self.extractor.with_timeout_secs(seconds);
        self
    }
}

impl PortableTool for OfficeConvertTool {
    const NAME: &'static str = "convert_document";
    type Args = OfficeConvertArgs;
    type Output = String;
    type Error = OfficeConvertError;

    fn description(&self) -> String {
        "Convert between office and PDF formats via ONLYOFFICE x2t. The target format is inferred from output_path's extension.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({"type":"object","properties":{"input_path":{"type":"string","description":"Path of the source document"},"output_path":{"type":"string","description":"Path of the converted output; its extension selects the target format"}},"required":["input_path","output_path"]})
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        if args.input_path.trim().is_empty() {
            return Err(OfficeConvertError::MissingInputPath);
        }
        if args.output_path.trim().is_empty() {
            return Err(OfficeConvertError::MissingOutputPath);
        }
        self.extractor
            .convert_file(&args.input_path, &args.output_path)
            .await?;
        Ok(
            json!({"success":true,"input_path":args.input_path,"output_path":args.output_path})
                .to_string(),
        )
    }
}

pub fn office_extract_text_tool() -> OfficeExtractTextTool {
    OfficeExtractTextTool::new()
}
pub fn office_convert_tool() -> OfficeConvertTool {
    OfficeConvertTool::new()
}

// OfficeCreateTool — create new docx/xlsx/pptx via docbuilder
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeCreateArgs {
    pub filename: String,
    pub script: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfficeCreateOutput {
    pub success: bool,
    pub output_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct OfficeCreateTool {
    binary: Option<PathBuf>,
    timeout_secs: u64,
}

impl OfficeCreateTool {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary = Some(path.into());
        self
    }

    pub fn with_timeout_secs(mut self, seconds: u64) -> Self {
        self.timeout_secs = seconds.max(1);
        self
    }

    fn binary(&self) -> PathBuf {
        self.binary
            .clone()
            .or_else(|| std::env::var_os("DOCBUILDER_PATH").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("docbuilder"))
    }

    async fn execute(&self, args: OfficeCreateArgs) -> Result<OfficeCreateOutput, OfficeToolError> {
        if args.filename.trim().is_empty() {
            return Err(OfficeToolError::CreateMissingFilename);
        }
        if args.script.trim().is_empty() {
            return Err(OfficeToolError::CreateMissingScript);
        }

        let ext = extract_extension(&args.filename);
        let ext = ext.as_deref().unwrap_or("docx");

        let binary = self.binary();
        let bin_dir = binary.parent().map(|p| p.to_path_buf());

        // Create temp dir for output
        let out_dir = tempfile::tempdir().map_err(OfficeToolError::TempDir)?;
        let out_dir_path = out_dir.path().to_path_buf();

        // Substitute <outDir> in script and write to temp file
        let script = substitute_out_dir(&args.script, &out_dir_path);
        let script_path = out_dir_path.join("create.docbuilder");
        fs::write(&script_path, &script)
            .await
            .map_err(OfficeToolError::ScriptWrite)?;

        let mut cmd = Command::new(&binary);
        cmd.arg("--check-fonts=0")
            .arg("--save-use-only-names")
            .arg(&out_dir_path)
            .arg(&script_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Set LD_LIBRARY_PATH if we have a bin dir
        if let Some(ref dir) = bin_dir {
            cmd.env("LD_LIBRARY_PATH", dir);
        }

        let child = cmd.spawn().map_err(|err| {
            if err.kind() == std::io::ErrorKind::NotFound {
                OfficeToolError::DocbuilderNotFound
            } else {
                OfficeToolError::Spawn(err)
            }
        })?;

        let result = timeout(
            Duration::from_secs(self.timeout_secs),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| OfficeToolError::DocbuilderTimeout(self.timeout_secs))?
        .map_err(OfficeToolError::Spawn)?;

        let stderr = String::from_utf8(result.stderr)?;
        if !result.status.success() {
            return Err(OfficeToolError::DocbuilderProcess {
                status: result
                    .status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                stderr: stderr.trim().to_string(),
            });
        }

        let expected = out_dir_path.join(format!("output.{}", ext));
        if !expected.exists() {
            return Err(OfficeToolError::DocbuilderNoOutput(
                expected.display().to_string(),
            ));
        }

        // Move output to the user-specified path
        let final_path = PathBuf::from(&args.filename);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(OfficeToolError::MoveOutput)?;
        }
        fs::copy(&expected, &final_path)
            .await
            .map_err(OfficeToolError::MoveOutput)?;

        Ok(OfficeCreateOutput {
            success: true,
            output_path: final_path
                .canonicalize()
                .unwrap_or(final_path)
                .display()
                .to_string(),
        })
    }
}

impl PortableTool for OfficeCreateTool {
    const NAME: &'static str = "office_create";
    type Args = OfficeCreateArgs;
    type Output = OfficeCreateOutput;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Create a new office document (docx/xlsx/pptx) from an LLM-authored ONLYOFFICE docbuilder JS script. The script is a complete docbuilder program using builder.CreateFile, Api.*, and builder.SaveFile. Requires docbuilder (Linux/prod only).".to_string()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "filename": {
                    "type": "string",
                    "description": "Output filename (e.g. report.docx, sheet.xlsx, deck.pptx)"
                },
                "script": {
                    "type": "string",
                    "description": "ONLYOFFICE docbuilder JS program. Use builder.CreateFile(ext), Api.GetDocument(), Api.CreateParagraph(), Api.CreateRun(), Api.CreateTable(), builder.SaveFile(), etc. Save output to <outDir>/output.<ext> where <outDir> is replaced automatically."
                }
            },
            "required": ["filename", "script"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        self.execute(args).await
    }
}

pub fn office_create_tool() -> OfficeCreateTool {
    OfficeCreateTool::new()
}

fn substitute_out_dir(script: &str, out_dir: &std::path::Path) -> String {
    let escaped = js_string(out_dir.display().to_string());
    script.replace("<outDir>", &escaped)
}

fn js_string(s: String) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

fn extract_extension(filename: &str) -> Option<String> {
    let lower = filename.to_ascii_lowercase();
    let dot = lower.rfind('.')?;
    let ext = &lower[dot + 1..];
    match ext {
        "docx" | "xlsx" | "pptx" => Some(ext.to_string()),
        _ => None,
    }
}

fn validate_args(args: &OfficeEditArgs) -> Result<(), OfficeToolError> {
    if args.filename.trim().is_empty() {
        return Err(OfficeToolError::MissingFilename);
    }
    if args.operations.is_empty() {
        return Err(OfficeToolError::MissingOperations);
    }
    let lower = args.filename.to_ascii_lowercase();
    if ![".docx", ".xlsx", ".pptx"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        return Err(OfficeToolError::UnsupportedExtension(args.filename.clone()));
    }
    Ok(())
}

fn validate_markdown_args(args: &OfficeMarkdownArgs) -> Result<(), OfficeToolError> {
    if args.filename.trim().is_empty() {
        return Err(OfficeToolError::MissingFilename);
    }
    if let Some(base_url) = &args.base_url {
        if base_url.trim().is_empty() {
            return Err(OfficeToolError::EmptyBaseUrl);
        }
    }
    let lower = args.filename.to_ascii_lowercase();
    if ![".docx", ".xlsx", ".pptx"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        return Err(OfficeToolError::UnsupportedExtension(args.filename.clone()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig::tool::PortableTool;
    use serde_json::json;

    #[test]
    fn exposes_office_edit_schema() {
        let tool = OfficeEditTool::new();
        assert_eq!(OfficeEditTool::NAME, "office_edit");
        assert!(tool.parameters()["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|value| value == "operations"));
    }

    #[test]
    fn validates_extensions_and_operations() {
        let missing = OfficeEditArgs {
            filename: "file.pdf".into(),
            operations: vec![json!({"type": "replace_text"})],
        };
        assert!(matches!(
            validate_args(&missing),
            Err(OfficeToolError::UnsupportedExtension(_))
        ));

        let empty = OfficeEditArgs {
            filename: "file.docx".into(),
            operations: vec![],
        };
        assert!(matches!(
            validate_args(&empty),
            Err(OfficeToolError::MissingOperations)
        ));
    }

    #[test]
    fn exposes_office_markdown_schema() {
        let tool = OfficeMarkdownTool::new();
        assert_eq!(OfficeMarkdownTool::NAME, "office_markdown__read");
        assert!(tool.parameters()["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|value| value == "filename"));
    }

    #[test]
    fn validates_markdown_arguments() {
        let args = OfficeMarkdownArgs {
            filename: "file.pdf".into(),
            base_url: None,
        };
        assert!(matches!(
            validate_markdown_args(&args),
            Err(OfficeToolError::UnsupportedExtension(_))
        ));

        let args = OfficeMarkdownArgs {
            filename: "file.docx".into(),
            base_url: Some("  ".into()),
        };
        assert!(matches!(
            validate_markdown_args(&args),
            Err(OfficeToolError::EmptyBaseUrl)
        ));
    }

    #[tokio::test]
    async fn executes_ooxcli_replace_text() {
        let ooxcli = std::env::var("OOXCLI_BIN").unwrap_or_else(|_| "ooxcli".to_string());
        // Skip if the binary isn't available (CI environment without gooxml build).
        if std::process::Command::new(&ooxcli)
            .arg("version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_err()
        {
            eprintln!("skipping integration test: {ooxcli} not found");
            return;
        }

        let dir = std::env::temp_dir().join("office-rig-test-XXXXX");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let src = format!(
            "{}/gooxml/cmd/docx2md/markdown.docx",
            env!("CARGO_MANIFEST_DIR")
                .trim_end_matches("/rig-tools/tools/office")
                .trim_end_matches("/tools/office")
        );
        let dest = dir.join("test.docx");
        std::fs::copy(&src, &dest).expect("copy test file");

        let tool = OfficeEditTool::new()
            .with_binary(&ooxcli)
            .with_timeout_secs(30);
        let args = OfficeEditArgs {
            filename: dest.to_string_lossy().to_string(),
            operations: vec![
                json!({"type": "replace_text", "find": "Some text", "replace": "REPLACED"}),
            ],
        };

        let output = tool.call(args).await.expect("edit failed");
        assert!(
            output.output.contains("successfully"),
            "got: {}",
            output.output
        );

        // Verify the file was actually modified by extracting text.
        let verify = std::process::Command::new(&ooxcli)
            .arg("extract")
            .arg(dest.to_string_lossy().to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .expect("extract failed");
        let text = String::from_utf8_lossy(&verify.stdout);
        assert!(
            text.contains("REPLACED"),
            "text should contain REPLACED:\n{text}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn executes_ooxcli_extract_markdown() {
        let ooxcli = std::env::var("OOXCLI_BIN").unwrap_or_else(|_| "ooxcli".to_string());
        if std::process::Command::new(&ooxcli)
            .arg("version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_err()
        {
            eprintln!("skipping integration test: {ooxcli} not found");
            return;
        }

        let source = format!(
            "{}/gooxml/cmd/docx2md/markdown.docx",
            env!("CARGO_MANIFEST_DIR")
                .trim_end_matches("/rig-tools/tools/office")
                .trim_end_matches("/tools/office")
        );
        let output = OfficeMarkdownTool::new()
            .with_binary(&ooxcli)
            .with_timeout_secs(30)
            .call(OfficeMarkdownArgs {
                filename: source,
                base_url: Some("/files".into()),
            })
            .await
            .expect("extract failed");
        assert!(!output.trim().is_empty());
    }

    #[test]
    fn exposes_office_convert_schemas() {
        let extract = OfficeExtractTextTool::new();
        assert_eq!(OfficeExtractTextTool::NAME, "extract_text");
        assert!(extract.parameters()["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|value| value == "file_path"));

        let convert = OfficeConvertTool::new();
        assert_eq!(OfficeConvertTool::NAME, "convert_document");
        assert_eq!(
            convert.parameters()["required"].as_array().unwrap().len(),
            2
        );
    }

    #[tokio::test]
    async fn validates_office_convert_arguments() {
        let extract = OfficeExtractTextTool::new();
        assert!(matches!(
            extract
                .call(OfficeExtractTextArgs {
                    file_path: "  ".into()
                })
                .await,
            Err(OfficeConvertError::MissingFilePath)
        ));

        let convert = OfficeConvertTool::new();
        assert!(matches!(
            convert
                .call(OfficeConvertArgs {
                    input_path: "input.docx".into(),
                    output_path: "  ".into(),
                })
                .await,
            Err(OfficeConvertError::MissingOutputPath)
        ));
    }
}
