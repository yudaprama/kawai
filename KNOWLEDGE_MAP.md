# Knowledge Map — Knowledge & Memory in Kawai

> One file, 8 implementations. Separate layers, 1 `libSQL` per-user (`~/.kawai/models` + `kawai.db`). All `feature`-gated — `cargo check` without `graph`/`office` costs nothing.

**TL;DR:** Kawai keeps document knowledge (RAG + GraphRAG) and long-term memory (Skills + L1) in a single per-user `libSQL` file. Document retrieval is hybrid vector+FTS5 with RRF (`k=60`); GraphRAG adds 5 arms over the same DB. Skills and L1 memories are plain-SQLite CRUD today — versioned/bounded prompt injection into the agent, no vectors yet.

---

## 1. Layer Overview

```
[File] → ragloader (parse) → kawai-embedding (vector) → rag (chunk) ─┐
                                                               ├─→ libSQL kawai.db ─→ Agent Tool
[File] → office extract → graph (entity) → kawai-embedding (vector) ─┘
```

* **Upstream (stateless):** `crates/ragloader`, `kawai-embedding`
* **Downstream (stateful, 1 DB):** `src-tauri/src/logic/rag.rs` (classic RAG), `src-tauri/src/logic/graph.rs` + `crates/graph` (GraphRAG)

---

## 2. Implementation Map

### 2.1 Document Knowledge (RAG + Graph)

| # | Crate / File | Role | Input → Output | `libSQL` Tables | Feature | Tool / RPC |
|---|---|---|---|---|---|---|
| **1** | `crates/ragloader` — `load_file()`, `parse.rs`, `chunk.rs`, `image.rs` | Upstream parser — `docx/xlsx/pptx→office_oxide`, `pdf→pdf_oxide`, `md→MarkdownSplitter`, `txt→TextSplitter` | `Path` → `Vec<Chunk>` | — (stateless) | `office` | Used by `logic/rag.rs` `describe_image()` |
| **2** | `kawai-embedding` — `TenantAwareEmbedder` | Multi-provider embedder — `OpenAI 1024` / `Nvidia` / `Gemini` / `LitertProvider EmbeddingGemma 768d` | `Vec<String>` → `Vec<Vec<f64>>` | `dims` for `FLOAT32(dims)` | `kawai-embedding` (+ `litert`) | `logic/rag.rs`, `logic/graph.rs` — `build_providers_from_env()` |
| **3** | `src-tauri/src/logic/rag.rs` — `CHUNK=1500/200`, `ensure_vector_schema`, `ensure_fts`, `vector_search_top_k`, `bm25_search`, `rrf_fuse` | Classic RAG — chunk → embed → insert → `knowledge_search()` | `query, mode` → `Vec<RagHit>` | `rag_chunks` / `_embeddings` / `_map` + `rag_chunks_fts` + `rag_files` + `session_files` | `office` | `commands.rs` `knowledge_search` · `web.rs` `KnowledgeSearchTool` |
| **4** | `src-tauri/src/logic/office` — `knowledge_context()` | Context injector (not retrieval) | `Vec<file_id>` → `KnowledgeContext` | — | `office` | `commands.rs` (cap `12k/file, 36k total`) |
| **5** | `crates/graph` | Pure graph helpers — no DB/embed | `text` → entities, `community_of()`, `rrf_fuse_graph()`, `local_traversal_sql()` | — | `graph` (optional) | `toolset()` stub |
| **6** | `src-tauri/src/logic/graph.rs` — `ensure_graph_schema`, `vector_search_nodes/edges`, `local_traversal`, `global_community_hits`, `graph_search(mode)` | GraphRAG — `chunk 1200/150` → regex entities → `graph_nodes/edges` → embed → `graph_search` | `query, mode` → `Vec<GraphHit>` | `graph_nodes / _embeddings / _map` + `graph_edges / _...` + `graph_files` | `graph` | `commands.rs` `graph_*` · `web.rs` · `agent.rs` |

### 2.2 Skills & Memories (long-term, plain SQLite)

| # | Crate / File | Role | Input → Output | `libSQL` Tables | Feature | Tool / RPC |
|---|---|---|---|---|---|---|
| **7** | `src-tauri/src/logic/skills.rs` — `skill_create/list/get/update/delete` + `prompt_block()` | Skills — SKILL.md CRUD (unique name, version bump, `skl-` base62 id) + bounded prompt injection | `name, description, content` → `Skill` | `skills` — `migrations/0008_skills.sql` | ungated | `skill_*` · inject via `agent.rs` |
| **8** | `src-tauri/src/logic/memory.rs` — `memory_create/list/update/delete` + `memory_extract()` | L1 memories — atomic items (`preference/rule/event/fact/goal`); extraction = tail 24k chars → `RemoteLlm` one-shot → JSON → title dedup → insert | `session_id` → `Vec<MemoryItem>` | `memories` — `migrations/0009_memories.sql` | ungated CRUD; extraction needs vault | `memory_*` |

---

