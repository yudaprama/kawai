//! Civitai generation tools for the `builtin.generator` agent.
//!
//! Four lanes, one per media kind — image, video, music, 3D — over the same
//! `logic::civitai` ops the Generator panel calls. Generation only: browsing
//! models/images (`search_models`, `search_images`, the feeds) stays a panel
//! concern, so the agent's whole tool surface is "make me a thing".
//!
//! ## Two-phase lanes
//!
//! Image generation is ONE call: the op submits, long-polls to completion,
//! downloads and imports, and answers with the stored file ids. The other
//! three lanes are workflow-based upstream (minutes, not seconds), so they
//! are submit → fetch: `*_submit` returns a `workflowId`, `*_fetch` polls it
//! to completion and stores the artifacts. Upstream result URLs are signed
//! and expire, so `*_fetch` re-reads them from the status call instead of
//! taking them as arguments — the only way a fetched URL can be a fresh one.
//!
//! ## Spend
//!
//! Every tool that can charge Buzz declares `requires_confirmation = true`
//! AND is mapped to `AgentCapability::Confirmation` by [`definition`], so the
//! chat path asks the user before the call and the supervisor's
//! `enforce_confirmation_policy` cannot dispatch it unapproved. The fetch
//! tools are free — the Buzz was charged at submit — and unconfirmed.
//!
//! Submits run DETACHED from the tool future: the scheduler hard-cancels a
//! step at its deadline, and dropping a submit future after the Buzz is
//! charged would spend the user's money for nothing. The tool awaits a budget
//! and, if it lapses, reports that the job is still running instead of dying.
//!
//! ## Bearer
//!
//! The balance gate needs the session bearer, read once at TOOLSET BUILD time
//! (`local_auth::stored_token`): a signed-out user gets no generation tools
//! rather than tools that fail on call. `kawai-web` has no token file (one
//! process serves many users) and therefore builds this agent without
//! generation tools.

use std::future::Future;
use std::time::{Duration, Instant};

use kawai_agent_contract::{
    AgentCapabilities, AgentCapability, AgentContext, AgentDefinition, ConfirmationPrompt,
};
use kawai_tools::{terr, AgentTool, ToolError, ToolSet};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::logic::{civitai, local_auth};

/// Agent id — the catalog entry served by `list_agents`.
pub const ID: &str = "builtin.generator";

const IMAGE_TOOL: &str = "civitai_generate_image";
const VIDEO_SUBMIT: &str = "civitai_video_submit";
const VIDEO_FETCH: &str = "civitai_video_fetch";
const MUSIC_SUBMIT: &str = "civitai_music_submit";
const MUSIC_FETCH: &str = "civitai_music_fetch";
const MODEL3D_SUBMIT: &str = "civitai_model3d_submit";
const MODEL3D_FETCH: &str = "civitai_model3d_fetch";

/// Poll budget for one `*_fetch` call. The chat path has no deadline
/// (`deadline::effective_budget` answers `None`) and uses this as its cap; the
/// supervisor path clamps it to the remaining step budget.
const FETCH_BUDGET: Duration = Duration::from_secs(150);

/// Budget a submit gets before the tool hands back what it knows. A submit is
/// a whatif + a balance read + one POST — seconds — so this only fires on a
/// stalled network, where reporting the state beats being hard-cancelled.
const SUBMIT_BUDGET: Duration = Duration::from_secs(180);

/// One server-side long-poll. The status ops block up to this before replying
/// with the current snapshot.
const POLL_WAIT_SECS: u64 = 15;

const PERSONA: &str = "You are kawai's media generation agent: you turn a description into a real image, video clip, music track or 3D model.\n\
Rules:\n\
- Call at most ONE tool per reply, as a single call:<name>{...} line, then stop and wait for the response: message.\n\
- Every generation spends the user's Buzz balance. The runtime asks the user to confirm each spend before it runs — never ask for permission yourself, just call the tool.\n\
- Image: civitai_generate_image is ONE call — it generates, downloads and stores the image, and answers with the fileId. Write a rich prompt (subject, style, lighting, composition); negativePrompt is optional.\n\
- Video, music and 3D are TWO calls: *_submit returns a workflowId (the Buzz is charged there), then *_fetch with that workflowId polls until the job finishes and stores the result. Never re-submit to \"check\" — re-submitting charges again. If *_fetch answers that the job is still running, call it again with the same workflowId.\n\
- Keep the workflowId in the conversation: upstream result URLs are signed and expire, so the fetch has to happen in this session.\n\
- After a result arrives, report in one short sentence what was made and give the file name(s). Never paste the raw JSON.\n\
- If a tool reports a validation error (unknown ecosystem, missing source image, unsupported workflow), fix the arguments from the hints it lists and call again — do not give up after one failure.\n\
- Final answers: short, factual, in the user's language.";

// ── ecosystem vocabulary (read from the client's registry, never restated) ──

fn image_ecosystems() -> String {
    civitai::registry::ecosystems_for_workflow(civitai::registry::DEFAULT_WORKFLOW).join(", ")
}

fn video_ecosystems() -> String {
    civitai::registry::video_ecosystem_keys().collect::<Vec<_>>().join(", ")
}

fn music_ecosystems() -> String {
    civitai::registry::MUSIC_ECOSYSTEMS
        .iter()
        .map(|e| e.key)
        .collect::<Vec<_>>()
        .join(", ")
}

