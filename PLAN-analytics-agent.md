# Implementation Plan — Analytics agent (`builtin.analytics`): Polars-backed tabular query tools

Status: **IMPLEMENTED (2026-08-24)** — all phases shipped: the
`components/analytics` crate (30 unit tests green), the kawai wiring
(`builtin.analytics` agent + `logic/analytics.rs` tools + store allowlist +
RAG tabular skip + frontend rail entry), the xlsx bridge, and the gates
(`analytics_smoke` offline e2e in all three CI smoke jobs, `cargo test -p
analytics` + compile gates in linux-check). Live status in `AGENTS.md` →
Roadmap 5 ✅.

**Addition (2026-08-24): SQL snapshot tools shipped (Phase 4, SQLite slice).**
`data_tables(profile)` + `data_import(profile, table)` live in
`logic/analytics.rs` per the design below: named profiles from env
(`KAWAI_SQL_PROFILE_<NAME>` = local SQLite path), capability-probe
registration (`has_sql_profiles()`), bound-parameter identifier validation
before quoting, hard row cap (`KAWAI_SQL_MAX_ROWS`, default 100k), typed dump
via the crate's neutral `RawCell` + `rows_to_parquet` API (polars stays
crate-side; src-tauri never sees it), snapshot lands in the office store and
associates with the session via `knowledge_add_to_session`; the persona
carries the confirm-before-import rule. 6 integration tests in
`logic::analytics::sql_tests` cover listing/profile errors, the full
dump→discover→query path, row-cap truncation, BLOB guidance errors,
null-typed columns, and quoted identifiers. External Postgres/MySQL via sqlx
remains deferred (service-backed tests required first). Profiles are ALSO
user-manageable in-app (no .env needed): the `sql_profiles` per-user table
(migration `0006`) behind ops `sql_profile_list`/`sql_profile_save`/
`sql_profile_delete` (both wrappers), surfaced as a "Databases" tab in the
knowledge panel with a native file picker; a process-local cache reloaded at
each agent turn registers the tools without restart. Env vars remain an
ops/dev override and win on name clash.

**Remote sources shipped (2026-08-24, feature `analytics-sql`)**: sqlx 0.8
(`runtime-tokio-rustls`, `postgres`, `mysql` — no sqlite; local stays on
libsql) in `logic/sql_remote.rs`. Profile sources may now be
`postgres://`/`postgresql://`/`mysql://`/`mariadb://` URLs (saved via the
same ops/UI, validated for scheme; file-existence check skipped). Design:
dialect from the URL scheme; identifier validated against information_schema
via BOUND PARAMETER before quoting (pg `"…"`, mysql backticks); temporal
columns CAST to text at the SQL layer (`col::text` / `CAST(… AS CHAR)`) so
no chrono dep; binary/array columns reject the dump naming the column
(same contract as SQLite BLOBs); cell decode cascades wide→narrow ints →
floats → bool → text into the crate's neutral RawCell. URLs are REDACTED
(`user:***@host`) in every error path — passwords never reach logs or the
model. CI: linux-check gains a `cargo check --features analytics-sql`
compile gate; live-server integration tests stay local-only (no DB service
in CI yet).

**Mobile readiness (2026-08-24)**: the analytics crate compiles clean for
android arm64 (`cargo ndk -t arm64-v8a -P 24 check -p analytics`) and iOS
(`cargo check -p analytics --target aarch64-apple-ios`); polars' enabled
features map to pure-Rust sub-crates only (cloud/http/aws stay off), and
libsql core already ships on both targets via kawai's own DB layer. The only
mobile blockers sit OUTSIDE this feature — the `office`→embedding path
(ONNX/fastembed is `#[cfg]`-gated out on Android/iOS; remote embedding
providers still work, but the on-device LLM engine is Roadmap 13) — both
owned by separate tracks. No SQL-specific work remains;
if a UI path is wanted before the mobile orchestrator lands, the deferred
non-agent data-explorer op pair (§4) is the drop-in shape.