## 3. GraphRAG — 5 Arms (`logic/graph.rs` + `crates/graph`)

| Arm | Idea | SQL / Rust | Location |
|---|---|---|---|
| **Naive** | Query → embed → vector (plain) | `vector_distance_cos` + `ROW_NUMBER() OVER (PARTITION BY docid)` | `graph.rs` `vector_search_nodes()` |
| **Local** | Extract entities → 1–2 hop | `LIKE %token%` → `WITH RECURSIVE … depth<2 JOIN graph_edges` | `crates/graph` `local_seed_tokens()` + `graph.rs` `local_traversal()` |
| **Global** | Embed relationship → community | `vector_search_edges` → `community_id IN (…)` | `graph.rs` `global_community_hits()` |
| **Hybrid** | Local+Global+Naive → equal RRF | `tokio::join!` → `1/(60+rank+1)` | `graph.rs` `graph_search()` hybrid arm + `crates/graph` `rrf_fuse_graph()` |
| **Mix** | Weighted RRF (production default) | Same + weights `0.2 / 0.5 / 0.3` | `graph.rs` `graph_search()` mix arm via `mode="mix"` |

Classic `rag` Naive is only `rag.rs` `vector_search_top_k` + `bm25_search`.

---

## 4. Features

```toml
# src-tauri/Cargo.toml
[features]
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

## 5. When to Use Which

* **Exact keyword** (`INV-88421`) → `rag` `mode=keyword` (FTS5) — graph has no BM25.
* **Paraphrase / synonym** → `rag` `mode=semantic` or `graph` `naive`.
* **Multi-hop** (`Alice→Bob→Jakarta`) → `graph` `mode=local` (2-hop).
* **Big picture / themes** → `graph` `mode=global` (community).
* **Most comprehensive** → `graph` `mode=mix` or **fusion** `rag+graph` (`tokio::join!` → RRF).

---

## 6. Data Flow

```
[User import] office_import_file
      ├─→ rag:    extract_text → chunk 1500/200 → embed → rag_* → knowledge_search (Hybrid)
      └─→ graph:  extract_text → chunk 1200/150 → entities → graph_nodes/edges → embed → graph_search (Mix)