fn model3d_ecosystems() -> String {
    civitai::registry::MODEL3D_ECOSYSTEMS
        .iter()
        .map(|e| e.key)
        .collect::<Vec<_>>()
        .join(", ")
}

fn encode(value: &Value) -> Result<String, ToolError> {
    serde_json::to_string(value).map_err(|e| terr(format!("encode result: {e}")))
}

/// Await a submit future under a budget WITHOUT dropping it: the work keeps
/// running after the budget lapses, so a stalled network — or the scheduler's
/// hard cancel at a step deadline — can never turn a charged submission into
/// a lost one. On lapse the caller gets `hint` instead of a result.
async fn submit_detached<F, T>(
    budget: Duration,
    hint: &'static str,
    future: F,
) -> Result<T, ToolError>
where
    F: Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
{
    let budget = kawai_tools::deadline::effective_budget(budget).unwrap_or(budget);
    match tokio::time::timeout(budget, tokio::spawn(future)).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(e))) => Err(terr(e)),
        Ok(Err(join)) => Err(terr(format!("generation task failed: {join}"))),
        Err(_) => Err(terr(hint)),
    }
}

// ── the workflow lanes (video / music / 3D) ────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lane {
    Video,
    Music,
    Model3d,
}

impl Lane {
    fn kind(self) -> &'static str {
        match self {
            Lane::Video => "civitai_video",
            Lane::Music => "civitai_music",
            Lane::Model3d => "civitai_model3d",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Lane::Video => "video",
            Lane::Music => "music",
            Lane::Model3d => "3D model",
        }
    }

    fn fetch_tool(self) -> &'static str {
        match self {
            Lane::Video => VIDEO_FETCH,
            Lane::Music => MUSIC_FETCH,
            Lane::Model3d => MODEL3D_FETCH,
        }
    }
}

/// One status snapshot, classified for the shared poll loop.
enum Probe {
    /// Terminal — the artifact is downloaded and stored; body is model-facing.
    Done(String),
    /// Terminal failure — the message names the status and the upstream error.
    Failed(String),
    /// Still in flight.
    Running {
        status: String,
        queue_position: Option<i64>,
    },
}

fn still_running(lane: Lane, workflow_id: &str, status: &str, queue: Option<i64>) -> String {
    json!({
        "kind": lane.kind(),
        "lane": lane.name(),
        "workflowId": workflow_id,
        "status": status,
        "queuePosition": queue,
        "note": format!(
            "Still running — call {} again with the same workflowId once the job finishes.",
            lane.fetch_tool()
        ),
    })
    .to_string()
}

/// Poll one workflow to terminal under a budget, then store its artifacts.
/// The cadence lives here once for all three lanes: a server-side long-poll
/// clamped to the remaining budget, so a step deadline can never hard-cancel
/// a poll mid-flight (a fetch is re-runnable, so nothing is lost either way).
async fn fetch_lane(
    lane: Lane,
    user_id: &str,
    workflow_id: &str,
    budget: Duration,
) -> Result<String, ToolError> {
    let workflow_id = workflow_id.trim();
    if workflow_id.is_empty() {
        return Err(terr("workflowId wajib diisi"));
    }
    let budget = kawai_tools::deadline::effective_budget(budget).unwrap_or(budget);
    let started = Instant::now();
    let mut last = ("queued".to_string(), None);
    loop {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining < Duration::from_secs(2) {
            return Ok(still_running(lane, workflow_id, &last.0, last.1));
        }
        let wait = remaining.as_secs().clamp(2, POLL_WAIT_SECS);
        let probe = match lane {
            Lane::Video => {
                let view = civitai::civitai_video_status(workflow_id.to_string(), Some(wait))
                    .await
                    .map_err(terr)?;
                match view.status.as_str() {
                    "succeeded" => match view.video {
                        Some(video) => {
                            let id = view.workflow_id.clone();
                            let saved = civitai::civitai_video_fetch(
                                user_id,
                                id.clone(),
                                video.video_url,
                                video.thumbnail_url,
                                view.additional.into_iter().map(|b| b.video_url).collect(),
                            )
                            .await
                            .map_err(terr)?;
                            Probe::Done(encode(&json!({
                                "kind": Lane::Video.kind(),
                                "lane": Lane::Video.name(),
                                "workflowId": id,
                                "files": [saved],
                                "note": "Stored in the Library — reference it in a document with kawai-file://<fileId>.",
                            }))?)
                        }
                        None => Probe::Failed(format!(
                            "workflow {workflow_id} finished without a video URL"
                        )),
                    },
                    "failed" | "expired" | "canceled" => Probe::Failed(format!(
                        "workflow {workflow_id} {} — {}",
                        view.status,
                        view.error.unwrap_or_else(|| "no error detail".into())
                    )),
                    other => Probe::Running {
                        status: other.to_string(),
                        queue_position: view.queue_position,
                    },
                }
            }
            Lane::Music => {
                let view = civitai::civitai_music_status(workflow_id.to_string(), Some(wait))
                    .await
                    .map_err(terr)?;
                match view.status.as_str() {
                    "succeeded" => match view.audio_url {
                        Some(audio_url) => {
                            let id = view.workflow_id.clone();
                            let saved =
                                civitai::civitai_music_fetch(user_id, id.clone(), audio_url)
                                    .await
                                    .map_err(terr)?;
                            Probe::Done(encode(&json!({
                                "kind": Lane::Music.kind(),
                                "lane": Lane::Music.name(),
                                "workflowId": id,
                                "files": [saved],
                                "note": "Stored in the Library — reference it in a document with kawai-file://<fileId>.",
                            }))?)
                        }
                        None => Probe::Failed(format!(
                            "workflow {workflow_id} finished without an audio URL"
                        )),
                    },
                    "failed" | "expired" | "canceled" => Probe::Failed(format!(
                        "workflow {workflow_id} {} — {}",
                        view.status,
                        view.error.unwrap_or_else(|| "no error detail".into())
                    )),
                    other => Probe::Running {
                        status: other.to_string(),
                        queue_position: view.queue_position,
                    },
                }
            }
            Lane::Model3d => {
                let view = civitai::civitai_model3d_status(workflow_id.to_string(), Some(wait))
                    .await
                    .map_err(terr)?;
                match view.status.as_str() {
                    "succeeded" => match view.model {
                        Some(model) => {
                            let id = view.workflow_id.clone();
                            let saved = civitai::civitai_model3d_fetch(
                                user_id,
                                id.clone(),
                                model.url,
                                model.format,
                                view.fbx.as_ref().map(|f| f.url.clone()),
                                view.fbx.as_ref().and_then(|f| f.format.clone()),
                                view.preview_url,
                                view.extras,
                            )
                            .await
                            .map_err(terr)?;
                            Probe::Done(encode(&json!({
                                "kind": Lane::Model3d.kind(),
                                "lane": Lane::Model3d.name(),
                                "workflowId": id,
                                "files": [saved],
                                "note": "Stored in the Library — the primary fileId is the model, fbxFileId/previewFileId its twins.",
                            }))?)
                        }
                        None => Probe::Failed(format!(
                            "workflow {workflow_id} finished without a model URL"
                        )),
                    },
                    "failed" | "expired" | "canceled" => Probe::Failed(format!(
                        "workflow {workflow_id} {} — {}",
                        view.status,
                        view.error.unwrap_or_else(|| "no error detail".into())
                    )),
                    other => Probe::Running {
                        status: other.to_string(),
                        queue_position: view.queue_position,
                    },
                }
            }
        };
        match probe {
            Probe::Done(body) => return Ok(body),
            Probe::Failed(message) => return Err(terr(message)),
            Probe::Running {
                status,
                queue_position,
            } => last = (status, queue_position),
        }
    }
}