Implementation deltas from the original design (discovered while building):

- **No agent-tool dep in the crate.** The tool structs live kawai-side
  (`logic/analytics.rs`, Phase 2) exactly like `KnowledgeSearchTool`; the
  crate is pure functions over a path (matches the decision table).
- **`query()` takes `QueryArgs` by value**; both entry points take an
  optional `sheet` (xlsx only).
- **Polars `JsonWriter` emits NDJSON** (one object per line), not a JSON
  array — `query()` folds newlines into array separators (in-string
  newlines are always escaped, so real newlines are exactly the row
  separators).
- **Oversize handling re-collects with a halved limit** instead of
  mid-string truncation (which would emit invalid JSON); a single row that
  still exceeds the cap is a guidance error. `_meta` carries
  `possibly_more_rows` (rows_returned == limit).
- **Polars 0.55 API notes**: `PlRefPath::try_from_path` for scans,
  `LazyCsvReader::new(..).with_separator(..).finish()`, prelude
  `Schema::iter()` yields `(&name, &dtype)`, `collect_schema` needs
  `&mut LazyFrame`, `contains_literal` is behind the `regex` feature,
  `lit(NaiveDate)` needs `dtype-date`/`dtype-datetime`.
- **Discovery samples strip Display quotes** (polars prints Utf8 AnyValues
  as `"laptop"`); parquet row count via metadata-driven
  `select([len()])`.

### xlsx bridge (office_oxide — NOT calamine)

polars 0.55 has no excel support (verified: no calamine in polars-io 0.55),
so the bridge rides kawai's existing office_oxide submodule instead of
adding an external dependency. Design (supersedes the "convert tool" idea):

- **Transparent intercept, not a model-visible tool**: `discover`/`query`
  dispatch `.xlsx/.xlsm` through [`excel`] before scanning; the engine only
  ever sees csv/parquet lazy frames. The model keeps its 2-hop flow and its
  `doc1` handles — no persona rule, no extra manifest entry.
- **Typed conversion** (the original proposal stringified everything):
  numbers stay numbers (all-integral columns → Int64 for exact sums),
  booleans stay booleans, date-styled serials → Date/Datetime columns
  (`styles.number_format_for` custom codes + builtin ids via
  `builtin_format_code`; heuristic over y/d/h tokens after stripping quoted
  literals and bracket sections), genuinely mixed columns degrade to text
  (same contract as csv inference), Excel error cells (`#DIV/0!`) become
  text.
- **Sidecar cache**: `.<file>.dc<idx>.parquet` (+ `.json` fingerprint =
  source mtime+size) beside the source — leading dot so the office store's
  `*.meta.json` listing never sees it and `<file_id>__` resolve can never
  match it. Stale fingerprint ⇒ re-convert; otherwise every later query is
  lazy-parquet (row-group pruning included).
- **Multi-sheet**: `SchemaInfo.sheets` echoes all names;
  `sheet` arg selects by case-insensitive name (error lists available);
  default = first sheet with data. Sidecars are per (source, sheet index).
- Headers from row 0 (empty header cells → Excel column letters A/B/…AA,
  duplicates suffixed `_2`); ragged rows → nulls; 5M-cell guard with a
  guidance error.

## 0. Context

Users keep tabular data (CSV / Parquet exports: transactions, sales, logs).
The agent tier has no way to answer analytical questions over such files —
`knowledge_search` chunks them as prose (wrong modality: no filtering, no
aggregation, no sorting), and `office_read_document` dumps raw text. This plan
adds a third catalog agent whose tools execute structured queries **in-process**
via Polars LazyFrames (predicate pushdown → parquet row-group pruning), fully
on-device, no credentials, no network.

