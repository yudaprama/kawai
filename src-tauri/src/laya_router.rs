//! Laya zero-shot fast-claim gate — router layer 1.5 (desktop, `litert`).
//!
//! Sits between the keyword gate (layer 1) and the layer-2 LLM resolver in
//! `supervisor::plan_task`. On the grey band (no keyword claim), one 222 ms
//! on-device forward pass either names a registered template — and the claim
//! proceeds through the SAME builder/confirmation machinery as every other
//! claim — or declines and layer 2 runs exactly as before.
//!
//! Safety contract (see the PoC: models/laya/multilingual + route_log corpus):
//! - Opt-in via `KAWAI_LAYA_ROUTER=1`; unset ⇒ this module never loads.
//! - The gate can only SHORTEN the path to a claim that layer 2 might also
//!   have made. It never sees greeting/question/direct goals (the static
//!   layers run first) and its claim must pass the same
//!   `missing_required`/`build`/`enforce_confirmation_policy` checks.
//! - A 0.96-confident wrong claim on a question-shaped goal is why the
//!   static guards run first — do not reorder.

use std::sync::atomic::{AtomicBool, Ordering};

use cognee_litert_lm::{build_sequence, calibrated_probabilities, LayaRunner, Question};
use kawai_paths::{find_laya_model_dir, user_models_dir};
use tokenizers::Tokenizer;

/// Claim threshold. The plan review gate (every claim builds a plan the user
/// sees and can discard) is the real safety net — a keyword miss costs 1–6
/// planner rounds, a wrong claim costs one dismissable card.
pub const CLAIM_THRESHOLD: f32 = 0.7;

const VARIANT: &str = "multilingual";
const OPT_OUT: &str = "plan";

/// Diagnostics for the `laya_status` op: asset presence only — there are no
/// env knobs and the assets are NOT bundled. A build without
/// `~/.kawai/models/laya/multilingual` (or `<app_data>/models/…`) never
/// loads the gate. Never forces the lazy load — status must not pay a
/// 34 MB tokenizer parse.
pub fn status() -> serde_json::Value {
    let assets = find_laya_model_dir(VARIANT);
    let assets_ok = assets.as_ref().is_some_and(|dir| {
        dir.join("laya_ml_s256_embeds_wfp16.tflite").is_file()
            && dir.join("laya_ml_act_head_fp32.tflite").is_file()
            && dir.join("token_embeddings_fp16.bin").is_file()
            && dir.join("tokenizer.json").is_file()
            && dir.join("laya_ml_calibration.json").is_file()
    });
    serde_json::json!({
        "assets_dir": assets.map(|d| d.display().to_string()),
        "assets_complete": assets_ok,
        "download": if DOWNLOAD_FAILED.load(Ordering::Relaxed) {
            "failed"
        } else if DOWNLOAD_STARTED.load(Ordering::Relaxed) {
            "running"
        } else {
            "idle"
        },
        "threshold": CLAIM_THRESHOLD,
    })
}

struct Gate {
    runner: LayaRunner,
    tokenizer: Tokenizer,
    calibration: serde_json::Value,
}

static GATE: std::sync::Mutex<Option<std::sync::Arc<Gate>>> = std::sync::Mutex::new(None);

static DOWNLOAD_STARTED: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_FAILED: AtomicBool = AtomicBool::new(false);

/// Files fetched from `litert-community/Laya-Multilingual-LiteRT` on first
/// grey-band use (the house auto-download pattern — see `logic::ensure_model`).
const ASSET_FILES: &[&str] = &[
    "laya_ml_s256_embeds_wfp16.tflite",
    "laya_ml_act_head_fp32.tflite",
    "token_embeddings_fp16.bin",
    "tokenizer.json",
    "tokenizer_config.json",
    "laya_ml_calibration.json",
];
const HF_BASE: &str = "https://huggingface.co/litert-community/Laya-Multilingual-LiteRT/resolve/main";

/// Whether the assets are on disk (gate usable).
pub fn assets_ready() -> bool {
    find_laya_model_dir(VARIANT).is_some()
}