// ── civitai_generate_image ─────────────────────────────────────────────────

/// Tool args for the image lane. `civitai::ImageGenParams` is the panel's wire
/// shape — every field but `width`/`height`/`prompt` is optional there — so
/// this mirrors it with the defaults a caller should not have to know.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageArgs {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub ecosystem: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub source_image: Option<String>,
    #[serde(default)]
    pub strength: Option<f64>,
    #[serde(default)]
    pub upscale_repeats: Option<i64>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub steps: Option<i64>,
    #[serde(default)]
    pub cfg_scale: Option<f64>,
    #[serde(default)]
    pub quantity: Option<i64>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub sampler: Option<String>,
    #[serde(default)]
    pub clip_skip: Option<i64>,
    #[serde(default)]
    pub diffuser_model: Option<String>,
    #[serde(default)]
    pub loras: Vec<civitai::LoraSpec>,
}

impl GenerateImageArgs {
    fn into_params(&self) -> civitai::ImageGenParams {
        let ecosystem = self
            .ecosystem
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string)
            .or_else(|| {
                civitai::registry::default_ecosystem_for_workflow(civitai::registry::DEFAULT_WORKFLOW)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        civitai::ImageGenParams {
            ecosystem,
            engine: None,
            workflow: self.workflow.clone(),
            prompt: self.prompt.clone(),
            source_image: self.source_image.clone(),
            strength: self.strength,
            upscale_repeats: self.upscale_repeats,
            negative_prompt: self.negative_prompt.clone(),
            width: self.width.unwrap_or(1024),
            height: self.height.unwrap_or(1024),
            cfg_scale: self.cfg_scale,
            steps: self.steps,
            quantity: self.quantity,
            seed: self.seed,
            loras: self.loras.clone(),
            diffuser_model: self.diffuser_model.clone(),
            sampler: self.sampler.clone(),
            clip_skip: self.clip_skip,
        }
    }
}

pub struct GenerateImageTool {
    user_id: String,
    bearer: String,
}

impl AgentTool for GenerateImageTool {
    const NAME: &'static str = IMAGE_TOOL;
    type Args = GenerateImageArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        format!(
            "Generate an image and store it in the user's Library. SPENDS Buzz — the runtime asks the user to confirm first. \
One call does everything: generate → download → store; the answer carries the fileId. \
ecosystem: the image model family, one of {}. Default {}. \
workflow: txt2img (text → image, the default), txt2img:hires-fix (text → image plus upscaled passes), \
img2img (redraw sourceImage), img2img:upscale (upscale sourceImage — no prompt needed). \
sourceImage must be an https image URL, a data: URL or raw base64 — a Library file handle is not accepted. \
sampler/clipSkip apply to the SD-family ecosystems only.",
            image_ecosystems(),
            civitai::registry::default_ecosystem_for_workflow(civitai::registry::DEFAULT_WORKFLOW)
                .unwrap_or("anima"),
        )
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "What to draw. Detailed prompts win: subject, style, lighting, composition, quality words."
                },
                "negativePrompt": {
                    "type": "string",
                    "description": "What to avoid (blurry, watermark, extra fingers, ...)."
                },
                "ecosystem": {
                    "type": "string",
                    "description": format!("Image model family. One of: {}", image_ecosystems())
                },
                "workflow": {
                    "type": "string",
                    "enum": ["txt2img", "txt2img:hires-fix", "img2img", "img2img:upscale"],
                    "description": "Generation mode. Default txt2img."
                },
                "sourceImage": {
                    "type": "string",
                    "description": "Required for img2img / img2img:upscale: an https image URL, a data: URL or raw base64."
                },
                "strength": {
                    "type": "number",
                    "description": "img2img only, 0.0-1.0 — how far from the source to redraw (0.6 is a good start)."
                },
                "upscaleRepeats": {
                    "type": "integer",
                    "description": "1-3 extra upscale passes for txt2img:hires-fix / img2img:upscale."
                },
                "width": {
                    "type": "integer",
                    "description": "Pixels, multiple of 16. 1024 square (default), 832x1216 portrait, 1216x832 landscape."
                },
                "height": { "type": "integer", "description": "Pixels, multiple of 16. Default 1024." },
                "steps": { "type": "integer", "description": "Sampling steps; the ecosystems default to 25-30." },
                "cfgScale": { "type": "number", "description": "Prompt adherence, ~1.5-8." },
                "quantity": { "type": "integer", "description": "How many images to generate; each one is charged." },
                "seed": { "type": "integer", "description": "Fix the seed to reproduce or refine a previous result." },
                "sampler": {
                    "type": "string",
                    "description": "SD-family only: Euler a, Euler, Heun, LMS, DDIM, DPM++ 2M Karras, DPM2."
                },
                "clipSkip": { "type": "integer", "description": "SD-family only, 1-2." },
                "diffuserModel": { "type": "string", "description": "Advanced: an explicit civitai model version id." },
                "loras": {
                    "type": "array",
                    "description": "Advanced: LoRA adapters to stack on the prompt.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "air": { "type": "string", "description": "AIR URN, e.g. urn:air:anima:lora:civitai:123456@789012." },
                            "strength": { "type": "number", "description": "Default 1.0." }
                        },
                        "required": ["air"]
                    }
                }
            },
            "required": ["prompt"]
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn produces(&self) -> Vec<String> {
        vec!["files".into()]
    }

    async fn call(&self, args: GenerateImageArgs) -> Result<String, ToolError> {
        let params = args.into_params();
        let buzz = civitai::image_buzz_estimate(&params);
        let tokens = civitai::buzz_to_tokens(buzz);
        let ecosystem = params.ecosystem.clone();
        let workflow = params
            .workflow
            .clone()
            .unwrap_or_else(|| civitai::registry::DEFAULT_WORKFLOW.to_string());
        let user_id = self.user_id.clone();
        let bearer = self.bearer.clone();
        let saved = submit_detached(
            SUBMIT_BUDGET,
            "the generation is still running upstream — its file lands in the Library when it \
             finishes; the job is listed in the Generator panel with the Buzz it charged",
            async move { civitai::civitai_generate(&user_id, &bearer, params).await },
        )
        .await?;
        encode(&json!({
            "kind": "civitai_image",
            "lane": "image",
            "ecosystem": ecosystem,
            "workflow": workflow,
            "files": saved,
            "buzz": buzz,
            "tokens": tokens,
            "note": "Stored in the Library — reference it in a document with kawai-file://<fileId>.",
        }))
    }
}