Design hardening applied to the originally proposed AST schema (see review
2026-08-24): dtype-aware literal coercion (no `unwrap_or(0.0)` — unparseable
values are errors, never silent defaults), no silent filter drops (unknown
operator = error), error payloads that echo the file schema so the model
self-corrects in one round, and path resolution exclusively through the office
store's `file_id` (never a user-supplied path — path traversal is structurally
impossible).

Division of labor follows the existing tier rules: the local orchestrator
(Gemma 4) plans the query; Polars does the math; when a remote provider is
configured, `deep_write` + cloud close synthesize the final answer from the
full `TurnMemory` log (auto — no analytics-specific code).

## 1. Core concept

```
knowledge panel import (csv/tsv/parquet into office store)     @-mention attach
        │                                                             │
        ▼                                                             ▼
office store: <data_root>/<user>/docs/<file_id>  ── session_files ── attachment block
        │                                                     ("doc1 = sales.csv")
        ▼
agent_chat loop (builtin.analytics)
        │
        ├─ data_schema(file_id)          ← persona REQUIRES this before any query
        │    columns {name, dtype, samples[3]}, row count (parquet metadata)
        │
        ├─ data_query(file_id, …)        ← the AST:
        │    filters[] → (lazy) → group_by[] → aggregations[] → sort → limit
        │    OR columns[] row-selection mode
        │    in-process polars, spawn_blocking, JSON rows out (≤30k chars)
        │
        ├─ office_list_files             ← browse ids when not @-mentioned
        │
        ├─ artifact_recall               ← oversized results page back (TurnMemory)
        │
        └─ deep_write (when remote configured) ← cloud close synthesizes the answer
```

Two-step discipline (`data_schema` → `data_query`) kills column-name
hallucination the same way the office persona's `knowledge_search`-first rule
does. File ids never appear in the model's context as raw 23-char handles —
the existing alias machinery (`doc1`, `doc2`, …) already rewrites
`office_list_files` results and resolves `file_id` args (`alias_resolve_args`
covers the `file_id` key — no agent.rs change needed for that part).

## 2. Architecture decisions

| Decision | Choice | Rationale |
|---|---|---|
| New crate | `components/analytics` | binance/webread pattern: hand-written `PortableTool`s, transport-agnostic, zero kawai deps. All Polars knowledge lives here, unit-testable with fixture files. |
| Polars dep | `polars 0.55`, features `lazy, parquet, csv, json, strings` only | Minimal feature set keeps compile cost + mobile surface down. No `temporal` extractors, no `excel` (phase 4), no rayon tuning. |
| Kawai-side glue | `src-tauri/src/logic/analytics.rs` (feature `analytics`) | The tools resolve `file_id` via `office::store::resolve` — that needs kawai state, so the tool structs live kawai-side exactly like `KnowledgeSearchTool`. The crate exposes pure `discover(path)` / `query(path, args)` fns. |
| File intake | office store ext allowlist += `csv \| tsv \| parquet` (`xlsx` already accepted) | Single intake invariant: the knowledge panel stays the ONLY door. Reuses import UI, per-user isolation, `session_files`, aliases, delete. |
| RAG | skip auto-index for tabular exts | Tabular files are queried structurally; chunking them as prose is wasted embeddings. `knowledge_add_to_session` associates without indexing; no `rag_files` row → no "Index failed" badge. |
| Agent identity | `builtin.analytics`, third catalog entry | Matches the specialized-catalog product story; persona tuned to query discipline; office agent stays document-shaped. |
| Feature graph | `analytics = ["dep:analytics", "office"]` | Data files live in the office store → office is implied. Desktop/mobile default builds stay analytics-free (polars stays out of the default graph). |
| Blocking | `tokio::task::spawn_blocking` around every collect | Polars collect is CPU-bound; never stall the runtime threads. |
| Output size | `limit` default 10, hard cap 100; body cap 30k chars | TurnMemory excerpts >4k bodies anyway (mem-handles + recall); 30k stays under the per-entry 32k cap so nothing is double-truncated. |

## 3. Tool contracts

