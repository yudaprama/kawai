//! libSQL schema creation and low-level storage helpers for the RAG subsystem.
//!
//! Physical layout (one DB per user):
//!
//!   rag_chunks                (id TEXT PRIMARY KEY, content, file_id, source, locator)
//!   rag_chunks_embeddings     (embedding FLOAT32(dims)) — one row per vector
//!   rag_chunks_embedding_map  (embedding_rowid → document_rowid)
//!   rag_chunks_fts            (FTS5 virtual table, kept in sync by triggers)
//!   rag_files                 (file_id TEXT PRIMARY KEY, status, chunks, error, updated_at)
//!   session_files             (session_id, file_id, added_at)

use super::types::{unix_secs, RagChunk};

/// Serialize an embedding into the little-endian `f32` byte blob libSQL's
/// `vector(?)` / `vector_distance_cos` SQL functions expect.
pub(crate) fn vec_to_le_bytes(v: &[f64]) -> Vec<u8> {
    v.iter()
        .map(|x| *x as f32)
        .flat_map(f32::to_le_bytes)
        .collect()
}

/// Create the vector-store tables + indexes if they do not exist. `dims` must
/// match the embedding model's dimension (FLOAT32 columns are sized on
/// creation and never migrate — re-index after a dimension change).
pub(crate) async fn ensure_vector_schema(
    conn: &libsql::Connection,
    dims: usize,
) -> Result<(), String> {
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS rag_chunks (\
             id TEXT PRIMARY KEY,\
             content TEXT,\
             file_id TEXT,\
             source TEXT,\
             locator TEXT\
         );
         CREATE INDEX IF NOT EXISTS idx_rag_chunks_id ON rag_chunks(id);
         CREATE TABLE IF NOT EXISTS rag_chunks_embeddings (
             embedding FLOAT32({dims})
         );
         CREATE INDEX IF NOT EXISTS rag_chunks_embeddings_idx
             ON rag_chunks_embeddings (libsql_vector_idx(embedding));
         CREATE TABLE IF NOT EXISTS rag_chunks_embedding_map (
             embedding_rowid INTEGER PRIMARY KEY,
             document_rowid INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding_map_document_rowid
             ON rag_chunks_embedding_map(document_rowid);"
    );
    conn.execute_batch(&sql)
        .await
        .map_err(|e| format!("vector schema: {e}"))?;
    Ok(())
}

/// Insert chunks with their embeddings, replacing any previous rows for the
/// same chunk ids (re-index of an already-indexed file). One transaction.
pub(crate) async fn insert_chunks(
    conn: &libsql::Connection,
    docs: &[RagChunk],
    embeddings: &[Vec<f64>],
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|e| format!("insert tx: {e}"))?;
    for (doc, embedding) in docs.iter().zip(embeddings) {
        // Replace any previous embedding rows for this chunk id.
        let existing: Option<i64> = {
            let mut rows = tx
                .query(
                    "SELECT rowid FROM rag_chunks WHERE id = ?",
                    vec![libsql::Value::Text(doc.id.clone())],
                )
                .await
                .map_err(|e| format!("insert lookup: {e}"))?;
            match rows
                .next()
                .await
                .map_err(|e| format!("insert lookup: {e}"))?
            {
                Some(row) => row.get::<i64>(0).ok(),
                None => None,
            }
        };
        if let Some(document_rowid) = existing {
            tx.execute(
                "DELETE FROM rag_chunks_embeddings
                 WHERE rowid IN (
                     SELECT embedding_rowid FROM rag_chunks_embedding_map
                     WHERE document_rowid = ?
                 )",
                vec![libsql::Value::Integer(document_rowid)],
            )
            .await
            .map_err(|e| format!("insert purge: {e}"))?;
            tx.execute(
                "DELETE FROM rag_chunks_embedding_map WHERE document_rowid = ?",
                vec![libsql::Value::Integer(document_rowid)],
            )
            .await
            .map_err(|e| format!("insert purge: {e}"))?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO rag_chunks (id, content, file_id, source, locator)
             VALUES (?, ?, ?, ?, ?)",
            vec![
                libsql::Value::Text(doc.id.clone()),
                libsql::Value::Text(doc.content.clone()),
                libsql::Value::Text(doc.file_id.clone()),
                libsql::Value::Text(doc.source.clone()),
                libsql::Value::Text(doc.locator.clone()),
            ],
        )
        .await
        .map_err(|e| format!("insert chunk: {e}"))?;
        let document_rowid = tx.last_insert_rowid();
        let mut rows = tx
            .query(
                "INSERT INTO rag_chunks_embeddings (embedding) VALUES (vector(?)) RETURNING rowid",
                vec![libsql::Value::Blob(vec_to_le_bytes(embedding))],
            )
            .await
            .map_err(|e| format!("insert embedding: {e}"))?;
        let embedding_rowid = match rows
            .next()
            .await
            .map_err(|e| format!("insert embedding: {e}"))?
        {
            Some(row) => row
                .get::<i64>(0)
                .map_err(|e| format!("insert embedding rowid: {e}"))?,
            None => return Err("insert embedding: no rowid".to_string()),
        };
        drop(rows);
        tx.execute(
            "INSERT INTO rag_chunks_embedding_map (embedding_rowid, document_rowid) VALUES (?, ?)",
            vec![
                libsql::Value::Integer(embedding_rowid),
                libsql::Value::Integer(document_rowid),
            ],
        )
        .await
        .map_err(|e| format!("insert map: {e}"))?;
    }
    tx.commit().await.map_err(|e| format!("insert commit: {e}"))
}

