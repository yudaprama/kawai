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

---

## 8. Kompatibilitas dengan TencentDB-Agent-Memory (`TECHNOLOGIES.md`)

Analisa `kawai` (6 implementasi, 1 `kawai.db` per-user) vs Tencent 4 modul (`MemoryCore` L0–L3 + Skills, `MemoryKnowledge` Wiki/Code, `MemoryProxy` + Redis, `MemoryPanel`).

### 8.1 Matriks Teknologi Inti

| Dimensi | Kawai | Tencent | Kompatibel | Catatan |
|---|---|---|---|---|
| **Chunking** | `MarkdownSplitter` 1500/200 `logic/rag.rs:532`, Graph 1200/150 `logic/graph.rs:30` | Wiki `chunker.ts` 12K/400 heading-aware, trigger 28K `TECHNOLOGIES.md:55` | ⚠️ Parsial | Granularitas beda ~8×. Keduanya heading-aware via `text-splitter`; migrasi butuh re-chunk atau simpan `locator` lama. Kawai optimised untuk context 768d/1024d pendek, Tencent Wiki untuk LLM FILE-block pipeline. |
| **Embedding provider** | `kawai-embedding/src/lib.rs:44-51` `OpenAI 1024` / `Nvidia 1024` / `Gemini 1024` / `LitertProvider EmbeddingGemma 300M 768d` + `TenantAwareEmbedder` DJB2 `lib.rs:109` | `embedding.ts:22-54` any OpenAI-compatible (`dimensions` configurable) + `LocalEmbeddingConfig` `node-llama-cpp` `embeddinggemma-300m-q8_0 768d` `embedding.ts:116-120` | ✅ Tinggi | Model identik (EmbeddingGemma 300M 768d). Kawai default `text-embedding-3-small 1024`; Tencent user-configurable + `sendDimensions:false` untuk BGE-M3. Beda registry: Kawai `build_providers_from_env()` dari vault vs Tencent `createEmbeddingService()` env-based; keduanya support `BillingHook`. |
| **Dimensi & isolasi** | `DEFAULT_DIM=1024` `lib.rs:45`, `LITERT_EMBED_DIM=768` `lib.rs:51`, `embed_for_tenant()` skip mismatched `lib.rs:1021-1036` | `LOCAL_DIMENSIONS=768` `embedding.ts:120`, `dimensions: number` required `embedding.ts:32`, `NoopEmbeddingService` dims 0 untuk TCVDB server-side `embedding.ts:638` | ⚠️ Guard sama | Keduanya blokir cross-dim mixing. Migrasi 768↔1024 wajib re-index. Kawai `djb2(tenant)%len` satu workspace = satu model; Tencent `team_id/agent_id/user_id` composite key `TECHNOLOGIES.md:693-696` → mapping `tenant = team_id:agent_id` feasible. |
| **Vector store** | libSQL `FLOAT32(dims)` + `libsql_vector_idx` + `embedding_map` `rag.rs:82`, `graph.rs:147-192` `vector_distance_cos` `graph.rs:241` | Prod TCVDB; Standalone SQLite `vec0` `TECHNOLOGIES.md:33-35` + `610-621` | ⚠️ Adapter | Hybrid logic identik, fisik beda: `vec0` virtual table vs `libsql_vector_idx`. Butuh converter `INSERT ... vector(?)`. Tencent `NoopEmbeddingService` (server generate vector dari text) `embedding.ts:629` tidak ada di Kawai — Kawai selalu client-side `embed_strings()` `rag.rs:914`, `graph.rs:759`. |
| **Keyword search** | FTS5 `rag_chunks_fts` `rag.rs:629` `WHERE MATCH ? AND file_id IN` + `bm25()` ASC `rag.rs:709` | FTS5 `buildFtsQuery() → BM25` `TECHNOLOGIES.md:35` | ✅ Tinggi | Keduanya `VIRTUAL USING FTS5`, BM25 lower-is-better, `rowid JOIN` pattern sama. |
| **Hybrid ranking** | `rrf_fuse()` `rag.rs:742` `1/(RRF_K+rank+1)` `RRF_K=60` | RRF `k=60` merge FTS5+vector `TECHNOLOGIES.md:37,595` `candidateK=limit×3` | ✅ Identik | Formula byte-identik. Kawai `rrf_fuse_graph()` `graph.rs:431` weighted `Hybrid 1.0/1.0/1.0` vs `Mix 0.2/0.5/0.3` `graph.rs:811` = superset dari Tencent 2-way. |
| **Graph extraction** | Regex `\b[A-Z][a-z]+` `graph.rs:105`, stop-list, FNV `%8` community `graph.rs:94-102`, edges `windows(2)` + clique ≤6 `graph.rs:624-639` | Wiki: LLM two-stage → FILE blocks + wikilink `[[]]` graph `TECHNOLOGIES.md:56-102`; Code: `@colbymchenry/codegraph` AST `TECHNOLOGIES.md:159` | ❌ Beda paradigma | Kawai zero-LLM/zero-dep cheap; Tencent LLM-extracted + code AST. Kawai tanpa wikilink, Tencent tanpa regex fallback. |
| **Graph traversal** | `WITH RECURSIVE traversal depth<2 JOIN graph_edges ON from_node` `graph.rs:358`, Global `community_id IN` `graph.rs:404` | `graphology` BFS `hop/decay/minScore/maxNodes=200` `graph-search.ts:30-38`, `score*decay` per hop, seed frozen | ⚠️ Parsial | Topologi sama (seed LIKE → expand → fuse). Kawai belum punya `decay/maxNodes` — perlu port argumen `GraphSearchArgs` `graph.rs:925-930` agar kompatibel dengan Wiki config. |
| **Memori berlapis** | Tidak ada (flat `rag_files`+`session_files`) — lihat §9 | L0 JSONL daily+vec0/FTS5, L1 JSONL+vec0/TCVDB+LLM dedup `l1-dedup.ts`, L2 `scene_blocks/*.md`, L3 `persona.md` `TECHNOLOGIES.md:379-502` | ❌ Gap | Kawai perlu `L1Extractor`/`SceneExtractor`/`PersonaGenerator` jika adopsi model Tencent. Mode `keyword/semantic/hybrid` 1:1 (`rag.rs:mode` ↔ `TECHNOLOGIES.md:324-334`). |
| **Skills** | Tidak ada | SQLite `skills`+`skill_vec(vec0)`+FTS5, RRF 3-mode, version chain TTL `TECHNOLOGIES.md:244-334` | ❌ Belum ada | Pola sama dengan RAG (vec0+FTS5+RRF) — bisa reuse `rag.rs` pattern. |
| **Storage & observability** | Per-user folder `~/Library/…/<user>/kawai.db` + `stderr` tee | COS STS + Redis + OTEL/Langfuse/Kafka `TECHNOLOGIES.md:42-43,650-673` | ⚠️ Infra beda | Isolasi per-user Kawai ↔ per-namespace Tencent (`user_id → team_id` 1:1 feasible). Butuh COS adapter jika multi-device sync. |

