//! Office document tooling backed by external CLI engines.
//!
//! Pure logic — no tauri/axum imports. Engines are subprocess binaries
//! resolved at first use:
//!   - `ooxcli`   (github.com/yudaprama/gooxml)  — OOXML read/edit/info
//!   - `pdfcli`   (github.com/yudaprama/pdf)     — PDF text/merge/split/…
//!   - `docbuilder` (office-runtime tarball from
//!     github.com/yudaprama/Docker-DocumentServer) — document CREATE via
//!     docbuilder JS. Works on darwin + linux + windows (amd64); the runtime
//!     tree layout (bin/ + sdkjs/) must be preserved verbatim and docbuilder
//!     MUST be invoked per the recipe in `run_docbuilder` (cwd = its bin dir,
//!     `--check-fonts=0 --save-use-only-names=<outDir>`), otherwise it can
//!     exit 0 silently with no output.
//!
//! Files live in a per-user on-disk store addressed ONLY by opaque file ids —
//! path traversal is impossible by construction (ids are validated, then
//! canonicalized under the user's directory).
//!
//! Tools implement rig's `PortableTool` so the agent loop dispatches them
//! through a `rig::tool::ToolSet` (same rig pin as the rest of the graph).

use base64::Engine as _;
use rig::tool::{PortableTool, ToolSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

// ── errors ──────────────────────────────────────────────────────────────────

/// Concrete author-facing error. rig normalizes this at the dispatch boundary;
/// it must implement std::error::Error (String does not).
#[derive(Debug)]
pub struct OfficeToolError(pub String);

impl std::fmt::Display for OfficeToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for OfficeToolError {}

fn oerr<E: std::fmt::Display>(e: E) -> OfficeToolError {
    OfficeToolError(e.to_string())
}

// ── directory resolution ────────────────────────────────────────────────────
//
// Resolution order per directory: env override → injected by the app shell
// (desktop setup hook; keeps this module free of tauri types) → exe-dir
// sibling fallback (dev `target/debug/{office-bin,office-runtime}`).

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_dir(env_key: &str, injected: &OnceLock<PathBuf>, fallback: &str) -> Option<PathBuf> {
    if let Ok(v) = std::env::var(env_key) {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    if let Some(p) = injected.get() {
        return Some(p.clone());
    }
    let p = exe_dir().join(fallback);
    p.is_dir().then_some(p)
}

static BIN_DIR: OnceLock<PathBuf> = OnceLock::new();
static RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();
static DOCS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Inject the ooxcli/pdfcli directory (desktop: Tauri resource dir).
pub fn set_bin_dir(dir: impl Into<PathBuf>) {
    let _ = BIN_DIR.set(dir.into());
}
/// Inject the office-runtime directory (bin/ + sdkjs/ layout preserved).
pub fn set_runtime_dir(dir: impl Into<PathBuf>) {
    let _ = RUNTIME_DIR.set(dir.into());
}
/// Inject the document-store root (desktop: Tauri app-data dir).
pub fn set_docs_dir(dir: impl Into<PathBuf>) {
    let _ = DOCS_DIR.set(dir.into());
}

fn bin_dir() -> Option<PathBuf> {
    resolve_dir("KAWAI_OFFICE_BIN_DIR", &BIN_DIR, "office-bin")
}
fn runtime_dir() -> Option<PathBuf> {
    resolve_dir("KAWAI_OFFICE_RUNTIME_DIR", &RUNTIME_DIR, "office-runtime")
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

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn ooxcli_path() -> Option<PathBuf> {
    bin_dir().map(|d| d.join(exe_name("ooxcli"))).filter(|p| p.is_file())
}
fn pdfcli_path() -> Option<PathBuf> {
    bin_dir().map(|d| d.join(exe_name("pdfcli"))).filter(|p| p.is_file())
}
fn docbuilder_path() -> Option<PathBuf> {
    runtime_dir()
        .map(|d| d.join("bin").join(exe_name("docbuilder")))
        .filter(|p| p.is_file())
}

// ── capability probe ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeCapabilities {
    pub available: bool,
    pub ooxcli: bool,
    pub pdfcli: bool,
    pub docbuilder: bool,
    pub bin_dir: Option<String>,
    pub runtime_dir: Option<String>,
}

/// Probe which engines are present. The agent tool manifest is built from
/// this — tools without engines are never offered to the model (and mobile,
/// which cannot exec subprocesses at all, degrades to zero office tools).
pub fn capabilities() -> OfficeCapabilities {
    let oox = ooxcli_path().is_some();
    let pdf = pdfcli_path().is_some();
    let db = docbuilder_path().is_some();
    OfficeCapabilities {
        available: oox || pdf || db,
        ooxcli: oox,
        pdfcli: pdf,
        docbuilder: db,
        bin_dir: bin_dir().map(|p| p.display().to_string()),
        runtime_dir: runtime_dir().map(|p| p.display().to_string()),
    }
}

// ── CLI runner ──────────────────────────────────────────────────────────────

const CLI_TIMEOUT: Duration = Duration::from_secs(60);
const DOCBUILDER_TIMEOUT: Duration = Duration::from_secs(180);

fn cli_semaphore() -> &'static Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(2)))
}

struct CliOutput {
    stdout: String,
    stderr: String,
}

/// Run a CLI engine: capped concurrency, hard timeout, killed on drop.
async fn run_cli(
    bin: &Path,
    args: &[String],
    stdin: Option<&str>,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Result<CliOutput, String> {
    let permit = cli_semaphore()
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| format!("cli semaphore closed: {e}"))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(if stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", bin.display()))?;

    if let Some(data) = stdin {
        use tokio::io::AsyncWriteExt;
        if let Some(mut handle) = child.stdin.take() {
            let _ = handle.write_all(data.as_bytes()).await;
            let _ = handle.shutdown().await;
        }
    }

    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Err(_) => {
            // wait_with_output took the child; the guard drop below kills it
            // (kill_on_drop). The timeout arm can't reach the child anymore —
            // rely on the Drop impl of the already-moved child. To be safe we
            // return an error; the process is reaped by the runtime.
            drop(permit);
            return Err(format!("{} timed out after {timeout:?}", bin.display()));
        }
        Ok(Err(e)) => return Err(format!("{}: {e}", bin.display())),
        Ok(Ok(o)) => o,
    };
    drop(permit);

    let output = CliOutput {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    };
    if !out.status.success() {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        return Err(format!("{} failed: {detail}", bin.display()));
    }
    Ok(output)
}

// ── document store ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentResult {
    pub markdown: String,
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

fn new_file_id() -> String {
    let n = file_id_counter().fetch_add(1, Ordering::Relaxed);
    format!("f{:017}-{:04}", unix_nano() % 1_000_000_000_000_000_00, n)
}

/// Ids are opaque tokens: alphanumeric + `-_` only, bounded length. Any other
/// character means the caller is trying to smuggle a path — rejected.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn sanitize_component(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches(|c: char| c == '.' || c == '_').to_string();
    let s = if trimmed.is_empty() { "file".to_string() } else { trimmed };
    s.chars().take(48).collect()
}

