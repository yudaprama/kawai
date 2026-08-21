//! Idle-time RAG indexing for office knowledge files.
//!
//! When the user attaches an office document (composer @-mention) there is a
//! natural idle gap before they finish typing the prompt. We use that gap to
//! extract → chunk → embed → store the document into the user's libSQL vector
//! store, so that `knowledge_search` at submit time is instant (no subprocess
//! spawn, no on-the-fly embedding).
//!
//! Pipeline: office extractors (office_oxide for OOXML, pdf_oxide in-process for
//! PDF) → in-tree chunker →
//! `kawai-embedding` (local fastembed ONNX fallback, no API key) →
//! `rig-libsql` vector store. All deps are gated behind the `office` feature
//! and share the single rig-core rev used by the rest of the graph.
//!
//! Scoping: user isolation is structural — one database file per user
//! (`db_connection(user_id)`), so no `user_id` column anywhere. Chunks belong
//! to FILES; the `session_files` table associates files with the sessions that
//! referenced them, so a search covers everything the session has touched, not
//! just the current message's mentions.
//!
//! Retrieval is hybrid by default: an FTS5 mirror of `rag_chunks` provides BM25
//! keyword ranking (exact ids, numbers, codes) alongside vector similarity
//! (paraphrase, synonyms), fused per-query with Reciprocal Rank Fusion.
//! [`knowledge_search`] also accepts an optional [`SearchMode`] — `semantic`
//! (vector only) or `keyword` (BM25 only, skips the embedder) — so the agent
//! can steer retrieval when it knows the query shape.

use std::collections::HashMap;

use rig_core::Embed;
use rig_core::embeddings::EmbeddingsBuilder;
use rig_core::vector_store::request::{SearchFilter, VectorSearchRequest};
use rig_core::vector_store::{InsertDocuments, VectorStoreIndex};
use rig_libsql::{Column, ColumnValue, LibsqlSearchFilter, LibsqlVectorStore, LibsqlVectorStoreTable};
use serde::{Deserialize, Serialize};
use serde_json::json;
use text_splitter::{ChunkConfig, MarkdownSplitter, TextSplitter};

use kawai_embedding::TenantAwareEmbedder;

const CHUNK_CHARS: usize = 1500;
const CHUNK_OVERLAP: usize = 200;
/// Reciprocal Rank Fusion smoothing constant (the standard k = 60).
const RRF_K: f64 = 60.0;

/// A single embedded chunk of an indexed office document.
#[derive(Clone, Debug, Deserialize, Serialize, Embed)]
pub struct RagChunk {
    pub id: String,
    #[embed]
    pub content: String,
    pub file_id: String,
    pub source: String,
    pub locator: String,
}

impl LibsqlVectorStoreTable for RagChunk {
    fn name() -> &'static str {
        "rag_chunks"
    }

    fn schema() -> Vec<Column> {
        vec![
            Column::new("id", "TEXT PRIMARY KEY"),
            Column::new("content", "TEXT"),
            Column::new("file_id", "TEXT"),
            Column::new("source", "TEXT"),
            Column::new("locator", "TEXT"),
        ]
    }

    fn id(&self) -> String {
        self.id.clone()
    }

    fn column_values(&self) -> Vec<(&'static str, Box<dyn ColumnValue>)> {
        vec![
            ("id", Box::new(self.id.clone())),
            ("content", Box::new(self.content.clone())),
            ("file_id", Box::new(self.file_id.clone())),
            ("source", Box::new(self.source.clone())),
            ("locator", Box::new(self.locator.clone())),
        ]
    }
}

// ── session ↔ file association ──────────────────────────────────────────────

/// Record which files a session referenced (idempotent).
async fn associate_session_files(
    conn: &libsql::Connection,
    session_id: i64,
    file_ids: &[String],
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    for fid in file_ids {
        conn.execute(
            "INSERT OR IGNORE INTO session_files (session_id, file_id, added_at) VALUES (?, ?, ?)",
            (session_id, fid.clone(), now),
        )
        .await
        .map_err(|e| format!("associate: {e}"))?;
    }
    Ok(())
}

/// All file ids the session has ever referenced (ordered by `added_at`).
pub async fn session_file_ids(
    conn: &libsql::Connection,
    session_id: i64,
) -> Result<Vec<String>, String> {
    let mut rows = conn
        .query(
            "SELECT file_id FROM session_files WHERE session_id = ?",
            vec![session_id],
        )
        .await
        .map_err(|e| format!("session files: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("session files: {e}"))? {
        out.push(row.get(0).map_err(|e| format!("session files: {e}"))?);
    }
    Ok(out)
}

/// List the full metadata of every file associated with a session. Used by the
/// files panel to show "In this session" vs "All documents".
pub async fn list_session_files(
    user_id: &str,
    session_id: i64,
) -> Result<Vec<crate::logic::office::OfficeFile>, String> {
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    let ids = session_file_ids(&conn, session_id).await?;
    let mut out = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Ok((_path, info)) = crate::logic::office::store::resolve(user_id, id) {
            out.push(info);
        }
    }
    Ok(out)
}

