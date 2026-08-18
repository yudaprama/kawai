use rig::tool::PortableTool;
use serde::Deserialize;
use serde_json::{json, Value};

use super::error::{oerr, OfficeToolError};
use super::ooxml;
use super::pdf;
use super::store;
use super::{schema, truncate_chars};

// -- office_list_files -------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesArgs {}

pub struct ListFilesTool(pub String);

impl PortableTool for ListFilesTool {
    const NAME: &'static str = "office_list_files";
    type Args = ListFilesArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "List the user's stored office documents (docx, xlsx, pptx, pdf). Returns id, originalName, ext, bytes, createdAt. Every other tool addresses files by that id.".into()
    }

    fn parameters(&self) -> Value {
        schema!({ "type": "object", "properties": {} })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, OfficeToolError> {
        let files = store::list_files(&self.0).map_err(oerr)?;
        Ok(json!({ "files": files }).to_string())
    }
}

// -- knowledge_search --------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchArgs {
    pub query: String,
}

/// Hybrid (vector + BM25) search over the documents this session uploaded.
/// `user_id` + `session_id` are bound at construction (server-side state) —
/// the model only supplies the query.
pub struct KnowledgeSearchTool(pub String, pub i64);

impl PortableTool for KnowledgeSearchTool {
    const NAME: &'static str = "knowledge_search";
    type Args = KnowledgeSearchArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Search the documents uploaded in this conversation for relevant passages. Use this FIRST when the user asks about content that may be in their documents (numbers, names, dates, invoice codes, tables). Returns the best matching excerpts with their source document.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to look for — keywords, codes, or a question." }
            },
            "required": ["query"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let hits = crate::logic::rag::knowledge_search(
            self.0.clone(),
            self.1,
            args.query,
        )
        .await
        .map_err(oerr)?;
        if hits.is_empty() {
            return Ok(
                json!({ "hits": [], "note": "No documents match. Either nothing was uploaded in this conversation, or none of them contains the answer." })
                    .to_string(),
            );
        }
        Ok(json!({ "hits": hits }).to_string())
    }
}

// -- office_read_document ----------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdArgs {
    pub file_id: String,
}

pub struct ReadDocumentTool(pub String);

impl PortableTool for ReadDocumentTool {
    const NAME: &'static str = "office_read_document";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Read a stored .docx/.xlsx/.pptx and return its full content as markdown (headings, tables, lists). For PDFs use pdf_extract_text.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let md = ooxml::read_document(&self.0, &args.file_id)
            .await
            .map_err(oerr)?;
        Ok(json!({ "markdown": truncate_chars(&md, 60_000) }).to_string())
    }
}

pub struct DocumentInfoTool(pub String);

impl PortableTool for DocumentInfoTool {
    const NAME: &'static str = "office_document_info";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Inspect a stored office document: type, paragraph/sheet/slide counts, core properties (title, author, dates). Cheaper than reading the whole document.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let info = ooxml::document_info(&self.0, &args.file_id)
            .await
            .map_err(oerr)?;
        Ok(info.to_string())
    }
}

// -- office_edit_document ----------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditDocumentArgs {
    pub file_id: String,
    pub operations: Vec<Value>,
}

pub struct EditDocumentTool(pub String);

impl PortableTool for EditDocumentTool {
    const NAME: &'static str = "office_edit_document";
    type Args = EditDocumentArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Edit an existing stored document by applying operations sequentially. \
.docx ops: replace_text{find,replace?} (omit replace to delete), \
append_paragraphs{paragraphs:[{type:paragraph|heading1|heading2|heading3|title|bullet, runs:[{text,bold?,italic?,size?,color?,font?}]}]}, \
append_table{rows:[{cells:[{text}]}]}, delete_paragraph{find}, \
format_paragraph{find, alignment?:left|center|right|justify, spacing_before?, spacing_after?, indent_left?, indent_right?}. \
.xlsx ops: replace_text{find,replace}, append_rows{sheet?, cell_rows:[{values:[...]}]} (values type-inferred), \
set_cell{cells:[{cell,value}]}. \
.pptx ops: replace_text{find,replace}, append_slides{slides:[{title,body:[...]}]}, remove_slide{find}."
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files" },
                "operations": {
                    "type": "array",
                    "description": "Edit operations, applied in order. Each has a \"type\" field; allowed types depend on the file format (see description).",
                    "items": { "type": "object" }
                }
            },
            "required": ["fileId", "operations"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        if args.operations.is_empty() {
            return Err(OfficeToolError("operations must not be empty".into()));
        }
        if args.operations.len() > 50 {
            return Err(OfficeToolError("too many operations (max 50)".into()));
        }
        let outcome = ooxml::edit_document(&self.0, &args.file_id, &args.operations)
            .await
            .map_err(oerr)?;
        Ok(json!({
            "success": true,
            "operationsApplied": args.operations.len(),
            "rowsModified": outcome.rows_modified,
            "operations": outcome.operations,
        })
        .to_string())
    }
}

// -- office_create_document --------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentArgs {
    pub filename: String,
    pub script: String,
}

pub struct CreateDocumentTool(pub String);