// ── civitai_video_submit / civitai_video_fetch ─────────────────────────────

/// Reuses the panel's `VideoGenRequest` verbatim: it is already the wire shape
/// (camelCase, every field but `ecosystem` optional), so there is no second
/// mapping to keep in sync.
pub struct SubmitVideoTool {
    user_id: String,
    bearer: String,
}

impl AgentTool for SubmitVideoTool {
    const NAME: &'static str = VIDEO_SUBMIT;
    type Args = civitai::VideoGenRequest;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        format!(
            "Start a video generation job (Civitai). SPENDS Buzz at submit — the runtime asks the user to confirm first. \
Returns a workflowId; call {} with it to poll the job and store the clip. Never re-submit to check on a job. \
ecosystem: one of {}. Default {}. \
workflow: one of {} — txt2vid (text → video, default), img2vid (needs images: first frame, optional last), \
img2vid:ref2vid (needs images: reference frames), vid2vid:edit (grok only — needs video). \
Optional knobs vary per ecosystem: duration (seconds), resolution, aspectRatio, generateAudio, model, mode, seed, quantity.",
            VIDEO_FETCH,
            video_ecosystems(),
            civitai::registry::DEFAULT_VIDEO_ECOSYSTEM,
            civitai::registry::VIDEO_WORKFLOWS.join(", "),
        )
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ecosystem": {
                    "type": "string",
                    "description": format!("Video engine. One of: {}", video_ecosystems())
                },
                "workflow": {
                    "type": "string",
                    "description": format!("One of: {}", civitai::registry::VIDEO_WORKFLOWS.join(", ")),
                    "enum": civitai::registry::VIDEO_WORKFLOWS
                },
                "prompt": {
                    "type": "string",
                    "description": "What happens in the clip: subject, action, camera movement, style."
                },
                "negativePrompt": { "type": "string", "description": "What to avoid." },
                "images": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Source frames for img2vid ([first] or [first, last]) / reference images for img2vid:ref2vid — https URL, data: URL or base64."
                },
                "video": {
                    "type": "string",
                    "description": "vid2vid:edit only: the source clip (https URL, data: URL or base64)."
                },
                "model": { "type": "string", "description": "Engine model key when the ecosystem offers more than one." },
                "duration": { "type": "integer", "description": "Clip length in seconds." },
                "resolution": { "type": "string", "description": "e.g. 480p, 720p, 1080p, 2K — the ecosystem's set." },
                "aspectRatio": { "type": "string", "description": "e.g. 16:9, 9:16, 1:1." },
                "generateAudio": { "type": "boolean", "description": "Ask the engine for a soundtrack when it supports one." },
                "enablePromptEnhancer": { "type": "boolean", "description": "Let the provider expand the prompt." },
                "seed": { "type": "integer", "description": "Fix the seed to reproduce a result." },
                "quantity": { "type": "integer", "description": "How many clips; each one is charged." }
            },
            "required": ["ecosystem"]
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn produces(&self) -> Vec<String> {
        vec!["workflowId".into()]
    }

    async fn call(&self, args: civitai::VideoGenRequest) -> Result<String, ToolError> {
        let user_id = self.user_id.clone();
        let bearer = self.bearer.clone();
        let submitted = submit_detached(
            SUBMIT_BUDGET,
            "the submit is still in flight — the job is listed in the Generator panel once it \
             lands; check the panel before retrying, a retry charges again",
            async move { civitai::civitai_video_submit(&user_id, &bearer, args).await },
        )
        .await?;
        encode(&json!({
            "kind": "civitai_video_submit",
            "lane": "video",
            "workflowId": submitted.workflow_id,
            "jobId": submitted.job_id,
            "status": "submitted",
            "note": format!("Call {} with this workflowId to poll the job and store the clip.", VIDEO_FETCH),
        }))
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchArgs {
    /// The id a `*_submit` tool returned.
    pub workflow_id: String,
}

pub struct FetchVideoTool {
    user_id: String,
}

impl AgentTool for FetchVideoTool {
    const NAME: &'static str = VIDEO_FETCH;
    type Args = FetchArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        format!(
            "Poll a submitted video job and, when it finishes, download the clip into the user's Library. Free — the Buzz was charged at submit. \
Answers with status \"queued\"/\"processing\" while the job runs (call again with the same workflowId) or with the stored files once it succeeds.",
        )
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "workflowId": {
                    "type": "string",
                    "description": "The workflowId returned by civitai_video_submit."
                }
            },
            "required": ["workflowId"]
        })
    }

    fn produces(&self) -> Vec<String> {
        vec!["files".into()]
    }

    async fn call(&self, args: FetchArgs) -> Result<String, ToolError> {
        fetch_lane(Lane::Video, &self.user_id, &args.workflow_id, FETCH_BUDGET).await
    }
}

