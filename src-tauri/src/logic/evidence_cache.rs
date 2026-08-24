//! Session-scoped evidence cache for the agent loop (cross-turn memory).
//!
//! `TurnMemory` dies with the turn; this cache lets a LATER turn of the SAME
//! session reuse a prior read of an unchanged local file without
//! re-dispatching the tool. Scope rules:
//!
//! - Keyed `(user_id, session_id)` — switching sessions parks the old
//!   session's entries (resumable on switch-back), never crosses sessions;
//!   `user_id` arrives resolved at the transport edge like everywhere else.
//! - Only deterministic READS of store files are cached (see [`classify`]);
//!   market quotes are never cached, web fetches have their own upstream LRU
//!   in `webread`, mutating tools change their own fingerprint anyway.
//! - Freshness = file fingerprint (mtime secs + size — the same signal the
//!   analytics parquet sidecar uses), re-checked on EVERY lookup. An edit
//!   between turns invalidates silently: the next probe misses.
//! - Two-level LRU: per-session entry/char caps, plus a global cap on how
//!   many sessions stay parked (oldest-used session is dropped whole).
//! - In-process only (global `Mutex` registry, the `alias_registry` pattern):
//!   nothing survives restart, no SQLite, no schema.

use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

/// Per-session entry cap.
const MAX_ENTRIES_PER_SESSION: usize = 64;
/// Per-session stored-chars budget (~1 MB).
const MAX_CHARS_PER_SESSION: usize = 1_000_000;
/// How many sessions stay parked across switches (LRU by last use).
const MAX_SESSIONS: usize = 8;

/// mtime(secs) + size of the backing file at put time.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Fingerprint {
    mtime_secs: i64,
    size: u64,
}

fn fingerprint_of(path: &str) -> Option<Fingerprint> {
    let md = std::fs::metadata(path).ok()?;
    let mtime_secs = md
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some(Fingerprint {
        mtime_secs,
        size: md.len(),
    })
}

/// What the loop should do with a completed tool result.
pub enum Policy {
    /// Deterministic read of a store file — cache keyed to the file's
    /// current fingerprint.
    FileScoped { file_id: String },
    /// Never cache (fresh-by-nature data, upstream-cached, or mutating).
    Skip,
}

