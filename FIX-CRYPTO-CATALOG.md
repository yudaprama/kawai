# FIX: crypto_* tools missing embeddings in Turso catalog

## Context

We renamed Binance tools from `binance_*` → `crypto_*` in both Rust code and the
Turso tool catalog. The rename itself is DONE and compiles clean. But the 4 new
`crypto_*` tools in the Turso catalog were inserted via raw SQL WITHOUT embeddings,
so the planner's vector search (`WHERE embedding IS NOT NULL`) excludes them entirely.

Stock tools (`get_stock_price`, `get_stock_history`, `get_stock_quote`,
`get_stock_detail`) have embeddings from the original seed → they appear in both
vector AND BM25 results → higher RRF rank → planner picks them for crypto queries.

## What's broken

```
# These tools have NO embedding (embedding IS NULL):
crypto_price
crypto_depth
crypto_klines
crypto_ta_analyze

# These tools HAVE embeddings:
get_stock_price
get_stock_history
get_stock_quote
get_stock_detail
```

Result: planner search for "what's the price of bitcoin" returns `get_stock_price`
instead of `crypto_price`. Plan validation then rejects `get_crypto_price`
(hallucinated name) as "unknown tool".

## How the catalog is (re-)seeded

There is one procedure, and it is the only supported way to change what the
planner can discover. The 4 `crypto_*` tools were missing embeddings because
that seed predated the binance tools; the fix is a full re-seed, not a
per-tool patch.

```sh
# ADMIN token required (KAWAI_TURSO_WRITE_TOKEN in .env / 1Password).
# Clients cannot write: the shared catalog's client token carries
# perm=[all tables: data_read] and every write is rejected server-side.
KAWAI_TURSO_DB_URL='libsql://libsql://kawai-tool-catalog-yudapramad.aws-ap-south-1.turso.io' \
KAWAI_TURSO_AUTH_TOKEN="$KAWAI_TURSO_WRITE_TOKEN" \
cargo run --release --manifest-path src-tauri/Cargo.toml \
  --example seed_tool_catalog --features litert,binance,monad -- --prune
```

- Embeddings come from the **local LiteRT embedder**
  (`kawai_embedding::build_litert_embedder()`, EmbeddingGemma-2 740M, 768 dims)
  — the same space plan-time queries embed in (`supervisor.rs:877`). Never
  re-seed with a cloud embedding provider: the cosine side silently becomes
  noise instead of erroring.
- `upsert_tools` uses `ON CONFLICT(name) DO UPDATE`, so descriptions are
  overwritten — always seed from the current Rust definitions
  (`catalog_composition::merged_definitions()`), never from a stale dump.
- `--prune` deletes rows that are no longer in the merged toolset. On a shared
  catalog this affects every user at once, so read the drift output first.
- Verify with the client token (read-only, cheap):
  `cargo run --example tool_catalog_drift_check --features litert,binance,monad`
  → expects `missing=0, stale=0`.

## Files modified (already done — DO NOT RE-EDIT)

- `crates/toolsets/binance/src/lib.rs` — `crypto_price`, `crypto_depth`, `crypto_klines`
- `crates/toolsets/binance/src/ta.rs` — `crypto_ta_analyze`
- `crates/toolsets/binance/src/account.rs` — `crypto_balances`, `crypto_open_orders`
- `crates/toolsets/binance/src/registry.rs` — all name mappings
- `crates/toolsets/binance/src/agent.rs` — persona tool references
- `src-tauri/src/agent_registry.rs` — test assertion
- `src-tauri/examples/binance_smoke.rs` — all test tool names
- `frontend/src/features/workbench/components/tool-views/index.tsx`
- `frontend/src/components/ai-elements/tool-renderers/index.tsx`
- `TOOL-MAP.md`, `ARCHITECTURE.md`

## Verification after fix

1. Check embeddings exist:
```sql
sqlite3 "$HOME/Library/Application Support/pro.kawai.app/tool-catalog/catalog.db" \
  "SELECT name, embedding IS NULL FROM tool_catalog WHERE name LIKE 'crypto_%';"
-- Expected: all 4 show 0 (embedding exists)
```

2. Check planner search returns crypto tools:
```sh
LOG="$HOME/Library/Logs/kawai/app.log"
# Restart app, then search for crypto query
grep "plan_task.*search.*crypto\|plan_task.*search.*bitcoin" "$LOG" | tail -5
# Expected: crypto_price, crypto_klines, etc. in results (NOT get_stock_price)
```

3. Run binance_smoke:
```sh
cargo run --example binance_smoke --features binance
```
