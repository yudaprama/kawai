# Tool Map — Kawai

> Every agent tool registered in the supervisor era: where it lives, which agent gets it, and
> how the planner discovers it — plus how a tool's output reaches the frontend (§11). Companion
> to `AGENTS.md` (architecture) and `KNOWLEDGE_MAP.md` (retrieval internals). Present tense
> only — when a tool ships or moves, update this file in the same commit.

**TL;DR:** One tool = one `AgentTool` impl (`const NAME`, `Args`, `Output`, `Error`) in a
per-category crate. Agent definitions (`builtin.office`, `builtin.presentation`,
`builtin.analytics`, `builtin.binance`) build their toolsets via `build_tools`; the merged
`auto` registry (first-wins per name) is what the supervisor actually dispatches against. The
planner never sees the full catalog — it discovers tools through ≤2 search rounds against the
tool catalog DB (local sqld), with a small core whitelist always visible.

---

## 0. How a tool becomes callable

```
AgentTool impl (crates/*)               →  kawai_tools::ToolSet (type-erased, name-keyed)
build_tools(context, remote_configured) →  per-agent ToolSet (agent_registry.rs composes)
ToolRegistry (crates/router)            →  merged `auto` catalog, first-wins per NAME
supervisor.rs build_supervisor_registry →  what plan_task validates & execute dispatches
tool-catalog (local sqld + embedded replica) →  planner discovery (vector+BM25/RRF search)
```

Rules that hold for every tool:

- `requires_confirmation()` defaults to `false` (read-only); side-effecting tools override —
  the planner cannot disable this gate.
- Identity-carrying tools (`user_id`/`session_id`) are bound **server-side at toolset build**;
  the model can never supply them.
- Errors are content: `ToolResult::error` text feeds back into the agent loop (guidance style).

## 1. Core runtime tools (added to every agent — `add_runtime_tools`)

Source: `src-tauri/src/agent_registry.rs` → `add_runtime_tools`.

| Tool | Crate | Gate | Purpose |
|---|---|---|---|
| `memory_search` | `kawai-memory` (`memory::tools`) | always | hybrid semantic recall over L1 memories |
| `memory_graph_search` | `kawai-memory` | always | entity lookup over `memory_entities` mentions |
| `session_step_results` | `kawai-agent` (`session_history.rs`) | always | cross-run memory: read earlier runs' persisted step outputs (incl. each run's `deliverable_writer` answer) in the same session — user+session bound at toolset build |
| `artifact_recall` | `kawai-agent` | always | page back oversized TurnMemory results (`handle, offset`) |
| `codegraph_explore` / `codegraph_status` | `kawai-codegraph` (`crates/toolsets/codegraph`) | feature `codegraph` | surgical code context via sidecar (15m LRU, 12/min) |
| `deep_write` | `kawai-agent` | remote configured | cloud long-form synthesis subagent |
| `plan_task` / `plan_revise` | `kawai-agent` | remote configured | planner subagents (multi-step decomposition / revision) |
| `draft_document` | `kawai-agent` | remote configured **and** agent capability (`document_drafter`) | cloud document drafting; office only, presentation explicitly opts out |

Planner core whitelist (always visible to `plan_task`, no search needed): `web_search`,
`memory_search`, `artifact_recall`, `deep_write`, `draft_document`.

## 2. Office + PDF (`builtin.office`) — `kawai-office`

Source: `crates/engines/office/src/lib.rs` (`office_toolset`) + `agent_registry.rs::office_tools`
(which adds `knowledge_search`, graph tools, then runtime tools). `document_drafter: true` →
gets `draft_document`.

| Tool | Purpose |
|---|---|
| `office_list_files` | list files in the per-user docs store |
| `office_create_document` | create docx/xlsx/pptx (office_oxide) |
| `office_read_document` | read back as markdown |
| `office_document_info` | metadata / structure info |
| `office_edit_document` | in-place declarative edit (oxml surgery) |
| `office_restore_backup` | restore prior version from backup store |
| `pdf_extract_text` | text extraction (OCR fallback on empty native text) |
| `pdf_search_text` | regex search over PDF |
| `pdf_replace_text` | DOM-based token substitution (no reflow) |
| `pdf_merge` / `pdf_split` / `pdf_info` | structural PDF ops |
| `pdf_create_from_markdown` | markdown → PDF |
| `knowledge_search` | RAG over session files (`hybrid`/`semantic`/`keyword`, model picks mode) |
| `graph_search` | GraphRAG 5 arms (`naive`/`local`/`global`/`mix`/`hybrid`) — **RPC-only by design; not registered in the chat toolset** (see `KNOWLEDGE_MAP.md` §0) |

