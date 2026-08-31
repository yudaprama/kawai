//! TTS via piper-rs (neural Piper ONNX models).
//!
//! Pure logic layer — no transport deps. Models live in `~/.kawai/models/tts/`
//! and are auto-downloaded on first use from HuggingFace.
//!
//! Default voice: `en_US-libritts_r-medium` (~60 MB onnx + json config).
//! All pretrained models: <https://huggingface.co/rhasspy/piper-voices>

use std::path::PathBuf;

/// Default voice id (matches huggingface.co/rhasspy/piper-voices directory layout).
const DEFAULT_VOICE: &str = "en_US-libritts_r-medium";

/// HuggingFace Piper voices base URL.
const VOICES_BASE_URL: &str = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

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

/// Return the TTS model directory (`~/.kawai/models/tts/`).
fn tts_model_dir() -> Result<PathBuf, TtsError> {
    let home =
        std::env::var("HOME").map_err(|_| TtsError::ModelNotFound("HOME not set".into()))?;
    Ok(PathBuf::from(home).join(".kawai/models/tts"))
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
        let i16_sample = (clamped * 32767.0) as i16;
        wav.extend_from_slice(&i16_sample.to_le_bytes());
    }

    wav
}

// ── Feature ON: piper-rs neural TTS ────────────────────────────────────────

#[cfg(feature = "tts")]
mod inner {
    use super::*;
    use std::sync::OnceLock;
    use piper_rs::Piper;

    /// Cached Piper instance (loaded once, reused across calls).
    static PIPER: OnceLock<tokio::sync::Mutex<Option<Piper>>> = OnceLock::new();

    /// Resolve paths for a voice: `.onnx` model + `.onnx.json` config.
    fn resolve_voice_paths(voice: &str) -> Result<(PathBuf, PathBuf), TtsError> {
        let dir = tts_model_dir()?;
        let onnx = dir.join(format!("{voice}.onnx"));
        let config = dir.join(format!("{voice}.onnx.json"));
        if onnx.exists() && config.exists() {
            Ok((onnx, config))
        } else {
            Err(TtsError::ModelNotFound(format!(
                "voice '{voice}' not found in {}",
                dir.display()
            )))
        }
    }

