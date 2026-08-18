//! Idle-time RAG indexing for office knowledge files.
//!
//! When the user attaches an office document (composer @-mention) there is a
//! natural idle gap before they finish typing the prompt. We use that gap to
//! extract → chunk → embed → store the document into a per-user libSQL vector
//! store, so that `knowledge_search` at submit time is instant (no subprocess
//! spawn, no on-the-fly embedding).
//!
//! Pipeline: office extractors (ooxcli/pdfcli) → in-tree chunker →
//! `kawai-embedding` (local fastembed ONNX fallback, no API key) →
//! `rig-libsql` vector store. All deps are gated behind the `office` feature
//! and share the single rig-core rev used by the rest of the graph.

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
    pub user_id: String,
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
            Column::new("user_id", "TEXT"),
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
            ("user_id", Box::new(self.user_id.clone())),
            ("file_id", Box::new(self.file_id.clone())),
            ("source", Box::new(self.source.clone())),
            ("locator", Box::new(self.locator.clone())),
        ]
    }
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
            user_id: user_id.clone(),
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

/// Retrieve the top-k most relevant indexed chunks for a query, scoped to the
/// given user and the mentioned file ids. Called at submit time instead of the
/// slow `knowledge_context` (which re-extracts everything). Returns chunk
/// contents; empty when nothing is indexed yet (caller falls back to
/// `knowledge_context`).
pub async fn knowledge_search(
    user_id: String,
    file_ids: Vec<String>,
    query: String,
) -> Result<Vec<RagHit>, String> {
    if file_ids.is_empty() || query.trim().is_empty() {
        return Ok(Vec::new());
    }
    const K: u64 = 8;

    let model = kawai_embedding::build_providers_from_env();
    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    let store: LibsqlVectorStore<TenantAwareEmbedder, RagChunk> =
        LibsqlVectorStore::new(conn, &model)
            .await
            .map_err(|e| format!("store: {e}"))?;
    let index = store.index(model);

    let mut filter = LibsqlSearchFilter::eq("user_id", json!(user_id));
    for fid in &file_ids {
        filter = filter.and(LibsqlSearchFilter::eq("file_id", json!(fid)));
    }

    let req = VectorSearchRequest::builder()
        .query(&query)
        .samples(K)
        .filter(filter)
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

/// Drop all indexed chunks (and their vector-map links) for the given file ids.
/// Scoped by `user_id` so one user cannot purge another's index. Safe to call
/// before any document was indexed (a missing table is treated as "nothing to
/// delete"). The frontend fires this when a knowledge mention is removed — the
/// index is cheaply rebuilt during idle time if the file is mentioned again.
pub async fn forget_file(user_id: String, file_ids: Vec<String>) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    let docs_subq = "SELECT rowid FROM rag_chunks WHERE user_id = ? AND file_id = ?";
    for fid in &file_ids {
        let p = vec![user_id.clone(), fid.clone()];
        // 1. Drop the FLOAT32 vectors referenced by the map for these docs, so
        //    no orphaned embedding rows remain.
        if let Err(e) = conn
            .execute(
                &format!(
                    "DELETE FROM rag_chunks_embeddings \
                     WHERE rowid IN \
                     (SELECT embedding_rowid FROM rag_chunks_embedding_map \
                      WHERE document_rowid IN ({docs_subq}))"
                ),
                p.clone(),
            )
            .await
        {
            if !e.to_string().contains("no such table") {
                return Err(format!("delete embeddings: {e}"));
            }
        }
        // 2. Drop the map links.
        if let Err(e) = conn
            .execute(
                &format!("DELETE FROM rag_chunks_embedding_map WHERE document_rowid IN ({docs_subq})"),
                p.clone(),
            )
            .await
        {
            if !e.to_string().contains("no such table") {
                return Err(format!("delete map: {e}"));
            }
        }
        // 3. Drop the document rows.
        if let Err(e) = conn
            .execute("DELETE FROM rag_chunks WHERE user_id = ? AND file_id = ?", p)
            .await
        {
            if !e.to_string().contains("no such table") {
                return Err(format!("delete: {e}"));
            }
        }
    }
    Ok(file_ids.len())
}
