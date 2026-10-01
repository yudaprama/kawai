//! Seed the remote Turso tool catalog with the supervisor's merged tool
//! definitions (same composition the planner sees in `auto` mode).
//!
//! Idempotent and incremental: re-running with a wider feature set adds the
//! missing tools; existing rows are upserted in place. Pass `--prune` to also
//! delete rows that are no longer part of the merged toolset (renames,
//! removed tools, RPC-only entries).
//!
//! Embeddings use the LOCAL LiteRT embedder (`build_litert_embedder()`) —
//! the same fixed space plan-time queries run in. Never mix providers here.
//! at plan time, so writer and reader share one vector space on this machine.
//! Toolset composition lives in `catalog_composition.rs` (shared with
//! `tool_catalog_drift_check.rs` — exactly one copy).
//!
//! Requires:
//!   --features litert,binance,codegraph,monad
//!                            (the domain tool builders are feature-gated;
//!                             every feature that the runtime registry can
//!                             include MUST be on here, or its tools silently
//!                             drop out of the catalog)
//!   KAWAI_TURSO_DB_URL       (from .env; env overrides the baked read-only
//!                             constants — only needed if the DB differs)
//!   KAWAI_TURSO_WRITE_TOKEN  (full-access token — NEVER baked; generate with
//!                             `turso db tokens create kawai-tool-catalog`)
//!
//! Usage: runs locally (write token via `KAWAI_TURSO_WRITE_TOKEN` in `.env`)
//!   on the user's explicit request — it is a heavy build. `.github/workflows/ci.yml`
//!   drift-gates every CI and auto-seeds additively on drift; for `--prune`
//!   (renames/deletions) run locally or dispatch that workflow manually
//!   (Actions → ci → Run workflow) with the `prune` input checked.

#[path = "catalog_composition.rs"]
mod composition;
#[path = "common/mod.rs"]
mod common;

fn main() {
    #[cfg(feature = "litert")]
    common::run_async("seed_tool_catalog", run());
    #[cfg(not(feature = "litert"))]
    {
        eprintln!("[seed_tool_catalog] FAIL: rebuild with --features litert (domain tool builders are litert-gated)");
        std::process::exit(1);
    }
}

#[cfg(feature = "litert")]
async fn run() -> Result<(), String> {
    use kawai_tool_catalog::RemoteConfig;

    let prune = std::env::args().any(|a| a == "--prune");

    let url = std::env::var("KAWAI_TURSO_DB_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            let baked = kawai_constants::turso::get_db_url();
            (!baked.trim().is_empty()).then_some(baked)
        })
        .ok_or("KAWAI_TURSO_DB_URL not set and no baked constant")?;
    let write_token = std::env::var("KAWAI_TURSO_WRITE_TOKEN")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or("KAWAI_TURSO_WRITE_TOKEN not set — generate a full-access token:\n  turso db tokens create kawai-tool-catalog")?;

    let definitions = composition::merged_definitions().await?;
    let names: Vec<String> = definitions.iter().map(|d| d.name.clone()).collect();
    println!(
        "[seed] merged catalog: {} tools (remote LLM configured: {}, prune: {prune})",
        names.len(),
        remote_llm::RemoteLlm::from_env().is_some()
    );

    // Upsert into the same replica the app syncs from (see sync_probe.rs).
    if let Some(dir) = kawai_paths::tauri_app_data_dir(kawai_paths::APP_IDENTIFIER) {
        kawai_paths::set_data_root(dir);
    }
    // Embed name + description with the LOCAL LiteRT embedder so the seeded
    // vector space matches what plan-time narrowing queries against (the
    // planner uses `build_litert_embedder()` — same helper, same space).
    let model = kawai_embedding::build_litert_embedder();
    let texts: Vec<String> = definitions
        .iter()
        .map(|d| format!("{}: {}", d.name, d.description))
        .collect();
    println!("[seed] embedding {} tools…", texts.len());
    let embeddings = model
        .embed_strings(texts)
        .await
        .map_err(|e| format!("embed: {e}"))?;
    if embeddings.len() != definitions.len() {
        return Err(format!(
            "embed count mismatch: {} embeddings for {} tools",
            embeddings.len(),
            definitions.len()
        ));
    }
    let dims = embeddings.first().map(|v| v.len()).unwrap_or(0);
    println!("[seed] embedding dimension: {dims}");

    let entries: Vec<(kawai_tool_catalog::CatalogTool, Vec<f64>)> = definitions
        .into_iter()
        .zip(embeddings)
        .map(|(def, embedding)| {
            (
                kawai_tool_catalog::CatalogTool {
                    kind: composition::catalog_kind(&def.name).to_string(),
                    name: def.name,
                    description: def.description,
                    input_schema: def.parameters.to_string(),
                },
                embedding,
            )
        })
        .collect();

    let cfg = RemoteConfig { url, auth_token: write_token };
    // Optional offline dump: write the seeded rows as plain SQL so the catalog
    // can be imported into ANY libsql/sqld instance (local dev, a self-hosted
    // VPS) without ever reading the primary DB. CI uploads this as an artifact.
    if let Ok(dump_path) = std::env::var("KAWAI_SEED_DUMP") {
        if !dump_path.is_empty() {
            write_dump(&dump_path, &entries)?;
            println!("[seed] dump written: {dump_path}");
        }
    }

    let catalog = kawai_tool_catalog::Catalog::open_remote(&cfg).await?;
    let synced = catalog.sync().await.unwrap_or(0);
    println!("[seed] replica sync: {synced} frames applied");

    catalog.upsert_tools(&entries).await?;
    println!("[seed] upserted {} tools", entries.len());

    if prune {
        let deleted = catalog.prune_tools(&names).await?;
        println!("[seed] pruned {deleted} stale row(s)");
    } else {
        println!("[seed] prune skipped (pass -- --prune to delete rows no longer in the merged toolset)");
    }

    println!(
        "[seed] DONE. Verify on the remote:\n  turso db shell kawai-tool-catalog \"SELECT COUNT(*) FROM tool_catalog\""
    );
    Ok(())
}

