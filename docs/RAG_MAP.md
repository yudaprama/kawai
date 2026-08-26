# RAG Map — RAG Implementations in Kawai

> One file, 6 implementations. Separate layers, 1 `libSQL` per-user (`~/.kawai/models` + `kawai.db`). All `feature`-gated — `cargo check` without `graph`/`office` = zero cost.

## 1. Layer Overview

```
[File] → ragloader (parse) → kawai-embedding (vector) → rag (chunk) ─┐
                                                              ├─→ libSQL kawai.db ─→ Agent Tool
[File] → office extract → graph (entity) → kawai-embedding (vector) ─┘
```

* **Upstream (stateless):** `crates/ragloader`, `kawai-embedding`
* **Downstream (stateful, 1 DB):** `src-tauri/src/logic/rag.rs` (classic RAG), `src-tauri/src/logic/graph.rs` + `crates/graph` (GraphRAG)

`edgequake/` is a separate project (Postgres/Cypher) — **not used** by `kawai` runtime.

---

## 2. Full Mapping Table

| # | Crate / File | Role | Input → Output | `libSQL` Tables | Feature | Tool / RPC |
|---|---|---|---|---|---|---|
| **1** | `crates/ragloader/src/lib.rs:78` `load_file()`<br>`crates/ragloader/src/parse.rs` `chunk.rs` `image.rs` | **Upstream parser** — `docx/xlsx/pptx→office_oxide.to_markdown`, `pdf→pdf_oxide per-page`, `md→MarkdownSplitter`, `txt→TextSplitter` | `Path` → `Vec<Chunk{id, source, file_type, locator, index, content}>` | — (stateless) | `office` (`dep:ragloader` in `src-tauri/Cargo.toml:72`) | Used by `logic/rag.rs:599` `describe_image()` (`image::DescriberChain`: `Local` stub → `JigsawStack VOCR`). `docx/pdf` chunking in `kawai` does **not** go through `ragloader::load_file` — uses `logic/rag.rs:532` directly |
| **2** | `kawai-embedding/src/lib.rs` `TenantAwareEmbedder` | **Multi-provider embedder** — `OpenAI 1024` / `Nvidia` / `Gemini 1024` / `LitertProvider EmbeddingGemma 300M 768d` (`cognee-litert-lm/src/embedder.rs:162`) | `Vec<String>` → `Vec<Vec<f64>>` | `dims` for `FLOAT32(dims)` | `kawai-embedding` (+ `litert` for local) | `logic/rag.rs:914` `embed_strings()`, `logic/graph.rs:759` same. `build_providers_from_env()` |
| **3** | `src-tauri/src/logic/rag.rs:40` `CHUNK=1500/200` <br>`rag.rs:82` `ensure_vector_schema` <br>`rag.rs:629` `ensure_fts` <br>`rag.rs:199` `vector_search_top_k` <br>`rag.rs:692` `bm25_search` <br>`rag.rs:742` `rrf_fuse` | **Classic RAG** — Document index + retrieval. `extract_text()` → `chunk_markdown()` → `kawai-embedding` → `INSERT` → `knowledge_search()` | `query, mode` → `Vec<RagHit{source,locator,content,file_id}>` | `rag_chunks` / `rag_chunks_embeddings` / `rag_chunks_embedding_map` + `rag_chunks_fts (VIRTUAL FTS5)` + `rag_files` + `session_files` (per-user `db_connection()`) | `office` | `commands.rs:468` `knowledge_search` / `office_index_file` <br>`web.rs:413` `/api/knowledge_search` <br>`office/tools.rs:118` `KnowledgeSearchTool` |
| **4** | `src-tauri/src/logic/office/mod.rs:90` `knowledge_context()` | **Context injector** — not retrieval | `Vec<file_id>` → `KnowledgeContext{context, files}` (`office_read_document` concat) | — | `office` | `commands.rs:438` `knowledge_context` (used by `@-mention` composer, cap `12k/file, 36k total`) |
| **5** | `crates/graph/src/lib.rs:1` | **Pure graph crate** — no DB/embed (so `cargo check -p graph` works without vault) | `text` → `Vec<String>` entities, `community_of()`, `rrf_fuse_graph()`, `local_traversal_sql()`, `schema_sql(dims)` | — | `graph` (optional) | `toolset()` stub `graph_search`/`graph_list` for manifest |
| **6** | `src-tauri/src/logic/graph.rs:1` `ensure_graph_schema` <br>`graph.rs:120` `vector_search_nodes/edges` <br>`graph.rs:190` `local_traversal` <br>`graph.rs:385` `global_community_hits` <br>`graph.rs:732` `graph_search(mode)` | **GraphRAG DB** — Graph index + retrieval (`chunk 1200/150` → entities regex `\b[A-Z][a-z]+` → `graph_nodes/edges` → `kawai-embedding` → `graph_search`) | `query, mode` → `Vec<GraphHit{title,content,file_id,locator,arm,community_id,score}>` | `graph_nodes / _embeddings / _map` + `graph_edges / _...` + `graph_files` (same `kawai.db` file) | `graph = ["dep:graph","dep:kawai-embedding"...]` `src-tauri/Cargo.toml:125` | `commands.rs:695` `graph_*` / `web.rs:740` `/api/graph_*` <br>`agent.rs:580` `extend_toolset` (office agent) |

