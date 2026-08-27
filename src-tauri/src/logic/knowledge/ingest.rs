//! Ingestion pipeline: text chunking, extraction from office files, and the
//! vector-index write path.

use text_splitter::{ChunkConfig, MarkdownSplitter, TextSplitter};

use super::schema::{associate_session_files, ensure_fts, ensure_vector_schema, insert_chunks};
use super::types::{Heading, RagChunk, CHUNK_CHARS, CHUNK_OVERLAP};
use crate::logic::db;

// ── chunking ─────────────────────────────────────────────────────────────────

/// Scan markdown text for `#`-prefixed headings, returning their char offsets
/// and trimmed titles. Used to attach the nearest preceding heading as each
/// chunk's locator (e.g. "Invoice Summary" instead of "chunk-3").
pub(crate) fn scan_headings(text: &str) -> Vec<Heading> {
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
pub(crate) fn locator_for(headings: &[Heading], char_offset: usize, fallback_idx: usize) -> String {
    let idx = headings.partition_point(|h| h.char_offset <= char_offset);
    headings
        .get(idx.wrapping_sub(1))
        .map(|h| h.text.clone())
        .unwrap_or_else(|| format!("section {fallback_idx}"))
}

/// Chunk markdown text using `MarkdownSplitter` (respects heading boundaries)
/// and attach the nearest preceding heading as each chunk's locator.
pub(crate) fn chunk_markdown(
    text: &str,
    max_chars: usize,
    overlap: usize,
) -> Vec<(String, String)> {
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
pub(crate) fn chunk_plain(text: &str, max_chars: usize, overlap: usize) -> Vec<(String, String)> {
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

// ── extraction ───────────────────────────────────────────────────────────────

/// Extract full text from a stored office file, dispatching by extension to
/// the same engines `knowledge_context` uses. Returns `Ok(None)` for file kinds we
/// cannot index (e.g. unknown types). Images are described to text via the
/// ragloader chain; markdown (YouTube transcripts) is read as-is.
pub(crate) async fn extract_text(
    user_id: &str,
    file_id: &str,
    ext: &str,
) -> Result<Option<String>, String> {
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
        "png" | "jpg" | "jpeg" | "gif" | "webp" => describe_image(user_id, file_id).await.map(Some),
        "html" | "md" => {
            // Decks (html) read back as markdown through the deck parser;
            // plain markdown (YouTube transcripts) is read as-is.
            crate::logic::office::read_document(user_id, file_id)
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
pub(crate) async fn describe_image(user_id: &str, file_id: &str) -> Result<String, String> {
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

// ── indexing ─────────────────────────────────────────────────────────────────

/// Core index pipeline: extract → chunk → embed → insert. Called by
/// [`office_index_file`] after status bookkeeping.
pub(crate) async fn index_file_inner(
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

    // Vector tables + indexes first (FTS triggers + backfill below read from
    // rag_chunks), then the FTS mirror — both no-ops when they already exist.
    ensure_vector_schema(conn, model.dimension()).await?;
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

    let embeddings = model
        .embed_strings(docs.iter().map(|d| d.content.clone()).collect())
        .await
        .map_err(|e| format!("embed: {e}"))?;
    if embeddings.len() != docs.len() {
        return Err(format!(
            "embed: provider returned {} vectors for {} chunks",
            embeddings.len(),
            docs.len()
        ));
    }

    insert_chunks(conn, &docs, &embeddings).await?;

    Ok(docs.len())
}

/// Index one stored office file for vector search, then associate it with the
/// uploading session (`session_files`). Called fire-and-forget right after
/// import from the knowledge panel. Returns the number of chunks indexed, or
/// `Ok(0)` for empty/unsupported files. Errors surface the underlying cause
/// without aborting the session — the agent can still fall back to the office
/// read tools. Progress is recorded in `rag_files` (`indexing` → `ready`/`failed`)
/// so the panel can show it; a crash mid-run leaves a stale `indexing` row
/// that `knowledge_list` reports as failed/interrupted.
pub async fn office_index_file(
    user_id: String,
    session_id: Option<i64>,
    file_id: String,
) -> Result<usize, String> {
    let (_file_path, info) = crate::logic::office::store::resolve(&user_id, &file_id)
        .map_err(|e| format!("resolve: {e}"))?;

    // Tabular files are queried structurally by the data analysis agent —
    // never prose-indexed, and never given a rag_files row (the panel shows
    // no index badge for them).
    if crate::logic::office::store::is_tabular_ext(&info.ext) {
        return Ok(0);
    }

    let conn = db::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    super::schema::set_index_status(&conn, &file_id, "indexing", 0, None).await?;
    match index_file_inner(&conn, &user_id, session_id, &file_id, &info).await {
        Ok(n) => {
            super::schema::set_index_status(&conn, &file_id, "ready", n as i64, None).await?;
            Ok(n)
        }
        Err(e) => {
            // Best-effort: a status-write failure must not mask the real error.
            let _ = super::schema::set_index_status(&conn, &file_id, "failed", 0, Some(&e)).await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::schema::ensure_fts;
    use super::*;

    const RAG_CHUNKS_SCHEMA: &str =
        "CREATE TABLE rag_chunks (id TEXT PRIMARY KEY, content TEXT, file_id TEXT, source TEXT, locator TEXT)";

    async fn memory_conn() -> libsql::Connection {
        let db = libsql::Builder::new_local(":memory:")
            .build()
            .await
            .unwrap();
        let conn = db.connect().unwrap();
        conn.execute_batch(RAG_CHUNKS_SCHEMA).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn fts_backfills_rows_indexed_before_the_mirror_existed() {
        let conn = memory_conn().await;
        conn.execute(
            "INSERT INTO rag_chunks (id, content, file_id, source, locator) VALUES ('x#c0', 'kwitansi pembayaran Q1', 'x', 'src', 'chunk-0')",
            (),
        )
        .await
        .unwrap();
        ensure_fts(&conn).await.unwrap();
        let hits = super::super::schema::bm25_search(&conn, &["x".to_string()], "\"kwitansi\"", 8)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "x#c0");
        // Idempotent: a second ensure_fts must not duplicate mirror rows.
        ensure_fts(&conn).await.unwrap();
        let hits = super::super::schema::bm25_search(&conn, &["x".to_string()], "\"kwitansi\"", 8)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
    }
}
