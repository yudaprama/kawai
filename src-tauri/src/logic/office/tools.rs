use kawai_tools::AgentTool;
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

impl AgentTool for ListFilesTool {
    const NAME: &'static str = "office_list_files";
    type Args = ListFilesArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "List the user's stored office documents (docx, xlsx, pptx, pdf, html decks, images, charts). Returns id, originalName, ext, bytes, createdAt. Every other tool addresses files by that id.".into()
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

impl AgentTool for KnowledgeSearchTool {
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
        let hits =
            crate::logic::rag::knowledge_search(self.0.clone(), self.1, args.query, args.mode)
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

impl AgentTool for ReadDocumentTool {
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

impl AgentTool for DocumentInfoTool {
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

impl AgentTool for EditDocumentTool {
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

impl AgentTool for CreateDocumentTool {
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

// -- office_create_deck -------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDeckArgs {
    pub filename: String,
    #[serde(default)]
    pub title: Option<String>,
    pub slides: Vec<super::deck::DeckSlide>,
}

pub struct CreateDeckTool(pub String);

impl AgentTool for CreateDeckTool {
    const NAME: &'static str = "office_create_deck";
    type Args = CreateDeckArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Create a presentation deck as ONE self-contained reveal.js HTML file the user can present directly in the app. THIS IS THE DEFAULT for slides/decks/presentations. \
slides = one entry per slide, IN ORDER: {\"title\":\"Slide title\",\"bodyHtml\":\"<h3>subhead</h3><p>one short idea</p><ul><li>point</li></ul><table><tr><td>a</td><td>b</td></tr></table>\"}. \
bodyHtml is simple semantic HTML only — h3 subheads, short p paragraphs (≤15 words), ul bullet lists (≤5 items), tables for data, and <img data-file=\"<file id>\"> to embed a stored image or chart (analytics svg charts work). Keep every slide to ONE idea; never dump raw <section> tags. \
Inline style attributes (color, background, text-align, font-size) are allowed; scripts and external URLs are stripped automatically. \
For a PowerPoint .pptx file: create the deck first, then call office_export_deck. office_create_document(.pptx) is only for transcribing literal text the user gave you. \
Example args: {\"filename\":\"q3-review.html\",\"title\":\"Q3 Review\",\"slides\":[{\"title\":\"Revenue\",\"bodyHtml\":\"<ul><li>Up 12% QoQ</li><li>APAC leads</li></ul>\"}]}"
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "filename": { "type": "string", "description": "Output filename, e.g. q3-review.html (extension optional)" },
                "title": { "type": "string", "description": "Deck title shown on the first slide context / browser tab" },
                "slides": {
                    "type": "array",
                    "description": "Slides in order; each {title, bodyHtml} (see tool description)",
                    "items": { "type": "object" }
                }
            },
            "required": ["filename", "slides"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        if args.slides.is_empty() {
            return Err(oerr("slides must not be empty — one entry per slide"));
        }
        let name = normalize_html_filename(&args.filename);
        let title = args
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| name.trim_end_matches(".html").to_string());

        let mut slides = args.slides;
        // Resolve <img data-file="…"> handles to inline data URLs from the
        // store (charts, images) BEFORE sanitizing — the sanitizer then sees
        // only trusted data: URLs.
        let mut resolved = std::collections::HashMap::new();
        for handle in super::deck::collect_file_refs(&slides) {
            let id = match store::resolve(&self.0, &handle) {
                Ok((_, info)) => Ok(info.id),
                Err(exact) => match resolve_file_id_fuzzy(&self.0, &handle) {
                    Some(fixed) => store::resolve(&self.0, &fixed).map(|(_, i)| i.id),
                    None => Err(exact),
                },
            };
            let Ok(id) = id else {
                continue; // substitute_file_refs leaves a visible placeholder
            };
            if let Ok((info, bytes)) = store::read_file(&self.0, &id) {
                if let Some(mime) = super::deck::image_mime_for_ext(&info.ext) {
                    resolved.insert(handle.clone(), (mime.to_string(), bytes));
                }
            }
        }
        super::deck::substitute_file_refs(&mut slides, &resolved);
        for slide in &mut slides {
            slide.body_html = super::deck::sanitize_html_fragment(&slide.body_html);
        }

