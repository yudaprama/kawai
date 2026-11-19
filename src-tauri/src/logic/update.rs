//! App self-update for the Android builds — manifest check + APK download.
//!
//! Two distribution channels, one manifest:
//! * `apk` (the QRIS/GitHub-Releases sideload build): download the new APK to
//!   `<app_data>/updates/`, verify its sha256 against the manifest, then hand
//!   it to Android's system package installer (the JNI side lives at the
//!   transport edge in `crate::update_installer` — this module stays pure).
//! * `play` (the `iap` build): no APK download — the UI opens the Play store
//!   listing, where Play serves the update. Google forbids self-updating APKs
//!   inside Play-distributed apps, and `release-android-build.yml` strips the
//!   `REQUEST_INSTALL_PACKAGES` permission from that variant at build time.
//!
//! The manifest is `latest-android.json` in the root of the latest PUBLISHED
//! GitHub release (the QRIS job writes it alongside the APK — never desktop's
//! `latest.json`, which tauri-action owns and would clobber). It mirrors the
//! Tauri updater shape so the two clients stay conceptually identical:
//!
//! ```json
//! { "version": "0.3.42", "pub_date": "…", "notes": "…",
//!   "platforms": { "android-aarch64": { "url": "…", "sha256": "…", "size": 123 } } }
//! ```
//!
//! Pure reqwest/futures — shared by the Tauri commands and the web routes.
//! No tauri/axum types here.

use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Where the Android updater manifest is published. `releases/latest/download`
/// resolves against the latest published (non-draft, non-prerelease) release —
/// exactly when the APK behind the manifest is actually installable.
pub const UPDATE_ENDPOINT: &str =
    "https://github.com/yudaprama/kawai/releases/latest/download/latest-android.json";

/// The manifest key this client reads. arm64-only builds: litert pins the
/// release to aarch64 (see AGENTS.md "Mobile LLM builds").
const ANDROID_PLATFORM: &str = "android-aarch64";

/// The distribution channel this build serves: `iap` ⇒ Play. Compile-time, so
/// the frontend never probes anything — it asks the backend, same pattern as
/// `topup::iap_available`.
pub fn channel() -> &'static str {
    if cfg!(feature = "iap") {
        "play"
    } else {
        "apk"
    }
}

/// The store listing, for the play channel's "open Play Store" action.
pub const STORE_URL: &str = "https://play.google.com/store/apps/details?id=pro.kawai.app";

/// One published update, as served to the UI. `channel` decides the flow:
/// `apk` downloads + installs this URL, `play` opens the store listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pub_date: Option<String>,
    pub url: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// `"apk"` (sideload: download + system installer) or `"play"` (open the
    /// store listing). Set server-side from the build feature, never trusted
    /// from the client.
    pub channel: String,
}

/// Stream events for `update_download_and_install`. Terminal variants are
/// `finished` / `error` (invariant: `#[serde(tag = "type")]`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum UpdateEvent {
    Progress { received: u64, total: u64 },
    Finished { path: String },
    Error { message: String },
}

/// The wire format of `latest-android.json` (Tauri-updater-shaped).
#[derive(Deserialize)]
struct UpdateManifest {
    version: String,
    notes: Option<String>,
    pub_date: Option<String>,
    platforms: HashMap<String, PlatformEntry>,
}

#[derive(Deserialize)]
struct PlatformEntry {
    url: String,
    sha256: String,
    size: Option<u64>,
}

/// Parse + normalize a manifest. Public for tests.
pub fn parse_manifest(raw: &str) -> Result<UpdateInfo, String> {
    let manifest: UpdateManifest =
        serde_json::from_str(raw).map_err(|e| format!("update manifest unreadable: {e}"))?;
    let entry = manifest
        .platforms
        .get(ANDROID_PLATFORM)
        .ok_or_else(|| format!("update manifest has no {ANDROID_PLATFORM} entry"))?;
    let sha256 = entry.sha256.trim().to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("update manifest sha256 is not a 64-char hex digest".into());
    }
    if manifest.version.trim().is_empty() || entry.url.trim().is_empty() {
        return Err("update manifest is missing version or url".into());
    }
    Ok(UpdateInfo {
        version: manifest.version.trim().to_string(),
        notes: manifest.notes,
        pub_date: manifest.pub_date,
        url: entry.url.trim().to_string(),
        sha256,
        size: entry.size,
        channel: channel().to_string(),
    })
}