// ── index status tracking ────────────────────────────────────────────────────

/// An `indexing` row older than this is a crashed/interrupted run (the app
/// died mid-index) — surfaced as `failed` instead of spinning forever.
const STALE_INDEXING_SECS: i64 = 15 * 60;

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Upsert one file's index status row.
async fn set_index_status(
    conn: &libsql::Connection,
    file_id: &str,
    status: &str,
    chunks: i64,
    error: Option<&str>,
) -> Result<(), String> {
    let error_val = match error {
        Some(e) => libsql::Value::Text(e.to_string()),
        None => libsql::Value::Null,
    };
    conn.execute(
        "INSERT INTO rag_files (file_id, status, chunks, error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET
            status = excluded.status,
            chunks = excluded.chunks,
            error = excluded.error,
            updated_at = excluded.updated_at",
        (file_id, status, chunks, error_val, unix_secs()),
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("rag_files upsert: {e}"))
}

/// Current stored status of one file's index (`None` when never indexed).
async fn rag_file_status(conn: &libsql::Connection, file_id: &str) -> Result<Option<String>, String> {
    let mut rows = conn
        .query(
            "SELECT status FROM rag_files WHERE file_id = ?",
            vec![file_id.to_string()],
        )
        .await
        .map_err(|e| format!("rag_files: {e}"))?;
    match rows.next().await.map_err(|e| format!("rag_files: {e}"))? {
        Some(row) => Ok(Some(row.get(0).map_err(|e| format!("rag_files: {e}"))?)),
        None => Ok(None),
    }
}

/// Lifecycle of one file's RAG index, as shown by the knowledge panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    /// Never indexed (imported before RAG existed, or indexing never ran).
    NotIndexed,
    /// Extraction/chunking/embedding in progress.
    Indexing,
    /// Indexed (possibly with zero chunks — empty/unextractable documents).
    Ready,
    /// The last indexing attempt failed (`error` carries the cause).
    Failed,
}

/// One knowledge-panel row: office store metadata + index state + whether the
/// active session can search this file.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFileInfo {
    pub id: String,
    pub original_name: String,
    pub ext: String,
    pub bytes: u64,
    pub created_at: i64,
    pub status: IndexStatus,
    pub chunks: i64,
    pub error: Option<String>,
    pub in_session: bool,
}

/// The knowledge panel's single list call: every stored office file joined
/// with its index status and its association to the given session. Files with
/// no `rag_files` row read as `not_indexed` (imported before RAG existed).
pub async fn knowledge_list(
    user_id: &str,
    session_id: Option<i64>,
) -> Result<Vec<KnowledgeFileInfo>, String> {
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    let mut in_session = std::collections::HashSet::new();
    if let Some(sid) = session_id {
        in_session = session_file_ids(&conn, sid).await?.into_iter().collect();
    }

    let mut status_rows = conn
        .query(
            "SELECT file_id, status, chunks, error, updated_at FROM rag_files",
            (),
        )
        .await
        .map_err(|e| format!("rag_files: {e}"))?;
    // (status, chunks, error) per file; stale `indexing` rows become
    // failed/interrupted so a crashed run never spins in the UI.
    let mut statuses: HashMap<String, (String, i64, Option<String>)> = HashMap::new();
    let now = unix_secs();
    while let Some(row) = status_rows
        .next()
        .await
        .map_err(|e| format!("rag_files: {e}"))?
    {
        let fid: String = row.get(0).map_err(|e| format!("rag_files: {e}"))?;
        let status: String = row.get(1).map_err(|e| format!("rag_files: {e}"))?;
        let chunks: i64 = row.get(2).map_err(|e| format!("rag_files: {e}"))?;
        let error: Option<String> = row.get(3).map_err(|e| format!("rag_files: {e}"))?;
        let updated_at: i64 = row.get(4).map_err(|e| format!("rag_files: {e}"))?;
        let entry = if status == "indexing" && now.saturating_sub(updated_at) > STALE_INDEXING_SECS
        {
            ("failed".to_string(), chunks, Some("indexing interrupted".to_string()))
        } else {
            (status, chunks, error)
        };
        statuses.insert(fid, entry);
    }

    let files = crate::logic::office::list_files(user_id)?;
    Ok(files
        .into_iter()
        .map(|f| {
            let is_in_session = in_session.contains(&f.id);
            let (status, chunks, error) = match statuses.get(&f.id) {
                Some((s, c, e)) => match s.as_str() {
                    "indexing" => (IndexStatus::Indexing, *c, None),
                    "ready" => (IndexStatus::Ready, *c, None),
                    "failed" => (IndexStatus::Failed, *c, e.clone()),
                    _ => (IndexStatus::NotIndexed, 0, None),
                },
                None => (IndexStatus::NotIndexed, 0, None),
            };
            KnowledgeFileInfo {
                id: f.id,
                original_name: f.original_name,
                ext: f.ext,
                bytes: f.bytes,
                created_at: f.created_at,
                status,
                chunks,
                error,
                in_session: is_in_session,
            }
        })
        .collect())
}

