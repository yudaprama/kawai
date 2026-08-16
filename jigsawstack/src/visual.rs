//! Vision tools: visual OCR, object detection, and image generation (with an
//! automatic fallback chain across JigsawStack, Cloudflare Workers AI, and
//! NVIDIA).

use std::env;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use log::warn;
use rand::prelude::IndexedRandom;
use reqwest::Method;
use serde::Deserialize;
use serde::Serialize;

use crate::{Error, JigsawStack, Result, to_json};

/// Endpoint for the visual OCR API.
pub const VOCR_ENDPOINT: &str = "/v1/vocr";
/// Endpoint for the object detection API.
pub const OBJECT_DETECTION_ENDPOINT: &str = "/v1/ai/object_detection";
/// Endpoint for the image generation API.
pub const IMAGE_GENERATION_ENDPOINT: &str = "/v1/ai/image_generation";

/// Base URL for NVIDIA's hosted visual-gen NIMs. Each model is served at
/// `/v1/genai/{org}/{model}` (note the dot in the slug, e.g.
/// `black-forest-labs/flux.1-dev`, NOT `flux1-dev`). The response is
/// `{"artifacts":[{"base64":"..."}]}`, unlike JigsawStack's `{"image":"..."}`.
const NVIDIA_IMAGE_BASE_URL: &str = "https://ai.api.nvidia.com/v1/genai";

/// The only width/height values NVIDIA's flux.1-dev accepts.
const NVIDIA_ALLOWED_DIMS: [u32; 10] = [768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344];

/// Default NVIDIA image model when `NVIDIA_IMAGE_MODEL` is unset.
const NVIDIA_DEFAULT_IMAGE_MODEL: &str = "black-forest-labs/flux.1-dev";

/// Base URL for Cloudflare's Workers AI REST API. Each model is served at
/// `/client/v4/accounts/{account_id}/ai/run/{model}`. Image models return the
/// PNG body directly (Content-Type: image/png); the JSON envelope
/// `{"result":{"image":"<base64>"}}` is handled too as a defensive path.
const CLOUDFLARE_AI_RUN_BASE_URL: &str = "https://api.cloudflare.com/client/v4/accounts";

/// Default Workers AI text-to-image model when `CLOUDFLARE_IMAGE_MODEL` is
/// unset. Alternatives:
/// - `@cf/bytedance/stable-diffusion-xl-lightning` (faster)
/// - `@cf/lykon/dreamshaper-8-lcm`
/// - `@cf/blackforestlabs/flux-1-schnell`
const CLOUDFLARE_DEFAULT_IMAGE_MODEL: &str = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

/// Request structure for the image generation API.
///
/// The model to use for the generation. Default is `sdxl`:
/// - `sd1.5` - Stable Diffusion v1.5
/// - `sdxl` - Stable Diffusion XL
/// - `ead1.0` - Anime Diffusion
/// - `rv1.3` - Realistic Vision v1.3
/// - `rv3` - Realistic Vision v3
/// - `rv5.1` - Realistic Vision v5.1
/// - `ar1.8` - AbsoluteReality v1.8.1
#[derive(Debug, Clone, Serialize)]
pub struct ImageGenerationRequest {
    /// The prompt describing the image to generate.
    pub prompt: String,
    /// The model to use. Defaults to `sdxl` when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The output size.
    pub size: String,
    /// The output width.
    pub width: u32,
    /// The output height.
    pub height: u32,
}

impl ImageGenerationRequest {
    /// Creates a request for the given prompt.
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            model: None,
            size: String::new(),
            width: 0,
            height: 0,
        }
    }

    /// Sets the model (e.g. `sdxl`).
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Sets the output size.
    pub fn size(mut self, size: impl Into<String>) -> Self {
        self.size = size.into();
        self
    }

    /// Sets the output dimensions.
    pub fn dimensions(mut self, width: u32, height: u32) -> Self {
        self.width = width;
        self.height = height;
        self
    }
}

/// Response structure for the image generation API.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageGenerationResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The generated image as base64 or a data URI.
    pub image: String,
}