// ── civitai_music_submit / civitai_music_fetch ─────────────────────────────

pub struct SubmitMusicTool {
    user_id: String,
    bearer: String,
}

impl AgentTool for SubmitMusicTool {
    const NAME: &'static str = MUSIC_SUBMIT;
    type Args = civitai::MusicGenRequest;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        format!(
            "Start a music / audio generation job (Civitai). SPENDS Buzz at submit — the runtime asks the user to confirm first. \
Returns a workflowId; call {} with it to poll the job and store the track. Never re-submit to check on a job. \
ecosystem: one of {}. Default {}. \
mode \"simple\" (default) takes one prompt and the backend drafts the rest; mode \"custom\" takes the structured fields \
(lyrics, abc, bpm, key, steps, duration, model) for full control. Sonilo also takes operation \"music\" (default) or \"soundEffect\".",
            MUSIC_FETCH,
            music_ecosystems(),
            civitai::registry::DEFAULT_MUSIC_ECOSYSTEM,
        )
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ecosystem": {
                    "type": "string",
                    "description": format!("Audio engine. One of: {}", music_ecosystems())
                },
                "mode": {
                    "type": "string",
                    "enum": ["simple", "custom"],
                    "description": "simple (default): one prompt, the backend drafts the structure. custom: you supply the fields below."
                },
                "operation": {
                    "type": "string",
                    "enum": ["music", "soundEffect"],
                    "description": "Sonilo only: a full track (default) or a short sound effect."
                },
                "prompt": { "type": "string", "description": "What to make: genre, mood, instrumentation, tempo." },
                "caption": { "type": "string", "description": "custom mode: the style caption." },
                "lyrics": { "type": "string", "description": "custom mode: the lyrics." },
                "abc": { "type": "string", "description": "custom mode: ABC notation score." },
                "bpm": { "type": "integer", "description": "custom mode: tempo." },
                "key": { "type": "string", "description": "custom mode: musical key, e.g. C major." },
                "duration": { "type": "number", "description": "Length in seconds." },
                "model": { "type": "string", "description": "Engine variant when the ecosystem offers more than one." },
                "seed": { "type": "integer", "description": "Fix the seed to reproduce a result." }
            },
            "required": ["ecosystem"]
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn produces(&self) -> Vec<String> {
        vec!["workflowId".into()]
    }

    async fn call(&self, args: civitai::MusicGenRequest) -> Result<String, ToolError> {
        let user_id = self.user_id.clone();
        let bearer = self.bearer.clone();
        let submitted = submit_detached(
            SUBMIT_BUDGET,
            "the submit is still in flight — the job is listed in the Generator panel once it \
             lands; check the panel before retrying, a retry charges again",
            async move { civitai::civitai_music_submit(&user_id, &bearer, args).await },
        )
        .await?;
        encode(&json!({
            "kind": "civitai_music_submit",
            "lane": "music",
            "workflowId": submitted.workflow_id,
            "jobId": submitted.job_id,
            "status": "submitted",
            "note": format!("Call {} with this workflowId to poll the job and store the track.", MUSIC_FETCH),
        }))
    }
}

