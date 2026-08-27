# Knowledge Architecture — Kawai

> Document knowledge (RAG), long-term memory (Skills + L1), and the agent's working memory. One `libSQL` per-user (`kawai.db`). All `feature`-gated — `cargo check` without `graph`/`office` costs nothing. GraphRAG exists in the same DB but is **RPC-only** (not wired to the agent toolset).

**TL;DR:** In chat, the agent has exactly **one** retrieval tool — `knowledge_search(query, mode)` — and the **model** picks the mode (`hybrid` = vector+BM25 fused via RRF, `semantic`, `keyword`). Skills and L1 memories are plain-SQLite CRUD with bounded prompt injection at opener build. GraphRAG (5 arms) is stored in the same DB and callable via RPC, but no agent toolset registers it — experimental, not part of the chat path. Start at §0 for "when to use what".

---

## 0. When to Use What — read this first

> **In day-to-day use you almost never choose anything.** Only three real decisions exist: (1) attach a file to the session or not, (2) save something as a **Skill** or as a **Memory**, (3) done. The retrieval mode is picked by the **model**, not by you.

### Five drawers — one question each

| Drawer | Answers the question | Who fills it | What you do |
|---|---|---|---|
| **Knowledge (RAG)** | "What's in my documents?" | You: import files/YouTube into the session (Knowledge panel) | Import → just ask |
| **Skills** | "How do I want the agent to work?" (procedures, style, working rules) | You: write manually (Assets → Skills) | Write once; applies from the next session |
| **L1 Memory** | "Who am I?" (facts, preferences, goals) | You manually, or extracted from a session transcript | Mention it in chat → extract; or write manually |
| **Session evidence** | "What just happened in this session?" | Automatic (TurnMemory + evidence cache) | Nothing |
| **GraphRAG** | (serves nothing in chat yet) | — | Ignore — RPC-only, not wired to the agent toolset (see §4) |

### Situation table

| Real situation | What you do | What happens inside |
|---|---|---|
| "Answer from this PDF contract" | Import into the session → ask | Hybrid RAG (vector + BM25) fetches passages; the agent reads the file if needed |
| "Find INV-88421 in the documents" | Just ask | Model picks `keyword` mode (BM25, exact match) |
| "Explain concept X from this paper" | Just ask | Model picks `semantic`/`hybrid` (vector) |
| "Whenever I ask for a monthly report, always use this format" | Write a **Skill** | Injected into the persona from the next session |
| "Remember, I trade crypto and I'm risk-averse" | Say it in chat → extract (or write a **Memory** manually) | Goes into `<memories>`, injected every session |
| Confused Skill vs Memory? | Skill = *how to work*; Memory = *facts about you* | — |

What **nobody** can decide in chat: GraphRAG (5 arms) and "rag+graph fusion". `graph_search` is not registered as an agent tool — it is only callable via RPC (`commands.rs`/`web.rs`) — and no combined rag+graph tool exists; the `tokio::join!` in the code fuses the 3 graph arms with each other only.

For the technology behind all of these drawers, see §3.4.

---

## 1. Module Layout (knowledge-scoped)

Only what this document covers — the rest of the repo (auth, analytics, binance, webread, generated tools, …) is out of scope here; see `AGENTS.md` for the full map.

```
crates/ (git submodule)
├── foundation/
│   ├── db/ (kawai-db)          Per-user SQLite — owns every knowledge table (rag_* / graph_* / skills / memories / session_artifacts) + migrations 0001-0009
│   ├── skills/ (kawai-skills)  SKILL.md CRUD + prompt injection (4k/skill, 12k total, ungated)
│   └── memory/ (kawai-memory)  L1 memories CRUD + cloud extraction (via remote-llm) + prompt injection (ungated)
├── engines/
│   ├── agent/ (kawai-agent)    Tool-calling loop + working memory (TurnMemory → session_artifacts, evidence_cache LRU); consumes knowledge_search
│   ├── graph/ (graph)          Standalone libSQL GraphRAG (Naive/Local/Global/Hybrid/Mix, pure)
│   ├── knowledge/ (kawai-knowledge)  RAG (types/schema/search/ingest/session/tools, KnowledgeSearchTool) + GraphRAG graph/* (5 arms)
│   └── office/ (kawai-office)  Document store (opaque ids, meta.json, kawai-db) — the intake feeding RAG/graph indexing
└── integrations/
    ├── ragloader/              Upstream parser (docx/xlsx/pptx/pdf/md/images) for ingest
    └── youtube-transcript/     YouTube import (knowledge_import_youtube)

kawai-embedding/                Multi-provider embedder (OpenAI/NVIDIA/Gemini/LiteRT) — repo root, outside the submodule; used by ingest + query

src-tauri/src/ (transport edge only)
├── logic/knowledge, logic/rag, logic/graph   thin `pub use kawai_knowledge::*` re-exports (call-site compat)
└── commands.rs / web.rs        expose knowledge_* / graph_* ops — knowledge_search is the only retrieval tool wired into the agent toolset
```

