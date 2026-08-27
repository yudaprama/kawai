//! GraphRAG agent toolset, list/forget/stats ops, and the tool struct implementations.

use super::types::GraphHit;
use crate::logic::db;

pub use super::types::GraphStats;

// ── public API ──────────────────────────────────────────────────────────────

pub async fn graph_list(
    user_id: &str,
    limit: Option<usize>,
) -> Result<(Vec<GraphHit>, Vec<GraphHit>), String> {
    let conn = db::db_connection(user_id)
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
        nodes.push(GraphHit {
            title,
            content,
            file_id,
            locator: format!("community {cid}"),
            arm: "store".into(),
            community_id: Some(cid),
            score: None,
        });
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
        edges.push(GraphHit {
            title: format!("{from} -> {to}"),
            content: desc,
            file_id,
            locator: format!("community {cid}"),
            arm: "store".into(),
            community_id: Some(cid),
            score: None,
        });
    }
    Ok((nodes, edges))
}

pub async fn graph_forget(user_id: &str, file_ids: Vec<String>) -> Result<usize, String> {
    if file_ids.is_empty() {
        return Ok(0);
    }
    let conn = db::db_connection(user_id)
        .await
        .map_err(|e| format!("db: {e}"))?;
    for fid in &file_ids {
        super::schema::purge_graph_file(&conn, fid).await?;
        conn.execute(
            "DELETE FROM graph_files WHERE file_id = ?",
            vec![fid.clone()],
        )
        .await
        .map_err(|e| format!("graph_forget: {e}"))?;
    }
    Ok(file_ids.len())
}

pub async fn graph_stats(user_id: &str) -> Result<GraphStats, String> {
    let conn = db::db_connection(user_id)
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
    let comms = count(
        &conn,
        "SELECT COUNT(DISTINCT community_id) FROM graph_nodes",
    )
    .await;
    Ok(GraphStats {
        nodes,
        edges,
        communities: comms,
        files,
    })
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
            "naive" => super::types::GraphSearchMode::Naive,
            "local" => super::types::GraphSearchMode::Local,
            "global" => super::types::GraphSearchMode::Global,
            "mix" => super::types::GraphSearchMode::Mix,
            _ => super::types::GraphSearchMode::Hybrid,
        };
        let hits = super::search::graph_search(self.0.clone(), args.query, Some(mode), args.limit)
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
        let (nodes, edges) = graph_list(&self.0, args.limit)
            .await
            .map_err(GraphToolError)?;
        serde_json::to_string(&serde_json::json!({"nodes": nodes, "edges": edges}))
            .map_err(|e| GraphToolError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::{community_of, extract_entities, DEFAULT_COMMUNITIES};

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
        use super::super::ingest::graph_index_text;
        use super::super::search::graph_search;
        use super::super::types::GraphSearchMode;

        let dir = tempfile::tempdir().unwrap();
        crate::logic::db::set_data_root(dir.path());
        let user = "graph-e2e-user";
        let text =
            "Alice is manager of Bob. Bob works with Charlie in Jakarta. Charlie reports to Alice.";
        let (n, e) = graph_index_text(user, "file1", text).await.unwrap();
        assert!(n >= 3, "nodes {n}");
        assert!(e >= 2, "edges {e}");
        let hits = graph_search(
            user.to_string(),
            "Alice".to_string(),
            Some(GraphSearchMode::Local),
            Some(5),
        )
        .await
        .unwrap();
        assert!(!hits.is_empty(), "local should find Alice neighborhood");
        let hits2 = graph_search(
            user.to_string(),
            "manager".to_string(),
            Some(GraphSearchMode::Naive),
            Some(5),
        )
        .await
        .unwrap();
        assert!(!hits2.is_empty(), "naive vector should hit");
        let hits3 = graph_search(
            user.to_string(),
            "Alice Bob".to_string(),
            Some(GraphSearchMode::Mix),
            Some(5),
        )
        .await
        .unwrap();
        assert!(!hits3.is_empty(), "mix should fuse");
    }
}