/// A request to run a vision task (VOCR / object detection) against an image.
#[derive(Debug, Clone, Default)]
pub struct VisionRequest {
    /// The prompt used in OCR. Not required for object detection.
    pub prompt: Option<String>,
    /// The URL of the image to use. The JigsawStack API field is `url` (not
    /// `image_url`); using the wrong name yields 400
    /// "Either url or file_store_key is required".
    pub url: Option<String>,
    /// The file-store key of the file to use as the image.
    pub file_key: Option<String>,
}

impl VisionRequest {
    /// Builds a vision request for an image URL.
    pub fn from_url(url: impl Into<String>) -> Self {
        Self {
            url: Some(url.into()),
            ..Default::default()
        }
    }

    /// Sets the prompt to use.
    pub fn prompt(mut self, prompt: impl Into<String>) -> Self {
        self.prompt = Some(prompt.into());
        self
    }

    /// Sets the URL of the image to use.
    pub fn url(mut self, url: impl Into<String>) -> Self {
        self.url = Some(url.into());
        self
    }

    /// Sets the file-store key of the file to use as the image.
    pub fn file_key(mut self, key: impl Into<String>) -> Self {
        self.file_key = Some(key.into());
        self
    }
}

#[derive(Serialize)]
struct VisionRequestBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<&'a str>,
    #[serde(rename = "url", skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(rename = "file_store_key", skip_serializing_if = "Option::is_none")]
    file_key: Option<&'a str>,
}

/// Response structure for the visual OCR API.
#[derive(Debug, Clone, Deserialize)]
pub struct VOCRResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The context of the image.
    pub context: String,
    /// The width of the image.
    pub width: u32,
    /// The height of the image.
    pub height: u32,
    /// The tags detected in the image.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Whether the image contains text.
    #[serde(default)]
    pub has_text: bool,
    /// The sections detected in the image.
    #[serde(default)]
    pub sections: Vec<serde_json::Value>,
}

/// A point in image pixel coordinates.
#[derive(Debug, Clone, Deserialize)]
pub struct Point {
    /// The x coordinate.
    pub x: i32,
    /// The y coordinate.
    pub y: i32,
}

/// The bounding box of a detected object.
#[derive(Debug, Clone, Deserialize)]
pub struct Bounds {
    /// The top-left corner.
    pub top_left: Point,
    /// The top-right corner.
    pub top_right: Point,
    /// The bottom-right corner.
    pub bottom_right: Point,
    /// The bottom-left corner.
    pub bottom_left: Point,
    /// The box width.
    pub width: u32,
    /// The box height.
    pub height: u32,
}

/// A single detected object.
#[derive(Debug, Clone, Deserialize)]
pub struct DetectedObject {
    /// The object name.
    pub name: String,
    /// The detection confidence.
    pub confidence: f64,
    /// The bounding box.
    pub bounds: Bounds,
}

/// Response structure for the object detection API.
#[derive(Debug, Clone, Deserialize)]
pub struct VisionObjectResponse {
    /// Whether the request succeeded.
    pub success: bool,
    /// The width of the image.
    pub width: u32,
    /// The height of the image.
    pub height: u32,
    /// The tags detected in the image.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The detected objects.
    #[serde(default)]
    pub objects: Vec<DetectedObject>,
}

/// Resolves the NVIDIA key from `NVIDIA_API_KEY`, or a randomly chosen entry of
/// the comma-separated `NVIDIA_API_KEYS` (to spread load across keys).
/// `NVIDIA_API_KEY` takes precedence over `NVIDIA_API_KEYS`.
fn nvidia_api_key() -> Option<String> {
    if let Ok(v) = env::var("NVIDIA_API_KEY") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    pick_env_key("NVIDIA_API_KEYS")
}

/// Picks a random non-empty entry from a comma-separated env var.
fn pick_env_key(var: &str) -> Option<String> {
    let v = env::var(var).ok()?;
    let keys: Vec<String> = v
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if keys.is_empty() {
        return None;
    }
    keys.choose(&mut rand::rng()).cloned()
}

