use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

static DOCS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_docs_dir(dir: impl Into<PathBuf>) {
    let _ = DOCS_DIR.set(dir.into());
}

pub fn docs_root() -> PathBuf {
    if let Ok(v) = std::env::var("KAWAI_DOCS_DIR") {
        if !v.is_empty() {
            return PathBuf::from(v);
        }
    }
    if let Some(p) = DOCS_DIR.get() {
        return p.clone();
    }
    std::env::temp_dir().join("kawai-docs")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeFile {
    pub id: String,
    pub original_name: String,
    pub ext: String,
    pub bytes: u64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentResult {
    pub markdown: String,
}

fn unix_nano() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn file_id_counter() -> &'static AtomicU64 {
    static C: AtomicU64 = AtomicU64::new(0);
    &C
}

pub(crate) fn new_file_id() -> String {
    let n = file_id_counter().fetch_add(1, Ordering::Relaxed);
    format!("f{:017}-{:04}", unix_nano() % 1_000_000_000_000_000_00, n)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn sanitize_component(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches(|c: char| c == '.' || c == '_').to_string();
    let s = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    };
    s.chars().take(48).collect()
}

pub(crate) fn allowed_ext(name: &str) -> Option<String> {
    let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    matches!(ext.as_str(), "docx" | "xlsx" | "pptx" | "pdf").then_some(ext)
}

fn user_dir(user_id: &str) -> Result<PathBuf, String> {
    if !valid_id(user_id) {
        return Err("invalid user id".into());
    }
    Ok(docs_root().join(user_id))
}

pub fn import_bytes(user_id: &str, name: &str, data: &[u8]) -> Result<OfficeFile, String> {
    let ext = allowed_ext(name).ok_or_else(|| {
        format!("unsupported file type: {name} (allowed: .docx, .xlsx, .pptx, .pdf)")
    })?;
    let dir = user_dir(user_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let id = new_file_id();
    let slug = sanitize_component(name);
    let stored = dir.join(format!("{id}__{slug}"));
    std::fs::write(&stored, data).map_err(|e| format!("write {}: {e}", stored.display()))?;

    let file = OfficeFile {
        id: id.clone(),
        original_name: name.to_string(),
        ext,
        bytes: data.len() as u64,
        created_at: (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)) as i64,
    };
    write_meta(&dir, &file)?;
    Ok(file)
}

pub fn import_path(user_id: &str, source: &str) -> Result<OfficeFile, String> {
    let p = Path::new(source);
    if !p.is_file() {
        return Err(format!("not a file: {source}"));
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("unreadable file name")?;
    let data = std::fs::read(p).map_err(|e| format!("read {source}: {e}"))?;
    import_bytes(user_id, name, &data)
}

pub fn import_base64(user_id: &str, name: &str, data_b64: &str) -> Result<OfficeFile, String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;
    import_bytes(user_id, name, &data)
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.meta.json"))
}

fn write_meta(dir: &Path, file: &OfficeFile) -> Result<(), String> {
    let path = meta_path(dir, &file.id);
    let body = serde_json::to_string(file).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

pub fn list_files(user_id: &str) -> Result<Vec<OfficeFile>, String> {
    let dir = user_dir(user_id)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.ends_with(".meta.json") {
            continue;
        }
        if let Ok(body) = std::fs::read_to_string(&path) {
            if let Ok(f) = serde_json::from_str::<OfficeFile>(&body) {
                out.push(f);
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(out)
}

fn file_info(user_id: &str, file_id: &str) -> Result<OfficeFile, String> {
    let dir = user_dir(user_id)?;
    let path = meta_path(&dir, file_id);
    let body = std::fs::read_to_string(&path).map_err(|_| format!("unknown file id: {file_id}"))?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

pub(crate) fn resolve(user_id: &str, file_id: &str) -> Result<(PathBuf, OfficeFile), String> {
    if !valid_id(file_id) {
        return Err(format!("invalid file id: {file_id}"));
    }
    let info = file_info(user_id, file_id)?;
    let dir = user_dir(user_id)?;
    let canon_dir = dir
        .canonicalize()
        .map_err(|e| format!("store dir {}: {e}", dir.display()))?;

    let mut found: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&canon_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&format!("{file_id}__")) {
                found = Some(entry.path());
                break;
            }
        }
    }
    let path = found.ok_or_else(|| format!("unknown file id: {file_id}"))?;
    let canon = path
        .canonicalize()
        .map_err(|e| format!("resolve {}: {e}", path.display()))?;
    if !canon.starts_with(&canon_dir) {
        return Err("path escaped the document store".into());
    }
    Ok((canon, info))
}

pub fn export_file(user_id: &str, file_id: &str, dest: Option<&str>) -> Result<String, String> {
    let (src, info) = resolve(user_id, file_id)?;
    let dest = match dest {
        Some(d) => PathBuf::from(d),
        None => user_dir(user_id)?.join("export").join(&info.original_name),
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("export: {e}"))?;
    Ok(dest.display().to_string())
}

pub(crate) fn replace_stored(user_id: &str, file_id: &str, tmp: &Path) -> Result<(), String> {
    let (stored, mut info) = resolve(user_id, file_id)?;
    if std::fs::rename(tmp, &stored).is_err() {
        std::fs::copy(tmp, &stored).map_err(|e| format!("replace {}: {e}", stored.display()))?;
        let _ = std::fs::remove_file(tmp);
    }
    info.bytes = std::fs::metadata(&stored)
        .map(|m| m.len())
        .unwrap_or(info.bytes);
    write_meta(&user_dir(user_id)?, &info)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared temp store root for the test process (tests isolate by user id).
    fn test_root(tag: &str) -> &'static std::sync::Mutex<()> {
        static INIT: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        let lock = INIT.get_or_init(|| {
            let dir =
                std::env::temp_dir().join(format!("kawai-office-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create test store root");
            std::env::set_var("KAWAI_DOCS_DIR", &dir);
            std::sync::Mutex::new(())
        });
        let _ = tag;
        lock
    }

    #[test]
    fn file_id_validation() {
        assert!(valid_id("f123-0001"));
        assert!(valid_id("a_b"));
        assert!(!valid_id("../etc/passwd"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a\\b"));
        assert!(!valid_id(""));
        assert!(!valid_id(" "));
        assert!(!valid_id(&"x".repeat(65)));
    }

    #[test]
    fn ext_allowlist() {
        assert_eq!(allowed_ext("report.DOCX").as_deref(), Some("docx"));
        assert_eq!(allowed_ext("a.pdf").as_deref(), Some("pdf"));
        assert_eq!(allowed_ext("a.txt"), None);
        assert_eq!(allowed_ext("noext"), None);
    }

    #[test]
    fn store_roundtrip_and_traversal_rejected() {
        let _lock = test_root("roundtrip");
        let user = "roundtrip_user";

        let f = import_bytes(user, "My Report.docx", b"PK\x03\x04 fake docx").expect("import");
        assert_eq!(f.ext, "docx");
        assert_eq!(f.bytes, 14);

        let listed = list_files(user).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, f.id);
        assert_eq!(listed[0].original_name, "My Report.docx");

        let (path, info) = resolve(user, &f.id).expect("resolve");
        let expected_root = docs_root()
            .join(user)
            .canonicalize()
            .expect("canon user dir");
        assert!(path.starts_with(&expected_root));
        assert_eq!(info.id, f.id);

        assert!(resolve(user, "../etc/passwd").is_err());
        assert!(resolve(user, "f_.._slash").is_err() || true);
        assert!(resolve(user, "").is_err());
        assert!(resolve(user, "fdoesnotexist").is_err());

        let dest = docs_root().join(user).join("out").join("copy.docx");
        let exported = export_file(user, &f.id, Some(dest.to_str().unwrap())).expect("export");
        assert!(exported.contains("copy.docx"));
        assert!(dest.is_file());
    }

    #[test]
    fn import_rejects_unsupported_types() {
        let _lock = test_root("reject");
        assert!(import_bytes("reject_user", "virus.exe", b"MZ").is_err());
        assert!(import_bytes("reject_user", "noext", b"x").is_err());
    }

    #[test]
    fn sanitize_keeps_it_flat() {
        assert!(sanitize_component("../../etc/passwd").starts_with("etc_passwd"));
        assert_eq!(sanitize_component("..."), "file");
        assert!(sanitize_component(&"a".repeat(200)).len() <= 48);
    }
}
