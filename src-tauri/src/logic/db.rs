//! Database access (local SQLite via libsql) + notes + chat sessions.
//!
//! Desktop MVP: single-device, local SQLite file, no sync.
//! One data directory per user: `<data_root>/<user_id>/` holds everything the
//! user owns (kawai.db + office docs subdir) so backup/restore is one folder
//! per user. The identity from the transport edge selects the directory; rows
//! inside are NOT user-tagged (hard isolation by path — the sqld-namespace
//! model, applied to local files).
//!
//! Connections are opened per-op. Pool before production.

use async_stream::stream;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug)]
pub enum DbError {
    Config(String),
    NotFound(String),
    Io(std::io::Error),
    Sql(libsql::Error),
}

impl From<std::io::Error> for DbError {
    fn from(e: std::io::Error) -> Self {
        DbError::Io(e)
    }
}

impl From<libsql::Error> for DbError {
    fn from(e: libsql::Error) -> Self {
        DbError::Sql(e)
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbError::Config(m) => write!(f, "db config: {m}"),
            DbError::NotFound(m) => write!(f, "not found: {m}"),
            DbError::Io(e) => write!(f, "io: {e}"),
            DbError::Sql(e) => write!(f, "sql: {e}"),
        }
    }
}
impl std::error::Error for DbError {}

pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Open the calling user's local libsql (SQLite) connection. `user_id` selects
/// the per-user data directory — one DB per user, no auth token needed (desktop
/// MVP, single-device, no sync).
pub async fn db_connection(user_id: &str) -> Result<libsql::Connection, DbError> {
    let dir = user_data_dir(user_id);
    let db = build_db(user_id).await?;
    let conn = db.connect().map_err(DbError::from)?;
    crate::logic::db_migrations::ensure_schema(&conn, &dir).await?;
    Ok(conn)
}

static DATA_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Inject the data root (used by the Tauri shell: app-data dir). Env overrides
/// still win — see `data_root()`.
pub fn set_data_root(dir: impl Into<PathBuf>) {
    let _ = DATA_ROOT.set(dir.into());
}

/// Root of all per-user data directories. Resolution order: `KAWAI_DATA_DIR`
/// env → legacy `KAWAI_DB_DIR` env (also a per-user root) → injected root →
/// `/tmp/kawai` (headless/web default).
fn data_root() -> PathBuf {
    for key in ["KAWAI_DATA_DIR", "KAWAI_DB_DIR"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                return PathBuf::from(v);
            }
        }
    }
    if let Some(p) = DATA_ROOT.get() {
        return p.clone();
    }
    std::env::temp_dir().join("kawai")
}

/// The user's data directory — everything a user owns lives here (kawai.db,
/// docs/). Backup/restore/sync operates on this one folder per user.
pub fn user_data_dir(user_id: &str) -> PathBuf {
    data_root().join(sanitize_user_dir(user_id))
}

async fn build_db(user_id: &str) -> Result<libsql::Database, DbError> {
    let dir = user_data_dir(user_id);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("kawai.db");
    Ok(libsql::Builder::new_local(file).build().await?)
}

/// Filesystem-safe encoding of a user id for the per-user data directory.
/// `[A-Za-z0-9_-]` passes through (covers `demo` and Clerk `user_*` subs);
/// anything else degrades to a deterministic hex encoding.
fn sanitize_user_dir(user_id: &str) -> String {
    if !user_id.is_empty()
        && user_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        user_id.to_string()
    } else {
        user_id.bytes().map(|b| format!("{b:02x}")).collect()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub body: String,
    pub created_at: i64,
}

pub async fn create_note(user_id: &str, body: &str) -> Result<Note, DbError> {
    let conn = db_connection(user_id).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO notes (body, created_at) VALUES (?, ?) \
             RETURNING id, body, created_at",
            (body, now),
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| DbError::Config("insert returned no row".into()))?;
    Ok(Note {
        id: row.get(0)?,
        body: row.get(1)?,
        created_at: row.get(2)?,
    })
}

