use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Semaphore;

pub(crate) const CLI_TIMEOUT: Duration = Duration::from_secs(60);

static BIN_DIR: OnceLock<PathBuf> = OnceLock::new();

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

pub fn set_bin_dir(dir: impl Into<PathBuf>) {
    let _ = BIN_DIR.set(dir.into());
}

fn bin_dir() -> Option<PathBuf> {
    resolve_dir("KAWAI_OFFICE_BIN_DIR", &BIN_DIR, "office-bin")
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

pub(crate) fn ooxcli_path() -> Option<PathBuf> {
    bin_dir()
        .map(|d| d.join(exe_name("ooxcli")))
        .filter(|p| p.is_file())
}

pub(crate) fn pdfcli_path() -> Option<PathBuf> {
    bin_dir()
        .map(|d| d.join(exe_name("pdfcli")))
        .filter(|p| p.is_file())
}

pub(crate) fn missing_engine(name: &str) -> String {
    format!("{name} binary not available on this host (see office_capabilities)")
}

fn cli_semaphore() -> &'static Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(2)))
}

pub(crate) struct CliOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) async fn run_cli(
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

pub(crate) fn bin_dir_str() -> Option<String> {
    bin_dir().map(|p| p.display().to_string())
}
