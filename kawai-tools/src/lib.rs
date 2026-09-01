//! The kawai agent tool seam: typed tools + a name-keyed registry.
//!
//! The agent loop (`src-tauri/src/logic/agent.rs`) embeds
//! [`ToolSet::get_tool_definitions`] in the system prompt as the tool manifest
//! and dispatches parsed `call:<name>{json}` lines through
//! [`ToolSet::execute`], feeding the returned text back as a
//! `response:<name>` message. Tools stay context-free: identity (`user_id`,
//! `session_id`) is baked into each tool at construction time by the
//! per-agent `toolset` builders — the model can never supply it.
//!
//! Errors are guidance, not failures: an errored [`ToolResult`] carries the
//! error message as its body so the model can repair its next call in one
//! round (invalid input messages name the problem; unknown-tool messages list
//! the available names).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;

/// Provider-facing tool metadata: registration name, model-facing
/// description, and the JSON Schema for the arguments object.
#[derive(Clone, Debug)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

/// Model-visible output of a tool call, as a single text body.
///
/// `String` stays verbatim; `Value` serializes to JSON. Custom output types
/// (e.g. `OfficeCreateOutput`) implement this in their own crate.
pub trait IntoToolOutput: Send {
    fn into_output(self) -> String;
}

impl IntoToolOutput for String {
    fn into_output(self) -> String {
        self
    }
}

impl IntoToolOutput for Value {
    fn into_output(self) -> String {
        self.to_string()
    }
}

impl IntoToolOutput for () {
    fn into_output(self) -> String {
        String::new()
    }
}

/// A context-free typed agent tool. The associated-type shape mirrors what
/// tool authors already write: `NAME`, `Args`, `Output`, `Error` plus
/// `description`/`parameters`/`call`. The registry type-erases tools and
/// deserializes arguments at dispatch.
pub trait AgentTool: Sized + Send + Sync {
    /// Unique registration and model-facing name.
    const NAME: &'static str;
    /// Owned JSON arguments.
    type Args: DeserializeOwned + Send;
    /// Canonical model-visible output.
    type Output: IntoToolOutput;
    /// Concrete author-facing failure; rendered via `Display`.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Model-facing description.
    fn description(&self) -> String;

    /// JSON Schema for arguments.
    fn parameters(&self) -> Value;

    /// Execute one owned invocation.
    fn call(
        &self,
        arguments: Self::Args,
    ) -> impl Future<Output = Result<Self::Output, Self::Error>> + Send;
}

/// The result of one dispatch: success body or guidance-error message.
/// Mirrors the error-as-content convention — the loop feeds either side back
/// to the model as text.
#[derive(Clone, Debug)]
pub struct ToolResult {
    body: Result<String, String>,
}

impl ToolResult {
    /// Successful result carrying its model-facing body.
    pub fn success(body: impl Into<String>) -> Self {
        Self {
            body: Ok(body.into()),
        }
    }

    /// Errored result whose message is fed back to the model verbatim.
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            body: Err(message.into()),
        }
    }

    /// Whether the tool completed successfully.
    pub fn is_success(&self) -> bool {
        self.body.is_ok()
    }

    /// The success body, when the tool completed successfully.
    pub fn text(&self) -> Option<&str> {
        match &self.body {
            Ok(text) => Some(text.as_str()),
            Err(_) => None,
        }
    }

    /// The error message, when the tool errored.
    pub fn error_message(&self) -> Option<&str> {
        match &self.body {
            Err(message) => Some(message.as_str()),
            Ok(_) => None,
        }
    }
}

type BoxedToolFuture = Pin<Box<dyn Future<Output = ToolResult> + Send>>;

/// Type-erased tool entry: its definition plus a JSON-string dispatch closure.
struct ErasedEntry {
    definition: ToolDefinition,
    #[allow(clippy::type_complexity)]
    invoke: Box<dyn Fn(&str) -> BoxedToolFuture + Send + Sync>,
}

