//! GraphRAG — libSQL-native, feature-gated (`graph`).
//!
//! One-file ACID DB, same `db_connection(user_id)` as RAG. Toggle via
//! `Cargo --features graph` — zero cost when off (no tables, no routes,
//! no commands). When on, provides Naive / Local / Global / Hybrid / Mix
//! arms over the same libSQL file, fused with RRF in Rust.
//!
//! Layout (per-user DB):
//!   graph_nodes                (id PK, title, content, file_id, community_id, type)
//!   graph_nodes_embeddings     (embedding FLOAT32(dims)) + libsql_vector_idx
//!   graph_nodes_embedding_map  (embedding_rowid -> document_rowid)
//!   graph_edges                (id PK, from_node, to_node, description, file_id, community_id, weight)
//!   graph_edges_embeddings     (embedding FLOAT32(dims)) + libsql_vector_idx
//!   graph_edges_embedding_map  (embedding_rowid -> document_rowid)
//!   graph_files                (file_id PK, status, chunks, error, updated_at)
//! Indexes: from_node, to_node, community_id for Recursive CTE speed.

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde::{Deserialize, Serialize};
use text_splitter::{ChunkConfig, MarkdownSplitter};

// Pure helpers re-used from the modular `crates/graph` crate (include/exclude
// as a single `graph` feature — see `crates/graph/src/lib.rs`). When the
// feature is off the crate is not compiled at all.
#[cfg(feature = "graph")]
use graph as graph_crate;

const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP: usize = 150;
const RRF_K: f64 = 60.0;
const DEFAULT_COMMUNITIES: i64 = 8;