/// Exact cosine top-k over the candidate files' chunks (best embedding per
/// chunk; today one vector per chunk, the window keeps that true if it ever
/// changes). Params bind the query vector twice — libSQL positional `?`
/// placeholders do not reuse.
pub(crate) async fn vector_search_top_k(
    conn: &libsql::Connection,
    query_vec: &[f64],
    candidates: &[String],
    k: usize,
) -> Result<Vec<RagChunk>, String> {
    if candidates.is_empty() || k == 0 {
        return Ok(Vec::new());
    }
    let blob = libsql::Value::Blob(vec_to_le_bytes(query_vec));
    let mut params: Vec<libsql::Value> = Vec::with_capacity(candidates.len() + 3);
    params.push(blob.clone());
    params.push(blob);
    for fid in candidates {
        params.push(libsql::Value::Text(fid.clone()));
    }
    params.push(libsql::Value::Integer(k as i64));
    let placeholders = vec!["?"; candidates.len()].join(", ");
    let sql = format!(
        "WITH ranked AS (
             SELECT m.document_rowid AS document_rowid,
                    1 - vector_distance_cos(?, e.embedding) AS score,
                    ROW_NUMBER() OVER (
                        PARTITION BY m.document_rowid
                        ORDER BY 1 - vector_distance_cos(?, e.embedding) DESC,
                                 m.document_rowid ASC
                    ) AS rank
             FROM rag_chunks_embeddings e
             JOIN rag_chunks_embedding_map m ON e.rowid = m.embedding_rowid
             JOIN rag_chunks d ON m.document_rowid = d.rowid
             WHERE d.file_id IN ({placeholders})
         )
         SELECT d.id, d.content, d.file_id, d.source, d.locator
         FROM ranked
         JOIN rag_chunks d ON ranked.document_rowid = d.rowid
         WHERE ranked.rank = 1
         ORDER BY ranked.score DESC, d.id ASC
         LIMIT ?"
    );
    let mut rows = conn
        .query(&sql, params)
        .await
        .map_err(|e| format!("vector search: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("vector search: {e}"))?
    {
        out.push(RagChunk {
            id: row.get(0).map_err(|e| format!("vector search: {e}"))?,
            content: row.get(1).map_err(|e| format!("vector search: {e}"))?,
            file_id: row.get(2).map_err(|e| format!("vector search: {e}"))?,
            source: row.get(3).map_err(|e| format!("vector search: {e}"))?,
            locator: row.get(4).map_err(|e| format!("vector search: {e}"))?,
        });
    }
    Ok(out)
}

// ── lexical (FTS5 / BM25) mirror ─────────────────────────────────────────────

/// Create the FTS5 mirror of `rag_chunks` plus the triggers that keep it in
/// sync, then backfill rows written before the mirror existed. Every write
/// path (`insert_chunks`, `purge_file_chunks`, the orphan pass in
/// `forget_file`) issues plain INSERT/DELETE on `rag_chunks`, so the triggers
/// cover them without touching any caller. Must be called only after
/// `rag_chunks` itself exists.
pub(crate) async fn ensure_fts(conn: &libsql::Connection) -> Result<(), String> {
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
/// operators) can never produce a MATCH syntax error. Tokens are OR-ed and
/// ranked by BM25 — short tokens (<3 chars) are dropped as noise while
/// longer siblings remain; if nothing survives, every token is kept (a lone
/// short code is still a valid query). `None` when nothing searchable remains.
pub(crate) fn fts_match_query(query: &str) -> Option<String> {
    let all: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', " "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .take(16)
        .collect();
    let tokens: Vec<&String> = {
        let long: Vec<&String> = all.iter().filter(|t| t.chars().count() >= 3).collect();
        if long.is_empty() {
            all.iter().collect()
        } else {
            long
        }
    };
    if tokens.is_empty() {
        None
    } else {
        Some(
            tokens
                .iter()
                .map(|t| format!("\"{}\"", t))
                .collect::<Vec<_>>()
                .join(" OR "),
        )
    }
}

/// Lexical top-k: BM25 over the FTS5 mirror, restricted to the same candidate
/// files the vector side searches. SQLite's `bm25()` is lower-is-better,
/// so the ASC order yields best matches first.
pub(crate) async fn bm25_search(
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

// ── session ↔ file association ──────────────────────────────────────────────

/// Record which files a session referenced (idempotent).
pub(crate) async fn associate_session_files(
    conn: &libsql::Connection,
    session_id: i64,
    file_ids: &[String],
) -> Result<(), String> {
    let now = unix_secs();
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
    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("session files: {e}"))?
    {
        out.push(row.get(0).map_err(|e| format!("session files: {e}"))?);
    }
    Ok(out)
}

/// Upsert one file's index status row. `raw` is the full plain text (vision description or document text) — stored once when status=ready so the Assets UI can show it without re-reading the file. `None` leaves the existing raw unchanged except when explicitly set via the 6-col path.
pub(crate) async fn set_index_status(
    conn: &libsql::Connection,
    file_id: &str,
    status: &str,
    chunks: i64,
    error: Option<&str>,
) -> Result<(), String> {
    set_index_status_with_raw(conn, file_id, status, chunks, error, None).await
}

/// Upsert with raw plain text. When `raw` is `Some`, the column is overwritten; when `None` it is left as-is (except for backwards compat where a fresh row gets NULL).
pub(crate) async fn set_index_status_with_raw(
    conn: &libsql::Connection,
    file_id: &str,
    status: &str,
    chunks: i64,
    error: Option<&str>,
    raw: Option<&str>,
) -> Result<(), String> {
    let error_val = match error {
        Some(e) => libsql::Value::Text(e.to_string()),
        None => libsql::Value::Null,
    };
    if let Some(r) = raw {
        conn.execute(
            "INSERT INTO rag_files (file_id, status, chunks, error, raw, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(file_id) DO UPDATE SET
                status = excluded.status,
                chunks = excluded.chunks,
                error = excluded.error,
                raw = excluded.raw,
                updated_at = excluded.updated_at",
            (file_id, status, chunks, error_val, r.to_string(), unix_secs()),
        )
        .await
        .map(|_| ())
        .map_err(|e| format!("rag_files upsert: {e}"))
    } else {
        // Keep existing raw (or NULL for new rows) — don't overwrite the stored plain text on indexing/failed.
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
}

/// Current stored status of one file's index (`None` when never indexed).
pub(crate) async fn rag_file_status(
    conn: &libsql::Connection,
    file_id: &str,
) -> Result<Option<String>, String> {
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

/// Number of chunks a file currently has indexed (0 when nothing has ever
/// been indexed — the `rag_chunks` table itself may not exist yet).
pub(crate) async fn file_chunk_count(
    conn: &libsql::Connection,
    file_id: &str,
) -> Result<i64, String> {
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
    match rows.next().await.map_err(|e| format!("chunk count: {e}"))? {
        Some(row) => row.get(0).map_err(|e| format!("chunk count: {e}")),
        None => Ok(0),
    }
}

/// Delete one file's chunks plus their FLOAT32 vectors and map links. Missing
/// tables are tolerated (nothing indexed yet). The FTS mirror rows go away via
/// the `rag_chunks` delete trigger.
pub(crate) async fn purge_file_chunks(
    conn: &libsql::Connection,
    file_id: &str,
) -> Result<(), String> {
    let docs_subq = "SELECT rowid FROM rag_chunks WHERE file_id = ?";
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
