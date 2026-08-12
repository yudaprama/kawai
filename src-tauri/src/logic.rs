use async_stream::stream;
use futures_core::Stream;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityInput {
    pub events: u64,
    pub interval_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActivityEvent {
    Started { total: u64 },
    Progress { done: u64, total: u64 },
    Finished,
    Error { message: String },
}

/// Request-response example.
pub fn greet(name: &str) -> String {
    format!("Hello, {name}! You've been greeted from Rust!")
}

/// Authenticated identity. Real ops take `user_id` as the first param and use
/// it to scope data. The wrappers (`commands.rs`, `web.rs`) resolve identity at
/// the edge and pass `sub` in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub user_id: String,
}

pub fn whoami(user_id: &str) -> UserInfo {
    UserInfo {
        user_id: user_id.to_string(),
    }
}

/// Streaming example. Returns a pure async stream of typed events.
pub fn generate_activity(input: ActivityInput) -> impl Stream<Item = ActivityEvent> {
    let total = input.events;
    let interval = input.interval_ms;
    stream! {
        yield ActivityEvent::Started { total };
        for done in 1..=total {
            tokio::time::sleep(Duration::from_millis(interval)).await;
            yield ActivityEvent::Progress { done, total };
        }
        yield ActivityEvent::Finished;
    }
}

// ── Database (self-hosted libsql-server / sqld) ───────────────────────────
//
// sqld validates client JWTs with EdDSA against an Ed25519 PUBLIC key. It does
// NOT support JWKS/RS256, so Clerk's session JWTs CANNOT be presented to sqld
// directly. The backend (holder of the Ed25519 private key) verifies the Clerk
// identity elsewhere and MINTS the EdDSA token here that sqld accepts.
//
// Builder selection is feature-gated — NOT branched on a transport type — so
// this module stays pure (no tauri/axum imports):
//   - web (`--features web`, kawai-web): remote client, no local file.
//   - desktop/mobile: embedded replica — a local file that syncs to sqld.
//
// Connections are opened per-op for correctness (fresh token, no expiry churn).
// Pool/refresh before production.

#[derive(Debug)]
pub enum DbError {
    Config(String),
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
            DbError::Io(e) => write!(f, "io: {e}"),
            DbError::Sql(e) => write!(f, "sql: {e}"),
        }
    }
}
impl std::error::Error for DbError {}

const DB_TOKEN_TTL_SECS: u64 = 300;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn db_url() -> Result<String, DbError> {
    std::env::var("KAWAI_DB_URL").map_err(|_| DbError::Config("KAWAI_DB_URL not set".into()))
}

fn db_jwt_key_path() -> Result<PathBuf, DbError> {
    std::env::var("KAWAI_DB_JWT_PRIVATE_KEY_FILE")
        .map(PathBuf::from)
        .map_err(|_| DbError::Config("KAWAI_DB_JWT_PRIVATE_KEY_FILE not set".into()))
}

#[derive(Serialize)]
struct DbClaims {
    sub: String,
    iat: u64,
    exp: u64,
}

/// Mint a short-lived EdDSA token that sqld validates against its configured
/// Ed25519 public key. `sub` carries the user id (selects the namespace when
/// sqld runs with `--enable-namespaces`; otherwise it's informational and rows
/// are filtered by `user_id`).
pub fn mint_db_token(user_id: &str) -> Result<String, DbError> {
    let pem = std::fs::read(db_jwt_key_path()?)?;
    let key = EncodingKey::from_ed_pem(&pem)
        .map_err(|e| DbError::Config(format!("ed25519 key: {e}")))?;
    let now = unix_now();
    let claims = DbClaims {
        sub: user_id.to_string(),
        iat: now,
        exp: now + DB_TOKEN_TTL_SECS,
    };
    let header = Header::new(Algorithm::EdDSA);
    encode(&header, &claims, &key).map_err(|e| DbError::Config(format!("encode jwt: {e}")))
}

/// Open a libsql connection to sqld, authenticated with a freshly minted
/// per-user EdDSA token.
pub async fn db_connection(user_id: &str) -> Result<libsql::Connection, DbError> {
    let url = db_url()?;
    let token = mint_db_token(user_id)?;
    let db = build_db(&url, &token).await?;
    db.connect().map_err(DbError::from)
}

async fn build_db(url: &str, token: &str) -> Result<libsql::Database, DbError> {
    #[cfg(feature = "web")]
    {
        Ok(libsql::Builder::new_remote(url.to_string(), token.to_string()).build().await?)
    }
    #[cfg(not(feature = "web"))]
    {
        let dir = replica_dir();
        std::fs::create_dir_all(&dir).ok();
        let file = dir.join("replica.db");
        Ok(
            libsql::Builder::new_remote_replica(file, url.to_string(), token.to_string())
                .build()
                .await?,
        )
    }
}

#[cfg(not(feature = "web"))]
fn replica_dir() -> PathBuf {
    // Desktop/mobile: a per-user local replica file. In production set
    // KAWAI_DB_REPLICA_DIR to the Tauri app-data dir (from a setup hook).
    std::env::var("KAWAI_DB_REPLICA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("kawai-replica"))
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