## 3. Presentation (`builtin.presentation`) — `presentation_toolset`

Deck-only subset + reading; no document editing, no PDF mutation. `document_drafter: false` →
no `draft_document`. Also gets `knowledge_search` + webread (when any engine) + runtime tools.

| Tool | Purpose |
|---|---|
| `office_create_deck` | template-seeded reveal.js deck (SYSTEM-owned rotating pack; `probe_deck` gate); `office_apply_template` re-themes a stored deck in place |
| `office_export_deck` | deck → `.pptx` (deterministic, no LLM) |
| `office_list_files` / `office_read_document` / `office_document_info` | source reading |
| `pdf_extract_text` / `pdf_info` | read-only PDF |

## 4. Analytics (`builtin.analytics`) — `kawai-analytics-tools`

Source: `crates/toolsets/analytics-tools/src/lib.rs::toolset`. Gets runtime tools but not
webread/knowledge.

| Tool | Purpose |
|---|---|
| `data_schema` | columns, dtypes, samples, sheet list (required before first `data_query`) |
| `data_query` | structured filter→group→aggregate→sort→limit over a stored file |
| `data_query_nl` | plain-English → structured query (LLM translated) |
| `data_ta` | TA indicator folds (SMA/EMA/RSI/MACD/BBands), final values only; output marked `kind:"ta"` + `_meta.lastClose`/`_meta.source` |
| `data_fetch` | Binance public klines → typed csv in the office store, returns `fileId` (keyless, DoH) — the chain entry for crypto TA |
| `data_chart` | charton SVG render; saved into the office store as session-associated svg |
| `office_list_files` | id discovery (same tool as office) |
| `data_tables` | registered SQL source → typed parquet snapshot (only when `sql_profiles` non-empty) |
| `data_import` | snapshot a validated SQL source into the office store (same gate) |

## 5. Binance (`builtin.binance`) — `crates/toolsets/binance` (feature `binance`)