/// A single heading found by scanning markdown text, with its char offset.
struct Heading {
    char_offset: usize,
    text: String,
}

/// Scan markdown text for `#`-prefixed headings, returning their char offsets
/// and trimmed titles. Used to attach the nearest preceding heading as each
/// chunk's locator (e.g. "Invoice Summary" instead of "chunk-3").
fn scan_headings(text: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let line_chars = line.chars().count();
        let bare = line.trim_end_matches(['\n', '\r']);
        let trimmed = bare.trim_start();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let level = 1 + rest.chars().take_while(|c| *c == '#').count();
            if level <= 6 {
                let title = trimmed.trim_start_matches('#').trim();
                if !title.is_empty() {
                    out.push(Heading {
                        char_offset: offset,
                        text: title.to_string(),
                    });
                }
            }
        }
        offset += line_chars;
    }
    out
}

/// Find the nearest preceding heading for a given char offset. Returns the
/// heading title, or a fallback `"section {idx}"` if none found.
fn locator_for(headings: &[Heading], char_offset: usize, fallback_idx: usize) -> String {
    let idx = headings.partition_point(|h| h.char_offset <= char_offset);
    headings
        .get(idx.wrapping_sub(1))
        .map(|h| h.text.clone())
        .unwrap_or_else(|| format!("section {fallback_idx}"))
}

/// Chunk markdown text using `MarkdownSplitter` (respects heading boundaries)
/// and attach the nearest preceding heading as each chunk's locator.
fn chunk_markdown(text: &str, max_chars: usize, overlap: usize) -> Vec<(String, String)> {
    let config = ChunkConfig::new(max_chars)
        .with_overlap(overlap)
        .expect("overlap is clamped below capacity");
    let splitter = MarkdownSplitter::new(config);
    let headings = scan_headings(text);
    splitter
        .chunk_char_indices(text)
        .enumerate()
        .map(|(i, idx)| {
            (
                locator_for(&headings, idx.char_offset, i),
                idx.chunk.to_string(),
            )
        })
        .collect()
}

/// Chunk plain text (PDF pages, .txt, etc.) using `TextSplitter`.
#[allow(dead_code)]
fn chunk_plain(text: &str, max_chars: usize, overlap: usize) -> Vec<(String, String)> {
    let config = ChunkConfig::new(max_chars)
        .with_overlap(overlap)
        .expect("overlap is clamped below capacity");
    let splitter = TextSplitter::new(config);
    splitter
        .chunk_char_indices(text)
        .enumerate()
        .map(|(i, idx)| (format!("section {i}"), idx.chunk.to_string()))
        .collect()
}

/// Extract full text from a stored office file, dispatching by extension to
/// the same engines `knowledge_context` uses. Returns `Ok(None)` for file kinds we
/// cannot index (e.g. unknown types). Images are described to text via the
/// ragloader chain; markdown (YouTube transcripts) is read as-is.
async fn extract_text(user_id: &str, file_id: &str, ext: &str) -> Result<Option<String>, String> {
    match ext {
        "pdf" => crate::logic::office::pdf::pdf_extract_text(user_id, file_id, None)
            .await
            .map(Some)
            .map_err(|e| format!("pdf: {e}")),
        "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" => {
            crate::logic::office::read_document(user_id, file_id)
                .await
                .map(Some)
                .map_err(|e| format!("ooxml: {e}"))
        }
        "png" | "jpg" | "jpeg" | "gif" | "webp" => {
            describe_image(user_id, file_id).await.map(Some)
        }
        "md" => {
            let (path, _info) = crate::logic::office::store::resolve(user_id, file_id)
                .map_err(|e| format!("resolve: {e}"))?;
            tokio::fs::read_to_string(&path)
                .await
                .map(Some)
                .map_err(|e| format!("read: {e}"))
        }
        _ => Ok(None),
    }
}

/// Describe a stored image into indexing-ready text via ragloader's
/// `DescriberChain` (local model stub first, JigsawStack VOCR when the image
/// is URL-reachable). Until LiteRT-LM gains multimodal input, purely local
/// images fail with "no describer supports this source" — surfaced as the
/// file's `failed` index status, retryable once a describer lands.
async fn describe_image(user_id: &str, file_id: &str) -> Result<String, String> {
    let (path, info) = crate::logic::office::store::resolve(user_id, file_id)
        .map_err(|e| format!("resolve: {e}"))?;
    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let chain = ragloader::image::default_chain();
    let source = ragloader::image::ImageSource::local(&info.original_name);
    let desc = chain
        .describe(&source, &data)
        .await
        .map_err(|e| format!("image describe: {e}"))?;
    let mut text = format!("# {}\n\n{}", info.original_name, desc.content);
    if !desc.tags.is_empty() {
        text.push_str(&format!("\n\nTags: {}", desc.tags.join(", ")));
    }
    Ok(text)
}

