//! Database access (local SQLite via libsql) + notes + chat sessions.
//!
//! Desktop MVP: single-device, local SQLite file, no sync.
//! DB path: $KAWAI_DB_DIR/kawai.db (default: /tmp/kawai-db/kawai.db).
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

/// Open a local libsql (SQLite) connection. No auth token needed — desktop MVP,
/// single-device, no sync.
pub async fn db_connection(_user_id: &str) -> Result<libsql::Connection, DbError> {
    let db = build_db().await?;
    db.connect().map_err(DbError::from)
}

async fn build_db() -> Result<libsql::Database, DbError> {
    let dir = db_dir();
    std::fs::create_dir_all(&dir).ok();
    let file = dir.join("kawai.db");
    Ok(libsql::Builder::new_local(file).build().await?)
}

fn db_dir() -> PathBuf {
    std::env::var("KAWAI_DB_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("kawai-db"))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub body: String,
    pub created_at: i64,
}

const NOTES_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS notes (
    user_id TEXT NOT NULL,
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
)";

pub async fn create_note(user_id: &str, body: &str) -> Result<Note, DbError> {
    let conn = db_connection(user_id).await?;
    conn.execute(NOTES_SCHEMA, ()).await?;
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO notes (user_id, body, created_at) VALUES (?, ?, ?) \
             RETURNING id, body, created_at",
            (user_id, body, now),
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
    conn.execute(NOTES_SCHEMA, ()).await?;
    let mut rows = conn
        .query(
            "SELECT id, body, created_at FROM notes WHERE user_id = ? ORDER BY id",
            vec![user_id],
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

/// First N chars of the first user message become the session title.
const SESSION_TITLE_MAX_CHARS: usize = 60;

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

const SESSIONS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS sessions (
    user_id TEXT NOT NULL,
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
)";

const MESSAGES_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
)";

async fn ensure_chat_schema(conn: &libsql::Connection) -> Result<(), DbError> {
    conn.execute(SESSIONS_SCHEMA, ()).await?;
    conn.execute(MESSAGES_SCHEMA, ()).await?;
    // Cover the hot queries: sessions by user (sidebar), messages by session.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, id)",
        (),
    )
    .await?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, id)",
        (),
    )
    .await?;
    Ok(())
}

/// Start a new chat session for the given agent (defaults to the MVP implicit
/// agent). Sessions are created lazily — on the first message, not on launch —
/// so restarts don't accumulate empty rows.
pub async fn create_chat_session(
    user_id: &str,
    agent_id: Option<&str>,
) -> Result<ChatSession, DbError> {
    let conn = db_connection(user_id).await?;
    ensure_chat_schema(&conn).await?;
    let agent = agent_id.unwrap_or(BUILTIN_CHAT_AGENT_ID);
    let now = unix_now() as i64;
    let mut rows = conn
        .query(
            "INSERT INTO sessions (user_id, agent_id, title, created_at) \
             VALUES (?, ?, '', ?) \
             RETURNING id, agent_id, title, created_at",
            (user_id, agent, now),
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
    ensure_chat_schema(&conn).await?;
    let mut rows = conn
        .query(
            "SELECT id, agent_id, title, created_at FROM sessions \
             WHERE user_id = ? ORDER BY id DESC",
            vec![user_id],
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

/// Fetch a session owned by `user_id`, or `NotFound` (covers both a missing
/// id and one belonging to another user — no information leak).
async fn chat_session_owned(
    conn: &libsql::Connection,
    user_id: &str,
    session_id: i64,
) -> Result<ChatSession, DbError> {
    let mut rows = conn
        .query(
            "SELECT id, agent_id, title, created_at FROM sessions \
             WHERE id = ? AND user_id = ?",
            (session_id, user_id),
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

/// List a session's messages, oldest first. Ownership is verified first.
pub async fn list_chat_messages(
    user_id: &str,
    session_id: i64,
) -> Result<Vec<ChatMessage>, DbError> {
    let conn = db_connection(user_id).await?;
    ensure_chat_schema(&conn).await?;
    chat_session_owned(&conn, user_id, session_id).await?;
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

/// Append a message to a session (ownership verified). The first user message
/// seeds the session title.
pub async fn append_chat_message(
    user_id: &str,
    session_id: i64,
    role: &str,
    content: &str,
) -> Result<ChatMessage, DbError> {
    let conn = db_connection(user_id).await?;
    ensure_chat_schema(&conn).await?;
    chat_session_owned(&conn, user_id, session_id).await?;
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