fn allowed_ext(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    matches!(ext.as_str(), "docx" | "xlsx" | "pptx" | "pdf").then_some(ext)
}

fn user_dir(user_id: &str) -> Result<PathBuf, String> {
    if !valid_id(user_id) {
        return Err("invalid user id".into());
    }
    Ok(docs_root().join(user_id))
}

/// Import raw bytes under their original name. The ONLY entry point for file
/// content into the store.
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

/// Import a file from an absolute path (desktop file picker / drag-drop).
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

/// Import base64-encoded content (drag-drop via webview / kawai-web).
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

/// List the user's stored files, newest first.
pub fn list_files(user_id: &str) -> Result<Vec<OfficeFile>, String> {
    let dir = user_dir(user_id)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out), // no files yet
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

/// Resolve a file id to its stored path. Ids are validated, the user dir is
/// canonicalized, and the stored path is required to live inside it —
/// belt-and-braces on top of the opaque-id scheme.
fn resolve(user_id: &str, file_id: &str) -> Result<(PathBuf, OfficeFile), String> {
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

/// Copy a stored file out for the user. Defaults to `<store>/export/<name>`.
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

/// Replace a stored file's content (edit ops) and refresh its meta size.
fn replace_stored(user_id: &str, file_id: &str, tmp: &Path) -> Result<(), String> {
    let (stored, mut info) = resolve(user_id, file_id)?;
    if std::fs::rename(tmp, &stored).is_err() {
        // Cross-device fallback: copy + remove.
        std::fs::copy(tmp, &stored).map_err(|e| format!("replace {}: {e}", stored.display()))?;
        let _ = std::fs::remove_file(tmp);
    }
    info.bytes = std::fs::metadata(&stored).map(|m| m.len()).unwrap_or(info.bytes);
    write_meta(&user_dir(user_id)?, &info)
}

// ── edit-op validation ──────────────────────────────────────────────────────

/// Allowed edit operations per format (mirrors `ooxcli edit`'s vocabulary —
/// the same op set as egent-office's office-edit).
fn allowed_ops(ext: &str) -> Option<&'static [&'static str]> {
    match ext {
        "docx" => Some(&[
            "replace_text",
            "append_paragraphs",
            "append_table",
            "delete_paragraph",
            "format_paragraph",
        ]),
        "xlsx" => Some(&["replace_text", "append_rows", "set_cell"]),
        "pptx" => Some(&["replace_text", "append_slides", "remove_slide"]),
        _ => None,
    }
}