/// Model-written args that mean "no arguments" — normalized to `{}` so an
/// empty argument list still deserializes for struct-args tools; unit-args
/// tools fall back to `null` in [`parse_args`].
fn normalize_args(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        "{}".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Deserialize typed args, tolerating the empty-argument forms: `{}` for
/// struct-args tools (the normalized empty payload) and `null` for unit-args
/// tools. Real payloads parse in one pass; the fallback only swaps the two
/// empty forms.
fn parse_args<T: DeserializeOwned>(raw: &str) -> Result<T, serde_json::Error> {
    let normalized = normalize_args(raw);
    match serde_json::from_str::<T>(&normalized) {
        Ok(args) => Ok(args),
        Err(e) => {
            let fallback = if normalized == "{}" { "null" } else { "{}" };
            serde_json::from_str::<T>(fallback).map_err(|_| e)
        }
    }
}

fn erase<T: AgentTool + 'static>(tool: T) -> ErasedEntry {
    let definition = ToolDefinition {
        name: T::NAME.to_string(),
        description: tool.description(),
        parameters: tool.parameters(),
    };
    let tool = Arc::new(tool);
    let captured = Arc::clone(&tool);
    let invoke = Box::new(move |raw: &str| {
        let tool = Arc::clone(&captured);
        let args = normalize_args(raw);
        Box::pin(async move {
            let parsed = match parse_args::<T::Args>(&args) {
                Ok(parsed) => parsed,
                Err(e) => {
                    return ToolResult::error(format!("invalid arguments for {}: {e}", T::NAME));
                }
            };
            match tool.call(parsed).await {
                Ok(output) => ToolResult::success(output.into_output()),
                Err(e) => ToolResult::error(e.to_string()),
            }
        }) as BoxedToolFuture
    });
    ErasedEntry { definition, invoke }
}

/// A name-keyed set of [`AgentTool`]s. Insertion order is preserved for the
/// manifest; re-adding a name replaces the tool in place.
#[derive(Clone, Default)]
pub struct ToolSet {
    entries: HashMap<String, Arc<ErasedEntry>>,
    definitions: Vec<ToolDefinition>,
}

