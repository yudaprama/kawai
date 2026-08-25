# Implementation Plan — Multimodal knowledge indexing (LiteRT-LM embedding engine)

Status: **BACKLOG — blocked on upstream model release** (see §0 Trigger).

This is **Option A (dual-space)**: keep the existing fastembed text pipeline
untouched, add a second, separate embedding space for media (images now,
audio later) backed by `cognee-litert-lm`'s `EmbeddingEngine`
(EmbeddingGemma v2, multimodal). Per AGENTS.md this rides on already-shipped
surfaces (RAG Tier 2/3) — no new ops, wrappers, or frontend work.

---

## 0. Trigger — what unblocks this

Everything below is designed to be **dimension-agnostic** (dim is read from
the model at runtime). The only hard blocker is a model file that LiteRT-LM's
embedding engine can load:

- [ ] `embedding-gemma-v2.litertlm` published (HF `google-ai-edge`, or a
      kontextdev-style community build) and dropped into `models/`
      (~/.kawai/models resolution already exists for the chat model).
- Fallback candidate if v2 never ships as a file: v1 text-only
  `kontextdev/embeddinggemma-300m-litertlm` (256-dim MRL-truncated) — but it
  has **no vision encoder**, so it does not solve the image gap; it would only
  serve as a local text-embedding swap (Option B territory, out of scope here).

Findings locked in during research (2026-08-19):

- LiteRT-LM does NOT hardcode the embedding dim anywhere — the executor reads
  tensor shapes at load (`embedding_litert_compiled_model_executor.cc:93-119`),
  the C test only asserts `dim > 0`. `EmbeddingResponse::size()` is the
  runtime source of truth.
- EmbeddingGemma v1 native dim = 768 (MRL-truncatable to 512/256/128). v2 dim
  unknown until the file exists — plan assumes nothing.
- The multimodal token scheme is real and validated in-tree
  (`embedding_engine_impl_test.cc:873-890`): image → `[start_of_image, -1×N,
  end_of_image]`, audio analog; negative placeholder ids are replaced by
  vision/audio encoder outputs inside the engine.
- Rust binding already exposes `InputKind::{Text, Image, ImageEnd, Audio,
  AudioEnd}` and `compute_embedding[_batch]` (`cognee-litert-lm/src/embedding.rs`,
  `session.rs:124`). `EmbeddingEngine` is `Send + Sync`.

## 1. Goals / Non-goals

**Goals**

1. Local images imported via the knowledge panel become **searchable**:
   `knowledge_search` finds them by meaning ("gambar kucing oranye") without
   any OCR/VOCR cloud call. Today they land in `failed` status
   (`describe_image` needs JigsawStack, rag.rs:452) — this removes that gap.
2. Text pipeline remains 1024-dimensional; desktop/web uses the local
   fastembed fallback, while Android/iOS exclude fastembed/ONNX entirely and
   use configured remote embedding providers only.
3. Media vectors live in their own table/space (`rag_media_chunks`) so the
   768-ish dim never collides with the 1024 schema.
4. All existing ops/behaviors preserved: no new commands, no web route
   changes, no frontend changes (index status + RagHit already flow).

**Non-goals**

- Audio indexing (API shape supports it; no audio ingestion path exists yet —
  revisit when the office store accepts audio).
- Replacing the desktop/web fastembed fallback as the text embedder (that's
  Option B — a full re-index and removal of the local ONNX path; separate
  decision, only worth it if we want to consolidate).
- Multimodal *chat* input (images into `local_chat` prompts) — different
  surface, tracked elsewhere.
- Zero-downtime migration — not applicable; media table starts empty.

## 2. Architecture

