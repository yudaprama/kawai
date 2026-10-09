# Implementation Plan — Multimodal knowledge indexing (LiteRT-LM embedding engine)

Status: **TEXT EMBEDDING SHIPPED via LiteRT (2026-08-26), migrated to
EmbeddingGemma 2 (2026-10-09); MEDIA INDEXING unblocked — the model trigger
landed, see §0.**

## What shipped — local text embedding on LiteRT

The desktop/web local embedding fallback runs **EmbeddingGemma 2 740M through
LiteRT-LM** (`kawai-embedding::LitertProvider` →
`cognee_litert_lm::LitertEmbedder`, feature `litert`). Key facts:

- Model: `embeddinggemma-2-740m.litertlm` from the official ungated HF repo
  `litert-community/embeddinggemma-2-740m-litert-lm` (auto-downloaded to
  `~/.kawai/models/`, with `.part` resume support). One file: the tokenizer
  ships inside the bundle, so there is no second SentencePiece download.
- Dimension: **768** — the pool-wide dimension (`kawai-embedding::DEFAULT_DIM`),
  which is also the native output of EG2 (MRL-truncatable to 512/256/128).
  All providers share one 768-d space: OpenRouter `text-embedding-3-small`,
  NVIDIA `llama-3_2-nemoretriever-300m-embed-v1`, and Gemini `embedding-001`
  request 768 server-side (Matryoshka `dimensions` / `outputDimensionality`,
  client-side truncate as safety net).
- Runner: LiteRT-LM's `EmbeddingEngine` (the `//c:litert-lm` C API), driven in
  batch via `compute_embedding_batch`. Text signature families
  `encoder_{128…8192}`; outputs arrive L2-normalized with `normalize` on.
- Swapping the embedder is a vector-space break even at the same dimension, so
  the change shipped with `db` migration `0028_reset_embedding_vectors`, which
  drops the stale rag / graph / memory vectors and clears the index status.

### What changed on 2026-10-09 (the EG1 → EG2 cutover)

Before: EmbeddingGemma 300M via the standalone whole-graph `.tflite` runner
(`c/tflite_embed.{h,cc}` + a separate `sentencepiece.model`), because
`EmbeddingEngine` requires a split `tf_lite_embedder` (per-token lookup) +
`tf_lite_text_encoder` `.litertlm` bundle and no such bundle existed. Google's
2026-09-29 `litert-community/embeddinggemma-2-*` release publishes exactly
that, so the provider now uses the real embedding engine and the standalone
runner is no longer on the text path. The C API also moved to 1.0.0 (every
call returns `LiteRtLmStatusCode` and writes results through out-params);
`cognee-litert-lm`'s FFI layer was ported to match.

## Remaining backlog — media indexing

This is **Option A (dual-space)**: add a second, separate embedding space for
media (images now, audio later) backed by multimodal inputs. The text pipeline
described above is done; nothing below rots.

## 0. Trigger — what unblocks media indexing

Everything below is designed to be **dimension-agnostic** (dim is read from
the model at runtime). The hard blocker is a model file that carries a vision
encoder:

- [x] A vision-capable embedding file loadable by LiteRT — shipped:
      `litert-community/embeddinggemma-2-740m-litert-lm` (full multimodal:
      text + vision 170M + audio 300M, `vision_tokens_per_image` 70–1120,
      audio soft tokens 12). The same bundle backs text today, so W1 can load
      one model rather than two.

Findings locked in during research (2026-08-19):

- LiteRT-LM does NOT hardcode the embedding dim anywhere — the executor reads
  tensor shapes at load (`embedding_litert_compiled_model_executor.cc:93-119`),
  the C test only asserts `dim > 0`. Runtime size is the source of truth.
- EmbeddingGemma 2 native dim = 768 (MRL-truncatable to 512/256/128) — the
  same `DEFAULT_DIM` the text path already uses, so media vectors can share it.
- The multimodal token scheme is real and validated in-tree
  (`embedding_engine_impl_test.cc:873-890`): image → `[start_of_image, -1×N,
  end_of_image]`, audio analog; negative placeholder ids are replaced by
  vision/audio encoder outputs inside the engine.
- Rust binding exposes `InputKind::{Text, Image, ImageEnd, Audio, AudioEnd}`
  and `compute_embedding[_batch]` (`cognee-litert-lm/src/embedding.rs`,
  `session.rs:124`). `EmbeddingEngine` is `Send + Sync`.

