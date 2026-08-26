//! Remote SQL sources (Postgres/MySQL) for the analytics snapshot tools.
//!
//! Feature `analytics-sql`. Everything here speaks the crate's neutral
//! [`analytics::RawCell`] output so the parquet dump path is shared with the
//! SQLite one. Credentials NEVER reach the model: the model only ever passes
//! a profile NAME; the URL is resolved server-side from the user's
//! `sql_profiles` table and is redacted in every error path.

use sqlx::mysql::MySqlPoolOptions;
use sqlx::postgres::PgPoolOptions;
use sqlx::{Column, Row, TypeInfo};

use analytics::RawCell;

/// One supported remote dialect, detected from the profile source scheme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    MySql,
}

/// Does this source string point at a REMOTE database (as opposed to a local
/// SQLite file)? Compiled even without the feature so callers can emit a
/// precise "rebuild needed" error instead of treating a URL as a path.
pub fn is_remote(source: &str) -> bool {
    detect(source).is_some()
}

/// Detect the dialect from the URL scheme. `None` = not a remote source.
pub fn detect(source: &str) -> Option<Dialect> {
    let s = source.trim().to_ascii_lowercase();
    if s.starts_with("postgres://") || s.starts_with("postgresql://") {
        Some(Dialect::Postgres)
    } else if s.starts_with("mysql://") || s.starts_with("mariadb://") {
        Some(Dialect::MySql)
    } else {
        None
    }
}

/// Mask the password in a URL for logs/errors: `postgres://u:SECRET@h/db` →
/// `postgres://u:***@h/db`. Anything without userinfo comes back unchanged.
pub fn redact(url: &str) -> String {
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (format!("{s}://"), r),
        None => return url.to_string(),
    };
    let (authority, tail) = match rest.split_once('/') {
        Some((a, t)) => (a, format!("/{t}")),
        None => (rest, String::new()),
    };
    match authority.split_once('@') {
        Some((userinfo, host)) => {
            let user = userinfo.split(':').next().unwrap_or("");
            format!("{scheme}{user}:***@{host}{tail}")
        }
        None => url.to_string(),
    }
}

/// Quote an identifier AFTER validation (call sites verify membership via
/// bound-parameter catalog queries first; this only escapes embedded quotes).
pub fn quote_ident(dialect: Dialect, name: &str) -> String {
    match dialect {
        Dialect::Postgres => format!("\"{}\"", name.replace('"', "\"\"")),
        Dialect::MySql => format!("`{}`", name.replace('`', "``")),
    }
}

/// One connection pool, dialect-tagged. Two connections max — these are
/// single-user desktop dumps, not app servers.
enum Pool {
    Pg(sqlx::PgPool),
    My(sqlx::MySqlPool),
}

async fn connect(url: &str) -> Result<Pool, String> {
    let target = url.trim();
    let err = |e: sqlx::Error| format!("connect {}: {e}", redact(target));
    match detect(target).expect("dialect checked by caller") {
        Dialect::Postgres => Ok(Pool::Pg(
            PgPoolOptions::new()
                .max_connections(2)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(target)
                .await
                .map_err(err)?,
        )),
        Dialect::MySql => Ok(Pool::My(
            MySqlPoolOptions::new()
                .max_connections(2)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(target)
                .await
                .map_err(err)?,
        )),
    }
}

fn pg_kind(table_type: &str) -> String {
    if table_type == "VIEW" { "view" } else { "table" }.to_string()
}

/// MySQL reports information_schema identifier columns with a BINARY charset
/// (VARBINARY/BINARY), so `try_get::<String>` rejects them — a strict decode
/// here silently emptied the whole catalog. Decode tolerantly: String when the
/// column is textual, lossy UTF-8 from bytes when it is binary-typed.
fn my_text(row: &sqlx::mysql::MySqlRow, i: usize) -> Option<String> {
    let ty = row.column(i).type_info().name().to_ascii_uppercase();
    if ty.contains("BINARY") || ty.contains("BLOB") {
        let b: Vec<u8> = row.try_get(i).ok()?;
        Some(String::from_utf8_lossy(&b).into_owned())
    } else {
        row.try_get::<String, _>(i).ok()
    }
}

