//! Shared executor for the `pdfcli` binary. Hand-written analog of
//! `httpclient.rs` in the generated crates: instead of issuing HTTP requests it
//! shells out to the `pdfcli` binary built from `pdf/cmd/pdfcli`.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

/// Per-crate tool configuration. Cloned into every tool instance.
#[derive(Debug, Clone, Default)]
pub struct ToolOptions {
    /// Path to the `pdfcli` binary. Defaults to `$PDFCLI_BIN`, then `pdfcli` on PATH.
    pub bin_path: Option<PathBuf>,
    /// Optional gate run before every invocation. An error aborts the call.
    pub pre_check: Option<fn() -> Result<(), ToolError>>,
}

impl ToolOptions {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_bin_path(mut self, p: impl Into<PathBuf>) -> Self {
        self.bin_path = Some(p.into());
        self
    }
}

#[derive(Debug, Clone)]
pub struct ToolBase {
    bin_path: PathBuf,
    pre_check: Option<fn() -> Result<(), ToolError>>,
}

impl Default for ToolBase {
    fn default() -> Self {
        Self::new(ToolOptions::default())
    }
}

impl ToolBase {
    pub fn new(opts: ToolOptions) -> Self {
        let bin_path = opts.bin_path.unwrap_or_else(|| {
            std::env::var("PDFCLI_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("pdfcli"))
        });
        Self {
            bin_path,
            pre_check: opts.pre_check,
        }
    }

    /// Path to the resolved `pdfcli` binary.
    pub fn bin_path(&self) -> &std::path::Path {
        &self.bin_path
    }

    /// Run `pdfcli <args>`, returning stdout on success. On a non-zero exit the
    /// captured stderr is returned as `ToolError::PdfCli`.
    pub async fn run(&self, args: &[String]) -> Result<String, ToolError> {
        if let Some(check) = self.pre_check {
            check()?;
        }
        let output = Command::new(&self.bin_path)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            return Err(ToolError::PdfCli {
                args: args.to_vec(),
                stderr,
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Run `pdfcli <args>` and parse stdout as JSON.
    pub async fn run_json(&self, args: &[String]) -> Result<serde_json::Value, ToolError> {
        let stdout = self.run(args).await?;
        Ok(serde_json::from_str(&stdout)?)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("pdfcli failed ({args:?}): {stderr}")]
    PdfCli {
        args: Vec<String>,
        stderr: String,
    },
}

impl ToolError {
    pub fn io(e: std::io::Error) -> Self {
        Self::Io(e)
    }
    pub fn json(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
    pub fn pdfcli(args: Vec<String>, stderr: String) -> Self {
        Self::PdfCli { args, stderr }
    }
}