## 1. Goals / Non-goals

**Goals**

1. Local images imported via the knowledge panel become **searchable**:
   `knowledge_search` finds them by meaning ("gambar kucing oranye") without
   any OCR/VOCR cloud call. Today they land in `failed` status
   (`describe_image` needs JigsawStack, rag.rs:452) — this removes that gap.
2. Text pipeline stays on the shipped LiteRT runner (768d); Android/iOS
   exclude it entirely and use configured remote embedding providers only.
3. Media vectors live in their own table/space (`rag_media_chunks`) so the
   media dim never collides with the text schema.
4. All existing ops/behaviors preserved: no new commands, no web route
   changes, no frontend changes (index status + RagHit already flow).

**Non-goals**

- Audio indexing (API shape supports it; no audio ingestion path exists yet —
  revisit when the office store accepts audio).
- Multimodal *chat* input (images into `local_chat` prompts) — different
  surface, tracked elsewhere.
- Zero-downtime migration — not applicable; media table starts empty.

## 2. Architecture

```
import image (knowledge panel)
  └─ office_index_file ─▶ index_file_inner (rag.rs)
        ├─ ext image ─▶ extract_text: describe_image()          (UNCHANGED path,
        │               try; if it works, caption enriches both  best-effort)
        ├─ caption chunk ─▶ rag_chunks (litert text runner, 768)
        └─ [cfg litert] raw bytes ─▶ media embed call
              ([Text(caption), Image(bytes)] once a vision-capable
               model file exists)
                └─▶ rag_media_chunks FLOAT32(<runtime ndims>)    (NEW table)

knowledge_search (session-scoped)
  ├─ vector: rag_chunks       via litert text runner   (SHIPPED)
  ├─ lexical: rag_chunks_fts  via BM25                 (UNCHANGED)
  └─ [cfg litert] media: rag_media_chunks              (NEW 3rd ranking)
        all fused in the SAME rrf_fuse()
```

Key decisions:

- **Caption always written as a small `rag_chunks` chunk** (id
  `<file_id>#caption`, content = filename + any describe text). Guarantees
  keyword-mode still hits media files and the panel's chunk count is nonzero
  even when litert is off.
- **Media embed is one-shot per file**: images are single semantic units;
  one vector per media row.
- **Engine lifecycle mirrors the text slot**: lazy-load on first media embed;
  explicit unload piggybacks on the existing unload op.

## 3. Work breakdown (unchanged in shape; embed call swaps to whatever
runner the trigger model needs)

### W1 — media embed plumbing (crate-local, pure)

- Slot + loader for the media model (path resolution:
  `KAWAI_EMBED_MEDIA_MODEL_PATH` → `~/.kawai/models/`),
  spawn_blocking wrapper, runtime-dim probe, unload hook.
- Unit-testable without a model: slot logic, path resolution, error strings.

### W2 — `rag.rs`: media table + purge coverage

- `RagMediaChunk` vector tables following the `<table>`/`<table>_embeddings`/
  `<table>_embedding_map` layout `ensure_vector_schema` uses. No FTS mirror
  for media in v1 (caption chunk covers the lexical side).
- `purge_file_chunks` extended: also drain the media tables for the file.

### W3 — index path

- For `png|jpg|jpeg|gif|webp`: caption chunk first (existing pipeline), then
  best-effort media embed; failure degrades silently (text side drives
  status). Idempotency: media row id = `<file_id>#media0`.

### W4 — search path

- `knowledge_search`: third ranking over `rag_media_chunks` when mode !=
  Keyword and the media model is available; fuse via the existing rrf_fuse.

### W5 — verification

- Feature battery green; mobile targets stay free of any new native dep.
- With a model present: manual image index + search round-trip.

## 4. Risks / open questions

- **Vision-capable file may not ship as one loadable artifact** — if nothing
  appears, this plan stays shelved; nothing in it rots (all guarded code is
  additive).
- **Memory**: a second loaded model (~300MB class). Acceptable on desktop;
  note for mobile later.
- **Vector-store `INSERT OR REPLACE` rowid-churn note** (FTS ghost rows):
  applies only to tables with FTS mirrors; media table has none in v1.

## 5. Explicitly out of scope (tracked elsewhere)

- Mobile media indexing UX, audio ingestion, GPU backends.
