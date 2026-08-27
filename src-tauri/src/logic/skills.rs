//! Skills — reusable instruction sets (SKILL.md format) the user curates for
//! their agents. Ungated (plain libsql, no office/embedding deps): a skill is
//! a named markdown document with a monotonic version counter; updates bump
//! the version and `updated_at`, history is not retained in this tier.

use serde::{Deserialize, Serialize};

use super::db::{db_connection, unix_now, DbError};

/// A stored skill. `content` is the SKILL.md body (markdown); the list view
/// omits it (`SkillSummary`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// List projection of a skill (everything except the body).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<Skill> for SkillSummary {
    fn from(s: Skill) -> Self {
        Self {
            id: s.id,
            name: s.name,
            description: s.description,
            version: s.version,
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

/// `skl-` + 12 base62 chars from the CSPRNG (~71 bits, collision-safe).
fn new_skill_id() -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    let suffix: String = (0..12)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect();
    format!("skl-{suffix}")
}

/// Create a skill. The trimmed name must be non-empty and unique; `content`
/// is stored verbatim (markdown). `description` may be empty.
pub async fn skill_create(
    user_id: &str,
    name: &str,
    description: &str,
    content: &str,
) -> Result<Skill, DbError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(DbError::Config("skill name must not be empty".into()));
    }
    let conn = db_connection(user_id).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO skills (id, name, description, content, version, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 1, ?, ?) \
             RETURNING id, name, description, content, version, created_at, updated_at",
            (new_skill_id(), name, description.trim(), content, now, now),
        )
        .await
        .map_err(|e| map_unique(e, name))?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| DbError::Config("insert returned no row".into()))?;
    Ok(skill_row(&row))
}

/// List all skills, most recently updated first.
pub async fn skill_list(user_id: &str) -> Result<Vec<SkillSummary>, DbError> {
    let conn = db_connection(user_id).await?;
    let mut rows = conn
        .query(
            "SELECT id, name, description, version, created_at, updated_at \
             FROM skills ORDER BY updated_at DESC, id",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(SkillSummary {
            id: row.get(0).unwrap_or_default(),
            name: row.get(1).unwrap_or_default(),
            description: row.get(2).unwrap_or_default(),
            version: row.get(3).unwrap_or(1),
            created_at: row.get(4).unwrap_or(0),
            updated_at: row.get(5).unwrap_or(0),
        });
    }
    Ok(out)
}

/// Fetch one skill including its body. Unknown ids read as `None`.
pub async fn skill_get(user_id: &str, skill_id: &str) -> Result<Option<Skill>, DbError> {
    let conn = db_connection(user_id).await?;
    let mut rows = conn
        .query(
            "SELECT id, name, description, content, version, created_at, updated_at \
             FROM skills WHERE id = ?",
            vec![skill_id],
        )
        .await?;
    match rows.next().await? {
        Some(row) => Ok(Some(skill_row(&row))),
        None => Ok(None),
    }
}

/// Update a skill's name/description/content (any subset). Bumps `version`
/// and `updated_at`. Returns the updated skill, or `None` for unknown ids.
pub async fn skill_update(
    user_id: &str,
    skill_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    content: Option<&str>,
) -> Result<Option<Skill>, DbError> {
    if let Some(n) = name {
        if n.trim().is_empty() {
            return Err(DbError::Config("skill name must not be empty".into()));
        }
    }
    let conn = db_connection(user_id).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "UPDATE skills SET \
                name = COALESCE(?, name), \
                description = COALESCE(?, description), \
                content = COALESCE(?, content), \
                version = version + 1, \
                updated_at = ? \
             WHERE id = ? \
             RETURNING id, name, description, content, version, created_at, updated_at",
            (
                name.map(str::trim),
                description.map(str::trim),
                content,
                now,
                skill_id,
            ),
        )
        .await
        .map_err(|e| map_unique(e, name.unwrap_or_default()))?;
    match rows.next().await? {
        Some(row) => Ok(Some(skill_row(&row))),
        None => Ok(None),
    }
}

/// Delete a skill. Returns whether a row was removed.
pub async fn skill_delete(user_id: &str, skill_id: &str) -> Result<bool, DbError> {
    let conn = db_connection(user_id).await?;
    let n = conn
        .execute("DELETE FROM skills WHERE id = ?", vec![skill_id])
        .await?;
    Ok(n > 0)
}

// ── agent injection ─────────────────────────────────────────────────────────
//
// The opener (persona + manifest) is keyed `agent:session` and only rebuilt on
// a fresh session/epoch, so a skill saved mid-session applies from the next
// session — the running conversation keeps its already-prefilled K/V state.

/// Per-skill body cap (chars) in the prompt block.
const PROMPT_SKILL_MAX_CHARS: usize = 4_000;
/// Total cap (chars) across all skill bodies — protects the on-device
/// prefill budget (K/V entries are the scarce resource, not context bytes).
const PROMPT_TOTAL_MAX_CHARS: usize = 12_000;