pub struct FetchMusicTool {
    user_id: String,
}

impl AgentTool for FetchMusicTool {
    const NAME: &'static str = MUSIC_FETCH;
    type Args = FetchArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Poll a submitted music job and, when it finishes, download the track into the user's Library. \
Free — the Buzz was charged at submit. Answers with status \"queued\"/\"processing\" while the job runs \
(call again with the same workflowId) or with the stored files once it succeeds."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "workflowId": {
                    "type": "string",
                    "description": "The workflowId returned by civitai_music_submit."
                }
            },
            "required": ["workflowId"]
        })
    }

    fn produces(&self) -> Vec<String> {
        vec!["files".into()]
    }

    async fn call(&self, args: FetchArgs) -> Result<String, ToolError> {
        fetch_lane(Lane::Music, &self.user_id, &args.workflow_id, FETCH_BUDGET).await
    }
}

// ── civitai_model3d_submit / civitai_model3d_fetch ─────────────────────────

pub struct SubmitModel3dTool {
    user_id: String,
    bearer: String,
}

impl AgentTool for SubmitModel3dTool {
    const NAME: &'static str = MODEL3D_SUBMIT;
    type Args = civitai::Model3dGenRequest;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        format!(
            "Start a 3D model generation job (Civitai). SPENDS Buzz at submit — the runtime asks the user to confirm first. \
Returns a workflowId; call {} with it to poll the job and store the model. Never re-submit to check on a job. \
ecosystem: one of {}. \
process: \"textTo3D\" (default when prompt is set) or \"imageTo3D\" (needs image). Meshy does both; the other engines are imageTo3D only. \
Common knobs: targetPolycount (meshy), faceLimit (tripo), texture/quad/autoSize (tripo), modelVersion (hunyuan3d), \
shouldTexture, shouldRemesh, enablePbr, texturePrompt, enableRigging, enableAnimation, withPreview.",
            MODEL3D_FETCH,
            model3d_ecosystems(),
        )
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "ecosystem": {
                    "type": "string",
                    "description": format!("3D engine. One of: {}", model3d_ecosystems())
                },
                "process": {
                    "type": "string",
                    "enum": ["textTo3D", "imageTo3D"],
                    "description": "textTo3D (default with a prompt) or imageTo3D (needs image)."
                },
                "prompt": { "type": "string", "description": "What to model: subject, style, detail." },
                "image": { "type": "string", "description": "imageTo3D source: https URL, data: URL or base64." },
                "texturePrompt": { "type": "string", "description": "Separate prompt for the texture pass." },
                "targetPolycount": { "type": "integer", "description": "meshy: target triangle count (100-300000)." },
                "faceLimit": { "type": "integer", "description": "tripo: face budget (1000-500000)." },
                "modelVersion": { "type": "string", "description": "hunyuan3d: v2 | v2.1 | v2-mini." },
                "texture": { "type": "string", "description": "tripo: no | standard | HD." },
                "shouldTexture": { "type": "boolean", "description": "Run the texture pass." },
                "shouldRemesh": { "type": "boolean", "description": "Remesh the result." },
                "enablePbr": { "type": "boolean", "description": "Physically-based materials." },
                "enableRigging": { "type": "boolean", "description": "Add a rig." },
                "enableAnimation": { "type": "boolean", "description": "Add basic animations." },
                "withPreview": { "type": "boolean", "description": "Render a preview image (default true)." },
                "seed": { "type": "integer", "description": "Fix the seed to reproduce a result." }
            },
            "required": ["ecosystem"]
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn produces(&self) -> Vec<String> {
        vec!["workflowId".into()]
    }

    async fn call(&self, args: civitai::Model3dGenRequest) -> Result<String, ToolError> {
        let user_id = self.user_id.clone();
        let bearer = self.bearer.clone();
        let submitted = submit_detached(
            SUBMIT_BUDGET,
            "the submit is still in flight — the job is listed in the Generator panel once it \
             lands; check the panel before retrying, a retry charges again",
            async move { civitai::civitai_model3d_submit(&user_id, &bearer, args).await },
        )
        .await?;
        encode(&json!({
            "kind": "civitai_model3d_submit",
            "lane": "3D model",
            "workflowId": submitted.workflow_id,
            "jobId": submitted.job_id,
            "status": "submitted",
            "note": format!("Call {} with this workflowId to poll the job and store the model.", MODEL3D_FETCH),
        }))
    }
}

pub struct FetchModel3dTool {
    user_id: String,
}

impl AgentTool for FetchModel3dTool {
    const NAME: &'static str = MODEL3D_FETCH;
    type Args = FetchArgs;
    type Output = String;
    type Error = ToolError;