---

## 3. 5 GraphRAG Arms (All in `logic/graph.rs` + `crates/graph`)

| Arm | Your Description | SQL / Rust | Location |
|---|---|---|---|
| **1. Naive** | `Query→Embed→Vector` (plain Google) | `1-vector_distance_cos(?,embedding)` + `ROW_NUMBER() OVER (PARTITION BY docid)` | `logic/graph.rs:120` `vector_search_nodes()` ← `graph/src/lib.rs:145` `vec_to_le_bytes` |
| **2. Local** | `Extract entities→1-2 hop` | `WHERE title LIKE %token%` → `WITH RECURSIVE traversal … WHERE depth<2 JOIN graph_edges ON from_node` | `graph/src/lib.rs:73` `extract_entities` + `153` `local_traversal_sql` + `logic/graph.rs:190` `local_traversal()` |
| **3. Global** | `Embed relationship→Community expand` | `vector_search_edges` (`graph_edges_embeddings`) → `WHERE community_id IN (...)` | `logic/graph.rs:385` `global_community_hits()` ← `graph/src/lib.rs:167` `global_community_sql` + `64` `community_of` (FNV `%8`) |
| **4. Hybrid** | `Local+Global+Naive → RRF equal` | `tokio::join!(naive,local,global)` → `RRF score=1/(60+rank+1)` | `logic/graph.rs:732` `Hybrid => rrf_fuse_graph(vec![(naive,1.0),(local,1.0),(global,1.0)])` ← `graph/src/lib.rs:113` |
| **5. Mix** | `weighted RRF` (production default) | same as Hybrid + weights | `logic/graph.rs:811` `Mix => rrf_fuse_graph(vec![(naive,0.2),(local,0.5),(global,0.3)])` via `commands.rs:738` `mode="mix"` |

Classic `rag` Naive is only `logic/rag.rs:199` `vector_search_top_k` + `bm25_search` (no graph).

---

## 4. Features & Include/Exclude

```toml
# src-tauri/Cargo.toml:117
[features]
graph = ["dep:graph","dep:kawai-embedding","dep:text-splitter","dep:regex"] # + libSQL vector
office = ["dep:ragloader","dep:kawai-embedding",...,"webread"]              # classic RAG
```

```sh
cargo check                         # without graph/office → graph_* returns 501, zero DB
cargo check --features graph        # GraphRAG only
cargo check --features graph,office # RAG + GraphRAG (1 DB, separate tables)
cargo check -p graph                # pure crate only
cargo check -p ragloader
```

*Include:* `bun tauri build -- --features graph,office,litert`
*Exclude:* remove `graph` from `--features` — no `graph_nodes/edges`, `graph_search` stub.

---

## 5. When to Use Which

* **Exact keyword** (`INV-88421`, numbers, codes) → `rag` `mode=keyword` (FTS5) — `graph` has no `bm25`.
* **Paraphrase / synonym** → `rag` `mode=semantic` or `graph` `naive`.
* **Multi-hop relations** (`Alice→Bob→Jakarta`) → `graph` `mode=local` (2-hop).
* **Big picture / themes** → `graph` `mode=global` (community).
* **Most comprehensive** → `graph` `mode=mix` (weighted RRF 3 arms) or **fusion** `rag+graph` (`tokio::join!(rag_search, graph_search)` → RRF).

---

## 6. End-to-End Data Flow

```
[User import] office_import_file (store/docs) 
      ├─→ logic/rag.rs:791 office_index_file ─→ extract_text → chunk 1500/200 → kawai-embedding → rag_* ─→ knowledge_search (Hybrid)
      └─→ logic/graph.rs:529 graph_index_file ─→ extract_text → chunk 1200/150 → extract_entities → graph_nodes/edges → kawai-embedding → graph_search (Mix)
```

Both per-user `logic::db_connection(user_id)` → `~/Library/Application Support/pro.kawai.app/<user>/kawai.db` (Tauri) or `/tmp/kawai/<user>` (headless).

---

## 7. Verification

```sh
cargo check --features graph,web,office,litert
cargo test -p graph --lib           # extract_entities, community, rrf
cargo test -p ragloader --lib
bun run build                       # frontend
```

> Don't delete `rag` for `graph` — `rag` for lexical, `graph` for relations. Keep `graph` optional in `crates/graph`.