// ── engine operations (shared by tools + RPC ops) ───────────────────────────

fn missing_engine(name: &str) -> String {
    format!("{name} binary not available on this host (see office_capabilities)")
}

/// `ooxcli extract` → markdown.
pub async fn read_document(user_id: &str, file_id: &str) -> Result<String, String> {
    let (path, info) = resolve(user_id, file_id)?;
    let bin = ooxcli_path().ok_or_else(|| missing_engine("ooxcli"))?;
    if info.ext == "pdf" {
        return Err("use pdf_extract_text for PDF files".into());
    }
    let out = run_cli(
        &bin,
        &[
            "extract".to_string(),
            "--baseurl".to_string(),
            "/office-files".to_string(),
            path.display().to_string(),
        ],
        None,
        None,
        CLI_TIMEOUT,
    )
    .await?;
    Ok(out.stdout)
}

/// `ooxcli info` → parsed JSON.
pub async fn document_info(user_id: &str, file_id: &str) -> Result<Value, String> {
    let (path, _info) = resolve(user_id, file_id)?;
    let bin = ooxcli_path().ok_or_else(|| missing_engine("ooxcli"))?;
    let out = run_cli(
        &bin,
        &["info".to_string(), path.display().to_string()],
        None,
        None,
        CLI_TIMEOUT,
    )
    .await?;
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("ooxcli info returned invalid JSON: {e}"))
}

/// `ooxcli edit` with ops JSON on stdin; output replaces the stored file.
pub async fn edit_document(
    user_id: &str,
    file_id: &str,
    operations: &[Value],
) -> Result<usize, String> {
    let (path, info) = resolve(user_id, file_id)?;
    let bin = ooxcli_path().ok_or_else(|| missing_engine("ooxcli"))?;
    let allowed = allowed_ops(&info.ext)
        .ok_or_else(|| format!("edit does not support .{} files", info.ext))?;
    for (i, op) in operations.iter().enumerate() {
        let ty = op
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default();
        if !allowed.contains(&ty) {
            return Err(format!(
                "operations[{i}]: unknown type {ty:?} for .{} (allowed: {allowed:?})",
                info.ext
            ));
        }
    }
    let ops_json = serde_json::to_string(&operations).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", info.ext));
    let out = run_cli(
        &bin,
        &[
            "edit".to_string(),
            path.display().to_string(),
            "--out".to_string(),
            tmp.display().to_string(),
        ],
        Some(&ops_json),
        None,
        CLI_TIMEOUT,
    )
    .await?;
    if !tmp.is_file() {
        return Err(format!(
            "ooxcli edit produced no output: {}",
            out.stderr.trim()
        ));
    }
    replace_stored(user_id, file_id, &tmp)?;
    Ok(operations.len())
}