impl ToolSet {
    /// An empty set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a tool under its [`AgentTool::NAME`].
    pub fn add_tool<T: AgentTool + 'static>(&mut self, tool: T) {
        let entry = Arc::new(erase(tool));
        match self.entries.get_mut(T::NAME) {
            Some(slot) => *slot = Arc::clone(&entry),
            None => {
                self.entries.insert(T::NAME.to_string(), Arc::clone(&entry));
            }
        }
        match self.definitions.iter_mut().find(|d| d.name == T::NAME) {
            Some(existing) => *existing = entry.definition.clone(),
            None => self.definitions.push(entry.definition.clone()),
        }
    }

    /// Merge every tool from `other` into `self`. First registration wins:
    /// names already present in `self` are kept, so callers control priority
    /// by merge order. `other` is left empty.
    pub fn merge(&mut self, other: &mut ToolSet) {
        for (name, entry) in other.entries.drain() {
            if self.entries.contains_key(&name) {
                continue;
            }
            self.definitions.push(entry.definition.clone());
            self.entries.insert(name, entry);
        }
    }

    /// Number of registered tools.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether no tools are registered.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The model-facing manifest: every tool's name, description, and
    /// argument schema, in registration order.
    pub fn get_tool_definitions(&self) -> &[ToolDefinition] {
        &self.definitions
    }

    /// Dispatch one call by tool name. The argument string is the model's
    /// JSON object (or empty). Unknown names and invalid arguments come back
    /// as errored results whose messages teach the valid inputs — the loop
    /// feeds them back to the model instead of failing the turn.
    pub async fn execute(&self, name: &str, args: impl Into<String>) -> ToolResult {
        match self.entries.get(name) {
            Some(entry) => (entry.invoke)(&args.into()).await,
            None => {
                let available = self
                    .definitions
                    .iter()
                    .map(|d| d.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                ToolResult::error(format!(
                    "tool {name:?} does not exist. Available tools: {available}"
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, thiserror::Error)]
    #[error("{0}")]
    struct EchoError(String);

    #[derive(Debug, Deserialize)]
    struct EchoArgs {
        text: String,
        #[serde(default)]
        repeat: Option<u32>,
    }

    struct EchoTool;

    impl AgentTool for EchoTool {
        const NAME: &'static str = "echo";
        type Args = EchoArgs;
        type Output = String;
        type Error = EchoError;

        fn description(&self) -> String {
            "Echoes text back.".into()
        }

        fn parameters(&self) -> Value {
            serde_json::json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "repeat": { "type": "integer" },
                },
                "required": ["text"]
            })
        }

        async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
            let n = args.repeat.unwrap_or(1);
            Ok(std::iter::repeat_n(args.text, n as usize)
                .collect::<Vec<_>>()
                .join("-"))
        }
    }

    #[derive(Debug, Deserialize)]
    struct FailArgs;

    struct FailTool;

    impl AgentTool for FailTool {
        const NAME: &'static str = "always_fails";
        type Args = FailArgs;
        type Output = String;
        type Error = EchoError;

        fn description(&self) -> String {
            "Always errors.".into()
        }

        fn parameters(&self) -> Value {
            serde_json::json!({"type": "object", "properties": {}})
        }

        async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
            Err(EchoError("boom: valid names are a, b".into()))
        }
    }

    struct JsonTool;

    #[derive(Debug, Deserialize)]
    struct JsonArgs;

    impl AgentTool for JsonTool {
        const NAME: &'static str = "json_out";
        type Args = JsonArgs;
        type Output = Value;
        type Error = EchoError;

        fn description(&self) -> String {
            "Returns JSON.".into()
        }

        fn parameters(&self) -> Value {
            serde_json::json!({"type": "object", "properties": {}})
        }

        async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
            Ok(serde_json::json!({"ok": true}))
        }
    }

    #[tokio::test]
    async fn dispatch_success_with_typed_args() {
        let mut set = ToolSet::new();
        set.add_tool(EchoTool);
        let result = set.execute("echo", r#"{"text": "hi", "repeat": 2}"#).await;
        assert!(result.is_success());
        assert_eq!(result.text(), Some("hi-hi"));
        assert!(result.error_message().is_none());
    }

    #[tokio::test]
    async fn empty_and_null_args_normalize_to_empty_object() {
        let mut set = ToolSet::new();
        set.add_tool(FailTool); // FailArgs is an empty struct — needs "{}"
        let result = set.execute("always_fails", "").await;
        assert!(!result.is_success());
        assert_eq!(result.error_message(), Some("boom: valid names are a, b"));

        let result = set.execute("always_fails", "null").await;
        assert_eq!(result.error_message(), Some("boom: valid names are a, b"));
    }

    #[tokio::test]
    async fn error_message_is_the_body() {
        let mut set = ToolSet::new();
        set.add_tool(FailTool);
        let result = set.execute("always_fails", "{}").await;
        assert!(!result.is_success());
        assert_eq!(result.text(), None);
        assert_eq!(result.error_message(), Some("boom: valid names are a, b"));
    }

    #[tokio::test]
    async fn invalid_args_name_the_tool_and_the_problem() {
        let mut set = ToolSet::new();
        set.add_tool(EchoTool);
        let result = set.execute("echo", r#"{"repeat": "not a number"}"#).await;
        assert!(!result.is_success());
        let msg = result.error_message().unwrap();
        assert!(msg.contains("invalid arguments for echo"), "{msg}");
    }

    #[tokio::test]
    async fn unknown_tool_lists_available_names() {
        let mut set = ToolSet::new();
        set.add_tool(EchoTool);
        set.add_tool(JsonTool);
        let result = set.execute("nope", "{}").await;
        assert!(!result.is_success());
        let msg = result.error_message().unwrap();
        assert!(msg.contains(r#"tool "nope" does not exist"#), "{msg}");
        assert!(msg.contains("echo, json_out"), "{msg}");
    }

    #[tokio::test]
    async fn json_output_serializes() {
        let mut set = ToolSet::new();
        set.add_tool(JsonTool);
        let result = set.execute("json_out", "{}").await;
        assert_eq!(result.text(), Some(r#"{"ok":true}"#));
    }

    #[test]
    fn definitions_preserve_registration_order_and_replace_in_place() {
        let mut set = ToolSet::new();
        set.add_tool(EchoTool);
        set.add_tool(JsonTool);
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(names, ["echo", "json_out"]);
        assert_eq!(set.len(), 2);
        assert_eq!(
            set.get_tool_definitions()[0].description,
            "Echoes text back."
        );
        assert!(
            set.get_tool_definitions()[0]
                .parameters
                .get("properties")
                .is_some()
        );
    }

    #[test]
    fn readd_replaces_definition_in_place() {
        let mut set = ToolSet::new();
        set.add_tool(EchoTool);
        set.add_tool(JsonTool);
        set.add_tool(EchoTool); // replace, keep position 0
        assert_eq!(set.len(), 2);
        let names: Vec<&str> = set
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(names, ["echo", "json_out"]);
    }

    #[test]
    fn merge_appends_new_names_and_keeps_existing() {
        let mut base = ToolSet::new();
        base.add_tool(EchoTool);
        let mut extra = ToolSet::new();
        extra.add_tool(JsonTool);
        extra.add_tool(EchoTool); // duplicate name — must NOT override base
        base.merge(&mut extra);
        assert_eq!(base.len(), 2);
        assert!(extra.is_empty(), "merge drains the source set");
        let names: Vec<&str> = base
            .get_tool_definitions()
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(names, ["echo", "json_out"]);
    }

    #[test]
    fn empty_set_is_empty() {
        let set = ToolSet::new();
        assert!(set.is_empty());
        assert!(set.get_tool_definitions().is_empty());
    }
}