/// One `account_id:api_key` pair for the Cloudflare fallback.
#[derive(Debug, Clone)]
struct CfCredential {
    account_id: String,
    token: String,
}

/// Splits a `accountID:token` entry on the first colon. Whitespace is trimmed.
/// Returns `None` if the entry has no colon or an empty side.
fn parse_cf_pair(entry: &str) -> Option<CfCredential> {
    let entry = entry.trim();
    let idx = entry.find(':')?;
    if idx == 0 || idx == entry.len() - 1 {
        return None;
    }
    let account_id = entry[..idx].trim();
    let token = entry[idx + 1..].trim();
    if account_id.is_empty() || token.is_empty() {
        return None;
    }
    Some(CfCredential {
        account_id: account_id.to_string(),
        token: token.to_string(),
    })
}

/// Resolves a Cloudflare `account_id:api_key` pair. Precedence:
/// 1. `CLOUDFLARE_API_KEY` — a single `accountID:token` pair. For backward
///    compatibility a bare token (no colon) is paired with the standalone
///    `CLOUDFLARE_ACCOUNT_ID` env var if present.
/// 2. `CLOUDFLARE_API_KEYS` — comma-separated `accountID:token` pairs; one is
///    chosen at random per call to spread load across accounts (each account
///    carries its own Workers AI free-tier quota).
fn cloudflare_credential() -> Option<CfCredential> {
    if let Ok(raw) = env::var("CLOUDFLARE_API_KEY") {
        if !raw.is_empty() {
            if let Some(c) = parse_cf_pair(&raw) {
                return Some(c);
            }
            if let Ok(acct) = env::var("CLOUDFLARE_ACCOUNT_ID") {
                if !acct.is_empty() {
                    return Some(CfCredential {
                        account_id: acct,
                        token: raw.trim().to_string(),
                    });
                }
            }
        }
    }
    let raw = env::var("CLOUDFLARE_API_KEYS").ok()?;
    let pairs: Vec<CfCredential> = raw
        .split(',')
        .filter_map(parse_cf_pair)
        .collect();
    if pairs.is_empty() {
        return None;
    }
    pairs.choose(&mut rand::rng()).cloned()
}

/// Reports whether the Cloudflare fallback can run.
fn cloudflare_image_configured() -> bool {
    cloudflare_credential().is_some()
}

/// Rounds `d` to the nearest dimension NVIDIA's flux.1-dev accepts.
fn snap_nvidia_dim(d: u32) -> u32 {
    let mut best = NVIDIA_ALLOWED_DIMS[0];
    for &v in &NVIDIA_ALLOWED_DIMS {
        if d.abs_diff(v) < d.abs_diff(best) {
            best = v;
        }
    }
    best
}

/// Caps `s` to `max` chars for safe inclusion in error messages.
fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push_str("...");
        out
    }
}

impl JigsawStack {
    /// Performs a visual object recognition (VOCR) task on an image.
    ///
    /// POST https://api.jigsawstack.com/v1/vocr
    ///
    /// Unlike the Go client (which returns the response as a JSON string), this
    /// returns the typed [`VOCRResponse`].
    pub async fn vocr(&self, prompt: &str, request: &VisionRequest) -> Result<VOCRResponse> {
        let body = VisionRequestBody {
            prompt: Some(prompt),
            url: request.url.as_deref(),
            file_key: request.file_key.as_deref(),
        };
        self.send_json(Method::POST, VOCR_ENDPOINT, Some(to_json(&body)?), None)
            .await
    }

    /// Performs a visual object detection (VOD) task on an image.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/object_detection
    ///
    /// Unlike the Go client (which returns the response as a JSON string), this
    /// returns the typed [`VisionObjectResponse`].
    pub async fn vision_object_detection(
        &self,
        request: &VisionRequest,
    ) -> Result<VisionObjectResponse> {
        let body = VisionRequestBody {
            prompt: request.prompt.as_deref(),
            url: request.url.as_deref(),
            file_key: request.file_key.as_deref(),
        };
        self.send_json(Method::POST, OBJECT_DETECTION_ENDPOINT, Some(to_json(&body)?), None)
            .await
    }