// ── lexical (FTS5 / BM25) mirror ─────────────────────────────────────────────

/// Create the FTS5 mirror of `rag_chunks` plus the triggers that keep it in
/// sync, then backfill rows written before the mirror existed. Every write
/// path (rig-libsql inserts, `purge_file_chunks`, the orphan pass in
/// `forget_file`) issues plain INSERT/DELETE on `rag_chunks`, so the triggers
/// cover them without touching any caller. rig-libsql uses `INSERT OR REPLACE`:
/// on a replace SQLite assigns a NEW rowid and (recursive triggers off) fires
/// only the insert trigger, leaving the old FTS row as a ghost — harmless,
/// because `bm25_search` joins on `rag_chunks.rowid`, which the ghost no longer
/// matches. Must be called only after `rag_chunks` itself exists.
async fn ensure_fts(conn: &libsql::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(content, tokenize='unicode61');
         CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_ai AFTER INSERT ON rag_chunks BEGIN
             INSERT INTO rag_chunks_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
         END;
         CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_ad AFTER DELETE ON rag_chunks BEGIN
             DELETE FROM rag_chunks_fts WHERE rowid = OLD.rowid;
         END;
         CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_au AFTER UPDATE ON rag_chunks BEGIN
             DELETE FROM rag_chunks_fts WHERE rowid = OLD.rowid;
             INSERT INTO rag_chunks_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
         END;
         INSERT INTO rag_chunks_fts(rowid, content)
             SELECT rowid, content FROM rag_chunks
             WHERE rowid NOT IN (SELECT rowid FROM rag_chunks_fts);",
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("fts schema: {e}"))
}

/// Quote each whitespace token so arbitrary user text (hyphens, digits, FTS5
/// operators) can never produce a MATCH syntax error; tokens become AND-ed
/// phrases (a hyphenated code like `INV-2026-041` matches its exact token
/// sequence). `None` when nothing searchable remains.
fn fts_match_query(query: &str) -> Option<String> {
    let phrases: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', " "))
        .filter(|t| !t.trim().is_empty())
        .map(|t| format!("\"{}\"", t.trim()))
        .take(16)
        .collect();
    if phrases.is_empty() {
        None
    } else {
        Some(phrases.join(" "))
    }
}

/// Lexical top-k: BM25 over the FTS5 mirror, restricted to the same candidate
/// files the vector side searches (FTS5 cannot filter `file_id` itself, hence
/// the rowid JOIN back to `rag_chunks`). SQLite's `bm25()` is lower-is-better,
/// so the ASC order yields best matches first.
async fn bm25_search(
    conn: &libsql::Connection,
    file_ids: &[String],
    match_query: &str,
    limit: usize,
) -> Result<Vec<RagChunk>, String> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let file_ph = (2..=file_ids.len() + 1)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT c.id, c.content, c.file_id, c.source, c.locator \
         FROM rag_chunks_fts JOIN rag_chunks c ON c.rowid = rag_chunks_fts.rowid \
         WHERE rag_chunks_fts MATCH ?1 AND c.file_id IN ({file_ph}) \
         ORDER BY bm25(rag_chunks_fts) LIMIT ?{}",
        file_ids.len() + 2
    );
    let mut params: Vec<libsql::Value> = Vec::with_capacity(file_ids.len() + 2);
    params.push(libsql::Value::Text(match_query.to_string()));
    params.extend(file_ids.iter().map(|f| libsql::Value::Text(f.clone())));
    params.push(libsql::Value::Integer(limit as i64));

    let mut rows = conn
        .query(&sql, params)
        .await
        .map_err(|e| format!("bm25: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("bm25: {e}"))? {
        let id: String = row.get(0).map_err(|e| format!("bm25: {e}"))?;
        let content: String = row.get(1).map_err(|e| format!("bm25: {e}"))?;
        let file_id: String = row.get(2).map_err(|e| format!("bm25: {e}"))?;
        let source: String = row.get(3).map_err(|e| format!("bm25: {e}"))?;
        let locator: String = row.get(4).map_err(|e| format!("bm25: {e}"))?;
        out.push(RagChunk {
            id,
            content,
            file_id,
            source,
            locator,
        });
    }
    Ok(out)
}