### 3.1 `data_schema`

```json
{
  "name": "data_schema",
  "description": "REQUIRED before the first data_query on a file. Returns the column names, data types, and sample values of a stored tabular file (csv/parquet), plus the row count.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_id": { "type": "string", "description": "File handle from office_list_files or the attachment block, e.g. \"doc1\"." }
    },
    "required": ["file_id"]
  }
}
```

Output (compact JSON): `{fileId, name, format: "parquet"|"csv", rows, bytes,
columns: [{name, dtype, samples: [..3..]}]}`. `rows` from parquet metadata
(instant); `null` for csv (a full scan is not worth it). Samples from
`head(3)`.

### 3.2 `data_query`

```json
{
  "name": "data_query",
  "description": "Run a structured query on a stored tabular file: filter rows, optionally group, aggregate (sum/avg/min/max/count/count_distinct), sort, and limit. Numeric filter values are always sent as strings; they are parsed to the column's real type.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_id": { "type": "string" },
      "columns": {
        "type": "array", "items": { "type": "string" },
        "description": "Row-selection mode: columns to return, no aggregation. Omit with aggregations present; omit both for all columns."
      },
      "filters": {
        "type": "array",
        "description": "WHERE conditions, AND-combined.",
        "items": {
          "type": "object",
          "properties": {
            "column": { "type": "string" },
            "operator": { "type": "string", "enum": ["eq","neq","gt","gte","lt","lte","contains"] },
            "value": { "type": "string", "description": "Always a string; parsed to the column's type (numbers as \"1500\", dates as \"2026-01-31\")." }
          },
          "required": ["column","operator","value"]
        }
      },
      "group_by": { "type": "array", "items": { "type": "string" } },
      "aggregations": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "column": { "type": "string" },
            "function": { "type": "string", "enum": ["sum","avg","min","max","count","count_distinct"] },
            "alias": { "type": "string" }
          },
          "required": ["column","function","alias"]
        }
      },
      "sort_by": { "type": "string", "description": "Output column to sort by (a group_by column or an aggregation alias; in row mode any column)." },
      "descending": { "type": "boolean", "default": false },
      "limit": { "type": "integer", "default": 10, "maximum": 100 }
    },
    "required": ["file_id"]
  }
}
```

Semantics (crate-side, `analytics::query`):

1. **Validate** every `column` / `group_by` / `sort_by` name against the
   scanned schema. Unknown → error listing the valid columns.
2. **Literal coercion per column dtype** (the critical hardening):
   - Int/UInt/Float → parse numeric; unparseable → error (message includes the
     column dtype), never a default.
   - Date → `YYYY-MM-DD`; Datetime → RFC 3339; parse failures → error with a
     format example.
   - Boolean → `"true"/"false"`.
   - Utf8 → string literal as-is.
   - `contains` → utf8 columns only (`str.contains(lit, literal=true)`); on a
     non-string column → error saying contains is text-only.
3. **Build the LazyFrame**: `scan_parquet` / `scan_csv` → apply all filter
   exprs (predicate pushdown happens here — this is what prunes parquet row
   groups) → group_by+agg **or** select(`columns`|all) → sort (`sort_by` may
   reference an agg alias — sorting happens on the lazy plan post-alias) →
   limit.
   - `group_by` set + `aggregations` empty → implicit `count(*) as row_count`
     (the "how many per category" query in one call).
4. **Collect** under `spawn_blocking`; serialize rows via `JsonWriter`;
   append `_meta {rows_returned, truncated, sort_by}`. Body >30k chars →
   truncate + `_meta.truncated_reason`.

**Error contract** (both tools): plain-string errors shaped
`column "x" not found; valid columns: a, b, c` — the loop feeds them back as
`response:` prompts, so one repair round fixes a bad name without a second
discovery call. All error paths are `Err`, never a silently-degraded
`Ok` (the two failure modes the original proposal had).

## 4. Phases