### 8.2 Rekomendasi Integrasi

1. **Reuse Kawai untuk doc RAG, proxy ke Tencent untuk memory/skills** — `logic/rag.rs:914` + `logic/graph.rs:759` handle file knowledge; `memory-search.ts` handle L1 recall via HTTP bridge. Keduanya `RRF k=60` sehingga merge lintas-sistem konsisten.
2. **Migrasi ke TCVDB prod:** ganti `libsql_vector_idx` dengan pola `NoopEmbeddingService` — client kirim `text`, server embed (hemat egress).
3. **Jangan campur 768d dan 1024d** dalam satu DB — kedua codebase sudah guard; re-index wajib saat ganti provider. Kawai `TenantAwareEmbedder` dan Tencent `getProviderInfo()` keduanya deteksi mismatch.
4. **Jangan hapus `rag` untuk `graph`** — `rag` untuk lexical exact (`INV-88421`), `graph` untuk relasi multi-hop; strategi produksi Kawai adalah `fusion rag+graph → RRF` (§5), bukan substitusi.

---

## 9. TurnMemory Kawai vs Memori Berlapis L0–L3 Tencent — Apakah Sama?

**Jawaban singkat: tidak sama.** Beda tujuan, lifecycle, dan storage.

### 9.1 TurnMemory Kawai — *process log* per-sesi