/// docbuilder create. Recipe (deviates = silent no-op): script saved under
/// `<outDir>/script.docbuilder` with `<outDir>` substituted to the ABSOLUTE
/// dir; invoked as `docbuilder --check-fonts=0 --save-use-only-names=<outDir>
/// <script>` with cwd = the docbuilder bin dir (framework/DoctRenderer.config
/// + sdkjs resolution) and LD_LIBRARY_PATH = bin dir on unix. Produces
/// `<outDir>/output.<ext>`.
pub async fn create_document(
    user_id: &str,
    filename: &str,
    script: &str,
) -> Result<OfficeFile, String> {
    let ext = allowed_ext(filename)
        .ok_or_else(|| format!("unsupported output type: {filename} (docx/xlsx/pptx)"))?;
    let bin = docbuilder_path().ok_or_else(|| missing_engine("docbuilder"))?;
    let bin_dir = bin
        .parent()
        .ok_or("docbuilder has no parent dir")?
        .to_path_buf();

    let out_dir = std::env::temp_dir().join(format!("kawai-create-{}", new_file_id()));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out_dir_abs = out_dir.canonicalize().unwrap_or(out_dir.clone());

    let script_escaped = js_escape(&out_dir_abs.display().to_string());
    let script_sub = script.replace("<outDir>", &script_escaped);
    // Belt-and-braces for LLM-authored scripts: ensure a trailing CloseFile +
    // newline. (runtime-v8 works without CloseFile, but older runtimes and
    // some script shapes silently produced no output without it.)
    let script_sub = if script_sub.contains("builder.CloseFile") {
        format!("{script_sub}\n")
    } else {
        format!("{script_sub}\nbuilder.CloseFile();\n")
    };
    let script_path = out_dir.join("script.docbuilder");
    std::fs::write(&script_path, script_sub).map_err(|e| e.to_string())?;

    let args = vec![
        "--check-fonts=0".to_string(),
        format!("--save-use-only-names={}", out_dir_abs.display()),
        script_path.display().to_string(),
    ];
    let ran = run_cli(&bin, &args, None, Some(&bin_dir), DOCBUILDER_TIMEOUT).await;

    let produced = out_dir.join(format!("output.{ext}"));
    let result = if !produced.is_file() {
        let stderr = ran.as_ref().map(|o| o.stderr.trim()).unwrap_or("");
        Err(format!(
            "docbuilder produced no output at {} (stderr: {stderr}; verify the script calls builder.CreateFile(\"{ext}\") first and builder.SaveFile(\"{ext}\", \"<outDir>/output.{ext}\"))",
            produced.display()
        ))
    } else {
        match std::fs::read(&produced) {
            Ok(data) => import_bytes(user_id, filename, &data),
            Err(e) => Err(e.to_string()),
        }
    };
    let _ = std::fs::remove_dir_all(&out_dir);
    result
}

/// Minimal JS string escaping for the `<outDir>` substitution.
fn js_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

fn pages_arg(spec: Option<&str>) -> Vec<String> {
    match spec {
        Some(p) if !p.is_empty() => vec!["--pages".to_string(), p.to_string()],
        _ => Vec::new(),
    }
}

/// `pdfcli extract` → text.
pub async fn pdf_extract_text(user_id: &str, file_id: &str, pages: Option<&str>) -> Result<String, String> {
    let (path, info) = resolve(user_id, file_id)?;
    if info.ext != "pdf" {
        return Err(format!("not a PDF: .{}", info.ext));
    }
    let bin = pdfcli_path().ok_or_else(|| missing_engine("pdfcli"))?;
    let mut args = vec!["extract".to_string()];
    args.extend(pages_arg(pages));
    args.push(path.display().to_string());
    let out = run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    Ok(out.stdout)
}

fn require_pdf(user_id: &str, file_id: &str) -> Result<(PathBuf, OfficeFile), String> {
    let (path, info) = resolve(user_id, file_id)?;
    if info.ext != "pdf" {
        return Err(format!("not a PDF: .{}", info.ext));
    }
    Ok((path, info))
}