/// Fire-and-forget first-use download body. Spawned ONCE at app startup by
/// the Tauri shell (`tauri::async_runtime::spawn` — the setup hook runs
/// outside any tokio reactor). No-op when the assets are already on disk or
/// a previous download failed (retried on the next launch, not hammered).
pub async fn kick_download() {
    if assets_ready() || DOWNLOAD_FAILED.load(Ordering::Relaxed) {
        return;
    }
    DOWNLOAD_STARTED.store(true, Ordering::Relaxed);
    let result = download_assets().await;
    if let Err(e) = &result {
        tracing::warn!(component = "laya_router", error = %e, "asset download failed");
        DOWNLOAD_FAILED.store(true, Ordering::Relaxed);
    }
    DOWNLOAD_STARTED.store(false, Ordering::Relaxed);
}

async fn download_assets() -> Result<(), String> {
    let models = user_models_dir().ok_or("no models dir (no home)")?;
    let dir = models.join("laya").join(VARIANT);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    // Bulk-transfer bounds — deliberately NOT `worker_client()`: its 30 s
    // TOTAL timeout would kill a 393 MB body mid-flight (the largest file;
    // 679 MB total). The connect bound surfaces a blocked edge / IPv6-first
    // DNS in seconds, and the per-read bound aborts a stalled transfer (no
    // bytes for 30 s) instead of parking the task in the OS TCP retry window.
    // On a phone that stall is invisible:
    // no error, no log line, and the gate simply never activates.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let sums_url = format!("{HF_BASE}/SHA256SUMS");
    let sums = client
        .get(&sums_url)
        .send()
        .await
        .map_err(|e| format!("{sums_url}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("{sums_url}: {e}"))?
        .text()
        .await
        .map_err(|e| format!("{sums_url}: {e}"))?;
    let mut expected: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for line in sums.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(hash), Some(file)) = (parts.next(), parts.next()) {
            expected.insert(file, hash);
        }
    }

    for file in ASSET_FILES {
        let target = dir.join(file);
        if target.is_file() {
            continue;
        }
        let url = format!("{HF_BASE}/{file}");
        // Hash expected BEFORE the transfer — a file with no recorded digest
        // is a package mistake, not a download problem.
        let hash = expected
            .get(file)
            .ok_or_else(|| format!("SHA256SUMS has no entry for {file}"))?
            .to_string();
        // `.part` is both the staging file and the resume checkpoint — the
        // 239–393 MB bodies must never land in RAM (the house pattern:
        // logic::ensure_model).
        let tmp = dir.join(format!("{file}.part"));
        fetch_to(&client, &url, &tmp).await?;
        // Digest the FILE, not the stream: a resumed transfer appends to bytes
        // already on disk, so an incremental hasher would cover only the tail.
        // Streamed, so the body still never lands in RAM.
        let actual = sha256_file(&tmp)?;
        if actual != hash {
            // Drop the partial — keeping it would resume a poisoned prefix and
            // fail identically on every later launch.
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("{file}: sha256 mismatch (got {actual})"));
        }
        let bytes = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        std::fs::rename(&tmp, &target).map_err(|e| format!("rename {}: {e}", target.display()))?;
        tracing::info!(component = "laya_router", file, bytes, "asset downloaded");
    }
    tracing::info!(component = "laya_router", "laya assets ready — gate active");
    DOWNLOAD_STARTED.store(false, Ordering::Relaxed);
    Ok(())
}