    fn description(&self) -> String {
        "Poll a submitted 3D job and, when it finishes, download the model into the user's Library. \
Free — the Buzz was charged at submit. Answers with status \"queued\"/\"processing\" while the job runs \
(call again with the same workflowId) or with the stored files once it succeeds."
            .to_string()
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "workflowId": {
                    "type": "string",
                    "description": "The workflowId returned by civitai_model3d_submit."
                }
            },
            "required": ["workflowId"]
        })
    }

    fn produces(&self) -> Vec<String> {
        vec!["files".into()]
    }

    async fn call(&self, args: FetchArgs) -> Result<String, ToolError> {
        fetch_lane(Lane::Model3d, &self.user_id, &args.workflow_id, FETCH_BUDGET).await
    }
}

// ── agent definition ───────────────────────────────────────────────────────

fn build_tools(context: &AgentContext<'_>, _remote_configured: bool) -> Option<ToolSet> {
    toolset(context.user_id)
}

/// The generation toolset for one user, or `None` when generation cannot run:
/// no baked API key, or no session bearer to gate the spend with. A missing
/// bearer is a transport fact (desktop persists it, `kawai-web` has no
/// per-request file), so the agent is served without generation tools there
/// instead of offering calls that can only fail.
pub fn toolset(user_id: &str) -> Option<ToolSet> {
    if !civitai::civitai_api_key_status().configured {
        return None;
    }
    let bearer = local_auth::stored_token(user_id)?;
    Some(build(user_id, &bearer))
}

/// The generation toolset for one user with an explicit bearer — the ungated
/// constructor [`toolset`] wraps.
fn build(user_id: &str, bearer: &str) -> ToolSet {
    let user_id = user_id.to_string();
    let bearer = bearer.to_string();
    let mut set = ToolSet::default();
    set.add_tool(GenerateImageTool {
        user_id: user_id.clone(),
        bearer: bearer.clone(),
    });
    set.add_tool(SubmitVideoTool {
        user_id: user_id.clone(),
        bearer: bearer.clone(),
    });
    set.add_tool(FetchVideoTool {
        user_id: user_id.clone(),
    });
    set.add_tool(SubmitMusicTool {
        user_id: user_id.clone(),
        bearer: bearer.clone(),
    });
    set.add_tool(FetchMusicTool {
        user_id: user_id.clone(),
    });
    set.add_tool(SubmitModel3dTool {
        user_id: user_id.clone(),
        bearer: bearer.clone(),
    });
    set.add_tool(FetchModel3dTool { user_id });
    set
}

/// Return the built-in Generator definition.
pub fn definition() -> AgentDefinition {
    AgentDefinition {
        id: ID,
        name: "Generator",
        description: "Generate images, video, music and 3D models from a description.",
        tools: true,
        enabled: true,
        persona: PERSONA,
        build_tools,
        capabilities: AgentCapabilities {
            cloud_writer: false,
            document_drafter: false,
            needs_confirmation: true,
            knowledge_summary: false,
        },
        capability_for_tool: |tool| match tool {
            IMAGE_TOOL | VIDEO_SUBMIT | MUSIC_SUBMIT | MODEL3D_SUBMIT => {
                Some(AgentCapability::Confirmation)
            }
            _ => None,
        },
        confirmation_for_tool: confirmation,
        summary_directive: None,
    }
}

