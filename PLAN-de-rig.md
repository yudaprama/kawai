# Implementation Plan — Remove rig from the kawai graph

Status: **PLANNED**. Live status lands in AGENTS.md → Roadmap when phases ship.

## Why

Decision context (2026-08-25): rig has drifted from load-bearing to plumbing.

- The orchestrator is local Gemma 4 via **prompt-based tool calling** (`logic/agent.rs`) — rig's agent loop, message model, and native function-calling are bypassed entirely.
- All five cloud endpoints (zai → venice → opencode → openrouter → ollama) are **OpenAI-compatible**; `logic/remote.rs` uses only `rig::providers::openai` streaming against them.
- Embeddings already run through kawai's own `KawaiProvider` trait with raw-reqwest HTTP (`kawai-embedding/src/lib.rs`); rig supplies only type seams.
- The vector store is our own crate (`rig-libsql`) implementing rig's traits over libsql we already own.

What rig costs: permanent cross-crate version coordination ("one rig-core source" landmine spans `src-tauri`, `rig-components/*`, `rig-libsql`, `kawai-embedding`, `local-llm`, plus the `gen` template), dep-graph weight, and upgrade churn — for zero behavior the app exercises.

Replacement budget: ~700 LOC total — a ~150-line tool trait/registry crate, a ~300-line OpenAI-compatible SSE client, ~200 lines of direct-SQL vector ops, plus mechanical porting of existing tool impls.

## Current rig touchpoints (full inventory)

| # | Surface | Files | Rig items used |
|---|---|---|---|
| 1 | Tool seam | `src-tauri/src/logic/{office/tools.rs,office/mod.rs,analytics.rs,agent.rs}`; `src-tauri/examples/{web_search_check,analytics_smoke,binance_smoke}.rs`; `rig-components/{binance,webread,analytics}/src/*`; `rig-components/tools/*/*.gen.rs` + `httpclient.rs` (ToolBase); `rig-components/gen/src/main.rs:162` (template emits `use rig::tool::PortableTool;`); `local-llm` (`rig-tools` feature) | `PortableTool`, `ToolSet`, `ToolContext`, `ToolResult`, `ToolOutput` |
| 2 | Cloud client | `src-tauri/src/logic/remote.rs` | `providers::openai::{CompletionModel, Client}`, `streaming::StreamedAssistantContent`, `message::Reasoning{Content}`, `http_client::HeaderMap`, `client::{CompletionClient, BearerAuth}` |
| 3 | Vector seam | `src-tauri/src/logic/rag.rs:33-38` | `Embed` derive, `EmbeddingsBuilder`, `InsertDocuments`, `VectorStoreIndex`, `VectorSearchRequest`, `LibsqlSearchFilter` |
| 4 | Vector store impl | `rig-libsql/` (workspace member) | implements `InsertDocuments`, `VectorStoreIndex`; uses `embeddings::{Embedding, EmbeddingModel}` |
| 5 | Embedding providers | `kawai-embedding/src/lib.rs:36,591,642`; `cognee-litert-lm/src/embedder.rs:13` | `rig_core::embeddings::{Embedding, EmbeddingError, EmbeddingModel}`; `rig_fastembed` (desktop-only fastembed wrapper) |
| 6 | Dead weight | `rig-examples/` (upstream reference examples); `rig-components/providers/{ollama,opencode,openrouter,venice,zai}` (referenced by **no** Cargo.toml) | delete outright |

Not touched: `binance-connector-rust` fork, `ta`, `jigsawstack`, `ragloader`, `youtube_transcript`, `webread` engine chain (only its tool wrappers carry the trait).

## Target architecture

```
kawai-tools (NEW, ~150 LOC, deps: serde_json + async-trait only)
├── trait AgentTool { name() / description() / schema() -> Value /
│                     call(args: Value) -> Result<String, String> }   // boxed-future async
└── struct ToolSet   { tools: HashMap<String, Arc<dyn AgentTool>> }
    add_tool / definitions() / get(name) / call(name, args)

logic/remote.rs  ── hand-rolled reqwest SSE client (OpenAI chat/completions,
                    stream=true) — replaces rig providers::openai
logic/rag.rs     ── direct SQL: embed via kawai-embedding → INSERT rag_rows
                    (+ embedding col) → candidate-scoped SELECT → cosine top-k
kawai-embedding  ── drops rig-core + rig-fastembed; `fastembed` crate directly;
                    everything speaks the existing KawaiProvider trait
```

Design constraints carried over unchanged:

- **Agent loop semantics frozen**: prompt-embedded manifest, JSON `call:` parsing, TurnMemory, recall interception, MAX_TOOL_CALLS budget — none of it touches rig today except the `ToolSet` handle it receives.
- **Failover contract preserved**: fixed priority pool, health/cooldown tracker (`Retry-After` capped 300s, process-global), failover boundary = first text token handed to the consumer, usage captured from the terminal chunk, reasoning-delta flattening, `finish_reason=length` ⇒ `hit_cap`. These live in `remote.rs`/`agent.rs` already — only the transport swaps underneath.
- **Guidance-error convention**: tools return errors as strings that teach valid inputs (`agent.rs` feeds them back verbatim) — the new `call` signature keeps `String` results/errors exactly.
- **Per-user scale**: RAG candidate sets are session-scoped file lists; in-process cosine over candidate rows is trivially fast at this scale. The FTS5/BM25 mirror and RRF fusion stay as-is (they never touched rig).

## Phases (each commit keeps the full check battery green)

### Phase 1 — introduce `kawai-tools` (additive, trivially green)
New workspace member at repo root. Mirror the rig surface the code actually uses so Phase 2 stays mechanical: `add_tool`, name-keyed lookup, `Value` args, `String` out, definitions list for prompt embedding. Include unit tests (registry, duplicate-name rejection, definitions serialization).

