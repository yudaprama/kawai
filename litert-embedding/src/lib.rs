//! # litert-embedding
//!
//! Local text embedder over the LiteRT-LM embedding engine, implementing
//! rig-core's [`EmbeddingModel`] so it drops straight into any rig vector
//! store (e.g. `rig-libsql`'s `LibsqlVectorStore`).
//!
//! This is a **standalone evaluation crate** — nothing in kawai depends on it
//! yet. It exists to evaluate a LiteRT-based local embedder (e.g.
//! EmbeddingGemma `.litertlm` models) as a potential replacement for the
//! ONNX/fastembed fallback, which cannot compile on mobile targets
//! (`ort-sys` has no mobile prebuilts).
//!
//! ## Usage
//!
//! ```rust,no_run
//! use litert_embedding::LitertEmbedder;
//!
//! # async fn example() -> Result<(), litert_embedding::Error> {
//! let embedder = LitertEmbedder::new("/path/to/embedding-gemma-v2.litertlm")?;
//! let vectors = embedder.embed(vec!["hello world".into(), "halo dunia".into()]).await?;
//! println!("dim = {}", embedder.dimension());
//! # Ok(())
//! # }
//! ```
//!
//! ## Linking
//!
//! The LiteRT-LM dylib must be findable at build and run time (see README):
//! `LITERT_LM_LIB_DIR` points cargo at `cognee-litert-lm/native/`, and an
//! rpath (`RUSTFLAGS="-C link-arg=-Wl,-rpath,<same dir>"`) resolves it at
//! load time. The `smoke.sh` script wires both automatically.

use std::sync::Arc;

use cognee_litert_lm::{
    Backend, EmbeddingEngine, EmbeddingEngineSettings, EmbeddingOptions, InputKind,
};
use futures::future::BoxFuture;
use rig_core::embeddings::{Embedding, EmbeddingError, EmbeddingModel};
use tokio::task::spawn_blocking;

/// Upper bound on texts per FFI batch call; larger inputs are split into
/// sequential sub-batches to bound native memory per call.
const SUB_BATCH: usize = 32;
/// Short text used once at construction to probe the model's output dimension.
const DIM_PROBE_TEXT: &str = "dimension probe";

/// Errors raised by [`LitertEmbedder`].
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The embedding model file could not be loaded into an engine.
    #[error("embedding engine init failed: {0}")]
    Engine(String),
    /// An embedding computation failed.
    #[error("embedding computation failed: {0}")]
    Compute(String),
    /// A background blocking task panicked or was cancelled.
    #[error("blocking task failed: {0}")]
    Join(String),
}

impl From<cognee_litert_lm::Error> for Error {
    fn from(e: cognee_litert_lm::Error) -> Self {
        Error::Compute(e.to_string())
    }
}

/// Configuration for [`LitertEmbedder::with_config`].
pub struct EmbedderConfig {
    /// Compute backend for the embedding engine.
    pub backend: Backend,
    /// L2-normalize every output vector (default). With normalized vectors,
    /// dot product equals cosine similarity.
    pub normalize: bool,
    /// Insert special tokens (BOS/EOS) around inputs. Defaults to the C
    /// API's `false`.
    pub insert_special_tokens: bool,
    /// Optional cache directory handed to the engine for model artifacts.
    pub cache_dir: Option<String>,
}

impl Clone for EmbedderConfig {
    fn clone(&self) -> Self {
        // Upstream's `Backend` is neither Clone nor Debug; mirror by value.
        let backend = match &self.backend {
            Backend::Cpu => Backend::Cpu,
            Backend::Gpu => Backend::Gpu,
            Backend::Custom(s) => Backend::Custom(s.clone()),
        };
        Self {
            backend,
            normalize: self.normalize,
            insert_special_tokens: self.insert_special_tokens,
            cache_dir: self.cache_dir.clone(),
        }
    }
}

