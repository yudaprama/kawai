# Tools Map — Local LLM (Gemma 4) Integration Analysis

> Generated: 2026-09-01
> Status: Analysis document for local LLM integration planning — first item shipped (`data_query_nl`)

## Table of Contents

- [Overview](#overview)
- [Tools by Category](#tools-by-category)
  - [Document & Office](#1-document--office)
  - [PDF Operations](#2-pdf-operations)
  - [Knowledge/RAG](#3-knowledgerag)
  - [Memory System](#4-memory-system)
  - [Analytics](#5-analytics)
  - [Binance/Crypto](#6-binancecrypto)
  - [Web Read/Search](#7-web-readsearch)
  - [CodeGraph](#8-codegraph)
  - [Agent/Supervisor](#9-agentsupervisor)
  - [Session Management](#10-session-management)
  - [Generated Tools](#11-generated-tools)
- [Tools with Existing Remote LLM](#tools-with-existing-remote-llm)
- [Local LLM Suitability Analysis](#local-llm-suitability-analysis)
- [Trade-off Analysis](#trade-off-analysis)
- [Implementation Roadmap](#implementation-roadmap)
- [Data Query NL — Implemented](#data-query-nl--implemented)
- [Architecture Proposal](#architecture-proposal)

---

## Overview

Document ini menganalisis semua tools dalam sistem kawai untuk menentukan kemungkinan integrasi local LLM (Gemma 4 E4B) sebagai reasoning engine.

### Local LLM Capabilities

- **Model**: Gemma 4 E4B (3.7GB, `.litertlm`)
- **Context Window**: 16K-32K tokens (configurable via `KAWAI_LLM_MAX_TOKENS`)
- **Inference Speed**: ~20-50 tok/s on CPU
- **Backend**: LiteRT-LM via `cognee-litert-lm`
- **Entry Point**: `local_llm::local_chat(system, user_message)`

### Current LLM Usage

| Provider | Usage |
|----------|-------|
| Local (Gemma 4) | `local_chat` only |
| Remote (Cloud Pool) | `plan_task`, `plan_revise`, `deep_write`, `draft_document`, `memory_extract`, `memory_consolidate`, `memory_scene_extract`, `memory_persona_generate` |
| Cloudflare Workers AI | `generate_session_title` |

---

## Tools by Category

### 1. Document & Office

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `office_list_files` | List stored files | ❌ None | **Tidak cocok** — Operasi murni database lookup, tidak ada reasoning yang dibutuhkan. Cukup `SELECT * FROM files`. |
| `office_read_document` | Baca dokumen jadi markdown | ❌ None | **Cocok untuk summary** — Setelah dokumen ter-ekstrak ke markdown, local LLM bisa memberikan summary, extract key points, atau translate. Tapi tidak wajib — tool ini sudah return markdown lengkap. |
| `office_import_file` | Import file ke store | ❌ None | **Tidak cocok** — Operasi file I/O murni: copy bytes ke direktori, update metadata JSON. Tidak ada reasoning. |
| `office_export_document` | Export markdown ke format | ❌ None | **Cocok untuk reasoning** — Convert markdown ke docx/xlsx/pptx butuh understanding format. Tapi office_oxide sudah handle ini deterministik. Local LLM bisa bantu jika ada ambiguitas dalam markdown. |
| `office_delete_file` | Hapus file | ❌ None | **Tidak cocok** — Operasi `fs::remove_file` + hapus metadata. Tidak ada reasoning. |
| `office_create_deck` | Buat presentasi | ❌ None | **Sangat cocok** — Butuh brainstorming: menentukan slide structure, content flow, visual hierarchy. Local LLM bisa generate HTML reveal.js dari topik + class vocabulary. Ini use case ideal untuk reasoning. |
| `office_export_deck` | Export deck ke pptx | ❌ None | **Tidak cocok** — Konversi deterministik dari HTML ke PPTX via office_oxide. Tidak perlu reasoning. |
| `office_create_document` | Buat dokumen dari markdown | ❌ None | **Cocok untuk generation** — Local LLM bisa generate konten markdown dari instruksi. Tapi tool ini hanya convert markdown yang sudah ada ke docx. |

### 2. PDF Operations

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `pdf_extract_text` | Ekstrak teks dari PDF | ❌ None | **Cocok untuk post-analysis** — Setelah text ter-ekstrak, local LLM bisa summarize, extract entities, atau translate. Tapi tool ini sudah return full text. |
| `pdf_search_text` | Cari teks di PDF | ❌ None | **Cocok untuk query expansion** — User bilang "cari tanggal" → LLM expand ke "date, tanggal, invoice date, due date". Tapi regex sudah cukup untuk exact match. |
| `pdf_replace_text` | Ganti teks di PDF | ❌ None | **Sangat cocok** — Case: "ganti tanggal" → LLM perlu interpret: tanggal berapa? di halaman mana? format apa? Ini butuh reasoning untuk resolve ambiguitas sebelum replace. |
| `pdf_merge` | Gabung PDF | ❌ None | **Tidak cocok** — Operasi concatenation murni, tidak ada reasoning. |
| `pdf_split` | Split PDF | ❌ None | **Tidak cocok** — Operasi split berdasarkan page spec, tidak ada reasoning. |
| `pdf_info` | Info PDF | ❌ None | **Tidak cocok** — Return metadata (page count, size, rotation). Tidak ada reasoning. |

### 3. Knowledge/RAG

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `knowledge_search` | Cari di indexed knowledge | ❌ None | **Sangat cocok** — Dua tahap reasoning: (1) **Query expansion** sebelum search: "cara reset password" → expand ke "password reset, forgot password, reset credentials". (2) **Answer synthesis** setelah retrieval: gabungkan beberapa chunks jadi jawaban koheren. Ini killer use case untuk local LLM. |
| `knowledge_add_to_session` | Tambah file ke session | ❌ None | **Tidak cocok** — Operasi database: `INSERT INTO session_files`. Tidak ada reasoning. |
| `knowledge_import_youtube` | Import YouTube transcript | ❌ None | **Cocok untuk summarization** — Transcript bisa panjang. Local LLM bisa summarize sebelum indexing, atau generate title. Tapi tool ini sudah handle full transcript. |
| `knowledge_index_file` | Index file untuk RAG | ❌ None | **Cocok untuk chunking optimization** — Local LLM bisa decide chunk boundaries berdasarkan semantic meaning, bukan hanya character count. Tapi MarkdownSplitter sudah cukup untuk MVP. |

### 4. Memory System

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `memory_search` | Cari memories (hybrid) | ❌ None | **Cocok untuk re-ranking** — Setelah vector+BM25 fusion, local LLM bisa re-rank berdasarkan relevance ke context. Tapi importance_score sudah handle ini. |
| `memory_graph_search` | Cari by entity | ❌ None | **Cocok untuk entity resolution** — "John" bisa refer ke "John Smith" atau "John Doe". Local LLM bisa resolve ambiguity. Tapi regex sudah cukup untuk exact match. |
| `memory_graph_export` | Export full graph | ❌ None | **Tidak cocok** — Export nodes/edges ke JSON. Tidak ada reasoning. |
| `memory_create` | Buat memory | ❌ None | **Cocok untuk extraction** — Local LLM bisa extract structured memory dari natural language. Tapi user sudah provide structured input. |
| `memory_list` | List memories | ❌ None | **Tidak cocok** — Query database + sort. Tidak ada reasoning. |
| `memory_update` | Update memory | ❌ None | **Cocok untuk merge reasoning** — Jika update bertentangan dengan existing, LLM bisa decide apakah merge, replace, atau keep both. Tapi untuk MVP, overwrite sudah cukup. |
| `memory_delete` | Delete memory | ❌ None | **Tidak cocok** — `DELETE FROM memories`. Tidak ada reasoning. |
| **`memory_extract`** | **Extract dari transcript** | 🔴 **Remote** | **Sangat cocok** — Transcript panjang → LLM extract structured memories (kind, title, content). Ini sudah remote, local bisa jadi fallback. Context window cukup (24K chars transcript, 16K local context). Output terstruktur (JSON array). |
| **`memory_consolidate`** | **Merge redundant** | 🔴 **Remote** | **Sangat cocok** — Cluster naming: "User prefers dark mode" + "Likes dark UIs" → LLM decide same cluster, name it. Local LLM cukup untuk task ini. Input: list memories (ringkas). Output: cluster names. |
| **`memory_scene_extract`** | **Cluster into scenes** | 🔴 **Remote** | **Sangat cocok** — Similar dengan consolidate: cluster by embedding similarity, LLM name each cluster. Local LLM cukup karena input adalah embeddings (ringkas). |
| `memory_scene_list` | List scenes | ❌ None | **Tidak cocok** — Query database. Tidak ada reasoning. |
| **`memory_persona_generate`** | **Generate persona** | 🔴 **Remote** | **Sangat cocok** — Synthesize persona dari importance-ranked memories. Local LLM cukup karena input dibatasi (24 items, 800 chars each). Output: single paragraph. |

### 5. Analytics

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `data_schema` | Get file schema | ❌ None | **Tidak cocok** — Return column names + dtypes. Tidak ada reasoning. |
| `data_query` | Query data (polars) | ❌ None | **Tidak cocok langsung** — Deterministic executor. Reasoning-nya dipindah ke `data_query_nl`. |
| **`data_query_nl`** | **NL query (polars)** | 🔵 **Remote-first** (local multi-turn saat offline) | ✅ **Implemented** — `DataQueryNlTool` di `crates/toolsets/analytics-tools/src/lib.rs`. Translation via `remote_llm::reason` (pool dulu, local engine kandidat terakhir); kalau engine loaded + feature `litert`, pakai **multi-turn stateful local** (query dependent bisa lihat hasil aktual). Eksekusi via `DataQueryTool`. Detail: [Data Query NL — Implemented](#data-query-nl--implemented). |
| `data_ta` | Technical analysis | ❌ None | **Cocok untuk interpretation** — Setelah indicators terhitung, LLM bisa interpret: "RSI 75 = overbought". Tapi tool ini sudah return final values. |
| `data_chart` | Generate chart | ❌ None | **Cocok untuk chart selection** — User: "visualize this" → LLM decide: bar chart? line? pie? Tapi tool ini sudah have logic untuk chart type selection. |
| `data_tables` | List SQL tables | ❌ None | **Tidak cocok** — Query `information_schema`. Tidak ada reasoning. |
| `data_import` | Import SQL data | ❌ None | **Tidak cocok** — Query SQL + convert to parquet. Tidak ada reasoning. |

### 6. Binance/Crypto

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `binance_price` | Get price | ❌ None | **Tidak cocok** — API call → return price. Tidak ada reasoning. |
| `binance_ticker24hr` | 24h ticker | ❌ None | **Tidak cocok** — API call → return stats. Tidak ada reasoning. |
| `binance_klines` | OHLCV candles | ❌ None | **Tidak cocok** — API call → return candles. Tidak ada reasoning. |
| `binance_depth` | Order book | ❌ None | **Tidak cocok** — API call → return order book. Tidak ada reasoning. |
| `binance_ta_analyze` | Technical analysis | ❌ None | **Cocok untuk interpretation** — Setelah indicators terhitung, LLM bisa interpret trends. Tapi tool ini sudah return final values. |
| `binance_search_symbol` | Search symbol | ❌ None | **Tidak cocok** — API call → return matches. Tidak ada reasoning. |

### 7. Web Read/Search

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `web_read` | Baca web page | ❌ None | **Cocok untuk summarization** — Halaman web bisa sangat panjang. Local LLM bisa summarize sebelum return. Tapi tool ini sudah return markdown yang sudah di-clean. |
| `web_search` | Search web (Bing SERP) | ❌ None | **Cocok untuk query expansion** — User: "cari tutorial React" → LLM expand ke "React tutorial for beginners, React getting started guide". Tapi search engine sudah handle ini. |

### 8. CodeGraph

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| `codegraph_explore` | Explore code | ❌ None | **Cocok untuk explanation** — CodeGraph return raw source + call paths. Local LLM bisa explain: "ini adalah function yang handle authentication". Tapi output sudah cukup informatif. |
| `codegraph_status` | Check status | ❌ None | **Tidak cocok** — Return boolean status. Tidak ada reasoning. |

### 9. Agent/Supervisor

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| **`plan_task`** | **Create supervisor plan** | 🔴 **Remote** | **Sangat cocok** — Goal → TaskPlan translation. Local LLM cukup karena: (1) Input terstruktur (goal + tool registry), (2) Output terstruktur (JSON plan), (3) Context window cukup (tool descriptions ~4K, goal ~1K). **Trade-off**: Remote lebih baik untuk complex planning, tapi local cukup untuk simple tasks. |
| **`plan_revise`** | **Revise plan** | 🔴 **Remote** | **Sangat cocok** — Similar dengan plan_task. Input: existing plan + feedback. Output: revised plan. Local LLM cukup untuk revision sederhana. |
| **`deep_write`** | **Cloud subagent writing** | 🔴 **Remote** | **Sangat cocok** — Long-form writing. **Trade-off**: Local LLM terbatas (16K context), tapi untuk writing <4K chars, local sudah cukup. Untuk full articles, remote lebih baik. |
| **`draft_document`** | **Cloud subagent drafting** | 🔴 **Remote** | **Sangat cocok** — Similar dengan deep_write. Local cocok untuk drafts pendek. |
| `artifact_recall` | Recall dari process log | ❌ None | **Cocok untuk context selection** — Log bisa sangat panjang. Local LLM bisa select relevant sections. Tapi tool ini sudah have pagination (offset). |

### 10. Session Management

| Tool | Kegunaan | LLM Saat Ini | Analisis Local LLM |
|------|----------|--------------|---------------------|
| **`generate_session_title`** | **Generate session title** | 🔵 **Cloudflare** | **Sangat cocok** — Input: goal + output (ringkas). Output: 3-6 word title. Task sederhana, local LLM pasti bisa. Cloudflare pakai Granite4H-Micro (small model), local Gemma 4 E4B seharusnya lebih baik. |
| `local_chat` | Direct on-device chat | 🟢 **Local** | ✅ Sudah lokal. |
| `local_load_model` | Load model | ❌ None | ✅ Sudah lokal. |
| `local_model_status` | Check model status | ❌ None | ✅ Sudah lokal. |

### 11. Generated Tools

| Tool Category | Analisis Local LLM |
|---------------|---------------------|
| Browser (5 tools) | **Tidak cocok** — Extraction murni (HTML → markdown/JSON/links). Tidak ada reasoning. |
| Entertainment (21 tools) | **Tidak cocok** — API calls (Jikan, Pexels, PoetryDB). Return data langsung. |
| Finance (21 tools) | **Tidak cocok** — API calls (Frankfurter, CoinGecko, Alpha Vantage). Return data langsung. |
| Wikipedia (2 tools) | **Tidak cocok** — API calls. Return data langsung. |

---

## Tools with Existing Remote LLM

Tools yang sudah menggunakan remote LLM untuk reasoning:

| Tool | Remote Provider | Fungsi | Est. Context Size |
|------|-----------------|--------|-------------------|
| `plan_task` | `remote_llm::RemoteLlm` | Generate TaskPlan dari goal | ~5K tokens |
| `plan_revise` | `remote_llm::RemoteLlm` | Revisi plan yang sudah ada | ~6K tokens |
| `deep_write` | Remote pool | Long-form writing subagent | ~8K tokens |
| `draft_document` | Remote pool | Document drafting subagent | ~8K tokens |
| `memory_extract` | `remote_llm::RemoteLlm` | Extract memories dari transcript | ~24K chars (~8K tokens) |
| `memory_consolidate` | `remote_llm::RemoteLlm` | Merge redundant memories | ~4K tokens |
| `memory_scene_extract` | `remote_llm::RemoteLlm` | Name clusters jadi scenes | ~4K tokens |
| `memory_persona_generate` | `remote_llm::RemoteLlm` | Synthesize user persona | ~3K tokens |
| `generate_session_title` | Cloudflare Workers AI | Generate judul session | ~500 tokens |

---

## Local LLM Suitability Analysis

### Tier 1: SANGAT COCOK (High Impact, Reasoning-Heavy)

| Tool | Alasan Cocok |
|------|--------------|
| `knowledge_search` | Query expansion + answer synthesis butuh understanding semantics |
| **`data_query_nl`** | ✅ **IMPLEMENTED** — NL → query translation, multi-turn stateful (lihat [Data Query NL — Implemented](#data-query-nl--implemented)) |
| `pdf_replace_text` | Resolve ambiguitas sebelum replace butuh interpretasi |
| `office_create_deck` | Content brainstorming butuh kreativitas |
| `memory_extract` | Extract structured memories dari transcript butuh comprehension |
| `memory_consolidate` | Cluster naming butuh understanding similarity |
| `memory_scene_extract` | Scene naming butuh grouping logic |
| `memory_persona_generate` | Persona synthesis butuh summarization |
| `plan_task` | Goal → plan translation butuh tool understanding |
| `plan_revise` | Plan revision butuh understanding feedback |
| `deep_write` | Long-form writing butuh generation |
| `draft_document` | Document drafting butuh generation |
| `generate_session_title` | Title generation butuh summarization |

### Tier 2: COCOK (Medium Impact, Optional Enhancement)

| Tool | Alasan |
|------|--------|
| `web_read` | Summary berguna tapi tool sudah return clean markdown |
| `web_search` | Query expansion berguna tapi search engine sudah handle |
| `codegraph_explore` | Explanation berguna tapi output sudah informatif |
| `office_read_document` | Summary berguna tapi tool sudah return full markdown |
| `data_ta` | Interpretation berguna tapi values sudah cukup |
| `memory_search` | Re-ranking berguna tapi importance_score sudah handle |
| `memory_create` | Extraction berguna tapi user sudah provide structured input |

### Tier 3: TIDAK COCOK (Deterministic Operations)

| Tool Category | Alasan Tidak Cocok |
|---------------|---------------------|
| File operations (list, import, delete) | Murni I/O, tidak ada reasoning |
| Database queries (list, delete) | Murni SQL, tidak ada reasoning |
| API calls (Binance, Finance, Entertainment) | Return data langsung dari API |
| Binary operations (merge, split, export) | Konversi deterministik |
| Status checks | Return boolean/metadata |

---

## Trade-off Analysis

### Local vs Remote

| Aspek | Local (Gemma 4 E4B) | Remote (Cloud Pool) |
|-------|---------------------|---------------------|
| **Context Window** | 16K-32K tokens | 128K+ tokens |
| **Kualitas Reasoning** | Good untuk simple tasks | Excellent untuk complex tasks |
| **Kecepatan** | ~20-50 tok/s (CPU) | ~100+ tok/s |
| **Privasi** | ✅ Data tetap lokal | ⚠️ Data ke cloud |
| **Offline** | ✅ Bisa offline | ❌ Perlu internet |
| **Biaya** | ✅ Gratis | ⚠️ Ada cost per call |
| **Output Length** | Terbatas (~4K chars) | Panjang (>10K chars) |

### Kapan pakai Local?

- Simple tasks (title generation, query expansion)
- Privacy-sensitive data
- Offline mode
- High-frequency calls (search ranking)

### Kapan pakai Remote?

- Complex planning (multi-step tasks)
- Long-form writing (>4K chars)
- High-quality reasoning needed
- Large context required

---

## Implementation Roadmap

### Phase 1: Local Fallback untuk Tools yang Sudah Remote

**Goal**: Tambahkan local fallback untuk tools yang sudah pakai remote LLM.

| Tool | Implementation | Complexity |
|------|----------------|------------|
| `plan_task` | Cek `is_engine_loaded()`, panggil `local_chat` sebagai fallback | Medium |
| `plan_revise` | Sama seperti `plan_task` | Medium |
| `memory_extract` | Local extraction dengan context trimming | Medium |
| `memory_consolidate` | Local clustering + naming | Low |
| `memory_scene_extract` | Local scene naming | Low |
| `memory_persona_generate` | Local persona synthesis | Low |
| `generate_session_title` | Fully local (replace Cloudflare) | Low |

**Estimated Effort**: 2-3 days

### Phase 2: Local Reasoning untuk Tools Baru

**Goal**: Tambahkan local reasoning capability ke tools yang belum pakai LLM.

| Tool | Implementation | Complexity | Status |
|------|----------------|------------|--------|
| `knowledge_search` | Query expansion + answer synthesis | Medium | — |
| `data_query_nl` | NL → query translation, multi-turn stateful | Medium | ✅ Done |
| `pdf_replace_text` | Ambiguity resolution | Low | — |
| `office_create_deck` | Content brainstorming | High | — |

**Estimated Effort**: 3-5 days

---

## Data Query NL — Implemented

`data_query_nl` (`DataQueryNlTool`, `crates/toolsets/analytics-tools/src/lib.rs`) adalah tool pertama yang memakai LLM untuk reasoning di dalam tool. Arsitekturnya:

### Pemilihan tier (remote-first, konsisten dengan arsitektur kawai)

```
engine loaded && feature litert? ── ya ──► LOCAL multi-turn (detail di bawah)
        │ tidak
        ▼
remote_llm::reason(system, prompt)   ← pool: zai → … → empero → local (litert)
```

- **`remote_llm::reason`** (helper shared di `crates/foundation/remote-llm/src/reason.rs`): remote pool dulu; dengan feature `litert`, on-device engine jadi KANDIDAT TERAKHIR pool (stateless one-shot, `fresh=true`, materials di-cap 12k chars) — jadi semua caller remote (deep_write, planner, diagram) otomatis dapat fallback local saat seluruh cloud gagal, tanpa ubah API.
- **`extract_json`** juga shared di modul yang sama — tidak ada lagi trimming fence manual per tool.

### Flow local multi-turn (engine loaded)

```
user NL query
     │
     ▼
data_schema (analytics::discover) ── schema context untuk prompt
     │
     ▼
┌─ multi-turn loop (max 4 turns) ──────────────────────────┐
│ turn 1: local_chat(fresh=true)  — blank KV cache         │
│   prompt = translator instructions + schema + NL query   │
│   → LLM return query JSON                                │
│ execute query via DataQueryTool (reuse, bukan duplikat)  │
│   → hasil dikirim balik sebagai prompt                   │
│ turn 2..n: local_chat(fresh=false) — conversation lanjut │
│   → LLM lihat hasil aktual, tentukan query berikutnya    │
│     ATAU {"done": true}                                  │
└──────────────────────────────────────────────────────────┘
     │
     ▼
single result → return bare; multi → [{queryIndex, result}…]
```

### Keputusan desain

- **Remote-first.** Kualitas translate remote lebih baik; local = resiliency (offline / vault kosong / semua provider cooldown). Konsisten dengan "planner requires a configured remote LLM pool" — empty vault tetap berarti pure-local, tidak mengubah gating product.
- **Multi-turn stateful hanya di local.** Remote tier stateless by design (chat history tidak pernah dikirim ke cloud), jadi jalur one-shot meminta model merencanakan semua query sekaligus (single/array). Local bisa iterative karena `local_chat` persist conversation antar call (`fresh=false` melanjutkan KV cache).
- **Turn cap = 4** (`MAX_NL_TURNS`). Model yang tidak pernah bilang `done` tidak bisa loop selamanya; hasil parsial tetap di-return.
- **`{"done": true}` dicek SEBELUM parse sebagai `QueryArgs`** — kalau tidak, marker done bisa ke-parse sebagai query kosong (semua field `QueryArgs` optional).
- **`DataQueryTool` dipanggil sebagai tool, bukan duplikat logic** — `data_query_nl` = translator layer; eksekusi, coercion, error guidance tetap satu pintu di `data_query`.
- **Feature-gated.** `local-llm` ditarik di belakang feature `litert` (analytics-tools + remote-llm, pola `kawai-agent/litert`); tanpa feature, semua jalur local compile out dan tool tetap berfungsi via `reason`. Wajib begitu — dep ungatan membuat link test butuh dylib `litert-lm` yang tidak ada di CI.

### Phase 3: Optional Enhancements

**Goal**: Tambahkan optional local reasoning untuk tools yang sudah cukup bagus.

| Tool | Implementation | Complexity |
|------|----------------|------------|
| `web_read` | Post-fetch summarization | Low |
| `web_search` | Query expansion | Low |
| `codegraph_explore` | Code explanation | Low |

**Estimated Effort**: 1-2 days

---

## Architecture Proposal

### Hybrid Local/Remote Reasoning Layer

```
┌─────────────────────────────────────────────────────────┐
│                   Tool Execution Layer                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │         Reasoning Router (Decision Layer)        │   │
│  │  • Check: local_llm::is_engine_loaded()         │   │
│  │  • Check: remote_llm::RemoteLlm::from_env()    │   │
│  │  • Decision: local first, remote fallback       │   │
│  │  • Or: remote first, local fallback             │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│           ┌─────────────┴─────────────┐                 │
│           ▼                           ▼                 │
│  ┌─────────────────┐         ┌─────────────────┐       │
│  │   Local LLM     │         │   Remote LLM    │       │
│  │   (Gemma 4)     │         │   (Cloud Pool)  │       │
│  ├─────────────────┤         ├─────────────────┤       │
│  │ • Fast (on-device)│       │ • Higher quality │       │
│  │ • Private         │       │ • Larger context │       │
│  │ • No network      │       │ • Better reasoning│      │
│  │ • Limited context │       │ • Requires vault │       │
│  └─────────────────┘         └─────────────────┘       │
│           │                           │                 │
│           └─────────────┬─────────────┘                 │
│                         ▼                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Tool Execution Result               │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Implementation Pattern

```rust
// Generic hybrid reasoning function
pub async fn hybrid_reason(
    system: &str,
    task: &str,
    context: &str,
) -> Result<String, String> {
    // 1. Try local LLM first (if loaded)
    if local_llm::is_engine_loaded() {
        match local_llm::local_chat(
            &format!("{system}\n\n{task}"),
            context,
        ).await {
            Ok(answer) if !answer.trim().is_empty() => return Ok(answer),
            Ok(_) => {}, // Empty, try remote
            Err(e) => {
                eprintln!("[hybrid] local failed: {e}, trying remote");
            }
        }
    }
    
    // 2. Fallback to remote LLM
    let remote = remote_llm::RemoteLlm::from_env()
        .ok_or_else(|| "no LLM available (local not loaded, remote not configured)")?;
    
    let mut stream = remote.stream(system, task, context).await
        .map_err(|e| format!("remote: {e}"))?;
    
    let mut answer = String::new();
    while let Some(event) = stream.next().await {
        if let remote_llm::RemoteEvent::Token { text } = event? {
            answer.push_str(&text);
        }
    }
    
    Ok(answer)
}
```

### Integration Points

1. **`src-tauri/src/logic.rs`**: Add `hybrid_reason` function
2. **`crates/foundation/memory/src/lib.rs`**: Update `memory_extract` et al
3. **`src-tauri/src/supervisor.rs`**: Update `plan_task` with local fallback
4. **`crates/engines/knowledge/src/tools.rs`**: Add reasoning to `knowledge_search`
5. **`crates/toolsets/analytics-tools/src/lib.rs`**: ✅ Done — `data_query_nl` (lihat [Data Query NL — Implemented](#data-query-nl--implemented))

---

## Local vs Remote Decision Matrix

Analisis mendalam untuk setiap tool yang membutuhkan reasoning: apakah **Local Gemma 4** sudah cukup, atau perlu **Remote LLM** yang lebih powerful.

### Decision Criteria

| Faktor | Local Gemma 4 Cukup | Perlu Remote LLM |
|--------|---------------------|------------------|
| **Context Window** | Input < 12K tokens | Input > 16K tokens |
| **Reasoning Complexity** | Single-step, pattern matching | Multi-step, complex inference |
| **Output Quality** | Draft/casual acceptable | Production/professional needed |
| **Output Length** | < 4K chars | > 4K chars |
| **Latency** | Can wait 2-5s | Needs < 2s response |
| **Privacy** | Sensitive data | Non-sensitive data |
| **Frequency** | High-frequency (>10x/hour) | Low-frequency (<10x/hour) |

---

### Category A: Local Gemma 4 SUFFICIENT

Tools yang **cukup dengan local LLM** karena task sederhana atau output terstruktur.

| Tool | Task | Analisis | Verdict |
|------|------|----------|---------|
| `generate_session_title` | Generate 3-6 word title | Task sangat sederhana: summarize goal + output jadi title pendek. Cloudflare pakai Granite4H-Micro (small model), Gemma 4 E4B seharusnya lebih baik. Input ~500 tokens, output ~10 tokens. | 🟢 **LOCAL SUFFICIENT** |
| `memory_consolidate` | Name memory clusters | Pattern matching sederhana: "User prefers dark mode" + "Likes dark UIs" → same cluster, name "UI Preferences". Input ~2K tokens (list memories ringkas), output ~100 tokens per cluster. | 🟢 **LOCAL SUFFICIENT** |
| `memory_scene_extract` | Name scene clusters | Similar consolidate: cluster by embedding, LLM name each. Input ~2K tokens, output ~200 tokens. | 🟢 **LOCAL SUFFICIENT** |
| `memory_persona_generate` | Synthesize user persona | Summarization task: gabungkan 24 memories jadi 1 paragraph persona. Input ~3K tokens (24 items × 800 chars), output ~500 tokens. | 🟢 **LOCAL SUFFICIENT** |
| `knowledge_search` (query expansion) | Expand search query | Pattern matching: "cara reset password" → "password reset, forgot password". Input ~500 tokens, output ~100 tokens. | 🟢 **LOCAL SUFFICIENT** |
| `data_query` (simple queries) | NL → polars query | Translate simple queries: "show sales by region" → `df.group_by("region").agg(...)`. Input ~1K tokens (schema + query), output ~200 tokens. | 🟢 **LOCAL SUFFICIENT** |
| `pdf_replace_text` (simple cases) | Resolve ambiguitas | Simple interpretation: "ganti tanggal" → extract pattern, match ke regex. Input ~1K tokens, output ~100 tokens. | 🟢 **LOCAL SUFFICIENT** |

---

### Category B: Remote LLM PREFERRED (Local sebagai Fallback)

Tools yang **lebih baik pakai remote** karena reasoning complex, tapi local bisa sebagai fallback.

| Tool | Task | Analisis | Verdict |
|------|------|----------|---------|
| `plan_task` | Create supervisor plan | **Complex multi-step reasoning**: goal →分解 → tool selection → dependency graph → validation. Butuh understanding 20+ tool descriptions + context user. Input ~5K tokens, output ~2K tokens (JSON plan). Remote lebih baik untuk complex goals, tapi local cukup untuk simple tasks (1-3 steps). | 🟡 **REMOTE PREFERRED, LOCAL FALLBACK** |
| `plan_revise` | Revise existing plan | **Complex reasoning**: understand feedback → identify affected steps → rewrite. Input ~6K tokens (plan + feedback), output ~2K tokens. | 🟡 **REMOTE PREFERRED, LOCAL FALLBACK** |
| `memory_extract` | Extract memories from transcript | **Comprehension task**: read 24K chars transcript → extract structured memories. Context window hampir penuh (24K chars ≈ 8K tokens, local limit 16K). Remote lebih reliable untuk extraction quality. | 🟡 **REMOTE PREFERRED, LOCAL FALLBACK** |
| `knowledge_search` (answer synthesis) | Synthesize answer from chunks | **Multi-document synthesis**: gabungkan 5-10 chunks jadi jawaban koheren. Input ~4K tokens (chunks), output ~1K tokens. Remote lebih baik untuk coherence, tapi local cukup untuk simple summary. | 🟡 **REMOTE PREFERRED, LOCAL FALLBACK** |
| `data_query` (complex queries) | NL → complex polars query | **Complex translation**: multi-table joins, subqueries, window functions. Input ~2K tokens, output ~500 tokens. Remote lebih reliable untuk complex queries. | 🟡 **REMOTE PREFERRED, LOCAL FALLBACK** |

---

### Category C: Remote LLM REQUIRED (Local TIDAK Cukup)

Tools yang **harus pakai remote** karena membutuhkan kualitas reasoning tinggi atau context window besar.

| Tool | Task | Analisis | Verdict |
|------|------|----------|---------|
| `deep_write` | Long-form writing | **High-quality generation**: artikel, laporan, dokumentasi >4K chars. Butuh coherence, structure, dan depth. Local Gemma 4 terbatas: (1) context window 16K tidak cukup untuk reference materials, (2) output quality untuk formal writing kurang. Remote LLM (Claude/GPT) jauh lebih baik. | 🔴 **REMOTE REQUIRED** |
| `draft_document` | Document drafting | **Professional quality**: proposal, laporan bisnis, kontrak. Butuh structure, tone consistency, dan completeness. Similar deep_write. | 🔴 **REMOTE REQUIRED** |
| `office_create_deck` (complex) | Create presentation | **Creative + structured**: butuh brainstorm slide structure, content flow, visual hierarchy. Remote lebih baik untuk creative tasks. Tapi untuk simple decks (3-5 slides), local mungkin cukup. | 🟡 **REMOTE PREFERRED, LOCAL UNTUK SIMPLE** |
| `pdf_replace_text` (complex cases) | Replace dengan konteks | **Deep理解**: "ganti semua harga lama ke harga baru" → butuh scan seluruh document, understand context, handle edge cases. Local bisa handle simple cases, tapi complex cases perlu remote. | 🟡 **REMOTE PREFERRED, LOCAL UNTUK SIMPLE** |

---

### Category D: LOCAL PREFERRED (Privasi/Speed Critical)

Tools yang **lebih baik pakai local** karena privasi atau latency.

| Tool | Task | Analisis | Verdict |
|------|------|----------|---------|
| `memory_extract` (privacy mode) | Extract dari transcript | **Privacy-critical**: transcript berisi percakapan pribadi. Local memastikan data tidak keluar dari device. User mungkin lebih rela kualitas lebih rendah daripada data bocor. | 🟢 **LOCAL PREFERRED (PRIVACY)** |
| `data_query` (real-time) | NL → query | **Latency-critical**: user menunggu hasil. Local ~2-5s, remote ~5-10s (network overhead). Untuk interactive analytics, local lebih baik. | 🟢 **LOCAL PREFERRED (SPEED)** |
| `knowledge_search` (offline) | Search offline | **Offline mode**: tidak ada internet. Local satu-satunya pilihan. | 🟢 **LOCAL REQUIRED (OFFLINE)** |

---

### Summary Matrix

| Tool | Local Sufficient | Remote Preferred | Remote Required | Local Preferred |
|------|:----------------:|:----------------:|:---------------:|:---------------:|
| `generate_session_title` | ✅ | | | |
| `memory_consolidate` | ✅ | | | |
| `memory_scene_extract` | ✅ | | | |
| `memory_persona_generate` | ✅ | | | |
| `knowledge_search` (query) | ✅ | | | |
| `data_query` (simple) | ✅ | | | |
| `pdf_replace_text` (simple) | ✅ | | | |
| `plan_task` | ⚠️ | ✅ | | |
| `plan_revise` | ⚠️ | ✅ | | |
| `memory_extract` | ⚠️ | ✅ | | |
| `knowledge_search` (synthesis) | ⚠️ | ✅ | | |
| `data_query` (complex) | ⚠️ | ✅ | | |
| `office_create_deck` (complex) | | ✅ | | |
| `pdf_replace_text` (complex) | | ✅ | | |
| `deep_write` | | | ✅ | |
| `draft_document` | | | ✅ | |
| `memory_extract` (privacy) | | | | ✅ |
| `data_query` (real-time) | | | | ✅ |
| `knowledge_search` (offline) | | | | ✅ |

**Legend:**
- ✅ = Recommended
- ⚠️ = Possible but quality may degrade
- Empty = Not applicable

---

### Decision Flowchart

```
┌─────────────────────────────────────────────────────────────┐
│                    Tool Needs Reasoning?                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ Data Sensitive? │
                    └─────────────────┘
                       │           │
                      Yes          No
                       │           │
                       ▼           ▼
              ┌──────────────┐  ┌─────────────────┐
              │ LOCAL PREFERRED│  │ Need > 4K output?│
              │ (Privacy)     │  └─────────────────┘
              └──────────────┘     │           │
                                  Yes          No
                                   │           │
                                   ▼           ▼
                      ┌─────────────────┐  ┌─────────────────┐
                      │ REMOTE REQUIRED │  │ Complex reasoning?│
                      │ (Quality)       │  └─────────────────┘
                      └─────────────────┘     │           │
                                             Yes          No
                                              │           │
                                              ▼           ▼
                                 ┌─────────────────┐  ┌──────────────┐
                                 │ REMOTE PREFERRED │  │ LOCAL SUFFICIENT│
                                 │ (Quality)       │  │ (Simple task)   │
                                 └─────────────────┘  └──────────────┘
```

---

### Implementation Strategy

#### Strategy 1: Local First, Remote Fallback

```rust
// Untuk tools di Category B
pub async fn plan_task_hybrid(user_id: &str, goal: &str, registry: &ToolRegistry) -> Result<TaskPlan, String> {
    // 1. Try local first
    if local_llm::is_engine_loaded() {
        match plan_task_local(user_id, goal, registry).await {
            Ok(plan) if plan.steps.len() <= 3 => return Ok(plan), // Simple plan, local OK
            Ok(plan) => {
                // Complex plan from local, but try remote for better quality
                if remote_llm::RemoteLlm::from_env().is_some() {
                    match plan_task_remote(user_id, goal, registry).await {
                        Ok(better_plan) => return Ok(better_plan),
                        Err(_) => return Ok(plan), // Remote failed, use local
                    }
                }
                return Ok(plan);
            }
            Err(e) => eprintln!("[plan_task] local failed: {e}"),
        }
    }
    
    // 2. Fallback to remote
    plan_task_remote(user_id, goal, registry).await
}
```

#### Strategy 2: Always Local (Privacy/Speed)

```rust
// Untuk tools di Category D
pub async fn memory_extract_private(user_id: &str, session_id: i64) -> Result<Vec<MemoryItem>, DbError> {
    // Always use local, never send transcript to cloud
    if !local_llm::is_engine_loaded() {
        return Err(DbError::Config("local LLM required for private extraction".into()));
    }
    
    memory_extract_local(user_id, session_id).await
}
```

#### Strategy 3: Always Remote (Quality)

```rust
// Untuk tools di Category C
pub async fn deep_write_quality(user_id: &str, goal: &str, context: &str) -> Result<String, String> {
    // Always use remote for best quality
    let remote = remote_llm::RemoteLlm::from_env()
        .ok_or_else(|| "deep_write requires remote LLM (quality critical)".to_string())?;
    
    // ... remote implementation
}
```

---

## Appendix: File Locations

| Component | Path |
|-----------|------|
| Local LLM entry point | `local-llm/src/lib.rs` |
| Remote LLM client | `crates/foundation/remote-llm/src/lib.rs` |
| Memory tools | `crates/foundation/memory/src/tools.rs` |
| Knowledge tools | `crates/engines/knowledge/src/tools.rs` |
| Analytics tools | `crates/toolsets/analytics-tools/src/lib.rs` |
| Office tools | `crates/engines/office/src/tools.rs` |
| Supervisor | `src-tauri/src/supervisor.rs` |
| Agent registry | `src-tauri/src/agent_registry.rs` |
