//! File logging for kawai (dev-facing). std + libc only — no tauri/axum —
//! so it stays usable from any layer.
//!
//! Two capture mechanisms:
//! 1. `write(level, msg)` — explicit, timestamped lines (used by the
//!    `frontend_log` command).
//! 2. `init()` — tees the whole process stderr into the log file (Rust
//!    panics, `eprintln!`, and the LiteRT-LM C++ engine's absl ERROR logs),
//!    while still printing to the terminal. Unix only; other platforms get
//!    mechanism 1 only.
//!
//! Log location: delegated to `kawai_paths::log_file()`.
//! Deliberately OUTSIDE `src-tauri/` so the `tauri dev` file watcher
//! doesn't rebuild-loop on log writes.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use kawai_paths;
use std::sync::{Mutex, OnceLock};

/// The open log file plus the path it was opened from. Re-resolved on every
/// append: the Tauri shell injects the log dir in `setup`, which runs AFTER
/// `init()`, and on Android the pre-injection path (`<temp>/kawai`) is not
/// writable at all — a cached handle would pin every later write to a dead
/// path.
static WRITER: OnceLock<Mutex<Option<(PathBuf, std::fs::File)>>> = OnceLock::new();

fn writer() -> &'static Mutex<Option<(PathBuf, std::fs::File)>> {
    WRITER.get_or_init(|| Mutex::new(None))
}

pub fn log_path() -> PathBuf {
    let path = kawai_paths::log_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    path
}

/// Append one timestamped line to the log file.
pub fn write(level: &str, msg: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    append_raw(format!("[{ts}] [{level}] {msg}\n").as_bytes());
    // The file is local-only. Mirror into `tracing` so the same line reaches
    // the remote layer (Grafana Loki) — the ONLY channel a physical phone has
    // (no terminal, no `run-as` on a signed APK). The level decides shipping:
    // release builds export WARN/ERROR, debug builds INFO and above.
    mirror_to_tracing(level, msg);
}

fn mirror_to_tracing(level: &str, msg: &str) {
    match level.to_ascii_lowercase().as_str() {
        "error" | "fatal" => tracing::error!(target: "frontend", "{msg}"),
        "warn" | "warning" => tracing::warn!(target: "frontend", "{msg}"),
        "info" => tracing::info!(target: "frontend", "{msg}"),
        other => tracing::debug!(target: "frontend", level = other, "{msg}"),
    }
}

/// Append bytes verbatim (the stderr tee path — no timestamp rewriting).
fn append_raw(bytes: &[u8]) {
    let Ok(mut guard) = writer().lock() else { return };
    let path = log_path();
    // Reopen when the resolved path changed (log-dir injection landed after
    // the first write) or the handle is missing (recoverable open failure).
    let needs_open = match guard.as_ref() {
        Some((opened, _)) => opened != &path,
        None => true,
    };
    if needs_open {
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => *guard = Some((path, file)),
            Err(e) => {
                // Report once per path, never per line: a chatty failure loop
                // would flood logcat exactly when there is nowhere to write.
                if !open_failure_reported(&path) {
                    eprintln!("[kawai] cannot open log file {}: {e}", path.display());
                }
                return;
            }
        }
    }
    if let Some((_, file)) = guard.as_mut() {
        let _ = file.write_all(bytes);
        let _ = file.flush();
    }
}


/// Paths whose open already failed — one stderr line each, so a persistently
/// unwritable log dir reports once instead of once per log line.
fn open_failure_reported(path: &std::path::Path) -> bool {
    static FAILED: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    let Ok(mut failed) = FAILED.get_or_init(|| Mutex::new(Vec::new())).lock() else {
        return false;
    };
    if failed.iter().any(|p| p == path) {
        return true;
    }
    failed.push(path.to_path_buf());
    false
}

#[cfg(unix)]
pub fn init() {
    // Tee stderr: save the original fd, redirect stderr into a pipe, and pump
    // the pipe into both the terminal (original fd) and the log file. The
    // tee is installed UNCONDITIONALLY — a log path that cannot be opened yet
    // (the shell injects the real log dir in `setup`, and on Android even the
    // pre-injection path is unwritable) must not silently disable capture for
    // the rest of the process; `append_raw` retries the open on every write.
    unsafe {
        let mut fds = [0i32; 2];
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return;
        }
        let (read_fd, write_fd) = (fds[0], fds[1]);
        let saved_fd = libc::dup(2);
        if saved_fd < 0 || libc::dup2(write_fd, 2) < 0 {
            return;
        }
        // The write end must be closed in this process so the pump sees EOF
        // on exit; stderr keeps its own duplicate.
        libc::close(write_fd);

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                let n = libc::read(read_fd, buf.as_mut_ptr() as *mut _, buf.len());
                if n <= 0 {
                    break;
                }
                let slice = &buf[..n as usize];
                let _ = libc::write(saved_fd, slice.as_ptr() as *const _, n as usize);
                append_raw(slice);
            }
        });
    }

    write("INFO", &format!("logging (stderr tee) to {}", log_path().display()));
}

#[cfg(not(unix))]
pub fn init() {
    write("INFO", &format!("logging to {}", log_path().display()));
}
