//! TTS via Supertonic on MNN (multilingual, on-device, no phonemizer).
//!
//! Pure logic layer — no transport deps. Models live in
//! `~/.kawai/models/tts/supertonic/` and are auto-downloaded on first use
//! from HuggingFace (pinned revision, fp16, ~191 MB for v3).
//!
//! Default voice: `M1`. All voices: `M1`–`M5` (male), `F1`–`F5` (female).
//! Language is auto-detected per call (whatlang → supertonic lang tag).

use std::path::PathBuf;
use std::sync::LazyLock;

#[cfg(feature = "tts")]
use supertonic::SupertonicEngine;

/// Default voice (supertonic style name).
const DEFAULT_VOICE: &str = "M1";

/// Supertonic model version + precision (bump together with the pinned HF
/// revision in the supertonic crate + a parity re-check).
const MODEL_VERSION: &str = "v3";
const MODEL_PRECISION: &str = "fp16";

/// TTS error type.
#[derive(Debug)]
pub enum TtsError {
    ModelNotFound(String),
    DownloadFailed(String),
    InferenceFailed(String),
    FeatureDisabled,
}

impl std::fmt::Display for TtsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ModelNotFound(msg) => write!(f, "model not found: {msg}"),
            Self::DownloadFailed(msg) => write!(f, "download failed: {msg}"),
            Self::InferenceFailed(msg) => write!(f, "inference failed: {msg}"),
            Self::FeatureDisabled => write!(f, "TTS feature not enabled (build with --features tts)"),
        }
    }
}

impl std::error::Error for TtsError {}

/// Return the TTS model directory (`~/.kawai/models/tts/supertonic/`).
fn tts_model_dir() -> Result<PathBuf, TtsError> {
    kawai_paths::tts_model_dir()
        .map(|dir| dir.join("supertonic"))
        .ok_or_else(|| TtsError::ModelNotFound("HOME not set".into()))
}

/// Convert f32 PCM samples to WAV bytes.
pub fn pcm_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * num_channels as u32 * bits_per_sample as u32 / 8;
    let block_align = num_channels * bits_per_sample / 8;
    let data_size = (samples.len() * 2) as u32;
    let file_size = 36 + data_size;

    let mut wav = Vec::with_capacity(44 + samples.len() * 2);

    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&file_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");

    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());

    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());

    for &sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = (clamped * 32767.0) as i16;
        wav.extend_from_slice(&value.to_le_bytes());
    }

    wav
}

// ── Supertonic engine cache (feature ON) ───────────────────────────────────

#[cfg(feature = "tts")]
mod inner {
    use super::*;

    struct CachedEngine {
        voice: String,
        engine: SupertonicEngine,
    }

    /// One loaded engine (voice pinned at load); voice changes reload it.
    /// The engine is CPU-heavy inference state — all access happens on a
    /// blocking thread under this mutex.
    static ENGINE: LazyLock<std::sync::Mutex<Option<CachedEngine>>> =
        LazyLock::new(|| std::sync::Mutex::new(None));

    /// Synthesize speech from text. Returns `(pcm_samples, sample_rate)`.
    pub async fn synthesize_impl(
        text: &str,
        voice: Option<&str>,
        length_scale: Option<f32>,
    ) -> Result<(Vec<f32>, u32), TtsError> {
        let voice = voice.unwrap_or(DEFAULT_VOICE).to_string();
        let dir = tts_model_dir()?;

        supertonic::ensure_models(&dir, MODEL_VERSION, MODEL_PRECISION, &voice)
            .await
            .map_err(|e| match e {
                supertonic::SupertonicError::DownloadFailed(msg) => {
                    TtsError::DownloadFailed(msg)
                }
                other => TtsError::ModelNotFound(other.to_string()),
            })?;

        // `length_scale` semantics: higher = slower. The engine's speed
        // factor DIVIDES the predicted duration, so it maps inversely.
        let speed = length_scale.map_or(1.0, |ls| 1.0 / ls.max(1e-3));
        let text = text.to_string();

        tokio::task::spawn_blocking(move || {
            let mut guard = ENGINE
                .lock()
                .map_err(|e| TtsError::InferenceFailed(format!("engine lock: {e}")))?;

            let engine = match guard.as_mut() {
                Some(cached) if cached.voice == voice => &mut cached.engine,
                _ => {
                    eprintln!("[tts] loading supertonic {MODEL_VERSION}/{MODEL_PRECISION} voice {voice}");
                    let engine = SupertonicEngine::load(&dir, MODEL_VERSION, MODEL_PRECISION, &voice)
                        .map_err(|e| TtsError::InferenceFailed(e.to_string()))?;
                    *guard = Some(CachedEngine {
                        voice: voice.to_string(),
                        engine,
                    });
                    eprintln!("[tts] supertonic engine ready");
                    &mut guard.as_mut().expect("just inserted").engine
                }
            };
            engine.steps = 5;
            engine.speed = speed;

            let lang = supertonic::detect_lang(&text);
            let sample_rate = engine.sample_rate();
            let samples = engine
                .synthesize(&text, lang)
                .map_err(|e| TtsError::InferenceFailed(e.to_string()))?;
            Ok((samples, sample_rate))
        })
        .await
        .map_err(|e| TtsError::InferenceFailed(format!("synthesis task: {e}")))?
    }
}

#[cfg(feature = "tts")]
pub use inner::synthesize_impl;

/// Synthesize speech from text. Returns `(pcm_samples, sample_rate)`.
///
/// - `text`: the text to synthesize (language auto-detected)
/// - `voice`: supertonic voice id `M1`–`F5` (None = `M1`)
/// - `length_scale`: speech speed (1.0 = normal, <1.0 = faster, >1.0 =
///   slower)
#[cfg(feature = "tts")]
pub async fn synthesize(
    text: &str,
    voice: Option<&str>,
    length_scale: Option<f32>,
) -> Result<(Vec<f32>, u32), TtsError> {
    synthesize_impl(text, voice, length_scale).await
}

// ── Feature OFF: stub that returns an error ────────────────────────────────

#[cfg(not(feature = "tts"))]
async fn synthesize_impl(
    _text: &str,
    _voice: Option<&str>,
    _length_scale: Option<f32>,
) -> Result<(Vec<f32>, u32), TtsError> {
    Err(TtsError::FeatureDisabled)
}

#[cfg(not(feature = "tts"))]
pub async fn synthesize(
    text: &str,
    voice: Option<&str>,
    length_scale: Option<f32>,
) -> Result<(Vec<f32>, u32), TtsError> {
    synthesize_impl(text, voice, length_scale).await
}
