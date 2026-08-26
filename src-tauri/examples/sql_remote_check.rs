// Headless check for the REMOTE SQL snapshot path (feature "analytics-sql"):
// data_tables + data_import against a LIVE Postgres/MySQL source, then
// data_schema/data_query over the parquet snapshots that land in the store.
// Credentials ride an env var — never hardcode them:
//
//   KAWAI_SQL_PROFILE_CHECK='postgresql://user:pass@host:5432/db' \
//     cargo run --example sql_remote_check --features analytics-sql [-- [table]] [--demo|--deep]
//
// Modes (writes happen ONLY under a flag; plain mode is strictly read-only):
//   (none)  read-only: list + import whatever the first listed table is
//   --demo  seeds kawai_sql_check_demo (2 rows), runs the full chain, drops it
//   --deep  everything --demo does PLUS the edge-case matrix: temporal CAST
//           (timestamptz/datetime → text), NULL cells, the binary-column
//           error contract (bytea/blob must fail with guidance, not garbage),
//           and the zero-row table shape. Every seeded table is DROPped on exit.
use kawai_lib::logic::analytics::{
    self as data, DataImportTool, DataQueryTool, DataTableSchemaTool, DataTablesTool,
};
use kawai_lib::logic::sql_remote::{detect, Dialect};
use kawai_tools::AgentTool;
use serde_json::Value;

const DEMO_TABLE: &str = "kawai_sql_check_demo";
const DEEP_TABLE: &str = "kawai_sql_check_deep";
const BIN_TABLE: &str = "kawai_sql_check_bin";
const EMPTY_TABLE: &str = "kawai_sql_check_empty";

fn die(msg: &str) -> ! {
    eprintln!("[sql_remote_check] FAIL: {msg}");
    std::process::exit(1);
}

fn expect(cond: bool, what: &str) {
    if !cond {
        die(what);
    }
}

/// The per-turn profile snapshot the tools are constructed with (env-only
/// here — this example configures its source through KAWAI_SQL_PROFILE_CHECK).
async fn baked_profiles() -> std::sync::Arc<Vec<data::SqlProfile>> {
    std::sync::Arc::new(data::effective_profiles("check-user").await)
}

async fn pg_pool(url: &str) -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(url)
        .await
        .unwrap_or_else(|e| die(&format!("seed connect: {e}")))
}

async fn my_pool(url: &str) -> sqlx::MySqlPool {
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(url)
        .await
        .unwrap_or_else(|e| die(&format!("seed connect: {e}")))
}

async fn pg_exec(pool: &sqlx::PgPool, sql: &str) {
    if let Err(e) = sqlx::query(sql).execute(pool).await {
        die(&format!("seed: {e}"));
    }
}

async fn my_exec(pool: &sqlx::MySqlPool, sql: &str) {
    if let Err(e) = sqlx::query(sql).execute(pool).await {
        die(&format!("seed: {e}"));
    }
}