// ── public types ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphHit {
    /// Human-readable title (entity name or edge "A -> B")
    pub title: String,
    /// Chunk / description text
    pub content: String,
    /// Origin file id (for `office_read_document` round-trip)
    pub file_id: String,
    /// Locator inside file (heading / chunk idx)
    pub locator: String,
    /// Which arm produced it (for debugging)
    pub arm: String,
    /// Community cluster (Global arm)
    pub community_id: Option<i64>,
    /// RRF score (after fusion)
    pub score: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphSearchMode {
    /// Naive: vector over nodes only
    Naive,
    /// Local: entity → 1-2 hop Recursive CTE traversal
    Local,
    /// Global: edge/community vectors
    Global,
    /// Hybrid: Naive + Local + Global fused (equal weights)
    #[default]
    Hybrid,
    /// Mix: weighted Hybrid (0.2 naive / 0.5 local / 0.3 global)
    Mix,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphStats {
    pub nodes: i64,
    pub edges: i64,
    pub communities: i64,
    pub files: i64,
}

// ── internal helpers ────────────────────────────────────────────────────────

fn vec_to_le_bytes(v: &[f64]) -> Vec<u8> {
    v.iter().map(|x| *x as f32).flat_map(f32::to_le_bytes).collect()
}

fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn community_of(title: &str) -> i64 {
    // Cheap hash → stable community_id, no external Louvain dep.
    let mut h: u64 = 1469598103934665603;
    for b in title.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    (h % DEFAULT_COMMUNITIES as u64) as i64
}

fn extract_entities(text: &str) -> Vec<String> {
    // Capitalized phrases: "Alice", "Bob Smith", "Jakarta". Filter noise.
    let re = Regex::new(r"\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}\b").unwrap();
    let stop: HashSet<&str> = [
        "The", "This", "That", "There", "These", "Those", "When", "Where", "Which", "While",
        "With", "From", "Untuk", "Yang", "Dan", "Atau", "Adalah", "Dalam",
    ]
    .into_iter()
    .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for m in re.find_iter(text) {
        let s = m.as_str().trim().to_string();
        if s.len() < 3 || s.len() > 40 {
            continue;
        }
        if stop.contains(s.as_str()) {
            continue;
        }
        if seen.insert(s.clone()) {
            out.push(s);
        }
        if out.len() >= 24 {
            break;
        }
    }
    out
}

fn chunk_markdown(text: &str) -> Vec<(String, String)> {
    let config = ChunkConfig::new(CHUNK_CHARS)
        .with_overlap(CHUNK_OVERLAP)
        .expect("overlap clamped");
    let splitter = MarkdownSplitter::new(config);
    splitter
        .chunk_char_indices(text)
        .enumerate()
        .map(|(i, idx)| (format!("chunk {i}"), idx.chunk.to_string()))
        .collect()
}

// ── schema ──────────────────────────────────────────────────────────────────

pub async fn ensure_graph_schema(conn: &libsql::Connection, dims: usize) -> Result<(), String> {
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

async fn set_graph_file_status(
    conn: &libsql::Connection,
    file_id: &str,
    status: &str,
    chunks: i64,
    error: Option<&str>,
) -> Result<(), String> {
    let err = error.map(|e| libsql::Value::Text(e.to_string())).unwrap_or(libsql::Value::Null);
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

// ── vector helpers (mirror rag.rs pattern) ──────────────────────────────────

async fn vector_search_nodes(
    conn: &libsql::Connection,
    query_vec: &[f64],
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let blob = libsql::Value::Blob(vec_to_le_bytes(query_vec));
    let params: Vec<libsql::Value> = vec![blob.clone(), blob, libsql::Value::Integer(k as i64)];
    let sql = "WITH ranked AS (
            SELECT m.document_rowid AS docid, 1 - vector_distance_cos(?, e.embedding) AS score,
                   ROW_NUMBER() OVER (PARTITION BY m.document_rowid ORDER BY 1 - vector_distance_cos(?, e.embedding) DESC) AS rnk
            FROM graph_nodes_embeddings e JOIN graph_nodes_embedding_map m ON e.rowid=m.embedding_rowid
            JOIN graph_nodes n ON m.document_rowid=n.rowid
        )
        SELECT n.id, n.title, n.content, n.file_id, n.community_id, ranked.score
        FROM ranked JOIN graph_nodes n ON ranked.docid=n.rowid
        WHERE ranked.rnk=1 ORDER BY ranked.score DESC LIMIT ?";
    let mut rows = conn.query(sql, params).await.map_err(|e| format!("graph vector nodes: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("graph vector nodes: {e}"))? {
        let id: String = row.get(0).map_err(|e| format!("{e}"))?;
        let title: String = row.get(1).map_err(|e| format!("{e}"))?;
        let content: String = row.get(2).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(3).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(4).map_err(|e| format!("{e}"))?;
        let score: f64 = row.get::<f64>(5).unwrap_or(0.0);
        let _ = id;
        out.push(GraphHit {
            title,
            content: content.clone(),
            file_id: file_id.clone(),
            locator: format!("community {cid}"),
            arm: "naive".into(),
            community_id: Some(cid),
            score: Some(score),
        });
    }
    Ok(out)
}

async fn vector_search_edges(
    conn: &libsql::Connection,
    query_vec: &[f64],
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let blob = libsql::Value::Blob(vec_to_le_bytes(query_vec));
    let params: Vec<libsql::Value> = vec![blob.clone(), blob, libsql::Value::Integer(k as i64)];
    let sql = "WITH ranked AS (
            SELECT m.document_rowid AS docid, 1 - vector_distance_cos(?, e.embedding) AS score,
                   ROW_NUMBER() OVER (PARTITION BY m.document_rowid ORDER BY 1 - vector_distance_cos(?, e.embedding) DESC) AS rnk
            FROM graph_edges_embeddings e JOIN graph_edges_embedding_map m ON e.rowid=m.embedding_rowid
            JOIN graph_edges g ON m.document_rowid=g.rowid
        )
        SELECT g.id, g.from_node, g.to_node, g.description, g.file_id, g.community_id, ranked.score
        FROM ranked JOIN graph_edges g ON ranked.docid=g.rowid
        WHERE ranked.rnk=1 ORDER BY ranked.score DESC LIMIT ?";
    let mut rows = conn.query(sql, params).await.map_err(|e| format!("graph vector edges: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("graph vector edges: {e}"))? {
        let _id: String = row.get(0).map_err(|e| format!("{e}"))?;
        let from: String = row.get(1).map_err(|e| format!("{e}"))?;
        let to: String = row.get(2).map_err(|e| format!("{e}"))?;
        let desc: String = row.get(3).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(4).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(5).map_err(|e| format!("{e}"))?;
        let score: f64 = row.get::<f64>(6).unwrap_or(0.0);
        out.push(GraphHit {
            title: format!("{from} -> {to}"),
            content: desc,
            file_id,
            locator: format!("community {cid}"),
            arm: "global".into(),
            community_id: Some(cid),
            score: Some(score),
        });
    }
    Ok(out)
}

// ── Local arm: Recursive CTE 1-2 hop ────────────────────────────────────────

async fn local_traversal(
    conn: &libsql::Connection,
    query: &str,
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    // Extract candidate entity tokens from query, match nodes by title LIKE
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|t| t.chars().count() >= 3)
        .take(6)
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    // Find seed nodes whose title contains any token (case-insensitive)
    let mut seed_ids: Vec<String> = Vec::new();
    for tok in &tokens {
        let pat = format!("%{tok}%");
        let mut rows = conn
            .query(
                "SELECT id FROM graph_nodes WHERE title LIKE ? COLLATE NOCASE LIMIT 5",
                vec![libsql::Value::Text(pat)],
            )
            .await
            .map_err(|e| format!("local seed: {e}"))?;
        while let Some(row) = rows.next().await.map_err(|e| format!("local seed: {e}"))? {
            let id: String = row.get(0).map_err(|e| format!("{e}"))?;
            if !seed_ids.contains(&id) {
                seed_ids.push(id);
            }
        }
        if seed_ids.len() >= 8 {
            break;
        }
    }
    if seed_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; seed_ids.len()].join(", ");
    let sql = format!(
        "WITH RECURSIVE traversal(node_id, depth) AS (
            SELECT id, 0 FROM graph_nodes WHERE id IN ({placeholders})
            UNION
            SELECT e.to_node, t.depth+1 FROM traversal t JOIN graph_edges e ON t.node_id=e.from_node WHERE t.depth < 2
        )
        SELECT n.title, n.content, n.file_id, n.community_id FROM traversal t
        JOIN graph_nodes n ON t.node_id=n.id
        GROUP BY n.id LIMIT ?"
    );
    let mut params: Vec<libsql::Value> = seed_ids.into_iter().map(libsql::Value::Text).collect();
    params.push(libsql::Value::Integer(k as i64));
    let mut rows = conn.query(&sql, params).await.map_err(|e| format!("local traversal: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("local traversal: {e}"))? {
        let title: String = row.get(0).map_err(|e| format!("{e}"))?;
        let content: String = row.get(1).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(2).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(3).map_err(|e| format!("{e}"))?;
        out.push(GraphHit {
            title,
            content,
            file_id,
            locator: "2-hop".into(),
            arm: "local".into(),
            community_id: Some(cid),
            score: None,
        });
    }
    Ok(out)
}

// ── Global community expansion ──────────────────────────────────────────────

async fn global_community_hits(
    conn: &libsql::Connection,
    edge_hits: &[GraphHit],
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    if edge_hits.is_empty() {
        return Ok(Vec::new());
    }
    let cids: Vec<i64> = edge_hits.iter().filter_map(|h| h.community_id).collect::<HashSet<_>>().into_iter().collect();
    if cids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; cids.len()].join(", ");
    let sql = format!(
        "SELECT title, content, file_id, community_id FROM graph_nodes WHERE community_id IN ({placeholders}) LIMIT ?"
    );
    let mut params: Vec<libsql::Value> = cids.into_iter().map(libsql::Value::Integer).collect();
    params.push(libsql::Value::Integer(k as i64));
    let mut rows = conn.query(&sql, params).await.map_err(|e| format!("global community: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(|e| format!("global community: {e}"))? {
        let title: String = row.get(0).map_err(|e| format!("{e}"))?;
        let content: String = row.get(1).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(2).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(3).map_err(|e| format!("{e}"))?;
        out.push(GraphHit {
            title,
            content,
            file_id,
            locator: format!("community {cid}"),
            arm: "global".into(),
            community_id: Some(cid),
            score: None,
        });
    }
    Ok(out)
}

// ── RRF fusion ───────────────────────────────────────────────────────────────

fn rrf_fuse_graph(arms: Vec<(Vec<GraphHit>, f64)>, limit: usize) -> Vec<GraphHit> {
    let mut fused: HashMap<String, (f64, GraphHit)> = HashMap::new();
    for (hits, weight) in arms {
        for (rank, hit) in hits.into_iter().enumerate() {
            let key = format!("{}::{}", hit.title, hit.file_id);
            let score = weight * (1.0 / (RRF_K + rank as f64 + 1.0));
            let entry = fused.entry(key).or_insert_with(|| (0.0, hit));
            entry.0 += score;
        }
    }
    let mut ranked: Vec<(f64, GraphHit)> = fused
        .into_values()
        .map(|(s, mut h)| {
            h.score = Some(s);
            (s, h)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.title.cmp(&b.1.title)));
    ranked.truncate(limit);
    ranked.into_iter().map(|(_, h)| h).collect()
}

// ── ingestion ────────────────────────────────────────────────────────────────

async fn insert_graph_batch(
    conn: &libsql::Connection,
    nodes: &[(String, String, String, String, i64)], // (id, title, content, file_id, community)
    node_embs: &[Vec<f64>],
    edges: &[(String, String, String, String, String, i64)], // (id, from, to, desc, file_id, community)
    edge_embs: &[Vec<f64>],
) -> Result<(), String> {
    let tx = conn.transaction().await.map_err(|e| format!("graph tx: {e}"))?;
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
        let emb_rowid: i64 = match rows.next().await.map_err(|e| format!("insert node emb: {e}"))? {
            Some(r) => r.get(0).map_err(|e| format!("{e}"))?,
            None => return Err("no rowid for node emb".into()),
        };
        drop(rows);
        tx.execute(
            "INSERT INTO graph_nodes_embedding_map (embedding_rowid, document_rowid) VALUES (?, ?)",
            vec![libsql::Value::Integer(emb_rowid), libsql::Value::Integer(doc_rowid)],
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
        let emb_rowid: i64 = match rows.next().await.map_err(|e| format!("insert edge emb: {e}"))? {
            Some(r) => r.get(0).map_err(|e| format!("{e}"))?,
            None => return Err("no rowid for edge emb".into()),
        };
        drop(rows);
        tx.execute(
            "INSERT INTO graph_edges_embedding_map (embedding_rowid, document_rowid) VALUES (?, ?)",
            vec![libsql::Value::Integer(emb_rowid), libsql::Value::Integer(doc_rowid)],
        )
        .await
        .map_err(|e| format!("map edge: {e}"))?;
    }
    tx.commit().await.map_err(|e| format!("graph commit: {e}"))
}

/// Index one office file into the graph (entities + 1-hop edges). Fire-and-
/// forget from the UI, like `rag::office_index_file`. Returns (nodes, edges).
pub async fn graph_index_file(
    user_id: String,
    file_id: String,
) -> Result<(usize, usize), String> {
    #[cfg(not(feature = "office"))]
    {
        let _ = (&user_id, &file_id);
        return Err("graph_index_file requires office feature (file store)".into());
    }
    #[cfg(feature = "office")]
    {
        let info = crate::logic::office::store::resolve(&user_id, &file_id)
            .map_err(|e| format!("resolve: {e}"))?;
        if crate::logic::office::store::is_tabular_ext(&info.1.ext) {
            return Ok((0, 0));
        }
        let ext = info.1.ext.clone();
        let fid = file_id.clone();
        let uid = user_id.clone();
        let txt = extract_text_for_graph(&uid, &fid, &ext).await?;
        let t = txt.ok_or_else(|| "unsupported file type for graph".to_string())?;
        if t.trim().is_empty() {
            return Ok((0, 0));
        }
        let conn = crate::logic::db_connection(&user_id)
            .await
            .map_err(|e| format!("db: {e}"))?;
        set_graph_file_status(&conn, &fid, "indexing", 0, None).await?;
        match graph_index_inner(&conn, &t, &fid).await {
            Ok((n, e)) => {
                set_graph_file_status(&conn, &fid, "ready", (n + e) as i64, None).await?;
                Ok((n, e))
            }
            Err(err) => {
                let _ = set_graph_file_status(&conn, &fid, "failed", 0, Some(&err)).await;
                Err(err)
            }
        }
    }
}

/// Index raw text (no office file needed) — useful for tests / standalone.
pub async fn graph_index_text(
    user_id: &str,
    file_id: &str,
    text: &str,
) -> Result<(usize, usize), String> {
    if text.trim().is_empty() {
        return Ok((0, 0));
    }
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    let model_dim = kawai_embedding::build_providers_from_env().dimension();
    ensure_graph_schema(&conn, model_dim).await?;
    set_graph_file_status(&conn, file_id, "indexing", 0, None).await?;
    match graph_index_inner(&conn, text, file_id).await {
        Ok(v) => {
            set_graph_file_status(&conn, file_id, "ready", (v.0 + v.1) as i64, None).await?;
            Ok(v)
        }
        Err(e) => {
            let _ = set_graph_file_status(&conn, file_id, "failed", 0, Some(&e)).await;
            Err(e)
        }
    }
}

async fn graph_index_inner(
    conn: &libsql::Connection,
    text: &str,
    file_id: &str,
) -> Result<(usize, usize), String> {
    let model = kawai_embedding::build_providers_from_env();
    ensure_graph_schema(conn, model.dimension()).await?;

    let chunks = chunk_markdown(text);
    if chunks.is_empty() {
        return Ok((0, 0));
    }

    // Collect entities per chunk, then build global node/edge sets.
    let mut node_map: HashMap<String, String> = HashMap::new(); // title -> content (first chunk containing it)
    let mut edge_set: HashSet<(String, String)> = HashSet::new();
    for (_loc, chunk) in &chunks {
        let ents = extract_entities(chunk);
        for e in &ents {
            node_map.entry(e.clone()).or_insert_with(|| chunk.clone());
        }
        for w in ents.windows(2) {
            let (a, b) = (w[0].clone(), w[1].clone());
            if a != b {
                let (x, y) = if a < b { (a, b) } else { (b, a) };
                edge_set.insert((x, y));
            }
        }
        // Also fully connect small chunk's entities (clique) for richer local traversal
        if ents.len() <= 6 {
            for i in 0..ents.len() {
                for j in (i + 1)..ents.len() {
                    let (a, b) = (ents[i].clone(), ents[j].clone());
                    let (x, y) = if a < b { (a, b) } else { (b, a) };
                    edge_set.insert((x, y));
                }
            }
        }
    }
    if node_map.is_empty() {
        return Ok((0, 0));
    }

    // Prepare node rows
    let nodes: Vec<(String, String, String, String, i64)> = node_map
        .into_iter()
        .map(|(title, content)| {
            let cid = community_of(&title);
            let id = format!("{file_id}#node#{}", title.replace(' ', "_"));
            (id, title, content, file_id.to_string(), cid)
        })
        .collect();

    let edges: Vec<(String, String, String, String, String, i64)> = edge_set
        .into_iter()
        .map(|(a, b)| {
            let cid = community_of(&a);
            let id = format!("{file_id}#edge#{}__{}", a.replace(' ', "_"), b.replace(' ', "_"));
            let desc = format!("{a} relates to {b}");
            (id, a, b, desc, file_id.to_string(), cid)
        })
        .collect();

    // Embed
    let node_texts: Vec<String> = nodes.iter().map(|(_, t, c, _, _)| format!("{t}: {c}")).collect();
    let edge_texts: Vec<String> = edges.iter().map(|(_, f, t, d, _, _)| format!("{f} -> {t}: {d}")).collect();

    let node_embs = if nodes.is_empty() {
        Vec::new()
    } else {
        model
            .embed_strings(node_texts)
            .await
            .map_err(|e| format!("embed nodes: {e}"))?
    };
    let edge_embs = if edges.is_empty() {
        Vec::new()
    } else {
        model
            .embed_strings(edge_texts)
            .await
            .map_err(|e| format!("embed edges: {e}"))?
    };

    // Purge previous graph for this file (replace semantics)
    purge_graph_file(conn, file_id).await?;
    insert_graph_batch(conn, &nodes, &node_embs, &edges, &edge_embs).await?;
    Ok((nodes.len(), edges.len()))
}

async fn purge_graph_file(conn: &libsql::Connection, file_id: &str) -> Result<(), String> {
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

#[cfg(feature = "office")]
async fn extract_text_for_graph(user_id: &str, file_id: &str, ext: &str) -> Result<Option<String>, String> {
    match ext {
        "pdf" => crate::logic::office::pdf::pdf_extract_text(user_id, file_id, None)
            .await
            .map(Some)
            .map_err(|e| format!("pdf: {e}")),
        "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" => {
            crate::logic::office::read_document(user_id, file_id).await.map(Some).map_err(|e| format!("ooxml: {e}"))
        }
        "html" | "md" => crate::logic::office::read_document(user_id, file_id).await.map(Some).map_err(|e| format!("read: {e}")),
        "png" | "jpg" | "jpeg" | "gif" | "webp" => {
            // Image → description via ragloader not available here; skip
            Ok(None)
        }
        _ => Ok(None),
    }
}

// ── search ──────────────────────────────────────────────────────────────────

/// GraphRAG search — all arms run natively in libSQL, fusion in Rust.
/// `mode`: Naive/Local/Global/Hybrid/Mix. Hybrid is default.
pub async fn graph_search(
    user_id: String,
    query: String,
    mode: Option<GraphSearchMode>,
    limit: Option<usize>,
) -> Result<Vec<GraphHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mode = mode.unwrap_or_default();
    let k = limit.unwrap_or(8).clamp(1, 20);
    let conn = crate::logic::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    // Ensure schema exists (no-op if done). Use embedder dim for new DBs.
    let dims = kawai_embedding::build_providers_from_env().dimension();
    // Best-effort: ignore if tables already exist with different dims
    let _ = ensure_graph_schema(&conn, dims).await;

    let use_naive = matches!(mode, GraphSearchMode::Naive | GraphSearchMode::Hybrid | GraphSearchMode::Mix);
    let use_local = matches!(mode, GraphSearchMode::Local | GraphSearchMode::Hybrid | GraphSearchMode::Mix);
    let use_global = matches!(mode, GraphSearchMode::Global | GraphSearchMode::Hybrid | GraphSearchMode::Mix);

    // Single embed for naive + global (share query vector)
    let query_vec: Option<Vec<f64>> = if use_naive || use_global {
        let model = kawai_embedding::build_providers_from_env();
        let vs = model.embed_strings(vec![query.clone()]).await.map_err(|e| format!("embed query: {e}"))?;
        vs.into_iter().next()
    } else {
        None
    };

    // Run arms in parallel via tokio::join!
    let naive_fut = async {
        if use_naive {
            if let Some(ref qv) = query_vec {
                vector_search_nodes(&conn, qv, k).await.unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };
    let local_fut = async {
        if use_local {
            local_traversal(&conn, &query, k).await.unwrap_or_default()
        } else {
            Vec::new()
        }
    };
    let global_fut = async {
        if use_global {
            if let Some(ref qv) = query_vec {
                let edge_hits = vector_search_edges(&conn, qv, k).await.unwrap_or_default();
                // Expand to community nodes for richer context
                let mut out = edge_hits.clone();
                if let Ok(comm) = global_community_hits(&conn, &edge_hits, k).await {
                    out.extend(comm);
                }
                out.truncate(k * 2);
                out
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        }
    };

    let (naive, local, global) = tokio::join!(naive_fut, local_fut, global_fut);

    let hits = match mode {
        GraphSearchMode::Naive => naive,
        GraphSearchMode::Local => local,
        GraphSearchMode::Global => global,
        GraphSearchMode::Hybrid => rrf_fuse_graph(vec![(naive, 1.0), (local, 1.0), (global, 1.0)], k),
        GraphSearchMode::Mix => rrf_fuse_graph(vec![(naive, 0.2), (local, 0.5), (global, 0.3)], k),
    };
    Ok(hits.into_iter().take(k).collect())
}

pub async fn graph_list(
    user_id: &str,
    limit: Option<usize>,
) -> Result<(Vec<GraphHit>, Vec<GraphHit>), String> {
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    let lim = limit.unwrap_or(50).clamp(1, 200) as i64;
    let mut nodes = Vec::new();
    let mut rows = conn
        .query(
            "SELECT title, content, file_id, community_id FROM graph_nodes LIMIT ?",
            vec![lim],
        )
        .await
        .map_err(|e| format!("graph list nodes: {e}"))?;
    while let Some(row) = rows.next().await.map_err(|e| format!("graph list: {e}"))? {
        let title: String = row.get(0).map_err(|e| format!("{e}"))?;
        let content: String = row.get(1).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(2).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(3).map_err(|e| format!("{e}"))?;
        nodes.push(GraphHit { title, content, file_id, locator: format!("community {cid}"), arm: "store".into(), community_id: Some(cid), score: None });
    }
    let mut edges = Vec::new();
    let mut rows = conn
        .query(
            "SELECT from_node, to_node, description, file_id, community_id FROM graph_edges LIMIT ?",
            vec![lim],
        )
        .await
        .map_err(|e| format!("graph list edges: {e}"))?;
    while let Some(row) = rows.next().await.map_err(|e| format!("graph list: {e}"))? {
        let from: String = row.get(0).map_err(|e| format!("{e}"))?;
        let to: String = row.get(1).map_err(|e| format!("{e}"))?;
        let desc: String = row.get(2).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(3).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(4).map_err(|e| format!("{e}"))?;
        edges.push(GraphHit { title: format!("{from} -> {to}"), content: desc, file_id, locator: format!("community {cid}"), arm: "store".into(), community_id: Some(cid), score: None });
    }
    Ok((nodes, edges))
}

pub async fn graph_forget(user_id: &str, file_ids: Vec<String>) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    for fid in &file_ids {
        purge_graph_file(&conn, fid).await?;
        conn.execute("DELETE FROM graph_files WHERE file_id = ?", vec![fid.clone()])
            .await
            .map_err(|e| format!("graph_forget: {e}"))?;
    }
    Ok(file_ids.len())
}

pub async fn graph_stats(user_id: &str) -> Result<GraphStats, String> {
    let conn = crate::logic::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    async fn count(conn: &libsql::Connection, sql: &str) -> i64 {
        let mut rows = match conn.query(sql, ()).await {
            Ok(r) => r,
            Err(_) => return 0,
        };
        match rows.next().await {
            Ok(Some(row)) => row.get::<i64>(0).unwrap_or(0),
            _ => 0,
        }
    }
    let nodes = count(&conn, "SELECT COUNT(*) FROM graph_nodes").await;
    let edges = count(&conn, "SELECT COUNT(*) FROM graph_edges").await;
    let files = count(&conn, "SELECT COUNT(*) FROM graph_files").await;
    let comms = count(&conn, "SELECT COUNT(DISTINCT community_id) FROM graph_nodes").await;
    Ok(GraphStats { nodes, edges, communities: comms, files })
}

// ── toolset for agent ───────────────────────────────────────────────────────

#[derive(Debug)]
pub struct GraphToolError(pub String);
impl std::fmt::Display for GraphToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for GraphToolError {}

pub fn toolset(user_id: &str) -> kawai_tools::ToolSet {
    let mut set = kawai_tools::ToolSet::default();
    set.add_tool(GraphSearchTool(user_id.to_string()));
    set.add_tool(GraphListTool(user_id.to_string()));
    set
}

/// Extend an existing ToolSet with graph tools (for agent.rs).
pub fn extend_toolset(set: &mut kawai_tools::ToolSet, user_id: &str) {
    set.add_tool(GraphSearchTool(user_id.to_string()));
    set.add_tool(GraphListTool(user_id.to_string()));
}

#[derive(Clone)]
struct GraphSearchTool(String);
#[derive(Clone)]
struct GraphListTool(String);

#[derive(serde::Deserialize)]
struct GraphSearchArgs {
    query: String,
    mode: Option<String>,
    limit: Option<usize>,
}

#[derive(serde::Deserialize)]
struct GraphListArgs {
    limit: Option<usize>,
}

impl kawai_tools::AgentTool for GraphSearchTool {
    const NAME: &'static str = "graph_search";
    type Args = GraphSearchArgs;
    type Output = String;
    type Error = GraphToolError;

    fn description(&self) -> String {
        "GraphRAG search over the knowledge graph (Naive/Local/Global/Hybrid/Mix). Use for entity-relationship queries, multi-hop reasoning. Args: {query: string, mode?: 'naive'|'local'|'global'|'hybrid'|'mix', limit?: number}".into()
    }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Entity or question"},
                "mode": {"type": "string", "enum": ["naive","local","global","hybrid","mix"], "default": "hybrid"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20, "default": 8}
            },
            "required": ["query"]
        })
    }
    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let mode = match args.mode.as_deref().unwrap_or("hybrid") {
            "naive" => GraphSearchMode::Naive,
            "local" => GraphSearchMode::Local,
            "global" => GraphSearchMode::Global,
            "mix" => GraphSearchMode::Mix,
            _ => GraphSearchMode::Hybrid,
        };
        let hits = graph_search(self.0.clone(), args.query, Some(mode), args.limit)
            .await
            .map_err(GraphToolError)?;
        serde_json::to_string(&hits).map_err(|e| GraphToolError(e.to_string()))
    }
}