```
import image (knowledge panel)
  └─ office_index_file ─▶ index_file_inner (rag.rs)
        ├─ ext image ─▶ extract_text: describe_image()          (UNCHANGED path, still
        │               try; if it works, caption enriches both)  best-effort)
        ├─ caption chunk ─▶ rag_chunks (fastembed 1024)          (BM25 side: filename
        │                                                           + caption text)
        └─ [cfg litert] raw bytes ─▶ local_llm::embed_media(
              [Text(caption), Image(bytes)])                     (NEW: spawn_blocking)
                └─▶ rag_media_chunks  FLOAT32(<runtime ndims>)   (NEW table,
                    + rag_media_chunks_fts mirror optional        media space)

knowledge_search (session-scoped)
  ├─ vector: rag_chunks       via fastembed           (UNCHANGED)
  ├─ lexical: rag_chunks_fts  via BM25                (UNCHANGED)
  └─ [cfg litert] media: rag_media_chunks via litert   (NEW 3rd ranking)
        all three fused in the SAME rrf_fuse()
```

Key decisions:

- **Caption always written as a small `rag_chunks` chunk** (id
  `<file_id>#caption`, content = filename + any describe text). Guarantees
  keyword-mode still hits media files and the panel's chunk count is nonzero
  even when litert is off.
- **Media embed is one-shot per file** (not chunked): images are single
  semantic units; `compute_embedding` with `[Text, Image]` produces one
  vector per file row.
- **Engine lifecycle mirrors `local-llm`'s slot pattern** (lib.rs:39-55):
  `Mutex<Option<EmbeddingEngine>>` OnceLock; lazy-load on first media embed;
  explicit unload piggybacks on `local_llm_unload`. Loading the chat engine
  and the embedding engine are independent slots (separate models).

## 3. Work breakdown

### W1 — `local-llm`: embedding engine slot (crate-local, pure)

- `embedding_slot() -> &'static Mutex<Option<EmbeddingEngine>>` +
  `EmbeddingOptions` (normalize = true) reuse.
- `load_embedding_engine() -> Result<usize, String>`: resolves model path
  (`KAWAI_EMBEDDING_MODEL_PATH` → `~/.kawai/models/embedding-gemma-v2.litertlm`),
  `EmbeddingEngineSettings::new(path, Backend::Cpu, None, None).build()`,
  returns the observed dim (`EmbeddingResponse::size()` on a probe text).
  CPU first — GPU is blocked upstream anyway (Roadmap 17).
- `embed_media(batch: Vec<Vec<InputKind<'_>>>) -> Result<Vec<Vec<f32>>, String>`:
  wraps `compute_embedding_batch` in `tokio::task::spawn_blocking`; loads the
  engine on demand. One-shot call, no partial state — safe re: the
  drop-mid-generation landmine (that hazard is specific to streaming LLM
  sessions; embedding compute is synchronous-and-done inside the closure).
- `embedding_unload()` wired into the existing `local_llm_unload` op.
- Unit-testable without a model: slot logic, path resolution, and error
  strings; the actual embed path stays behind the runtime model check.

### W2 — `rag.rs`: media table + purge coverage

- `RagMediaChunk` with its vector tables (columns: id, file_id,
  source, locator, content=short caption for display in RagHit). NOTE:
  the vector tables follow the `<table>`/`<table>_embeddings`/
  `<table>_embedding_map` layout `rag.rs::ensure_vector_schema` creates —
  so `rag_media_chunks` gets its own
  `rag_media_chunks_embeddings` etc. No FTS mirror for media in v1 (caption
  chunk already covers the lexical side) — revisit if captions get rich.
- Media-side store construction needs an `EmbeddingModel` impl to hand to
  `LibsqlVectorStore::new`. That adapter (`LitertMediaModel`) lives in rag.rs
  behind `#[cfg(feature = "litert")]`: `ndims()` returns the slot's cached
  runtime dim; `embed_texts` delegates to `local_llm::embed_media` (text-only
  rows → `[Text]` inputs). It is NOT a `KawaiProvider` — deliberately outside
  kawai-embedding (that trait is `Vec<String>`-typed; media needs InputKind).
- `ensure_media_tables(conn)` — create-if-missing; tolerant of missing table
  on purge (same `no such table` handling as `purge_file_chunks`).