/// Stable display name for a backend (`"cpu"`, `"gpu"`, or the custom string).
pub fn backend_name(backend: &Backend) -> &str {
    match backend {
        Backend::Cpu => "cpu",
        Backend::Gpu => "gpu",
        Backend::Custom(s) => s.as_str(),
    }
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        Self {
            backend: Backend::Cpu,
            normalize: true,
            insert_special_tokens: false,
            cache_dir: None,
        }
    }
}

/// Local text embedder backed by the LiteRT-LM embedding engine.
///
/// Clone-cheap (`Arc` over the native engine); the native engine handle is
/// declared `Send + Sync` upstream. Batch FFI calls run on tokio's blocking
/// pool so callers can await from async contexts; construction is synchronous
/// and blocks for one short inference (the dimension probe).
#[derive(Clone)]
pub struct LitertEmbedder {
    engine: Arc<EmbeddingEngine>,
    dim: usize,
    normalize: bool,
    insert_special_tokens: bool,
}

impl LitertEmbedder {
    /// Creates an embedder with default config (CPU backend, L2-normalized).
    /// Loads the model and probes its output dimension with one inference;
    /// blocks until done.
    pub fn new(model_path: &str) -> Result<Self, Error> {
        Self::with_config(model_path, EmbedderConfig::default())
    }

    /// Creates an embedder with explicit configuration. Loads the model and
    /// probes its output dimension with one inference; blocks until done.
    pub fn with_config(model_path: &str, config: EmbedderConfig) -> Result<Self, Error> {
        let mut settings =
            EmbeddingEngineSettings::new(model_path, config.backend, None, None)
                .map_err(|e| Error::Engine(e.to_string()))?;
        if let Some(cache_dir) = &config.cache_dir {
            settings
                .set_cache_dir(cache_dir)
                .map_err(|e| Error::Engine(e.to_string()))?;
        }
        let engine = settings.build().map_err(|e| Error::Engine(e.to_string()))?;

        let embedder = Self {
            engine: Arc::new(engine),
            dim: 0,
            normalize: config.normalize,
            insert_special_tokens: config.insert_special_tokens,
        };
        let probe = embedder.compute_one(DIM_PROBE_TEXT)?;
        if probe.is_empty() {
            return Err(Error::Engine(
                "model returned a zero-dimension embedding on the dimension probe".into(),
            ));
        }
        Ok(Self {
            dim: probe.len(),
            ..embedder
        })
    }

    /// The embedding dimension reported by the loaded model.
    pub fn dimension(&self) -> usize {
        self.dim
    }

    /// Whether outputs are L2-normalized.
    pub fn normalized(&self) -> bool {
        self.normalize
    }

