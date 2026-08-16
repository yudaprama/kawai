//! Natural-language tools: sentiment, summarization, and translation.

use reqwest::Method;
use serde::Deserialize;
use serde::Serialize;

use crate::{JigsawStack, Result, to_json};

/// Endpoint for the sentiment analysis API.
pub const SENTIMENT_ENDPOINT: &str = "/v1/ai/sentiment";
/// Endpoint for the summarization API.
pub const SUMMARY_ENDPOINT: &str = "/v1/ai/summarize";
/// Endpoint for the translation API.
pub const TRANSLATE_ENDPOINT: &str = "/v1/ai/translate";

/// An emotion detected in text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Emotion {
    /// Anger.
    Anger,
    /// Fear.
    Fear,
    /// Sadness.
    Sadness,
    /// Happiness.
    Happiness,
    /// Anxiety.
    Anxiety,
    /// Disgust.
    Disgust,
    /// Embarrassment.
    Embarrassment,
    /// Love.
    Love,
    /// Surprise.
    Surprise,
    /// Shame.
    Shame,
    /// Envy.
    Envy,
    /// Satisfaction.
    Satisfaction,
    /// Self-confidence.
    #[serde(rename = "self-confidence")]
    SelfConfidence,
    /// Annoyance.
    Annoyance,
    /// Boredom.
    Boredom,
    /// Hatred.
    Hatred,
    /// Compassion.
    Compassion,
    /// Guilt.
    Guilt,
    /// Loneliness.
    Loneliness,
    /// Depression.
    Depression,
    /// Pride.
    Pride,
    /// Neutral.
    Neutral,
}

/// A language identifier.
pub type Language = String;

/// A sentiment detected for a single sentence.
#[derive(Debug, Clone, Deserialize)]
pub struct SentimentSentence {
    /// The sentence text.
    pub text: String,
    /// The detected emotion.
    pub emotion: Emotion,
    /// The sentiment label (e.g. positive / negative / neutral).
    pub sentiment: String,
    /// The sentiment score.
    pub score: f64,
}

/// The overall sentiment of the input text.
#[derive(Debug, Clone, Deserialize)]
pub struct Sentiment {
    /// The detected emotion.
    pub emotion: Emotion,
    /// The sentiment label (e.g. positive / negative / neutral).
    pub sentiment: String,
    /// The sentiment score.
    pub score: f64,
    /// Per-sentence sentiment breakdown.
    #[serde(default)]
    pub sentences: Vec<SentimentSentence>,
}

/// Response structure for the sentiment API.
#[derive(Debug, Clone, Deserialize)]
pub struct SentimentResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The sentiment result.
    pub sentiment: Sentiment,
}

/// Request structure for the summarization API.
#[derive(Debug, Clone, Serialize)]
pub struct SummaryRequest {
    /// The text to summarize.
    pub text: String,
}

/// Response structure for the summarization API.
#[derive(Debug, Clone, Deserialize)]
pub struct SummaryResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The generated summary.
    pub summary: String,
}

/// Request structure for the translation API.
#[derive(Debug, Clone, Serialize)]
pub struct TranslateRequest {
    /// The language the text is currently in.
    #[serde(rename = "current_language")]
    pub current_language: Language,
    /// The language to translate into.
    #[serde(rename = "target_language")]
    pub target_language: Language,
    /// The text to translate.
    pub text: String,
}

/// Response structure for the translation API.
#[derive(Debug, Clone, Deserialize)]
pub struct TranslateResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The translated text.
    #[serde(rename = "translated_text")]
    pub translated_text: String,
}

#[derive(Serialize)]
struct TextBody<'a> {
    text: &'a str,
}

impl JigsawStack {
    /// Performs a sentiment analysis over a string.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/sentiment
    pub async fn sentiment(&self, text: &str) -> Result<SentimentResponse> {
        let body = TextBody { text };
        self.send_json(Method::POST, SENTIMENT_ENDPOINT, Some(to_json(&body)?), None)
            .await
    }

    /// Summarizes the given text.
    ///
    /// Max text character is 5000.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/summarize
    pub async fn summarize(&self, request: &SummaryRequest) -> Result<SummaryResponse> {
        self.send_json(Method::POST, SUMMARY_ENDPOINT, Some(to_json(request)?), None)
            .await
    }

    /// Translates the text from the current language to the target language.
    ///
    /// Max text character is 5000.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/translate
    pub async fn translate(&self, request: &TranslateRequest) -> Result<TranslateResponse> {
        self.send_json(Method::POST, TRANSLATE_ENDPOINT, Some(to_json(request)?), None)
            .await
    }
}
