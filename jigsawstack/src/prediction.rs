//! Time-series prediction.

use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::Deserialize;
use serde::Serialize;

use crate::{JigsawStack, Result, to_json};

/// Endpoint for the prediction API.
///
/// Note: the Go client hardcodes this without a leading slash
/// (`"v1/ai/prediction"`), which forms an invalid URL; the Rust client uses
/// the correct path.
pub const PREDICT_ENDPOINT: &str = "/v1/ai/prediction";

/// A single entry in a time-series dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetEntry {
    /// The date of the entry (RFC 3339).
    pub date: DateTime<Utc>,
    /// The value of the entry.
    pub value: f64,
}

/// Response structure for the prediction API.
#[derive(Debug, Clone, Deserialize)]
pub struct PredictResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The predicted future values.
    #[serde(default)]
    pub answer: Vec<DatasetEntry>,
}

#[derive(Serialize)]
struct Body<'a> {
    dataset: &'a [DatasetEntry],
}

impl JigsawStack {
    /// Predicts the future values of a dataset.
    ///
    /// Max text character is 5000.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/prediction
    pub async fn predict(&self, dataset: &[DatasetEntry]) -> Result<PredictResponse> {
        let body = Body { dataset };
        self.send_json(Method::POST, PREDICT_ENDPOINT, Some(to_json(&body)?), None)
            .await
    }
}