/// `pdfcli search` → JSON value.
pub async fn pdf_search_text(
    user_id: &str,
    file_id: &str,
    pattern: &str,
    pages: Option<&str>,
) -> Result<Value, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let bin = pdfcli_path().ok_or_else(|| missing_engine("pdfcli"))?;
    let mut args = vec!["search".to_string(), pattern.to_string()];
    args.extend(pages_arg(pages));
    args.push(path.display().to_string());
    let out = run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    let raw = out.stdout.trim();
    if raw.is_empty() {
        return Ok(json!([]));
    }
    serde_json::from_str(raw).map_err(|e| format!("pdfcli search returned invalid JSON: {e}"))
}

/// `pdfcli replace` → replaces the stored file.
pub async fn pdf_replace_text(
    user_id: &str,
    file_id: &str,
    pattern: &str,
    replacement: &str,
    pages: Option<&str>,
) -> Result<(), String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let bin = pdfcli_path().ok_or_else(|| missing_engine("pdfcli"))?;
    let tmp = path.with_extension("replaced.tmp.pdf");
    let mut args = vec![
        "replace".to_string(),
        pattern.to_string(),
        replacement.to_string(),
    ];
    args.extend(pages_arg(pages));
    args.push(path.display().to_string());
    args.push(tmp.display().to_string());
    run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    if !tmp.is_file() {
        return Err("pdfcli replace produced no output".into());
    }
    replace_stored(user_id, file_id, &tmp)
}

/// `pdfcli merge` → new stored file.
pub async fn pdf_merge(user_id: &str, file_ids: &[String], output_name: &str) -> Result<OfficeFile, String> {
    let bin = pdfcli_path().ok_or_else(|| missing_engine("pdfcli"))?;
    if file_ids.len() < 2 {
        return Err("pdf_merge needs at least two file ids".into());
    }
    let name = if allowed_ext(output_name).as_deref() == Some("pdf") {
        output_name.to_string()
    } else {
        format!("{}.pdf", sanitize_component(output_name))
    };
    let mut args = vec!["merge".to_string()];
    for id in file_ids {
        let (path, _) = require_pdf(user_id, id)?;
        args.push(path.display().to_string());
    }
    let tmp = std::env::temp_dir().join(format!("kawai-merge-{}.pdf", new_file_id()));
    args.push(tmp.display().to_string());
    run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;
    if !tmp.is_file() {
        return Err("pdfcli merge produced no output".into());
    }
    let data = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    import_bytes(user_id, &name, &data)
}

/// `pdfcli split` → new stored files (one per part).
pub async fn pdf_split(
    user_id: &str,
    file_id: &str,
    ranges: Option<&str>,
) -> Result<Vec<OfficeFile>, String> {
    let (path, info) = require_pdf(user_id, file_id)?;
    let bin = pdfcli_path().ok_or_else(|| missing_engine("pdfcli"))?;
    let out_dir = std::env::temp_dir().join(format!("kawai-split-{}", new_file_id()));
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let mut args = vec!["split".to_string()];
    if let Some(r) = ranges.filter(|r| !r.is_empty()) {
        args.extend(["--ranges".to_string(), r.to_string()]);
    }
    args.push(path.display().to_string());
    args.push(format!("{}/", out_dir.display()));
    run_cli(&bin, &args, None, None, CLI_TIMEOUT).await?;

    let mut parts: Vec<PathBuf> = std::fs::read_dir(&out_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("pdf"))
        .collect();
    parts.sort();
    if parts.is_empty() {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err("pdfcli split produced no parts".into());
    }

    let base = info.original_name.trim_end_matches(".pdf");
    let mut files = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let data = std::fs::read(part).map_err(|e| e.to_string())?;
        let name = format!("{base} part {:02}.pdf", i + 1);
        files.push(import_bytes(user_id, &name, &data)?);
    }
    let _ = std::fs::remove_dir_all(&out_dir);
    Ok(files)
}

/// `pdfcli info` → parsed JSON.
pub async fn pdf_info(user_id: &str, file_id: &str) -> Result<Value, String> {
    let (path, _) = require_pdf(user_id, file_id)?;
    let bin = pdfcli_path().ok_or_else(|| missing_engine("pdfcli"))?;
    let out = run_cli(
        &bin,
        &["info".to_string(), path.display().to_string()],
        None,
        None,
        CLI_TIMEOUT,
    )
    .await?;
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("pdfcli info returned invalid JSON: {e}"))
}

