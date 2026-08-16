//! Web tools.

use reqwest::Method;
use serde::Deserialize;

use crate::request::Querier;
use crate::{JigsawStack, Result};

/// Endpoint for the web search suggestions API.
pub const WEB_SUGGEST_ENDPOINT: &str = "/v1/web/search/suggest";

/// Response structure for the web search suggestions API.
#[derive(Debug, Clone, Deserialize)]
pub struct WebSearchSuggestions {
    /// Whether the request succeeded.
    pub success: bool,
    /// The suggested search terms.
    #[serde(default)]
    pub suggestions: Vec<String>,
}

impl JigsawStack {
    /// Performs a web search suggestions call over a query string.
    ///
    /// GET https://api.jigsawstack.com/v1/web/search/suggest
    pub async fn web_search_suggestions(&self, query: &str) -> Result<WebSearchSuggestions> {
        struct QueryParam<'a>(&'a str);

        impl Querier for QueryParam<'_> {
            fn url_query(&self, out: &mut Vec<(String, String)>) {
                out.push(("query".to_string(), self.0.to_string()));
            }
        }

        self.send_json(Method::GET, WEB_SUGGEST_ENDPOINT, None, Some(&QueryParam(query)))
            .await
    }
}