- `purge_file_chunks` extended: also drain `rag_media_chunks_embeddings`,
  `rag_media_chunks_embedding_map`, `rag_media_chunks` for the file. All
  existing callers (`forget_file`, `office_delete_file`) get media cleanup
  for free — no wrapper changes.
- `file_chunk_count` unchanged (panel semantics: caption chunk makes count
  ≥ 1 already).

### W3 — index path

- `index_file_inner`: for `png|jpg|jpeg|gif|webp`:
  1. caption text (describe_image best-effort; fallback = filename only);
  2. write caption chunk to `rag_chunks` (existing pipeline);
  3. `#[cfg(feature = "litert")]` if engine loadable → read bytes → embed
     `[Text(caption), Image(bytes)]` → insert `RagMediaChunk` row(s);
  4. litert off / model missing / engine error → media row skipped silently
     (status stays driven by the text side, so files still become `ready`).
     Log at `debug`; a hard error only when the text side also fails
     (existing behavior).
- Idempotency: media row id = `<file_id>#media0` (deterministic replace,
  same contract as text chunks).
- `rag_files.chunks` counts text chunks only (no semantic change).

### W4 — search path

- `knowledge_search`: add media ranking when mode != Keyword and litert is
  available: embed `[Text(query)]` via the media model, top-K over
  `rag_media_chunks` with the same `file_id`-IN filter, map hits to RagHit
  (content = caption; locator = `image`), feed into the existing
  `rrf_fuse(vector, lexical, media, K)` — extend signature to three
  rankings (trivially: fuse over `[vector, lexical, media]` iterator).
- Failure of the media side degrades to current two-way behavior (same
  best-effort contract as the FTS side in hybrid).
- SearchMode semantics unchanged.

### W5 — verification

- `cargo check` / `cargo check --features web` / `cargo check --features
  litert` / `cargo check --features litert,office` (+ web combo) all green.
- Mobile: `cargo ndk -t arm64-v8a -P 24 check --features litert,office` and
  `cargo check --target aarch64-apple-ios --features litert,office` — the
  litert and office paths must NOT drag `ort-sys` into these builds. The
  `kawai-embedding` fastembed dependency and provider are target-gated out on
  Android/iOS; mobile RAG uses remote providers when configured and otherwise
  returns the normal no-provider configuration error.
- Unit tests (no model needed): media table naming/purge SQL, rrf_fuse with
  3 rankings, caption-chunk id determinism, mode gating.
- With a model present: manual index + search of one image; verify
  `rag_media_chunks_embeddings` has a FLOAT32(dim) column matching
  `EmbeddingResponse::size()`.

## 4. Risks / open questions

- **v2 model may not ship as `.litertlm`** — if Google ships it only inside
  GenAI APIs, the fallback is a community conversion (kontextdev did v1).
  If nothing appears, this plan stays shelved; nothing in it rots (all
  guarded code is additive).
- **Memory**: embedding engine is a second loaded model (~300MB class).
  Acceptable on desktop; note for mobile later.
- **Vision encoder in `.litertlm` bundle**: v1 files do not include one; v2
  presumably bundles it (patch_width metadata exists in the builder proto).
  If the shipped file lacks vision sections, `compute_embedding([Image])`
  will error → W3 step 4 degrade path keeps indexing green; image search
  simply stays off until a proper file lands.
- **Threads**: embedding engine CPU threads not yet tunable via binding for
  the main backend (`set_audio_num_threads` only) — fine for one-shot calls.
- **Vector-store `INSERT OR REPLACE` rowid-churn note** (FTS ghost rows,
  rag.rs:477-481): applies only to tables with FTS mirrors; media table has
  none in v1, so no ghost-row concern there.

## 5. Explicitly out of scope (tracked elsewhere)

- Option B (single-space consolidation on litert for ALL embedding) — decided
  against for now; revisit post-v2 if quality/cost favors it.
- Mobile media indexing UX, audio ingestion, GPU backends.
