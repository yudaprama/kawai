//! Text-to-SQL.

use reqwest::Method;
use serde::Deserialize;
use serde::Serialize;

use crate::{JigsawStack, Result, to_json};

/// Endpoint for the text-to-SQL API.
pub const TEXT_TO_SQL_ENDPOINT: &str = "/v1/ai/sql";

/// Response structure for the text-to-SQL API.
#[derive(Debug, Clone, Deserialize)]
pub struct TextToSQLResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The generated SQL.
    #[serde(rename = "sql")]
    pub sql: String,
}

#[derive(Serialize)]
struct Body<'a> {
    prompt: &'a str,
    sql_schema: &'a str,
}

impl JigsawStack {
    /// Converts text to SQL.
    ///
    /// Max text character is 5000.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/sql
    pub async fn text_to_sql(&self, prompt: &str, sql_schema: &str) -> Result<TextToSQLResponse> {
        let body = Body {
            prompt,
            sql_schema,
        };
        self.send_json(Method::POST, TEXT_TO_SQL_ENDPOINT, Some(to_json(&body)?), None)
            .await
    }
}