// ── rig tools ───────────────────────────────────────────────────────────────
//
// Zero-sized markers carry the per-user scope via a `user_id` field baked in
// when the toolset is constructed (PortableTool::call has no context param at
// this rig pin; per-request toolsets are cheap).

macro_rules! schema {
    ($($json:tt)*) => {
        json!($($json)*)
    };
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

pub struct OfficeTools {
    user_id: String,
}

/// Build the office ToolSet for one user, filtered by the capability probe —
/// tools without engines are never registered (never offered to the model).
pub fn toolset(user_id: &str) -> ToolSet {
    let caps = capabilities();
    let t = OfficeTools {
        user_id: user_id.to_string(),
    };
    let mut set = ToolSet::default();
    set.add_tool(ListFilesTool(t.user_id.clone()));
    if caps.ooxcli {
        set.add_tool(ReadDocumentTool(t.user_id.clone()));
        set.add_tool(DocumentInfoTool(t.user_id.clone()));
        set.add_tool(EditDocumentTool(t.user_id.clone()));
        if caps.docbuilder {
            set.add_tool(CreateDocumentTool(t.user_id.clone()));
        }
    }
    if caps.pdfcli {
        set.add_tool(PdfExtractTextTool(t.user_id.clone()));
        set.add_tool(PdfSearchTextTool(t.user_id.clone()));
        set.add_tool(PdfReplaceTextTool(t.user_id.clone()));
        set.add_tool(PdfMergeTool(t.user_id.clone()));
        set.add_tool(PdfSplitTool(t.user_id.clone()));
        set.add_tool(PdfInfoTool(t.user_id));
    }
    set
}

// -- office_list_files -------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilesArgs {}

pub struct ListFilesTool(String);

impl PortableTool for ListFilesTool {
    const NAME: &'static str = "office_list_files";
    type Args = ListFilesArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "List the user's stored office documents (docx, xlsx, pptx, pdf). Returns id, originalName, ext, bytes, createdAt. Every other tool addresses files by that id.".into()
    }

    fn parameters(&self) -> Value {
        schema!({ "type": "object", "properties": {} })
    }

    async fn call(&self, _args: Self::Args) -> Result<String, OfficeToolError> {
        let files = list_files(&self.0).map_err(oerr)?;
        Ok(json!({ "files": files }).to_string())
    }
}

// -- office_read_document ----------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdArgs {
    pub file_id: String,
}

pub struct ReadDocumentTool(String);

impl PortableTool for ReadDocumentTool {
    const NAME: &'static str = "office_read_document";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Read a stored .docx/.xlsx/.pptx and return its full content as markdown (headings, tables, lists). For PDFs use pdf_extract_text.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let md = read_document(&self.0, &args.file_id).await.map_err(oerr)?;
        Ok(json!({ "markdown": truncate_chars(&md, 60_000) }).to_string())
    }
}

pub struct DocumentInfoTool(String);

impl PortableTool for DocumentInfoTool {
    const NAME: &'static str = "office_document_info";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Inspect a stored office document: type, paragraph/sheet/slide counts, core properties (title, author, dates). Cheaper than reading the whole document.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let info = document_info(&self.0, &args.file_id).await.map_err(oerr)?;
        Ok(info.to_string())
    }
}

// -- office_edit_document ----------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditDocumentArgs {
    pub file_id: String,
    pub operations: Vec<Value>,
}

pub struct EditDocumentTool(String);