    /// Generates an image from a prompt and parameters.
    ///
    /// POST https://api.jigsawstack.com/v1/ai/image_generation
    pub async fn image_generation(
        &self,
        request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationResponse> {
        self.send_json(Method::POST, IMAGE_GENERATION_ENDPOINT, Some(to_json(request)?), None)
            .await
    }

    /// Generates an image with an automatic fallback chain. Tries JigsawStack
    /// first, then Cloudflare Workers AI (generous free tier), then NVIDIA's
    /// hosted image-generation NIM. The first provider that returns a usable
    /// image wins; each subsequent provider is tried only if the previous one
    /// was unconfigured or errored. This keeps `image_generation` working even
    /// when the JigsawStack key is missing or the request fails.
    pub async fn image_generation_fallback(
        &self,
        request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationResponse> {
        // 1. JigsawStack primer.
        match self.image_generation(request).await {
            Ok(resp) => return Ok(resp),
            Err(err) => warn!(
                "jigsawstack image generation failed; trying fallbacks: error={err:?}, prompt={}",
                request.prompt
            ),
        }

        // 2. Cloudflare Workers AI REST API (free tier before paid NVIDIA).
        //    Skipped silently when CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN
        //    are not set.
        if cloudflare_image_configured() {
            match self.image_generation_cloudflare(request).await {
                Ok(resp) => return Ok(resp),
                Err(err) => warn!(
                    "cloudflare image fallback failed; falling back to nvidia: error={err:?}, prompt={}",
                    request.prompt
                ),
            }
        }

        // 3. NVIDIA NIM (paid, highest quality) — last resort.
        self.image_generation_nvidia(request).await
    }

    /// Calls NVIDIA's hosted FLUX/SD image NIM. The decoded result is returned
    /// as an [`ImageGenerationResponse`] (image as a data URI) so it is
    /// interchangeable with the JigsawStack path.
    async fn image_generation_nvidia(
        &self,
        request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationResponse> {
        let Some(api_key) = nvidia_api_key() else {
            return Err(Error::Provider(
                "nvidia image fallback unavailable: NVIDIA_API_KEY/NVIDIA_API_KEYS not set"
                    .to_string(),
            ));
        };
        let model = env::var("NVIDIA_IMAGE_MODEL")
            .unwrap_or_else(|_| NVIDIA_DEFAULT_IMAGE_MODEL.to_string());

        let mut body = serde_json::json!({
            "prompt": request.prompt,
            "seed": 0,
            "steps": 30,
        });
        // flux.1-dev only accepts the fixed dimension set in NVIDIA_ALLOWED_DIMS
        // and 422s on anything else (e.g. 512), which would surface to the
        // caller as a 502. Snap to the nearest allowed value instead of
        // forwarding an invalid size, so any dimension the caller requests
        // works through this fallback.
        if request.width > 0 {
            body["width"] = serde_json::json!(snap_nvidia_dim(request.width));
        }
        if request.height > 0 {
            body["height"] = serde_json::json!(snap_nvidia_dim(request.height));
        }

        let url = format!("{NVIDIA_IMAGE_BASE_URL}/{model}");
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let bytes = resp.bytes().await?.to_vec();
        if !status.is_success() {
            return Err(Error::BadStatus {
                status: status.as_u16(),
                body: truncate_str(&String::from_utf8_lossy(&bytes), 500),
            });
        }

        #[derive(Deserialize)]
        struct NvidiaResponse {
            #[serde(default)]
            artifacts: Vec<NvidiaArtifact>,
        }
        #[derive(Deserialize)]
        struct NvidiaArtifact {
            #[serde(default)]
            base64: String,
        }

        let parsed: NvidiaResponse = serde_json::from_slice(&bytes).map_err(|source| {
            Error::Decode {
                source,
                body: truncate_str(&String::from_utf8_lossy(&bytes), 500),
            }
        })?;
        let base64 = parsed
            .artifacts
            .first()
            .map(|a| a.base64.clone())
            .filter(|b| !b.is_empty())
            .ok_or_else(|| Error::Provider("nvidia returned no image artifacts".to_string()))?;

        Ok(ImageGenerationResponse {
            success: true,
            image: format!("data:image/jpeg;base64,{base64}"),
        })
    }

    /// Calls Cloudflare's Workers AI REST API. The returned image (raw PNG
    /// bytes in the common case, or a base64 string inside the JSON envelope)
    /// is normalized to an [`ImageGenerationResponse`] with `image` as a
    /// `data:image/png;base64,...` URI, so it is interchangeable with the
    /// JigsawStack and NVIDIA paths.
    async fn image_generation_cloudflare(
        &self,
        request: &ImageGenerationRequest,
    ) -> Result<ImageGenerationResponse> {
        let Some(cred) = cloudflare_credential() else {
            return Err(Error::Provider(
                "cloudflare image fallback unavailable: CLOUDFLARE_API_KEY(S) not set (expect accountID:token pairs)"
                    .to_string(),
            ));
        };
        let model = env::var("CLOUDFLARE_IMAGE_MODEL")
            .unwrap_or_else(|_| CLOUDFLARE_DEFAULT_IMAGE_MODEL.to_string());

        let payload = serde_json::json!({ "prompt": request.prompt });
        let url = format!("{CLOUDFLARE_AI_RUN_BASE_URL}/{}/ai/run/{model}", cred.account_id);
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&cred.token)
            .json(&payload)
            .send()
            .await?;
        let status = resp.status();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let bytes = resp.bytes().await?.to_vec();
        if !status.is_success() {
            return Err(Error::BadStatus {
                status: status.as_u16(),
                body: truncate_str(&String::from_utf8_lossy(&bytes), 500),
            });
        }

        // Common case: image models stream raw image bytes back (image/png).
        if content_type.starts_with("image/") {
            let encoded = BASE64.encode(&bytes);
            return Ok(ImageGenerationResponse {
                success: true,
                image: format!("data:{content_type};base64,{encoded}"),
            });
        }

        // Defensive: JSON envelope {"result":{"image":"<base64>"}, "success":true}.
        #[derive(Deserialize)]
        struct CfEnvelope {
            #[serde(default)]
            success: bool,
            #[serde(default)]
            result: CfResult,
        }
        #[derive(Default, Deserialize)]
        struct CfResult {
            #[serde(default)]
            image: String,
        }

        let envelope: CfEnvelope = serde_json::from_slice(&bytes).map_err(|source| {
            Error::Decode {
                source,
                body: truncate_str(&String::from_utf8_lossy(&bytes), 500),
            }
        })?;
        if !envelope.success || envelope.result.image.is_empty() {
            return Err(Error::Provider(format!(
                "cloudflare returned no image (success={}): {}",
                envelope.success,
                truncate_str(&String::from_utf8_lossy(&bytes), 500)
            )));
        }
        // The image field may already be a data URI or a raw base64 string.
        let img = envelope.result.image;
        let image = if img.starts_with("data:") {
            img
        } else {
            format!("data:image/png;base64,{img}")
        };
        Ok(ImageGenerationResponse {
            success: true,
            image,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_dim() {
        assert_eq!(snap_nvidia_dim(512), 768);
        assert_eq!(snap_nvidia_dim(1024), 1024);
        assert_eq!(snap_nvidia_dim(1030), 1024);
        assert_eq!(snap_nvidia_dim(2000), 1344);
    }

    #[test]
    fn parse_cf_pair_cases() {
        assert!(parse_cf_pair("").is_none());
        assert!(parse_cf_pair("nocolon").is_none());
        assert!(parse_cf_pair(":token").is_none());
        assert!(parse_cf_pair("acct:").is_none());
        let c = parse_cf_pair(" acct-123 : tok-en ").unwrap();
        assert_eq!(c.account_id, "acct-123");
        assert_eq!(c.token, "tok-en");
    }

    #[test]
    fn truncate() {
        assert_eq!(truncate_str("short", 500), "short");
        assert_eq!(truncate_str("abcdef", 3), "abc...");
    }
}
