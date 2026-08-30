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

static WRITER: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();

fn writer() -> &'static Mutex<Option<std::fs::File>> {
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
    if let Ok(mut guard) = writer().lock() {
        if guard.is_none() {
            *guard = OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path())
                .ok();
        }
        if let Some(file) = guard.as_mut() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(file, "[{ts}] [{level}] {msg}");
        }
    }
}

#[cfg(unix)]
pub fn init() {
    use std::os::unix::io::AsRawFd;

    let path = log_path();
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            write(
                "WARN",
                &format!("cannot open log file {}: {e}", path.display()),
            );
            return;
        }
    };

    // Tee stderr: save the original fd, redirect stderr into a pipe, and
    // pump the pipe into both the terminal (original fd) and the log file.
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

        let log_fd = file.as_raw_fd();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                let n = libc::read(read_fd, buf.as_mut_ptr() as *mut _, buf.len());
                if n <= 0 {
                    break;
                }
                let slice = &buf[..n as usize];
                let _ = libc::write(saved_fd, slice.as_ptr() as *const _, n as usize);
                let mut file: std::mem::ManuallyDrop<std::fs::File> =
                    std::mem::ManuallyDrop::new(std::os::unix::io::FromRawFd::from_raw_fd(log_fd));
                let _ = file.write_all(slice);
            }
        });
        // Keep `file` alive forever: the pump writes through its fd.
        std::mem::forget(file);
    }

    write(
        "INFO",
        &format!("logging (stderr tee) to {}", path.display()),
    );
}

#[cfg(not(unix))]
pub fn init() {
    write("INFO", &format!("logging to {}", log_path().display()));
}