/// Render the user's skills (newest-updated first) as a `<skills>` prompt
/// block appended to the agent persona; empty string when there are none.
/// Newer skills win the budget — oldest are dropped and the block notes the
/// truncation so the model never assumes the list is exhaustive.
pub async fn prompt_block(user_id: &str) -> String {
    let summaries = match skill_list(user_id).await {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    if summaries.is_empty() {
        return String::new();
    }
    let conn = match db_connection(user_id).await {
        Ok(c) => c,
        Err(_) => return String::new(),
    };

    let mut bodies: Vec<(String, String, String)> = Vec::new(); // name, description, content
    for s in &summaries {
        let Ok(mut rows) = conn
            .query(
                "SELECT content FROM skills WHERE id = ?",
                vec![s.id.as_str()],
            )
            .await
        else {
            continue;
        };
        let content = match rows.next().await {
            Ok(Some(row)) => row.get::<String>(0).unwrap_or_default(),
            _ => continue,
        };
        bodies.push((s.name.clone(), s.description.clone(), content));
    }

    let mut out = String::from(
        "<skills>\nThe user maintains these reusable instruction sets. When a request falls inside a skill's scope, follow that skill.\n",
    );
    let mut total = 0usize;
    let mut included = 0usize;
    for (name, description, content) in &bodies {
        let mut body = content.trim().to_string();
        if body.chars().count() > PROMPT_SKILL_MAX_CHARS {
            body = truncate_chars(&body, PROMPT_SKILL_MAX_CHARS);
            body.push_str("\n(skill truncated)");
        }
        let entry = if description.is_empty() {
            format!("--- skill: {name} ---\n{body}\n\n")
        } else {
            format!("--- skill: {name} ---\n{description}\n{body}\n\n")
        };
        total += entry.chars().count();
        if total > PROMPT_TOTAL_MAX_CHARS {
            break;
        }
        out.push_str(&entry);
        included += 1;
    }
    if included < bodies.len() {
        out.push_str(&format!(
            "({} older skill(s) omitted for space)\n",
            bodies.len() - included
        ));
    }
    out.push_str("</skills>");
    out
}

/// Char-boundary-safe truncation (no panics on multibyte UTF-8).
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Surface a UNIQUE(name) violation as a friendly error instead of raw SQL.
fn map_unique(e: libsql::Error, name: &str) -> DbError {
    let msg = e.to_string();
    if msg.contains("idx_skills_name") || msg.to_lowercase().contains("unique") {
        DbError::Config(format!("a skill named “{name}” already exists"))
    } else {
        e.into()
    }
}

/// Read a `Skill` from a row of
/// `SELECT id, name, description, content, version, created_at, updated_at`.
fn skill_row(row: &libsql::Row) -> Skill {
    Skill {
        id: row.get(0).unwrap_or_default(),
        name: row.get(1).unwrap_or_default(),
        description: row.get(2).unwrap_or_default(),
        content: row.get(3).unwrap_or_default(),
        version: row.get(4).unwrap_or(1),
        created_at: row.get(5).unwrap_or(0),
        updated_at: row.get(6).unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn skill_crud_round_trip() {
        // Same convention as the graph/rag e2e tests: temp data root + a
        // unique user id. The OnceLock root is first-set-wins and tests run
        // in parallel, so the TempDir is deliberately leaked — dropping it
        // would delete the shared root out from under the other test.
        let dir = tempfile::tempdir().unwrap();
        crate::logic::db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = "skills-e2e-user";

        let created = skill_create(user, "pdf-flow", "PDF tricks", "# PDF\nbe gentle")
            .await
            .unwrap();
        assert!(created.id.starts_with("skl-"));
        assert_eq!(created.id.len(), 16);
        assert_eq!(created.version, 1);

        // Duplicate name is rejected with a friendly message.
        let dup = skill_create(user, "pdf-flow", "", "# dup").await;
        assert!(dup.is_err());

        // List sees it; get returns the body.
        let list = skill_list(user).await.unwrap();
        assert!(list.iter().any(|s| s.id == created.id));
        let got = skill_get(user, &created.id).await.unwrap().unwrap();
        assert_eq!(got.content, "# PDF\nbe gentle");

        // Update bumps the version and keeps untouched fields.
        let updated = skill_update(user, &created.id, None, Some("better desc"), Some("# PDF v2"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.version, 2);
        assert_eq!(updated.name, "pdf-flow");
        assert_eq!(updated.description, "better desc");
        assert_eq!(updated.content, "# PDF v2");

        // Unknown id → None / false, not an error.
        assert!(skill_get(user, "skl-nope").await.unwrap().is_none());
        assert!(skill_update(user, "skl-nope", Some("x"), None, None).await.unwrap().is_none());
        assert!(!skill_delete(user, "skl-nope").await.unwrap());

        assert!(skill_delete(user, &created.id).await.unwrap());
        assert!(skill_get(user, &created.id).await.unwrap().is_none());
    }
}
