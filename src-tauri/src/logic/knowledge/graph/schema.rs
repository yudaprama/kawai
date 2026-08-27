//! GraphRAG libSQL DDL, file status tracking, purge, and batch insert.

use super::types::{vec_to_le_bytes, unix_secs};

/// Create all graph tables + indexes if they do not exist. `dims` must match
/// the embedding model's dimension (FLOAT32 columns are sized on creation and
/// never migrate — re-index after a dimension change).
pub(crate) async fn ensure_graph_schema(
    conn: &libsql::Connection,
    dims: usize,
) -> Result<(), String> {
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS graph_nodes (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             content TEXT NOT NULL,
             file_id TEXT NOT NULL,
             community_id INTEGER NOT NULL,
             type TEXT NOT NULL DEFAULT 'entity'
         );
         CREATE INDEX IF NOT EXISTS idx_graph_nodes_title ON graph_nodes(title);
         CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(file_id);
         CREATE INDEX IF NOT EXISTS idx_graph_nodes_community ON graph_nodes(community_id);
         CREATE TABLE IF NOT EXISTS graph_nodes_embeddings (
             embedding FLOAT32({dims})
         );
         CREATE INDEX IF NOT EXISTS graph_nodes_embeddings_idx
             ON graph_nodes_embeddings (libsql_vector_idx(embedding));
         CREATE TABLE IF NOT EXISTS graph_nodes_embedding_map (
             embedding_rowid INTEGER PRIMARY KEY,
             document_rowid INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_graph_nodes_map_doc ON graph_nodes_embedding_map(document_rowid);

         CREATE TABLE IF NOT EXISTS graph_edges (
             id TEXT PRIMARY KEY,
             from_node TEXT NOT NULL,
             to_node TEXT NOT NULL,
             description TEXT NOT NULL,
             file_id TEXT NOT NULL,
             community_id INTEGER NOT NULL,
             weight REAL NOT NULL DEFAULT 1.0
         );
         CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node);
         CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node);
         CREATE INDEX IF NOT EXISTS idx_graph_edges_file ON graph_edges(file_id);
         CREATE INDEX IF NOT EXISTS idx_graph_edges_community ON graph_edges(community_id);
         CREATE TABLE IF NOT EXISTS graph_edges_embeddings (
             embedding FLOAT32({dims})
         );
         CREATE INDEX IF NOT EXISTS graph_edges_embeddings_idx
             ON graph_edges_embeddings (libsql_vector_idx(embedding));
         CREATE TABLE IF NOT EXISTS graph_edges_embedding_map (
             embedding_rowid INTEGER PRIMARY KEY,
             document_rowid INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_graph_edges_map_doc ON graph_edges_embedding_map(document_rowid);

         CREATE TABLE IF NOT EXISTS graph_files (
             file_id TEXT PRIMARY KEY,
             status TEXT NOT NULL,
             chunks INTEGER NOT NULL DEFAULT 0,
             error TEXT,
             updated_at INTEGER NOT NULL
         );"
    );
    conn.execute_batch(&sql)
        .await
        .map_err(|e| format!("graph schema: {e}"))?;
    Ok(())
}

pub(crate) async fn set_graph_file_status(
    conn: &libsql::Connection,
    file_id: &str,
    status: &str,
    chunks: i64,
    error: Option<&str>,
) -> Result<(), String> {
    let err = error
        .map(|e| libsql::Value::Text(e.to_string()))
        .unwrap_or(libsql::Value::Null);
    conn.execute(
        "INSERT INTO graph_files (file_id, status, chunks, error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET status=excluded.status, chunks=excluded.chunks, error=excluded.error, updated_at=excluded.updated_at",
        (file_id, status, chunks, err, unix_secs()),
    )
    .await
    .map(|_| ())
    .map_err(|e| format!("graph_files upsert: {e}"))
}

pub(crate) async fn purge_graph_file(
    conn: &libsql::Connection,
    file_id: &str,
) -> Result<(), String> {
    for sql in [
        "DELETE FROM graph_nodes_embeddings WHERE rowid IN (SELECT embedding_rowid FROM graph_nodes_embedding_map WHERE document_rowid IN (SELECT rowid FROM graph_nodes WHERE file_id = ?))",
        "DELETE FROM graph_nodes_embedding_map WHERE document_rowid IN (SELECT rowid FROM graph_nodes WHERE file_id = ?)",
        "DELETE FROM graph_nodes WHERE file_id = ?",
        "DELETE FROM graph_edges_embeddings WHERE rowid IN (SELECT embedding_rowid FROM graph_edges_embedding_map WHERE document_rowid IN (SELECT rowid FROM graph_edges WHERE file_id = ?))",
        "DELETE FROM graph_edges_embedding_map WHERE document_rowid IN (SELECT rowid FROM graph_edges WHERE file_id = ?)",
        "DELETE FROM graph_edges WHERE file_id = ?",
    ] {
        if let Err(e) = conn.execute(sql, vec![file_id.to_string()]).await {
            if !e.to_string().contains("no such table") {
                return Err(format!("purge graph: {e}"));
            }
        }
    }
    Ok(())
}