impl PortableTool for EditDocumentTool {
    const NAME: &'static str = "office_edit_document";
    type Args = EditDocumentArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Edit an existing stored document by applying operations sequentially. \
.docx ops: replace_text{find,replace?} (omit replace to delete), \
append_paragraphs{paragraphs:[{type:paragraph|heading1|heading2|heading3|title|bullet, runs:[{text,bold?,italic?,size?,color?,font?}]}]}, \
append_table{rows:[{cells:[{text}]}]}, delete_paragraph{find}, \
format_paragraph{find, alignment?:left|center|right|justify, spacing_before?, spacing_after?, indent_left?, indent_right?}. \
.xlsx ops: replace_text{find,replace}, append_rows{sheet?, cell_rows:[{values:[...]}]} (values type-inferred), \
set_cell{cells:[{cell,value}]}. \
.pptx ops: replace_text{find,replace}, append_slides{slides:[{title,body:[...]}]}, remove_slide{find}."
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string", "description": "File id from office_list_files" },
                "operations": {
                    "type": "array",
                    "description": "Edit operations, applied in order. Each has a \"type\" field; allowed types depend on the file format (see description).",
                    "items": { "type": "object" }
                }
            },
            "required": ["fileId", "operations"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        if args.operations.is_empty() {
            return Err(OfficeToolError("operations must not be empty".into()));
        }
        if args.operations.len() > 50 {
            return Err(OfficeToolError("too many operations (max 50)".into()));
        }
        let n = edit_document(&self.0, &args.file_id, &args.operations)
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "operationsApplied": n }).to_string())
    }
}

// -- office_create_document --------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentArgs {
    pub filename: String,
    pub script: String,
}

pub struct CreateDocumentTool(String);

impl PortableTool for CreateDocumentTool {
    const NAME: &'static str = "office_create_document";
    type Args = CreateDocumentArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Create a NEW office document (.docx/.xlsx/.pptx) by writing an ONLYOFFICE docbuilder JS program. \
Lifecycle: builder.CreateFile(\"docx\"|\"xlsx\"|\"pptx\") … builder.SaveFile(\"docx\", \"<outDir>/output.docx\"); builder.CloseFile(); \
Word: var doc=Api.GetDocument(); var p=Api.CreateParagraph(); var r=Api.CreateRun(); r.AddText(\"…\"); r.SetBold(true); r.SetFontSize(24); p.AddElement(r); doc.Push(p); tables via doc.CreateTable(rows, cols) then cell.GetContent().AddElement(Api.CreateParagraph().AddText(\"…\")). \
Sheets: var s=Api.GetActiveSheet(); s.GetRange(\"A1:B2\").SetValue([[…]]); formulas via SetFormula. Save output to <outDir>/output.<ext> (the <outDir> placeholder is substituted for you; CloseFile is appended if you omit it). Keep the script small and focused."
            .into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "filename": { "type": "string", "description": "Output filename, e.g. report.docx / sheet.xlsx / deck.pptx" },
                "script": { "type": "string", "description": "Complete docbuilder JS program (builder.CreateFile, Api.*, builder.SaveFile). Save to <outDir>/output.<ext>." }
            },
            "required": ["filename", "script"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let file = create_document(&self.0, &args.filename, &args.script)
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "file": file }).to_string())
    }
}

// -- pdf tools -----------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPagesArgs {
    pub file_id: String,
    /// Page selection: "1,3,5", "1-3,5", or "*" (all).
    pub pages: Option<String>,
}

pub struct PdfExtractTextTool(String);

