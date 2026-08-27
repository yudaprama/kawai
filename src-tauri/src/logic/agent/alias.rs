#[cfg(feature = "litert")]
use serde_json::Value;

/// # File-id alias handles
///
/// The office store mints long, opaque file ids (`f87366129058607000-0000`).
/// The on-device model reliably transcribes short, stable handles but
/// corrupts 23-char ids (session 20: `f873…0000` → `f7`). So the loop hides
/// the real id behind a per-session, short alias (`doc1`, `doc2`, …) shown in
/// tool results, and resolves the alias back to the real id only at dispatch
/// (so the underlying rig tool still sees the real id). The map is keyed by
/// session id and persists for the session's lifetime.
#[cfg(feature = "litert")]
struct AliasState {
    order: Vec<(String, String)>,
    seen: std::collections::HashSet<String>,
}

#[cfg(feature = "litert")]
fn alias_registry() -> &'static std::sync::Mutex<std::collections::HashMap<i64, AliasState>> {
    use std::sync::{Mutex, OnceLock};
    static REG: OnceLock<Mutex<std::collections::HashMap<i64, AliasState>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Assign (or reuse) a short alias for a real file id and return it.
#[cfg(feature = "litert")]
pub fn alias_assign(sid: i64, real: &str) -> String {
    if real.is_empty() {
        return String::new();
    }
    let mut reg = alias_registry().lock().unwrap();
    let st = reg.entry(sid).or_insert(AliasState {
        order: Vec::new(),
        seen: std::collections::HashSet::new(),
    });
    if let Some((a, _)) = st.order.iter().find(|(_, r)| r == real) {
        return a.clone();
    }
    let a = format!("doc{}", st.order.len() + 1);
    st.seen.insert(real.to_string());
    st.order.push((a.clone(), real.to_string()));
    a
}

/// Reverse lookup: real id → its alias (if previously assigned).
#[cfg(feature = "litert")]
pub fn alias_of(sid: i64, real: &str) -> Option<String> {
    let reg = alias_registry().lock().unwrap();
    reg.get(&sid)?
        .order
        .iter()
        .find(|(_, r)| r == real)
        .map(|(a, _)| a.clone())
}

/// Resolve a possibly-aliased value to its real id. Tries exact alias, then a
/// case-insensitive match (the model occasionally lowercases the handle,
/// e.g. `Doc1`). Returns the original value unchanged when no alias matches —
/// downstream arg validation / the repair round still handle genuine misses.
#[cfg(feature = "litert")]
pub fn alias_resolve(sid: i64, value: &str) -> String {
    let reg = alias_registry().lock().unwrap();
    let st = match reg.get(&sid) {
        Some(s) => s,
        None => return value.to_string(),
    };
    let v = value.trim();
    for (a, r) in &st.order {
        if a == v || a.eq_ignore_ascii_case(v) {
            return r.clone();
        }
    }
    value.to_string()
}

/// Rewrite a tool result body so any real file ids it exposes become short
/// aliases before the model sees them. Only the two result shapes that carry
/// ids are touched: `office_list_files` (`files[].id`) and `knowledge_search`
/// (`hits[].fileId`). Other tools pass through unchanged.
#[cfg(feature = "litert")]
pub fn alias_rewrite_body(sid: i64, tool: &str, body: &str) -> String {
    let mut v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return body.to_string(),
    };
    let touch = |map: &mut serde_json::Map<String, Value>, key: &str| {
        if let Some(id) = map.get(key).and_then(Value::as_str) {
            if !id.is_empty() {
                let a = alias_assign(sid, id);
                map.insert(key.to_string(), Value::String(a));
            }
        }
    };
    match tool {
        "office_list_files" => {
            if let Some(files) = v.get_mut("files").and_then(Value::as_array_mut) {
                for f in files.iter_mut().filter_map(Value::as_object_mut) {
                    touch(f, "id");
                }
            }
        }
        "knowledge_search" => {
            if let Some(hits) = v.get_mut("hits").and_then(Value::as_array_mut) {
                for h in hits.iter_mut().filter_map(Value::as_object_mut) {
                    touch(h, "fileId");
                }
            }
        }
        _ => {}
    }
    serde_json::to_string(&v).unwrap_or_else(|_| body.to_string())
}

/// Resolve any `fileId` / `file_id` argument from an alias to its real id,
/// returning a new args object (the original is preserved for the UI event).
#[cfg(feature = "litert")]
pub fn alias_resolve_args(sid: i64, args: &Value) -> Value {
    let mut out = args.clone();
    if let Some(obj) = out.as_object_mut() {
        for key in ["fileId", "file_id"] {
            if let Some(Value::String(s)) = obj.get(key) {
                let resolved = alias_resolve(sid, s);
                if resolved != *s {
                    obj.insert(key.to_string(), Value::String(resolved));
                }
            }
        }
    }
    out
}

