//! A Rust client for the [JigsawStack](https://jigsawstack.com) API — an
//! idiomatic port of the Go client of the same name.
//!
//! It gives tools for working with the JigsawStack API.

pub mod audio;
pub mod geography;
pub mod natural_language;
pub mod prediction;
pub mod request;
pub mod sql;
pub mod visual;
pub mod web;

use std::fmt;

use reqwest::header;
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::request::Querier;

/// Default base URL for the JigsawStack API.
pub const DEFAULT_BASE_URL: &str = "https://api.jigsawstack.com";

/// Result alias for the crate's [`Error`] type.
pub type Result<T> = std::result::Result<T, Error>;

/// Error type for JigsawStack client operations.
#[derive(Debug)]
pub enum Error {
    /// Transport / HTTP layer error from reqwest.
    Http(reqwest::Error),
    /// The API returned a non-2xx status code.
    BadStatus { status: u16, body: String },
    /// A request body could not be encoded as JSON.
    Encode { source: serde_json::Error },
    /// The response body could not be decoded into the target type.
    Decode {
        source: serde_json::Error,
        body: String,
    },
    /// A provider (JigsawStack / Cloudflare / NVIDIA) rejected the request.
    Provider(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Http(e) => write!(f, "jigsawstack http error: {e}"),
            Error::BadStatus { status, body } => {
                write!(f, "jigsawstack bad status code: {status}\nbody: {body}")
            }
            Error::Encode { source } => write!(f, "jigsawstack failed to encode request: {source}"),
            Error::Decode { source, body } => {
                write!(f, "jigsawstack failed to decode response: {source}\nbody: {body}")
            }
            Error::Provider(msg) => write!(f, "jigsawstack provider error: {msg}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Http(e) => Some(e),
            Error::Encode { source } => Some(source),
            Error::Decode { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e)
    }
}

/// Client options for [`JigsawStack`], mirroring the functional options of the
/// Go client.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Base URL override. Defaults to [`DEFAULT_BASE_URL`].
    pub base_url: Option<String>,
    /// Custom HTTP client. Defaults to a plain `reqwest::Client`.
    pub client: Option<reqwest::Client>,
    /// Explicit API key. Defaults to the env-resolved key (see [`JigsawStack::new`]).
    pub api_key: Option<String>,
}

impl Options {
    /// Creates an empty option set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the base URL.
    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Sets a custom HTTP client.
    pub fn client(mut self, client: reqwest::Client) -> Self {
        self.client = Some(client);
        self
    }

    /// Sets the API key explicitly.
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }
}

/// A JigsawStack API client.
#[derive(Debug, Clone)]
pub struct JigsawStack {
    base_url: String,
    client: reqwest::Client,
    api_key: String,
}

impl Default for JigsawStack {
    fn default() -> Self {
        Self::new()
    }
}

impl JigsawStack {
    /// Creates a new client. The API key is resolved from `JIGSAWSTACK_API_KEY`
    /// or `JIGSAWSTACK_API_KEYS` (comma-separated, random pick).
    pub fn new() -> Self {
        Self::with_options(Options::new())
    }

    /// Creates a new client with the given options.
    pub fn with_options(opts: Options) -> Self {
        let base_url = opts.base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let client = opts.client.unwrap_or_default();
        let api_key = opts.api_key.unwrap_or_else(resolve_key);
        JigsawStack {
            base_url,
            client,
            api_key,
        }
    }

    /// Sends a request and returns the raw response bytes on success.
    async fn send_raw(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        query: Option<&dyn Querier>,
    ) -> Result<Vec<u8>> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self
            .client
            .request(method, &url)
            .header("x-api-key", &self.api_key)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json");
        if let Some(body) = body {
            req = req.json(&body);
        }
        if let Some(q) = query {
            let mut pairs = Vec::new();
            q.url_query(&mut pairs);
            if !pairs.is_empty() {
                req = req.query(&pairs);
            }
        }
        let resp = req.send().await?;
        let status = resp.status();
        let bytes = resp.bytes().await?.to_vec();
        if !status.is_success() {
            return Err(Error::BadStatus {
                status: status.as_u16(),
                body: String::from_utf8_lossy(&bytes).to_string(),
            });
        }
        Ok(bytes)
    }

    /// Sends a request and decodes the response as JSON.
    async fn send_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
        query: Option<&dyn Querier>,
    ) -> Result<T> {
        let bytes = self.send_raw(method, path, body, query).await?;
        serde_json::from_slice(&bytes).map_err(|source| Error::Decode {
            source,
            body: String::from_utf8_lossy(&bytes).to_string(),
        })
    }
}

/// Serializes a request body into JSON for sending.
pub(crate) fn to_json<T: Serialize>(body: &T) -> Result<serde_json::Value> {
    serde_json::to_value(body).map_err(|source| Error::Encode { source })
}

/// Resolves the JigsawStack API key from kawai-constants.
fn resolve_key() -> String {
    kawai_constants::jigsawstack::get_jigsawstack()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_key_works() {
        let key = resolve_key();
        assert!(!key.is_empty());
    }

    #[test]
    fn default_base_url() {
        let j = JigsawStack::new();
        assert_eq!(j.base_url, DEFAULT_BASE_URL);
    }
}
