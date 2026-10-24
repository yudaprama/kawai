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

use std::sync::LazyLock;

use cognee_litert_lm::{build_sequence, calibrated_probabilities, LayaRunner, Question};
use kawai_paths::find_laya_model_dir;
use tokenizers::Tokenizer;

/// Claim threshold. The plan review gate (every claim builds a plan the user
/// sees and can discard) is the real safety net — a keyword miss costs 1–6
/// planner rounds, a wrong claim costs one dismissable card.
pub const CLAIM_THRESHOLD: f32 = 0.7;

const VARIANT: &str = "multilingual";
const OPT_OUT: &str = "plan";

/// `KAWAI_LAYA_ROUTER=1` enables the fast-claim gate. Unset ⇒ never loads.
pub fn enabled() -> bool {
    std::env::var("KAWAI_LAYA_ROUTER").ok().as_deref() == Some("1")
}

/// Diagnostics for the `laya_status` op: flag state + asset presence. Never
/// forces the lazy load — status must not pay a 34 MB tokenizer parse.
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
        "enabled": enabled(),
        "assets_dir": assets.map(|d| d.display().to_string()),
        "assets_complete": assets_ok,
        "threshold": CLAIM_THRESHOLD,
    })
}

struct Gate {
    runner: LayaRunner,
    tokenizer: Tokenizer,
    calibration: serde_json::Value,
}

static GATE: LazyLock<Option<Gate>> = LazyLock::new(load);

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

    let gate = GATE.as_ref()?;

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
