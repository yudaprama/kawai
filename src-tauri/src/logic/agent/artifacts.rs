#[cfg(feature = "litert")]
use serde_json::Value;

#[cfg(feature = "litert")]
use crate::logic::db;
#[cfg(feature = "litert")]
use super::constants::*;
#[cfg(feature = "litert")]
use super::parsing::truncate_chars;

/// One "--- tool ---" block of the cloud-materials package.
#[cfg(feature = "litert")]
pub fn artifact_block(a: &TurnArtifact) -> String {
    format!("--- {} ---\n{}", a.tool, a.content)
}

/// Distinct lowercase terms (≥3 alphanumeric chars) from the user's message —
/// the relevance signal for materials packing. Order-preserving and capped;
/// pure heuristic on purpose.
#[cfg(feature = "litert")]
pub fn focus_terms(message: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for term in message.to_lowercase().split(|c: char| !c.is_alphanumeric()) {
        if term.chars().count() >= 3 && !out.iter().any(|t| t == term) {
            out.push(term.to_string());
            if out.len() >= 32 {
                break;
            }
        }
    }
    out
}

/// Relevance score of one artifact for the package: distinct focus-term hits
/// dominate, recency breaks ties (later entries carry more of the turn's
/// conclusion). Deterministic — same log + message ⇒ same package.
#[cfg(feature = "litert")]
pub fn relevance_score(a: &TurnArtifact, terms: &[String], idx: usize) -> usize {
    if terms.is_empty() {
        return idx;
    }
    let body = a.content.to_lowercase();
    let tool = a.tool.to_lowercase();
    let hits = terms
        .iter()
        .filter(|t| body.contains(t.as_str()) || tool.contains(t.as_str()))
        .count();
    hits * 8 + idx
}

/// Extra persona rule for agents carrying the deep_write subagent: tells the
/// local model WHEN to delegate (the core quality lever of the hybrid tier).
#[cfg(feature = "litert")]
pub const DEEP_WRITE_RULE: &str = "- Long, analytical, comparative or creative answers (reports, comparisons, drafts, syntheses across sources) MUST be delegated to the deep_write tool: task = the complete brief (audience, structure, focus). materials = a ONE-LINE pointer naming what to use (e.g. \"the video transcript read this turn\") or omit it — the system AUTOMATICALLY attaches the full tool results you gathered this turn. NEVER paste excerpts, documents, or long text into materials (slow and error-prone). The deep_write result is streamed to the user as your final answer. Short factual replies you write yourself — do NOT delegate those.";

/// Extra persona rule for the office agent: document creation with real
/// content goes through the draft_document subagent, which composes the
/// document in the cloud and writes the file itself. `office_create_document`
/// is only for exact-content files (the user supplied the literal text).
#[cfg(all(feature = "litert", feature = "office"))]
pub const DRAFT_DOCUMENT_RULE: &str = "- Document-content rule (STRICT): when the document's content must be WRITTEN or COMPOSED (the user describes what it should contain or say — reports, proposals, summaries, updates from their files), you MUST call draft_document. Do NOT compose document content yourself and do NOT pass your own made-up content to office_create_document — that tool is ONLY for files whose exact text the user already gave you (transcribe verbatim, e.g. 'a docx containing exactly these lines'). If you are writing ANY of the document's body yourself, that is a draft_document turn. EXCEPTION: presentation DECKS — author those locally with office_create_deck (never draft_document).";

// ── Turn memory: the turn's process log ─────────────────────────────────────
//
// Every completed process this user message (plain tool result, recall page,
// subagent receipt) appends one entry. The log lives only for the duration of
// the `agent_chat` stream — dropped when the turn ends, never persisted. It
// serves three consumers: the cloud-subagent `materials` package (rendered on
// demand via `materials()`), the chain digest fed back on budget exhaustion,
// and `artifact_recall` paging for oversized bodies.

/// Canonical serialization of tool-call args for turn-memory dedup keys.
/// Object keys are sorted RECURSIVELY — required because `schemars` (via
/// rig) enables serde_json's `preserve_order`, making `Value::to_string()`
/// keep the model's insertion order: the same semantic call written with a
/// different key order would otherwise dedup-fail. Whitespace never
/// survives parsing, so only key order needs normalizing here. Numeric-form
/// differences (`5` vs `5.0`) remain distinct keys — acceptable: one model,
/// one phrasing per turn.
#[cfg(feature = "litert")]
pub fn canonical_args_key(value: &Value) -> String {
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    write(&map[*k], out);
                }
                out.push('}');
            }
            Value::Array(arr) => {
                out.push('[');
                for (i, item) in arr.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut s = String::new();
    write(value, &mut s);
    s
}

/// One stored process result. `content` is the tool's verbatim output body,
/// already capped at `TOOL_RESULT_ENTRY_MAX_CHARS`.
#[cfg(feature = "litert")]
#[derive(Clone)]
pub struct TurnArtifact {
    pub handle: String,
    pub tool: String,
    /// Canonical (tool, resolved-args) string — exact-match dedup key.
    pub args_key: String,
    pub content: String,
}

