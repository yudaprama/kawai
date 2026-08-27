//! Knowledge subsystem: RAG ingestion, retrieval, GraphRAG, session-scoped file management.
//!
//! # Module structure
//!
//! ```text
//! knowledge/
//! types.rs    — RagChunk, RagHit, IndexStatus, KnowledgeFileInfo, SearchMode
//! schema.rs   — libSQL DDL (vector tables, FTS5 mirror), insert/search helpers
//! search.rs   — vector_search, bm25_search, RRF fusion, knowledge_search
//! ingest.rs   — chunking (MarkdownSplitter), text extraction, indexing pipeline
//! session.rs  — file association, knowledge panel list, management ops
//! graph/      — GraphRAG (feature "graph"): Naive/Local/Global/Hybrid/Mix
//!   ├── types.rs, schema.rs, search.rs, ingest.rs, tools.rs
//! ```
//!
//! # Backward compatibility
//!
//! This module is re-exported through `logic::rag` so all existing call sites
//! (`logic::rag::knowledge_search`, `logic::rag::RagHit`, etc.) continue to
//! work unchanged. GraphRAG is re-exported through `logic::graph`.

#[cfg(feature = "office")]
pub mod types;
#[cfg(feature = "office")]
pub mod schema;
#[cfg(feature = "office")]
pub mod search;
#[cfg(feature = "office")]
pub mod ingest;
#[cfg(feature = "office")]
pub mod session;

#[cfg(feature = "graph")]
pub mod graph;

// Re-export the public API so `logic::rag::*` call sites stay valid.
#[cfg(feature = "office")]
pub use types::*;
#[cfg(feature = "office")]
pub use schema::session_file_ids;
#[cfg(feature = "office")]
pub use search::knowledge_search;
#[cfg(feature = "office")]
pub use ingest::office_index_file;
#[cfg(feature = "office")]
pub use session::*;
