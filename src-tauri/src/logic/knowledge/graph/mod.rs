//! GraphRAG — libSQL-native knowledge graph (feature-gated `graph`).
//!
//! Module structure:
//!
//! ```text
//! graph/
//! ├── types.rs    — GraphHit, GraphSearchMode, GraphStats, pure helpers
//! ├── schema.rs   — graph DDL, file status, purge, batch insert
//! ├── search.rs   — vector/CTE/community arms, RRF fusion, graph_search
//! ├── ingest.rs   — entity extraction, chunking, graph indexing pipeline
//! └── tools.rs    — agent toolset, graph_list, graph_forget, graph_stats
//! ```

pub mod types;
pub mod schema;
pub mod search;
pub mod ingest;
pub mod tools;

// Re-export the public API so `logic::graph::*` call sites remain valid.
pub use types::*;
pub use search::graph_search;
pub use ingest::{graph_index_file, graph_index_text};
pub use tools::*;