    /// Embeds each text, preserving order. Returns one vector per input.
    pub async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f64>>, Error> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(texts.len());
        for batch in texts.chunks(SUB_BATCH) {
            let batch: Vec<String> = batch.to_vec();
            let vectors = self.embed_batch_blocking(batch).await?;
            out.extend(vectors);
        }
        Ok(out)
    }
    /// Cosine similarity between two equal-length vectors. Returns 0.0 on
    /// mismatched lengths or zero magnitude.
    pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
        if a.len() != b.len() {
            return 0.0;
        }
        let mut dot = 0.0;
        let mut na = 0.0;
        let mut nb = 0.0;
        for (x, y) in a.iter().zip(b.iter()) {
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        if na == 0.0 || nb == 0.0 {
            return 0.0;
        }
        dot / (na.sqrt() * nb.sqrt())
    }

    /// Provider-style boxed-future entry point (mirrors kawai-embedding's
    /// `KawaiProvider::embed_strings` shape).
    pub fn embed_boxed<'a>(&'a self, texts: Vec<String>) -> EmbedFuture<'a> {
        Box::pin(async move { self.embed(texts).await })
    }

    async fn embed_batch_blocking(&self, texts: Vec<String>) -> Result<Vec<Vec<f64>>, Error> {
        let engine = Arc::clone(&self.engine);
        let normalize = self.normalize;
        let special = self.insert_special_tokens;
        spawn_blocking(move || {
            let options = make_options(normalize, special)?;
            let inputs: Vec<Vec<InputKind<'_>>> = texts
                .iter()
                .map(|t| vec![InputKind::Text(t.as_str())])
                .collect();
            let responses = engine
                .compute_embedding_batch(&inputs, Some(&options))
                .map_err(|e| Error::Compute(e.to_string()))?;

            let count = responses.size();
            let mut out = Vec::with_capacity(count);
            for i in 0..count {
                let resp = responses.get(i).map_err(|e| Error::Compute(e.to_string()))?;
                out.push(resp.values().iter().map(|v| *v as f64).collect());
            }
            if out.len() != texts.len() {
                return Err(Error::Compute(format!(
                    "batch size mismatch: sent {}, got {}",
                    texts.len(),
                    out.len()
                )));
            }
            Ok(out)
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    /// Synchronous single-text compute; used by the construction-time
    /// dimension probe.
    fn compute_one(&self, text: &str) -> Result<Vec<f64>, Error> {
        let options = make_options(self.normalize, self.insert_special_tokens)?;
        let response = self
            .engine
            .compute_embedding(&[InputKind::Text(text)], Some(&options))
            .map_err(|e| Error::Compute(e.to_string()))?;
        Ok(response.values().iter().map(|v| *v as f64).collect())
    }
}

type EmbedFuture<'a> = BoxFuture<'a, Result<Vec<Vec<f64>>, Error>>;

fn make_options(normalize: bool, insert_special_tokens: bool) -> Result<EmbeddingOptions, Error> {
    let mut options = EmbeddingOptions::new().map_err(|e| Error::Compute(e.to_string()))?;
    options.set_normalize(normalize);
    options.set_insert_special_tokens(insert_special_tokens);
    Ok(options)
}

impl EmbeddingModel for LitertEmbedder {
    const MAX_DOCUMENTS: usize = SUB_BATCH;

    // Construction needs a model path, which rig's client flow has no slot
    // for; the client IS the configured embedder, and `make` clones it. This
    // keeps vector-store usage (`LibsqlVectorStore::new(conn, &embedder)`,
    // `EmbeddingsBuilder::new(embedder)`) explicit about the model file.
    type Client = Self;

    fn make(client: &Self::Client, _model: impl Into<String>, _dims: Option<usize>) -> Self {
        client.clone()
    }

    fn ndims(&self) -> usize {
        self.dim
    }

    async fn embed_texts(
        &self,
        texts: impl IntoIterator<Item = String> + Send,
    ) -> Result<Vec<Embedding>, EmbeddingError> {
        let texts: Vec<String> = texts.into_iter().collect();
        let vectors = self
            .embed(texts.clone())
            .await
            .map_err(|e| EmbeddingError::ResponseError(e.to_string()))?;
        Ok(vectors
            .into_iter()
            .zip(texts)
            .map(|(vec, document)| Embedding { document, vec })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_matches_known_values() {
        assert!((LitertEmbedder::cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
        assert!((LitertEmbedder::cosine(&[1.0, 0.0], &[0.0, 1.0]) - 0.0).abs() < 1e-9);
        assert!((LitertEmbedder::cosine(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-9);
        assert_eq!(LitertEmbedder::cosine(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(LitertEmbedder::cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
    }

    #[test]
    fn cosine_is_scale_invariant() {
        let a = [3.0, 4.0];
        let b = [6.0, 8.0];
        assert!((LitertEmbedder::cosine(&a, &b) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn config_defaults_are_cpu_normalized() {
        let cfg = EmbedderConfig::default();
        assert!(matches!(cfg.backend, Backend::Cpu));
        assert!(cfg.normalize);
        assert!(!cfg.insert_special_tokens);
        assert!(cfg.cache_dir.is_none());
    }

    #[test]
    fn error_display_carries_message() {
        let e = Error::Engine("no such file".into());
        assert!(e.to_string().contains("no such file"));
    }

    #[test]
    fn sub_batch_is_sane() {
        const { assert!(SUB_BATCH > 0 && SUB_BATCH <= 1024) };
        assert_eq!(<LitertEmbedder as EmbeddingModel>::MAX_DOCUMENTS, SUB_BATCH);
    }
}