```

Per-user `logic::db_connection(user_id)` → `~/Library/Application Support/pro.kawai.app/<user>/kawai.db` (Tauri) or `/tmp/kawai/<user>` (headless).

---

## 7. Verification

```sh
cargo check --features graph,web,office,litert
cargo test -p graph --lib
cargo test -p ragloader --lib
bun run build
```

> Don't delete `rag` for `graph` — lexical vs. relations. Keep `graph` optional in `crates/graph`.

---

## 8. Comparison with TencentDB-Agent-Memory (`TECHNOLOGIES.md`)

Kawai: 8 implementations, 1 `kawai.db` per-user. Tencent: 4 modules (`MemoryCore` L0–L3 + Skills, `MemoryKnowledge` Wiki/Code, `MemoryProxy` + Redis, `MemoryPanel`).

### 8.1 Technology Matrix

| Dimension | Kawai | Tencent | Verdict | Notes |
|---|---|---|---|---|
| **Chunking** | `MarkdownSplitter` 1500/200, Graph 1200/150 | Wiki `chunker.ts` 12K/400 (trigger 28K) | ⚠️ Partial | ~8× granularity gap. Both heading-aware; migration needs re-chunk. |
| **Embedding** | `OpenAI 1024` / `Nvidia` / `Gemini` / `EmbeddingGemma 768d` + `TenantAwareEmbedder` | Any OpenAI-compatible + `LocalEmbeddingConfig` `embeddinggemma-300m-q8_0` | ✅ High | Same 300M model. Kawai: vault-based `build_providers_from_env()`; Tencent: env-based. |
| **Dimensions** | `DEFAULT 1024`, `LITERT 768`, `embed_for_tenant()` guard | `LOCAL 768`, `dimensions` required, `NoopEmbeddingService` (server-side) | ⚠️ Same guard | Cross-dim mixing blocked on both. Re-index on switch. |
| **Vector store** | libSQL `FLOAT32(dims)` + `libsql_vector_idx` + map | Prod TCVDB; standalone `vec0` | ⚠️ Adapter | Same hybrid logic, different engine. Tencent `NoopEmbeddingService` has no kawai equivalent. |
| **Keyword search** | FTS5 `rag_chunks_fts` + `bm25() ASC` | FTS5 + BM25 | ✅ High | Same `VIRTUAL USING FTS5` pattern. |
| **Hybrid ranking** | `rrf_fuse()` `1/(60+rank+1)` | RRF `k=60`, `candidateK=limit×3` | ✅ Identical | Kawai `Mix 0.2/0.5/0.3` is a superset of Tencent 2-way. |
| **Graph extraction** | Regex `\b[A-Z][a-z]+`, FNV `%8` | LLM two-stage → `[[]]` wikilinks; Code AST | ❌ Different | Kawai entity extraction is zero-LLM (regex); embedding still uses `build_providers_from_env()` (may hit remote). Tencent LLM + AST for extraction. |
| **Graph traversal** | `WITH RECURSIVE depth<2` + `community_id IN` | `graphology` BFS `hop/decay/maxNodes=200` | ⚠️ Partial | Same topology; kawai lacks `decay`/`maxNodes` tuning. |
| **Layered memory** | L0 `sessions/messages`; L1 `memories` + `memory_extract` + `prompt_block()` | L0 JSONL+vec0, L1 JSONL+vec0 dedup, L2 `scene_blocks`, L3 `persona.md` | ⚠️ L0+L1 basic | Extraction: cloud one-shot + title dedup vs. vector+LLM dedup. Kawai injects via `<memories>` block (all L1). |
| **Skills** | `skills` CRUD + `prompt_block()` — no vectors yet | `skills`+`skill_vec(vec0)`+FTS5, RRF, TTL | ⚠️ Basic | CRUD + injection shipped; vector/FTS5 not yet. |
| **Storage** | Per-user folder `~/Library/.../kawai.db` + `stderr` tee | COS STS + Redis + OTEL/Langfuse/Kafka | ⚠️ Different infra | Per-user ↔ per-namespace mapping is 1:1. |

### 8.2 Integration Recommendations

1. **Reuse kawai for doc RAG, proxy to Tencent for memory/skills** — both use `RRF k=60`.
2. **TCVDB migration:** replace `libsql_vector_idx` with `NoopEmbeddingService` pattern (server embeds).
3. **Don't mix 768d and 1024d** — both codebases guard; re-index on switch.
4. **Don't delete `rag` for `graph`** — lexical vs. relations; production is `rag+graph → RRF`.

---

## 9. TurnMemory vs. Layered Memory (L0–L3) — Same Thing?

**Short answer: no.** Different purpose, lifecycle, and storage.

### 9.1 TurnMemory — Per-Session Process Log

* **Location:** `logic/agent.rs` `TurnMemory` + `session_artifacts` (`migrations/0007`)
* **Content:** `TurnArtifact { handle:"mem1", tool, args_key, content(truncated 32k)}` — one entry per distinct `tool+args_key` (handle `mem1, mem2 …`).
* **Lifecycle:** `restore()` → `record()` per tool → `take_unpersisted()` → `flush_new_artifacts()` — survives turns & restarts.
* **Use:** (a) paging via `artifact_recall(handle, offset)`; (b) `materials()` for cloud subagents; (c) `staging_slices()` for `deep_write`; (d) `evidence_digest()` for replay.
* **Not semantic:** verbatim tool output, no embedding/dedup/summarization — *episodic/operational*.

### 9.2 Layered Memory L0–L3 — Long-Term Knowledge

| Layer | Content | Storage | Process |
|---|---|---|---|
| **L0** Raw Conversations | `conversations/YYYY-MM-DD.jsonl` + vec0+FTS5 | `l0-recorder.ts` → `auto-recall.ts` hybrid RRF | Full retention |
| **L1** Atomic Memories | `records/YYYY-MM-DD.jsonl` + vec0/TCVDB | `l1-extractor.ts` → `l1-dedup.ts` (top-K=5 + LLM) | Facts (`preference/rule/event/fact/goal`) |
| **L2** Scene Blocks | `scene_blocks/*.md` + `scene_index.json` | `scene-extractor.ts` | Contextual summaries |
| **L3** Persona | `persona.md` | `persona-generator.ts` | Stable profile |

Recall `performAutoRecall()` runs L1 RRF + L2 navigation + L3 persona in parallel.

### 9.3 Direct Comparison

| Aspect | TurnMemory (Kawai) | L0–L3 (Tencent) |
|---|---|---|
| Scope | One `session_id` | One `team_id/agent_id/user_id`, cross-session |
| Source | Tool outputs in this session | All conversations → LLM-extracted facts/scenes |
| Embedding | No | Yes (L0,L1,Skills) |
| Dedup | Exact `tool+args_key` | Vector + LLM conflict |
| Summarization | No (verbatim) | Yes (L2/L3) |
| Persistence | SQLite `session_artifacts` per-user | JSONL + vec0/TCVDB + COS |
| Consumption | `artifact_recall` + `materials` budget | `performAutoRecall()` per turn (5s timeout) |
| Analogy | Short-term working memory / scratchpad | Long-term semantic + episodic + persona |

### 9.4 Implications for Kawai

* **Complementary, not competing.** L1 now exists (`logic/memory.rs`: manual CRUD + cloud one-shot title-dedup + `prompt_block()` injection, 800 char/entry · 4k total · 24 items max). L2/L3 build on the same foundation and read `sessions/messages` — don't replace `session_artifacts`.
* **Gap remaining:** vector dedup (exact title today), selective vector recall (kawai injects all L1), and L2/L3 pipeline.
* **Don't index `session_artifacts.content` into `rag_chunks`** — it would pollute the document vector space with transient tool output. `memories` (L1) is also not embedded in this tier — add `vec0`/FTS5 following `rag.rs` when semantic recall is needed, don't mix tables.
