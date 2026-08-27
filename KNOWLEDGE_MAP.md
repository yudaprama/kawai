# Knowledge Architecture — Kawai

> Document knowledge (RAG + GraphRAG), long-term memory (Skills + L1), and the agent's working memory. One `libSQL` per-user (`kawai.db`). All `feature`-gated — `cargo check` without `graph`/`office` costs nothing.

**TL;DR:** Kawai keeps document knowledge (RAG + GraphRAG) and long-term memory (Skills + L1) in a single per-user `libSQL` file. Document retrieval is hybrid vector+FTS5 with RRF (`k=60`); GraphRAG adds 5 arms over the same DB. Skills and L1 memories are plain-SQLite CRUD — versioned/bounded prompt injection into the agent, no vectors yet.

---

## 1. Module Layout

```
logic/
├── knowledge/              ← document knowledge subsystem (rag + graph)
│   ├── types.rs            RagChunk, RagHit, IndexStatus, KnowledgeFileInfo, SearchMode
│   ├── schema.rs           libSQL DDL (vector tables, FTS5 mirror), insert/search SQL
│   ├── search.rs           vector_search, bm25_search, RRF fusion, knowledge_search
│   ├── ingest.rs           chunking (MarkdownSplitter), text extraction, index pipeline
│   ├── session.rs          file association, knowledge panel list, management ops
│   └── graph/              ← GraphRAG (feature "graph")
│       ├── types.rs        GraphHit, GraphSearchMode, GraphStats, entity extraction
│       ├── schema.rs       graph DDL, file status, purge, batch insert
│       ├── search.rs       vector/CTE/community arms, RRF, graph_search
│       ├── ingest.rs       entity extraction, chunking, graph_index_file/text
│       └── tools.rs        GraphToolError, toolset, graph_list, graph_forget, graph_stats
├── skills.rs               SKILL.md CRUD + prompt injection (ungated)
├── memory.rs               L1 memories CRUD + cloud extraction + prompt injection (ungated)
├── agent.rs                prompt-based tool-calling loop, TurnMemory, cloud subagents
├── office/                 document editing/extraction, file store, decks, PDF
├── analytics.rs            tabular query engine, SQL sources, chart generation
└── db.rs / db_migrations.rs   per-user SQLite, schema migrations
```

**Backward compat:** `logic::rag::*` and `logic::graph::*` are thin re-export shims — all existing call sites (`commands.rs`, `web.rs`, `agent.rs`) continue to work unchanged.

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

### 3.1 Document Knowledge (RAG + Graph)

| # | Crate / File | Role | Input → Output | `libSQL` Tables | Feature |
|---|---|---|---|---|---|
| **1** | `crates/ragloader` | Upstream parser — `docx/xlsx/pptx→office_oxide`, `pdf→pdf_oxide`, `md→MarkdownSplitter`, images→`DescriberChain` | `Path` → `Vec<Chunk>` | — (stateless) | `office` |
| **2** | `kawai-embedding` | Multi-provider embedder — `OpenAI 1024` / `Nvidia` / `Gemini` / `LitertProvider EmbeddingGemma 768d` | `Vec<String>` → `Vec<Vec<f64>>` | — | `kawai-embedding` |
| **3** | `knowledge/schema.rs` + `knowledge/ingest.rs` | Classic RAG — schema DDL, chunk → embed → insert | `Path` → indexed chunks | `rag_chunks` / `_embeddings` / `_map` + `rag_chunks_fts` + `rag_files` + `session_files` | `office` |
| **4** | `knowledge/search.rs` | Retrieval — vector + BM25 + RRF fusion | `query, mode` → `Vec<RagHit>` | — | `office` |
| **5** | `knowledge/session.rs` | Session-scoped file management — association, list, add, forget, import, delete | — | `session_files` | `office` |
| **6** | `knowledge/graph/schema.rs` + `knowledge/graph/ingest.rs` | GraphRAG indexing — entity extraction, embedding, node/edge storage | `text` → `graph_nodes/edges` | `graph_nodes / _embeddings / _map` + `graph_edges / _...` + `graph_files` | `graph` |
| **7** | `knowledge/graph/search.rs` | GraphRAG retrieval — 5 arms (Naive/Local/Global/Hybrid/Mix) + RRF | `query, mode` → `Vec<GraphHit>` | — | `graph` |
| **8** | `knowledge/graph/tools.rs` | Agent toolset — `graph_search`, `graph_list`, `graph_forget`, `graph_stats` | — | — | `graph` |

### 3.2 Skills & Memories (long-term, plain SQLite)

| # | File | Role | `libSQL` Tables | Feature |
|---|---|---|---|---|
| **9** | `skills.rs` | SKILL.md CRUD (unique name, version bump, `skl-` base62 id) + bounded prompt injection (4k/skill, 12k total) | `skills` — `migrations/0008_skills.sql` | ungated |
| **10** | `memory.rs` | L1 memories — atomic items (`preference/rule/event/fact/goal`); cloud extraction (tail 24k chars → RemoteLlm one-shot → JSON → title dedup) + prompt injection (800 char/entry · 4k total · 24 items max) | `memories` — `migrations/0009_memories.sql` | ungated CRUD; extraction needs vault |

### 3.3 Agent Working Memory

| # | File | Role | Storage | Feature |
|---|---|---|---|---|
| **11** | `agent.rs` `TurnMemory` | Per-session process log — verbatim tool outputs, one entry per distinct `tool+args_key` (handle `mem1, mem2 …`). Survives turns & restarts. | `session_artifacts` — `migrations/0007` | ungated |

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
graph  = ["dep:graph","dep:kawai-embedding","dep:text-splitter","dep:regex"]
office = ["dep:ragloader","dep:kawai-embedding",...,"webread"]
```

```sh
cargo check                          # no graph/office → stubs, zero DB
cargo check --features graph         # GraphRAG only
cargo check --features graph,office  # RAG + GraphRAG (1 DB, separate tables)
cargo check -p graph                 # pure crate only
```

*Include:* `bun tauri build -- --features graph,office,litert`
*Exclude:* drop `graph` from `--features` — no `graph_nodes/edges`.

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
cargo check --features graph,web,office,litert
cargo test --features 'office,graph' --lib -- knowledge
cargo test -p graph --lib
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