impl PortableTool for CreateDocumentTool {
    const NAME: &'static str = "office_create_document";
    type Args = CreateDocumentArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Create a NEW office document (.docx/.xlsx/.pptx) by writing an ONLYOFFICE docbuilder JS program. \
Lifecycle: builder.CreateFile(\"docx\"|\"xlsx\"|\"pptx\") … builder.SaveFile(\"docx\", \"<outDir>/output.docx\"); builder.CloseFile(); \
Word: var doc=Api.GetDocument(); var p=Api.CreateParagraph(); var r=Api.CreateRun(); r.AddText(\"…\"); r.SetBold(true); r.SetFontSize(24); p.AddElement(r); doc.Push(p); tables via doc.CreateTable(rows, cols) then cell.GetContent().AddElement(Api.CreateParagraph().AddText(\"…\")). \
Sheets: var s=Api.GetActiveSheet(); s.GetRange(\"A1:B2\").SetValue([[…]]); formulas via SetFormula. Save output to <outDir>/output.<ext> (the <outDir> placeholder is substituted for you; CloseFile is appended if you omit it). Keep the script small and focused."
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "filename": { "type": "string", "description": "Output filename, e.g. report.docx / sheet.xlsx / deck.pptx" },
                "script": { "type": "string", "description": "Complete docbuilder JS program (builder.CreateFile, Api.*, builder.SaveFile). Save to <outDir>/output.<ext>." }
            },
            "required": ["filename", "script"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let file = ooxml::create_document(&self.0, &args.filename, &args.script)
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "file": file }).to_string())
    }
}

// -- pdf tools -----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPagesArgs {
    pub file_id: String,
    pub pages: Option<String>,
}

pub struct PdfExtractTextTool(pub String);

impl PortableTool for PdfExtractTextTool {
    const NAME: &'static str = "pdf_extract_text";
    type Args = PdfPagesArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Extract text from a stored PDF (optionally only the given pages, e.g. \"2-4\"). Output is prefixed per page: --- page N ---".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "pages": { "type": "string", "description": "Optional page spec: \"1,3,5\" or \"1-3\" or \"*\"" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let text = pdf::pdf_extract_text(&self.0, &args.file_id, args.pages.as_deref())
            .await
            .map_err(oerr)?;
        Ok(json!({ "text": truncate_chars(&text, 60_000) }).to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchArgs {
    pub file_id: String,
    pub pattern: String,
    pub pages: Option<String>,
}

pub struct PdfSearchTextTool(pub String);

impl PortableTool for PdfSearchTextTool {
    const NAME: &'static str = "pdf_search_text";
    type Args = PdfSearchArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Search text in a stored PDF. Returns a JSON array of {page, matches} entries (empty array = no hits).".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "pattern": { "type": "string" },
                "pages": { "type": "string" }
            },
            "required": ["fileId", "pattern"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let hits =
            pdf::pdf_search_text(&self.0, &args.file_id, &args.pattern, args.pages.as_deref())
                .await
                .map_err(oerr)?;
        Ok(hits.to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReplaceArgs {
    pub file_id: String,
    pub pattern: String,
    pub replacement: String,
    pub pages: Option<String>,
}

pub struct PdfReplaceTextTool(pub String);

impl PortableTool for PdfReplaceTextTool {
    const NAME: &'static str = "pdf_replace_text";
    type Args = PdfReplaceArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Replace text in a stored PDF in place (same file id, content updated). Best for small corrections; heavy rewrites should regenerate the source document.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "pattern": { "type": "string" },
                "replacement": { "type": "string" },
                "pages": { "type": "string" }
            },
            "required": ["fileId", "pattern", "replacement"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        pdf::pdf_replace_text(
            &self.0,
            &args.file_id,
            &args.pattern,
            &args.replacement,
            args.pages.as_deref(),
        )
        .await
        .map_err(oerr)?;
        Ok(json!({ "success": true }).to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMergeArgs {
    pub file_ids: Vec<String>,
    pub output_name: String,
}

pub struct PdfMergeTool(pub String);

impl PortableTool for PdfMergeTool {
    const NAME: &'static str = "pdf_merge";
    type Args = PdfMergeArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Merge two or more stored PDFs (in the given order) into a NEW stored PDF file.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileIds": { "type": "array", "items": { "type": "string" }, "description": "PDF file ids in merge order (min 2)" },
                "outputName": { "type": "string", "description": "Name for the merged file, e.g. combined.pdf" }
            },
            "required": ["fileIds", "outputName"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let file = pdf::pdf_merge(&self.0, &args.file_ids, &args.output_name)
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "file": file }).to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSplitArgs {
    pub file_id: String,
    pub ranges: Option<String>,
}

pub struct PdfSplitTool(pub String);

impl PortableTool for PdfSplitTool {
    const NAME: &'static str = "pdf_split";
    type Args = PdfSplitArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Split a stored PDF into multiple NEW stored PDFs (by ranges, e.g. \"1-2,3-5\"; default: one part per page). Returns the new files.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "ranges": { "type": "string", "description": "e.g. \"1-2,3,4-5\"" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let files = pdf::pdf_split(&self.0, &args.file_id, args.ranges.as_deref())
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "files": files }).to_string())
    }
}

pub struct PdfInfoTool(pub String);

impl PortableTool for PdfInfoTool {
    const NAME: &'static str = "pdf_info";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Inspect a stored PDF: page count plus per-page size/rotation/mediaBox. Use before page-range operations.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let info = pdf::pdf_info(&self.0, &args.file_id).await.map_err(oerr)?;
        Ok(info.to_string())
    }
}