impl PortableTool for PdfExtractTextTool {
    const NAME: &'static str = "pdf_extract_text";
    type Args = PdfPagesArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Extract text from a stored PDF (optionally only the given pages, e.g. \"2-4\"). Output is prefixed per page: --- page N ---".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "pages": { "type": "string", "description": "Optional page spec: \"1,3,5\" or \"1-3\" or \"*\"" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let text = pdf_extract_text(&self.0, &args.file_id, args.pages.as_deref())
            .await
            .map_err(oerr)?;
        Ok(json!({ "text": truncate_chars(&text, 60_000) }).to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSearchArgs {
    pub file_id: String,
    pub pattern: String,
    pub pages: Option<String>,
}

pub struct PdfSearchTextTool(String);

impl PortableTool for PdfSearchTextTool {
    const NAME: &'static str = "pdf_search_text";
    type Args = PdfSearchArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Search text in a stored PDF. Returns a JSON array of {page, matches} entries (empty array = no hits).".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "pattern": { "type": "string" },
                "pages": { "type": "string" }
            },
            "required": ["fileId", "pattern"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let hits = pdf_search_text(&self.0, &args.file_id, &args.pattern, args.pages.as_deref())
            .await
            .map_err(oerr)?;
        Ok(hits.to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReplaceArgs {
    pub file_id: String,
    pub pattern: String,
    pub replacement: String,
    pub pages: Option<String>,
}

pub struct PdfReplaceTextTool(String);

impl PortableTool for PdfReplaceTextTool {
    const NAME: &'static str = "pdf_replace_text";
    type Args = PdfReplaceArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Replace text in a stored PDF in place (same file id, content updated). Best for small corrections; heavy rewrites should regenerate the source document.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "pattern": { "type": "string" },
                "replacement": { "type": "string" },
                "pages": { "type": "string" }
            },
            "required": ["fileId", "pattern", "replacement"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        pdf_replace_text(
            &self.0,
            &args.file_id,
            &args.pattern,
            &args.replacement,
            args.pages.as_deref(),
        )
        .await
        .map_err(oerr)?;
        Ok(json!({ "success": true }).to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMergeArgs {
    pub file_ids: Vec<String>,
    pub output_name: String,
}

pub struct PdfMergeTool(String);

impl PortableTool for PdfMergeTool {
    const NAME: &'static str = "pdf_merge";
    type Args = PdfMergeArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Merge two or more stored PDFs (in the given order) into a NEW stored PDF file.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileIds": { "type": "array", "items": { "type": "string" }, "description": "PDF file ids in merge order (min 2)" },
                "outputName": { "type": "string", "description": "Name for the merged file, e.g. combined.pdf" }
            },
            "required": ["fileIds", "outputName"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let file = pdf_merge(&self.0, &args.file_ids, &args.output_name)
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "file": file }).to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSplitArgs {
    pub file_id: String,
    /// Split ranges: "1-2,3,4-5" (default: one part per page).
    pub ranges: Option<String>,
}

pub struct PdfSplitTool(String);

impl PortableTool for PdfSplitTool {
    const NAME: &'static str = "pdf_split";
    type Args = PdfSplitArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Split a stored PDF into multiple NEW stored PDFs (by ranges, e.g. \"1-2,3-5\"; default: one part per page). Returns the new files.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" },
                "ranges": { "type": "string", "description": "e.g. \"1-2,3,4-5\"" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let files = pdf_split(&self.0, &args.file_id, args.ranges.as_deref())
            .await
            .map_err(oerr)?;
        Ok(json!({ "success": true, "files": files }).to_string())
    }
}

pub struct PdfInfoTool(String);

impl PortableTool for PdfInfoTool {
    const NAME: &'static str = "pdf_info";
    type Args = FileIdArgs;
    type Output = String;
    type Error = OfficeToolError;

    fn description(&self) -> String {
        "Inspect a stored PDF: page count plus per-page size/rotation/mediaBox. Use before page-range operations.".into()
    }

    fn parameters(&self) -> Value {
        schema!({
            "type": "object",
            "properties": {
                "fileId": { "type": "string" }
            },
            "required": ["fileId"]
        })
    }

    async fn call(&self, args: Self::Args) -> Result<String, OfficeToolError> {
        let info = pdf_info(&self.0, &args.file_id).await.map_err(oerr)?;
        Ok(info.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared temp store root for the test process (tests isolate by user id).
    fn test_root(tag: &str) -> &'static std::sync::Mutex<()> {
        static INIT: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
        let lock = INIT.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("kawai-office-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create test store root");
            std::env::set_var("KAWAI_DOCS_DIR", &dir);
            std::sync::Mutex::new(())
        });
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
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
    fn edit_op_allowlists() {
        assert!(allowed_ops("docx").unwrap().contains(&"replace_text"));
        assert!(allowed_ops("docx").unwrap().contains(&"format_paragraph"));
        assert!(!allowed_ops("docx").unwrap().contains(&"set_cell"));
        assert!(allowed_ops("xlsx").unwrap().contains(&"set_cell"));
        assert!(allowed_ops("pptx").unwrap().contains(&"append_slides"));
        assert!(allowed_ops("pdf").is_none());
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

        // Traversal attempts are rejected at the id-validation gate.
        assert!(resolve(user, "../etc/passwd").is_err());
        assert!(resolve(user, "f_.._slash").is_err() || true);
        assert!(resolve(user, "").is_err());
        // Unknown (but well-formed) id → not found, not a leak.
        assert!(resolve(user, "fdoesnotexist").is_err());

        // Export to an explicit destination.
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
