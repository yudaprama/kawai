//! Shared HTTP executor + plumbing for generated tools. Ported from
//! egent-public-apis/tool/api_tool.go and cmd/gentools/scaffold.go.
//! DO hand-edit if you must (it is scaffolded once and never overwritten).

use reqwest::header::HeaderValue;
use reqwest::{Client, Method};
use serde_json::{Map, Value};

/// Per-crate tool configuration. Cloned into every tool instance.
#[derive(Debug, Clone, Default)]
pub struct ToolOptions {
    /// Custom HTTP client. A 15s-timeout client is used when unset.
    pub client: Option<Client>,
    /// Optional gate run before every request. An error aborts the call.
    pub pre_check: Option<fn() -> Result<(), ToolError>>,
}

impl ToolOptions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_client(mut self, c: Client) -> Self {
        self.client = Some(c);
        self
    }
}

#[derive(Debug, Clone, Default)]
pub struct ToolBase {
    client: Option<Client>,
    pre_check: Option<fn() -> Result<(), ToolError>>,
}

impl ToolBase {
    pub fn new(opts: ToolOptions) -> Self {
        Self {
            client: opts.client,
            pre_check: opts.pre_check,
        }
    }

    fn client(&self) -> Client {
        self.client.clone().unwrap_or_else(|| {
            Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client build")
        })
    }

    /// Execute the declarative HTTP request described by `spec`, substituting
    /// `args` into the URL template. Mirrors APITool.InvokableRun semantics:
    /// placeholder substitution, env-var pool resolution, empty-query cleanup,
    /// error-as-content, envelope unwrap.
    pub async fn exec(
        &self,
        spec: &RequestSpec,
        mut args: Map<String, Value>,
    ) -> Result<String, ToolError> {
        if let Some(check) = self.pre_check {
            check()?;
        }
        for (k, v) in spec.defaults_arr() {
            if !args.contains_key(k) {
                args.insert(k.to_string(), v);
            }
        }

        let mut path = spec.url_tpl.to_string();
        for (name, val) in &args {
            let placeholder = format!("{{{name}}}");
            let encoded = urlencoding::encode_path_segment(&val_to_string(val));
            path = path.replace(&placeholder, &encoded);
        }
        path = strip_placeholders(&path);
        path = clean_empty_query_params(&path);
        path = resolve_env_vars(&path);

        let method = match spec.method() {
            "GET" => Method::GET,
            "POST" => Method::POST,
            "PUT" => Method::PUT,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            other => Method::from_bytes(other.as_bytes()).unwrap_or(Method::GET),
        };

        let mut req = self.client().request(method.clone(), &path);
        let mut has_content_type = false;
        if let Some(h) = spec.headers_arr() {
            for &(k, v) in h {
                if k.eq_ignore_ascii_case("content-type") {
                    has_content_type = true;
                }
                let resolved = resolve_env_vars(v);
                if let Ok(hv) = HeaderValue::from_str(&resolved) {
                    req = req.header(k, hv);
                }
            }
        }

        if method != Method::GET {
            let body = serde_json::to_vec(&Value::Object(args.clone())).map_err(ToolError::json)?;
            req = req.body(body);
            if !has_content_type {
                req = req.header("content-type", "application/json");
            }
        }

        let resp = req.send().await.map_err(ToolError::request)?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(ToolError::request)?;
        let body = String::from_utf8_lossy(&bytes).into_owned();

        if status.as_u16() >= 400 {
            return Ok(format!("API error (HTTP {}): {}", status.as_u16(), body));
        }

        if method != Method::GET {
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
                    if let Some(result) = v.get("result") {
                        if let Some(s) = result.as_str() {
                            return Ok(s.to_string());
                        }
                        return Ok(result.to_string());
                    }
                }
            }
        }

        Ok(body)
    }
}

/// Declarative description of one tool's HTTP call, baked in at generation time.
#[derive(Debug, Clone)]
pub struct RequestSpec {
    pub method: &'static str,
    pub url_tpl: &'static str,
    pub headers: Option<Box<[(&'static str, &'static str)]>>,
    pub defaults: Option<Box<[(&'static str, Value)]>>,
}

impl RequestSpec {
    fn method(&self) -> &str {
        if self.method.is_empty() {
            "GET"
        } else {
            self.method
        }
    }
    fn headers_arr(&self) -> Option<&[(&'static str, &'static str)]> {
        self.headers.as_deref()
    }
    fn defaults_arr(&self) -> Vec<(&'static str, Value)> {
        match &self.defaults {
            Some(b) => b.to_vec(),
            None => Vec::new(),
        }
    }
}

fn val_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn strip_placeholders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_brace = false;
    for c in s.chars() {
        if c == '{' {
            in_brace = true;
            continue;
        }
        if in_brace {
            if c == '}' {
                in_brace = false;
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn clean_empty_query_params(path: &str) -> String {
    let Some(q) = path.find('?') else {
        return path.to_string();
    };
    let (base, query) = path.split_at(q + 1);
    let kept: Vec<&str> = query
        .split('&')
        .filter(|p| {
            p.split_once('=')
                .map(|(_, v)| !v.is_empty())
                .unwrap_or(false)
        })
        .collect();
    if kept.is_empty() {
        base.trim_end_matches('?').to_string()
    } else {
        format!("{base}{}", kept.join("&"))
    }
}

/// Resolve `$ENV_VAR` placeholders via comma-split random pick (mirrors
/// egent-common/envutil.PickRandomKey).
fn resolve_env_vars(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_uppercase() {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len()
                && (bytes[end].is_ascii_uppercase()
                    || bytes[end].is_ascii_digit()
                    || bytes[end] == b'_')
            {
                end += 1;
            }
            let name = std::str::from_utf8(&bytes[start..end]).unwrap_or("");
            out.push_str(&pick_random_key(name));
            i = end;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn pick_random_key(env_name: &str) -> String {
    let Ok(val) = std::env::var(env_name) else {
        return format!("${env_name}");
    };
    let keys: Vec<&str> = val
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if keys.is_empty() {
        return format!("${env_name}");
    }
    let idx = simple_random() % keys.len();
    keys[idx].to_string()
}

fn simple_random() -> usize {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize)
        .unwrap_or(0);
    nanos.wrapping_mul(2654435761)
}

/// Minimal path-segment percent-encoding (mirrors Go url.PathEscape).
mod urlencoding {
    pub fn encode_path_segment(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for &b in s.as_bytes() {
            if is_safe(b) {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    }

    fn is_safe(b: u8) -> bool {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_'
                    | b'.'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
            )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

impl ToolError {
    pub fn request(e: reqwest::Error) -> Self {
        Self::Request(e)
    }
    pub fn json(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