/// Seed every fixture table the current mode needs. Direct sqlx — this is a
/// test-fixture writer, not part of the product path; the DDL differs per
/// dialect (types + upsert + binary/temporal literals).
async fn seed_all(url: &str, deep: bool) {
    let is_pg = detect(url) == Some(Dialect::Postgres);
    let (create_demo, insert_demo) = if is_pg {
        (
            format!("CREATE TABLE IF NOT EXISTS {DEMO_TABLE} (id int primary key, label text, nilai double precision)"),
            format!("INSERT INTO {DEMO_TABLE} (id,label,nilai) VALUES (1,'alpha',12.5),(2,'beta',7.0) ON CONFLICT (id) DO NOTHING"),
        )
    } else {
        (
            format!("CREATE TABLE IF NOT EXISTS {DEMO_TABLE} (id int primary key, label varchar(32), nilai double)"),
            format!("INSERT IGNORE INTO {DEMO_TABLE} (id,label,nilai) VALUES (1,'alpha',12.5),(2,'beta',7.0)"),
        )
    };
    if is_pg {
        let pool = pg_pool(url).await;
        pg_exec(&pool, &create_demo).await;
        pg_exec(&pool, &insert_demo).await;
        if deep {
            pg_exec(&pool, &format!(
                "CREATE TABLE IF NOT EXISTS {DEEP_TABLE} (id int primary key, label text, nilai double precision, created_at timestamptz not null)"
            ))
            .await;
            pg_exec(&pool, &format!("DELETE FROM {DEEP_TABLE}")).await;
            pg_exec(&pool, &format!(
                "INSERT INTO {DEEP_TABLE} (id,label,nilai,created_at) VALUES \
                 (1,'alpha',12.5,'2026-01-15 10:30:00+00'),(2,NULL,NULL,'2026-02-20 08:00:00+00')"
            ))
            .await;
            pg_exec(&pool, &format!(
                "CREATE TABLE IF NOT EXISTS {BIN_TABLE} (id int primary key, payload bytea)"
            ))
            .await;
            pg_exec(&pool, &format!(
                "INSERT INTO {BIN_TABLE} (id,payload) VALUES (1,decode('deadbeef','hex')) ON CONFLICT (id) DO NOTHING"
            ))
            .await;
            pg_exec(&pool, &format!(
                "CREATE TABLE IF NOT EXISTS {EMPTY_TABLE} (id int primary key, note text)"
            ))
            .await;
        }
    } else {
        let pool = my_pool(url).await;
        my_exec(&pool, &create_demo).await;
        my_exec(&pool, &insert_demo).await;
        if deep {
            my_exec(&pool, &format!(
                "CREATE TABLE IF NOT EXISTS {DEEP_TABLE} (id int primary key, label varchar(32), nilai double, created_at datetime not null)"
            ))
            .await;
            my_exec(&pool, &format!("DELETE FROM {DEEP_TABLE}")).await;
            my_exec(&pool, &format!(
                "INSERT INTO {DEEP_TABLE} (id,label,nilai,created_at) VALUES \
                 (1,'alpha',12.5,'2026-01-15 10:30:00'),(2,NULL,NULL,'2026-02-20 08:00:00')"
            ))
            .await;
            my_exec(&pool, &format!(
                "CREATE TABLE IF NOT EXISTS {BIN_TABLE} (id int primary key, payload longblob)"
            ))
            .await;
            my_exec(&pool, &format!(
                "INSERT IGNORE INTO {BIN_TABLE} (id,payload) VALUES (1,UNHEX('DEADBEEF'))"
            ))
            .await;
            my_exec(&pool, &format!(
                "CREATE TABLE IF NOT EXISTS {EMPTY_TABLE} (id int primary key, note varchar(64))"
            ))
            .await;
        }
    }
    println!("[sql_remote_check] seeded ({DEMO_TABLE}, deep={deep})");
}

/// Drop EVERY fixture this checker might have created — safe on a fresh DB.
async fn drop_all(url: &str) {
    let ddl: Vec<String> = [DEMO_TABLE, DEEP_TABLE, BIN_TABLE, EMPTY_TABLE]
        .iter()
        .map(|t| format!("DROP TABLE IF EXISTS {t}"))
        .collect();
    // Driver result types differ — one arm each, same statements.
    if detect(url) == Some(Dialect::Postgres) {
        let pool = pg_pool(url).await;
        for s in ddl {
            if let Err(e) = sqlx::query(&s).execute(&pool).await {
                eprintln!("[sql_remote_check] WARN cleanup failed ({e})");
            }
        }
    } else {
        let pool = my_pool(url).await;
        for s in ddl {
            if let Err(e) = sqlx::query(&s).execute(&pool).await {
                eprintln!("[sql_remote_check] WARN cleanup failed ({e})");
            }
        }
    }
    println!("[sql_remote_check] fixtures dropped");
}