### Phase 2 — atomic tool-seam flip (one commit; cannot be split)
The whole graph shares one `ToolSet` type, so every `PortableTool` impl flips together:

1. Update `rig-components/gen/src/main.rs` template to emit `kawai_tools::AgentTool`; regenerate all `.gen.rs` files (`cargo run -p rig-components-gen -- --category <each>`), commit regenerated output.
2. Flip `impl rig::tool::PortableTool for X` → `impl AgentTool for X` in: `rig-components/{binance,webread,analytics}`, `tools/*/httpclient.rs` ToolBase, `src-tauri` office/analytics tools, `agent.rs` subagents (`DeepWrite`/`DraftDocument`/`ArtifactRecall` stubs), examples.
3. Swap `toolset_for` builders + the `agent.rs` dispatch site (~3402) + `tool_result_body` onto `kawai_tools::ToolSet`.
4. `local-llm`: retarget its `rig-tools` feature (or drop the feature — audit its actual use first).
5. Delete `rig-examples/` and `rig-components/providers/*`.

Mechanical, broad, low-risk — gated by `cargo check` × feature matrix + `cargo test -p analytics -p webread` + the three smoke examples that construct tools directly.

### Phase 3 — cloud client swap (self-contained)
Rewrite `remote.rs`'s transport as reqwest POST `/chat/completions` (`stream: true`), SSE line parser mapping:
`delta.content` → Token · `delta.reasoning_content` → Reasoning{reset on provider switch} · terminal `usage` chunk → Done · `finish_reason == "length"` → hit_cap · `[DONE]` sentinel · non-200/transport errors → retryable classification feeding the existing cooldown tracker.

Verify: `remote_smoke`, `draft_smoke`, `turn_log_report`, then `agent_eval` (E4B baseline must hold 20/20). No frontend/API changes.

### Phase 4 — RAG + embeddings de-rig
1. Inspect the live `rag_chunks` schema rig-libsql creates; write migration `0007_rag_vectors.sql` if the embedding storage format changes (likely: add `embedding BLOB` f32 little-endian; JSON fallback acceptable). Re-index note: chunks remain valid; stale-format rows re-ingest to reindex (same guidance as the pdf_oxide switch).
2. Replace `EmbeddingsBuilder`/`insert_documents`/`vector_search` in `rag.rs` with: embed batch via `KawaiProvider` → bulk INSERT → candidate-scoped SELECT (file_id IN) → cosine top-k in Rust. RRF fusion with BM25 unchanged.
3. `kawai-embedding`: drop `rig-core` + `rig_fastembed`; adopt the `fastembed` crate directly behind the existing desktop cfg-gate; keep `KawaiProvider` as the single trait; move any rig type aliases out.
4. `cognee-litert-lm/src/embedder.rs`: speak `KawaiProvider` (or return `Vec<f64>` directly).
5. Retire `rig-libsql` (fold any surviving helper into `rag.rs`), remove from workspace.

Verify: knowledge ingest e2e (import → ready badge → hybrid/semantic/keyword search), `cargo test --features litert,office --lib`, mobile checks (shared-code change): `cargo ndk -t arm64-v8a -P 24 check` + `cargo check --target aarch64-apple-ios`.

### Phase 5 — purge + docs hygiene (same-commit rule)
- Strip `rig`/`rig-core`/`rig-libsql`/`rig-fastembed` from every Cargo.toml; refresh both lockfiles (`rig-components/Cargo.lock` + root).
- Confirm the reqwest pair may collapse to one version in the graph (0.12 vs 0.13 landmine shrinks or dies).
- Grep-clean mentions: `grep -rn "rig" AGENTS.md ARCHITECTURE.md PLAN-*.md scripts/ .github/` — rewrite "one rig-core source" landmine, Where-things-live entries (`rig-components` keeps its name as the tool-crate family? see Open questions), roadmap text, script comments. Rename decision below gates how far the grep can go.
- Full battery: `bun run build`, `cargo check`, `--features web/litert/office/binance/webread/analytics`, `-p analytics`/`-p webread` tests, smokes, mobile.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| SSE parity misses (zai reasoning deltas, usage-on-last-chunk quirks, keep-alive handling) | Port against real providers via `remote_smoke`/`draft_smoke` before merging Phase 3; `turn_log_report` diff pre/post usage telemetry; `agent_eval` gate |
| Stored-vector format mismatch breaks existing indexes | Migration 0007 + read-time tolerance (old rows still searchable via BM25 until re-ingest); document reindex path |
| Regenerated `.gen.rs` drift | Template change and regeneration land in the same commit; deterministic generator already emits byte-stable output |
| Hidden rig coupling surfaces mid-flip | Phase 2 is one atomic commit — bisectable as a unit; inventory table above is grep-derived and complete as of planning |
| Vault-provider edge cases (opencode custom headers, venice model names) | Header construction already lives in `remote.rs` (`random_id`, HeaderMap) — carried over verbatim |

## Open questions (defaults chosen; flip freely)

1. **Crate name**: default `kawai-tools`. Alternative: fold the trait into an existing leaf crate to avoid a new member — rejected: every tool crate would then depend on that crate's deps.
2. **`rig-components` directory rename** (e.g. `components/` or `toolkits/`): renaming maximizes doc cleanliness but churns every Cargo.toml path + submodule-adjacent CI. Default: keep the directory name, treat "rig-components" as historical branding; revisit post-MVP.
3. **async runtime of `AgentTool::call`**: default boxed future (`Pin<Box<dyn Future>>`) for dyn-compatibility, matching how the dispatch loop consumes tools; `#[async_trait]` is already in-tree (ragloader).
