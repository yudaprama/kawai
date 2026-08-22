use rig::tool::PortableTool;
use serde::Deserialize;
use serde_json::{json, Value};

use super::error::{oerr, OfficeToolError};
use super::ooxml;
use super::pdf;
use super::store;
use super::{schema, truncate_chars};

/// Resolve a file id the model half-copied. Small models routinely corrupt
/// long hex ids (drop/scramble digits) when echoing them into a call; exact
/// resolve fails and the turn dies. Candidates are scored by normalized LCS
/// ratio; the best wins when it clears a floor AND beats the runner-up by a
/// margin (no guessing across near-ties).
fn resolve_file_id_fuzzy(user_id: &str, arg: &str) -> Option<String> {
    let files = super::list_files(user_id).ok()?;
    let normalize = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect()
    };
    let n_arg = normalize(arg);
    if n_arg.len() < 6 {
        return None;
    }
    let mut scored: Vec<(f64, String)> = files
        .into_iter()
        .map(|f| (lcs_ratio(&n_arg, &normalize(&f.id)), f.id))
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let (best, second) = (scored.first()?, scored.get(1).map(|s| s.0).unwrap_or(0.0));
    if best.0 >= 0.6 && best.0 - second >= 0.1 {
        Some(best.1.clone())
    } else {
        None
    }
}

/// Longest-common-subsequence ratio between two normalized id strings.
fn lcs_ratio(a: &str, b: &str) -> f64 {
    let x: Vec<char> = a.chars().collect();
    let y: Vec<char> = b.chars().collect();
    let mut prev = vec![0usize; y.len() + 1];
    let mut cur = vec![0usize; y.len() + 1];
    for &cx in &x {
        cur.iter_mut().for_each(|v| *v = 0);
        for (j, &cy) in y.iter().enumerate() {
            cur[j + 1] = if cx == cy {
                prev[j] + 1
            } else {
                cur[j].max(prev[j + 1])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let lcs = prev[y.len()];
    lcs as f64 / x.len().max(y.len()) as f64
}

/// Exact read; on failure retry once with a fuzzy-resolved id.
async fn read_document_forgiving(user_id: &str, file_id: &str) -> Result<String, String> {
    match ooxml::read_document(user_id, file_id).await {
        Ok(md) => Ok(md),
        Err(exact_err) => match resolve_file_id_fuzzy(user_id, file_id) {
            Some(fixed) => {
                eprintln!("[office] fileId {file_id:?} unresolved — fuzzy matched, retrying");
                ooxml::read_document(user_id, &fixed).await
            }
            None => Err(exact_err),
        },
    }
}

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
    pub mode: Option<crate::logic::rag::SearchMode>,
}

/// Hybrid (vector + BM25) search over the documents this session uploaded.
/// `user_id` + `session_id` are bound at construction (server-side state) —
/// the model only supplies the query (and an optional retrieval mode).
pub struct KnowledgeSearchTool(pub String, pub i64);

impl PortableTool for KnowledgeSearchTool {
    const NAME: &'static str = "knowledge_search";
    type Args = KnowledgeSearchArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Search the knowledge imported in this conversation (uploaded documents AND imported YouTube transcripts) for relevant passages. Use this FIRST when the user asks about content that may be in their files or videos — summaries, numbers, names, dates, invoice codes, tables. Returns the best matching excerpts with their source.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "What to look for — keywords, codes, or a question." },
                "mode": {
                    "type": "string",
                    "enum": ["hybrid", "semantic", "keyword"],
                    "description": "Retrieval strategy. keyword: exact identifiers, codes, numbers, names (fastest). semantic: conceptual or rephrased questions where wording may differ. hybrid: combine both (default — use when unsure)."
                }
            },
            "required": ["query"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let hits = crate::logic::rag::knowledge_search(
            self.0.clone(),
            self.1,
            args.query,
            args.mode,
        )
        .await
        .map_err(oerr)?;
        if hits.is_empty() {
            return Ok(
                json!({ "hits": [], "note": "No documents match. Either nothing was uploaded in this conversation, or none of them contains the answer. Retry with ONE distinctive keyword (an exact code, name, or date word) — long phrases often miss." })
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
        "Read a stored .docx/.xlsx/.pptx (or .md transcript/notes) and return its full content as markdown (headings, tables, lists). For PDFs use pdf_extract_text.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files or a search hit" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let md = read_document_forgiving(&self.0, &args.file_id)
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
        let info = match ooxml::document_info(&self.0, &args.file_id).await {
            Ok(i) => i,
            Err(exact_err) => match resolve_file_id_fuzzy(&self.0, &args.file_id) {
                Some(fixed) => ooxml::document_info(&self.0, &fixed).await.map_err(oerr)?,
                None => return Err(oerr(exact_err)),
            },
        };
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
    pub blocks: Vec<super::ooxml::DocBlock>,
}

pub struct CreateDocumentTool(pub String);

impl PortableTool for CreateDocumentTool {
    const NAME: &'static str = "office_create_document";
    type Args = CreateDocumentArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Create a NEW office document from EXACT content the user already provided (you transcribe their literal text — do NOT compose content yourself; when content must be written/drafted, call draft_document instead). \
blocks is a list, in document order: \
{\"type\":\"title\",\"text\":\"...\"} — big centered title; \
{\"type\":\"heading\",\"text\":\"...\",\"level\":1|2|3} — section heading; \
{\"type\":\"paragraph\",\"text\":\"...\",\"bold\":true|false}; \
{\"type\":\"bullets\",\"items\":[\"...\",\"...\"]}; \
{\"type\":\"table\",\"rows\":[[\"a\",\"b\"],[\"c\",\"d\"]]}. \
The filename extension picks the format (.docx renders blocks in order; .xlsx writes blocks as spreadsheet rows starting at A1, tables as cells; .pptx makes each title a new slide with the following blocks as its body text). \
Example args: {\"filename\":\"report.docx\",\"blocks\":[{\"type\":\"title\",\"text\":\"Report\"},{\"type\":\"paragraph\",\"text\":\"Hello world\"}]}"
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "filename": { "type": "string", "description": "Output filename, e.g. report.docx / sheet.xlsx / deck.pptx" },
                "blocks": { "type": "array", "description": "Document content in order: title/heading/paragraph/bullets/table objects (see tool description).", "items": { "type": "object" } }
            },
            "required": ["filename", "blocks"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let file = ooxml::create_document_from_blocks(&self.0, &args.filename, &args.blocks)
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "file": file }).to_string())
    }
}