**Backward compat:** the `logic::*` shims (`rag`, `graph`, `knowledge`, `db`, `skills`, `memory`, `office`, `agent`, `evidence_cache`, …) are thin `pub use kawai_*::*` re-exports — existing call sites (`commands.rs`, `web.rs`, `agent.rs`) keep working unchanged.

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
| **1** | `crates/integrations/ragloader` | Upstream parser — `docx/xlsx/pptx→office_oxide`, `pdf→pdf_oxide`, `md→MarkdownSplitter`, images→`DescriberChain` | `Path` → `Vec<Chunk>` | — (stateless) | `office` |
| **2** | `kawai-embedding` | Multi-provider embedder — `OpenAI 1024` / `Nvidia` / `Gemini` / `LitertProvider EmbeddingGemma 768d` | `Vec<String>` → `Vec<Vec<f64>>` | — | `kawai-embedding` |
| **3** | `kawai-knowledge` `schema`+`ingest` | Classic RAG — schema DDL, chunk → embed → insert (1500/200) | `Path` → indexed chunks | `rag_chunks` / `_embeddings` / `_map` + `rag_chunks_fts` + `rag_files` + `session_files` | `kawai-knowledge/office` (via `office`) |
| **4** | `kawai-knowledge` `search`+`tools` | Retrieval — vector + BM25 + RRF (`k=60`) + `KnowledgeSearchTool` (`kawai_tools::AgentTool`) | `query, mode` → `Vec<RagHit>` | — | `kawai-knowledge/office` |
| **5** | `kawai-knowledge` `session` | Session-scoped file management — association, list, add, forget, import, delete | — | `session_files` | `kawai-knowledge/office` |
| **6** | `crates/engines/graph` (`graph`) **and** `kawai-knowledge` `graph/schema`+`ingest` | GraphRAG indexing — entity extraction (`\b[A-Z][a-z]+`, FNV `%8`), embedding, node/edge storage | `text` → `graph_nodes/edges` | `graph_nodes / _embeddings / _map` + `graph_edges / _...` + `graph_files` | `graph` (`kawai-knowledge/graph` + `graph` crate) |
| **7** | `kawai-knowledge` `graph/search` / `crates/engines/graph` | GraphRAG retrieval — 5 arms (Naive/Local/Global/Hybrid/Mix) + RRF | `query, mode` → `Vec<GraphHit>` | — | `graph` |
| **8** | `kawai-knowledge` `graph/tools` / `crates/engines/graph` | Agent toolset — `graph_search`, `graph_list`, `graph_forget`, `graph_stats` | — | — | `graph` |

### 3.2 Skills & Memories (long-term, plain SQLite) — `kawai-skills` + `kawai-memory`

| # | Crate | Role | `libSQL` Tables | Feature |
|---|---|---|---|---|
| **9** | `kawai-skills` (`crates/foundation/skills`) | SKILL.md CRUD (unique name, version bump, `skl-` base62 id) + bounded prompt injection (4k/skill, 12k total, `prompt_block()`) | `skills` — `migrations/0008_skills.sql` | ungated |
| **10** | `kawai-memory` (`crates/foundation/memory`) | L1 memories — atomic items (`preference/rule/event/fact/goal`); cloud extraction (tail 24k chars → `remote-llm` one-shot → JSON → title dedup, `kawai-knowledge` not needed) + prompt injection (800 char/entry · 4k total · 24 items max, `prompt_block()`) | `memories` — `migrations/0009_memories.sql` | ungated CRUD; extraction needs `remote-llm` vault |

### 3.3 Agent Working Memory — `kawai-agent`

