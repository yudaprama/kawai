# Tool Map — Kawai

> Every agent tool registered in the supervisor era: where it lives, which agent gets it, and
> how the planner discovers it. Companion to `AGENTS.md` (architecture) and `KNOWLEDGE_MAP.md`
> (retrieval internals). Present tense only — when a tool ships or moves, update this file in
> the same commit.

**TL;DR:** One tool = one `AgentTool` impl (`const NAME`, `Args`, `Output`, `Error`) in a
per-category crate. Agent definitions (`builtin.office`, `builtin.presentation`,
`builtin.analytics`, `builtin.binance`) build their toolsets via `build_tools`; the merged
`auto` registry (first-wins per name) is what the supervisor actually dispatches against. The
planner never sees the full catalog — it discovers tools through ≤2 search rounds against the
Turso tool catalog, with a small core whitelist always visible.

---

## 0. How a tool becomes callable

```
AgentTool impl (crates/*)               →  kawai_tools::ToolSet (type-erased, name-keyed)
build_tools(context, remote_configured) →  per-agent ToolSet (agent_registry.rs composes)
ToolRegistry (crates/router)            →  merged `auto` catalog, first-wins per NAME
supervisor.rs build_supervisor_registry →  what plan_task validates & execute dispatches
tool-catalog (Turso embedded replica)   →  planner discovery (vector+BM25/RRF search)
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
| `office_create_deck` | template-seeded reveal.js deck (required `templateId`; `probe_deck` gate) |
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
| `data_ta` | TA indicator folds (SMA/EMA/RSI/MACD/BBands), final values only |
| `data_chart` | charton SVG render; saved into the office store as session-associated svg |
| `office_list_files` | id discovery (same tool as office) |
| `data_tables` | registered SQL source → typed parquet snapshot (only when `sql_profiles` non-empty) |
| `data_import` | snapshot a validated SQL source into the office store (same gate) |

## 5. Binance (`builtin.binance`) — `crates/toolsets/binance` (feature `binance`)

Keyless public spot market data + in-process TA. Also gets webread + runtime tools
(`supports_draft_document: false`).

| Tool | Purpose |
|---|---|
| `binance_price` | current price / 24hr ticker |
| `binance_klines` | OHLCV candles |
| `binance_depth` | order book |
| `binance_ta_analyze` | indicator suite over klines |
| `binance_balances` / `binance_open_orders` | read-only account tools — compiled **only** when `BINANCE_API_KEY` + `BINANCE_API_SECRET` are both set (never trade permission) |

## 6. Cross-cutting: web read/search — `crates/toolsets/webread`

Registered under `webread::any_engine()` (desktop webview or Cloudflare configured; kawai-web
degrades to CF-only). Added to office (via `office_toolset`), presentation, and binance.

| Tool | Purpose |
|---|---|
| `web_read` | engine chain: on-device webview → CF Browser Rendering (budgeted) → CF `/markdown`; challenge detection, 15-min LRU, 12k-char cap |
| `web_search` | Bing SERP through the same chain; every hit auto-fetched |

## 7. Generated tools — `crates/generated-tools/*`

Auto-generated per-category `AgentTool` crates (`crates-gen` / xtask). One category = one
crate; each tool is a thin typed wrapper over a public API. Currently **not** wired into the
supervisor's `auto` registry by default — they join when a definition's `build_tools` includes
them (catalog via tool-catalog search). Categories:

| Crate | Example tools (non-exhaustive) |
|---|---|
| `browser` | `browser_markdown_extract`, `browser_content_extract`, `browser_json_extract`, `browser_links_extract`, `browser_scrape_elements` |
| `entertainment` | `search_anime`, `get_top_anime`, `search_manga`, `search_artist`, `search_album`, `search_books`, `get_book_by_isbn`, `search_photos`, `search_videos`, `search_poems_by_title`, `get_tv_show_detail`, `search_star_wars_people` |
| `finance` | `get_stock_quote`, `get_stock_history`, `search_crypto`, `get_crypto_price`, `get_crypto_klines`, `get_forex_history`, `currency_exchange` |
| `food-drink` | `search_recipe`, `get_random_recipe`, `search_cocktail`, `get_food_by_barcode`, `get_all_fruits` |
| `gaming` | `get_pokemon`, `get_pokemon_species`, `draw_cards` |
| `geospace` | `geocode`, `get_ip_location`, `get_earthquakes_by_region`, `get_sun_times`, `get_iss_position`, `get_flights_in_area` |
| `knowledge` | `search_papers`, `search_github_repos`, `get_github_repo`, `get_github_user`, `calculate`, `diagram_generate`, `diagram_render`, `validate_email`, `define_word` |
| `news-media` | `get_top_headlines`, `search_news`, `get_news_sources`, `get_on_this_day` |
| `religion` | `get_quran_surah`, `get_bible_verse`, `get_trivia_questions` |
| `sports` | `get_competitions`, `get_competition_standings`, `get_team_info`, `get_match_detail`, `get_tv_schedule` |
| `utility` | `composio_list_toolkits`, `composio_list_tools`, `composio_execute`, `composio_authorize`, `composio_list_connections` |
| `weather-geo` | `get_weather`, `get_weather_forecast`, `get_country_info`, `get_time_in_timezone` |
| `wikipedia` | `search_wikipedia`-family lookups (`get_person_info`, etc.) |

Full inventory: `grep -rhoE 'const NAME: &'"'"'static str = "[a-z_0-9]+"' crates/generated-tools`.

## 8. Planner discovery — `crates/foundation/tool-catalog`

- The planner prompt carries **no** catalog: only the core whitelist (§1).
- Tool discovery = ≤2 bounded search rounds against the Turso embedded replica
  (vector + BM25 fused via RRF); 1 corrective round on plan validation failure; hard cap
  6 LLM calls per `plan_task`.
- The emitted plan is validated against the **full local `ToolRegistry`** (structure, dispatch
  keys, confirmation policy, per-step args vs each tool's `input_schema`) — fail-fast before
  execution. Design + benchmark: `PLAN-planner-search-loop.md`.
- Credentials: `KAWAI_TURSO_DB_URL` / `KAWAI_TURSO_AUTH_TOKEN` (dev) → baked read-only
  constants from `kawai-vault/constants` (distribution default). Token MUST be read-only.

## 9. Adding a tool — checklist

1. Implement `AgentTool` in the owning crate (or a generated-tools category if it's a public
   API wrapper — regenerate via xtask, don't hand-write those).
2. Register it in the right agent's `build_tools` (or `add_runtime_tools` if cross-cutting).
   First-wins in the merged registry — don't reuse an existing NAME with different semantics.
3. Override `requires_confirmation()` if side-effecting.
4. It is automatically discoverable by the planner **only if** it's in the local registry the
   supervisor builds (`build_supervisor_registry`) — verify with
   `src-tauri/examples/tool_catalog_narrow_check.rs`.
5. Update this file + `AGENTS.md` crate table in the same commit.
