//! Idle-time RAG indexing for office knowledge files.
//!
//! When the user attaches an office document (composer @-mention) there is a
//! natural idle gap before they finish typing the prompt. We use that gap to
//! extract → chunk → embed → store the document into the user's libSQL vector
//! store, so that `knowledge_search` at submit time is instant (no subprocess
//! spawn, no on-the-fly embedding).
//!
//! Pipeline: office extractors (ooxcli/pdfcli) → in-tree chunker →
//! `kawai-embedding` (local fastembed ONNX fallback, no API key) →
//! `rig-libsql` vector store. All deps are gated behind the `office` feature
//! and share the single rig-core rev used by the rest of the graph.
//!
//! Scoping: user isolation is structural — one database file per user
//! (`db_connection(user_id)`), so no `user_id` column anywhere. Chunks belong
//! to FILES; the `session_files` table associates files with the sessions that
//! referenced them, so a search covers everything the session has touched, not
//! just the current message's mentions.

use rig_core::Embed;
use rig_core::embeddings::EmbeddingsBuilder;
use rig_core::vector_store::request::{SearchFilter, VectorSearchRequest};
use rig_core::vector_store::{InsertDocuments, VectorStoreIndex};
use rig_libsql::{Column, ColumnValue, LibsqlSearchFilter, LibsqlVectorStore, LibsqlVectorStoreTable};
use serde::{Deserialize, Serialize};
use serde_json::json;

use kawai_embedding::TenantAwareEmbedder;

const CHUNK_CHARS: usize = 1500;
const CHUNK_OVERLAP: usize = 200;

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

const SESSION_FILES_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS session_files (
    session_id INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, file_id)
)";

async fn ensure_session_files(conn: &libsql::Connection) -> Result<(), String> {
    conn.execute(SESSION_FILES_SCHEMA, ())
        .await
        .map(|_| ())
        .map_err(|e| format!("session_files schema: {e}"))
}

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

/// All files the session has ever referenced.
async fn session_file_ids(
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

/// Split text into overlapping character windows. Keeps a single short doc as
/// one chunk; long docs are cut at `CHUNK_CHARS` with `CHUNK_OVERLAP` overlap
/// so context spanning a boundary is still retrievable.
fn chunk_text(text: &str, max: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + max).min(chars.len());
        out.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    out
}

/// Extract full text from a stored office file, dispatching by extension to the
/// same engines `knowledge_context` uses. Returns `Ok(None)` for file kinds we
/// cannot index (e.g. images, unknown types).
async fn extract_text(user_id: &str, file_id: &str) -> Result<Option<String>, String> {
    let (_path, info) =
        crate::logic::office::store::resolve(user_id, file_id).map_err(|e| format!("resolve: {e}"))?;
    match info.ext.as_str() {
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
        _ => Ok(None),
    }
}

/// A retrieved chunk with its provenance, for citation in the UI/LLM context.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHit {
    pub source: String,
    pub locator: String,
    pub content: String,
}

/// Index one stored office file for vector search. Called during the idle gap
/// after import (frontend fires it without awaiting). Returns the number of
/// chunks indexed, or `Ok(0)` for empty/unsupported files. Errors surface the
/// underlying cause (missing engine, embedding failure, …) without aborting
/// the session — the legacy `knowledge_context` path remains the fallback.
pub async fn office_index_file(user_id: String, file_id: String) -> Result<usize, String> {
    let text = match extract_text(&user_id, &file_id).await? {
        Some(t) if !t.trim().is_empty() => t,
        _ => return Ok(0),
    };

    let chunks = chunk_text(&text, CHUNK_CHARS, CHUNK_OVERLAP);
    if chunks.is_empty() {
        return Ok(0);
    }

    let source = crate::logic::office::store::resolve(&user_id, &file_id)
        .map(|(_, info)| info.original_name)
        .unwrap_or_else(|_| file_id.clone());

    let model = kawai_embedding::build_providers_from_env();
    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    // Re-indexing replaces: drop this file's previous chunks (and vectors) so
    // ids never go stale when the new extraction has fewer chunks.
    purge_file_chunks(&conn, &file_id).await?;

    let store: LibsqlVectorStore<TenantAwareEmbedder, RagChunk> =
        LibsqlVectorStore::new(conn, &model)
            .await
            .map_err(|e| format!("store: {e}"))?;

    let docs: Vec<RagChunk> = chunks
        .into_iter()
        .enumerate()
        .map(|(i, content)| RagChunk {
            id: format!("{file_id}#c{i}"),
            content,
            file_id: file_id.clone(),
            source: source.clone(),
            locator: format!("chunk-{i}"),
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

/// Retrieve the top-k most relevant indexed chunks for a query. The candidate
/// files are the message's explicit mentions UNION every file the session has
/// referenced (`session_files`) — so follow-up questions keep their document
/// context without re-mentioning. Mentioned files are (re-)associated with the
/// session here, at the only moment the session id is guaranteed known.
/// Called at submit time instead of the slow `knowledge_context` (which
/// re-extracts everything). Returns chunk contents; empty when nothing is
/// indexed yet (caller falls back to `knowledge_context`).
pub async fn knowledge_search(
    user_id: String,
    session_id: Option<i64>,
    file_ids: Vec<String>,
    query: String,
) -> Result<Vec<RagHit>, String> {
    if (file_ids.is_empty() && session_id.is_none()) || query.trim().is_empty() {
        return Ok(Vec::new());
    }
    const K: u64 = 8;

    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    ensure_session_files(&conn).await?;

    // Union of explicit mentions and the session's accumulated file set.
    let mut candidates: Vec<String> = file_ids.clone();
    if let Some(sid) = session_id {
        if !file_ids.is_empty() {
            associate_session_files(&conn, sid, &file_ids).await?;
        }
        candidates.extend(session_file_ids(&conn, sid).await?);
    }
    candidates.sort();
    candidates.dedup();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let model = kawai_embedding::build_providers_from_env();
    let store: LibsqlVectorStore<TenantAwareEmbedder, RagChunk> =
        LibsqlVectorStore::new(conn, &model)
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

    let results = index
        .top_n::<RagChunk>(req)
        .await
        .map_err(|e| format!("search: {e}"))?;

    Ok(results
        .into_iter()
        .map(|(_, _, doc)| RagHit {
            source: doc.source,
            locator: doc.locator,
            content: doc.content,
        })
        .collect())
}

/// Remove the given files' session associations and drop the chunks of any
/// file no longer referenced by ANY session (orphans). `session_id` `None`
/// (mention removed before the session exists) only runs the orphan pass.
/// Safe to call before anything was indexed (missing tables are treated as
/// "nothing to delete"); the index is cheaply rebuilt during idle time.
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
    ensure_session_files(&conn).await?;

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
    }
    Ok(orphans.len())
}

/// Delete one file's chunks plus their FLOAT32 vectors and map links. Missing
/// tables are tolerated (nothing indexed yet).
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
