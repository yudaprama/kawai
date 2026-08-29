//! Shared types and constants for the knowledge (RAG) subsystem.

use serde::{Deserialize, Serialize};

/// Default chunk size in characters for the markdown-aware splitter.
pub(crate) const CHUNK_CHARS: usize = 1500;

/// Overlap between consecutive chunks (characters).
pub(crate) const CHUNK_OVERLAP: usize = 200;

/// Reciprocal Rank Fusion smoothing constant (the standard k = 60).
pub(crate) const RRF_K: f64 = 60.0;

/// An `indexing` row older than this is a crashed/interrupted run (the app
/// died mid-index) — surfaced as `failed` instead of spinning forever.
pub(crate) const STALE_INDEXING_SECS: i64 = 15 * 60;

pub(crate) fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A single embedded chunk of an indexed office document.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RagChunk {
    pub id: String,
    pub content: String,
    pub file_id: String,
    pub source: String,
    pub locator: String,
}

/// A retrieved chunk with its provenance, for citation in the UI/LLM context.
/// `file_id` lets the model act on a hit directly (e.g. office_read_document)
/// without a name→id lookup round-trip.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHit {
    pub source: String,
    pub locator: String,
    pub content: String,
    pub file_id: String,
}

/// Retrieval strategy for [`super::search::knowledge_search`]. Deserialized from the
/// model/RPC-supplied string; unknown values are rejected by serde (whitelist).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    /// Vector similarity fused with BM25 via RRF (the default).
    #[default]
    Hybrid,
    /// Vector similarity only — natural-language questions about concepts.
    Semantic,
    /// BM25 only — exact codes, names, numbers; skips the embedder entirely.
    Keyword,
}

/// Lifecycle of one file's RAG index, as shown by the knowledge panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    /// Never indexed (imported before RAG existed, or indexing never ran).
    NotIndexed,
    /// Extraction/chunking/embedding in progress.
    Indexing,
    /// Indexed (possibly with zero chunks — empty/unextractable documents).
    Ready,
    /// The last indexing attempt failed (`error` carries the cause).
    Failed,
}

/// One knowledge-panel row: office store metadata + index state + whether the
/// active session can search this file.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFileInfo {
    pub id: String,
    pub original_name: String,
    pub ext: String,
    pub bytes: u64,
    pub created_at: i64,
    pub status: IndexStatus,
    pub chunks: i64,
    pub error: Option<String>,
    pub in_session: bool,
    /// Full plain text (vision description or document text) — for the Assets
    /// panel to show without re-reading the file. `None` when not indexed.
    pub raw: Option<String>,
}

/// A single heading found by scanning markdown text, with its char offset.
pub(crate) struct Heading {
    pub char_offset: usize,
    pub text: String,
}