/// Reciprocal Rank Fusion of the vector and lexical rankings (1-based ranks):
/// score(d) = Σ 1/(RRF_K + rank_d). Chunks found by both sides outrank
/// single-side hits; ties break by chunk id for determinism.
fn rrf_fuse(vector: Vec<RagChunk>, lexical: Vec<RagChunk>, limit: usize) -> Vec<RagChunk> {
    let mut fused: HashMap<String, (f64, RagChunk)> = HashMap::new();
    for ranking in [vector, lexical] {
        for (rank, doc) in ranking.into_iter().enumerate() {
            let entry = fused.entry(doc.id.clone()).or_insert_with(|| (0.0, doc));
            entry.0 += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    let mut ranked: Vec<(f64, RagChunk)> = fused.into_values().collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    ranked.truncate(limit);
    ranked.into_iter().map(|(_, doc)| doc).collect()
}

/// A retrieved chunk with its provenance, for citation in the UI/LLM context.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHit {
    pub source: String,
    pub locator: String,
    pub content: String,
}

/// Retrieval strategy for [`knowledge_search`]. Deserialized from the
/// model/RPC-supplied string; unknown values are rejected by serde (whitelist).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// Vector similarity fused with BM25 via RRF (the default).
    #[default]
    Hybrid,
    /// Vector similarity only — natural-language questions about concepts.
    Semantic,
    /// BM25 only — exact codes, names, numbers; skips the embedder entirely.
    Keyword,
}

/// Index one stored office file for vector search, then associate it with the
/// uploading session (`session_files`). Called fire-and-forget right after
/// import from the knowledge panel. Returns the number of chunks indexed, or
/// `Ok(0)` for empty/unsupported files. Errors surface the underlying cause
/// (missing engine, embedding failure, …) without aborting the session — the
/// agent can still fall back to the office read tools. Progress is recorded
/// in `rag_files` (`indexing` → `ready`/`failed`) so the panel can show it;
/// a crash mid-run leaves a stale `indexing` row that `knowledge_list`
/// reports as failed/interrupted.
pub async fn office_index_file(
    user_id: String,
    session_id: Option<i64>,
    file_id: String,
) -> Result<usize, String> {
    let (_file_path, info) =
        crate::logic::office::store::resolve(&user_id, &file_id).map_err(|e| format!("resolve: {e}"))?;

    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    set_index_status(&conn, &file_id, "indexing", 0, None).await?;
    match index_file_inner(&conn, &user_id, session_id, &file_id, &info).await {
        Ok(n) => {
            set_index_status(&conn, &file_id, "ready", n as i64, None).await?;
            Ok(n)
        }
        Err(e) => {
            // Best-effort: a status-write failure must not mask the real error.
            let _ = set_index_status(&conn, &file_id, "failed", 0, Some(&e)).await;
            Err(e)
        }
    }
}

async fn index_file_inner(
    conn: &libsql::Connection,
    user_id: &str,
    session_id: Option<i64>,
    file_id: &str,
    info: &crate::logic::office::OfficeFile,
) -> Result<usize, String> {
    let text = match extract_text(user_id, file_id, &info.ext).await? {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Ok(0),
    };

    let chunks = chunk_markdown(&text, CHUNK_CHARS, CHUNK_OVERLAP);
    if chunks.is_empty() {
        return Ok(0);
    }

    let source = info.original_name.clone();

    let model = kawai_embedding::build_providers_from_env();
    if let Some(sid) = session_id {
        associate_session_files(conn, sid, &[file_id.to_string()]).await?;
    }

    let store: LibsqlVectorStore<TenantAwareEmbedder, RagChunk> =
        LibsqlVectorStore::new(conn.clone(), &model)
            .await
            .map_err(|e| format!("store: {e}"))?;

    // FTS mirror + triggers must exist before the inserts below so BM25 sees
    // them; the backfill inside also covers chunks indexed pre-FTS.
    ensure_fts(conn).await?;

    let docs: Vec<RagChunk> = chunks
        .into_iter()
        .enumerate()
        .map(|(i, (locator, content))| RagChunk {
            id: format!("{file_id}#c{i}"),
            content,
            file_id: file_id.to_string(),
            source: source.clone(),
            locator,
        })
        .collect();

    let embeddings = EmbeddingsBuilder::new(model)
        .documents(docs.clone())
        .map_err(|e| format!("builder: {e}"))?
        .build()
        .await
        .map_err(|e| format!("embed: {e}"))?;

    store
        .insert_documents(embeddings)
        .await
        .map_err(|e| format!("insert: {e}"))?;

    Ok(docs.len())
}