/// Tables + views visible to the connecting user, sorted by name. Scoped to
/// the session's default schema — the SAME scope `dump_rows` reads from, so
/// everything `data_tables` offers is actually importable (MySQL already
/// scoped to DATABASE(); Postgres previously listed every non-system schema,
/// offering tables the dump could never resolve).
pub async fn list_objects(url: &str) -> Result<Vec<(String, String)>, String> {
    let pool = connect(url).await?;
    match &pool {
        Pool::Pg(p) => {
            let rows = sqlx::query(
                "SELECT table_name, table_type FROM information_schema.tables \
                 WHERE table_schema = current_schema() \
                   AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY 1",
            )
            .fetch_all(p)
            .await
            .map_err(|e| format!("listing tables failed: {e}"))?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    Some((
                        r.try_get::<String, usize>(0).ok()?,
                        pg_kind(&r.try_get::<String, usize>(1).unwrap_or_default()),
                    ))
                })
                .collect())
        }
        Pool::My(p) => {
            let rows = sqlx::query(
                "SELECT table_name, table_type FROM information_schema.tables \
                 WHERE table_schema = DATABASE() \
                   AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY 1",
            )
            .fetch_all(p)
            .await
            .map_err(|e| format!("listing tables failed: {e}"))?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    Some((
                        my_text(r, 0)?,
                        pg_kind(&my_text(r, 1).unwrap_or_default()),
                    ))
                })
                .collect())
        }
    }
}

/// Column layout of ONE validated table: `(name, data_type)` in order.
/// Validation happens HERE via a bound parameter — quoting only after this.
async fn table_columns(
    pool: &Pool,
    dialect: Dialect,
    table: &str,
) -> Result<Vec<(String, String)>, String> {
    // Each arm returns directly — the two drivers yield different row types.
    match (pool, dialect) {
        (Pool::Pg(p), _) => {
            let rows = sqlx::query(
                "SELECT column_name, data_type FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = $1 \
                 ORDER BY ordinal_position",
            )
            .bind(table)
            .fetch_all(p)
            .await
            .map_err(|e| format!("schema lookup failed: {e}"))?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    Some((
                        r.try_get::<String, usize>(0).ok()?,
                        r.try_get::<String, usize>(1).unwrap_or_default(),
                    ))
                })
                .collect())
        }
        (Pool::My(p), _) => {
            let rows = sqlx::query(
                "SELECT column_name, data_type FROM information_schema.columns \
                 WHERE table_schema = DATABASE() AND table_name = ? \
                 ORDER BY ordinal_position",
            )
            .bind(table)
            .fetch_all(p)
            .await
            .map_err(|e| format!("schema lookup failed: {e}"))?;
            Ok(rows
                .iter()
                .filter_map(|r| {
                    Some((
                        my_text(r, 0)?,
                        my_text(r, 1).unwrap_or_default(),
                    ))
                })
                .collect())
        }
    }
}

fn pg_is_temporal(data_type: &str) -> bool {
    matches!(
        data_type,
        "timestamp without time zone"
            | "timestamp with time zone"
            | "date"
            | "time without time zone"
            | "time with time zone"
            | "interval"
            | "uuid"
    )
}

fn my_is_temporal(data_type: &str) -> bool {
    matches!(data_type, "datetime" | "timestamp" | "date" | "time" | "year")
}

fn pg_is_unsupported(data_type: &str) -> bool {
    // BYTEA and every array type (`ARRAY`, wire names like `_text`) have no
    // faithful scalar mapping in this pipeline.
    data_type == "bytea" || data_type == "ARRAY" || data_type.starts_with('_')
}

fn my_is_unsupported(data_type: &str) -> bool {
    matches!(
        data_type,
        "binary"
            | "varbinary"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "geometry"
            | "set"
    )
}