| # | Crate / File | Role | Storage | Feature |
|---|---|---|---|---|
| **11** | `kawai-agent` `evidence_cache` + `artifacts::TurnMemory` | Per-session process log (`session_artifacts` handles `mem1…`) + cross-turn file-read LRU (`FileScoped` probe, `mtime+size` fingerprint, 64 entries / 1M chars / 8 sessions) — verbatim tool outputs, survives turns & restarts. `evidence_cache` is `kawai_agent::evidence_cache` (in-process, no SQLite beyond `session_artifacts`). | `session_artifacts` — `migrations/0007` (log) + in-process LRU | ungated (LRU) + `kawai-agent` (`litert` for loop) |

**Not semantic:** no embedding, no dedup, no summarization — *episodic/operational*. Complementary to L1 memories, not competing. **Don't index `session_artifacts.content` into `rag_chunks`** — it would pollute the document vector space with transient tool output.

### 3.4 Tech Stack — the technology behind knowledge

One principle first: all knowledge runs **in-process inside a single SQLite file** — no servers, no external services. The stack, layer by layer:

| Layer | Technology | Where | Role & notes |
|---|---|---|---|
| Database | **libSQL** 0.9 (SQLite fork), crate `libsql` (feature `core`) | All tables: `rag_*`, `graph_*`, `skills`, `memories`, `session_artifacts` | One `kawai.db` file per user (`Builder::new_local`). Chosen because it is embeddable with no server, one file = per-user isolation + backup unit, and a path to future sync (sqld). Access = raw SQL via `libsql::Connection`, no ORM. |
| Vector | **libSQL native vectors**: `FLOAT32(dims)` columns, `vector(?)` + `vector_distance_cos()` functions | `rag_chunks_embeddings`, `graph_nodes/edges_embeddings` (+ `_map` join tables) | Cosine similarity computed inside SQL. Search = **brute-force scan** with a `file_id` pre-filter — not ANN. The `libsql_vector_idx` index is created in the DDL but never used by any query. |
| Keyword | **FTS5** (built into SQLite) + `bm25()` | `rag_chunks_fts` + trigger mirror | Virtual table + triggers created at runtime on first index (`ensure_fts`). Query tokens are OR-ed so free-form input cannot trigger FTS syntax errors. |
| Hybrid fusion | **Hand-rolled RRF in Rust** (k=60) | `crates/engines/knowledge/src/search.rs` (`rrf_fuse`) | Not a DB-engine feature — vector and BM25 rankings are merged in application code. |
| Chunking | **`text-splitter` 0.27** — `MarkdownSplitter`, char-based | RAG 1500/200; graph 1200/150 | Markdown-aware: chunks follow headings, never cut through structure. |
| Embedding | **`kawai-embedding`** multi-provider, selected via env | OpenAI (1024d) / NVIDIA / Gemini / **LiteRT EmbeddingGemma 768d on-device** | The local (LiteRT) provider makes the pipeline fully offline-capable. The provider's dimension determines the table schema: switching to a different-dims provider = mandatory re-index (§9 #4). |
| Document parsing | **`ragloader`** → office_oxide (docx/xlsx/pptx, pure Rust, submodule), **pdf_oxide** (git dep, pure Rust), YouTube transcript, DescriberChain (vision for images) | `crates/integrations/ragloader` | All in-process — no office server, no external CLI. |
| Entity extraction (graph) | **`regex` crate** only | `graph/types.rs` `extract_entities` | No LLM/NLP — this is GraphRAG's current quality ceiling (TitleCase phrases only, see §4). |
| Runtime | **tokio** async; agent tools = `kawai_tools::AgentTool` | All crates | SQLite connection opened per operation (`db_connection(user_id)`); idempotent migrations run on every connection. |

**Deliberately not in the stack** (not hidden omissions): a reranker (e.g. NVIDIA), an external vector server (pgvector/Qdrant/Milvus), an LLM in the graph ingest path, semantic dedup/summarization for memory. Local-first MVP = zero infrastructure; these gaps are documented in §4/§8.

---

## 4. GraphRAG — 5 Arms

> **Status: RPC-only & experimental.** The `graph_*` ops are exposed via `commands.rs`/`web.rs` only — no agent toolset registers `GraphSearchTool`, so the chat model cannot reach any arm. Known caveats in today's code: `community_of()` is an FNV-1a hash bucket (`% 8`), not community detection; edge descriptions are boilerplate `"{a} relates to {b}"` (embedded as-is); `local_traversal` has no deterministic `ORDER BY` before `LIMIT`; nodes/edges never cross files (multi-hop works within one file only); graph search is user-wide — it does **not** scope by `session_files` the way RAG does (see §9 note).