/// Retrieve the top-k most relevant indexed chunks for a query, scoped to the
/// files the session has uploaded (`session_files`). The session id is bound
/// server-side (agent tool / wrapper state) — callers only supply the query
/// and an optional [`SearchMode`] (`None` = hybrid). Hybrid fuses vector
/// similarity with FTS5/BM25 keyword ranking via RRF so exact codes and
/// numbers also hit; `keyword` skips the embedder, `semantic` skips the FTS
/// side. Empty result means nothing is indexed for this session yet.
pub async fn knowledge_search(
    user_id: String,
    session_id: i64,
    query: String,
    mode: Option<SearchMode>,
) -> Result<Vec<RagHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mode = mode.unwrap_or_default();
    const K: u64 = 8;

    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    let candidates = session_file_ids(&conn, session_id).await?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Vector side — skipped entirely in keyword mode (no embedder round-trip).
    let vector: Vec<RagChunk> = if mode == SearchMode::Keyword {
        Vec::new()
    } else {
        let model = kawai_embedding::build_providers_from_env();
        let store: LibsqlVectorStore<TenantAwareEmbedder, RagChunk> =
            LibsqlVectorStore::new(conn.clone(), &model)
                .await
                .map_err(|e| format!("store: {e}"))?;
        let index = store.index(model);

        let mut file_filter = LibsqlSearchFilter::eq("file_id", json!(candidates[0]));
        for fid in &candidates[1..] {
            file_filter = file_filter.or(LibsqlSearchFilter::eq("file_id", json!(fid)));
        }

        let req = VectorSearchRequest::builder()
            .query(&query)
            .samples(K)
            .filter(file_filter)
            .build();

        index
            .top_n::<RagChunk>(req)
            .await
            .map_err(|e| format!("search: {e}"))?
            .into_iter()
            .map(|(_, _, doc)| doc)
            .collect()
    };

    // Lexical side. In hybrid mode it is best-effort: a missing/broken FTS
    // mirror must never fail the search — degrade to vector-only. In keyword
    // mode it IS the requested retrieval, so failures surface; an untokenizable
    // query just yields no matches.
    let lexical: Vec<RagChunk> = if mode == SearchMode::Semantic {
        Vec::new()
    } else {
        match fts_match_query(&query) {
            Some(match_query) => {
                if mode == SearchMode::Hybrid {
                    if ensure_fts(&conn).await.is_ok() {
                        bm25_search(&conn, &candidates, &match_query, K as usize)
                            .await
                            .unwrap_or_default()
                    } else {
                        Vec::new()
                    }
                } else {
                    ensure_fts(&conn).await?;
                    bm25_search(&conn, &candidates, &match_query, K as usize).await?
                }
            }
            None => Vec::new(),
        }
    };

    let docs = rrf_fuse(vector, lexical, K as usize);

    Ok(docs
        .into_iter()
        .map(|doc| RagHit {
            source: doc.source,
            locator: doc.locator,
            content: doc.content,
        })
        .collect())
}

/// Remove the given files' session associations and drop the chunks of any
/// file no longer referenced by ANY session (orphans). Used when a file is
/// removed from a session or deleted outright. Safe to call before anything
/// was indexed (missing tables are treated as "nothing to delete").
pub async fn forget_file(
    user_id: String,
    session_id: Option<i64>,
    file_ids: Vec<String>,
) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    if let Some(sid) = session_id {
        for fid in &file_ids {
            if let Err(e) = conn
                .execute(
                    "DELETE FROM session_files WHERE session_id = ? AND file_id = ?",
                    (sid, fid.clone()),
                )
                .await
            {
                return Err(format!("disassociate: {e}"));
            }
        }
    }

    // Orphan pass: chunks of files with zero remaining associations go away.
    let mut orphans: Vec<String> = Vec::new();
    for fid in &file_ids {
        let mut rows = conn
            .query(
                "SELECT EXISTS (SELECT 1 FROM session_files WHERE file_id = ?)",
                vec![fid.clone()],
            )
            .await
            .map_err(|e| format!("orphan check: {e}"))?;
        let row = rows
            .next()
            .await
            .map_err(|e| format!("orphan check: {e}"))?
            .ok_or_else(|| "orphan check: no row".to_string())?;
        let still_referenced: i64 = row.get(0).map_err(|e| format!("orphan check: {e}"))?;
        if still_referenced == 0 {
            orphans.push(fid.clone());
        }
    }
    for fid in &orphans {
        purge_file_chunks(&conn, fid).await?;
        // The file may still sit in the library, but nothing is indexed
        // anymore — reset its status row so the panel shows `not indexed`.
        conn.execute(
            "DELETE FROM rag_files WHERE file_id = ?",
            vec![fid.clone()],
        )
        .await
        .map_err(|e| format!("rag_files delete: {e}"))?;
    }
    Ok(orphans.len())
}

/// Number of chunks a file currently has indexed (0 when nothing has ever
/// been indexed — the `rag_chunks` table itself may not exist yet).
async fn file_chunk_count(conn: &libsql::Connection, file_id: &str) -> Result<i64, String> {
    let mut rows = match conn
        .query(
            "SELECT COUNT(*) FROM rag_chunks WHERE file_id = ?",
            vec![file_id.to_string()],
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) if e.to_string().contains("no such table") => return Ok(0),
        Err(e) => return Err(format!("chunk count: {e}")),
    };
    match rows
        .next()
        .await
        .map_err(|e| format!("chunk count: {e}"))?
    {
        Some(row) => row.get(0).map_err(|e| format!("chunk count: {e}")),
        None => Ok(0),
    }
}