/// Session-scoped append-only log of completed processes. Restored from the
/// per-session SQLite table at stream start, so handles stay valid across
/// turns and restarts; new records flush back to the DB as they are made.
/// Touched only inside the single `agent_chat` stream — no locking needed.
#[cfg(feature = "litert")]
#[derive(Default)]
pub struct TurnMemory {
    pub artifacts: Vec<TurnArtifact>,
    /// Artifacts already flushed to the DB this stream (`take_unpersisted`
    /// advances it).
    pub persisted: usize,
}

#[cfg(feature = "litert")]
impl TurnMemory {
    /// Seed the log with prior turns' stored results so recall handles keep
    /// working after an epoch break; numbering continues from here.
    pub fn restore(&mut self, prior: Vec<TurnArtifact>) {
        self.persisted = prior.len();
        self.artifacts = prior;
    }

    /// Clone out the artifacts recorded since the last flush and advance the
    /// cursor — the caller persists them to the session's DB rows.
    pub fn take_unpersisted(&mut self) -> Vec<TurnArtifact> {
        let fresh = self.artifacts[self.persisted.min(self.artifacts.len())..].to_vec();
        self.persisted = self.artifacts.len();
        fresh
    }

    /// One-line inventory of stored results for the replayed transcript: the
    /// model learns WHICH handles exist across epoch breaks even though the
    /// bodies do not replay. Oldest-first, capped.
    pub fn evidence_digest(&self) -> String {
        if self.artifacts.is_empty() {
            return String::new();
        }
        const MAX_ITEMS: usize = 24;
        let mut parts: Vec<String> = self
            .artifacts
            .iter()
            .take(MAX_ITEMS)
            .map(|a| {
                format!(
                    "{} {} {} chars",
                    a.handle,
                    a.tool,
                    a.content.chars().count()
                )
            })
            .collect();
        if self.artifacts.len() > MAX_ITEMS {
            parts.push(format!("… {} more", self.artifacts.len() - MAX_ITEMS));
        }
        format!(
            "[Stored tool results from this session's earlier work — call \
             artifact_recall to read any of them: {}]",
            parts.join("; ")
        )
    }

    /// Append one completed process. A repeat of the same tool + resolved args
    /// returns the existing handle — the log grows per DISTINCT step, never
    /// per repeat. Returns the handle ("mem1", "mem2", … sequential).
    pub fn record(&mut self, tool: &str, args_key: &str, content: String) -> String {
        if let Some(existing) = self
            .artifacts
            .iter()
            .find(|a| a.tool == tool && a.args_key == args_key)
        {
            return existing.handle.clone();
        }
        let handle = format!("mem{}", self.artifacts.len() + 1);
        self.artifacts.push(TurnArtifact {
            handle: handle.clone(),
            tool: tool.to_string(),
            args_key: args_key.to_string(),
            content: truncate_chars(&content, TOOL_RESULT_ENTRY_MAX_CHARS),
        });
        handle
    }