Keyless public spot market data + in-process TA. Signed reads (spot account,
US-stocks, futures) resolve credentials PER USER: the user's own keys from
Settings → Binance API (stored in their local DB, migration 0027) with the
product-baked kawai-vault pair as fallback; a user with neither gets a
guidance error naming Settings, and the tools register unconditionally (an
invisible tool can't tell the user what to do — a guidance error can). Also
gets webread + runtime tools (`supports_draft_document: false`). The
advisory tools (stop-loss / take-profit / audit klines) ride a KEYLESS fapi
client — only the mirror sync needs credentials at all.

`crypto_price` is tiered — Binance REST first, then a CoinMarketCap quotes
tier (vault Pro key, same pattern as web_search's tiers) when Binance is
unreachable; `_source` names the serving tier. `crypto_klines` is
Binance-only: its CMC OHLCV endpoint is plan-gated on the key's current plan
(403/1006) and is excluded from generation (`PLAN_GATED` in
`coinmarketcap/tools/gen.py`), so an unreachable Binance fails the step with
the reason.

| Tool | Purpose |
|---|---|
| `crypto_price` | current price / 24hr ticker |
| `crypto_klines` | OHLCV candles |
| `crypto_depth` | order book |
| `crypto_ta_analyze` | indicator suite over klines |
| `crypto_balances` / `crypto_open_orders` | read-only account tools — signed via the baked kawai-vault read-only pair (never trade permission) |
| `stock_quote` / `stock_info` | Binance Stocks US-equity bid/ask quote + symbol metadata — same baked kawai-vault pair |
| `binance_futures_positions` | open futures positions + their open orders incl. stop-losses / take-profits, mirrored into `binance_futures_positions` / `binance_futures_open_orders` — BOTH markets: USDⓈ-M (`fapi`) AND COIN-M (`dapi`) — see §5.1 |
| `crypto_futures_stop_loss` / `crypto_futures_take_profit` | per-position advisory stop (CE/Donchian/Keltner + ratchet vs the advice history table) and R-multiple TP ladder, graded against the resting orders |
| `binance_futures_risk_audit` | ONE-call portfolio risk review: sync → grade the biggest USDⓈ-M positions with the SAME stop policy → TP coverage → summary (naked positions, naked notional, R:R) — see §5.2 |

### 5.1 `binance_futures_positions` — the local futures mirror

The one Binance tool that WRITES. Signed reads on both market families —
`/fapi/v3/positionRisk` + `/fapi/v1/openOrders` (USDⓈ-M, USDT-settled) and
`/dapi/v1/positionRisk` + `/dapi/v1/openOrders` (COIN-M, coin-settled) —
mirror the OPEN set into two per-user SQLite tables,
`binance_futures_positions` (migrations 0022 + 0025) and
`binance_futures_open_orders`, then report both. Every row carries a
`margin` tag (`USDM` | `COINM`).

- **Why the local copy.** The live APIs only ever answer "what is open right
  now". Without a mirror, every question about a position's mark/entry drift
  is unanswerable the moment the next sync overwrites it — and the agent has
  no other way to see futures exposure at all (spot tools do not carry it).
- **Exact mirror, not append-only.** Each sync stamps the rows it wrote with
  the current unix second and deletes every row carrying an older stamp, so a
  position or order closed on the exchange disappears locally with no
  tombstone table. Both tables are written in ONE transaction: a failed write
  can never leave a half-pruned set behind.
- **Rerun semantics.** A rerun NEVER reuses the DB to skip the exchange —
  every sync re-fetches the full open set (4 signed reads) because the mirror
  answers "what is open RIGHT NOW"; reusing stale rows to save calls would
  produce wrong answers, which defeats the mirror's purpose. Reuse happens at
  the ROW level instead: the upsert updates still-open rows in place (same
  PK, no duplicates) and overwrites their values with fresh data. Reruns are
  idempotent (verified live: identical counts, zero duplicate rows). Edge
  case, accepted: the stamp is second-granular, so two syncs inside the same
  unix second leave rows from the first sync un-pruned until the next sync —
  delayed pruning by at most one cycle, never corruption.
- **Rate budget (per-process): 6 syncs/min.** Each sync spends 4 signed
  exchange reads (2 markets × position + orders), and the mirror re-fetches
  the FULL open set by design — so a stuck agent retry loop would burn reads
  without bound. Same sliding-window shape as the codegraph tool's limiter;
  attempts are counted (a failed sync spends the reads too), the check runs
  BEFORE the fetches, and a poisoned lock fails CLOSED. The budget lives on
  `sync_mirror`, so the stop-loss advisory tool is bounded by the same pool —
  and deterministic callers (examples, cron-style binaries) inherit it for
  free. The rejection is guidance, not a dead end: the local mirror stays
  readable and the next window flows.
- **Positions are keyed `(margin, symbol, positionSide)`** — hedge mode
  reports LONG and SHORT for one symbol, one-way mode reports BOTH.
  Zero-`positionAmt` rows are dropped: `positionRisk` answers with every
  tradable symbol, and only the non-zero ones are positions.
- **Orders are keyed `(margin, orderId)`** — exchange-assigned and stable
  across amends, unlike the (symbol, side, price) triple, which collides when
  two orders rest at the same level. The `margin` half of the key is
  load-bearing: dapi and fapi order ids are independent counters and DO
  collide numerically. `positionSide` is carried so an order joins to its
  position.
- **Stop-losses and take-profits are the reason the orders table exists.**
  They are not fields on a position — they are resting `STOP_MARKET` /
  `TAKE_PROFIT_MARKET` orders, so "what is my protection?" is unanswerable
  from `positionRisk` alone. `orderType` alone still does not say whether a
  LIMIT adds risk or cuts it, so each row stores a derived `intent`
  (`classify_intent`): `ENTRY` (same side as the position, not
  reduce-only), `STOP_LOSS`, `TAKE_PROFIT`, `EXIT` (opposite side or
  reduce-only), `CLOSE` (closePosition).
- **COIN-M specifics** (`dapi`, coin-settled): the dapi position model has no
  `notional` / `isolatedWallet` / `adl` / `marginAsset` — the first three are
  stored as 0, and `marginAsset` is derived from the symbol prefix
  (`BTCUSD_PERP` → BTC). PnL is denominated in the settlement coin, NOT
  USDT: `totalUnrealizedPnl` in the report stays USDⓈ-M-only (summing across
  units is meaningless), and COIN-M PnL lands in
  `coinmUnrealizedPnlByAsset` ({BTC: …, ETH: …}). Migration 0025 rebuilt the
  two tables around the `margin` column — safe because they are exact
  mirrors, fully rewritten by the next sync.
- **Storage is the existing per-user DB**, not a second SQLite file:
  `kawai_db::db_connection(user_id)` is what a toolset crate already uses
  (`crates/toolsets/analytics-tools`), it inherits the migration runner and
  the structural per-user isolation (no `user_id` column), and the sqld
  multi-device roadmap targets that file — a new database would be orphaned
  by both.
- **`user_id` is bound at toolset build** from `AgentContext`, never supplied
  by the model, so a sync can only ever write into the caller's own database.

### 5.2 `binance_futures_risk_audit` — the one-call risk review

The workflow wrapper over everything in §5.1 + the advisory tools: sync the
mirror, grade the biggest USDⓈ-M positions with the SAME stop policy
(`stop_advice` + the advice-history ratchet — one policy, not a second
opinion), check take-profit coverage from the resting `TAKE_PROFIT` intents,
and roll up a portfolio summary. Deterministic end-to-end: the LLM (or a cron
binary — it is a plain Rust call) makes ONE call and gets the whole risk
picture, so there is no multi-tool choreography to get wrong.

- **Coverage is direction-aware.** A resting stop on the wrong side of the
  mark (already crossed) is a ghost order that protects nothing — it does not
  count as coverage, and neither does a stop closer than 0.2% to the mark
  (at-market is a fill waiting to happen). R:R = TP distance / SL distance
  from the mark, using the NEAREST resting TP; `null` when either leg is
  missing, never a faked number.
- **Top-N by notional, honestly.** A klines fold per position is a real
  cost, so the audit grades `limit` (default 25, max 50) LARGEST exposures
  first and says exactly how many it skipped; skipped positions are still
  COUNTED in the coverage summary from the resting orders alone. One
  position's klines failure degrades to an error row — it never aborts the
  audit.
- **COIN-M is counted, not audited.** The dapi kline endpoint is not wired in
  this toolset; COIN-M positions appear in the summary and their coin PnL in
  `coinmUnrealizedPnlByAsset`, explicitly labeled not-audited — a half-audit
  that pretends to be whole would be worse than one that says what it
  skipped.
- **Advice history is shared** with the stop-loss/take-profit tools (same
  `binance_futures_advice` table, `kind = 'stop_loss'`), so the monotonic
  ratchet carries across entry points.

## 5b. Monad (`builtin.monad`) — `crates/toolsets/monad-tools` (feature `monad`)

Strictly read-only Monad EVM reads over `kawai-monad` (alloy). RPC + contract
addresses come from `logic::monad_contracts` (NETWORKS.md mirror) and are
pinned at toolset build — the model never supplies an RPC URL. The device
wallet address is bound at construction (desktop keychain); every tool
prompt-free. Also gets webread + runtime tools.

| Tool | Purpose |
|---|---|
| `monad_wallet_status` | one-call wallet snapshot: native MON + stablecoin + KAWAI balances via the canonical Multicall3 aggregate, with block height |
| `monad_token_balance` | ERC-20 balance for a (token, wallet) pair — "usdt"/"kawai" presets or an address; raw + human-readable |
| `monad_token_info` | ERC-20 symbol + decimals |
| `monad_gas_price` | current gas price (gwei) |
| `monad_chain_status` | latest block number + chain id |
| `monad_tx_receipt` | tx status by hash: pending / success / failed + block + explorer link |
| `monad_logs` | recent ERC-20 Transfer activity for an address (in + out, newest first) over a bounded block window (default 50k requested, cap 200k blocks; cap 200 logs) — endpoints that cap getLogs ranges (public Monad RPC: 100 blocks) are handled by adaptive shrink; the result reports the window actually scanned + `rangeShrunk` |
| `monad_allowance` | ERC-20 allowance (defaults: device wallet × stablecoin × PaymentVault) |

## 6. Cross-cutting: web read/search — `crates/toolsets/webread`

Registered under `webread::any_engine()` (desktop webview or Cloudflare configured; kawai-web
degrades to CF-only). Added to office (via `office_toolset`), presentation, and binance.

| Tool | Purpose |
|---|---|
| `web_read` | engine chain: on-device webview → CF Browser Rendering (budgeted) → CF `/markdown`; challenge detection, 15-min LRU, 12k-char cap |
| `web_search` | Bing SERP through the same chain; every hit auto-fetched |

## 7. Generated tools — `crates/generated-tools/*`

Per-category `AgentTool` crates for public-API wrappers. One category = one
crate; each tool is a thin typed wrapper over a public API. Hand-maintained —
edit the tool files directly — except `coinmarketcap`, generated from the
CoinMarketCap TypeScript SDK (`coinmarketcap-api-typescript/`) by
`crates/generated-tools/coinmarketcap/tools/gen.py`. All categories merge
first-wins into the supervisor's `auto` registry. Categories:

| Crate | Example tools (non-exhaustive) |
|---|---|
| `browser` | `browser_markdown_extract`, `browser_content_extract`, `browser_json_extract`, `browser_links_extract`, `browser_scrape_elements` |
| `coinmarketcap` | `crypto_map`, `crypto_listings_latest`, `price_conversion`, `kline_candles`, `dex_search` |
| `entertainment` | `search_anime`, `get_top_anime`, `search_manga`, `search_artist`, `search_album`, `search_books`, `get_book_by_isbn`, `search_photos`, `search_videos`, `search_poems_by_title`, `get_tv_show_detail`, `search_star_wars_people` |
| `finance` | `get_stock_quote`, `get_stock_history`, `search_crypto`, `get_crypto_price`, `get_crypto_klines`, `get_forex_history`, `currency_exchange`, `get_balance_sheet`, `get_cashflow`, `get_income_statement`, `get_insider_transactions`, `get_stock_news` |
| `food-drink` | `search_recipe`, `get_random_recipe`, `search_cocktail`, `get_food_by_barcode`, `get_all_fruits` |
| `gaming` | `get_pokemon`, `get_pokemon_species`, `draw_cards` |
| `geospace` | `geocode`, `get_ip_location`, `get_earthquakes_by_region`, `get_sun_times`, `get_iss_position`, `get_flights_in_area` |
| `knowledge` | `search_papers`, `search_github_repos`, `get_github_repo`, `get_github_user`, `calculate`, `diagram_generate`, `diagram_render`, `validate_email`, `define_word` |
| `news-media` | `get_news_sources`, `get_on_this_day` |
| `religion` | `get_quran_surah`, `get_bible_verse`, `get_trivia_questions` |
| `sports` | `get_competitions`, `get_competition_standings`, `get_team_info`, `get_match_detail`, `get_tv_schedule` |
| `composio` | `composio_list_toolkits`, `composio_list_tools`, `composio_execute`, `composio_authorize`, `composio_list_connections` |
| `utility` | `draw_cards`, `get_chuck_norris_joke`, `search_star_wars_people`, `validate_email`, … |
| `weather-geo` | `get_weather`, `get_weather_forecast`, `get_country_info`, `get_time_in_timezone` |
| `wikipedia` | `search_wikipedia`-family lookups (`get_person_info`, etc.) |

Full inventory: `grep -rhoE 'const NAME: &'"'"'static str = "[a-z_0-9]+"' crates/generated-tools`.

## 8. Planner discovery — `crates/foundation/tool-catalog`

- The planner prompt carries **no** catalog: only the core whitelist (§1).
- Tool discovery = ≤2 bounded search rounds against the local-sqld tool catalog replica
  (vector + BM25 fused via RRF); 1 corrective round on plan validation failure; hard cap
  6 LLM calls per `plan_task`.
- The emitted plan is validated against the **full local `ToolRegistry`** (structure, dispatch
  keys, confirmation policy, per-step args vs each tool's `input_schema`) — fail-fast before
  execution. Design + benchmark: `PLAN-planner-search-loop.md`.
- Credentials: `KAWAI_TURSO_DB_URL` / `KAWAI_TURSO_AUTH_TOKEN` (legacy names,
  menunjuk instance lokal) → baked constants from `kawai-vault/constants`
  (men Bake endpoint lokal yang sama). sqld lokal jalan tanpa auth.

## 9. Seeder & drift gate

- **Prasyarat**: tool-catalog sqld lokal jalan (`~/.local/bin/sqld --db-path
  ~/.kawai/sqld/toolcatalog/data.sqld --http-listen-addr 127.0.0.1:8084
  --hrana-listen-addr 127.0.0.1:8085`).
- **Seed** (insert + update, idempotent upsert; `--prune` menghapus baris basi):
  `cargo run --release --manifest-path src-tauri/Cargo.toml --example seed_tool_catalog
  --features litert,binance,codegraph,monad` — proses berat (kompilasi besar +
  on-device embedder); jalan hanya atas permintaan eksplisit user.
- **Drift check** (read-only, cepat): `cargo run --release --manifest-path
  src-tauri/Cargo.toml --example tool_catalog_drift_check --features
  litert,binance,codegraph,monad` — verifikasi pasca-seed / coverage gate.
- Kedua example berbagi satu komposisi toolset: `src-tauri/examples/catalog_composition.rs` (jangan duplikasi logika di sana).

## 10. Adding a tool — checklist

1. Implement `AgentTool` in the owning crate (or a generated-tools category if it's a public
   API wrapper).
2. Register it in the right agent's `build_tools` (or `add_runtime_tools` if cross-cutting).
   First-wins in the merged registry — don't reuse an existing NAME with different semantics.
3. Override `requires_confirmation()` if side-effecting.
4. It is automatically discoverable by the planner **only if** it's in the local registry the
   supervisor builds (`build_supervisor_registry`) — verify with
   `src-tauri/examples/tool_catalog_narrow_check.rs`.
5. Update this file (+ `AGENTS.md` crate table) in the same commit. If the tool's output
   should get a custom Workbench view, follow §11.5.

## 11. Tool output → frontend: shape, storage, delivery

How a supervisor step's tool output travels from the Rust scheduler to the Workbench viewer,
and which view renders it. Source of truth for shapes is the Rust code cited per row — update
this section when a tool's output changes. Render code:
`frontend/src/features/workbench/components/tool-views/`.

```
tool call (Rust)                     transport event                    frontend
──────────────────────────────────────────────────────────────────────────────
AgentTool::call → Output (String) ─▶ stepCompleted { output ≤2000 chars } ─▶ renderStepReport(tool, output)
                                    + artifacts: ArtifactInfo[]             (tool-views/)
                                    full body kept backend-side (see §11.2)
```

### 11.1 Delivery (the wire)

| Channel | What crosses | Cap |
|---|---|---|
| `stepCompleted.output` | preview string (raw tool output, possibly cut mid-JSON) | 2000 chars — `STEP_EVENT_OUTPUT_MAX_CHARS`, `src-tauri/src/supervisor.rs` |
| `stepCompleted.artifacts` | `ArtifactInfo[]` (file handles produced by the tool) | metadata only |
| `planCompleted.final_output` | the synthesized deliverable | **uncapped** |
| `planStarted.planKey` / `planRevised.planKey` | hash of the executing plan — the read key for persisted step results; changes on replan | — |
| `supervisor_step_output` op | **full body** of one persisted step result (pull, not push) | — |

Full step bodies live in `supervisor_step_results` and never ride the wire.
The viewer always fetches the full body for an opened report:
`useWorkbench.loadFullOutput(stepId, planKey)` calls the op once per opened
step (per-instance cache in `useStepReport`) and re-renders with the full
text — see `DeliverableViewer` and `PastRunCanvas`. Past runs read through
their OWN `planKey`; a record without one (legacy) passes `""`, which hits
`supervisor::step_output`'s session-scope fallback (newest rows for that step
id, still user-scoped — a same-id step from a newer run can win). The
JSON-repair in `parseMaybeJson` remains as the safety net for fetch failures —
the ≤2000-char preview stays visible then.

### 11.2 Storage

| Data | Where | Notes |
|---|---|---|
| Full step output (text) | `supervisor_step_results` SQLite table, keyed by plan-JSON hash | read path: `supervisor_step_output` op (both wrappers, auth at edge); also powers Resume + the ExecutionMemo |
| Per-step artifacts + failure text | embedded in the persisted plan record (session history JSON); restored on reopen by `hydrateStep` / `restorePersisted` | metadata only — full artifact files stay in the office store; records written before these fields existed restore empty |
| Run progress (partial records) | the SAME plan-record row, appended once at plan start and updated in place per step event (`update_chat_message` op, both wrappers); a row that stays `partial: true` never reached a terminal event and renders as an interrupted run | avoids one history row per write; transcripts render partials via `planToText`'s interrupted note |
| Files a tool produces (docx, pdf, svg, decks) | office store (`<data_root>/<user>/docs/`), referenced by handle | `ArtifactInfo { handle, filename }` rides the event; preview via `office_read_file` |
| Final deliverable | `planCompleted.final_output` on the wire; persisted plan record goes to session history | user-exportable to a stored .pdf/.docx via the `export_deliverable` op (auto-persist to the office store is still an open S2 item) |
| Sessions / messages | `sessions` / `messages` tables | chat history, not tool output |

### 11.3 Render map (tool → view)

Registry: `tool-views/index.tsx`. Every view receives the (possibly repaired)
parsed JSON, or the raw string. Unlisted tools fall through to the heuristic
`FallbackView` (markdown-ish text → Streamdown; array of records → cards;
record → key-value; scalar array → bullets).

Office / PDF (`kawai-office`, `office-tools/pdf`):

| Tool | Output shape | View |
|---|---|---|
| `office_list_files` | `{"files":[{id, originalName, ext, bytes, createdAt}]}` | `FileListView` — ext badge, size, date, id |
| `office_read_document` / `office_create_document` | `{"markdown":"…"}` | `MarkdownView` (Streamdown) |
| `office_document_info` | metadata record | `KeyValueView` |
| `pdf_extract_text` | TWO shapes — supervisor dispatch (first-wins) serves the kawai-office wrapper: `{"text":"--- page 1 ---\n…"}`; the office-tools/pdf variant emits `{"pages":{"1":"text",…}}` | `PdfPagesView` — collapsible panel per page (both shapes split into pages) |
| `pdf_search_text` | `{"pattern":"…","matches":[…]}` | key-value with match count |
| `pdf_info` / `pdf_metadata_get` | `{"metadata":{…}}` | `KeyValueView` |
| `pdf_page_info` | page record | `KeyValueView` |

Memory / knowledge (`kawai-memory`, `kawai-knowledge`):

| Tool | Output shape | View |
|---|---|---|
| `memory_search` | text lines `- (kind \| mem_id) Title: content` | `MemoryLinesView` — badge = kind |
| `memory_graph_search` | `## Entity` sections of the same lines | `MemoryGraphView` |
| `knowledge_search` | `{"hits":[{source, locator, content, fileId}], "note"?}` — empty search → `hits: []` with retry guidance in `note`; a bare hit array is the pre-envelope shape of already-persisted rows | `renderKnowledgeSearch` (shared via `tool-renderers/knowledge.tsx`) — count line + source/locator/content cards, `note` as footnote |
| `session_step_results` | `{"entries":[{run, is_last_run, tool, finished_at, output, truncated}], "note"?}` | `SessionStepResultsView` — card per entry, markdown body, "last run" pill, truncation note |

Binance (`crates/toolsets/binance`):

| Tool | Output shape | View |
|---|---|---|
| `crypto_price` | `{symbol, lastPrice, priceChange, priceChangePercent, openPrice, highPrice, lowPrice, volume, quoteVolume, bidPrice, askPrice, weightedAvgPrice, count, _source}` | `renderTicker24` |
| `crypto_depth` | `{symbol, book:{bestBid, bestAsk, spread, mid}, bids, asks}` | `renderBinanceDepth` |
| `crypto_klines` | `{symbol, interval, count, candles:[[openTime, open, high, low, close, volume],…], _source}` | `chart(binanceKlineSeries)` |
| `crypto_ta_analyze` | indicator finals (e.g. `rsi14`, `ema9`, `macd12269`) + `windowChangePct`, `skipped` | `renderBinanceTa` |
| `crypto_balances` | `{canTrade, balances:[{asset, free, locked}]}` | `renderBinanceBalances` |
| `crypto_open_orders` | `{count, orders:[…]}` | `renderBinanceOpenOrders` |
| `stock_quote` / `stock_info` | `{symbol, bidPrice?, askPrice?, bidSize?, askSize?, mid?}` / `{symbol, tradability, fractionable, …}` | `KeyValueView` (via `genericKv`) |

Finance (`generated-tools/finance`):

| Tool | Output shape | View |
|---|---|---|
| `get_stock_price` / `get_stock_quote` / `get_stock_detail` | `{symbol, name?, price, change, percent_change, previous_close?, open?, day_high?, day_low?, volume?, market_cap?, fifty_two_week_*?, source}` (shape varies by provider fallback: TwelveData → StockTwits → yfinance → AlphaVantage) | `StockQuoteView` — big price + ▲/▼ pill + detail grid |
| `get_stock_history` | `{"meta":…,"values":[{datetime, close, …}]}` (TwelveData time_series) | `SparklineView` — SVG sparkline + period delta |
| `trending_stocks` | `{"trending":[{symbol, title, watchers}]}` | `TrendingView` — ranked list, "N pengamat" |
| `stock_social_feed` | `{"symbol","count","messages":[{user, body, sentiment, created_at, likes}]}` | `SocialFeedView` — sentiment tally + badge per post |
| `stock_sentiment` | aggregate sentiment record | fallback (key-value) |
| `get_stock_news` / `get_reddit_posts` | `{"articles"\|"posts":[{title, summary, publisher, link, published?}]}` | `NewsListView` — headline cards, id-ID dates |
| `get_balance_sheet` / `get_income_statement` / `get_cashflow` | `{"ticker","freq","count","statements":[…]}` (yfinance) | `FinancialTableView` — periods × line items |

CoinMarketCap (generated-tools/coinmarketcap — 68 tools):

All CMC tools return the raw upstream HTTP body — the vendor envelope
`{"status":{"error_code":…},"data":…}` passes through verbatim (http-common
`ToolBase::exec`, GET). Views unwrap it in `tool-views/cmc-views.tsx`;
`error_code ≠ 0` or an unrecognized shape returns null → `FallbackView`.

| Tools | `data` shape | View |
|---|---|---|
| `crypto_listings_latest` / `_historical`, `crypto_quotes_latest` / `_historical`, `dex_listings_quotes`, `dex_pairs_quotes_latest`, `dex_token_price`, `dex_token_liquidity`, `simple_price`, `rwa_quotes_latest`, `flipside_fcas_quotes_latest`, `index_cmc100_latest` / `_historical`, `index_cmc20_latest` / `_historical`, `global_metrics_quotes_latest` / `_historical` (incl. `{quotes:[…]}` records) | records with `quote.USD` `{price, percent_change_24h, market_cap, …}` | `CmcView` → quote rows: rank, name/symbol, price, ▲/▼ 24h, compact market cap |
| `fear_and_greed_latest` / `_historical` | `[{value, value_classification}]` | `CmcFearGreedView` — big index + tone pill (Rakus/Takut) |
| `kline_candles`, `kline_points`, `dex_pairs_ohlcv_latest` / `_historical` | positional candles `[open, high, low, close, volume, timestamp, traders]` | `CmcOhlcvView` → `SparklineView` over closes (index 3) |
| everything else (`crypto_info`, `exchange_*`, `dex_*` info/security/holders, `rwa_*` lists, `*_map`, derivatives, posts, …) | record → flattened key-value; plain record array → titled cards | `CmcView` smart dispatch |

Monad (`crates/toolsets/monad-tools` — all camelCase + top-level `chain`
stamp; views in `tool-views/monad-views.tsx`, unrecognized shape →
`GenericHumanView`, never nothing):

| Tool | Output shape | View |
|---|---|---|
| `monad_wallet_status` | `{address, balanceWei, balanceMon, blockNumber, tokens:[{label, address, available, raw, formatted}], rpcUrl, chain}` | `MonadWalletStatusView` — big MON balance + token cards |
| `monad_token_balance` / `monad_allowance` | `{token, wallet\|owner, spender?, raw, formatted, decimals, rpcUrl, chain}` | `MonadTokenBalanceView` — big formatted amount + raw/decimals |
| `monad_gas_price` | `{gasPriceGwei, isDynamicFee, rpcUrl, chain}` | `MonadGasView` — big gwei value |
| `monad_chain_status` | `{rpcUrl, blockNumber, chainId, chain}` | `MonadChainStatusView` — key-value |
| `monad_tx_receipt` | `{txHash, status: success\|failed\|pending, blockNumber?, explorerUrl, chain}` | `MonadTxReceiptView` — status pill + explorer link |
| `monad_logs` | `{tokenLabel, scannedBlocks, transfers:[{txHash, blockNumber, direction, counterparty, amountRaw}], truncated, chain}` | `MonadLogsView` — in/out transfer rows |
| `monad_token_info` | `{address, symbol, decimals, rpcUrl, chain}` | `MonadTokenInfoView` — key-value |

Analytics export & runtime notes:

| Tool | Output shape | View |
|---|---|---|
| `data_export` | `{fileId, filename, format, rows, bytes}` | `FileCreatedView` — stored-file card, click opens the preview |
| `data_fetch` | `{kind:"data", fileId, filename, symbol, interval, rows, bytes, columns, nextStep}` | `FileCreatedView` — stored-file card, click opens the preview |
| `deep_write` / `draft_document` / `plan_task` / `plan_revise` / `artifact_recall` | loop-intercepted by the agent engine before dispatch (`subagents.rs`) — never produce step outputs; nothing to register | — |
| `memory_search` / `memory_graph_search` / `session_step_results` | see Memory/knowledge above (already registered) | — |

Generic (any tool):

| Situation | View |
|---|---|
| JSON array of records with a title-ish field | cards (`RecordListView`) |
| JSON record | key-value grid |
| JSON scalar array | bullet list |
| text with markdown structure (`#`/`-`/`1.`) | Streamdown |
| plain text | Streamdown paragraph |
| JSON cut off mid-string/bracket | repaired prefix, rendered normally (no disclaimer) |

### 11.4 Formatting rules (`tool-views/format.ts`)

- Locale `id-ID` everywhere: `Intl.NumberFormat` (compact for volume/market
  cap), `Intl.DateTimeFormat` (accepts epoch s/ms and ISO strings).
- Percent deltas carry an explicit sign: `+2,34%` / `-1,05%`.
- Copy is human, not field names: "5 dokumen ditemukan", "▲ Naik +2,3%".
- `parseMaybeJson` = parse → on failure repair (boundary-first backward sweep,
  dangling-brace/comma cleanup) → raw string as last resort.

### 11.5 Adding a tool view

1. Confirm the exact output shape in the tool's Rust source (`json!({...})`).
2. Add a view (or reuse a category view) in `tool-views/views.tsx`.
3. Register it in the `registry` map in `tool-views/index.tsx`.
4. Prefer null over wrong: a registry fn that returns `null` (shape mismatch)
   falls back to `FallbackView` instead of rendering lies.