### Phase 1 — `components/analytics` crate (no kawai wiring)

Files:
- `components/analytics/Cargo.toml` — deps: `polars 0.55` (features
  above), `serde`, `serde_json`; dev-deps `tokio`. Lints mirror binance
  (`unexpected_cfgs = warn`).
- `components/analytics/src/lib.rs` — `ToolError`/`terr` + public fns:
  - `discover(path: &Path) -> Result<SchemaInfo, ToolError>`
  - `query(path: &Path, args: &QueryArgs) -> Result<String, ToolError>`
  - `QueryArgs`, `FilterOp`, `AggOp` (`#[derive(Deserialize)]`, camelCase-tolerant)
- `components/analytics/src/engine.rs` — AST → LazyFrame translation,
  literal coercion, schema validation (the only file that touches polars
  exprs).
- Add `"analytics"` to `components/Cargo.toml` workspace members.
- Unit tests in-crate: build fixture parquet + csv via polars writers in
  `tempfile` dirs; cover: dtype-aware filters (numeric string → f64/i64,
  date string, contains), unknown column error lists valid names, unparseable
  numeric error, group_by+sum/avg/count/count_distinct, implicit row_count,
  sort by agg alias both directions, limit cap, row-selection mode, empty
  result shape, 30k truncation.

Gate: `cargo test -p analytics` green. No changes to src-tauri yet.

### Phase 2 — kawai wiring

Files:
- `src-tauri/Cargo.toml` — `analytics = { path = "../components/analytics", optional = true }`;
  feature `analytics = ["dep:analytics", "office"]`; `[[example]]
  analytics_smoke` (required-features `["analytics"]`).
- `src-tauri/src/logic/analytics.rs` — kawai-side tools + builder:
  - `DataTableSchemaTool(user_id)` / `DataQueryTool(user_id)` implementing
    `PortableTool` (`data_schema`, `data_query`); args carry an optional
    `sheet` (xlsx only, passed straight through to the crate fns); `call`
    resolves `office::store::resolve(user_id, file_id)` → path + ext →
    dispatches to the crate under `spawn_blocking`; non-tabular ext → error
    naming the supported exts (csv/tsv/parquet/xlsx/xlsm).
  - `pub fn toolset(user_id: &str) -> ToolSet` — the two tools +
    `office::tools::ListFilesTool` (id browsing). No knowledge_search, no
    webread (minimal toolset; revisitable later).
- `src-tauri/src/logic/office/store.rs` — ext allowlist (line ~95) +=
  `"csv" | "tsv" | "parquet"`.
- `src-tauri/src/logic/rag.rs` — `knowledge_add_to_session` /
  import-time auto-index: skip tabular exts (associate only, no rag_files
  row). `office_index_file` on a tabular ext → guidance error pointing at the
  analytics agent.
- `src-tauri/src/logic/agent.rs`:
  - `ANALYTICS_AGENT_ID = "builtin.analytics"`.
  - `list_agents()` entry (tools: true under `#[cfg(feature = "analytics")]`).
  - `ANALYTICS_PERSONA` (draft below) + `persona_for` arm.
  - `toolset_for` arm: `analytics::toolset(user_id)` + `ArtifactRecall` +
    the pure-local `Some(set)` return arm.
  - `attachment_prompt_block`: no change (already office-gated, agent-agnostic).
- `src-tauri/src/lib.rs` — `mod analytics;` (cfg-gated).
- Frontend: `AGENT_META` entry in `frontend/src/panels/agents-rail.tsx`
  (presentation only — icon, accent, suggested prompts; ids come from
  `list_agents`). Verify the knowledge-panel import picker doesn't filter
  extensions client-side (if it carries an `accept=` list, add the exts).

Persona draft (kawai call:/response: protocol, not native function calling):