/// Associate existing library documents with a session (the knowledge panel's
/// "Add to this session") and make sure they become searchable: files with no
/// chunks — imported before RAG existed, previously purged, or failed — are
/// (re)indexed; files mid-index are left alone. Re-indexing is idempotent
/// (deterministic chunk ids replace). Individual index failures don't abort
/// the batch — they surface per file via the panel's `failed` status.
/// Returns how many files were (re)indexed.
pub async fn knowledge_add_to_session(
    user_id: &str,
    session_id: i64,
    file_ids: &[String],
) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    // Validate every id against the store before associating anything.
    for fid in file_ids {
        crate::logic::office::store::resolve(user_id, fid)
            .map_err(|e| format!("resolve {fid}: {e}"))?;
    }
    associate_session_files(&conn, session_id, file_ids).await?;

    let mut reindexed = 0usize;
    for fid in file_ids {
        if file_chunk_count(&conn, fid).await? > 0 {
            continue;
        }
        if rag_file_status(&conn, fid).await?.as_deref() == Some("indexing") {
            continue;
        }
        if office_index_file(user_id.to_string(), Some(session_id), fid.clone())
            .await
            .is_ok()
        {
            reindexed += 1;
        }
    }
    Ok(reindexed)
}

/// Language preference for YouTube transcripts, in order.
const YT_LANGS: [&str; 2] = ["en", "id"];