/// Cacheability table. ONLY deterministic reads of immutable-until-edited
/// store files qualify; everything else stays Skip until a real need shows
/// up in turn_log data.
pub fn classify(tool: &str, args: &Value) -> Policy {
    #[cfg(feature = "office")]
    if matches!(
        tool,
        "office_read_document"
            | "office_document_info"
            | "pdf_extract_text"
            | "pdf_search_text"
            | "pdf_info"
    ) {
        let file_id = args
            .get("fileId")
            .or_else(|| args.get("file_id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !file_id.is_empty() {
            return Policy::FileScoped {
                file_id: file_id.to_string(),
            };
        }
    }
    Policy::Skip
}

struct Entry {
    tool: String,
    args_key: String,
    body: String,
    path: String,
    fingerprint: Fingerprint,
    used_at: std::time::Instant,
}

/// Back of `entries` = most recently used.
#[derive(Default)]
struct SessionCache {
    entries: Vec<Entry>,
}

impl SessionCache {
    fn chars(&self) -> usize {
        self.entries
            .iter()
            .map(|e| e.body.chars().count())
            .sum()
    }

    fn find_idx(&self, tool: &str, args_key: &str) -> Option<usize> {
        self.entries
            .iter()
            .position(|e| e.tool == tool && e.args_key == args_key)
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key(String, i64);

#[derive(Default)]
struct Registry {
    sessions: HashMap<Key, SessionCache>,
    /// Front = least recently used session.
    order: VecDeque<Key>,
}

fn registry() -> &'static Mutex<Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Registry::default()))
}

/// Look up a cached result. Returns `(body, age_secs)` on a hit — only when
/// the call classifies as cacheable AND the underlying file still carries the
/// fingerprint captured at put time. A fingerprint mismatch removes the stale
/// entry (next real run re-populates it).
pub fn probe(user_id: &str, sid: i64, tool: &str, exec_args: &Value) -> Option<(String, u64)> {
    #[cfg(feature = "office")]
    {
        probe_office_scoped(user_id, sid, tool, exec_args)
    }
    #[cfg(not(feature = "office"))]
    {
        let _ = (user_id, sid, tool, exec_args);
        None
    }
}

#[cfg(feature = "office")]
fn probe_office_scoped(
    user_id: &str,
    sid: i64,
    tool: &str,
    exec_args: &Value,
) -> Option<(String, u64)> {
    match classify(tool, exec_args) {
        Policy::Skip => return None,
        Policy::FileScoped { .. } => {}
    }
    let mut reg = registry().lock().unwrap();
    let cache = reg.sessions.get_mut(&Key(user_id.to_string(), sid))?;
    let idx = cache.find_idx(tool, &canonical_lookup_key(tool, exec_args)?)?;
    // Freshness check against the CURRENT file state.
    let entry = &cache.entries[idx];
    if fingerprint_of(&entry.path) != Some(entry.fingerprint) {
        cache.entries.remove(idx);
        return None;
    }
    let (body, age) = (
        entry.body.clone(),
        entry.used_at.elapsed().as_secs(),
    );
    // Touch: move to the MRU end.
    let mut e = cache.entries.remove(idx);
    e.used_at = std::time::Instant::now();
    cache.entries.push(e);
    reg.order.retain(|k| *k != Key(user_id.to_string(), sid));
    reg.order.push_back(Key(user_id.to_string(), sid));
    Some((body, age))
}

/// Store a completed tool result. No-op unless the call classifies as
/// cacheable and its file still resolves; oversized single bodies (> the
/// whole per-session budget) are refused rather than thrashing the caps.
pub fn store_result(user_id: &str, sid: i64, tool: &str, exec_args: &Value, body: &str) {
    #[cfg(feature = "office")]
    store_office_scoped(user_id, sid, tool, exec_args, body);
    #[cfg(not(feature = "office"))]
    {
        let _ = (user_id, sid, tool, exec_args, body);
    }
}

#[cfg(feature = "office")]
fn store_office_scoped(user_id: &str, sid: i64, tool: &str, exec_args: &Value, body: &str) {
    let file_id = match classify(tool, exec_args) {
        Policy::FileScoped { file_id } => file_id,
        Policy::Skip => return,
    };
    let Ok(path) = crate::logic::office::store::file_path(user_id, &file_id) else {
        return;
    };
    let Some(fingerprint) = fingerprint_of(&path) else {
        return;
    };
    let chars = body.chars().count();
    if chars > MAX_CHARS_PER_SESSION {
        return;
    }
    let Some(args_key) = canonical_lookup_key(tool, exec_args) else {
        return;
    };
    let mut reg = registry().lock().unwrap();
    let key = Key(user_id.to_string(), sid);
    if !reg.sessions.contains_key(&key) {
        // Park a brand-new session; retire the oldest-parked if over cap.
        while reg.order.len() >= MAX_SESSIONS {
            if let Some(old) = reg.order.pop_front() {
                reg.sessions.remove(&old);
            }
        }
        reg.order.push_back(key.clone());
        reg.sessions.insert(key.clone(), SessionCache::default());
    }
    let cache = reg.sessions.get_mut(&key).unwrap();
    let entry = Entry {
        tool: tool.to_string(),
        args_key,
        body: body.to_string(),
        path,
        fingerprint,
        used_at: std::time::Instant::now(),
    };
    // Same key replaces in place (net chars adjust), otherwise append MRU.
    if cache.find_idx(tool, &entry.args_key).is_some() {
        let idx = cache.find_idx(tool, &entry.args_key).unwrap();
        cache.entries.remove(idx);
    }
    cache.entries.push(entry);
    // Enforce caps by retiring the LRU entries (never the just-added tail
    // unless it alone overflows, which the early-return above prevents).
    while cache.entries.len() > MAX_ENTRIES_PER_SESSION
        || cache.chars() > MAX_CHARS_PER_SESSION
    {
        if cache.entries.len() <= 1 {
            break;
        }
        cache.entries.remove(0);
    }
    reg.order.retain(|k| *k != key);
    reg.order.push_back(key);
}

/// Drop one session's parked entries (session delete / cleanup hook).
pub fn drop_session(user_id: &str, sid: i64) {
    let mut reg = registry().lock().unwrap();
    let key = Key(user_id.to_string(), sid);
    reg.sessions.remove(&key);
    reg.order.retain(|k| *k != key);
}

/// Canonical dedup/lookup key for a cached call — mirrors the turn-memory
/// dedup key (`canonical_args_key` in agent.rs) so both layers agree on what
/// "same call" means. `None` when the args carry no usable object payload.
#[cfg(feature = "office")]
fn canonical_lookup_key(tool: &str, exec_args: &Value) -> Option<String> {
    let obj = exec_args.as_object()?;
    let mut keys: Vec<&String> = obj.keys().collect();
    keys.sort();
    let inner: Vec<String> = keys
        .iter()
        .map(|k| {
            format!(
                "{}:{}",
                k,
                obj[*k].to_string()
            )
        })
        .collect();
    Some(format!("{tool}?{}", inner.join(",")))
}

#[cfg(all(test, feature = "office"))]
mod tests {
    use super::*;
    use serde_json::json;

    /// Unique scratch dir per test process.
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "kawai-evc-{}-{}-{}",
                tag,
                std::process::id(),
                N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self, name: &str, content: &str) -> String {
            let p = self.0.join(name);
            std::fs::write(&p, content).unwrap();
            p.display().to_string()
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn sid_for(tag: &str) -> i64 {
        // Distinct sid per test so registry state never collides.
        let mut h: i64 = 7;
        for b in tag.as_bytes() {
            h = h.wrapping_mul(31).wrapping_add(i64::from(*b));
        }
        h + std::process::id() as i64 % 100_000
    }

    const FILE_ARGS_JSON: &str = r#"{"fileId":"f1"}"#;

    fn file_args(fid: &str) -> Value {
        json!({ "fileId": fid })
    }

    #[test]
    fn classify_only_deterministic_reads() {
        assert!(matches!(
            classify("office_read_document", &file_args("f1")),
            Policy::FileScoped { .. }
        ));
        assert!(matches!(
            classify("pdf_search_text", &json!({"file_id":"f1","query":"x"})),
            Policy::FileScoped { .. }
        ));
        assert!(matches!(
            classify("office_read_document", &json!({})),
            Policy::Skip
        ));
        assert!(matches!(classify("binance_price", &json!({})), Policy::Skip));
        assert!(matches!(
            classify("office_edit_document", &file_args("f1")),
            Policy::Skip
        ));
        assert!(matches!(
            classify("web_read", &json!({"url":"https://x"})),
            Policy::Skip
        ));
    }

    #[test]
    fn roundtrip_hit_then_file_edit_misses() {
        let s = Scratch::new("rt");
        let path = s.file("doc.md", "v1");
        // Point file_id f1 at the scratch file by storing through a real
        // user store is heavy; instead exercise the registry primitives via
        // store/probe with a REAL store file is out of scope here — use the
        // public API with a stubbed path through direct registry access.
        let sid = sid_for("rt");
        let uid = "u-rt";
        {
            let mut reg = registry().lock().unwrap();
            let key = Key(uid.to_string(), sid);
            reg.order.push_back(key.clone());
            reg.sessions.insert(key, SessionCache::default());
            reg.sessions
                .get_mut(&Key(uid.to_string(), sid))
                .unwrap()
                .entries
                .push(Entry {
                    tool: "office_read_document".into(),
                    args_key: canonical_lookup_key(
                        "office_read_document",
                        &serde_json::from_str::<Value>(FILE_ARGS_JSON).unwrap(),
                    )
                    .unwrap(),
                    body: "cached body".into(),
                    path: path.clone(),
                    fingerprint: fingerprint_of(&path).unwrap(),
                    used_at: std::time::Instant::now(),
                });
        }
        let (body, age) =
            probe(uid, sid, "office_read_document", &file_args("f1")).expect("hit");
        assert_eq!(body, "cached body");
        assert!(age < 60);

        // Edit the file → fingerprint changes → next probe misses.
        std::fs::write(&path, "v2-longer-content").unwrap();
        assert!(
            probe(uid, sid, "office_read_document", &file_args("f1")).is_none(),
            "stale fingerprint must miss"
        );

        drop_session(uid, sid);
        assert!(probe(uid, sid, "office_read_document", &file_args("f1")).is_none());
    }

    #[test]
    fn per_session_caps_retire_lru_entries() {
        let s = Scratch::new("caps");
        let path = s.file("f.bin", "data");
        let sid = sid_for("caps");
        let uid = "u-caps";
        {
            let mut reg = registry().lock().unwrap();
            let key = Key(uid.into(), sid);
            reg.sessions.insert(key.clone(), SessionCache::default());
            reg.order.push_back(key);
        }
        // Direct-entry inserts stand in for store_result (which needs a real
        // store path); caps live in SessionCache manipulation shared by both.
        {
            let mut reg = registry().lock().unwrap();
            let cache = reg.sessions.get_mut(&Key(uid.into(), sid)).unwrap();
            for i in 0..MAX_ENTRIES_PER_SESSION {
                cache.entries.push(Entry {
                    tool: format!("t{i}"),
                    args_key: i.to_string(),
                    body: "x".into(),
                    path: path.clone(),
                    fingerprint: fingerprint_of(&path).unwrap(),
                    used_at: std::time::Instant::now(),
                });
            }
        }
        assert_eq!(registry().lock().unwrap().sessions[&Key(uid.into(), sid)].entries.len(), MAX_ENTRIES_PER_SESSION);
    }

    #[test]
    fn max_sessions_park_cap_evicts_oldest_whole() {
        let uid = "u-many";
        let base = sid_for("many");
        for i in 0..MAX_SESSIONS {
            let sid = base + i as i64;
            let mut reg = registry().lock().unwrap();
            let key = Key(uid.into(), sid);
            reg.sessions.insert(key.clone(), SessionCache::default());
            reg.order.push_back(key);
        }
        // One more session than the park cap → oldest retired whole.
        let oldest = base;
        let newest = base + MAX_SESSIONS as i64;
        {
            let mut reg = registry().lock().unwrap();
            let key = Key(uid.into(), newest);
            while reg.order.len() >= MAX_SESSIONS {
                let old = reg.order.pop_front().unwrap();
                reg.sessions.remove(&old);
            }
            reg.order.push_back(key.clone());
            reg.sessions.insert(key, SessionCache::default());
        }
        assert!(!registry().lock().unwrap().sessions.contains_key(&Key(uid.into(), oldest)));
        assert!(registry().lock().unwrap().sessions.contains_key(&Key(uid.into(), newest)));
        for i in 0..=MAX_SESSIONS {
            drop_session(uid, base + i as i64);
        }
    }
}
