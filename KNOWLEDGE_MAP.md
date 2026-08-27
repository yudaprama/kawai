# Knowledge Architecture — Kawai

> Document knowledge (RAG + GraphRAG), long-term memory (Skills + L1), and the agent's working memory. One `libSQL` per-user (`kawai.db`). All `feature`-gated — `cargo check` without `graph`/`office` costs nothing.

**TL;DR:** Kawai keeps document knowledge (RAG + GraphRAG) and long-term memory (Skills + L1) in a single per-user `libSQL` file. Document retrieval is hybrid vector+FTS5 with RRF (`k=60`); GraphRAG adds 5 arms over the same DB. Skills and L1 memories are plain-SQLite CRUD — versioned/bounded prompt injection into the agent, no vectors yet.

---

## 1. Module Layout

```
crates/
├── auth (kawai-auth)        OIDC JWT Verifier/Claims/Session (pure, no transport)
├── remote-llm (remote-llm)  Hybrid cloud pool (zai→empero, health-aware failover, SSE)
├── db (kawai-db)            Per-user SQLite (sessions/messages/artifacts/turn_log + migrations 0001-0009, office/analytics gated)
├── skills (kawai-skills)    SKILL.md CRUD + prompt injection (4k/skill, 12k total, ungated)
├── memory (kawai-memory)    L1 memories CRUD + cloud extraction + prompt injection (ungated)
├── office (kawai-office)    Document store (opaque ids, meta.json, kawai-db) + ooxml/pdf/deck + AgentTool wrappers (office_* , pdf_*)
├── knowledge (kawai-knowledge)  RAG (types/schema/search/ingest/session/tools KnowledgeSearchTool) + GraphRAG graph/* (5 arms)
├── analytics-tools (kawai-analytics)  Thin wrappers over crates/analytics engine (data_schema/query/ta/chart + sql_profiles + sql_remote)
├── agent (kawai-agent)      Prompt-based tool-calling loop (opener/delta, TurnMemory, subagents DeepWrite/DraftDocument/ArtifactRecall, evidence_cache LRU)
├── analytics (analytics)    Polars engine (discover/query/ta_suite/chart, office_oxide bridge)
├── graph (graph)            Standalone libSQL GraphRAG (Naive/Local/Global/Hybrid/Mix, pure)
├── webread (webread)        Tiered web_read/search (webview → Cloudflare /markdown, LRU, budgets)
└── tools/*, ragloader, etc  Per-category AgentTool crates + parsers

src-tauri/src/
├── logic.rs                 Pure helpers (greet/whoami/generate_activity, resolve_model_path/ensure_model, generate_session_title → kawai-db, delete_chat_session → evidence_cache)
├── logic/                   Thin shims: db/db_migrations/skills/memory/office/knowledge/rag/graph/analytics/sql_remote/agent/evidence_cache → crates/* (pub use kawai_*)
├── auth.rs                  Shim → kawai-auth
└── logic/knowledge, logic/rag, logic/graph shims → kawai-knowledge / kawai-knowledge::graph
```

**Backward compat:** `logic::rag::*`, `logic::graph::*`, `logic::db::*`, `logic::skills::*`, `logic::memory::*`, `logic::office::*`, `logic::knowledge::*`, `logic::analytics::*`, `logic::agent::*`, `logic::evidence_cache::*` are thin `pub use kawai_*::*` shims — all existing call sites (`commands.rs`, `web.rs`, `agent.rs`) continue to work unchanged. `crates/` is a git submodule (`https://github.com/yudaprama/crates.git`).

---

## 2. Data Flow

```
[User import] office_import_file
      ├─→ rag:    extract_text → chunk 1500/200 → embed → rag_* → knowledge_search (Hybrid)
      └─→ graph:  extract_text → chunk 1200/150 → entities → graph_nodes/edges → embed → graph_search (Mix)
```

Per-user `logic::db_connection(user_id)` → `~/Library/Application Support/pro.kawai.app/<user>/kawai.db` (Tauri) or `/tmp/kawai/<user>` (headless).

---

## 3. Component Map

### 3.1 Document Knowledge (RAG + Graph) — `kawai-knowledge` + `graph`