/// Semver-ish dotted-numeric compare: `is_newer("0.3.42", "0.3.9")` is true.
/// Anything non-numeric (or equal) is "not newer" — a weird tag never
/// triggers a downgrade prompt.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Option<Vec<u64>> {
        v.trim()
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect()
    };
    let (Some(candidate), Some(current)) = (parse(candidate), parse(current)) else {
        return false;
    };
    for i in 0..candidate.len().max(current.len()) {
        let c = candidate.get(i).copied().unwrap_or(0);
        let cur = current.get(i).copied().unwrap_or(0);
        if c != cur {
            return c > cur;
        }
    }
    false
}

/// Fetch the manifest and resolve it against `current_version`. `None` = up
/// to date (or no manifest published yet — a 404 on a fresh repo is normal,
/// never an error the UI nags about).
pub async fn check_update(current_version: &str) -> Result<Option<UpdateInfo>, String> {
    let client = crate::logic::local_auth::worker_client();
    let response = client
        .get(UPDATE_ENDPOINT)
        .send()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response
        .error_for_status()
        .map_err(|e| format!("update check failed: {e}"))?;
    let raw = response
        .text()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;
    let info = parse_manifest(&raw)?;
    if !is_newer(&info.version, current_version) {
        return Ok(None);
    }
    Ok(Some(info))
}

/// Download destination: `<data_root>/updates/` — the app-private files dir
/// on Android (the shell injects app_data_dir as the data root), which the
/// manifest's FileProvider `<files-path>` entry must cover for the installer
/// to hand the file to the system installer.
pub fn updates_dir() -> PathBuf {
    kawai_paths::data_root().join("updates")
}

/// deterministic per-version name, so a re-download overwrites in place.
pub fn apk_path(version: &str) -> PathBuf {
    updates_dir().join(format!("kawai-{version}-android-aarch64.apk"))
}

/// Stream `url` to `dest` (`.part` then atomic rename), sha256-verifying
/// against `expected_sha256`, reporting `(received, total)` through the
/// callback per chunk. A mismatch or truncated download deletes the file —
/// a half-written APK must never reach the installer.
async fn download_inner(
    info: &UpdateInfo,
    dest: &Path,
    on_progress: impl Fn(u64, u64) + Send + Sync,
) -> Result<(), String> {
    // The shared worker_client caps at 30s TOTAL — far under a GB-scale APK.
    // This client keeps only a connect timeout; the body runs as long as it
    // makes progress.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("download client build failed: {e}"))?;
    let mut response = client
        .get(&info.url)
        .send()
        .await
        .map_err(|e| format!("update download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("update download failed: {e}"))?;

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("update dir create failed: {e}"))?;
    }
    let part = dest.with_extension("apk.part");
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("update file create failed: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut received: u64 = 0;
    // The manifest's Content-Length, when present (GitHub assets always send it).
    let total = response.content_length().unwrap_or(0);

    use tokio::io::AsyncWriteExt as _;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("update download interrupted: {e}"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("update write failed: {e}"))?;
        received += chunk.len() as u64;
        on_progress(received, total);
    }
    file.flush()
        .await
        .map_err(|e| format!("update write failed: {e}"))?;
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if actual != info.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "update download failed sha256 verification (expected {}, got {actual})",
            info.sha256
        ));
    }
    if info.size.is_some_and(|size| received != size) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "update download is {received} bytes but the manifest says {}",
            info.size.unwrap()
        ));
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| format!("update finalize failed: {e}"))?;
    Ok(())
}

