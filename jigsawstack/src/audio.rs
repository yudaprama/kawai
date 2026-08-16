//! Text-to-speech (TTS) audio.

use reqwest::Method;
use serde::Serialize;

use crate::{JigsawStack, Result, to_json};

/// Endpoint for the text-to-speech API.
pub const TTS_ENDPOINT: &str = "/v1/ai/tts";

/// Options for a TTS request, mirroring the Go client's `TTSOption`s.
#[derive(Debug, Clone, Default)]
pub struct TtsOptions {
    /// Accent of the speaker voice to use.
    pub accent: Option<String>,
    /// URL of the speaker voice to use.
    pub speaker_url: Option<String>,
    /// File-store key of the speaker voice to use.
    pub file_key: Option<String>,
}

impl TtsOptions {
    /// Creates an empty option set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the accent of the speaker voice to use.
    pub fn accent(mut self, accent: impl Into<String>) -> Self {
        self.accent = Some(accent.into());
        self
    }

    /// Sets the URL of the speaker voice to use.
    pub fn speaker_url(mut self, url: impl Into<String>) -> Self {
        self.speaker_url = Some(url.into());
        self
    }

    /// Sets the file-store key of the speaker voice to use.
    pub fn file_key(mut self, key: impl Into<String>) -> Self {
        self.file_key = Some(key.into());
        self
    }
}

#[derive(Serialize)]
pub(crate) struct TtsBody<'a> {
    pub text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<&'a str>,
    #[serde(rename = "speaker_clone_url", skip_serializing_if = "Option::is_none")]
    pub speaker_url: Option<&'a str>,
    #[serde(rename = "speaker_clone_file_store_key", skip_serializing_if = "Option::is_none")]
    pub file_key: Option<&'a str>,
}

impl JigsawStack {
    /// Creates a text to speech (TTS) audio file.
    ///
    /// It only supports one option at a time, but does support no options.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/tts
    ///
    /// Unlike the Go client (which returns the MP3 bytes as a `string`), this
    /// returns the raw MP3 bytes as a `Vec<u8>`.
    pub async fn audio_tts(&self, text: &str, options: &TtsOptions) -> Result<Vec<u8>> {
        let body = TtsBody {
            text,
            accent: options.accent.as_deref(),
            speaker_url: options.speaker_url.as_deref(),
            file_key: options.file_key.as_deref(),
        };
        self.send_raw(Method::POST, TTS_ENDPOINT, Some(to_json(&body)?), None).await
        
    }
}
