//! L1 memories — atomic long-term memory items (preference / rule / event /
//! fact / goal) distilled from conversations. Ungated CRUD over plain libsql
//! plus a cloud extraction pass (`memory_extract`): the hybrid-tier
//! `RemoteLlm` reads a session transcript and returns a JSON array of memory
//! candidates, which are deduped against existing titles and stored with
//! `source_session_id`. Offline (no vault) the extraction reports unavailable
//! — manual CRUD always works.

use serde::{Deserialize, Serialize};

use super::db::{self, db_connection, unix_now, DbError};

/// The Tencent-L1 taxonomy this tier stores. Unknown strings are refused at
/// creation so the UI's kind filter stays honest.
pub const MEMORY_KINDS: [&str; 5] = ["preference", "rule", "event", "fact", "goal"];

/// A stored memory item.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub source_session_id: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `mem-` + 12 base62 chars from the CSPRNG.
fn new_memory_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    let suffix: String = (0..12)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect();
    format!("mem-{suffix}")
}

fn valid_kind(kind: &str) -> Result<&str, DbError> {
    if MEMORY_KINDS.contains(&kind) {
        Ok(kind)
    } else {
        Err(DbError::Config(format!(
            "unknown memory kind “{kind}” (expected one of {MEMORY_KINDS:?})"
        )))
    }
}

/// Create a memory manually (`source_session_id` = None).
pub async fn memory_create(
    user_id: &str,
    kind: &str,
    title: &str,
    content: &str,
) -> Result<MemoryItem, DbError> {
    let kind = valid_kind(kind)?;
    let title = title.trim();
    if title.is_empty() {
        return Err(DbError::Config("memory title must not be empty".into()));
    }
    let conn = db_connection(user_id).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO memories (id, kind, title, content, source_session_id, created_at, updated_at) \
             VALUES (?, ?, ?, ?, NULL, ?, ?) \
             RETURNING id, kind, title, content, source_session_id, created_at, updated_at",
            (new_memory_id(), kind, title, content.trim(), now, now),
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| DbError::Config("insert returned no row".into()))?;
    Ok(memory_row(&row))
}

/// List all memories, newest-updated first.
pub async fn memory_list(user_id: &str) -> Result<Vec<MemoryItem>, DbError> {
    let conn = db_connection(user_id).await?;
    let mut rows = conn
        .query(
            "SELECT id, kind, title, content, source_session_id, created_at, updated_at \
             FROM memories ORDER BY updated_at DESC, id",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(memory_row(&row));
    }
    Ok(out)
}

/// Update a memory's kind/title/content (any subset). Returns the updated
/// item, or `None` for unknown ids.
pub async fn memory_update(
    user_id: &str,
    memory_id: &str,
    kind: Option<&str>,
    title: Option<&str>,
    content: Option<&str>,
) -> Result<Option<MemoryItem>, DbError> {
    if let Some(k) = kind {
        valid_kind(k)?;
    }
    if let Some(t) = title {
        if t.trim().is_empty() {
            return Err(DbError::Config("memory title must not be empty".into()));
        }
    }
    let conn = db_connection(user_id).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "UPDATE memories SET \
                kind = COALESCE(?, kind), \
                title = COALESCE(?, title), \
                content = COALESCE(?, content), \
                updated_at = ? \
             WHERE id = ? \
             RETURNING id, kind, title, content, source_session_id, created_at, updated_at",
            (
                kind,
                title.map(str::trim),
                content.map(str::trim),
                now,
                memory_id,
            ),
        )
        .await?;
    match rows.next().await? {
        Some(row) => Ok(Some(memory_row(&row))),
        None => Ok(None),
    }
}

/// Delete a memory. Returns whether a row was removed.
pub async fn memory_delete(user_id: &str, memory_id: &str) -> Result<bool, DbError> {
    let conn = db_connection(user_id).await?;
    let n = conn
        .execute("DELETE FROM memories WHERE id = ?", vec![memory_id])
        .await?;
    Ok(n > 0)
}

// ── agent injection ─────────────────────────────────────────────────────────
//
// Like skills: rides the persona in the opener (rebuilt per session/epoch),
// so a memory saved mid-session applies from the next session.

/// Per-memory entry cap (chars) in the prompt block.
const PROMPT_MEMORY_MAX_CHARS: usize = 800;
/// Total cap (chars) across the block — protects the on-device prefill
/// budget. Newest-updated win; the block notes the omission.
const PROMPT_MEMORY_TOTAL_MAX_CHARS: usize = 4_000;
/// How many memories enter the block at most (even short ones).
const PROMPT_MEMORY_MAX_ITEMS: usize = 24;