    /// Download a single file from HuggingFace with resume support and progress logging.
    async fn download_file(url: &str, dest: &std::path::Path, label: &str) -> Result<(), TtsError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| TtsError::DownloadFailed(format!("reqwest client: {e}")))?;

        let tmp = dest.with_extension("part");
        let existing_size = std::fs::metadata(&tmp)
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        let response = if existing_size > 0 {
            eprintln!("[tts] resuming {label} download ({:.1} MB done)", existing_size as f64 / 1e6);
            client
                .get(url)
                .header("Range", format!("bytes={}-", existing_size))
                .send()
                .await
                .map_err(|e| TtsError::DownloadFailed(format!("http (resume): {e}")))?
        } else {
            client
                .get(url)
                .send()
                .await
                .map_err(|e| TtsError::DownloadFailed(format!("http: {e}")))?
        };

        if !response.status().is_success() && response.status().as_u16() != 206 {
            return Err(TtsError::DownloadFailed(format!(
                "HTTP {} for {url}",
                response.status()
            )));
        }

        let total_size = existing_size + response.content_length().unwrap_or(0);
        eprintln!(
            "[tts] downloading {label} ({:.1} MB) ...",
            total_size as f64 / 1e6
        );

        use futures_util::StreamExt;
        use std::io::Write;

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(existing_size > 0)
            .write(true)
            .open(&tmp)
            .map_err(|e| TtsError::DownloadFailed(format!("open tmp: {e}")))?;

        let mut stream = response.bytes_stream();
        let mut downloaded = existing_size;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| TtsError::DownloadFailed(format!("chunk: {e}")))?;
            file.write_all(&chunk)
                .map_err(|e| TtsError::DownloadFailed(format!("write: {e}")))?;
            downloaded += chunk.len() as u64;

            let prev_mb = (downloaded - chunk.len() as u64) / 5_000_000;
            let cur_mb = downloaded / 5_000_000;
            if cur_mb > prev_mb && total_size > 0 {
                let pct = downloaded as f64 / total_size as f64 * 100.0;
                eprintln!(
                    "[tts] {label}: {:.1}/{:.1} MB ({:.0}%)",
                    downloaded as f64 / 1e6,
                    total_size as f64 / 1e6,
                    pct
                );
            }
        }

        std::fs::rename(&tmp, dest)
            .map_err(|e| TtsError::DownloadFailed(format!("rename: {e}")))?;

        eprintln!("[tts] {label} download complete: {}", dest.display());
        Ok(())
    }

    /// Ensure the voice model is downloaded.
    async fn ensure_voice(voice: &str) -> Result<(PathBuf, PathBuf), TtsError> {
        if let Ok(paths) = resolve_voice_paths(voice) {
            return Ok(paths);
        }

        let dir = tts_model_dir()?;
        std::fs::create_dir_all(&dir)
            .map_err(|e| TtsError::DownloadFailed(format!("create dir: {e}")))?;

        let onnx_url = format!("{VOICES_BASE_URL}/{voice}.onnx");
        let config_url = format!("{VOICES_BASE_URL}/{voice}.onnx.json");

        let onnx_path = dir.join(format!("{voice}.onnx"));
        let config_path = dir.join(format!("{voice}.onnx.json"));

        download_file(&config_url, &config_path, &format!("{voice}.onnx.json")).await?;
        download_file(&onnx_url, &onnx_path, &format!("{voice}.onnx")).await?;

        resolve_voice_paths(voice)
    }

    /// Load or get the cached Piper instance.
    async fn get_piper(voice: &str) -> Result<tokio::sync::MutexGuard<'static, Option<Piper>>, TtsError> {
        let cell = PIPER.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut guard = cell.lock().await;

        if guard.is_some() {
            return Ok(guard);
        }

        let (onnx_path, config_path) = ensure_voice(voice).await?;
        eprintln!("[tts] loading model: {}", onnx_path.display());

        let piper = Piper::new(&onnx_path, &config_path)
            .map_err(|e| TtsError::InferenceFailed(format!("load model: {e}")))?;

        *guard = Some(piper);
        eprintln!("[tts] model loaded");
        Ok(guard)
    }

    /// Synthesize speech from text. Returns `(pcm_samples, sample_rate)`.
    pub async fn synthesize_impl(
        text: &str,
        voice: Option<&str>,
        length_scale: Option<f32>,
    ) -> Result<(Vec<f32>, u32), TtsError> {
        let voice = voice.unwrap_or(DEFAULT_VOICE);
        let mut guard = get_piper(voice).await?;
        let piper = guard
            .as_mut()
            .ok_or_else(|| TtsError::InferenceFailed("model not loaded".into()))?;

        let (samples, sample_rate) = piper
            .create(text, false, None, length_scale, None, None)
            .map_err(|e| TtsError::InferenceFailed(format!("synthesis: {e}")))?;

        Ok((samples, sample_rate))
    }
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

/// Synthesize speech from text. Returns `(pcm_samples, sample_rate)`.
///
/// - `text`: the text to synthesize
/// - `voice`: voice id (None = DEFAULT_VOICE)
/// - `length_scale`: speech speed (1.0 = normal, <1.0 = faster, >1.0 = slower)
#[cfg(feature = "tts")]
pub async fn synthesize(
    text: &str,
    voice: Option<&str>,
    length_scale: Option<f32>,
) -> Result<(Vec<f32>, u32), TtsError> {
    inner::synthesize_impl(text, voice, length_scale).await
}

#[cfg(not(feature = "tts"))]
pub async fn synthesize(
    text: &str,
    voice: Option<&str>,
    length_scale: Option<f32>,
) -> Result<(Vec<f32>, u32), TtsError> {
    synthesize_impl(text, voice, length_scale).await
}
