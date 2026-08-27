//! Retrieval: vector similarity, BM25 lexical search, RRF fusion, and the
//! top-level [`knowledge_search`] orchestration.

use std::collections::HashMap;

use super::schema::{
    bm25_search, ensure_fts, fts_match_query, session_file_ids, vector_search_top_k,
};
use super::types::{RagChunk, RagHit, SearchMode, RRF_K};
use crate::logic::db;

/// Reciprocal Rank Fusion of the vector and lexical rankings (1-based ranks):
/// score(d) = Σ 1/(RRF_K + rank_d). Chunks found by both sides outrank
/// single-side hits; ties break by chunk id for determinism.
pub(crate) fn rrf_fuse(
    vector: Vec<RagChunk>,
    lexical: Vec<RagChunk>,
    limit: usize,
) -> Vec<RagChunk> {
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

    let conn = db::db_connection(&user_id)
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
        let query_vec = model
            .embed_strings(vec![query.clone()])
            .await
            .map_err(|e| format!("embed query: {e}"))?;
        let query_vec = query_vec
            .into_iter()
            .next()
            .ok_or_else(|| "embed query: empty response".to_string())?;
        vector_search_top_k(&conn, &query_vec, &candidates, K as usize)
            .await?
            .into_iter()
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
            file_id: doc.file_id,
        })
        .collect())
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
    fn rrf_fuse_rewards_dual_side_hits() {
        let out = rrf_fuse(
            vec![chunk("a"), chunk("b")],
            vec![chunk("c"), chunk("a")],
            2,
        );
        assert_eq!(out[0].id, "a");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn rrf_fuse_respects_limit_and_empty_sides() {
        let out = rrf_fuse(Vec::new(), vec![chunk("x"), chunk("y")], 1);
        assert_eq!(out.len(), 1);
        assert!(rrf_fuse(Vec::new(), Vec::new(), 8).is_empty());
    }
}
