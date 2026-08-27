//! Shared types, constants, and pure helpers for the GraphRAG subsystem.

use std::collections::HashSet;

use regex::Regex;
use serde::{Deserialize, Serialize};

pub(crate) const CHUNK_CHARS: usize = 1200;
pub(crate) const CHUNK_OVERLAP: usize = 150;
pub(crate) const RRF_K: f64 = 60.0;
pub(crate) const DEFAULT_COMMUNITIES: i64 = 8;

pub(crate) fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Serialize an embedding into the little-endian `f32` byte blob libSQL's
/// `vector(?)` / `vector_distance_cos` SQL functions expect.
pub(crate) fn vec_to_le_bytes(v: &[f64]) -> Vec<u8> {
    v.iter()
        .map(|x| *x as f32)
        .flat_map(f32::to_le_bytes)
        .collect()
}

/// Stable hash → community_id (no external Louvain dep).
pub(crate) fn community_of(title: &str) -> i64 {
    let mut h: u64 = 1469598103934665603;
    for b in title.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    (h % DEFAULT_COMMUNITIES as u64) as i64
}

/// Extract capitalized phrases as entity candidates. Filters noise words.
pub(crate) fn extract_entities(text: &str) -> Vec<String> {
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
