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
use std::sync::LazyLock;

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

/// Fire-and-forget first-use download. No-op when the assets are already on
/// disk or a download is in flight/failed (a failed download is retried on
/// the next app launch, not hammered per goal). Call from an async context.
pub fn kick_download() {
    if assets_ready() || DOWNLOAD_FAILED.load(Ordering::Relaxed) {
        return;
    }
    if DOWNLOAD_STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = download_assets().await {
            tracing::warn!(component = "laya_router", error = %e, "asset download failed");
            DOWNLOAD_FAILED.store(true, Ordering::Relaxed);
        }
    });
}

async fn download_assets() -> Result<(), String> {
    let models = user_models_dir().ok_or("no models dir (no home)")?;
    let dir = models.join("laya").join(VARIANT);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
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
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("{url}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("{url}: {e}"))?;
        // Hash expected BEFORE the transfer — a file with no recorded digest
        // is a package mistake, not a download problem.
        let hash = expected
            .get(file)
            .ok_or_else(|| format!("SHA256SUMS has no entry for {file}"))?
            .to_string();
        // Stream to .part with an incremental digest — never hold a 393 MB
        // body in RAM (the house pattern: logic::ensure_model).
        use futures_util::StreamExt;
        use sha2::Digest as _;
        use std::io::Write as _;
        let tmp = dir.join(format!("{file}.part"));
        let mut stream = response.bytes_stream();
        let mut hasher = sha2::Sha256::new();
        let mut written: u64 = 0;
        let mut out = std::fs::File::create(&tmp)
            .map_err(|e| format!("create {}: {e}", tmp.display()))?;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("{url}: stream: {e}"))?;
            hasher.update(&chunk);
            out.write_all(&chunk)
                .map_err(|e| format!("write {}: {e}", tmp.display()))?;
            written += chunk.len() as u64;
        }
        out.flush().map_err(|e| format!("flush {}: {e}", tmp.display()))?;
        let actual = hex::encode(hasher.finalize());
        if actual != hash {
            return Err(format!("{file}: sha256 mismatch (got {actual})"));
        }
        std::fs::rename(&tmp, &target).map_err(|e| format!("rename {}: {e}", target.display()))?;
        tracing::info!(component = "laya_router", file, bytes = written, "asset downloaded");
    }
    tracing::info!(component = "laya_router", "laya assets ready — gate active");
    DOWNLOAD_STARTED.store(false, Ordering::Relaxed);
    Ok(())
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

    let mut guard = GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.is_none() {
        // First attempt after the assets land (or the only attempt when they
        // were installed manually) — retried on every grey-band goal, so a
        // goal that raced the background download picks the gate up late.
        *guard = load().map(std::sync::Arc::new);
    }
    // Clone the handle OUT and drop the lock: inference takes ~250 ms and
    // the first load parses a 34 MB tokenizer — neither may serialize other
    // claims or `laya_status` behind the mutex.
    let gate = std::sync::Arc::clone(guard.as_ref()?);
    drop(guard);

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