/// Render the seeded entries as idempotent upsert SQL. Embeddings are stored
/// as little-endian float32 blobs, matching `tool-catalog`'s on-disk format
/// (`vec_to_le_bytes`). Import order: provision the table first (kawai's
/// `ensure_schema`/`upsert_tools` does this on first use), then apply the dump.
fn write_dump(
    path: &str,
    entries: &[(kawai_tool_catalog::CatalogTool, Vec<f64>)],
) -> Result<(), String> {
    use std::fmt::Write as _;
    let mut out = String::from(
        "-- tool_catalog dump (generated by seed_tool_catalog KAWAI_SEED_DUMP)\n\
         -- Self-contained: provisions the table, vector index and FTS mirror,\
         \\n then upserts every row. Apply to any sqld/libsql instance.\n\
         CREATE TABLE IF NOT EXISTS tool_catalog (\
             name TEXT PRIMARY KEY, description TEXT NOT NULL, input_schema TEXT NOT NULL,\
             kind TEXT NOT NULL DEFAULT 'pure', embedding FLOAT32(768));\n\
         CREATE INDEX IF NOT EXISTS tool_catalog_embedding_idx \
             ON tool_catalog (libsql_vector_idx(embedding));\n\
         CREATE VIRTUAL TABLE IF NOT EXISTS tool_catalog_fts USING fts5(content, tokenize='unicode61');\n\
         CREATE TRIGGER IF NOT EXISTS tool_catalog_fts_ai AFTER INSERT ON tool_catalog BEGIN \
             INSERT INTO tool_catalog_fts(rowid, content) VALUES (NEW.rowid, NEW.name || ' ' || NEW.description); END;\n\
         CREATE TRIGGER IF NOT EXISTS tool_catalog_fts_ad AFTER DELETE ON tool_catalog BEGIN \
             DELETE FROM tool_catalog_fts WHERE rowid = OLD.rowid; END;\n\
         CREATE TRIGGER IF NOT EXISTS tool_catalog_fts_au AFTER UPDATE ON tool_catalog BEGIN \
             DELETE FROM tool_catalog_fts WHERE rowid = OLD.rowid; \
             INSERT INTO tool_catalog_fts(rowid, content) VALUES (NEW.rowid, NEW.name || ' ' || NEW.description); END;\n",
    );
    for (tool, embedding) in entries {
        let mut bytes = Vec::with_capacity(embedding.len() * 4);
        for v in embedding {
            bytes.extend_from_slice(&(*v as f32).to_le_bytes());
        }
        let mut hex = String::with_capacity(bytes.len() * 2);
        for b in &bytes {
            let _ = write!(hex, "{b:02x}");
        }
        let esc = |s: &str| s.replace('\'', "''");
        let _ = writeln!(
            out,
            "INSERT INTO tool_catalog (name, description, input_schema, kind, embedding) \
             VALUES ('{}', '{}', '{}', '{}', x'{}') \
             ON CONFLICT(name) DO UPDATE SET description=excluded.description, \
             input_schema=excluded.input_schema, kind=excluded.kind, embedding=excluded.embedding;",
            esc(&tool.name),
            esc(&tool.description),
            esc(&tool.input_schema),
            esc(&tool.kind),
            hex
        );
    }
    std::fs::write(path, out).map_err(|e| format!("seed dump write: {e}"))?;
    Ok(())
}
