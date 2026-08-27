//! GraphRAG search arms: naive vector, local CTE traversal, global community
//! expansion, RRF fusion, and the top-level [`graph_search`] orchestration.

use std::collections::{HashMap, HashSet};

use super::schema::ensure_graph_schema;
use super::types::{GraphHit, GraphSearchMode, RRF_K};
use crate::logic::db;

// ── naive arm: vector over nodes ────────────────────────────────────────────

pub(crate) async fn vector_search_nodes(
    conn: &libsql::Connection,
    query_vec: &[f64],
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let blob = libsql::Value::Blob(super::types::vec_to_le_bytes(query_vec));
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
    let mut rows = conn
        .query(sql, params)
        .await
        .map_err(|e| format!("graph vector nodes: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("graph vector nodes: {e}"))?
    {
        let _id: String = row.get(0).map_err(|e| format!("{e}"))?;
        let title: String = row.get(1).map_err(|e| format!("{e}"))?;
        let content: String = row.get(2).map_err(|e| format!("{e}"))?;
        let file_id: String = row.get(3).map_err(|e| format!("{e}"))?;
        let cid: i64 = row.get(4).map_err(|e| format!("{e}"))?;
        let score: f64 = row.get::<f64>(5).unwrap_or(0.0);
        out.push(GraphHit {
            title,
            content,
            file_id,
            locator: format!("community {cid}"),
            arm: "naive".into(),
            community_id: Some(cid),
            score: Some(score),
        });
    }
    Ok(out)
}

// ── global arm: vector over edges ───────────────────────────────────────────

pub(crate) async fn vector_search_edges(
    conn: &libsql::Connection,
    query_vec: &[f64],
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    if k == 0 {
        return Ok(Vec::new());
    }
    let blob = libsql::Value::Blob(super::types::vec_to_le_bytes(query_vec));
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
    let mut rows = conn
        .query(sql, params)
        .await
        .map_err(|e| format!("graph vector edges: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("graph vector edges: {e}"))?
    {
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

// ── local arm: Recursive CTE 1-2 hop ────────────────────────────────────────

pub(crate) async fn local_traversal(
    conn: &libsql::Connection,
    query: &str,
    k: usize,
) -> Result<Vec<GraphHit>, String> {
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
    let mut rows = conn
        .query(&sql, params)
        .await
        .map_err(|e| format!("local traversal: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("local traversal: {e}"))?
    {
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

// ── global arm: community expansion ─────────────────────────────────────────

pub(crate) async fn global_community_hits(
    conn: &libsql::Connection,
    edge_hits: &[GraphHit],
    k: usize,
) -> Result<Vec<GraphHit>, String> {
    if edge_hits.is_empty() {
        return Ok(Vec::new());
    }
    let cids: Vec<i64> = edge_hits
        .iter()
        .filter_map(|h| h.community_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if cids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; cids.len()].join(", ");
    let sql = format!(
        "SELECT title, content, file_id, community_id FROM graph_nodes WHERE community_id IN ({placeholders}) LIMIT ?"
    );
    let mut params: Vec<libsql::Value> = cids.into_iter().map(libsql::Value::Integer).collect();
    params.push(libsql::Value::Integer(k as i64));
    let mut rows = conn
        .query(&sql, params)
        .await
        .map_err(|e| format!("global community: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("global community: {e}"))?
    {
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

pub(crate) fn rrf_fuse_graph(
    arms: Vec<(Vec<GraphHit>, f64)>,
    limit: usize,
) -> Vec<GraphHit> {
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

// ── top-level search ─────────────────────────────────────────────────────────

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
    let conn = db::db_connection(&user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;

    // Ensure schema exists (no-op if done). Use embedder dim for new DBs.
    let dims = kawai_embedding::build_providers_from_env().dimension();
    let _ = ensure_graph_schema(&conn, dims).await;

    let use_naive = matches!(
        mode,
        GraphSearchMode::Naive | GraphSearchMode::Hybrid | GraphSearchMode::Mix
    );
    let use_local = matches!(
        mode,
        GraphSearchMode::Local | GraphSearchMode::Hybrid | GraphSearchMode::Mix
    );
    let use_global = matches!(
        mode,
        GraphSearchMode::Global | GraphSearchMode::Hybrid | GraphSearchMode::Mix
    );

    // Single embed for naive + global (share query vector)
    let query_vec: Option<Vec<f64>> = if use_naive || use_global {
        let model = kawai_embedding::build_providers_from_env();
        let vs = model
            .embed_strings(vec![query.clone()])
            .await
            .map_err(|e| format!("embed query: {e}"))?;
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
        GraphSearchMode::Hybrid => {
            rrf_fuse_graph(vec![(naive, 1.0), (local, 1.0), (global, 1.0)], k)
        }
        GraphSearchMode::Mix => rrf_fuse_graph(vec![(naive, 0.2), (local, 0.5), (global, 0.3)], k),
    };
    Ok(hits.into_iter().take(k).collect())
}