// -- office_restore_backup -----------------------------------------------------

pub struct RestoreBackupTool(pub String);

impl PortableTool for RestoreBackupTool {
    const NAME: &'static str = "office_restore_backup";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Undo the LAST edit of a stored document by restoring its pre-edit snapshot (swap semantics — call it twice to get the edited version back). Use when the user says an edit went wrong / undo / batalkan edit. Fails when the document was never edited.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files or a search hit" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let file = match store::restore_backup(&self.0, &args.file_id) {
            Ok(f) => f,
            Err(exact_err) => match resolve_file_id_fuzzy(&self.0, &args.file_id) {
                Some(fixed) => store::restore_backup(&self.0, &fixed)
                    .map_err(|e| oerr(format!("{e} (fuzzy matched from {:?})", args.file_id)))?,
                None => return Err(oerr(exact_err)),
            },
        };
        Ok(json!({ "success": true, "restored": true, "note": "pre-edit snapshot restored; calling again swaps back", "file": file }).to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lcs_ratio_scores_corrupted_ids_high() {
        // Exact shape observed in the wild: model dropped + scrambled digits.
        let real = "f87328470555963000-0000";
        let mangled1 = "f83247805963000-000";
        let mangled2 = "f3787545960300-000";
        assert!(lcs_ratio(mangled1, real) >= 0.6, "{}", lcs_ratio(mangled1, real));
        assert!(lcs_ratio(mangled2, real) >= 0.6, "{}", lcs_ratio(mangled2, real));
    }

    #[test]
    fn lcs_ratio_scores_unrelated_ids_low() {
        assert!(lcs_ratio("f3787545960300-000", "f11111111111111111-2222") < 0.5);
    }

    #[test]
    fn lcs_ratio_exact_is_one() {
        assert!((lcs_ratio("f87328470555963000-0000", "f87328470555963000-0000") - 1.0).abs() < 1e-9);
    }
}