    /// The whole chain as a compact block (valid handles + chars + tool) —
    /// fed on budget exhaustion so the model closes the turn knowing what it
    /// already gathered.
    pub fn chain_digest(&self) -> String {
        self.artifacts
            .iter()
            .map(|a| {
                format!(
                    "{} {} {} chars",
                    a.handle,
                    a.tool,
                    a.content.chars().count()
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Paged slice for `artifact_recall`: (page_text, next_offset). `None`
    /// next_offset = no more content. Err carries a teaching message (valid
    /// handles / valid range) — errors are prompts, not failures.
    pub fn page(&self, handle: &str, offset: usize) -> Result<(String, Option<usize>), String> {
        let Some(a) = self
            .artifacts
            .iter()
            .find(|a| a.handle.eq_ignore_ascii_case(handle))
        else {
            let valid = self
                .artifacts
                .iter()
                .map(|a| format!("{} ({} chars)", a.handle, a.content.chars().count()))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "unknown handle {handle:?}. Valid handles this turn: {}",
                if valid.is_empty() {
                    "none — no tool output is stored".to_string()
                } else {
                    valid
                }
            ));
        };
        let total = a.content.chars().count();
        if offset >= total {
            return Err(format!(
                "offset {offset} is past the end of {} ({} chars). Valid range: 0..{}",
                a.handle,
                total,
                total.saturating_sub(1)
            ));
        }
        let page: String = a
            .content
            .chars()
            .skip(offset)
            .take(ARTIFACT_PAGE_CHARS)
            .collect();
        let served = page.chars().count();
        let next = if offset + served < total {
            Some(offset + served)
        } else {
            None
        };
        Ok((page, next))
    }

    /// The cloud-materials package: whole "--- tool ---" blocks joined in turn
    /// order under `budget` (per-provider — see `RemoteLlm::materials_budget`).
    /// Selection is RELEVANCE-ranked — distinct terms from the user's message
    /// dominate, recency breaks ties — but rendering stays chronological, so a
    /// giant early read can no longer crowd out a small decisive one. Blocks
    /// ship WHOLE; artifacts that do not fit are omitted EXPLICITLY via a
    /// trailing note (handles + tools + sizes) — the writer must never receive
    /// a silently truncated package.
    pub fn materials(&self, focus: &str, budget: usize) -> String {
        let n = self.artifacts.len();
        if n == 0 {
            return String::new();
        }
        let terms = focus_terms(focus);
        let block_chars: Vec<usize> = self
            .artifacts
            .iter()
            .map(|a| artifact_block(a).chars().count())
            .collect();
        let mut ranked: Vec<usize> = (0..n).collect();
        ranked.sort_by_key(|&i| {
            std::cmp::Reverse((relevance_score(&self.artifacts[i], &terms, i), i))
        });
        // First-fit over the ranking; kept blocks stay WHOLE (no mid-body cut).
        let fits = |avail: usize| -> Vec<usize> {
            let mut used = 0usize;
            let mut sel = Vec::new();
            for &i in &ranked {
                let sep = if sel.is_empty() { 0 } else { 2 };
                if used + sep + block_chars[i] <= avail {
                    used += sep + block_chars[i];
                    sel.push(i);
                }
            }
            sel
        };
        let mut selected = fits(budget);
        if selected.len() < n {
            // Refit reserving room for the omission note so the final package
            // (note included) stays within budget.
            selected = fits(budget.saturating_sub(MATERIALS_NOTE_RESERVE));
        }
        // A single giant read can leave the selection empty — always ship at
        // least the top-ranked head block rather than an empty package; its
        // tail gets the standard ellipsis marker below.
        if selected.is_empty() {
            selected.push(ranked[0]);
        }
        selected.sort_unstable(); // chronological render

        let note = if selected.len() == n {
            None
        } else {
            let listed = self
                .artifacts
                .iter()
                .enumerate()
                .filter(|(i, _)| !selected.contains(i))
                .map(|(_, a)| {
                    format!(
                        "{} {} {} chars",
                        a.handle,
                        a.tool,
                        a.content.chars().count()
                    )
                })
                .collect::<Vec<_>>()
                .join("; ");
            Some(format!(
                "[MATERIALS NOTE: {} of {} stored results did not fit this package \
                 ({}-char cap). Omitted: {}. Ground the answer ONLY in the included \
                 results; do not imply coverage of the omitted ones.]",
                n - selected.len(),
                n,
                budget,
                listed,
            ))
        };
        let note_text = note.map(|m| format!("\n\n{m}")).unwrap_or_default();
        let avail = budget.saturating_sub(note_text.chars().count());
        let joined = selected
            .iter()
            .map(|&i| artifact_block(&self.artifacts[i]))
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut out = if joined.chars().count() > avail {
            truncate_chars(&joined, avail)
        } else {
            joined
        };
        out.push_str(&note_text);
        out
    }

    /// Resolve deep_write staging requests into "[ADDITIONAL SLICES …]" blocks
    /// of verbatim pages from this log. Invalid handles/offsets are skipped —
    /// the writer asked, we serve what exists; duplicates dedup on
    /// (handle, offset); bounded by STAGING_MAX_REQUESTS pages total.
    pub fn staging_slices(&self, reqs: &[(String, usize)]) -> String {
        let mut seen: std::collections::HashSet<(String, usize)> = Default::default();
        let mut blocks: Vec<String> = Vec::new();
        for (handle, offset) in reqs.iter().take(STAGING_MAX_REQUESTS) {
            if !seen.insert((handle.to_lowercase(), *offset)) {
                continue;
            }
            if let Ok((page_text, _)) = self.page(handle, *offset) {
                blocks.push(format!(
                    "--- requested slice {} @{} ---\n{}",
                    handle, offset, page_text
                ));
            }
            if blocks.len() >= STAGING_MAX_REQUESTS {
                break;
            }
        }
        if blocks.is_empty() {
            String::new()
        } else {
            format!(
                "[ADDITIONAL SLICES fetched at this writer's request]\n{}",
                blocks.join("\n\n")
            )
        }
    }

    /// Total stored content chars — the cloud-close trigger metric.
    pub fn total_content_chars(&self) -> usize {
        self.artifacts
            .iter()
            .map(|a| a.content.chars().count())
            .sum()
    }
}

/// Flush artifacts recorded since the last flush to the session's persistent
/// log (best-effort: a failed write only degrades those entries to
/// turn-scoped visibility; the turn never dies).
#[cfg(feature = "litert")]
pub async fn flush_new_artifacts(user_id: &str, sid: i64, memory: &mut TurnMemory) {
    for a in memory.take_unpersisted() {
        if let Err(e) = db::append_session_artifact(
            user_id,
            sid,
            &a.handle,
            &a.tool,
            &a.args_key,
            &a.content,
        )
        .await
        {
            eprintln!("[agent_chat] artifact persist {} failed: {e}", a.handle);
        }
    }
}