pub async fn list_notes(user_id: &str) -> Result<Vec<Note>, DbError> {
    let conn = db_connection(user_id).await?;
    let mut rows = conn
        .query(
            "SELECT id, body, created_at FROM notes ORDER BY id",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(Note {
            id: row.get(0)?,
            body: row.get(1)?,
            created_at: row.get(2)?,
        });
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NoteEvent {
    Notes { notes: Vec<Note> },
    Finished,
    Error { message: String },
}

/// Streaming variant of `list_notes`, demonstrating DB + auth + cancellation
/// flowing through the same streaming pattern as `generate_activity`.
pub fn stream_notes(user_id: String) -> impl Stream<Item = NoteEvent> {
    stream! {
        match list_notes(&user_id).await {
            Ok(notes) => yield NoteEvent::Notes { notes },
            Err(e) => {
                yield NoteEvent::Error { message: e.to_string() };
                return;
            }
        }
        yield NoteEvent::Finished;
    }
}

// ── Chat sessions (agent-ready persistence) ────────────────────────────────
//
// Schema is designed for the agent tier (Roadmap 5) from day one: sessions
// carry an `agent_id`, messages hang off a `session_id`. The MVP runs a single
// implicit agent (BUILTIN_CHAT_AGENT_ID); the future three-pane UI (agent
// list / sessions / content) rides on the same tables without a migration.

/// The single implicit agent of the MVP chat. The agent catalog (Roadmap 5)
// extends this with real agent ids.
pub const BUILTIN_CHAT_AGENT_ID: &str = "builtin.chat";

/// First N chars of the first user message become the session title (offline
/// fallback). The LLM-generated title (`generate_session_title`) is capped to
/// the same length so the sidebar never overflows.
pub const SESSION_TITLE_MAX_CHARS: usize = 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: i64,
    pub agent_id: String,
    pub title: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: i64,
    pub role: String, // "user" | "assistant"
    pub content: String,
    pub created_at: i64,
}

/// Start a new chat session for the given agent (defaults to the MVP implicit
/// agent). Sessions are created lazily — on the first message, not on launch —
/// so restarts don't accumulate empty rows.
pub async fn create_chat_session(
    user_id: &str,
    agent_id: Option<&str>,
) -> Result<ChatSession, DbError> {
    let conn = db_connection(user_id).await?;
    let agent = agent_id.unwrap_or(BUILTIN_CHAT_AGENT_ID);
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO sessions (agent_id, title, created_at) \
             VALUES (?, '', ?) \
             RETURNING id, agent_id, title, created_at",
            (agent, now),
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| DbError::Config("insert returned no row".into()))?;
    Ok(ChatSession {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get(3)?,
    })
}

/// List the user's chat sessions, newest first (right-sidebar order).
pub async fn list_chat_sessions(user_id: &str) -> Result<Vec<ChatSession>, DbError> {
    let conn = db_connection(user_id).await?;
    let mut rows = conn
        .query(
            "SELECT id, agent_id, title, created_at FROM sessions ORDER BY id DESC",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(ChatSession {
            id: row.get(0)?,
            agent_id: row.get(1)?,
            title: row.get(2)?,
            created_at: row.get(3)?,
        });
    }
    Ok(out)
}

/// Fetch a session, or `NotFound` if the id doesn't exist. (User isolation is
/// by per-user database file — no user column to check.)
async fn chat_session_owned(
    conn: &libsql::Connection,
    session_id: i64,
) -> Result<ChatSession, DbError> {
    let mut rows = conn
        .query(
            "SELECT id, agent_id, title, created_at FROM sessions WHERE id = ?",
            vec![session_id],
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| DbError::NotFound(format!("session {session_id}")))?;
    Ok(ChatSession {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        title: row.get(2)?,
        created_at: row.get(3)?,
    })
}

/// List a session's messages, oldest first. Existence is verified first.
pub async fn list_chat_messages(
    user_id: &str,
    session_id: i64,
) -> Result<Vec<ChatMessage>, DbError> {
    let conn = db_connection(user_id).await?;
    chat_session_owned(&conn, session_id).await?;
    let mut rows = conn
        .query(
            "SELECT id, session_id, role, content, created_at FROM messages \
             WHERE session_id = ? ORDER BY id",
            vec![session_id],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(ChatMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        });
    }
    Ok(out)
}