/// Render the user's L1 memories (newest-updated first) as a `<memories>`
/// prompt block appended to the agent persona; empty string when there are
/// none. DB failure degrades to an empty block.
pub async fn prompt_block(user_id: &str) -> String {
    let items = match memory_list(user_id).await {
        Ok(items) => items,
        Err(_) => return String::new(),
    };
    if items.is_empty() {
        return String::new();
    }

    let mut out = String::from(
        "<memories>\nDurable facts about the user, distilled from past conversations. Treat them as standing context — they apply until the user says otherwise.\n",
    );
    let mut total = 0usize;
    let mut included = 0usize;
    for m in items.iter().take(PROMPT_MEMORY_MAX_ITEMS) {
        let body = m.content.trim();
        let body = if body.chars().count() > PROMPT_MEMORY_MAX_CHARS {
            let mut cut: String = body.chars().take(PROMPT_MEMORY_MAX_CHARS).collect();
            cut.push_str("…");
            cut
        } else {
            body.to_string()
        };
        let entry = format!("- ({}) {}: {}\n", m.kind, m.title, body);
        total += entry.chars().count();
        if total > PROMPT_MEMORY_TOTAL_MAX_CHARS {
            break;
        }
        out.push_str(&entry);
        included += 1;
    }
    if included == 0 {
        return String::new();
    }
    if included < items.len().min(PROMPT_MEMORY_MAX_ITEMS) {
        out.push_str(&format!(
            "({} older memor{} omitted for space)\n",
            items.len() - included,
            if items.len() - included == 1 { "y" } else { "ies" }
        ));
    }
    out.push_str("</memories>");
    out
}

/// How much transcript (chars, tail-kept) the extractor may send.
const EXTRACT_TRANSCRIPT_CHARS: usize = 24_000;

