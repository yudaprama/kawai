//! Versioned, transactional schema migrations for the per-user local SQLite DB.
//!
//! Replaces the scattered `CREATE TABLE IF NOT EXISTS` calls elsewhere with a
//! single idempotent runner applied once per data directory. Hand-rolled for
//! the libsql API (no refinery / rusqlite_migration, which assume rusqlite).
//!
//! Each migration is a multi-statement `.sql` file loaded via `include_str!`.
//! Pending migrations run inside a `BEGIN`/`COMMIT` so a failure rolls back
//! and aborts startup — schema must be consistent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::logic::DbError;

pub struct Migration {
    pub version: &'static str,
    pub sql: &'static str,
}

/// Build the full, ordered migration list. Office/rag tables are included only
/// when the `office` feature is enabled (the same gating that controls whether
/// those tables are used at all).
fn migrations() -> Vec<Migration> {
    let mut m = vec![
        Migration {
            version: "0001_baseline",
            sql: include_str!("../../migrations/0001_baseline.sql"),
        },
        Migration {
            version: "0002_backfill_untitled_sessions",
            sql: include_str!("../../migrations/0002_backfill_untitled_sessions.sql"),
        },
    ];
    #[cfg(feature = "office")]
    m.push(Migration {
        version: "0003_office_tables",
        sql: include_str!("../../migrations/0003_office_tables.sql"),
    });
    m.push(Migration {
        version: "0004_session_archive",
        sql: include_str!("../../migrations/0004_session_archive.sql"),
    });
    m.push(Migration {
        version: "0005_remap_chat_agent",
        sql: include_str!("../../migrations/0005_remap_chat_agent.sql"),
    });
    m
}

/// Data directories whose DB has already been fully migrated in this process.
/// Connections are opened per-op, so this avoids re-running the version check
/// (and the no-op migration loop) on every single call.
static MIGRATED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn already_migrated(dir: &Path) -> bool {
    MIGRATED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .contains(dir)
}

fn mark_migrated(dir: &Path) {
    MIGRATED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(dir.to_path_buf());
}

/// Apply every pending migration to `conn` exactly once for `dir`.
///
/// `dir` is the user's data directory (`db::user_data_dir`) and is used only
/// for the in-memory idempotency guard — it is never touched on disk here.
pub async fn ensure_schema(conn: &libsql::Connection, dir: &Path) -> Result<(), DbError> {
    if already_migrated(dir) {
        return Ok(());
    }

    // Bootstrap the tracking table before reading it.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )",
        (),
    )
    .await?;

    let mut rows = conn
        .query("SELECT version FROM schema_migrations", ())
        .await?;
    let mut applied = HashSet::new();
    while let Some(r) = rows.next().await? {
        applied.insert(r.get::<String>(0)?);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    for mig in migrations() {
        if applied.contains(mig.version) {
            continue;
        }
        conn.execute("BEGIN", ()).await?;
        let result: Result<(), DbError> = async {
            conn.execute_batch(mig.sql).await?;
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (mig.version, now),
            )
            .await?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                conn.execute("COMMIT", ()).await?;
            }
            Err(e) => {
                conn.execute("ROLLBACK", ()).await.ok();
                return Err(e);
            }
        }
    }

    mark_migrated(dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn open_temp() -> (libsql::Connection, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "kawai_migtest_{}_{}",
            std::process::id(),
            uuid_like()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = libsql::Builder::new_local(dir.join("kawai.db"))
            .build()
            .await
            .unwrap();
        let conn = db.connect().unwrap();
        (conn, dir)
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{n:x}")
    }

    #[tokio::test]
    async fn runs_once_and_is_idempotent() {
        let (conn, dir) = open_temp().await;
        ensure_schema(&conn, &dir).await.unwrap();
        // Second call must be a no-op, not an error.
        ensure_schema(&conn, &dir).await.unwrap();

        let mut rows = conn
            .query("SELECT version FROM schema_migrations ORDER BY version", ())
            .await
            .unwrap();
        let mut versions = Vec::new();
        while let Some(r) = rows.next().await.unwrap() {
            versions.push(r.get::<String>(0).unwrap());
        }
        let mut expected = vec![
            "0001_baseline",
            "0002_backfill_untitled_sessions",
        ];
        #[cfg(feature = "office")]
        expected.push("0003_office_tables");
        expected.push("0004_session_archive");
        expected.push("0005_remap_chat_agent");
        assert_eq!(versions, expected);

        // Core tables exist.
        for table in ["sessions", "messages", "turn_log", "schema_migrations"] {
            let mut r = conn
                .query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", vec![table])
                .await
                .unwrap();
            assert!(r.next().await.unwrap().is_some(), "missing table {table}");
        }
    }

    #[tokio::test]
    async fn backfill_sets_untitled_title() {
        let (conn, dir) = open_temp().await;
        // Pre-create a sessions row with an empty title (legacy shape).
        conn.execute(
            "CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (agent_id, title, created_at) VALUES ('builtin.chat', '', 0)",
            (),
        )
        .await
        .unwrap();

        ensure_schema(&conn, &dir).await.unwrap();

        let mut r = conn
            .query("SELECT title FROM sessions", ())
            .await
            .unwrap();
        let row = r.next().await.unwrap().unwrap();
        assert_eq!(row.get::<String>(0).unwrap(), "(untitled)");
    }

    #[tokio::test]
    async fn remaps_legacy_chat_agent_sessions() {
        let (conn, dir) = open_temp().await;
        conn.execute(
            "CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
            (),
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (agent_id, title, created_at) VALUES ('builtin.chat', 'old chat', 0)",
            (),
        )
        .await
        .unwrap();

        ensure_schema(&conn, &dir).await.unwrap();

        let mut r = conn
            .query("SELECT agent_id FROM sessions", ())
            .await
            .unwrap();
        let row = r.next().await.unwrap().unwrap();
        assert_eq!(row.get::<String>(0).unwrap(), "builtin.office");
    }

    #[tokio::test]
    async fn adds_archive_columns_to_sessions() {
        let (conn, dir) = open_temp().await;
        // Pre-create sessions WITHOUT the archive columns (legacy shape).
        conn.execute(
            "CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
            (),
        )
        .await
        .unwrap();

        ensure_schema(&conn, &dir).await.unwrap();

        // Verify both archive columns exist via PRAGMA (works for libsql).
        let mut r = conn
            .query("PRAGMA table_info(sessions)", ())
            .await
            .unwrap();
        let mut columns = Vec::new();
        while let Some(row) = r.next().await.unwrap() {
            columns.push(row.get::<String>(1).unwrap());
        }
        assert!(
            columns.contains(&"archived".to_string()),
            "missing 'archived' column; got {columns:?}"
        );
        assert!(
            columns.contains(&"archived_at".to_string()),
            "missing 'archived_at' column; got {columns:?}"
        );

        // Verify default values: archived=0, archived_at=NULL.
        let mut r = conn
            .query("INSERT INTO sessions (agent_id, title, created_at) VALUES ('test', 't', 0) RETURNING archived, archived_at", ())
            .await
            .unwrap();
        let row = r.next().await.unwrap().unwrap();
        assert_eq!(row.get::<i64>(0).unwrap(), 0);
        assert!(row.get::<Option<i64>>(1).unwrap().is_none());
    }
}