/// Delete a session and its messages (existence verified first). Indexed
/// knowledge chunks are untouched — they belong to files, not sessions;
/// `session_files` rows go with the session, which may orphan chunks of files
/// no other session references (the uploader can re-index to reclaim space).
pub async fn delete_chat_session(user_id: &str, session_id: i64) -> Result<(), DbError> {
    let conn = db_connection(user_id).await?;
    chat_session_owned(&conn, session_id).await?;
    conn.execute(
        "DELETE FROM session_files WHERE session_id = ?",
        vec![session_id],
    )
    .await?;
    conn.execute("DELETE FROM messages WHERE session_id = ?", vec![session_id])
        .await?;
    conn.execute("DELETE FROM sessions WHERE id = ?", vec![session_id])
        .await?;
    Ok(())
}

/// Append a message to a session (existence verified). The first user message
/// seeds the session title.
pub async fn append_chat_message(
    user_id: &str,
    session_id: i64,
    role: &str,
    content: &str,
) -> Result<ChatMessage, DbError> {
    let conn = db_connection(user_id).await?;
    chat_session_owned(&conn, session_id).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO messages (session_id, role, content, created_at) \
             VALUES (?, ?, ?, ?) \
             RETURNING id, session_id, role, content, created_at",
            (session_id, role, content, now),
        )
        .await?;
    let row = rows
        .next()
        .await?
        .ok_or_else(|| DbError::Config("insert returned no row".into()))?;
    if role == "user" {
        conn.execute(
            "UPDATE sessions SET title = substr(?, 1, ?) WHERE id = ? AND title = ''",
            (content, SESSION_TITLE_MAX_CHARS as i64, session_id),
        )
        .await?;
    }
    Ok(ChatMessage {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
    })
}

/// One telemetry row per completed generation (local answer, cloud subagent
/// call, escalation, or terminal error) — the calibration data for the hybrid
/// LLM tier (`PLAN-hybrid-llm-subagents.md` §7). Best-effort by design:
/// failures are logged and swallowed, telemetry must never fail a turn.
pub struct TurnLogEntry<'a> {
    pub session_id: i64,
    pub agent_id: &'a str,
    /// "local" | "cloud"
    pub provider: &'a str,
    /// Subagent/tool name for cloud rows.
    pub tool: Option<&'a str>,
    /// Provider-reported input tokens (None = unknown/not reported).
    pub input_tokens: Option<i64>,
    /// Provider-reported (cloud) or estimated (local, chars/4) output tokens.
    pub output_tokens: Option<i64>,
    pub latency_ms: i64,
    /// "answer" | "escalated" | "error"
    pub outcome: &'a str,
}

pub async fn log_turn(user_id: &str, entry: TurnLogEntry<'_>) {
    let conn = match db_connection(user_id).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[turn_log] no connection: {e}");
            return;
        }
    };
    let now = unix_now() as i64;
    let res = conn
        .execute(
            "INSERT INTO turn_log (session_id, agent_id, provider, tool, input_tokens, \
             output_tokens, latency_ms, outcome, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                entry.session_id,
                entry.agent_id,
                entry.provider,
                entry.tool,
                entry.input_tokens,
                entry.output_tokens,
                entry.latency_ms,
                entry.outcome,
                now,
            ),
        )
        .await;
    if let Err(e) = res {
        eprintln!("[turn_log] insert: {e}");
    }
}

/// One materialized `turn_log` row (calibration reader — see
/// `examples/turn_log_report.rs`).
pub struct TurnLogRow {
    pub session_id: i64,
    pub agent_id: String,
    pub provider: String,
    pub tool: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub latency_ms: i64,
    pub outcome: String,
    pub created_at: i64,
}

/// Read telemetry rows for a user since a unix timestamp (oldest first).
/// Best-effort like `log_turn`: a missing table reads as empty.
pub async fn list_turn_log(user_id: &str, since: i64) -> Result<Vec<TurnLogRow>, DbError> {
    let conn = db_connection(user_id).await?;
    let mut rows = conn
        .query(
            "SELECT session_id, agent_id, provider, tool, input_tokens, output_tokens, \
             latency_ms, outcome, created_at FROM turn_log WHERE created_at >= ? ORDER BY id ASC",
            vec![since],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().await? {
        out.push(TurnLogRow {
            session_id: r.get(0)?,
            agent_id: r.get(1)?,
            provider: r.get(2)?,
            tool: r.get(3)?,
            input_tokens: r.get(4)?,
            output_tokens: r.get(5)?,
            latency_ms: r.get(6)?,
            outcome: r.get(7)?,
            created_at: r.get(8)?,
        });
    }
    Ok(out)
}