```
You are kawai's data analysis agent. You answer questions about the user's
tabular files (csv, parquet) by running structured queries through tools.
Rules:
- Call at most ONE tool per reply, as a single call:<name>{...} line, then stop and wait for the response: message.
- BEFORE the first data_query on a file, call data_schema on it — never guess column names, types, or formats.
- Compose queries from the schema: filters[] for conditions, group_by + aggregations for totals/averages/counts, sort_by + descending + limit for rankings. Numeric and date filter values are always strings ("1500", "2026-01-31").
- "How many per X" with no metric → group_by ["X"] alone (row_count is implicit).
- Files are addressed by their handle (doc1, doc2 …) exactly as shown in the attachment list or office_list_files. If unsure which file holds the data, ask or list files.
- If a response: reports an error (unknown column, bad value), fix the arguments from the valid-columns list it shows and call again — do not give up after one failure.
- Compute NOTHING yourself: sums, averages, growth rates, comparisons all come from data_query results.
- After each response: message, either call another tool or give the final answer.
- Final answers: short, factual, cite the numbers you queried; no JSON dumps.
```

### Phase 3 — smoke, CI, docs — ✅ DONE

- `src-tauri/examples/analytics_smoke.rs` — fully offline (no network, no
  model): imports generated csv + xlsx fixtures through the real office
  store → data_schema (typed columns, resolved dates, sheets echo) →
  aggregate query through the serde wire shape → date-range filter → error
  contract (unknown column + unknown sheet echo valid names) → tabular-ext
  guard.
- `.github/workflows/ci.yml`: `analytics_smoke` in all three OS smoke jobs;
  linux-check gains `cargo check --features analytics` +
  `cargo test -p analytics`.
- Docs: `AGENTS.md` (layout tree ×3, Roadmap 5 ✅ entry, MVP-3 CI list,
  verify matrix) + `ARCHITECTURE.md` (logic/ modules).

### Phase 4 — deferred (do not start without the user asking)

- `having`, `in`/`not_in`/`is_null` operators, multi-key sort,
  date-part filters (`month == 1`) instead of gte/lte ranges.
- Registering the data tools on the office agent (cross-listing).
- A non-agent data-explorer op pair (`commands.rs` + `web.rs`) if the UI ever
  needs query results outside `agent_chat`.
