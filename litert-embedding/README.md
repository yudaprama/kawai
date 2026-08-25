# litert-embedding

Local text embedder over the **LiteRT-LM embedding engine**, implementing
rig-core's `EmbeddingModel` so it plugs directly into `rig-libsql`'s
`LibsqlVectorStore`.

**Status: standalone evaluation crate. Nothing in kawai depends on it yet** —
not wired into `kawai-embedding`, `src-tauri`, or any UI. It exists to answer
one question before adoption: *is a LiteRT-based local embedder good enough
to replace fastembed?*

## Why this exists

The current RAG fallback embedder (`FastembedProvider` in `kawai-embedding`)
pulls `ort-sys` / ONNX Runtime, which ships no mobile prebuilts — that is what
blocks `cargo check --target aarch64-apple-ios --features office`. The
LiteRT-LM C API already exposes a full embedding engine (`EmbeddingEngine`,
single + batch compute, L2-normalize option, multimodal inputs), rides the
same dylibs kawai already builds and bundles for chat, and has upstream bazel
configs for android/ios targets. Replacing fastembed with this stack removes
ONNX from the graph entirely.

## Requirements

1. **Prepared dylibs**: `cognee-litert-lm/native/` filled by
   `bun run bundle:litert` at the repo root (the same step desktop dev needs).
2. **An embedding `.litertlm` model** — a model built for the *embedding*
   graph (upstream's reference default: `embedding-gemma-v2.litertlm`).
   Chat models (`gemma-4-E4B-it.litertlm`, …) are a different graph kind and
   do not serve as embedding models here.
3. macOS arm64 dev machine today; the same engine builds for android arm64 /
   iOS upstream (that portability is the point of the evaluation).

## Evaluate

```sh
./smoke.sh /path/to/embedding-gemma-v2.litertlm            # cpu backend
./smoke.sh /path/to/model.litertlm --backend gpu           # where supported
```

The harness prints:

- output dimension + normalization state (probed once at load),
- most/least similar pairs over a mixed EN/ID sentence set,
- mini retrieval check — rank of the intended document per query
  (weather / finance / recipe / earnings),
- cold batch latency and warm average per-text latency.

Adoption signals worth collecting while evaluating:

| Signal | Threshold of interest |
|---|---|
| Retrieval top-1 on the mini set | 4/4 (sanity), then build a real fixture set |
| Dimension | 768 native (EmbeddingGemma-class); MRL truncation available |
| Latency per chunk | comparable-or-better vs fastembed on 1500-char chunks |
| Model size | hundreds of MB vs ~GB-scale fastembed pair |
| Multilingual | one model replaces the EN/multilingual `whatlang` routing |

## Library use

```rust
use litert_embedding::LitertEmbedder;

let embedder = LitertEmbedder::new("/path/to/model.litertlm")?; // blocks: loads + dims probe
let vecs = embedder.embed(vec!["hello".into(), "halo".into()]).await?;
let dim = embedder.dimension();
```

Config knobs via `LitertEmbedder::with_config(path, EmbedderConfig { backend,
normalize, insert_special_tokens, cache_dir })`. The type also implements
rig-core's `EmbeddingModel` (`MAX_DOCUMENTS = 32`; rig batches through it
directly), so `LibsqlVectorStore::new(conn, &embedder)` works unchanged once
adopted.

Batch FFI calls run on tokio's blocking pool; construction is synchronous and
performs one short inference for the dimension probe.

## Linking

Same contract as every consumer of `cognee-litert-lm`:

- build/link time: `LITERT_LM_LIB_DIR=<repo>/cognee-litert-lm/native`
- run time: rpath to that dir — `RUSTFLAGS="-C link-arg=-Wl,-rpath,<dir>"`

`smoke.sh` sets both automatically. `cargo check`/`clippy` need no env;
anything that links (`test`, `build`, `run`) does.

## Layout

```
src/lib.rs        LitertEmbedder + EmbedderConfig + Error + EmbeddingModel impl
examples/smoke.rs headless evaluation harness (pairs / retrieval / latency)
smoke.sh          env-wiring wrapper around the example
```

## If adopted (decision checklist)

Replacing fastembed requires more than swapping the provider — recorded here
so the follow-up work is explicit:

1. Provider placement: inject into the `kawai-embedding` registry from the
   engine-linked side rather than making that crate depend on LiteRT.
2. Full re-index regardless of dimension match (different vector space);
   new schema migration dropping `rag_chunks*` tables + `rag_files` reset.
3. Model resolution + auto-download policy (pattern: `resolve_model_path`).
4. CI smoke gate with a cached fixture model; mobile checks re-enabled for
   `office` once `ort-sys` leaves the graph.
