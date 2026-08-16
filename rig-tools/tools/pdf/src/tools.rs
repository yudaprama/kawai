//! PDF tools backed by the `pdfcli` binary. Hand-written mirror of
//! `components/tool/pdf/pdf.go` (Eino) for rig.rs: each tool shells out to
//! `pdfcli` instead of linking `github.com/yudaprama/pdf` directly.

use std::collections::BTreeMap;

use rig::tool::PortableTool;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::pdfcli::{ToolBase, ToolError, ToolOptions};

/// Append `--pages <spec>` unless pages is empty or `*` (meaning all pages).
fn push_pages(args: &mut Vec<String>, pages: &Option<String>) {
    if let Some(p) = pages {
        let t = p.trim();
        if !t.is_empty() && t != "*" {
            args.push("--pages".into());
            args.push(t.to_string());
        }
    }
}

/// Parse `pdfcli extract` stdout (`--- page N ---\ntext`) into a page→text map.
fn parse_extract_pages(stdout: &str) -> BTreeMap<String, String> {
    let mut pages = BTreeMap::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("--- page ") {
            if let Some(num) = rest.strip_suffix(" ---") {
                if let Some((n, lines)) = current.take() {
                    pages.insert(n, lines.join("\n").trim_end().to_string());
                }
                current = Some((num.trim().to_string(), Vec::new()));
                continue;
            }
        }
        if let Some((_, lines)) = current.as_mut() {
            lines.push(line.to_string());
        }
    }
    if let Some((n, lines)) = current.take() {
        pages.insert(n, lines.join("\n").trim_end().to_string());
    }
    pages
}

// ---------------------------------------------------------------------------
// pdf_search_replace
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfSearchReplaceArgs {
    #[serde(rename = "pattern")]
    pub pattern: String,
    #[serde(rename = "replacement")]
    pub replacement: String,
    #[serde(rename = "pages")]
    pub pages: Option<String>,
    #[serde(rename = "inputPath")]
    pub input_path: String,
    #[serde(rename = "outputPath")]
    pub output_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct PdfSearchReplaceTool {
    base: ToolBase,
}

impl PdfSearchReplaceTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfSearchReplaceTool {
    const NAME: &'static str = "pdf_search_replace";
    type Args = PdfSearchReplaceArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Search and replace text in PDF files. Returns the number of pages with matches and the output path."
            .into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Text pattern to search in PDF" },
                "replacement": { "type": "string", "description": "Replacement text" },
                "pages": { "type": "string", "description": "Comma-separated page numbers (e.g. 1,2) or '*' for all pages. Defaults to '*'" },
                "inputPath": { "type": "string", "description": "Input PDF path" },
                "outputPath": { "type": "string", "description": "Output PDF path" }
            },
            "required": ["pattern", "replacement", "inputPath", "outputPath"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut search_args = vec!["search".to_string(), args.pattern.clone()];
        push_pages(&mut search_args, &args.pages);
        search_args.push(args.input_path.clone());
        let matches = self.base.run_json(&search_args).await?;
        let page_count = matches.as_array().map(|a| a.len()).unwrap_or(0);

        let mut replace_args = vec![
            "replace".to_string(),
            args.pattern.clone(),
            args.replacement.clone(),
        ];
        push_pages(&mut replace_args, &args.pages);
        replace_args.push(args.input_path);
        replace_args.push(args.output_path.clone());
        self.base.run(&replace_args).await?;

        Ok(format!(
            "Replaced {:?} with {:?}. Matches found on {} page(s). Output: {}",
            args.pattern, args.replacement, page_count, args.output_path
        ))
    }
}