/// `download_inner` as a terminal-event stream (`progress`… then exactly one
/// `finished`/`error`). The download runs on its own task so progress events
/// interleave with it; dropping the stream early aborts the task, so a
/// cancelled stream stops the HTTP body too.
pub fn download_stream(
    info: UpdateInfo,
    dest: PathBuf,
) -> impl futures_util::Stream<Item = UpdateEvent> {
    async_stream::stream! {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();

        // Dropping the stream (cancellation) must stop the download task —
        // JoinHandle::drop detaches, so hold the handle behind an aborting
        // guard instead. `async_stream` streams are not `Unpin`, but a guard
        // is: the select below awaits `&mut task.0`, which is `JoinHandle`,
        // an `Unpin` future.
        struct AbortOnDrop(tokio::task::JoinHandle<(Result<(), String>, PathBuf)>);
        impl Drop for AbortOnDrop {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let mut task = AbortOnDrop(tokio::spawn({
            let info = info.clone();
            let dest = dest.clone();
            async move {
                let result = download_inner(&info, &dest, |received, total| {
                    let _ = tx.send((received, total));
                })
                .await;
                // tx drops with the task body, closing the progress channel.
                (result, dest)
            }
        }));

        // Exactly one terminal: the task arm for an early finish, the `None`
        // arm when progress closed first (all senders dropped ⇒ the task
        // body ran to its end, so awaiting the handle returns immediately).
        let terminal = loop {
            tokio::select! {
                maybe = rx.recv() => match maybe {
                    Some((received, total)) => {
                        yield UpdateEvent::Progress { received, total };
                    }
                    None => break (&mut task.0).await,
                },
                result = &mut task.0 => break result,
            }
        };

        match terminal {
            Ok((Ok(()), path)) => {
                yield UpdateEvent::Finished {
                    path: path.to_string_lossy().into_owned(),
                }
            }
            Ok((Err(message), _)) => {
                let _ = tokio::fs::remove_file(dest.with_extension("apk.part")).await;
                yield UpdateEvent::Error { message };
            }
            Err(join_error) => yield UpdateEvent::Error {
                message: format!("update download task failed: {join_error}"),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"{
        "version": "0.3.42",
        "pub_date": "2026-11-19T10:00:00Z",
        "notes": "bug fixes",
        "platforms": {
            "android-aarch64": {
                "url": "https://github.com/yudaprama/kawai/releases/download/v0.3.42/kawai-0.3.42-android-aarch64.apk",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "size": 123456
            }
        }
    }"#;

    #[test]
    fn manifest_parses_with_channel_from_build() {
        let info = parse_manifest(MANIFEST).expect("valid manifest parses");
        assert_eq!(info.version, "0.3.42");
        assert_eq!(info.notes.as_deref(), Some("bug fixes"));
        assert_eq!(info.size, Some(123456));
        assert_eq!(info.sha256.len(), 64);
        assert_eq!(info.channel, channel());
    }

    #[test]
    fn manifest_without_android_platform_is_rejected() {
        let raw = r#"{"version":"1.0.0","platforms":{"darwin-aarch64":{"url":"https://x","sha256":"aa"}}}"#;
        let err = parse_manifest(raw).expect_err("foreign platform is not readable");
        assert!(err.contains(ANDROID_PLATFORM));
    }

    #[test]
    fn manifest_with_bad_sha256_is_rejected() {
        let raw = r#"{"version":"1.0.0","platforms":{"android-aarch64":{"url":"https://x","sha256":"zz"}}}"#;
        let err = parse_manifest(raw).expect_err("non-hex sha256 rejected");
        assert!(err.contains("sha256"));
    }

    #[test]
    fn manifest_with_bad_json_is_rejected() {
        assert!(parse_manifest("not json").is_err());
    }

    #[test]
    fn version_compare() {
        assert!(is_newer("0.3.42", "0.3.9"));
        assert!(is_newer("0.4.0", "0.3.42"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.3.42", "0.3.42"));
        assert!(!is_newer("0.3.41", "0.3.42"));
        assert!(!is_newer("0.3.9", "0.3.42"));
        // A non-numeric tag never triggers a downgrade prompt.
        assert!(!is_newer("latest", "0.3.42"));
        assert!(!is_newer("0.3.42", ""));
        // Missing components count as zero.
        assert!(is_newer("0.3.42", "0.3"));
    }
}