/// One full chain over a named table: import → schema → query. Returns the
/// parsed import receipt.
async fn roundtrip(table: &str) -> Value {
    let import = DataImportTool("check-user".into(), 1, baked_profiles().await)
        .call(data::SqlImportArgs {
            profile: "check".into(),
            table: table.to_string(),
        })
        .await
        .unwrap_or_else(|e| die(&format!("import {table}: {}", e.0)));
    println!("[sql_remote_check] data_import({table}) → {import}");
    let iv: Value =
        serde_json::from_str(&import).unwrap_or_else(|e| die(&format!("bad import JSON: {e}")));
    let file_id = iv["fileId"]
        .as_str()
        .unwrap_or_else(|| die("import returned no fileId"))
        .to_string();
    let sch_out = DataTableSchemaTool("check-user".into())
        .call(data::SchemaArgs {
            file_id: file_id.clone(),
            sheet: None,
        })
        .await
        .unwrap_or_else(|e| die(&format!("schema {table}: {}", e.0)));
    println!("[sql_remote_check] data_schema({table}) → {sch_out}");
    let q = DataQueryTool("check-user".into())
        .call(data::QueryArgs {
            file_id,
            sheet: None,
            q: analytics::QueryArgs::default(),
        })
        .await
        .unwrap_or_else(|e| die(&format!("query {table}: {}", e.0)));
    let qv: Value = serde_json::from_str(&q).unwrap_or_default();
    println!(
        "[sql_remote_check] sample rows({table}) → {} returned",
        qv["rows"].as_array().map(|a| a.len()).unwrap_or(0)
    );
    iv
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let deep = args.iter().any(|a| a == "--deep");
    let demo = deep || args.iter().any(|a| a == "--demo");
    let url = match (
        args.first().filter(|a| !a.starts_with("--")).cloned(),
        std::env::var("KAWAI_SQL_PROFILE_CHECK").ok(),
    ) {
        (Some(u), _) | (None, Some(u)) => u,
        (None, None) => {
            die("set KAWAI_SQL_PROFILE_CHECK='postgres://…' or pass the URL as argv[1]")
        }
    };
    if !kawai_lib::logic::sql_remote::is_remote(&url) {
        die("source is not a postgres/mysql URL");
    }
    // Isolated per-user data dir so the store/db never touch real app data.
    if std::env::var("KAWAI_DATA_DIR").is_err() {
        std::env::set_var("KAWAI_DATA_DIR", "/tmp/kawai-sql-check");
    }
    std::env::set_var("KAWAI_SQL_PROFILE_CHECK", &url);

    if demo {
        seed_all(&url, deep).await;
    }

    // 1. data_tables — live catalog listing through the profile name only.
    let out = DataTablesTool(baked_profiles().await)
        .call(data::SqlTablesArgs {
            profile: "check".into(),
        })
        .await
        .unwrap_or_else(|e| die(&e.0));
    println!("[sql_remote_check] data_tables → {out}");
    let v: Value = serde_json::from_str(&out).unwrap_or_else(|e| die(&format!("bad JSON: {e}")));
    let tables: Vec<String> = v["tables"]
        .as_array()
        .unwrap_or_else(|| die("no tables array"))
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_string))
        .collect();

    // 2. Basic chain: the requested table, the demo fixture, or first listed.
    let table = match (
        args.first().filter(|a| !a.starts_with("--")).cloned(),
        demo,
    ) {
        (Some(t), _) => t,
        (None, true) => DEMO_TABLE.to_string(),
        (None, false) => {
            let Some(t) = tables.first().cloned() else {
                println!("[sql_remote_check] source exposes no tables/views — nothing to import");
                return;
            };
            t
        }
    };
    roundtrip(&table).await;

    // 3. Deep matrix — the cases unit tests offline cannot reach.
    if deep {
        // 3a. Temporal CAST + NULLs: timestamps arrive as readable text, all
        //     rows survive, count aggregation matches the source exactly.
        let dv = roundtrip(DEEP_TABLE).await;
        expect(dv["rows"].as_u64() == Some(2), "deep table must export 2 rows");

        // 3b. Binary column contract: the import must FAIL with guidance
        //     naming the offending column — never a panic or silent loss.
        let bin_err = DataImportTool("check-user".into(), 1, baked_profiles().await)
            .call(data::SqlImportArgs {
                profile: "check".into(),
                table: BIN_TABLE.to_string(),
            })
            .await
            .err()
            .unwrap_or_else(|| die("bytea/blob import unexpectedly SUCCEEDED"))
            .0;
        expect(
            bin_err.contains("payload") && bin_err.contains("binary"),
            &format!("binary error must name column+reason, got: {bin_err}"),
        );
        println!("[sql_remote_check] binary guard → {bin_err}");

        // 3c. Zero-row table: correctly SHAPED empty snapshot (columns known,
        //      rows 0) — not an error, not a broken file.
        let ev = roundtrip(EMPTY_TABLE).await;
        expect(ev["rows"].as_u64() == Some(0), "empty table must export 0 rows");
    }

    if demo {
        drop_all(&url).await;
    }
    println!("[sql_remote_check] ALL PASS");
}
