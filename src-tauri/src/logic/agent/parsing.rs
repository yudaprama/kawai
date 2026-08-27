use serde_json::Value;

/// Parse a fenced tool call from a completed generation.
///
/// - `None` → no ```tool fence and no native markup (final answer)
/// - `Some(Ok((tool, args)))` → dispatchable call
/// - `Some(Err(detail))` → markup present but malformed (one repair allowed)
pub fn parse_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    if let Some(fenced) = parse_fenced_tool_call(text) {
        return Some(fenced);
    }
    parse_native_tool_call(text)
}

/// Parse the taught ```tool fence protocol. Tolerates the inline form the
/// model emits under pressure (JSON glued to the opener: ```tool{"tool":…}```
/// with no newline) as well as an info-string line (```tool json).
fn parse_fenced_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    let lower = text.to_lowercase();
    let start = lower.find("```tool")? + "```tool".len();
    let rest = text[start..].trim_start();
    let end = match rest.find("```") {
        Some(e) => e,
        None => return Some(Err("unterminated ```tool block".into())),
    };
    let mut raw = rest[..end].trim();
    if !raw.starts_with('{') {
        // Info string on its own line (```tool json\n{...}) — drop it, but
        // only when a JSON body actually follows (a lone bare name stays).
        if let Some(nl) = raw.find('\n') {
            let next = raw[nl + 1..].trim_start();
            if next.starts_with('{') {
                raw = next.trim_end();
            }
        }
    }
    if raw.is_empty() {
        return Some(Err("empty ```tool block".into()));
    }
    // Leniency: a fence containing ONLY a bare tool name (the model forgot the
    // JSON wrapper) dispatches with empty args. Arg validation then fails as a
    // TOOL_RESULT the model can answer with a complete call — instead of the
    // turn dying on a malformed-fence error.
    if !raw.contains('\n')
        && raw.starts_with(|c: char| c.is_ascii_alphabetic())
        && raw
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Some(Ok((raw.to_string(), serde_json::json!({}))));
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v) => {
            // Accept the documented "tool" plus the aliases small models
            // commonly emit ("tool_name", "name").
            let tool = ["tool", "tool_name", "name"]
                .iter()
                .find_map(|k| v.get(k).and_then(|t| t.as_str()).map(str::to_string))
                .filter(|t| !t.is_empty());
            match tool {
                Some(t) => {
                    let args = v.get("args").cloned().unwrap_or(serde_json::json!({}));
                    Some(Ok((t, args)))
                }
                None => Some(Err("tool block missing the \"tool\" field".into())),
            }
        }
        Err(e) => Some(Err(format!("tool block is not valid JSON: {e}"))),
    }
}

/// Parse the Gemma native tool-call markup the model sometimes emits instead
/// of the taught ```tool fence:
/// `<|tool_call>call:NAME{ARGS}<tool_call|>` — opener tolerates the closed
/// `<|tool_call|>` form, terminator accepts `<tool_call|>` or
/// `<|tool_call_end|>`, and quotes may be escaped as `<|"|>` / `<|'|>`.
/// Keys may be bare (`{mode:"keyword"}`) — [`quote_bare_keys`] fixes that.
fn parse_native_tool_call(text: &str) -> Option<Result<(String, Value), String>> {
    if let Some(start) = text.find("<|tool_call") {
        let after = &text[start..];
        let name_start = after.find("call:")? + "call:".len();
        let rest = &after[name_start..];
        let end = ["<tool_call|>", "<|tool_call_end|>"]
            .iter()
            .filter_map(|m| rest.find(m))
            .min()
            .unwrap_or(rest.len());
        return parse_native_body(rest[..end].trim());
    }
    // Marker-less bare form: `call:NAME{args}` with no special tokens at all
    // (observed degradation when the model drops the wrapper entirely). A
    // candidate that does not validate is treated as prose (final answer),
    // NOT an error — "call:" inside ordinary language must not kill a turn.
    // Exception: a valid name + balanced braces whose args fail to parse is
    // clearly an attempted call — surfaced as malformed for the repair round.
    let mut first_broken: Option<String> = None;
    let mut from = 0usize;
    while let Some(rel) = text[from..].find("call:") {
        let at = from + rel;
        from = at + "call:".len();
        // Word boundary: "recall:" / "we call:" are not tool calls.
        if at > 0 {
            let prev = text[..at].chars().next_back().unwrap();
            if prev.is_alphanumeric() || prev == '_' {
                continue;
            }
        }
        let body = &text[at + "call:".len()..];
        // Arg extent: balanced braces from the first `{` (strings respected).
        let Some(open) = body.find('{') else {
            continue;
        };
        let name = body[..open].trim().trim_end_matches(':').trim();
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        let args_span = balanced_braces(body, open);
        let parsed = args_span.and_then(|raw| parse_native_body(&format!("{name} {raw}")));
        if let Some(Ok((n, v))) = parsed {
            return Some(Ok((n, v)));
        }
        // Retry after syntax repair: a key missing its opening quote desyncs
        // the string tracker above, so unbalanced here may still be a valid
        // call once bare keys are re-quoted.
        let fixed = quote_bare_keys(body);
        if let Some(open2) = fixed.find('{') {
            let name2 = fixed[..open2]
                .trim()
                .trim_end_matches(':')
                .trim()
                .to_string();
            if name2 == name {
                let reparsed = balanced_braces(&fixed, open2)
                    .and_then(|raw| parse_native_body(&format!("{name} {raw}")));
                if let Some(Ok((n, v))) = reparsed {
                    return Some(Ok((n, v)));
                }
            }
        }
        // Recognizable but broken (valid name + BALANCED braces, args won't
        // parse): NOT prose — remember the first failure. If no candidate
        // parses, surface it as a malformed call so the loop's ONE repair
        // round teaches the correct shape (raw-persisting the line is the
        // worst outcome). Unbalanced braces stay prose ("call:" + garbage).
        if args_span.is_some() && first_broken.is_none() {
            first_broken = Some(format!("call:{name}{{...}} — args are not valid JSON"));
        }
    }
    first_broken.map(Err)
}