* **Lokasi:** `src-tauri/src/logic/agent.rs:1520` `TurnMemory { artifacts: Vec<TurnArtifact>, persisted: usize }` + tabel `session_artifacts(session_id, handle, tool, args_key, content)` `migrations/0007_session_artifacts.sql:5-13`.
* **Isi:** `TurnArtifact { handle:"mem1", tool, args_key, content(truncated 32k)}` `agent.rs:1506-1512`. Satu entry per *distinct* `tool+args_key` (dedup exact-match `agent.rs:1578-1584`), handle sekuensial `mem1, mem2 …`.
* **Lifecycle:** `restore(prior)` di awal stream `agent.rs:1531` → `record()` tiap tool selesai → `take_unpersisted()` → `flush_new_artifacts()` `agent.rs:1800` (`db::append_session_artifact` `db.rs:395`). Bertahan **lintas turn & restart** (persisted), bukan hanya konteks LLM turn ini.
* **Fungsi:** (a) paging hasil besar via `artifact_recall(handle, offset)` `agent.rs:1614` `ARTIFACT_PAGE_CHARS`; (b) `materials(focus, budget)` relevance-ranked untuk cloud subagent `agent.rs:1670` (first-fit whole-block, omission note, `budget` per-provider); (c) `staging_slices()` untuk `deep_write` writer-requested slices `agent.rs:1760`; (d) `evidence_digest()` / `chain_digest()` untuk replay lintas epoch `agent.rs:1547,1599`.
* **Bukan memory semantik:** tidak ada embedding, tidak ada dedup LLM, tidak ada summarization. Hanya verbatim tool output yang sudah terjadi di sesi itu — *episodic/operational*.

### 9.2 Memori Berlapis L0–L3 Tencent — *long-term knowledge* lintas sesi

| Layer | Isi | Storage | Proses |
|---|---|---|---|
| **L0** Raw Conversations | `conversations/YYYY-MM-DD.jsonl` + vec0+FTS5 | `l0-recorder.ts` auto-capture, hybrid RRF recall `auto-recall.ts` | Semua pesan user+assistant, retention penuh |
| **L1** Structured Atomic Memories | `records/YYYY-MM-DD.jsonl` + vec0/TCVDB | `l1-extractor.ts` Quality Gate → `callLlmExtraction()` (type/priority) → `l1-dedup.ts` vector top-K=5 + LLM conflict → `l1-writer.ts` | Fakta atomik (`preference/rule/event/fact/goal`) dedup semantik |
| **L2** Scene Blocks | `scene_blocks/*.md` + `scene_index.json` | `scene-extractor.ts` LLM tool-calling CREATE/UPDATE/MERGE | Ringkasan situasi kontekstual, heat tracking |
| **L3** Persona | `persona.md` | `persona-generator.ts` baca semua L2 → sintesis | Profil stabil jangka panjang |

Recall `performAutoRecall()` `TECHNOLOGIES.md:516-563` paralel: L1 RRF + L2 navigation + L3 persona → `prependContext`/`appendSystemContext` injection.

### 9.3 Perbandingan Langsung

| Aspek | TurnMemory (Kawai) | L0–L3 (Tencent) |
|---|---|---|
| Scope | Satu `session_id` (chat session) | Satu `team_id/agent_id/user_id` global, lintas sesi |
| Sumber | Hanya output tool yang sudah dieksekusi di sesi itu | Semua percakapan, diekstrak LLM menjadi fakta/scene/persona |
| Embedding | Tidak | Ya (L0,L1,Skills → vec0/TCVDB) |
| Dedup | Exact `tool+args_key` | Vector similarity + LLM conflict detection |
| Summarization | Tidak (verbatim) | Ya (L2/L3 LLM synthesis) |
| Persistensi | SQLite `session_artifacts` per-user DB | JSONL + SQLite vec0/TCVDB + COS untuk multi-node |
| Konsumsi | `artifact_recall` paging + `materials` budget untuk `deep_write` | `performAutoRecall()` otomatis tiap turn (timeout 5s) |
| Analogi | Short-term *working memory* / scratchpad | Long-term *semantic + episodic + persona* memory |

### 9.4 Implikasi untuk Kawai

* `TurnMemory` tidak menggantikan L0–L3 — ia melengkapi. Jika Kawai ingin memori jangka panjang, tambah pipeline L1–L3 di atas `TurnMemory` (mis. `l1-extractor` yang membaca `messages` `sessions/messages` tables), bukan mengganti `session_artifacts`. Keduanya bisa hidup berdampingan: TurnMemory = bukti proses sesi ini, L1–L3 = pengetahuan terdistilasi lintas sesi.
* Jangan indeks `session_artifacts.content` ke `rag_chunks` secara otomatis — sudah ada `rag Files` untuk dokumen; TurnMemory sengaja tidak di-embed agar tidak mencemari ruang vektor dokumen dengan output tool sementara.