/// GET `url` into `tmp`, resuming a partial file.
///
/// A phone network drops often enough that restarting a 239–393 MB body on
/// every stall would never finish, so `tmp` doubles as the resume checkpoint:
/// Range from its current length, append only on a real 206, and truncate when
/// the server ignores Range (200). A 416 means the partial is already at/past
/// EOF (the remote asset changed) — discard it and fetch from zero. Integrity
/// is settled by the caller's digest check.
async fn fetch_to(client: &reqwest::Client, url: &str, tmp: &std::path::Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write as _;

    let mut discarded_partial = false;
    loop {
        let done = std::fs::metadata(tmp).map(|m| m.len()).unwrap_or(0);
        let mut request = client.get(url);
        if done > 0 {
            request = request.header("Range", format!("bytes={done}-"));
        }
        let response = request.send().await.map_err(|e| format!("{url}: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && !discarded_partial {
            discarded_partial = true;
            let _ = std::fs::remove_file(tmp);
            continue;
        }
        let append = status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !append && !status.is_success() {
            return Err(format!("{url}: HTTP {status}"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).write(true);
        if append {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut out = options
            .open(tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("{url}: stream: {e}"))?;
            out.write_all(&chunk)
                .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        }
        out.flush().map_err(|e| format!("flush {}: {e}", tmp.display()))?;
        return Ok(());
    }
}

/// Streamed SHA-256 of a file on disk — never buffers the body in RAM.
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::Digest as _;
    use std::io::Read as _;

    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn load() -> Option<Gate> {
    let dir = find_laya_model_dir(VARIANT)?;
    let runner = LayaRunner::from_paths(
        &dir.join("laya_ml_s256_embeds_wfp16.tflite"),
        &dir.join("laya_ml_act_head_fp32.tflite"),
        &dir.join("token_embeddings_fp16.bin"),
    )
    .ok()?;
    let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).ok()?;
    let calibration: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("laya_ml_calibration.json")).ok()?)
            .ok()?;
    Some(Gate { runner, tokenizer, calibration })
}