| # | Crate | Role | Input → Output | `libSQL` Tables | Feature |
|---|---|---|---|---|---|
| **1** | `crates/ragloader` | Upstream parser — `docx/xlsx/pptx→office_oxide`, `pdf→pdf_oxide`, `md→MarkdownSplitter`, images→`DescriberChain` | `Path` → `Vec<Chunk>` | — (stateless) | `office` |
| **2** | `kawai-embedding` | Multi-provider embedder — `OpenAI 1024` / `Nvidia` / `Gemini` / `LitertProvider EmbeddingGemma 768d` | `Vec<String>` → `Vec<Vec<f64>>` | — | `kawai-embedding` |
| **3** | `kawai-knowledge` `schema`+`ingest` | Classic RAG — schema DDL, chunk → embed → insert (1500/200) | `Path` → indexed chunks | `rag_chunks` / `_embeddings` / `_map` + `rag_chunks_fts` + `rag_files` + `session_files` | `kawai-knowledge/office` (via `office`) |
| **4** | `kawai-knowledge` `search`+`tools` | Retrieval — vector + BM25 + RRF (`k=60`) + `KnowledgeSearchTool` (`kawai_tools::AgentTool`) | `query, mode` → `Vec<RagHit>` | — | `kawai-knowledge/office` |
| **5** | `kawai-knowledge` `session` | Session-scoped file management — association, list, add, forget, import, delete | — | `session_files` | `kawai-knowledge/office` |
| **6** | `crates/graph` (`graph`) **and** `kawai-knowledge` `graph/schema`+`ingest` | GraphRAG indexing — entity extraction (`\b[A-Z][a-z]+`, FNV `%8`), embedding, node/edge storage | `text` → `graph_nodes/edges` | `graph_nodes / _embeddings / _map` + `graph_edges / _...` + `graph_files` | `graph` (`kawai-knowledge/graph` + `graph` crate) |
| **7** | `kawai-knowledge` `graph/search` / `crates/graph` | GraphRAG retrieval — 5 arms (Naive/Local/Global/Hybrid/Mix) + RRF | `query, mode` → `Vec<GraphHit>` | — | `graph` |
| **8** | `kawai-knowledge` `graph/tools` / `crates/graph` | Agent toolset — `graph_search`, `graph_list`, `graph_forget`, `graph_stats` | — | — | `graph` |

### 3.2 Skills & Memories (long-term, plain SQLite) — `kawai-skills` + `kawai-memory`

| # | Crate | Role | `libSQL` Tables | Feature |
|---|---|---|---|---|
| **9** | `kawai-skills` (`crates/skills`) | SKILL.md CRUD (unique name, version bump, `skl-` base62 id) + bounded prompt injection (4k/skill, 12k total, `prompt_block()`) | `skills` — `migrations/0008_skills.sql` | ungated |
| **10** | `kawai-memory` (`crates/memory`) | L1 memories — atomic items (`preference/rule/event/fact/goal`); cloud extraction (tail 24k chars → `remote-llm` one-shot → JSON → title dedup, `kawai-knowledge` not needed) + prompt injection (800 char/entry · 4k total · 24 items max, `prompt_block()`) | `memories` — `migrations/0009_memories.sql` | ungated CRUD; extraction needs `remote-llm` vault |

### 3.3 Agent Working Memory — `kawai-agent`

| # | Crate / File | Role | Storage | Feature |
|---|---|---|---|---|
| **11** | `kawai-agent` `evidence_cache` + `artifacts::TurnMemory` | Per-session process log (`session_artifacts` handles `mem1…`) + cross-turn file-read LRU (`FileScoped` probe, `mtime+size` fingerprint, 64 entries / 1M chars / 8 sessions) — verbatim tool outputs, survives turns & restarts. `evidence_cache` is `kawai_agent::evidence_cache` (in-process, no SQLite beyond `session_artifacts`). | `session_artifacts` — `migrations/0007` (log) + in-process LRU | ungated (LRU) + `kawai-agent` (`litert` for loop) |

**Not semantic:** no embedding, no dedup, no summarization — *episodic/operational*. Complementary to L1 memories, not competing. **Don't index `session_artifacts.content` into `rag_chunks`** — it would pollute the document vector space with transient tool output.

---

## 4. GraphRAG — 5 Arms

| Arm | Idea | SQL / Rust | Location |
|---|---|---|---|
| **Naive** | Query → embed → vector (plain) | `vector_distance_cos` + `ROW_NUMBER() OVER (PARTITION BY docid)` | `graph/search.rs` `vector_search_nodes()` |
| **Local** | Extract entities → 1–2 hop | `LIKE %token%` → `WITH RECURSIVE … depth<2 JOIN graph_edges` | `graph/search.rs` `local_traversal()` |
| **Global** | Embed relationship → community | `vector_search_edges` → `community_id IN (…)` | `graph/search.rs` `global_community_hits()` |
| **Hybrid** | Local+Global+Naive → equal RRF | `tokio::join!` → `1/(60+rank+1)` | `graph/search.rs` `graph_search()` hybrid arm |
| **Mix** | Weighted RRF (production default) | Same + weights `0.2 / 0.5 / 0.3` | `graph/search.rs` `graph_search()` mix arm via `mode="mix"` |

---

## 5. Feature Gates

```toml
# src-tauri/Cargo.toml
kawai-auth, remote-llm, kawai-db, kawai-skills, kawai-memory # always
graph  = ["dep:graph","dep:kawai-embedding","dep:text-splitter","dep:regex","dep:kawai-knowledge","kawai-knowledge/graph","kawai-agent/graph"]
office = ["dep:base64","dep:kawai-embedding","dep:text-splitter","dep:ragloader","dep:youtube_transcript","dep:office_oxide","dep:pdf_oxide","dep:regex","webread","kawai-db/office","dep:kawai-office","dep:kawai-knowledge","kawai-knowledge/office","kawai-agent/office"]
# office always pulls kawai-knowledge; analytics pulls office + kawai-analytics
analytics = ["dep:analytics","office","kawai-db/analytics","dep:kawai-analytics","kawai-agent/analytics"]
```