/// Insert a batch of graph nodes + edges with their embeddings in one transaction.
pub(crate) async fn insert_graph_batch(
    conn: &libsql::Connection,
    nodes: &[(String, String, String, String, i64)], // (id, title, content, file_id, community)
    node_embs: &[Vec<f64>],
    edges: &[(String, String, String, String, String, i64)], // (id, from, to, desc, file_id, community)
    edge_embs: &[Vec<f64>],
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .await
        .map_err(|e| format!("graph tx: {e}"))?;
    for ((id, title, content, file_id, cid), emb) in nodes.iter().zip(node_embs) {
        tx.execute(
            "INSERT OR REPLACE INTO graph_nodes (id, title, content, file_id, community_id) VALUES (?, ?, ?, ?, ?)",
            vec![
                libsql::Value::Text(id.clone()),
                libsql::Value::Text(title.clone()),
                libsql::Value::Text(content.clone()),
                libsql::Value::Text(file_id.clone()),
                libsql::Value::Integer(*cid),
            ],
        )
        .await
        .map_err(|e| format!("insert node: {e}"))?;
        let doc_rowid = tx.last_insert_rowid();
        let mut rows = tx
            .query(
                "INSERT INTO graph_nodes_embeddings (embedding) VALUES (vector(?)) RETURNING rowid",
                vec![libsql::Value::Blob(vec_to_le_bytes(emb))],
            )
            .await
            .map_err(|e| format!("insert node emb: {e}"))?;
        let emb_rowid: i64 = match rows
            .next()
            .await
            .map_err(|e| format!("insert node emb: {e}"))?
        {
            Some(r) => r.get(0).map_err(|e| format!("{e}"))?,
            None => return Err("no rowid for node emb".into()),
        };
        drop(rows);
        tx.execute(
            "INSERT INTO graph_nodes_embedding_map (embedding_rowid, document_rowid) VALUES (?, ?)",
            vec![
                libsql::Value::Integer(emb_rowid),
                libsql::Value::Integer(doc_rowid),
            ],
        )
        .await
        .map_err(|e| format!("map node: {e}"))?;
    }
    for ((id, from, to, desc, file_id, cid), emb) in edges.iter().zip(edge_embs) {
        tx.execute(
            "INSERT OR REPLACE INTO graph_edges (id, from_node, to_node, description, file_id, community_id) VALUES (?, ?, ?, ?, ?, ?)",
            vec![
                libsql::Value::Text(id.clone()),
                libsql::Value::Text(from.clone()),
                libsql::Value::Text(to.clone()),
                libsql::Value::Text(desc.clone()),
                libsql::Value::Text(file_id.clone()),
                libsql::Value::Integer(*cid),
            ],
        )
        .await
        .map_err(|e| format!("insert edge: {e}"))?;
        let doc_rowid = tx.last_insert_rowid();
        let mut rows = tx
            .query(
                "INSERT INTO graph_edges_embeddings (embedding) VALUES (vector(?)) RETURNING rowid",
                vec![libsql::Value::Blob(vec_to_le_bytes(emb))],
            )
            .await
            .map_err(|e| format!("insert edge emb: {e}"))?;
        let emb_rowid: i64 = match rows
            .next()
            .await
            .map_err(|e| format!("insert edge emb: {e}"))?
        {
            Some(r) => r.get(0).map_err(|e| format!("{e}"))?,
            None => return Err("no rowid for edge emb".into()),
        };
        drop(rows);
        tx.execute(
            "INSERT INTO graph_edges_embedding_map (embedding_rowid, document_rowid) VALUES (?, ?)",
            vec![
                libsql::Value::Integer(emb_rowid),
                libsql::Value::Integer(doc_rowid),
            ],
        )
        .await
        .map_err(|e| format!("map edge: {e}"))?;
    }
    tx.commit().await.map_err(|e| format!("graph commit: {e}"))
}