/// Extract memories from one session's transcript via the cloud tier, dedup
/// against existing titles (case-insensitive), store with `source_session_id`.
/// Returns the newly stored items (possibly empty — nothing worth keeping).
/// Errors when the vault is empty (no remote provider) or the session is
/// unknown; a malformed model answer is an error too, not a silent zero.
pub async fn memory_extract(
    user_id: &str,
    session_id: i64,
) -> Result<Vec<MemoryItem>, DbError> {
    let remote = crate::logic::remote::RemoteLlm::from_env()
        .ok_or_else(|| DbError::Config("memory extraction needs a cloud provider — no vault key configured".into()))?;
    let messages = db::list_chat_messages(user_id, session_id).await?;
    if messages.is_empty() {
        return Ok(Vec::new());
    }
    let mut transcript = String::new();
    for m in &messages {
        let line = format!("[{}] {}\n", m.role, m.content);
        transcript.push_str(&line);
    }
    if transcript.chars().count() > EXTRACT_TRANSCRIPT_CHARS {
        transcript = transcript
            .chars()
            .rev()
            .take(EXTRACT_TRANSCRIPT_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }

    let system = "You extract long-term memories from a support conversation. \
                  Return ONLY a JSON array — no prose, no code fences. Each element: \
                  {\"kind\": \"preference|rule|event|fact|goal\", \"title\": \"...\", \"content\": \"...\"}. \
                  Capture durable facts about the user (preferences, standing rules, important events, \
                  facts, goals). Skip anything transient, session-specific, or trivial. Few, high-quality \
                  items beat many noisy ones — an empty array is a valid answer.";
    let task = "Extract the long-term memories from the transcript below.";

    let mut stream = remote
        .stream(system, task, &transcript)
        .await
        .map_err(|e| DbError::Config(format!("cloud tier: {e}")))?;
    let mut answer = String::new();
    use futures_util::StreamExt;
    while let Some(event) = stream.next().await {
        match event {
            Ok(crate::logic::remote::RemoteEvent::Token { text }) => answer.push_str(&text),
            Ok(_) => {}
            Err(e) => return Err(DbError::Config(format!("cloud tier: {e}"))),
        }
    }

    let candidates = parse_candidates(&answer)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Dedup against existing titles (case-insensitive) and each other.
    let existing = memory_list(user_id).await?;
    let mut seen: Vec<String> = existing.iter().map(|m| m.title.to_lowercase()).collect();
    let conn = db_connection(user_id).await?;
    let now = unix_now() as i64;
    let mut stored = Vec::new();
    for c in candidates {
        let title = c.title.trim();
        if title.is_empty() {
            continue;
        }
        let key = title.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let kind = if MEMORY_KINDS.contains(&c.kind.as_str()) {
            c.kind.as_str()
        } else {
            "fact"
        };
        let mut rows = conn
            .query(
                "INSERT INTO memories (id, kind, title, content, source_session_id, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?) \
                 RETURNING id, kind, title, content, source_session_id, created_at, updated_at",
                (
                    new_memory_id(),
                    kind,
                    title,
                    c.content.trim(),
                    session_id,
                    now,
                    now,
                ),
            )
            .await?;
        if let Some(row) = rows.next().await? {
            stored.push(memory_row(&row));
        }
    }
    Ok(stored)
}

/// One extraction candidate as returned by the model.
#[derive(Debug, Deserialize)]
struct Candidate {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
}

/// Parse the model's JSON array out of a possibly fenced / prose-wrapped
/// answer. Tolerates ```json fences and stray text around the array.
fn parse_candidates(answer: &str) -> Result<Vec<Candidate>, DbError> {
    let trimmed = answer.trim();
    let Some(start) = trimmed.find('[') else {
        // An explicit empty answer from the model is fine; anything else
        // without an array is a malformed response.
        if trimmed.contains("[]") || trimmed.is_empty() {
            return Ok(Vec::new());
        }
        return Err(DbError::Config(
            "extraction answer contained no JSON array".into(),
        ));
    };
    let Some(end) = trimmed.rfind(']') else {
        return Err(DbError::Config(
            "extraction answer contained no JSON array".into(),
        ));
    };
    let slice = &trimmed[start..=end];
    serde_json::from_str(slice)
        .map_err(|e| DbError::Config(format!("extraction answer was not valid JSON: {e}")))
}

/// Read a `MemoryItem` from a row of
/// `SELECT id, kind, title, content, source_session_id, created_at, updated_at`.
fn memory_row(row: &libsql::Row) -> MemoryItem {
    MemoryItem {
        id: row.get(0).unwrap_or_default(),
        kind: row.get(1).unwrap_or_else(|_| "fact".into()),
        title: row.get(2).unwrap_or_default(),
        content: row.get(3).unwrap_or_default(),
        source_session_id: row.get(4).unwrap_or(None),
        created_at: row.get(5).unwrap_or(0),
        updated_at: row.get(6).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_clean_and_fenced_arrays() {
        let clean = r#"[{"kind":"preference","title":"Likes dark mode","content":"Always ships dark UIs"}]"#;
        assert_eq!(parse_candidates(clean).unwrap().len(), 1);
        let fenced = "Here you go:\n```json\n[{\"kind\":\"fact\",\"title\":\"A\",\"content\":\"B\"}]\n```\nthanks";
        assert_eq!(parse_candidates(fenced).unwrap().len(), 1);
        assert!(parse_candidates("no array here").is_err());
        assert!(parse_candidates("[]").unwrap().is_empty());
    }

    #[test]
    fn unknown_kind_falls_back_at_extract_but_create_refuses() {
        // parse level: kind is a plain string; validation happens at insert.
        let c = parse_candidates(r#"[{"kind":"weird","title":"t","content":"c"}]"#).unwrap();
        assert_eq!(c[0].kind, "weird");
        assert!(valid_kind("weird").is_err());
        assert_eq!(valid_kind("goal").unwrap(), "goal");
    }

    #[tokio::test]
    async fn memory_crud_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        crate::logic::db::set_data_root(dir.path());
        // Leaked on purpose — see the note in the skills test (parallel tests
        // share the first-set data root; dropping it mid-run breaks the other).
        std::mem::forget(dir);
        let user = "memories-e2e-user";

        let m = memory_create(user, "preference", "Dark mode", "Always dark UIs")
            .await
            .unwrap();
        assert!(m.id.starts_with("mem-"));
        assert!(m.source_session_id.is_none());

        assert!(memory_create(user, "bogus", "x", "y").await.is_err());

        let list = memory_list(user).await.unwrap();
        assert_eq!(list.len(), 1);

        let updated = memory_update(user, &m.id, Some("rule"), Some("Dark mode only"), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.kind, "rule");
        assert_eq!(updated.title, "Dark mode only");
        assert_eq!(updated.content, "Always dark UIs");

        assert!(memory_update(user, "mem-nope", Some("fact"), None, None).await.unwrap().is_none());
        assert!(!memory_delete(user, "mem-nope").await.unwrap());
        assert!(memory_delete(user, &m.id).await.unwrap());
        assert!(memory_list(user).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn prompt_block_renders_and_caps() {
        let dir = tempfile::tempdir().unwrap();
        crate::logic::db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = "memories-prompt-user";

        // Empty tier → empty block.
        assert!(prompt_block(user).await.is_empty());

        memory_create(user, "preference", "Dark mode", "Always dark UIs")
            .await
            .unwrap();
        let block = prompt_block(user).await;
        assert!(block.starts_with("<memories>"));
        assert!(block.ends_with("</memories>"));
        assert!(block.contains("(preference) Dark mode: Always dark UIs"));

        // Many long memories → the block stays bounded and notes omissions.
        let long = "x".repeat(PROMPT_MEMORY_MAX_CHARS + 100);
        for i in 0..40 {
            memory_create(user, "fact", &format!("bulk-{i}"), &long)
                .await
                .unwrap();
        }
        let capped = prompt_block(user).await;
        assert!(capped.chars().count() < PROMPT_MEMORY_TOTAL_MAX_CHARS + 400);
        assert!(capped.contains("omitted for space"));
    }
}