/// Ingest a YouTube video into the knowledge base: fetch its transcript,
/// store it as a markdown document (`yt-<videoId> <title>.md`), associate it
/// with the session and index it. Re-importing a known video just
/// re-associates/re-indexes the existing document (dedupe by name prefix).
/// Transcript fetch errors surface to the caller; indexing failures land in
/// the file's `failed` status (visible in the panel).
pub async fn knowledge_import_youtube(
    user_id: &str,
    session_id: Option<i64>,
    url: &str,
) -> Result<crate::logic::office::OfficeFile, String> {
    let video_id = youtube_transcript::YouTubeTranscript::extract_video_id(url)
        .map_err(|e| format!("not a YouTube URL: {e}"))?;

    // Dedupe: the deterministic `yt-<id>` name prefix identifies a video.
    let prefix = format!("yt-{video_id} ");
    if let Some(existing) = crate::logic::office::list_files(user_id)?
        .into_iter()
        .find(|f| f.original_name.starts_with(&prefix) || f.original_name == format!("yt-{video_id}.md"))
    {
        if let Some(sid) = session_id {
            knowledge_add_to_session(user_id, sid, &[existing.id.clone()]).await?;
        }
        return Ok(existing);
    }

    let yt = youtube_transcript::YouTubeTranscript::new();
    let langs = YT_LANGS.to_vec();
    let resp = match yt.fetch_transcript(&video_id, Some(langs)).await {
        Ok(resp) => resp,
        Err(youtube_transcript::TranscriptError::NoTranscriptFound(_, _)) => {
            // Video has no en/id track — fall back to whatever exists.
            let list = yt
                .list_transcripts(&video_id)
                .await
                .map_err(|e| format!("transcript list: {e}"))?;
            let fallback = list
                .all_transcripts()
                .first()
                .ok_or_else(|| "video has no transcripts".to_string())?
                .language_code
                .clone();
            yt.fetch_transcript(&video_id, Some(vec![&fallback]))
                .await
                .map_err(|e| format!("transcript: {e}"))?
        }
        Err(e) => return Err(format!("transcript: {e}")),
    };

    let title = resp.title.clone().unwrap_or_else(|| video_id.clone());
    let body: String = resp
        .transcript
        .iter()
        .map(|item| item.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let markdown = format!(
        "# {title} (YouTube)\n\nSource: https://youtu.be/{video_id}\n\n{body}\n"
    );

    let file = crate::logic::office::store::import_bytes(
        user_id,
        &format!("yt-{video_id} {title}.md"),
        markdown.as_bytes(),
    )?;
    if let Some(sid) = session_id {
        knowledge_add_to_session(user_id, sid, &[file.id.clone()]).await?;
    }
    Ok(file)
}

/// Delete a stored document entirely: session associations, indexed chunks
/// (with FTS mirror + vectors), the index status row, and the file itself in
/// the office store. Unlike [`forget_file`] there is no orphan pass — the
/// file is gone unconditionally.
pub async fn office_delete_file(user_id: &str, file_id: &str) -> Result<(), String> {
    // Resolve first: an unknown id errors before anything is deleted.
    let (stored_path, _info) = crate::logic::office::store::resolve(user_id, file_id)
        .map_err(|e| format!("resolve: {e}"))?;

    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    conn.execute(
        "DELETE FROM session_files WHERE file_id = ?",
        vec![file_id.to_string()],
    )
    .await
    .map_err(|e| format!("disassociate: {e}"))?;
    purge_file_chunks(&conn, file_id).await?;
    conn.execute(
        "DELETE FROM rag_files WHERE file_id = ?",
        vec![file_id.to_string()],
    )
    .await
    .map_err(|e| format!("rag_files delete: {e}"))?;

    crate::logic::office::store::delete_file(user_id, &stored_path, file_id)
}

/// Delete one file's chunks plus their FLOAT32 vectors and map links. Missing
/// tables are tolerated (nothing indexed yet). The FTS mirror rows go away via
/// the `rag_chunks` delete trigger.
async fn purge_file_chunks(conn: &libsql::Connection, file_id: &str) -> Result<(), String> {
    let docs_subq = "SELECT rowid FROM rag_chunks WHERE file_id = ?";
    // 1. Drop the FLOAT32 vectors referenced by the map for these docs, so
    //    no orphaned embedding rows remain.
    for sql in [
        format!(
            "DELETE FROM rag_chunks_embeddings \
             WHERE rowid IN \
             (SELECT embedding_rowid FROM rag_chunks_embedding_map \
              WHERE document_rowid IN ({docs_subq}))"
        ),
        format!("DELETE FROM rag_chunks_embedding_map WHERE document_rowid IN ({docs_subq})"),
        format!("DELETE FROM rag_chunks WHERE file_id = ?"),
    ] {
        if let Err(e) = conn.execute(&sql, vec![file_id]).await {
            if !e.to_string().contains("no such table") {
                return Err(format!("purge: {e}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str) -> RagChunk {
        RagChunk {
            id: id.to_string(),
            content: String::new(),
            file_id: String::new(),
            source: String::new(),
            locator: String::new(),
        }
    }

    #[test]
    fn fts_match_query_quotes_and_sanitizes() {
        assert_eq!(
            fts_match_query("berapa total INV-2026-041?"),
            Some("\"berapa\" \"total\" \"INV-2026-041?\"".to_string())
        );
        assert_eq!(fts_match_query("  \"  \""), None);
        assert_eq!(fts_match_query(""), None);
    }

    #[test]
    fn rrf_fuse_rewards_dual_side_hits() {
        // "a" ranks 1st (vector) + 2nd (lexical) → beats "b" (1st lexical only
        // is "c"; b is 2nd vector) and outranks single-side winners.
        let out = rrf_fuse(vec![chunk("a"), chunk("b")], vec![chunk("c"), chunk("a")], 2);
        assert_eq!(out[0].id, "a");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn rrf_fuse_respects_limit_and_empty_sides() {
        let out = rrf_fuse(Vec::new(), vec![chunk("x"), chunk("y")], 1);
        assert_eq!(out.len(), 1);
        assert!(rrf_fuse(Vec::new(), Vec::new(), 8).is_empty());
    }

    const RAG_CHUNKS_SCHEMA: &str =
        "CREATE TABLE rag_chunks (id TEXT PRIMARY KEY, content TEXT, file_id TEXT, source TEXT, locator TEXT)";

    async fn memory_conn() -> libsql::Connection {
        let db = libsql::Builder::new_local(":memory:").build().await.unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch(RAG_CHUNKS_SCHEMA).await.unwrap();
        conn
    }

    async fn insert_chunk(conn: &libsql::Connection, id: &str, content: &str, file_id: &str) {
        conn.execute(
            "INSERT INTO rag_chunks (id, content, file_id, source, locator) VALUES (?, ?, ?, 'src', 'chunk-0')",
            (id, content, file_id),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn fts_mirror_syncs_via_triggers_and_scopes_to_candidates() {
        let conn = memory_conn().await;
        ensure_fts(&conn).await.unwrap();
        insert_chunk(&conn, "a#c0", "Invoice INV-2026-041 total 5000", "a").await;
        insert_chunk(&conn, "b#c0", "Laporan keuangan kuartal pertama", "b").await;

        let both = ["a".to_string(), "b".to_string()];
        let hits = bm25_search(&conn, &both, "\"INV-2026-041\"", 8)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a#c0");

        // Candidate scoping: the code only exists in file "a".
        let hits = bm25_search(&conn, &["b".to_string()], "\"INV-2026-041\"", 8)
            .await
            .unwrap();
        assert!(hits.is_empty());

        // Delete trigger keeps the mirror clean.
        conn.execute("DELETE FROM rag_chunks WHERE id = 'a#c0'", ())
            .await
            .unwrap();
        let hits = bm25_search(&conn, &both, "\"INV-2026-041\"", 8)
            .await
            .unwrap();
        assert!(hits.is_empty());
    }

    #[tokio::test]
    async fn fts_backfills_rows_indexed_before_the_mirror_existed() {
        let conn = memory_conn().await;
        insert_chunk(&conn, "x#c0", "kwitansi pembayaran Q1", "x").await;
        ensure_fts(&conn).await.unwrap();
        let hits = bm25_search(&conn, &["x".to_string()], "\"kwitansi\"", 8)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "x#c0");
        // Idempotent: a second ensure_fts must not duplicate mirror rows.
        ensure_fts(&conn).await.unwrap();
        let hits = bm25_search(&conn, &["x".to_string()], "\"kwitansi\"", 8)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
    }
}
