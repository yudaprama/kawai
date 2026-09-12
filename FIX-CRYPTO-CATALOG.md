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

## What needs to happen

Generate 768-dim embeddings for the 4 `crypto_*` tools and upsert them into the
Turso catalog. The embeddings must use the same model as the original seed
(`kawai_embedding::build_providers_from_env()` — tries OpenRouter
`text-embedding-3-small` → NVIDIA `llama-3_2-nemoretriever-300m-embed-v1` →
Gemini `embedding-001`, each requesting 768 dims).

### Approach 1: Run seed_tool_catalog (proper fix)

```sh
# From kawai/ repo root, on a machine with litert built:
KAWAI_TURSO_WRITE_TOKEN=$(turso db tokens create kawai-tool-catalog) \
  cargo run --example seed_tool_catalog \
    --manifest-path src-tauri/Cargo.toml \
    --features litert,binance,codegraph
```

This re-seeds ALL tools with embeddings. The `ON CONFLICT(name) DO UPDATE` in
`upsert_tools` will overwrite descriptions (so use the current descriptions from
the Rust code, not the old ones).

### Approach 2: Minimal upsert script (faster)

Write a small Rust example or script that:
1. Opens the remote catalog with the write token
2. Builds the embedding provider via `kawai_embedding::build_providers_from_env()`
3. For each of the 4 crypto tools, embeds `format!("{} {}", name, description)`
4. Calls `catalog.upsert_tools(&[(tool, embedding)])` to upsert

Key details:
- Remote catalog URL: `libsql://kawai-tool-catalog-dielz.aws-ap-south-1.turso.io`
- Write token: `turso db tokens create kawai-tool-catalog`
- The `upsert_tools` method uses `ON CONFLICT(name) DO UPDATE` so it's safe to re-run
- Embedding dimension MUST be 768 (matches the `FLOAT32(768)` column)

### Approach 3: Direct SQL (if embedding provider isn't available)

If you can't build the embedding provider, you can still fix the search by
updating the stock tool descriptions to be even more discouraging for crypto:

```sql
-- Make stock descriptions explicitly say "NOT for cryptocurrency" at the START
UPDATE tool_catalog SET description = 'STOCKS ONLY — NOT for cryptocurrency. Use crypto_price for Bitcoin/ETH/SOL. Get the latest price for a stock ticker (e.g. AAPL, TSLA). Returns just the current price in USD.' WHERE name = 'get_stock_price';

UPDATE tool_catalog SET description = 'STOCKS ONLY — NOT for cryptocurrency. Use crypto_price for Bitcoin/ETH/SOL. Get the latest stock quote for a ticker symbol (e.g. AAPL, TSLA). Returns open, high, low, price, volume, previous close, change, and change percent.' WHERE name = 'get_stock_quote';

UPDATE tool_catalog SET description = 'STOCKS ONLY — NOT for cryptocurrency. Use crypto_klines for Bitcoin/ETH/SOL. Get historical daily stock prices (OHLCV) for ticker symbols (e.g. AAPL, TSLA, GOOGL). Returns date, open, high, low, close, and volume.' WHERE name = 'get_stock_history';

UPDATE tool_catalog SET description = 'STOCKS ONLY — NOT for cryptocurrency. Use crypto_price/crypto_ta_analyze for Bitcoin/ETH/SOL. Get detailed stock information including open, high, low, close, volume, 52-week range for stock tickers (e.g. AAPL, TSLA).' WHERE name = 'get_stock_detail';
```

This won't fix the vector search gap but will push stock tools down in BM25
rankings for crypto queries.

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
