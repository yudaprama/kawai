//! GraphRAG ingestion: entity extraction, chunking, and the index pipeline.

use std::collections::{HashMap, HashSet};

use text_splitter::{ChunkConfig, MarkdownSplitter};

use super::schema::{ensure_graph_schema, insert_graph_batch, purge_graph_file, set_graph_file_status};
use super::types::{community_of, extract_entities, CHUNK_CHARS, CHUNK_OVERLAP};
use crate::logic::db;

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

/// Extract full text from a stored office file for graph indexing.
#[cfg(feature = "office")]
pub(crate) async fn extract_text_for_graph(
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
        "html" | "md" => crate::logic::office::read_document(user_id, file_id)
            .await
            .map(Some)
            .map_err(|e| format!("read: {e}")),
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Ok(None),
        _ => Ok(None),
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

    let mut node_map: HashMap<String, String> = HashMap::new();
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
        // Fully connect small chunk's entities (clique) for richer local traversal
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
            let id = format!(
                "{file_id}#edge#{}__{}",
                a.replace(' ', "_"),
                b.replace(' ', "_")
            );
            let desc = format!("{a} relates to {b}");
            (id, a, b, desc, file_id.to_string(), cid)
        })
        .collect();

    let node_texts: Vec<String> = nodes
        .iter()
        .map(|(_, t, c, _, _)| format!("{t}: {c}"))
        .collect();
    let edge_texts: Vec<String> = edges
        .iter()
        .map(|(_, f, t, d, _, _)| format!("{f} -> {t}: {d}"))
        .collect();

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

    purge_graph_file(conn, file_id).await?;
    insert_graph_batch(conn, &nodes, &node_embs, &edges, &edge_embs).await?;
    Ok((nodes.len(), edges.len()))
}

/// Index one office file into the graph (entities + 1-hop edges). Fire-and-
/// forget from the UI, like `rag::office_index_file`. Returns (nodes, edges).
pub async fn graph_index_file(user_id: String, file_id: String) -> Result<(usize, usize), String> {
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
        let conn = db::db_connection(&user_id)
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
    let conn = db::db_connection(user_id)
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