/// One choice question over the registry menu: `(template_id, calibrated p)`
/// when a template clears [`CLAIM_THRESHOLD`], `None` when the classifier
/// picks the opt-out, lands under the threshold, or the gate is
/// unavailable/disabled. Blocking (~250 ms); run on the blocking pool.
pub fn claim(goal: &str, registry: &kawai_router::TemplateRegistry<'_>) -> Option<(String, f32)> {
    // Build the menu lazily per call: the registry is static, but caching it
    // in the gate would couple load order to `crate::templates`. Cheap —
    // a handful of format! calls.
    let mut ids: Vec<String> = Vec::new();
    let mut options: Vec<String> = Vec::new();
    for t in registry.iter() {
        ids.push(t.id.to_string());
        options.push(format!("{}: {}", t.id, t.purpose));
    }
    ids.push(OPT_OUT.into());
    options.push(
        "plan: none of the listed workflows matches this goal — a general task, question, or conversation"
            .into(),
    );

    // Load OUTSIDE the hot path's clone: the one-time parse of a 34 MB
    // tokenizer plus graph init takes seconds and must not serialize a
    // concurrent claim. Double-checked re-lock keeps a single load.
    if GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_none()
    {
        let loaded = load().map(std::sync::Arc::new);
        let mut guard = GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = loaded;
        }
    }
    // Clone the handle OUT and drop the lock: inference takes ~250 ms and
    // must never serialize other claims or `laya_status` behind the mutex.
    let gate = {
        let guard = GATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.as_ref().map(std::sync::Arc::clone)
    }?;

    let question = Question {
        t: "choice".into(),
        ins: "Which fixed workflow matches this user goal? Pick `plan` when no listed workflow matches."
            .into(),
        options,
    };
    let tokenizer = &gate.tokenizer;
    let (ids_built, markers) = build_sequence(goal, &question, 256, 256, |text| {
        tokenizer
            .encode(text, false)
            .map(|e| e.get_ids().to_vec())
            .unwrap_or_default()
    });
    let out = gate.runner.run_question(&ids_built, &markers, 0).ok()?;
    let probs = calibrated_probabilities(&out.raw_logits, "choice", &gate.calibration);
    let (best, p) = probs
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    let p = *p;
    if p < CLAIM_THRESHOLD {
        return None;
    }
    let id = ids.get(best)?.clone();
    if id == OPT_OUT {
        return None;
    }
    Some((id, p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Minimal HTTP/1.1 server for `fetch_to`: serves `body`, optionally
    /// honoring `Range`; `force_status` overrides the FIRST response. Records
    /// the payload length of every response so a test can prove a resume
    /// (2000 bytes served) from a silent restart (3000).
    fn serve(
        body: Vec<u8>,
        honor_range: bool,
        force_status: Option<u16>,
    ) -> (String, Arc<Mutex<Vec<usize>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let addr = format!("http://{}", listener.local_addr().expect("local addr"));
        let served: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&served);
        std::thread::spawn(move || {
            let mut first = true;
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
                let mut range_start: Option<usize> = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    let line = line.trim_end().to_ascii_lowercase();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.strip_prefix("range: bytes=") {
                        range_start = v.trim_end_matches('-').parse().ok();
                    }
                }
                let status = if first && force_status.is_some() {
                    force_status.expect("checked")
                } else if honor_range {
                    match range_start {
                        Some(start) if start < body.len() => 206,
                        Some(_) => 416,
                        None => 200,
                    }
                } else {
                    200
                };
                first = false;
                let payload: Vec<u8> = match (status, range_start) {
                    (206, Some(start)) => body[start..].to_vec(),
                    (200, _) => body.clone(),
                    _ => Vec::new(),
                };
                recorded.lock().expect("served lock").push(payload.len());
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                stream.write_all(head.as_bytes()).expect("write head");
                stream.write_all(&payload).expect("write body");
                stream.flush().expect("flush");
            }
        });
        (addr, served)
    }

    fn asset_body() -> Vec<u8> {
        (0..3000u32).map(|i| (i % 251) as u8).collect()
    }

    async fn fetch(url: &str, tmp: &std::path::Path) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("client");
        fetch_to(&client, url, tmp).await
    }

    /// A partial `.part` is completed from its current length — the server
    /// serves only the tail (206). A resume that secretly restarted would
    /// serve 3000 bytes instead of 2000.
    #[tokio::test]
    async fn resumes_a_partial_file() {
        let (addr, served) = serve(asset_body(), true, None);
        let dir = tempfile::tempdir().expect("tempdir");
        let tmp = dir.path().join("asset.part");
        std::fs::write(&tmp, &asset_body()[..1000]).expect("seed partial");

        fetch(&format!("{addr}/asset"), &tmp).await.expect("fetch");

        assert_eq!(std::fs::read(&tmp).expect("read"), asset_body());
        assert_eq!(*served.lock().expect("served"), vec![2000]);
    }

    /// A server that ignores Range (200, not 206) must RESTART the file:
    /// appending would interleave the body with the stale prefix and the
    /// digest would fail on every later launch.
    #[tokio::test]
    async fn restarts_when_the_server_ignores_range() {
        let (addr, served) = serve(asset_body(), false, None);
        let dir = tempfile::tempdir().expect("tempdir");
        let tmp = dir.path().join("asset.part");
        std::fs::write(&tmp, vec![0xAAu8; 1000]).expect("seed partial");

        fetch(&format!("{addr}/asset"), &tmp).await.expect("fetch");

        assert_eq!(std::fs::read(&tmp).expect("read"), asset_body());
        assert_eq!(*served.lock().expect("served"), vec![3000]);
    }

    /// 416 = the partial is at/past EOF (the remote asset changed): discard it
    /// and fetch from zero.
    #[tokio::test]
    async fn discards_a_satisfied_range_and_refetches() {
        let (addr, served) = serve(asset_body(), true, None);
        let dir = tempfile::tempdir().expect("tempdir");
        let tmp = dir.path().join("asset.part");
        std::fs::write(&tmp, vec![0xAAu8; 5000]).expect("seed oversized partial");

        fetch(&format!("{addr}/asset"), &tmp).await.expect("fetch");

        assert_eq!(std::fs::read(&tmp).expect("read"), asset_body());
        assert_eq!(*served.lock().expect("served"), vec![0, 3000]);
    }

    /// An HTTP error is surfaced rather than written out as an empty asset.
    #[tokio::test]
    async fn surfaces_a_server_error() {
        let (addr, _served) = serve(asset_body(), true, Some(500));
        let dir = tempfile::tempdir().expect("tempdir");
        let tmp = dir.path().join("asset.part");

        let err = fetch(&format!("{addr}/asset"), &tmp)
            .await
            .expect_err("must fail");
        assert!(err.contains("500"), "{err}");
    }
}