/// The pre-spend prompt. For the image lane the price is the panel's own
/// estimate (`image_buzz_estimate`, the docs formula); the workflow lanes are
/// priced by a provider whatif that only the submit itself can run, so their
/// prompt states the job shape and that the Buzz is charged at submit.
fn confirmation(tool: &str, args: &Value) -> Option<ConfirmationPrompt> {
    match tool {
        IMAGE_TOOL => {
            let params = serde_json::from_value::<GenerateImageArgs>(args.clone())
                .ok()?
                .into_params();
            let quantity = params.quantity.unwrap_or(1);
            let buzz = civitai::image_buzz_estimate(&params);
            let tokens = civitai::buzz_to_tokens(buzz);
            let workflow = params.effective_workflow().to_string();
            Some(ConfirmationPrompt {
                prompt: format!(
                    "Buat {quantity} gambar {workflow} ({ecosystem}, {width}x{height}) dengan Civitai? \
                     Biaya ≈ {buzz} Buzz ({tokens} token).",
                    ecosystem = params.ecosystem,
                    width = params.width,
                    height = params.height,
                ),
                accept_text: format!("Ya, buat {quantity} gambar."),
                decline_text: "Batal, jangan buat gambar.".to_string(),
            })
        }
        VIDEO_SUBMIT | MUSIC_SUBMIT | MODEL3D_SUBMIT => {
            let ecosystem = args
                .get("ecosystem")
                .and_then(Value::as_str)
                .unwrap_or("?");
            let workflow = args.get("workflow").and_then(Value::as_str);
            let what = match tool {
                VIDEO_SUBMIT => "video",
                MUSIC_SUBMIT => "musik",
                _ => "model 3D",
            };
            let shape = match workflow {
                Some(w) => format!("{ecosystem} / {w}"),
                None => ecosystem.to_string(),
            };
            Some(ConfirmationPrompt {
                prompt: format!(
                    "Mulai pembuatan {what} dengan Civitai ({shape})? Buzz ditagih provider saat submit \
                     dan nominalnya mengikuti pengaturan yang diminta."
                ),
                accept_text: format!("Ya, mulai buat {what}."),
                decline_text: format!("Batal, jangan buat {what}."),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The registry is the vocabulary source: every ecosystem/workflow name the
    /// tool descriptions advertise must still resolve, so a registry change
    /// cannot leave the model reading stale options.
    #[test]
    fn advertised_vocabulary_resolves_in_the_registry() {
        for key in civitai::registry::ecosystems_for_workflow(civitai::registry::DEFAULT_WORKFLOW) {
            assert!(
                civitai::registry::ecosystem(key).is_some(),
                "image ecosystem {key} is advertised but unknown"
            );
        }
        for key in civitai::registry::video_ecosystem_keys() {
            assert!(civitai::registry::video_ecosystem(key).is_some());
        }
        for eco in civitai::registry::MUSIC_ECOSYSTEMS.iter() {
            assert!(civitai::registry::music_ecosystem(eco.key).is_some());
        }
        for eco in civitai::registry::MODEL3D_ECOSYSTEMS.iter() {
            assert!(civitai::registry::model3d_ecosystem(eco.key).is_some());
        }
        // The image workflow enum is restated in the schema (the registry's
        // WORKFLOWS table is private) — pin it to the registry.
        for workflow in ["txt2img", "txt2img:hires-fix", "img2img", "img2img:upscale"] {
            assert!(
                civitai::registry::workflow(workflow).is_some(),
                "image workflow {workflow} is advertised but unknown"
            );
        }
    }

    /// Name in, kind out: the tools the frontend renders must keep emitting the
    /// flat, `kind`-tagged envelopes their views read, and the spend tools must
    /// stay behind the confirmation gate on BOTH paths.
    #[test]
    fn tool_surface_is_flat_kind_tagged_and_gated() {
        let set = build("test-user", "test-bearer");
        let definitions = set.get_tool_definitions();
        let names: Vec<&str> = definitions.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                IMAGE_TOOL,
                VIDEO_SUBMIT,
                VIDEO_FETCH,
                MUSIC_SUBMIT,
                MUSIC_FETCH,
                MODEL3D_SUBMIT,
                MODEL3D_FETCH,
            ]
        );
        for def in definitions {
            let spend = def.requires_confirmation;
            let expected = !def.name.ends_with("_fetch");
            assert_eq!(spend, expected, "{} confirmation gate", def.name);
            let produces = &def.produces;
            if def.name.ends_with("_submit") {
                assert_eq!(produces, &vec!["workflowId".to_string()]);
            } else {
                assert_eq!(produces, &vec!["files".to_string()]);
            }
        }
        // The resolver that the chat path actually consults.
        let resolver = definition().capability_for_tool;
        assert_eq!(
            resolver(IMAGE_TOOL),
            Some(AgentCapability::Confirmation)
        );
        assert_eq!(resolver(VIDEO_FETCH), None);

        // The bearer gate never fails open: a user with no stored session
        // token gets no generation tools at all (the same answer the web
        // transport always gets).
        assert!(toolset("no-such-user-has-no-token-file").is_none());
    }

    /// The still-running envelope is what the model loops on — its shape is a
    /// contract (kind/lane/workflowId/status/queuePosition/note).
    #[test]
    fn still_running_envelope_is_flat_and_kind_tagged() {
        let body = still_running(Lane::Video, "wf-1", "processing", Some(3));
        let value: Value = serde_json::from_str(&body).expect("valid json");
        assert_eq!(value["kind"], "civitai_video");
        assert_eq!(value["lane"], "video");
        assert_eq!(value["workflowId"], "wf-1");
        assert_eq!(value["status"], "processing");
        assert_eq!(value["queuePosition"], 3);
        assert!(value["note"].as_str().unwrap().contains(VIDEO_FETCH));
    }

    /// The image confirmation must quote the same price the panel shows: the
    /// prompt's numbers come from the same estimate the spend gate uses.
    #[test]
    fn image_confirmation_quotes_the_panel_price() {
        let args = json!({ "prompt": "a cat", "width": 1024, "height": 1024, "quantity": 2 });
        let prompt = confirmation(IMAGE_TOOL, &args).expect("image spends, so it is confirmed");
        let params = serde_json::from_value::<GenerateImageArgs>(args)
            .unwrap()
            .into_params();
        let buzz = civitai::image_buzz_estimate(&params);
        let tokens = civitai::buzz_to_tokens(buzz);
        assert!(prompt.prompt.contains(&format!("{buzz} Buzz")));
        assert!(prompt.prompt.contains(&format!("{tokens} token")));
        assert!(confirmation(VIDEO_FETCH, &json!({})).is_none());
    }

    /// Arg defaults: a caller that only knows the prompt still gets a valid
    /// shape (the panel's own defaults), and the registry picks the ecosystem.
    #[test]
    fn image_args_default_to_a_valid_shape() {
        let params = serde_json::from_value::<GenerateImageArgs>(json!({ "prompt": "x" }))
            .unwrap()
            .into_params();
        assert_eq!(params.width, 1024);
        assert_eq!(params.height, 1024);
        assert_eq!(
            params.ecosystem,
            civitai::registry::default_ecosystem_for_workflow(civitai::registry::DEFAULT_WORKFLOW)
                .unwrap()
        );
        assert!(params.workflow.is_none());
        params.validate().expect("defaults must validate");
    }
}