impl kawai_tools::AgentTool for GraphListTool {
    const NAME: &'static str = "graph_list";
    type Args = GraphListArgs;
    type Output = String;
    type Error = GraphToolError;

    fn description(&self) -> String {
        "List knowledge-graph nodes and edges (for debugging). Args: {limit?: number}".into()
    }
    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}},
        })
    }
    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        let (nodes, edges) = graph_list(&self.0, args.limit).await.map_err(GraphToolError)?;
        serde_json::to_string(&serde_json::json!({"nodes": nodes, "edges": edges})).map_err(|e| GraphToolError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_entities_basic() {
        let ents = extract_entities("Alice manages Bob in Jakarta office. Alice met Charlie.");
        assert!(ents.contains(&"Alice".to_string()));
        assert!(ents.contains(&"Bob".to_string()));
        assert!(ents.contains(&"Jakarta".to_string()));
    }

    #[test]
    fn community_is_stable() {
        assert_eq!(community_of("Alice"), community_of("Alice"));
        assert!(community_of("Alice") < DEFAULT_COMMUNITIES);
    }

    #[tokio::test]
    async fn graph_index_and_search_e2e() {
        let dir = tempfile::tempdir().unwrap();
        crate::logic::db::set_data_root(dir.path());
        let user = "graph-e2e-user";
        let text = "Alice is manager of Bob. Bob works with Charlie in Jakarta. Charlie reports to Alice.";
        let (n, e) = graph_index_text(user, "file1", text).await.unwrap();
        assert!(n >= 3, "nodes {n}");
        assert!(e >= 2, "edges {e}");
        let hits = graph_search(user.to_string(), "Alice".to_string(), Some(GraphSearchMode::Local), Some(5)).await.unwrap();
        assert!(!hits.is_empty(), "local should find Alice neighborhood");
        let hits2 = graph_search(user.to_string(), "manager".to_string(), Some(GraphSearchMode::Naive), Some(5)).await.unwrap();
        assert!(!hits2.is_empty(), "naive vector should hit");
        let hits3 = graph_search(user.to_string(), "Alice Bob".to_string(), Some(GraphSearchMode::Mix), Some(5)).await.unwrap();
        assert!(!hits3.is_empty(), "mix should fuse");
    }
}