/// Extract `{...}` starting at `body[open]`, honouring string literals, to the
/// matching close brace. `None` when unbalanced.
fn balanced_braces(body: &str, open: usize) -> Option<&str> {
    let bytes = body.as_bytes();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if in_str => i += 1,
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(&body[open..=i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Validate `NAME {json}` (or bare `NAME`) from a native call body.
fn parse_native_body(body: &str) -> Option<Result<(String, Value), String>> {
    let (name, args_raw) = match body.find('{') {
        Some(i) => (
            body[..i].trim().trim_end_matches(':').trim(),
            body[i..].trim(),
        ),
        None => (body.trim(), ""),
    };
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        let shown: String = name.chars().take(60).collect();
        return Some(Err(format!("native tool call has no valid name: {shown}")));
    }
    if args_raw.is_empty() {
        return Some(Ok((name.to_string(), serde_json::json!({}))));
    }
    let unescaped = args_raw.replace("<|\"|>", "\"").replace("<|'|>", "'");
    let fixed = quote_bare_keys(&unescaped);
    match serde_json::from_str::<Value>(&fixed) {
        Ok(v) => Some(Ok((name.to_string(), v))),
        Err(e) => Some(Err(format!("native tool call args not valid JSON: {e}"))),
    }
}

/// Quote bare object keys so serde accepts near-JSON args:
/// `{mode:"keyword"}` → `{"mode":"keyword"}`. Only identifiers directly after
/// `{` or `,` (modulo whitespace) that are followed by `:` get quoted —
/// string values and already-quoted keys pass through untouched.
fn quote_bare_keys(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 16);
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            // Copy the string literal verbatim (escape-aware).
            out.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                out.push(ch);
                i += 1;
                if ch == '\\' && i < chars.len() {
                    out.push(chars[i]);
                    i += 1;
                } else if ch == '"' {
                    break;
                }
            }
            continue;
        }
        if c == '{' || c == ',' || (out.is_empty() && (c.is_ascii_alphabetic() || c == '_')) {
            // At a key position: scan an identifier, quote it if a `:` follows.
            out.push(c);
            i += 1;
            while i < chars.len() && chars[i] == ' ' {
                out.push(' ');
                i += 1;
            }
            if i < chars.len() && (chars[i].is_ascii_alphabetic() || chars[i] == '_') {
                let ks = i;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[ks..i].iter().collect();
                let mut j = i;
                while j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == ':' {
                    out.push('"');
                    out.push_str(&ident);
                    out.push('"');
                } else if j < chars.len() && chars[j] == '"' && {
                    // Missing OPENING quote (`..."`,task": "x`) — the model
                    // dropped one side of the key. The closing quote is right
                    // here; supply the opener.
                    let mut k = j + 1;
                    while k < chars.len() && chars[k] == ' ' {
                        k += 1;
                    }
                    k < chars.len() && chars[k] == ':'
                } {
                    out.push('"');
                    out.push_str(&ident);
                } else {
                    out.push_str(&ident);
                }
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Strip protocol markers the model may echo back into streamed tokens.
/// Covers the taught fence markers plus the Gemma 4 native special tokens
/// (tool-call lifecycle, thought channel, turn end) so they never reach the
/// UI as prose. Escaped string delimiters un-escape to real quotes.
#[cfg(feature = "litert")]
pub fn strip_markers(t: &str) -> String {
    t.replace("<agent_context>", "")
        .replace("</agent_context>", "")
        .replace("<user_request>", "")
        .replace("</user_request>", "")
        .replace("<|tool_call>", "")
        .replace("<|tool_call|>", "")
        .replace("<tool_call|>", "")
        .replace("<|tool_call_end|>", "")
        .replace("<|tool_response>", "")
        .replace("<|tool_response|>", "")
        .replace("<|channel>thought>", "")
        .replace("<|message|>", "")
        .replace("<|end|>", "")
        .replace("<|\"|>", "\"")
        .replace("<|'|>", "'")
}

#[cfg(feature = "litert")]
pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

/// Render a ToolResult into the text fed back to the model.
#[cfg(feature = "litert")]
pub fn tool_result_body(result: &kawai_tools::ToolResult) -> String {
    if let Some(text) = result.text() {
        if !text.trim().is_empty() {
            return text.to_string();
        }
    }
    if let Some(err) = result.error_message() {
        return format!("ERROR: {err}");
    }
    "<non-text output>".to_string()
}