/// Dump up to `limit` rows as typed cells. Temporal columns are CAST to text
/// at the SQL layer (no chrono dependency; dates arrive as readable strings).
/// Binary/array columns fail the whole dump with a message naming them —
/// same contract as the SQLite path.
pub async fn dump_rows(
    url: &str,
    table: &str,
    limit: usize,
) -> Result<(Vec<String>, Vec<Vec<RawCell>>), String> {
    let dialect = detect(url).ok_or("not a remote SQL source")?;
    let pool = connect(url).await?;
    let columns = table_columns(&pool, dialect, table).await?;
    if columns.is_empty() {
        return Err(format!("no table or view named {table:?}"));
    }
    for (name, dt) in &columns {
        let bad = match dialect {
            Dialect::Postgres => pg_is_unsupported(dt),
            Dialect::MySql => my_is_unsupported(dt),
        };
        if bad {
            return Err(format!(
                "column {name:?} holds binary/array values — snapshot export supports scalar types only"
            ));
        }
    }

    let quoted_table = quote_ident(dialect, table);
    let projection = columns
        .iter()
        .map(|(name, dt)| {
            let q = quote_ident(dialect, name);
            let temporal = match dialect {
                Dialect::Postgres => pg_is_temporal(dt),
                Dialect::MySql => my_is_temporal(dt),
            };
            match (dialect, temporal) {
                // Aliases keep the original column name through the cast.
                (Dialect::Postgres, true) => format!("{q}::text AS {q}"),
                (Dialect::MySql, true) => format!("CAST({q} AS CHAR) AS {q}"),
                _ => q,
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql =
        format!("SELECT {projection} FROM {quoted_table} LIMIT {}", limit.saturating_add(1));

    // Column names come from the catalog (aliases preserve them), so an
    // EMPTY table still yields a correctly-shaped zero-row parquet.
    let out_cols: Vec<String> = columns.iter().map(|(n, _)| n.clone()).collect();
    let mut raw: Vec<Vec<RawCell>> = Vec::new();
    match &pool {
        Pool::Pg(p) => {
            let rows = sqlx::query(&sql)
                .fetch_all(p)
                .await
                .map_err(|e| format!("read failed: {e}"))?;
            raw.reserve(rows.len());
            for row in &rows {
                raw.push((0..out_cols.len()).map(|i| pg_cell(row, i)).collect());
            }
        }
        Pool::My(p) => {
            let rows = sqlx::query(&sql)
                .fetch_all(p)
                .await
                .map_err(|e| format!("read failed: {e}"))?;
            raw.reserve(rows.len());
            for row in &rows {
                raw.push((0..out_cols.len()).map(|i| my_cell(row, i)).collect());
            }
        }
    }
    Ok((out_cols, raw))
}

/// Typed decode cascade for one Postgres cell. The projection already
/// normalized temporal/decimal shapes; this covers the scalar families.
/// try_get is strictly typed per column, so widths are tried wide→narrow.
fn pg_cell(row: &sqlx::postgres::PgRow, i: usize) -> RawCell {
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
        return RawCell::Int(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<i32>, _>(i) {
        return RawCell::Int(v as i64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<i16>, _>(i) {
        return RawCell::Int(v as i64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
        return RawCell::Float(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f32>, _>(i) {
        return RawCell::Float(v as f64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(i) {
        return RawCell::Int(v as i64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(i) {
        return RawCell::Text(v);
    }
    RawCell::Null
}

/// MySQL variant — the protocol is width-tolerant, so the cascade is short.
fn my_cell(row: &sqlx::mysql::MySqlRow, i: usize) -> RawCell {
    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(i) {
        return RawCell::Int(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(i) {
        return RawCell::Float(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(i) {
        return RawCell::Int(v as i64);
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(i) {
        return RawCell::Text(v);
    }
    RawCell::Null
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_schemes() {
        assert_eq!(detect("postgres://u:p@h/db"), Some(Dialect::Postgres));
        assert_eq!(detect("POSTGRESQL://u@h/db"), Some(Dialect::Postgres));
        assert_eq!(detect("mysql://u:p@h/db"), Some(Dialect::MySql));
        assert_eq!(detect("mariadb://h/db"), Some(Dialect::MySql));
        assert_eq!(detect("sqlite:///a.db"), None);
        assert_eq!(detect("/plain/path.db"), None);
        assert_eq!(detect("ftp://h"), None);
        assert!(is_remote("MYSQL://h/db"));
        assert!(!is_remote("/tmp/x.db"));
    }

    #[test]
    fn redact_masks_password_only() {
        assert_eq!(
            redact("postgres://alice:s3cret@db.internal:5432/shop"),
            "postgres://alice:***@db.internal:5432/shop"
        );
        assert_eq!(redact("mysql://bob@host/db"), "mysql://bob:***@host/db");
        assert_eq!(redact("postgres://host/db"), "postgres://host/db");
        assert_eq!(redact("/local/file.db"), "/local/file.db");
        // The secret must not survive anywhere.
        assert!(!redact("postgres://a:topsecret@h/d").contains("topsecret"));
    }

    #[test]
    fn quoting_escapes_embedded_quotes() {
        assert_eq!(quote_ident(Dialect::Postgres, "or\"der"), "\"or\"\"der\"");
        assert_eq!(quote_ident(Dialect::MySql, "or`der"), "`or``der`");
        assert_eq!(quote_ident(Dialect::Postgres, "plain"), "\"plain\"");
    }

    #[test]
    fn temporal_and_unsupported_classification() {
        for dt in ["timestamp with time zone", "date", "uuid", "interval"] {
            assert!(pg_is_temporal(dt), "{dt}");
        }
        assert!(!pg_is_temporal("integer"));
        assert!(pg_is_unsupported("bytea"));
        assert!(pg_is_unsupported("ARRAY"));
        assert!(pg_is_unsupported("_text"));
        for dt in ["datetime", "year"] {
            assert!(my_is_temporal(dt));
        }
        assert!(my_is_unsupported("longblob"));
        assert!(!my_is_unsupported("json"));
    }
}