- Legacy `.xls` (office_oxide has a reader; needs its own bridge arm).
- **SQL sources → Parquet snapshot** (external Postgres/MySQL; local SQLite
  rides the existing libsql dep). Strategy settled 2026-08-24 after external
  proposal review: dump tables to typed Parquet snapshots in the office store
  and query them with the EXISTING `data_schema`/`data_query` — never
  Text-to-SQL against the source DB (small local orchestrator, injection
  surface, dialect drift). Design decisions:
  - **Credentials follow the binance pattern**
    (`components/binance/src/account.rs`): named profiles live in env
    (`KAWAI_SQL_PROFILE_<NAME>=<connection-url>`), NEVER as a model-supplied
    argument. Tool args are `profile` + `table` only; unknown profile name ⇒
    error listing the valid names — host/port always come from user config,
    which structurally closes credential leakage into the LLM context and
    SSRF-via-prompt-injection. Capability probe mirroring `has_credentials()`:
    the dump/import tool registers only when ≥1 profile exists (same rule as
    the binance account tools and the web-read engines).
  - **Guardrails the binance pattern does not cover** (Binance's API surface
    is fixed; SQL is arbitrary): identifier validation of `table`/schema
    against `information_schema`/`sqlite_master` + strict quoting (no raw
    interpolation); backend SELECT-only enforcement (single statement,
    keyword denylist, row/time caps on the dump); read-only DB grants as the
    outermost layer.
  - **Dump mechanics**: typed extraction per sqlx column `type_info()` —
    never String-ify columns (dtype fidelity IS the point of Parquet;
    String-ification reintroduces the csv-inference failure mode from §6);
    batched reads (keyset pagination) → incremental Parquet write under
    `spawn_blocking` with a cancellation token; consistent-snapshot read
    (REPEATABLE READ txn / sqlite backup API) with `exportedAt` surfaced in
    `_meta` so the model knows the data's age; output enters through the
    office store (file_id + aliases + `session_files`; tabular exts skip RAG
    indexing per §2).
  - **Feature graph**: `sqlx` as an optional dep behind e.g.
    `analytics-sql` (implying `analytics`), with `runtime-tokio-rustls`
    (mobile has no openssl prebuilts); polars stays pinned at 0.55 minimal
    features. Any new op gets BOTH wrappers.
  - **Intake door — DECIDED (2026-08-24): agent tools.** `data_tables(profile)`
    + `data_import(profile, table)` land as kawai-side `PortableTool`s in
    `logic/analytics.rs` (the `KnowledgeSearchTool` pattern), registered under
    a `has_sql_profiles()` capability probe (binance rule). The tool layer is
    orchestrator-agnostic — whichever LLM drives the `agent_chat` loop calls
    them through the same call:/response: protocol (local Gemma 4 first;
    remote-delegated flows reuse the same tools unchanged). Core dump logic
    stays pure fns in `logic.rs`, so an op/UI wrapper can ride the same code
    later without duplication. Consent rides the persona ("before
    data_import, state the source and estimated size and wait for user
    confirmation") plus the hard caps above; this is a documented exception
    to the single-intake knowledge-panel invariant.
  - **Escape hatch — cloud-authored SQL over polars-sql**: if queries the
    AST cannot express ever justify it, delegate SQL AUTHORING to the remote
    subagent pool (`RemoteLlm::stream`: schema + intent in materials → SQL
    text out) and execute LOCALLY via polars' SQL context over the Parquet
    snapshot — still never against the source DB. Costs one remote
    round-trip + subagent budget per authored query; the local AST stays the
    default path.

## 5. Verification gates

```sh
cargo test -p analytics                                  # Phase 1
bun run build                                            # frontend meta entry
cargo check                                              # default: analytics absent
cargo check --features web                               # web module unaffected
cargo check --features litert,office,analytics           # full agent graph
cargo run --example analytics_smoke --features analytics # offline e2e
cargo ndk -t arm64-v8a -P 24 check --features litert,office,analytics   # agent.rs is shared
cargo check --target aarch64-apple-ios --features litert,office,analytics
```

Mobile note: polars is pure Rust (no C deps with the minimal feature set);
android/iOS aarch64 expected to compile — the check confirms it before merge.
If polars' rayon thread pool misbehaves on mobile, set `POLARS_MAX_THREADS=1`
in the mobile adapters (note only; not expected).

## 6. Risks & landmines

- **Polars compile cost**: ~2–4 min cold on the feature subset; cached after.
  Keep the feature list minimal — every added feature (temporal, excel, simd)
  re-opens this. Gated behind `analytics`, so default desktop/mobile/web
  builds never pay it.
- **Two `JsonWriter`s could confuse** — polars' writer vs serde_json; the
  crate uses polars' for rows (dtype-correct) and serde_json for `_meta`;
  merge via string surgery on the output buffer, never re-parse rows.
- **Aggregation on string columns** (`sum` on Utf8) → polars error; map it to
  a friendly error naming the column's dtype and the functions it supports.
- **csv dtypes are inferred**, not declared — a mostly-numeric column with one
  `N/A` becomes Utf8 and numeric filters then fail dtype parsing. The error
  message must surface the inferred dtype (it does — the coercion error names
  it) and `data_schema` shows it up front; persona tells the model to read
  dtypes first. Do NOT add per-query cast knobs in v1.
- **K/V pressure**: schema + query results ride the same 4k excerpt / 32k
  memory budget as every other tool — `limit ≤ 100` keeps a single result
  under control; the persona discourages re-querying with huge limits.
- **`office_index_file` on tabular exts** must fail with guidance (Phase 2),
  else the knowledge panel retry loop fights the skip rule.