| Arm | Idea | SQL / Rust | Location |
|---|---|---|---|
| **Naive** | Query → embed → vector (plain) | `vector_distance_cos` + `ROW_NUMBER() OVER (PARTITION BY docid)` | `graph/search.rs` `vector_search_nodes()` |
| **Local** | Extract entities → 1–2 hop | `LIKE %token%` → `WITH RECURSIVE … depth<2 JOIN graph_edges` | `graph/search.rs` `local_traversal()` |
| **Global** | Embed relationship → community | `vector_search_edges` → `community_id IN (…)` | `graph/search.rs` `global_community_hits()` |
| **Hybrid** | Local+Global+Naive → equal RRF | `tokio::join!` → `1/(60+rank+1)` | `graph/search.rs` `graph_search()` hybrid arm |
| **Mix** | Weighted RRF (default mode) | Same + weights `0.2 / 0.5 / 0.3` | `graph/search.rs` `graph_search()` mix arm via `mode="mix"` |

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

**Production chat reality:** the agent has exactly one retrieval tool — `knowledge_search(query, mode)`. The model picks `mode`; callers pick nothing. GraphRAG arms are RPC-only (§4), and **no rag+graph fusion tool exists** — the `tokio::join!` in `graph_search` fuses the three graph arms with each other, not with RAG.

| Retrieval situation | Tool + mode | Mechanism |
|---|---|---|
| Exact code/number/name (`INV-88421`) | `knowledge_search` `mode=keyword` | FTS5/BM25 exact match; skips the embedder |
| Paraphrase / concept ("explain X") | `knowledge_search` `mode=semantic` or `hybrid` | Vector similarity |
| Default (model doesn't know which) | `knowledge_search` `mode=hybrid` | Both sides fused via RRF |
| (RPC-only — not reachable from chat) | `graph_search` `naive/local/global/hybrid/mix` | §4 |

Notes: RRF `k=60` is the rank-smoothing constant, **not** the result count — each side contributes top-8 and the fused result is top-8 (`const K: u64 = 8`, `search.rs`). Results are scoped to the session's files (`session_files`).

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
| Hybrid ranking | RRF `k=60` (rag) + weighted 3-arm RRF `0.2/0.5/0.3` (graph, RPC-only) | RRF `k=60`, `candidateK=limit×3` | Same constant; no rag+graph fusion in kawai |
| Graph extraction | Regex `\b[A-Z][a-z]+` (TitleCase only — misses lowercase words/acronyms), FNV `%8` | LLM two-stage → `[[]]` wikilinks; Code AST | Zero-LLM vs. LLM+AST |
| Graph traversal | `WITH RECURSIVE depth<2` + `community_id IN` | `graphology` BFS `hop/decay/maxNodes=200` | Same topology; kawai lacks `decay`/`maxNodes` tuning |
| Layered memory | L0 `sessions/messages`; L1 `memories` + `prompt_block()` | L0–L3 (JSONL + vec0 + LLM dedup) | Kawai L0+L1 basic; Tencent has L2 scenes + L3 persona |
| Skills | CRUD + `prompt_block()` — no vectors yet | CRUD + `vec0` + FTS5 + RRF + TTL | Kawai vector/FTS5 not yet |
| Storage | Per-user `~/Library/.../kawai.db` | COS STS + Redis + OTEL/Langfuse/Kafka | Per-user ↔ per-namespace mapping is 1:1 |

**Don't delete `rag` for `graph`** — lexical and relational retrieval are complementary. Production chat uses `knowledge_search` only; the graph arms stay RPC-only/experimental (§4) until a `GraphSearchTool` is registered in an agent toolset.

---

## 9. Architecture Invariants

1. **User isolation is structural** — one DB file per user (`db_connection(user_id)`), no `user_id` columns.
2. **Chunks belong to files; files belong to sessions** — `session_files(session_id, file_id)` scopes RAG search. (Graph search is user-wide today — §4.)
3. **Session id is bound server-side** — the model never provides `user_id` or `session_id`.
4. **Don't mix 768d and 1024d** — cross-dim mixing blocked; re-index on switch.
5. **Don't index transient tool output** — `session_artifacts` stays out of `rag_chunks`.
6. **Skills and L1 memories inject at opener build** — mid-session saves apply from the next session.