// ---------------------------------------------------------------------------
// pdf_search_text
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfSearchTextArgs {
    #[serde(rename = "pattern")]
    pub pattern: String,
    #[serde(rename = "pages")]
    pub pages: Option<String>,
    #[serde(rename = "inputPath")]
    pub input_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct PdfSearchTextTool {
    base: ToolBase,
}

impl PdfSearchTextTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfSearchTextTool {
    const NAME: &'static str = "pdf_search_text";
    type Args = PdfSearchTextArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Search text in PDF files and return page-level match information".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "description": "Text pattern to search in PDF" },
                "pages": { "type": "string", "description": "Comma-separated page numbers (e.g. 1,2) or '*' for all pages. Defaults to '*'" },
                "inputPath": { "type": "string", "description": "Input PDF path" }
            },
            "required": ["pattern", "inputPath"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut cli = vec!["search".to_string(), args.pattern.clone()];
        push_pages(&mut cli, &args.pages);
        cli.push(args.input_path);
        let matches = self.base.run_json(&cli).await?;
        Ok(json!({ "pattern": args.pattern, "matches": matches }).to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_extract_text
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfExtractTextArgs {
    #[serde(rename = "pages")]
    pub pages: Option<String>,
    #[serde(rename = "inputPath")]
    pub input_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct PdfExtractTextTool {
    base: ToolBase,
}

impl PdfExtractTextTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfExtractTextTool {
    const NAME: &'static str = "pdf_extract_text";
    type Args = PdfExtractTextArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Extract text from PDF pages. Returns a map of page number to extracted text.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pages": { "type": "string", "description": "Comma-separated page numbers (e.g. 1,2) or '*' for all pages. Defaults to '*'" },
                "inputPath": { "type": "string", "description": "Input PDF path" }
            },
            "required": ["inputPath"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut cli = vec!["extract".to_string()];
        push_pages(&mut cli, &args.pages);
        cli.push(args.input_path);
        let stdout = self.base.run(&cli).await?;
        Ok(json!({ "pages": parse_extract_pages(&stdout) }).to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_merge
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfMergeArgs {
    #[serde(rename = "inputPaths")]
    pub input_paths: Vec<String>,
    #[serde(rename = "outputPath")]
    pub output_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct PdfMergeTool {
    base: ToolBase,
}

impl PdfMergeTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfMergeTool {
    const NAME: &'static str = "pdf_merge";
    type Args = PdfMergeArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Merge multiple PDF files into one output PDF".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "inputPaths": { "type": "array", "items": { "type": "string" }, "description": "List of input PDF paths to merge in order" },
                "outputPath": { "type": "string", "description": "Output PDF path" }
            },
            "required": ["inputPaths", "outputPath"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let file_count = args.input_paths.len();
        let mut cli = vec!["merge".to_string()];
        cli.extend(args.input_paths.clone());
        cli.push(args.output_path.clone());
        self.base.run(&cli).await?;

        let page_count = self
            .base
            .run_json(["info".to_string(), args.output_path.clone()].as_ref())
            .await
            .ok()
            .and_then(|v| v.get("pageCount").and_then(|c| c.as_u64()))
            .unwrap_or(0);

        Ok(json!({
            "outputPath": args.output_path,
            "fileCount": file_count,
            "pageCount": page_count
        })
        .to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_split
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfSplitArgs {
    #[serde(rename = "inputPath")]
    pub input_path: String,
    #[serde(rename = "outputDir")]
    pub output_dir: String,
    #[serde(rename = "ranges")]
    pub ranges: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PdfSplitTool {
    base: ToolBase,
}

impl PdfSplitTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfSplitTool {
    const NAME: &'static str = "pdf_split";
    type Args = PdfSplitArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Split a PDF into multiple output PDFs. Returns the list of generated paths.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "inputPath": { "type": "string", "description": "Input PDF path" },
                "outputDir": { "type": "string", "description": "Output directory for split PDF files" },
                "ranges": { "type": "string", "description": "Comma-separated page ranges (e.g. 1-2,3,4-5). Defaults to one output per page" }
            },
            "required": ["inputPath", "outputDir"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut cli = vec!["split".to_string()];
        if let Some(r) = &args.ranges {
            let t = r.trim();
            if !t.is_empty() {
                cli.push("--ranges".into());
                cli.push(t.to_string());
            }
        }
        cli.push(args.input_path.clone());
        cli.push(args.output_dir.clone());
        let outputs = self.base.run_json(&cli).await?;
        Ok(json!({
            "inputPath": args.input_path,
            "outputPaths": outputs
        })
        .to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_page_info
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfPageInfoArgs {
    #[serde(rename = "inputPath")]
    pub input_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct PdfPageInfoTool {
    base: ToolBase,
}

impl PdfPageInfoTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfPageInfoTool {
    const NAME: &'static str = "pdf_page_info";
    type Args = PdfPageInfoArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Get PDF page count and page-level size/rotation information".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "inputPath": { "type": "string", "description": "Input PDF path" }
            },
            "required": ["inputPath"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let info = self
            .base
            .run_json(["info".to_string(), args.input_path].as_ref())
            .await?;
        Ok(info.to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_metadata_get
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfMetadataGetArgs {
    #[serde(rename = "inputPath")]
    pub input_path: String,
}

#[derive(Debug, Clone, Default)]
pub struct PdfMetadataGetTool {
    base: ToolBase,
}

impl PdfMetadataGetTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfMetadataGetTool {
    const NAME: &'static str = "pdf_metadata_get";
    type Args = PdfMetadataGetArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Get document metadata from a PDF Info dictionary".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "inputPath": { "type": "string", "description": "Input PDF path" }
            },
            "required": ["inputPath"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let meta = self
            .base
            .run_json(
                ["metadata".to_string(), "get".to_string(), args.input_path].as_ref(),
            )
            .await?;
        Ok(json!({ "metadata": meta }).to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_metadata_set
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfMetadataSetArgs {
    #[serde(rename = "inputPath")]
    pub input_path: String,
    #[serde(rename = "outputPath")]
    pub output_path: String,
    #[serde(rename = "metadata")]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct PdfMetadataSetTool {
    base: ToolBase,
}

impl PdfMetadataSetTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfMetadataSetTool {
    const NAME: &'static str = "pdf_metadata_set";
    type Args = PdfMetadataSetArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Set document metadata fields (Title, Author, Subject, Keywords, Creator, Producer). Returns the resulting metadata.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "inputPath": { "type": "string", "description": "Input PDF path" },
                "outputPath": { "type": "string", "description": "Output PDF path" },
                "metadata": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Metadata fields to set: Title, Author, Subject, Keywords, Creator, Producer" }
            },
            "required": ["inputPath", "outputPath", "metadata"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mut cli = vec![
            "metadata".to_string(),
            "set".to_string(),
            args.input_path.clone(),
            args.output_path.clone(),
        ];
        for (key, value) in &args.metadata {
            let flag = match key.to_lowercase().as_str() {
                "title" => "--title",
                "author" => "--author",
                "subject" => "--subject",
                "keywords" => "--keywords",
                "creator" => "--creator",
                "producer" => "--producer",
                _ => continue,
            };
            cli.push(flag.to_string());
            cli.push(value.clone());
        }
        self.base.run(&cli).await?;

        let updated = self
            .base
            .run_json(
                [
                    "metadata".to_string(),
                    "get".to_string(),
                    args.output_path.clone(),
                ]
                .as_ref(),
            )
            .await?;

        Ok(json!({
            "inputPath": args.input_path,
            "outputPath": args.output_path,
            "metadata": updated
        })
        .to_string())
    }
}

// ---------------------------------------------------------------------------
// pdf_extract_images
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PdfExtractImagesArgs {
    #[serde(rename = "inputPath")]
    pub input_path: String,
    #[serde(rename = "outputDir")]
    pub output_dir: String,
    #[serde(rename = "pages")]
    pub pages: Option<String>,
    #[serde(rename = "format")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct PdfExtractImagesTool {
    base: ToolBase,
}

impl PdfExtractImagesTool {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            base: ToolBase::new(opts),
        }
    }
}

impl PortableTool for PdfExtractImagesTool {
    const NAME: &'static str = "pdf_extract_images";
    type Args = PdfExtractImagesArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Extract raster images from PDF pages to files. Returns image location and geometry metadata.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "inputPath": { "type": "string", "description": "Input PDF path" },
                "outputDir": { "type": "string", "description": "Output directory for extracted images" },
                "pages": { "type": "string", "description": "Page selection like '*' or 1-3,5. Defaults to '*'" },
                "format": { "type": "string", "description": "Output image format: png or jpg. Defaults to png" }
            },
            "required": ["inputPath", "outputDir"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let format = args
            .format
            .clone()
            .unwrap_or_else(|| "png".to_string())
            .to_lowercase();
        let mut cli = vec!["images".to_string()];
        push_pages(&mut cli, &args.pages);
        if !format.is_empty() {
            cli.push("--format".into());
            cli.push(format.clone());
        }
        cli.push(args.input_path.clone());
        cli.push(args.output_dir.clone());
        let images = self.base.run_json(&cli).await?;
        Ok(json!({
            "inputPath": args.input_path,
            "outputDir": args.output_dir,
            "format": format,
            "images": images
        })
        .to_string())
    }
}