```sh
cargo check                                          # no office/graph → kawai-knowledge/graph stubs, kawai-office/knowledge not compiled, zero DB
cargo check -p kawai-db -p kawai-skills -p kawai-memory  # storage only (no office/graph)
cargo check -p kawai-office --features office        # store + ooxml/pdf/deck
cargo check -p kawai-knowledge --features office     # RAG (vector + FTS5)
cargo check -p kawai-knowledge --features office,graph  # RAG + GraphRAG (1 DB, separate tables)
cargo check --features graph,office,litert           # full desktop (office+graph+agent)
cargo check -p graph -p kawai-agent --features litert,office  # pure crates
```

*Include:* `bun tauri build -- --features graph,office,litert`
*Exclude:* drop `graph`/`office` from `--features` — `kawai-knowledge`/`kawai-office` not compiled, no `rag_*`/`graph_*` tables.

---

## 6. When to Use Which

| Query type | Best path | Why |
|---|---|---|
| Exact keyword (`INV-88421`) | `rag` `mode=keyword` (FTS5) | BM25 matches codes/numbers exactly |
| Paraphrase / synonym | `rag` `mode=semantic` or `graph` `naive` | Vector similarity captures meaning |
| Multi-hop (`Alice→Bob→Jakarta`) | `graph` `mode=local` (2-hop) | Recursive CTE traverses edges |
| Big picture / themes | `graph` `mode=global` (community) | Community expansion surfaces clusters |
| Most comprehensive | `graph` `mode=mix` or **fusion** `rag+graph` (`tokio::join!` → RRF) | All arms combined |

---

## 7. Verification

```sh
cargo check --features graph,office,litert
cargo check -p kawai-db --lib && cargo test -p kawai-db  # 6 migrations tests
cargo test -p kawai-skills -p kawai-memory --lib          # skills 1/1, memory 4/4
cargo test -p kawai-knowledge --features office,graph     # RAG + GraphRAG
cargo test -p kawai-office --lib
cargo test -p kawai-analytics --lib  # polars engine; wrapper tests in kawai-analytics
cargo test -p graph --lib && cargo test -p kawai-agent --features litert,office,analytics,graph
cargo test -p ragloader --lib
bun run build
```

---

## 8. Comparison with TencentDB-Agent-Memory

| Dimension | Kawai | Tencent | Notes |
|---|---|---|---|
| Chunking | `MarkdownSplitter` 1500/200, Graph 1200/150 | Wiki `chunker.ts` 12K/400 (trigger 28K) | ~8× granularity gap |
| Embedding | `OpenAI 1024` / `Nvidia` / `Gemini` / `EmbeddingGemma 768d` | Any OpenAI-compatible + `embeddinggemma-300m-q8_0` | Same 300M model, different provider wiring |
| Vector store | libSQL `FLOAT32(dims)` + `libsql_vector_idx` | Prod TCVDB; standalone `vec0` | Same hybrid logic, different engine |
| Keyword search | FTS5 `rag_chunks_fts` + `bm25() ASC` | FTS5 + BM25 | Identical pattern |
| Hybrid ranking | RRF `k=60` + Mix weights `0.2/0.5/0.3` | RRF `k=60`, `candidateK=limit×3` | Kawai is a superset |
| Graph extraction | Regex `\b[A-Z][a-z]+`, FNV `%8` | LLM two-stage → `[[]]` wikilinks; Code AST | Zero-LLM vs. LLM+AST |
| Graph traversal | `WITH RECURSIVE depth<2` + `community_id IN` | `graphology` BFS `hop/decay/maxNodes=200` | Same topology; kawai lacks `decay`/`maxNodes` tuning |
| Layered memory | L0 `sessions/messages`; L1 `memories` + `prompt_block()` | L0–L3 (JSONL + vec0 + LLM dedup) | Kawai L0+L1 basic; Tencent has L2 scenes + L3 persona |
| Skills | CRUD + `prompt_block()` — no vectors yet | CRUD + `vec0` + FTS5 + RRF + TTL | Kawai vector/FTS5 not yet |
| Storage | Per-user `~/Library/.../kawai.db` | COS STS + Redis + OTEL/Langfuse/Kafka | Per-user ↔ per-namespace mapping is 1:1 |

**Don't delete `rag` for `graph`** — lexical vs. relations. Production is `rag+graph → RRF`.

---

## 9. Architecture Invariants

1. **User isolation is structural** — one DB file per user (`db_connection(user_id)`), no `user_id` columns.
2. **Chunks belong to files; files belong to sessions** — `session_files(session_id, file_id)` scopes search.
3. **Session id is bound server-side** — the model never provides `user_id` or `session_id`.
4. **Don't mix 768d and 1024d** — cross-dim mixing blocked; re-index on switch.
5. **Don't index transient tool output** — `session_artifacts` stays out of `rag_chunks`.
6. **Skills and L1 memories inject at opener build** — mid-session saves apply from the next session.