        let html = super::deck::render_deck(&title, &slides);
        let file = store::import_bytes(&self.0, &name, html.as_bytes()).map_err(oerr)?;
        Ok(json!({ "success": true, "file": file, "slides": slides.len() })
            .to_string())
    }
}

/// Force the `.html` extension (`.htm` canonicalized by the store).
fn normalize_html_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.to_ascii_lowercase().ends_with(".html")
        || trimmed.to_ascii_lowercase().ends_with(".htm")
    {
        trimmed.to_string()
    } else {
        format!("{}.html", trimmed.trim_end_matches('.'))
    }
}

// -- office_export_deck -------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDeckArgs {
    pub file_id: String,
    #[serde(default)]
    pub filename: Option<String>,
}

pub struct ExportDeckTool(pub String);

impl AgentTool for ExportDeckTool {
    const NAME: &'static str = "office_export_deck";
    type Args = ExportDeckArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Convert a stored deck (.html created by office_create_deck) into a real PowerPoint .pptx file. Deterministic conversion, no rewriting: slide titles → pptx slide titles, bullet lists / paragraphs / tables kept in order, png/jpg/gif images embedded; custom layout, colors and svg charts do NOT carry over (the deck itself stays unchanged). Use when the user needs a .pptx / PowerPoint file of a deck."
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "Stored deck file id (from office_create_deck's result or office_list_files)" },
                "filename": { "type": "string", "description": "Optional output filename; defaults to the deck's name with .pptx" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let (path, info) = match store::resolve(&self.0, &args.file_id) {
            Ok(v) => v,
            Err(exact) => match resolve_file_id_fuzzy(&self.0, &args.file_id) {
                Some(fixed) => store::resolve(&self.0, &fixed)
                    .map_err(|e| oerr(format!("{e} (fuzzy matched from {:?})", args.file_id)))?,
                None => return Err(oerr(exact)),
            },
        };
        if info.ext != "html" {
            return Err(oerr(
                "office_export_deck converts .html decks (from office_create_deck)",
            ));
        }
        let html = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| oerr(format!("read deck: {e}")))?;
        let deck = super::deck::parse_deck(&html);
        if deck.slides.is_empty() {
            return Err(oerr("the deck has no slides to export"));
        }
        let (bytes, stats) = super::deck::export_pptx(&deck).map_err(oerr)?;
        let name = match args.filename {
            Some(n) if n.to_ascii_lowercase().ends_with(".pptx") => n,
            Some(n) => format!("{}.pptx", n.trim_end_matches('.')),
            None => format!(
                "{}.pptx",
                info.original_name
                    .trim_end_matches(".html")
                    .trim_end_matches(".htm")
            ),
        };
        let file = store::import_bytes(&self.0, &name, &bytes).map_err(oerr)?;
        Ok(json!({
            "success": true,
            "file": file,
            "slides": stats.slides,
            "imagesKept": stats.images_kept,
            "imagesDropped": stats.images_dropped,
            "note": "pptx keeps text, bullets and tables in order; custom layout, colors and svg charts do not carry over — the html deck remains the source of truth"
        })
        .to_string())
    }
}

// -- office_restore_backup -----------------------------------------------------

pub struct RestoreBackupTool(pub String);

impl AgentTool for RestoreBackupTool {
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

impl AgentTool for PdfExtractTextTool {
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

impl AgentTool for PdfSearchTextTool {
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

impl AgentTool for PdfReplaceTextTool {
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

impl AgentTool for PdfMergeTool {
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

impl AgentTool for PdfSplitTool {
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

impl AgentTool for PdfInfoTool {
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
        assert!(
            lcs_ratio(mangled1, real) >= 0.6,
            "{}",
            lcs_ratio(mangled1, real)
        );
        assert!(
            lcs_ratio(mangled2, real) >= 0.6,
            "{}",
            lcs_ratio(mangled2, real)
        );
    }

    #[test]
    fn lcs_ratio_scores_unrelated_ids_low() {
        assert!(lcs_ratio("f3787545960300-000", "f11111111111111111-2222") < 0.5);
    }

    #[test]
    fn lcs_ratio_exact_is_one() {
        assert!(
            (lcs_ratio("f87328470555963000-0000", "f87328470555963000-0000") - 1.0).abs() < 1e-9
        );
    }
}
