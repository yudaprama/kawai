//! Supervisor entry point: registry builder and streaming execution.
//!
//! Translates the existing per-agent `ToolSet` catalog into a flat
//! [`kawai_router::ToolRegistry`] so the deterministic scheduler can
//! dispatch steps directly against the application's tool implementations.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_core::Stream;
use futures_util::StreamExt;
use kawai_router::{ToolCall, ToolDispatch, ToolKind, ToolMeta, ToolRegistry};
use serde::Serialize;

use crate::agent_registry;

// ── Events ──────────────────────────────────────────────────────────────────

/// Plan structure for one step, sent with `planStarted` so the frontend can
/// render the full plan (tools, tasks, dependencies) before any step runs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepInfo {
    pub id: String,
    pub tool: String,
    pub task: String,
    pub depends_on: Vec<String>,
}

/// Artifact emitted by a completed step, carried on `stepCompleted` so the
/// frontend can render files/structured results instead of a text summary.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    /// `text` | `file` | `structured` | `handle`
    pub kind: String,
    pub handle: Option<String>,
    pub filename: Option<String>,
    /// Human-readable one-liner for the progress UI — the frontend never
    /// renders raw handles or a generic "structured result" (see
    /// PLAN-supervisor-ui-ux.md R5).
    pub label: Option<String>,
}

fn artifact_infos(output: &str) -> Vec<ArtifactInfo> {
    tool_output_artifacts(output)
        .iter()
        .map(|a| match a {
            kawai_router::Artifact::File { handle, filename, .. } => ArtifactInfo {
                kind: "file".into(),
                handle: Some(handle.clone()),
                filename: filename.clone(),
                label: None,
            },
            kawai_router::Artifact::Structured { value } => ArtifactInfo {
                kind: "structured".into(),
                handle: None,
                filename: None,
                // Describe the payload by its shape — e.g. "table: 4 rows ×
                // 3 cols" or "keys: files, total" — never a generic
                // "structured result".
                label: Some(structured_label(value)),
            },
            kawai_router::Artifact::Handle { kind, .. } => ArtifactInfo {
                kind: "handle".into(),
                handle: kind.clone(),
                filename: None,
                label: Some("stored result".into()),
            },
            kawai_router::Artifact::Text { .. } => ArtifactInfo {
                kind: "text".into(),
                handle: None,
                filename: None,
                label: None,
            },
        })
        .collect()
}

/// One-line description of a structured payload for the progress UI.
fn structured_label(value: &serde_json::Value) -> String {
    if let Some(array) = value.as_array() {
        let (rows, cols) = (array.len(), array.first().and_then(|v| v.as_object()).map(|o| o.len()));
        return match cols {
            Some(c) => format!("table: {rows} rows × {c} cols"),
            None => format!("list: {rows} items"),
        };
    }
    if let Some(obj) = value.as_object() {
        let keys: Vec<&String> = obj.keys().take(3).collect();
        if !keys.is_empty() {
            let more = obj.len().saturating_sub(keys.len());
            let more = if more > 0 { format!(", +{more} more") } else { String::new() };
            let joined: Vec<&str> = keys.iter().map(|k| k.as_str()).collect();
            return format!("data: {}{}", joined.join(", "), more);
        }
        return "data object".into();
    }
    if value.is_string() {
        return "text result".into();
    }
    "data".into()
}

fn plan_step_infos(plan: &kawai_router::TaskPlan) -> Vec<PlanStepInfo> {
    plan.steps
        .iter()
        .map(|s| PlanStepInfo {
            id: s.id.clone(),
            tool: s.tool.clone().unwrap_or_else(|| s.agent_id.clone()),
            // Plans may omit `task` (token economy) — fall back to the tool
            // name so the progress panel never shows an empty label.
            task: if s.task.is_empty() {
                s.tool.clone().unwrap_or_else(|| s.agent_id.clone())
            } else {
                s.task.clone()
            },
            depends_on: s.depends_on.clone(),
        })
        .collect()
}

/// Progress events emitted by the supervisor as it executes a plan.
/// `rename_all` renames VARIANTS; `rename_all_fields` (serde 1.0.185+) is
/// required to also camelCase the struct-variant FIELDS — without it the
/// wire format was snake_case (step_id, final_output) while the frontend
/// reads camelCase, silently dropping every multi-word field.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SupervisorEvent {
    PlanStarted {
        goal: String,
        step_count: usize,
        steps: Vec<PlanStepInfo>,
        /// Hash of the executed plan — the read key for persisted step results
        /// (`supervisor_step_output` op). Changes when the plan is revised.
        plan_key: String,
    },
    StepStarted {
        step_id: String,
        tool: String,
    },
    ConfirmationRequested {
        stream_id: String,
        step_id: String,
        task: String,
        description: String,
    },
    StepCompleted {
        step_id: String,
        output: String,
        artifacts: Vec<ArtifactInfo>,
        /// Retries the scheduler spent on this step (0 = first attempt
        /// succeeded) — drives the retry indicator in the progress UI.
        retries_used: usize,
    },
    StepFailed {
        step_id: String,
        error: String,
        /// Failure class for UI/telemetry: `timeout` | `confirmation` |
        /// `cancelled` | `tool`.
        kind: &'static str,
    },
    StepSkipped {
        step_id: String,
        reason: String,
    },
    /// A step failed and the supervisor is asking the planner to revise the
    /// remaining plan (failure-triggered replan; budget-capped).
    PlanRevising {
        failed_step_ids: Vec<String>,
        attempt: u32,
    },
    /// The planner produced a revised plan; execution restarts on it. Step
    /// ids are new — the frontend re-seeds its plan state from `steps`.
    PlanRevised {
        attempt: u32,
        step_count: usize,
        steps: Vec<PlanStepInfo>,
        /// Key of the REVISED plan — replaces the planStarted key for all
        /// subsequent `supervisor_step_output` reads.
        plan_key: String,
    },
    /// Emitted once at `plan_task` entry — the instant acknowledgment that
    /// planning began (context building + the first LLM round can stay
    /// silent for tens of seconds after this).
    PlanningStarted {},
    /// Emitted per planner LLM round while `plan_task` runs — the only live
    /// signal the UI gets during the otherwise-silent planning phase. Fired
    /// TWICE per round: once when the round opens (`provider` empty — the
    /// request is still in flight), once when a provider completes it.
    PlanningRound {
        /// 1-based planner call number.
        round: u32,
        /// Provider label that served the round (pool telemetry).
        provider: String,
        /// True while the round requested tool-catalog searches (vs emitting
        /// the final plan).
        searching: bool,
    },
    /// Tool names a planning search round surfaced for the first time.
    PlanningToolSearch {
        queries: Vec<String>,
        tools: Vec<String>,
    },
    PlanCompleted {
        final_output: Option<String>,
    },
    PlanFailed {
        error: String,
    },
}

// ── Registry builder ────────────────────────────────────────────────────────

/// Universal execution mode: the plan is built and dispatched against the
/// merged catalog of every available domain toolset. Explicit agent ids
/// remain as an optional narrowing hint.
pub const AUTO_AGENT_ID: &str = "auto";

/// Build the supervisor toolset for a request.
///
/// `auto` merges every available domain toolset into one registry so the
/// planner can pick tools across domains (cross-domain plans). An explicit
/// agent id narrows the catalog to that domain's toolset.
async fn build_supervisor_toolset(
    user_id: &str,
    session_id: i64,
    agent_id: &str,
 ) -> Option<kawai_tools::ToolSet> {
    let remote_configured = remote_llm::RemoteLlm::from_env().is_some();
    let sql_profiles = kawai_analytics::effective_profiles(user_id).await;
    let context = kawai_agent_contract::AgentContext {
        user_id,
        session_id,
        sql_profiles: Some(sql_profiles.as_slice()),
    };

    // Domain builders. Do not expose the office superset to analytics/binance
    // plans when a specialist is chosen explicitly.
    let office = || -> Option<kawai_tools::ToolSet> {
        agent_registry::office_tools(&context, remote_configured)
    };
    let presentation = || -> Option<kawai_tools::ToolSet> {
        agent_registry::presentation_tools_for_supervisor(&context, remote_configured)
    };
    let binance = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        { agent_registry::binance_tools_for_supervisor(&context, remote_configured) }
        #[cfg(not(feature = "litert"))]
        {
            let _ = (&context, remote_configured);
            None
        }
    };
    let analytics = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        { agent_registry::analytics_tools_for_supervisor(&context, remote_configured) }
        #[cfg(not(feature = "litert"))]
        {
            let _ = (&context, remote_configured);
            None
        }
    };
    let finance = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        { agent_registry::finance_tools_for_supervisor(&context, remote_configured) }
        #[cfg(not(feature = "litert"))]
        {
            let _ = (&context, remote_configured);
            None
        }
    };
    let entertainment = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        { agent_registry::entertainment_tools_for_supervisor(&context, remote_configured) }
        #[cfg(not(feature = "litert"))]
        {
            let _ = (&context, remote_configured);
            None
        }
    };
    let generated = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        {
            let mut set = kawai_tools::ToolSet::default();
            for tools in [
                agent_registry::weather_geo_tools_for_supervisor(&context, remote_configured),
                agent_registry::news_media_tools_for_supervisor(&context, remote_configured),
                agent_registry::sports_tools_for_supervisor(&context, remote_configured),
                agent_registry::food_drink_tools_for_supervisor(&context, remote_configured),
                agent_registry::geospace_tools_for_supervisor(&context, remote_configured),
                agent_registry::knowledge_tools_for_supervisor(&context, remote_configured),
                agent_registry::religion_tools_for_supervisor(&context, remote_configured),
                agent_registry::utility_tools_for_supervisor(&context, remote_configured),
            ] {
                if let Some(mut tools) = tools {
                    set.merge(&mut tools);
                }
            }
            Some(set)
        }
        #[cfg(not(feature = "litert"))]
        {
            let _ = (&context, remote_configured);
            None
        }
    };

    if agent_id == AUTO_AGENT_ID {
        // Merged catalog: first-wins per tool name. Office first — its
        // knowledge/memory/subagent tools are the broadest base — then the
        // specialists fill in their exclusive domain tools.
        let mut merged: Option<kawai_tools::ToolSet> = None;
        for set in [
            office(),
            presentation(),
            binance(),
            analytics(),
            finance(),
            entertainment(),
            generated(),
        ]
            .into_iter()
            .flatten() {
            match &mut merged {
                Some(base) => base.merge(&mut { set }),
                None => merged = Some(set),
            }
        }
        return merged;
    }

    match agent_id {
        agent_registry::OFFICE_AGENT_ID => office(),
        agent_registry::PRESENTATION_AGENT_ID => presentation(),
        agent_registry::BINANCE_AGENT_ID => binance(),
        agent_registry::ANALYTICS_AGENT_ID => analytics(),
        agent_registry::ENTERTAINMENT_AGENT_ID => entertainment(),
        _ => None,
    }
}

/// Convert a [`kawai_tools::ToolDefinition`] into a [`kawai_router::ToolMeta`].
fn tool_meta_from_definition(def: &kawai_tools::ToolDefinition) -> ToolMeta {
    ToolMeta {
        name: def.name.clone(),
        kind: ToolKind::Pure,
        description: def.description.clone(),
        input_schema: def.parameters.clone(),
        output_schema: serde_json::json!({}),
        requires_confirmation: def.requires_confirmation,
    }
}

/// Render the user-context blocks that ride the planner call: the L3 persona,
/// goal-relevant memories (relevance-ranked; bumps access counters), the
/// user's skills, and the files attached to this run's session. Each block
/// degrades to empty on failure. Pure string assembly so tests can pin the
/// shape.
fn render_planner_context(
    persona_block: String,
    memories_block: String,
    skills_block: String,
    attached_files_block: String,
) -> String {
    if persona_block.is_empty()
        && memories_block.is_empty()
        && skills_block.is_empty()
        && attached_files_block.is_empty()
    {
        return String::new();
    }
    let mut out = String::from("<user-context>\nBackground about the user and this run's inputs. Ground decisions in it when relevant; ignore it when not.\n");
    for block in [persona_block, memories_block, skills_block, attached_files_block] {
        if !block.is_empty() {
            out.push_str(&block);
            out.push('\n');
        }
    }
    out.push_str("</user-context>");
    out
}

/// Cap on how many attached-file names ride the planner prompt (names only —
/// never ids or contents; scope stays server-side via the session binding).
const ATTACHED_FILES_MAX: usize = 20;

/// Names of the files attached to this run's session, as a planner-context
/// block. Without it the planner is blind to attachments: a neutral goal
/// ("make a summary") would plan no knowledge_search step, and the attached
/// files would never be read by any step. Names give the planner the semantic
/// signal to plan retrieval and write good queries; tabular files are flagged
/// so the planner routes them to the analytics tools instead. Best-effort —
/// a read failure degrades to an empty block, planning never fails on it.
async fn attached_files_block(user_id: &str, session_id: i64) -> String {
    let files = match crate::logic::rag::list_session_files(user_id, session_id).await {
        Ok(files) if !files.is_empty() => files,
        _ => return String::new(),
    };
    let mut out = String::from(
        "<attached-files>\nThe user attached these files to this run (their contents are searchable via knowledge_search):\n",
    );
    for f in files.iter().take(ATTACHED_FILES_MAX) {
        if kawai_office::store::is_tabular_ext(&f.ext) {
            out.push_str(&format!(
                "- {} (tabular — query structurally via the analytics tools)\n",
                f.original_name
            ));
        } else {
            out.push_str(&format!("- {}\n", f.original_name));
        }
    }
    out.push_str("</attached-files>");
    out
}

/// Build a [`ToolRegistry`] from the supervisor's toolset.
///
/// The registry contains metadata for the planner prompt and a dispatch
/// closure that delegates to [`kawai_tools::ToolSet::execute`].
pub async fn plan_task(
    user_id: &str,
    session_id: i64,
    goal: &str,
    registry: &ToolRegistry,
    on_progress: impl Fn(SupervisorEvent),
) -> Result<(kawai_router::TaskPlan, remote_llm::RemoteUsage), String> {
    // The remote pool serves the planner with a tight per-call output cap:
    // the loop's rounds must stay short (the 2026-02 benchmark showed 14.6k
    // output tokens = the whole 250 s latency).
    let remote = Some(
        remote_llm::RemoteLlm::from_env()
            .map(|r| r.with_output_cap(2_500))
            .ok_or_else(|| "remote LLM is not configured".to_string())?,
    );

    on_progress(SupervisorEvent::PlanningStarted {});

    // User context rides the planner call: persona + goal-relevant memories
    // + skills. All three are best-effort — planning never fails on them.
    // All independent, so they run concurrently — sequential awaits here were
    // the bulk of the dead time between submit and the first planner round.
    // The Turso catalog sync joins the same fan-out (best-effort).
    let (persona_block, memories_block, skills_block, attached_files_block, catalog) = tokio::join! {
        kawai_memory::persona_prompt_block(user_id),
        kawai_memory::prompt_block_relevant(user_id, goal),
        kawai_skills::prompt_block(user_id),
        attached_files_block(user_id, session_id),
        open_synced_catalog(PLAN_SEARCH_SYNC_TIMEOUT),
    };
    let context = render_planner_context(
        persona_block,
        memories_block,
        skills_block,
        attached_files_block,
    );

    // The planner sees NO full catalog. It discovers tools through bounded
    // search rounds against the Turso tool catalog, then emits the plan.
    // Core cross-cutting tools are always visible (retrieval misses them
    // disproportionately — measured, see tool_search_probe).
    let core_tools: Vec<String> = PLAN_CORE_TOOLS
        .iter()
        .filter(|name| registry.get(name).is_some())
        .map(|s| s.to_string())
        .collect();

    // LiteRT-ONLY embedder: the catalog is seeded in the on-device model's
    // space (seed_tool_catalog uses the same helper), so seed and query stay
    // in one space on every device — no cloud embedding dependency (the
    // OpenRouter pool 402'd mid-session and killed discovery), no fallback
    // into a different space.
    let embedder = kawai_embedding::build_litert_embedder();

    let system = plan_loop_system_prompt(&core_tools);
    let mut task = if context.is_empty() {
        format!("User goal:\n{goal}")
    } else {
        format!("{context}\n\nUser goal:\n{goal}")
    };
    let mut materials = String::new();
    let mut seen: std::collections::HashSet<String> = core_tools.iter().cloned().collect();
    let mut usage = remote_llm::RemoteUsage::default();
    let mut searches_used = 0usize;
    let mut repairs_used = 0usize;
    let mut calls = 0usize;

    loop {
        calls += 1;
        if calls > PLAN_MAX_CALLS {
            return Err(format!(
                "planner exceeded its call budget ({PLAN_MAX_CALLS} rounds) without producing a valid plan"
            ));
        }
        let must_plan = searches_used >= PLAN_SEARCH_ROUNDS;
        // Round-open signal — fired BEFORE the LLM round so the UI shows
        // motion during the (potentially long) first-token wait.
        on_progress(SupervisorEvent::PlanningRound {
            round: calls as u32,
            provider: String::new(),
            searching: !must_plan,
        });
        let mut round_materials = materials.clone();
        if must_plan {
            round_materials.push_str(
                "\n<system-note>Search budget exhausted. Respond ONLY with the final plan JSON now.</system-note>",
            );
        }

        let mut raw = String::new();
        {
            let mut stream = remote.as_ref().unwrap().stream(&system, &task, &round_materials).await?;
            while let Some(event) = stream.next().await {
                match event? {
                    remote_llm::RemoteEvent::Token { text } => {
                        if raw.len() < 32_000 {
                            raw.push_str(&text);
                        }
                    }
                    remote_llm::RemoteEvent::Done { usage: u, provider, .. } => {
                        // #5 observability: which candidate served the round
                        // (latency tuning data — see PLAN-planner-search-loop.md).
                        eprintln!("[plan_task] round {} served by {provider}", calls);
                        // Live progress for the transport layer (desktop Channel /
                        // web log) — the planning phase is otherwise silent for
                        // tens of seconds.
                        on_progress(SupervisorEvent::PlanningRound {
                            round: calls as u32,
                            provider: provider.to_string(),
                            searching: !must_plan,
                        });
                        usage.input_tokens += u.input_tokens;
                        usage.output_tokens += u.output_tokens;
                    }
                    _ => {}
                }
            }
        }

        let parsed: Option<serde_json::Value> = kawai_router::extract_json_slice(&raw)
            .ok()
            .and_then(|slice| serde_json::from_str(slice).ok());

        // Final plan?
        if let Some(v) = &parsed {
            if v.get("steps").is_some() && v.get("goal").is_some() {
                match parse_supervisor_plan(&raw, registry) {
                    Ok(plan) => return Ok((plan, usage)),
                    Err(plan_err) => {
                        // One corrective round with validator feedback, fuzzy
                        // name suggestions, and the schemas of every tool the
                        // rejected plan used — most rejections are missing or
                        // malformed arguments, and the model cannot fix them
                        // without the exact required properties in view.
                        if repairs_used < 2 {
                            repairs_used += 1;
                            let suggestions = suggest_tools(registry, &plan_err);
                            let used_tools: Vec<String> = v
                                .get("steps")
                                .and_then(|s| s.as_array())
                                .map(|steps| {
                                    steps
                                        .iter()
                                        .filter_map(|st| st.get("tool").and_then(|t| t.as_str()))
                                        .map(|t| t.to_string())
                                        .collect()
                                })
                                .unwrap_or_default();
                            let schemas = registry.catalog_lines_for(&used_tools);
                            materials.push_str(&format!(
                                "\n<plan-rejected>\nYour plan was rejected by the validator: {plan_err}\n{}\
                                 {}\
                                 Respond ONLY with the corrected plan JSON. Keep every required \
                                 argument from the input schemas below.\n{schemas}</plan-rejected>\n",
                                if suggestions.is_empty() {
                                    String::new()
                                } else {
                                    format!("Did you mean one of: {}?\n", suggestions.join(", "))
                                },
                                if schemas.is_empty() {
                                    String::new()
                                } else {
                                    format!("Schemas of the tools your plan used:\n")
                                },
                            ));
                            continue;
                        }
                        return Err(format!("plan validation failed: {plan_err}"));
                    }
                }
            }

            // Search action?
            if !must_plan {
                if let Some(queries) = v
                    .get("action")
                    .and_then(|a| a.as_str())
                    .filter(|a| *a == "search")
                    .and_then(|_| v.get("queries"))
                    .and_then(|q| q.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|q| q.as_str().map(|s| s.trim().to_string()))
                            .filter(|s| !s.is_empty())
                            .take(3)
                            .collect::<Vec<String>>()
                    })
                    .filter(|q| !q.is_empty())
                {
                    searches_used += 1;
                    let (block, found) =
                        run_tool_search(catalog.as_deref(), &embedder, &queries, &mut seen).await;
                    on_progress(SupervisorEvent::PlanningToolSearch {
                        queries: queries.clone(),
                        tools: found,
                    });
                    materials.push_str(&block);
                    continue;
                }
            }
        }

        // Protocol violation (not JSON, wrong shape, or search after budget).
        materials.push_str(
            "\n<system-note>Unrecognized response. Respond ONLY with one JSON object: \
             {\"action\":\"search\",\"queries\":[…]} or the final plan JSON.</system-note>",
        );
        if calls + 1 > PLAN_MAX_CALLS {
            return Err(
                "planner kept responding off-protocol and ran out of its call budget".to_string(),
            );
        }
    }
}

pub fn parse_supervisor_plan(raw: &str, registry: &ToolRegistry) -> Result<kawai_router::TaskPlan, String> {
    let slice = kawai_router::extract_json_slice(raw).map_err(|e| e.to_string())?;
    let plan: kawai_router::TaskPlan = serde_json::from_str(slice)
        .map_err(|e| format!("invalid plan JSON: {e}"))?;
    registry.validate_plan(&plan).map_err(|e| e.to_string())?;
    Ok(plan)
}

// ── Planner search-loop (mode A: no full-catalog fallback) ──────────────────

/// Open the Turso tool catalog and sync the local embedded replica, with every
/// failure surfaced on stderr. An unreachable sync is tolerated (the replica
/// serves its last synced state), but an EMPTY replica is treated as
/// unavailable: searching an empty catalog silently returns no hits, which
/// makes the planner believe no domain tools exist and degrade to the core
/// set (the session-25 failure class). Returning `None` there makes
/// `run_tool_search` report the outage honestly to the planner instead.
/// Shared catalog instance: ONE `Catalog` per process. Two instances on the
/// same replica file sync against each other and crash with
/// `wal_insert_begin failed` (measured: the startup prefetch loop racing
/// plan_task's lazy open).
static SHARED_CATALOG: tokio::sync::OnceCell<
    Option<std::sync::Arc<kawai_tool_catalog::Catalog>>,
> = tokio::sync::OnceCell::const_new();
/// Serializes every sync against the shared replica.
static CATALOG_SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Last time a sync attempt COMPLETED (success or logged failure) — a fresh
/// sync suppresses re-syncing for 10 minutes so prefetch and plan_task
/// don't stack retries on a flapping connection.
static LAST_SYNC_AT: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);
const SYNC_SUPPRESS: std::time::Duration = std::time::Duration::from_secs(600);

async fn shared_catalog() -> Option<std::sync::Arc<kawai_tool_catalog::Catalog>> {
    SHARED_CATALOG
        .get_or_try_init(|| async {
            type SharedCatalog = Option<std::sync::Arc<kawai_tool_catalog::Catalog>>;
            let Some(cfg) = kawai_tool_catalog::RemoteConfig::from_env() else {
                return Ok::<SharedCatalog, ()>(None);
            };
            match kawai_tool_catalog::Catalog::open_default(&cfg).await {
                Ok(c) => Ok(Some(std::sync::Arc::new(c))),
                Err(e) => {
                    eprintln!("[tool-catalog] open failed: {e}");
                    Ok(None)
                }
            }
        })
        .await
        .ok()
        .cloned()
        .flatten()
}

/// One serialized sync + freshness gate on the shared replica. Skipped when
/// a sync completed recently. Safe to call from anywhere (startup prefetch,
/// plan_task).
async fn sync_shared_catalog(sync_timeout: std::time::Duration) {
    let Some(catalog) = shared_catalog().await else {
        return;
    };
    if LAST_SYNC_AT
        .lock()
        .map(|t| t.map(|t| t.elapsed() < SYNC_SUPPRESS).unwrap_or(false))
        .unwrap_or(false)
    {
        return;
    }
    let _guard = CATALOG_SYNC_LOCK.lock().await;
    // Double-check after acquiring the lock (another task may have just
    // finished a sync while we waited).
    if LAST_SYNC_AT
        .lock()
        .map(|t| t.map(|t| t.elapsed() < SYNC_SUPPRESS).unwrap_or(false))
        .unwrap_or(false)
    {
        return;
    }
    match tokio::time::timeout(sync_timeout, catalog.sync()).await {
        Ok(Ok(frames)) if frames > 0 => {
            eprintln!("[tool-catalog] synced {frames} frames from remote");
        }
        Ok(Ok(_)) => {} // already up to date
        Ok(Err(e)) => eprintln!("[tool-catalog] sync failed: {e}"),
        Err(_) => {
            // Do NOT leave the sync dead: a dropped sync mid-WAL-apply
            // poisons the replica file. Hand it to the background to finish.
            eprintln!(
                "[tool-catalog] sync exceeded {sync_timeout:?} — continuing in background"
            );
            catalog.sync_detached();
        }
    }
    *LAST_SYNC_AT.lock().unwrap() = Some(std::time::Instant::now());

    // Freshness gate: a timed-out sync leaves the replica at an old
    // replication index — the planner would then search a catalog missing
    // the newest tools entirely (measured: a frozen 83-tool snapshot vs 144
    // on the remote). Verify and retry once before degrading.
    let Some(cfg) = kawai_tool_catalog::RemoteConfig::from_env() else {
        return;
    };
    if let Ok((local, remote)) = catalog.row_counts(&cfg).await {
        if local < remote {
            eprintln!(
                "[tool-catalog] replica STALE ({local} vs {remote} on remote) — retrying sync"
            );
            let _ = tokio::time::timeout(sync_timeout, catalog.sync()).await;
            catalog.sync_detached(); // never leave a dropped sync behind
            *LAST_SYNC_AT.lock().unwrap() = Some(std::time::Instant::now());
            match catalog.row_counts(&cfg).await {
                Ok((local, remote)) if local < remote => eprintln!(
                    "[tool-catalog] CRITICAL: replica still stale after retry \
                     ({local} vs {remote}) — planner sees an outdated catalog"
                ),
                Ok(_) => eprintln!("[tool-catalog] replica fresh after retry"),
                Err(e) => eprintln!("[tool-catalog] count check failed: {e}"),
            }
        }
    }
}

/// Startup prefetch: converge the replica in the background so plan_task
/// never pays (or loses) the first sync. Loop until fresh or attempts out.
pub fn prefetch_tool_catalog() {
    tauri::async_runtime::spawn(async {
        if shared_catalog().await.is_none() {
            return;
        }
        for attempt in 1..=5 {
            sync_shared_catalog(std::time::Duration::from_secs(60)).await;
            let Some(catalog) = shared_catalog().await else { return };
            let Some(cfg) = kawai_tool_catalog::RemoteConfig::from_env() else { return };
            match catalog.row_counts(&cfg).await {
                Ok((local, remote)) if local >= remote => break, // converged
                Ok((local, remote)) => {
                    eprintln!(
                        "[tool-catalog] prefetch: replica still stale ({local} vs {remote}), retrying"
                    );
                }
                Err(e) => {
                    eprintln!("[tool-catalog] prefetch count check failed: {e}");
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}

async fn open_synced_catalog(
    sync_timeout: std::time::Duration,
) -> Option<std::sync::Arc<kawai_tool_catalog::Catalog>> {
    let catalog = shared_catalog().await?;
    sync_shared_catalog(sync_timeout).await;
    match catalog.list_names().await {
        Ok(names) if !names.is_empty() => Some(catalog),
        Ok(_) => {
            eprintln!(
                "[tool-catalog] local replica is EMPTY (sync failed or remote unseeded) — \
                 planner restricted to core tools; re-seed via \
                 `cargo run --example seed_tool_catalog --features litert,binance,codegraph`"
            );
            None
        }
        Err(e) => {
            eprintln!("[tool-catalog] replica unreadable: {e}");
            None
        }
    }
}

/// Search rounds the planner may spend before it must emit the plan.
/// 2 rounds × up to 3 queries per round proved sufficient (probe: every
/// benchmark goal resolved in ≤1 effective round).
const PLAN_SEARCH_ROUNDS: usize = 2;
/// Hard cap on total LLM calls (search rounds + corrections + violations).
const PLAN_MAX_CALLS: usize = 6;
/// Cross-cutting tools retrieval misses disproportionately — always visible.
/// Only `memory_search` qualifies: user context must be recalled before
/// acting on nearly every goal. `web_search` is deliberately NOT core — it
/// lives in the catalog like any other tool, so the planner must surface it
/// through search instead of lazily defaulting to it (sessions 37–39: with
/// web_search always visible, the planner planned it for goals covered by
/// specialist tools like get_weather). Consequence: with the catalog truly
/// unavailable, almost no goal is plannable — fail fast beats a low-quality
/// generic answer.
/// All of them are DIRECTLY dispatchable toolset tools. Internal-dispatch
/// subagent tools (deep_write, draft_document, plan_task, plan_revise,
/// artifact_recall) are deliberately absent — the scheduler executes steps
/// via `ToolSet::execute`, where those tools return an "unavailable here"
/// error text instead of doing their work.
const PLAN_CORE_TOOLS: [&str; 1] = ["memory_search"];
/// Subagent/internal-dispatch tools: excluded from the supervisor registry
/// entirely so the planner can neither see nor plan against them. Must stay
/// in sync with `examples/catalog_composition::NON_DISPATCHABLE_TOOLS` —
/// the catalog is the planner's discovery path.
pub const NON_DISPATCHABLE_TOOLS: [&str; 5] = [
    "deep_write",
    "draft_document",
    "plan_task",
    "plan_revise",
    "artifact_recall",
];
/// Sync budget — an unreachable Turso must never stall planning, but it must
/// be long enough for the FIRST sync of a cold replica (a full frame pull,
/// not an incremental one); 5 s made the cold path time out and left the
/// replica permanently empty.
const PLAN_SEARCH_SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Cap on the accumulated search results package (matches the remote pool's
/// typical small-candidate materials budget).
const PLAN_MATERIALS_CAP: usize = 12_000;

fn plan_loop_system_prompt(core_tools: &[String]) -> String {
    format!(
        r#"You are a task planner for a deterministic supervisor.
The full tool catalog is NOT provided. Discover tools by searching.

Respond ONLY with ONE JSON object — either:
{{"action": "search", "queries": ["<search 1>", "<search 2>", "<search 3>"]}}
  (request tool search results; up to 3 diverse queries; describe CAPABILITIES, not tool names)
  — ALWAYS write the queries in ENGLISH: the catalog descriptions are English,
  so queries in any other language return junk and waste the search budget.
{{"goal": "<one-line goal>", "steps": [{{"id": "s1", "tool": "<exact name>", "task": "…", "arguments": {{}}, "dependsOn": [], "produces": [], "timeoutMs": 30000, "retries": 0, "onError": "fail", "requiresConfirmation": false}}]}}
  (the final plan, once you know which tools to use)

Plan rules:
- Decompose into 1..{} concrete steps; each step names exactly ONE tool.
- "task" is REQUIRED: a single line ≤80 chars describing the step in the
  USER'S LANGUAGE (the goal's language), for the progress UI — e.g.
  "Cek cuaca Tokyo", "Find 3 Bali beach photos". ALWAYS keep "arguments"
  complete and precise — the arguments are what the tool executes.
- Be concise overall: no prose outside the JSON, no repeated context.
- Be concise overall: no prose outside the JSON, no repeated context.
- "dependsOn" lists step ids that must finish first; no cycles.
- To pass a previous step's artifact: {{"fromStep": "<step id>", "output": "<artifact name>"}} — never paste large content.
- "produces" names the artifacts a step emits for later steps.
- Side-effect tools MUST set "requiresConfirmation": true with a short "confirmationDescription".
- "onError" is one of "fail", "skip", "continue". Default "fail".
 - Keep each task description under {} chars.
 - Core tools below are ALWAYS available — never search for them:
{}
 - PREFERENCE RULE: when a searched-and-surfaced tool matches a sub-task, you
   MUST use it instead of web_search. web_search is the FALLBACK for sub-tasks
   with no dedicated tool — never the default when a specialist exists.
 - FORBIDDEN tools — internal-only, validation will reject them: deep_write, draft_document, plan_task, plan_revise, artifact_recall. Never name them in steps. To create documents use office_create_document / office_create_deck / pdf_create_from_markdown.
 - The supervisor AUTOMATICALLY writes the final user-facing deliverable
   (answer / summary / report) from the step outputs after they finish — via a
   built-in "deliverable writer" agent you never see. NEVER plan a
   summarization / writing / "produce the answer" step yourself; plan only the
   data-gathering and artifact-producing steps that feed it.
 - If told the search budget is exhausted, respond ONLY with the final plan JSON.
"#,
        kawai_router::types::MAX_PLAN_STEPS,
        kawai_router::types::MAX_TASK_CHARS,
        core_tools
            .iter()
            .map(|n| format!("- {n}"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// Execute one search round: embed the queries, hit the Turso catalog,
/// dedupe against everything already shown, and format the results block.
/// Returns the block plus the names of the newly surfaced tools (planner
/// progress telemetry).
async fn run_tool_search(
    catalog: Option<&kawai_tool_catalog::Catalog>,
    embedder: &kawai_embedding::TenantAwareEmbedder,
    queries: &[String],
    seen: &mut std::collections::HashSet<String>,
) -> (String, Vec<String>) {
    let Some(catalog) = catalog else {
        return ("\n<tool-search-results>\nTool catalog is unavailable; rely on the core tools listed above.\n</tool-search-results>\n".to_string(), Vec::new());
    };
    // Primary provider ONLY: the catalog is seeded with provider #1's
    // embedding space. A silent fallback to another model (the local LiteRT
    // embedder, same 768-dim) is a different space — cosine becomes noise
    // and the search returns junk (planner sessions 41–42).
    let vecs = match embedder.embed_primary(queries.to_vec()).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[plan_task] catalog embedding failed (primary provider): {e}");
            return ("\n<tool-search-results>\nTool search failed (embedding unavailable); rely on the core tools listed above.\n</tool-search-results>\n".to_string(), Vec::new());
        }
    };
    let mut block = String::from("\n<tool-search-results>\n");
    let mut found: Vec<String> = Vec::new();
    for (query, qvec) in queries.iter().zip(vecs) {
        block.push_str(&format!("\nquery: {query}\n"));
        // k=8 (was 6): the vector side is noisy — generic-description tools
        // (binance_price, get_sector_performance, …) rank for nearly every
        // query, crowding the specialist tools out of the fused top-k. More
        // slots give BM25-side specialist hits room to survive the fusion.
        let hits = match catalog.search(query, &qvec, 8).await {
            Ok(hits) => hits,
            Err(e) => {
                eprintln!("[plan_task] catalog search failed for {query:?}: {e}");
                block.push_str("- (search failed for this query)\n");
                continue;
            }
        };
        let mut surfaced: Vec<String> = Vec::new();
        let mut listed = 0;
        for hit in hits {
            // Belt-and-suspenders: the catalog should never contain these
            // (see catalog_composition::NON_DISPATCHABLE_TOOLS /
            // BROWSER_INTERNAL_TOOLS), but a stale replica can still surface
            // them — filter here so validation never has to reject a plan for
            // a tool it cannot dispatch.
            if NON_DISPATCHABLE_TOOLS.contains(&hit.name.as_str())
                || hit.name.starts_with("browser_")
            {
                continue;
            }
            if !seen.insert(hit.name.clone()) {
                continue; // already visible to the planner
            }
            listed += 1;
            found.push(hit.name.clone());
            surfaced.push(hit.name.clone());
            let desc: String = hit.description.chars().take(160).collect();
            let schema: String = hit.input_schema.chars().take(300).collect();
            block.push_str(&format!("- {} — {desc}\n  args: {schema}\n", hit.name));
        }
        if listed == 0 {
            block.push_str("- (no new tools beyond those already listed)\n");
        }
        // Planner-search telemetry: which query surfaced which tools (the
        // search block itself is otherwise invisible outside the LLM call).
        eprintln!("[plan_task] search {query:?} -> {surfaced:?}");
    }
    block.push_str("</tool-search-results>\n");
    (truncate_chars(&block, PLAN_MATERIALS_CAP), found)
}

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

/// Registry names most similar to the unknown tool name mentioned in a
/// validation error: shared-underscore-token overlap, top 4. Heuristic on
/// purpose — it only feeds a corrective hint to the planner.
fn suggest_tools(registry: &ToolRegistry, plan_err: &str) -> Vec<String> {
    let err_lower = plan_err.to_lowercase();
    let mut scored: Vec<(usize, String)> = registry
        .metas()
        .filter_map(|meta| {
            let name_lower = meta.name.to_lowercase();
            let score = name_lower
                .split('_')
                .filter(|tok| tok.len() >= 3 && err_lower.contains(tok))
                .count();
            (score > 0).then_some((score, meta.name.clone()))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.truncate(4);
    scored.into_iter().map(|(_, name)| name).collect()
}

// ── Planner catalog narrowing (Turso tool catalog) ──────────────────────────

/// Below this size the full catalog is always pasted into the planner prompt
/// (small catalogs plan better unfiltered).
const NARROW_MIN_TOOLS: usize = 60;
/// Top-k tools admitted to the prompt when narrowing kicks in.
const NARROW_TOP_K: usize = 40;
/// Sync budget — an unreachable Turso must never stall planning.
const NARROW_SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Narrow the planner prompt's tool catalog to the top-k entries the remote
/// Turso tool catalog ranks as relevant to the goal (vector + BM25 fused via
/// RRF over an embedded replica — offline-safe via the last synced state).
///
/// Purely advisory: the result only shapes the prompt. Plan validation and
/// dispatch stay against the FULL registry, so a stale catalog (or one that
/// names tools this install cannot dispatch) degrades gracefully. Every
/// failure mode — no Turso config, no embedder, sync timeout, dimension
/// mismatch, empty intersection — falls back to `None` = full catalog.
pub async fn narrow_registry_for_goal(registry: &ToolRegistry, goal: &str) -> Option<ToolRegistry> {
    narrow_registry_for_goal_with(registry, goal, NARROW_MIN_TOOLS, NARROW_TOP_K).await
}

/// Parametrized variant of [`narrow_registry_for_goal`] (inspection/test
/// seam): `min_tools` is the activation threshold, `top_k` the admitted set.
pub async fn narrow_registry_for_goal_with(
    registry: &ToolRegistry,
    goal: &str,
    min_tools: usize,
    top_k: usize,
) -> Option<ToolRegistry> {
    if registry.len() <= min_tools {
        return None;
    }
    let cfg = kawai_tool_catalog::RemoteConfig::from_env()?;
    let model = kawai_embedding::build_providers_from_env();
    let query_vec = model
        .embed_strings(vec![goal.to_string()])
        .await
        .ok()?
        .into_iter()
        .next()?;
    let catalog = open_synced_catalog(NARROW_SYNC_TIMEOUT).await?;
    let hits = catalog.search(goal, &query_vec, top_k).await.ok()?;
    let keep: std::collections::HashSet<String> =
        hits.into_iter().map(|t| t.name).collect();
    let narrowed = registry.narrowed(&keep);
    if narrowed.is_empty() {
        None
    } else {
        Some(narrowed)
    }
}

/// Stable key for one plan execution: SHA-256 hex of the plan JSON.
///
/// SHA-256 is used instead of `DefaultHasher` because `std::hash` does not
/// guarantee cross-Rust-version stability — a toolchain bump could orphan
/// old memo rows. SHA-256 is deterministic across all platforms and compiler
/// versions.
///
/// Re-executing the SAME plan (resume) reuses the key — identical completed
/// steps are served from the persisted ExecutionMemo seed; a revised or
/// edited plan gets a different key and never reuses stale results.
pub fn plan_key(plan: &kawai_router::TaskPlan) -> String {
    use sha2::Digest;
    let serialized = serde_json::to_string(plan)
        .expect("plan serialization must not fail (all TaskPlan fields are infallible)");
    let hash = sha2::Sha256::digest(serialized.as_bytes());
    hex::encode(hash)
}

/// Full body of one persisted step result — the read path the wire preview
/// (stepCompleted's 2000-char cap) deliberately does not serve. The latest
/// row wins: upserts are keyed on (session, plan_key, tool, args_key), so a
/// step id may map to several rows across re-runs of the same plan.
pub async fn step_output(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
    step_id: &str,
) -> Result<String, String> {
    let rows = kawai_db::list_supervisor_step_results(user_id, session_id, plan_key)
        .await
        .map_err(|e| format!("supervisor_step_output: {e}"))?;
    rows.into_iter()
        .rev()
        .find(|r| r.step_id == step_id)
        .map(|r| r.output)
        .ok_or_else(|| format!("no persisted output for step '{step_id}'"))
}

pub async fn build_supervisor_registry(
    user_id: &str,
    session_id: i64,
    agent_id: &str,
    plan_key: &str,
) -> Result<ToolRegistry, String> {
    let toolset = build_supervisor_toolset(user_id, session_id, agent_id).await.ok_or_else(|| {
        if agent_id == AUTO_AGENT_ID {
            "no supervisor toolsets available (all domain builders returned None)".to_string()
        } else {
            format!("no toolset available for agent '{agent_id}'")
        }
    })?;

    // Convert definitions → ToolMeta, and keep each tool's input schema at
    // hand for dispatch-time coercion of resolved artifact references.
    // Internal-dispatch subagent tools are dropped: they are engine
    // capabilities, not scheduler-executable steps (ToolSet::execute on them
    // returns an "unavailable here" error text as a fake success).
    let definitions: Vec<_> = toolset
        .get_tool_definitions()
        .iter()
        .filter(|d| !NON_DISPATCHABLE_TOOLS.contains(&d.name.as_str()))
        .cloned()
        .collect();
    let schemas: std::collections::HashMap<String, serde_json::Value> = definitions
        .iter()
        .map(|d| (d.name.clone(), d.parameters.clone()))
        .collect();
    let schemas = std::sync::Arc::new(schemas);

    // Build the dispatch closure — captures a cloned ToolSet.
    let dispatch_toolset = toolset;
    // Idempotency memo: an identical COMPLETED call earlier in this plan
    // execution is served from the memo, never re-executed. Failed attempts
    // are not memoized, so scheduler retry semantics are untouched. Seeded
    // from supervisor_step_results (same plan key) so RESUMING a plan skips
    // steps that already completed before a crash/failure.
    let memo = Arc::new(kawai_router::ExecutionMemo::new());
    if !plan_key.is_empty() {
        match kawai_db::list_supervisor_step_results(user_id, session_id, plan_key).await {
            Ok(rows) => {
                let resumed = rows.len();
                for row in rows {
                    let artifacts = serde_json::from_str::<Vec<kawai_router::Artifact>>(
                        &row.artifacts_json,
                    )
                    .unwrap_or_default();
                    memo.insert_raw(&row.tool, &row.args_key, row.output, artifacts);
                }
                if resumed > 0 {
                    eprintln!(
                        "[supervisor] resume seed: {resumed} persisted step result(s) for plan {plan_key}"
                    );
                }
            }
            Err(e) => eprintln!("[supervisor] resume seed unavailable: {e}"),
        }
    }
    let db_user_id = user_id.to_string();
    let db_plan_key = plan_key.to_string();
    let dispatch: ToolDispatch = Arc::new(move |call: ToolCall| {
        let toolset = dispatch_toolset.clone();
        let schemas = Arc::clone(&schemas);
        let memo = Arc::clone(&memo);
        let db_user_id = db_user_id.clone();
        let db_plan_key = db_plan_key.clone();
        let db_session_id = session_id;
        Box::pin(async move {
            let name = call.step.dispatch_key().to_string();
            let args_value = coerce_resolved_args(&name, &call.args, schemas.get(&name));
            if let Some(hit) = memo.get(&name, &args_value) {
                return Ok(kawai_router::StepResult {
                    step_id: call.step.id,
                    agent_id: call.step.agent_id,
                    status: kawai_router::StepStatus::Completed,
                    output: hit.output,
                    artifacts: hit.artifacts,
                    error: None,
                    retries_used: 0,
                    error_kind: kawai_router::FailureKind::Other,
                });
            }
            let args = kawai_router::canonical_json(&args_value);
            let started = std::time::Instant::now();
            let result = toolset.execute(&name, args.clone()).await;
            let latency_ms = started.elapsed().as_millis() as i64;
            // Per-step telemetry (turn_log) — best-effort, never fails a step.
            let success = result.is_success();
            kawai_db::log_turn(
                &db_user_id,
                kawai_db::TurnLogEntry {
                    session_id: db_session_id,
                    agent_id: call.step.agent_id.as_str(),
                    provider: "supervisor",
                    tool: Some(name.as_str()),
                    input_tokens: None,
                    output_tokens: result.text().map(|t| t.len() as i64 / 4),
                    latency_ms,
                    outcome: if success { "tool" } else { "error" },
                },
            )
            .await;

            let output = result.text().unwrap_or("").to_string();
            let (error, status) = if result.is_success() {
                (None, kawai_router::StepStatus::Completed)
            } else {
                (
                    result.error_message().map(String::from),
                    kawai_router::StepStatus::Failed,
                )
            };
            let artifacts = if status == kawai_router::StepStatus::Completed {
                let extracted = tool_output_artifacts(&output);
                memo.insert(&name, &args_value, output.clone(), extracted.clone());
                // Persist for plan resume (best-effort — never fail a step on
                // a cache write).
                let record = kawai_db::SupervisorStepResult {
                    tool: name.clone(),
                    args_key: args,
                    step_id: call.step.id.clone(),
                    output: output.clone(),
                    artifacts_json: serde_json::to_string(&extracted).unwrap_or_default(),
                };
                if let Err(e) =
                    kawai_db::upsert_supervisor_step_result(&db_user_id, db_session_id, &db_plan_key, &record)
                        .await
                {
                    eprintln!("[supervisor] step result persist failed: {e}");
                }
                extracted
            } else {
                Vec::new()
            };
            Ok(kawai_router::StepResult {
                step_id: call.step.id,
                agent_id: call.step.agent_id,
                status,
                output,
                artifacts,
                error,
                retries_used: 0,
                    error_kind: kawai_router::FailureKind::Other,
            })
        })
    });

    let mut registry = ToolRegistry::new(dispatch);
    for def in &definitions {
        registry.register(tool_meta_from_definition(def));
    }

    Ok(registry)
}

/// Convert structured tool envelopes into scheduler artifacts.
/// Coerce artifact-reference resolutions that don't match the tool's input
/// schema. The planner wires a producer step's list output (e.g.
/// `office_list_files`' `files` array) into a scalar consumer argument
/// (`fileId`) — deterministic plans have no select mechanism, so the intent
/// is unambiguous: use the file the session provides. Only string-typed
/// schema properties are coerced, and only from shapes the resolver can
/// produce (file objects with `id`/`handle`, or a list of them).
fn coerce_resolved_args(
    tool: &str,
    args: &serde_json::Value,
    schema: Option<&serde_json::Value>,
) -> serde_json::Value {
    let Some(schema) = schema else { return args.clone(); };
    let Some(properties) = schema.get("properties").and_then(|v| v.as_object()) else {
        return args.clone();
    };
    let Some(arg_obj) = args.as_object() else { return args.clone(); };
    let wants_string = |prop_schema: &serde_json::Value| {
        match prop_schema.get("type") {
            Some(serde_json::Value::String(t)) => t == "string",
            Some(serde_json::Value::Array(types)) => types
                .iter()
                .filter_map(|v| v.as_str())
                .any(|t| t == "string"),
            _ => false,
        }
    };
    let pick_id = |v: &serde_json::Value| -> Option<serde_json::Value> {
        // Prefer the PDF entry in a files list when the consumer is a pdf_
        // tool; otherwise the first entry.
        let candidate = |e: &serde_json::Value| -> Option<serde_json::Value> {
            // Only file-like objects are unambiguous; plain strings are left
            // alone so list→scalar mistakes fail loudly at the tool instead
            // of silently taking the first element.
            match e {
                serde_json::Value::Object(o) => o
                    .get("id")
                    .or_else(|| o.get("handle"))
                    .filter(|v| v.is_string())
                    .cloned(),
                _ => None,
            }
        };
        match v {
            serde_json::Value::Array(items) => {
                let chosen = if tool.starts_with("pdf_") {
                    items
                        .iter()
                        .find(|e| e.get("ext").and_then(|x| x.as_str()) == Some("pdf"))
                        .or_else(|| items.first())
                } else {
                    items.first()
                };
                chosen.and_then(candidate)
            }
            serde_json::Value::Object(_) => candidate(v),
            _ => None,
        }
    };
    let mut out = arg_obj.clone();
    for (key, value) in arg_obj {
        let Some(prop_schema) = properties.get(key) else { continue };
        if !wants_string(prop_schema) || value.is_string() {
            continue;
        }
        if let Some(coerced) = pick_id(value) {
            out.insert(key.clone(), coerced);
        }
    }
    serde_json::Value::Object(out)
}

fn tool_output_artifacts(output: &str) -> Vec<kawai_router::Artifact> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return vec![kawai_router::Artifact::text(output.to_string())];
    };
    if let Some(file) = value.get("file").or_else(|| value.get("output_file")) {
        if let (Some(id), Some(name)) = (
            file.get("id").and_then(|v| v.as_str()),
            file.get("originalName").or_else(|| file.get("filename")).and_then(|v| v.as_str()),
        ) {
            return vec![kawai_router::Artifact::File {
                handle: id.to_string(), mime: None, filename: Some(name.to_string()),
            }];
        }
    }
    vec![kawai_router::Artifact::Structured { value }]
}

// ── Streaming execution ─────────────────────────────────────────────────────

/// Execute a [`kawai_router::TaskPlan`] and yield progress events.
///
/// The registry must already be built via [`build_supervisor_registry`].
/// The stream emits [`SupervisorEvent`]s as steps start, complete, fail,
/// or are skipped, ending with `PlanCompleted` or `PlanFailed`.
/// Pending confirmation: `step_id` → completer for the awaiting gate.
/// Frontend responses route through [`respond_supervisor_confirmation`].
pub type PendingConfirmations = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>;

pub fn confirmation_key(stream_id: &str, step_id: &str) -> String {
    format!("{stream_id}\u{1f}{step_id}")
}

/// Convert one scheduler event to its transport form, logging it on the way
/// through — per-step lifecycle telemetry for this otherwise-silent path.
/// Convert the router's typed failure classification to the transport string.
fn step_error_kind(kind: &kawai_router::FailureKind) -> &'static str {
    match kind {
        kawai_router::FailureKind::Timeout => "timeout",
        kawai_router::FailureKind::Confirmation => "confirmation",
        kawai_router::FailureKind::Cancelled => "cancelled",
        kawai_router::FailureKind::Tool | kawai_router::FailureKind::Other => "tool",
    }
}

/// Wire cap for the per-step `output` carried by `stepCompleted` events.
/// Full step outputs stay in the scheduler (dependent-step `inputs`) and the
/// resume memo / `supervisor_step_results` — those need the whole body. The
/// frontend only previews (160 chars) and persists to history (500 chars),
/// so the transport event carries a bounded preview. The plan's FINAL
/// output (`planCompleted.final_output`) is the user-visible answer and is
/// deliberately NOT capped here.
const STEP_EVENT_OUTPUT_MAX_CHARS: usize = 2000;

/// The virtual post-plan step that writes the user-facing deliverable.
/// Not part of the TaskPlan — emitted as lifecycle events so the UI can show
/// synthesis as real, trackable work.
pub const DELIVERABLE_STEP_ID: &str = "__deliverable";
pub const DELIVERABLE_TOOL: &str = "deliverable_writer";

/// Char-boundary-safe prefix of `s` (at most `max_chars` characters).
fn preview_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn log_scheduler_event(stream_id: &str, event: kawai_router::SchedulerEvent) -> SupervisorEvent {
    let label = match &event {
        kawai_router::SchedulerEvent::StepStarted { step_id, tool } => {
            format!("stepStarted step={step_id} tool={tool}")
        }
        kawai_router::SchedulerEvent::ConfirmationRequested { step_id, .. } => {
            format!("confirmationRequested step={step_id}")
        }
        kawai_router::SchedulerEvent::StepCompleted { step_id, output, retries_used } => {
            format!("stepCompleted step={step_id} output_len={} retries={retries_used}", output.len())
        }
        kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => {
            format!("stepFailed step={step_id} error={:?}", error)
        }
        kawai_router::SchedulerEvent::StepSkipped { step_id, reason } => {
            format!("stepSkipped step={step_id} reason={reason}")
        }
    };
    eprintln!("[supervisor] {label}");
    match event {
        kawai_router::SchedulerEvent::StepStarted { step_id, tool } => {
            SupervisorEvent::StepStarted { step_id, tool }
        }
        kawai_router::SchedulerEvent::ConfirmationRequested { step_id, task, description } => {
            SupervisorEvent::ConfirmationRequested { stream_id: stream_id.to_string(), step_id, task, description }
        }
        kawai_router::SchedulerEvent::StepCompleted { step_id, output, retries_used } => {
            let artifacts = artifact_infos(&output);
            let output = preview_chars(&output, STEP_EVENT_OUTPUT_MAX_CHARS).to_string();
            SupervisorEvent::StepCompleted { step_id, output, artifacts, retries_used }
        }
        kawai_router::SchedulerEvent::StepFailed { step_id, error, kind, .. } => SupervisorEvent::StepFailed {
            kind: step_error_kind(&kind),
            step_id,
            error,
        },
        kawai_router::SchedulerEvent::StepSkipped { step_id, reason } => SupervisorEvent::StepSkipped { step_id, reason },
    }
}

// ── Failure-triggered replanning ───────────────────────────────────────

/// Hard cap on planner revisions per plan execution. Without it, a
/// systematically misunderstood goal would burn LLM calls in a loop.
const MAX_REPLANS: u32 = 1;

/// Core tools visible to the revise prompt (same whitelist plan_task uses).
fn planner_core_tools(registry: &ToolRegistry) -> Vec<String> {
    PLAN_CORE_TOOLS
        .iter()
        .filter(|name| registry.get(name).is_some())
        .map(|s| s.to_string())
        .collect()
}

/// Decide whether a failed execution deserves a planner revision. Returns
/// `None` for: success, empty results, user cancellation, and user decisions
/// (confirmation rejected / no handler) — those are not plan bugs.
fn replan_reason(
    result: &kawai_router::ExecutionResult,
    cancel: &tokio_util::sync::CancellationToken,
) -> Option<String> {
    if cancel.is_cancelled() {
        return None;
    }
    let failures = result.failures();
    if failures.is_empty() {
        return None;
    }
    let is_user_decision = |failure: &&kawai_router::StepResult| {
        matches!(
            failure.error_kind,
            kawai_router::FailureKind::Confirmation | kawai_router::FailureKind::Cancelled
        )
    };
    if failures.iter().all(is_user_decision) {
        return None;
    }
    Some(
        failures
            .iter()
            .map(|f| format!("step '{}' ({}): {}", f.step_id, f.agent_id, f.error.as_deref().unwrap_or("unknown")))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// Compact per-step outcome report fed to the planner as replan materials.
/// Completed outputs are truncated — the planner needs shape, not bodies.
fn execution_report(result: &kawai_router::ExecutionResult) -> String {
    const OUTPUT_CHARS: usize = 300;
    let mut out = String::from("<execution-report>\n");
    for r in &result.results {
        let output = {
            let trimmed: String = r.output.chars().take(OUTPUT_CHARS).collect();
            if r.output.chars().count() > OUTPUT_CHARS {
                format!("{trimmed}…")
            } else {
                trimmed
            }
        };
        out.push_str(&format!(
            "<step id=\"{}\" status=\"{:?}\" output=\"{}\" error=\"{}\"/>\n",
            r.step_id,
            r.status,
            output.replace('"', "'"),
            r.error.as_deref().unwrap_or("").replace('"', "'"),
        ));
    }
    out.push_str("</execution-report>");
    out
}

/// Ask the planner for a revised plan. One call + one validator corrective
/// round (the same `validate_plan` contract `plan_task` enforces — revision
/// grants the planner no extra power).
async fn revise_plan(
    goal: &str,
    reason: &str,
    result: &kawai_router::ExecutionResult,
    registry: &ToolRegistry,
) -> Result<kawai_router::TaskPlan, String> {
    let remote = remote_llm::RemoteLlm::from_env()
        .map(|r| r.with_output_cap(2_500))
        .ok_or_else(|| "remote LLM is not configured".to_string())?;
    let system = plan_loop_system_prompt(&planner_core_tools(registry));
    let task = format!(
        "The execution of the plan for this goal DIVERGED. The remaining plan is no longer trusted.\
         \n\nOriginal goal:\n{goal}\
         \n\nFailures:\n{reason}\
         \n\nExecution report — completed steps already produced their artifacts; do NOT redo \
          them unless their outputs are the direct cause of the failures:\n{}\
         \n\nProduce a REVISED plan that completes the original goal from the current state.\
         \nRespond ONLY with the plan JSON.",
        execution_report(result)
    );

    let mut materials = String::new();
    for round in 0..2 {
        let mut raw = String::new();
        {
            // Overall watchdog for this revise round. remote-llm streams have
            // no inherent timeout by design (long generations are legitimate);
            // every consumer enforces its own — agent.rs uses
            // REMOTE_TIMEOUT_SECS. Without one here, a provider that accepts
            // the connection but never streams hangs the whole replan (and
            // with it the run) forever — observed live 2026 (zai returned no
            // text, the failover candidate stalled mid-stream).
            let collect = async {
                let mut stream = remote.stream(&system, &task, &materials).await?;
                while let Some(event) = stream.next().await {
                    match event? {
                        remote_llm::RemoteEvent::Token { text } => {
                            if raw.len() < 32_000 {
                                raw.push_str(&text);
                            }
                        }
                        _ => {}
                    }
                }
                Ok::<(), String>(())
            };
            if let Err(e) = tokio::time::timeout(std::time::Duration::from_secs(300), collect).await {
                return Err(format!("revised-planner call did not finish in 300s: {e}"));
            }
        }
        match parse_supervisor_plan(&raw, registry) {
            Ok(plan) if !plan.steps.is_empty() => return Ok(plan),
            Ok(_) => {
                materials.push_str(
                    "\n<plan-rejected>The revised plan had no steps. Respond ONLY with plan JSON.</plan-rejected>",
                );
            }
            Err(plan_err) => {
                if round == 0 {
                    let suggestions = suggest_tools(registry, &plan_err);
                    materials.push_str(&format!(
                        "\n<plan-rejected>Your revised plan was rejected by the validator: {plan_err}\n{}\
                         Respond ONLY with the corrected plan JSON.</plan-rejected>",
                        if suggestions.is_empty() {
                            String::new()
                        } else {
                            format!("Did you mean one of: {}?\n", suggestions.join(", "))
                        },
                    ));
                } else {
                    return Err(format!("revised plan validation failed: {plan_err}"));
                }
            }
        }
    }
    unreachable!("revise loop exhausted without returning")
}

/// Per-step result digest for the synthesis call: tool + status + a bounded
/// output preview per step, overall-capped so the materials stay within the
/// providers' budgets.
fn synthesis_materials(plan: &kawai_router::TaskPlan, result: &kawai_router::ExecutionResult) -> String {
    const PER_STEP_CHARS: usize = 4_000;
    const TOTAL_CHARS: usize = 24_000;
    let mut out = String::new();
    for step in &plan.steps {
        let Some(r) = result.get(&step.id) else { continue };
        let tool = step.tool.clone().unwrap_or_else(|| step.agent_id.clone());
        let (status, body) = match r.status {
            kawai_router::StepStatus::Completed => ("ok", r.output.as_str()),
            kawai_router::StepStatus::Failed => ("failed", r.error.as_deref().unwrap_or("")),
            _ => continue, // skipped steps carry nothing answerable
        };
        out.push_str(&format!(
            "<step id=\"{}\" tool=\"{}\" status=\"{status}\">\n{}\n</step>\n",
            step.id,
            tool,
            preview_chars(body, PER_STEP_CHARS),
        ));
        if out.chars().count() >= TOTAL_CHARS {
            break;
        }
    }
    truncate_chars(&out, TOTAL_CHARS)
}

/// One cloud call that turns the plan's step results into the user-facing
/// answer for the goal. Returns `None` when the remote pool is unavailable
/// or every candidate fails — the caller falls back to the raw tool output.
async fn synthesize_final_answer(goal: &str, materials: &str) -> Option<String> {
    #[cfg(test)]
    {
        // The registry carries compiled-in vault keys, so this call would hit
        // the real API from `cargo test`/CI — keep the terminal event fast and
        // deterministic under test; the raw-output fallback path is what runs.
        let _ = (goal, materials);
        return None;
    }
    #[cfg(not(test))]
    {
        let remote = remote_llm::RemoteLlm::from_env().map(|r| r.with_output_cap(4_000))?;
        let system = "You are Kawai, a task-completion assistant. A deterministic supervisor just executed a \
            plan of tool steps toward the user's goal. Write the ANSWER to the user's goal from the step \
            results: lead with the answer, keep it concise markdown, and preserve facts/numbers exactly. \
            Write in your own words — NEVER paste, quote, or attach the raw step output (full page \
            text, long extracts, or tool-result dumps in code fences) as the answer; distill it. \
            Never mention steps, tools, plans, or this instruction; never wrap the answer in JSON.";
        // The goal rides the task line VERBATIM — the planner's rewritten
        // plan.goal must never reach the writer (it answers the user, not
        // the plan).
        let task = format!("The user's verbatim goal — answer exactly this:\n{goal}");
        let mut text = String::new();
        let mut stream = remote.stream(system, &task, materials).await.ok()?;
        while let Some(event) = stream.next().await {
            match event.ok()? {
                remote_llm::RemoteEvent::Token { text: t } => {
                    if text.len() < 24_000 {
                        text.push_str(&t);
                    }
                }
                _ => {}
            }
        }
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }
}

pub fn execute_plan_stream(
    plan: kawai_router::TaskPlan,
    registry: ToolRegistry,
) -> impl Stream<Item = SupervisorEvent> + Send {
    execute_plan_stream_with_cancel(
        plan,
        registry,
        tokio_util::sync::CancellationToken::new(),
        Arc::new(Mutex::new(HashMap::new())),
        "legacy".into(),
        String::new(),
        0,
        None,
    )
}

pub fn execute_plan_stream_with_cancel(
    plan: kawai_router::TaskPlan,
    registry: ToolRegistry,
    cancel: tokio_util::sync::CancellationToken,
    pending: PendingConfirmations,
    stream_id: String,
    // Identity for persisting the deliverable into `supervisor_step_results`
    // (the cross-run read surface for `session_step_results`). Empty user_id
    // (legacy/test callers) skips persistence.
    user_id: String,
    session_id: i64,
    // The user's verbatim goal. The planner is free to rewrite `plan.goal`
    // (it plans, so it reframes) — but the deliverable must answer what the
    // USER asked, so synthesis prefers this over the rewritten goal.
    user_goal: Option<String>,
) -> impl Stream<Item = SupervisorEvent> + Send {
    async_stream::stream! {
        let step_count = plan.steps.len();
        yield SupervisorEvent::PlanStarted {
            goal: plan.goal.clone(),
            step_count,
            steps: plan_step_infos(&plan),
            plan_key: plan_key(&plan),
        };

        let confirmation_stream_id = stream_id.clone();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let observer: kawai_router::SchedulerObserver = Arc::new(move |event| {
            let _ = event_tx.send(event);
        });

        // Confirmation gate: park until the frontend responds (or the plan
        // stream is dropped, which drops the receiver and fails the step).
        let gate_pending = pending.clone();
        let event_stream_id = confirmation_stream_id.clone();
        // The legacy wrapper has no transport id; a per-stream pointer keeps
        // the public API compatible while transport callers use stream_id.
        let confirmation_stream_id = stream_id.clone();
        let gate: kawai_router::ConfirmationHandler = Arc::new(move |step_id: String, _task: String| {
            let pending = gate_pending.clone();
            let key = confirmation_key(&confirmation_stream_id, &step_id);
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            pending.lock().expect("pending confirmations mutex held across panic").insert(key.clone(), tx);
            Box::pin(async move {
                match rx.await {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(kawai_router::RouterError::ConfirmationRejected(step_id)),
                    Err(_) => {
                        pending.lock().expect("pending confirmations mutex held across panic").remove(&key);
                        Err(kawai_router::RouterError::ConfirmationRequired(step_id))
                    }
                }
            })
        });

        let limits = kawai_router::SchedulerLimits {
            observer: Some(observer),
            confirmation_handler: Some(gate),
            ..Default::default()
        };
        let dispatch = registry.step_dispatch();

        // Failure-triggered replan loop: a non-user-decided failure with
        // budget left asks the planner for a revised plan and re-executes it.
        // Confirmation gates, cancellation, and the ExecutionMemo all carry
        // over — a revised plan cannot re-run an identical completed call and
        // cannot dispatch anything the registry doesn't know.
        let mut current_plan = plan;
        let mut replan_attempt: u32 = 0;
        'plans: loop {
            let execution = kawai_router::run_plan_with_cancel(
                current_plan.clone(),
                dispatch.clone(),
                limits.clone(),
                cancel.clone(),
            );
            tokio::pin!(execution);
            let result = loop {
                tokio::select! {
                    Some(event) = event_rx.recv() => {
                        yield log_scheduler_event(&event_stream_id, event);
                    }
                    result = &mut execution => break result,
                }
            };
            // Drain observer events still queued when the scheduler finished —
            // otherwise late stepCompleted/stepFailed events are lost and the UI
            // shows a terminal row without its per-step lifecycle.
            while let Ok(event) = event_rx.try_recv() {
                yield log_scheduler_event(&event_stream_id, event);
            }
            match result {
                Ok(result) => {
                    eprintln!(
                        "[supervisor] plan terminal: results={} all_completed={} final_output={:?}",
                        result.results.len(),
                        result.all_completed(),
                        result.final_output().map(|o| o.len()),
                    );
                    // Per-step lifecycle events were forwarded live above. Emit
                    // only the terminal plan event here to avoid duplicate UI rows.
                    // An EMPTY result set must not count as success —
                    // `[].all(completed)` is trivially true in Rust.
                    if result.results.is_empty() {
                        eprintln!(
                            "[supervisor] plan '{}' produced no step results (steps in plan: {})",
                            current_plan.goal,
                            current_plan.steps.len()
                        );
                        yield SupervisorEvent::PlanFailed {
                            error: "scheduler produced no step results".into(),
                        };
                        break;
                    }
                    if result.all_completed() {
                        // The scheduler's `final_output` is the LAST tool's raw
                        // output (e.g. 26k chars of extracted PDF text) — not an
                        // answer. One synthesis call turns the per-step results
                        // into the user-facing reply; on failure (no remote, all
                        // providers down) fall back to the raw output verbatim.
                        // The synthesis is a VISIBLE step (stepStarted/completed
                        // for the virtual `deliverable_writer` agent) — invisible
                        // work reads as magic and breaks the workbench's trust
                        // contract.
                        yield SupervisorEvent::StepStarted {
                            step_id: DELIVERABLE_STEP_ID.into(),
                            tool: DELIVERABLE_TOOL.into(),
                        };
                        let raw_final = result.final_output().map(String::from);
                        let materials = synthesis_materials(&current_plan, &result);
                        let synthesis_goal = user_goal
                            .clone()
                            .unwrap_or_else(|| current_plan.goal.clone());
                        let synthesized =
                            synthesize_final_answer(&synthesis_goal, &materials).await;
                        if let Some(answer) = &synthesized {
                            eprintln!("[supervisor] synthesis ok ({} chars)", answer.chars().count());
                        } else {
                            eprintln!("[supervisor] synthesis unavailable — falling back to raw final output");
                        }
                        let written = synthesized.clone().or_else(|| raw_final.clone());
                        // Persist the deliverable alongside the tool-step
                        // results so later runs in this session can read it
                        // via `session_step_results` (the enhancement chain).
                        if let Some(written) = &written {
                            if !user_id.is_empty() {
                                let _ = kawai_db::upsert_supervisor_step_result(
                                    &user_id,
                                    session_id,
                                    &plan_key(&current_plan),
                                    &kawai_db::SupervisorStepResult {
                                        tool: DELIVERABLE_TOOL.into(),
                                        args_key: "deliverable".into(),
                                        step_id: DELIVERABLE_STEP_ID.into(),
                                        output: written.clone(),
                                        artifacts_json: "[]".into(),
                                    },
                                )
                                .await;
                            }
                        }
                        yield SupervisorEvent::StepCompleted {
                            step_id: DELIVERABLE_STEP_ID.into(),
                            output: written
                                .as_deref()
                                .map(|o| preview_chars(o, STEP_EVENT_OUTPUT_MAX_CHARS).to_string())
                                .unwrap_or_default(),
                            artifacts: Vec::new(),
                            retries_used: 0,
                        };
                        yield SupervisorEvent::PlanCompleted {
                            final_output: synthesized.or(raw_final),
                        };
                        break;
                    }
                    // Failure path — decide between replanning and giving up.
                    let reason = replan_reason(&result, &cancel);
                    let failed_ids: Vec<String> = result
                        .failures()
                        .iter()
                        .map(|f| f.step_id.clone())
                        .collect();
                    if replan_attempt < MAX_REPLANS {
                        if let Some(reason) = reason {
                            replan_attempt += 1;
                            yield SupervisorEvent::PlanRevising {
                                failed_step_ids: failed_ids.clone(),
                                attempt: replan_attempt,
                            };
                            eprintln!(
                                "[supervisor] replanning (attempt {replan_attempt}/{MAX_REPLANS}): {reason}"
                            );
                            match revise_plan(&current_plan.goal, &reason, &result, &registry).await {
                                Ok(revised) => {
                                    let count = revised.steps.len();
                                    yield SupervisorEvent::PlanRevised {
                                        attempt: replan_attempt,
                                        step_count: count,
                                        steps: plan_step_infos(&revised),
                                        plan_key: plan_key(&revised),
                                    };
                                    current_plan = revised;
                                    continue 'plans;
                                }
                                Err(e) => {
                                    yield SupervisorEvent::PlanFailed {
                                        error: format!(
                                            "{}; replan (attempt {replan_attempt}) failed: {e}",
                                            reason
                                        ),
                                    };
                                    break;
                                }
                            }
                        }
                    }
                    yield SupervisorEvent::PlanFailed {
                        error: result.failures().into_iter().map(|f| {
                            format!("step '{}' failed: {}", f.step_id, f.error.as_deref().unwrap_or("unknown"))
                        }).collect::<Vec<_>>().join("; "),
                    };
                    break;
                }
                Err(e) => {
                    yield SupervisorEvent::PlanFailed {
                        error: e.to_string(),
                    };
                    break;
                }
            }
        }
        // Remove any confirmation senders left behind by cancellation or a
        // disconnected client. This also prevents stale responses matching a
        // later plan that happens to reuse a step id.
        let prefix = format!("{}\u{1f}", stream_id);
        if let Ok(mut pending) = pending.lock() {
            pending.retain(|key, _| !key.starts_with(&prefix));
        }
    }
}

#[cfg(all(test, feature = "litert"))]
mod tests {
    use super::*;
    use kawai_router::{StepStatus, TaskStep};

    #[test]
    fn preview_chars_is_char_boundary_safe_and_capped() {
        assert_eq!(preview_chars("short", 2000), "short");
        let long = "x".repeat(5000);
        assert_eq!(preview_chars(&long, 2000).chars().count(), 2000);
        // Multi-byte characters never panic on the truncation edge.
        let wide: String = "🐍".repeat(3000);
        let cut = preview_chars(&wide, 2500);
        assert_eq!(cut.chars().count(), 2500);
    }

    #[test]
    fn planner_context_omits_empty_blocks_and_wraps_present_ones() {
        assert_eq!(
            render_planner_context(String::new(), String::new(), String::new(), String::new()),
            ""
        );
        let out = render_planner_context(
            "<persona>likes dark UIs</persona>".into(),
            String::new(),
            "<skills>pdf skill</skills>".into(),
            String::new(),
        );
        assert!(out.starts_with("<user-context>"));
        assert!(out.contains("<persona>likes dark UIs</persona>"));
        assert!(out.contains("<skills>pdf skill</skills>"));
        assert!(out.ends_with("</user-context>"));
        // No empty block placeholders.
        assert!(!out.contains("<memories>"));
    }

    #[test]
    fn attached_files_only_context_is_rendered() {
        let out = render_planner_context(
            String::new(),
            String::new(),
            String::new(),
            "<attached-files>\n- report.docx\n</attached-files>".into(),
        );
        assert!(out.starts_with("<user-context>"));
        assert!(out.contains("<attached-files>\n- report.docx\n</attached-files>"));
        assert!(out.ends_with("</user-context>"));
    }

    /// Registry whose single tool records executions and succeeds.
    fn echo_registry() -> ToolRegistry {
        let executed = Arc::new(Mutex::new(Vec::<String>::new()));
        let executed_dispatch = executed.clone();
        let dispatch: ToolDispatch = Arc::new(move |call: ToolCall| {
            let executed = executed_dispatch.clone();
            Box::pin(async move {
                executed.lock().unwrap().push(call.step.id.clone());
                Ok(kawai_router::StepResult {
                    step_id: call.step.id,
                    agent_id: call.step.agent_id,
                    status: StepStatus::Completed,
                    output: "done".into(),
                    artifacts: Vec::new(),
                    error: None,
                    retries_used: 0,
                    error_kind: kawai_router::FailureKind::Other,
                })
            })
        });
        let mut registry = ToolRegistry::new(dispatch);
        registry.register(ToolMeta {
            name: "echo".into(),
            kind: ToolKind::Pure,
            description: "test tool".into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            requires_confirmation: false,
        });
        registry
    }

    fn confirm_step(id: &str) -> TaskStep {
        TaskStep {
            id: id.into(),
            agent_id: "echo".into(),
            task: format!("task {id}"),
            requires_confirmation: Some(true),
            confirmation_description: Some("about to act".into()),
            ..Default::default()
        }
    }

    /// Full loop: planStarted → stepStarted → confirmationRequested → approve
    /// (via the pending-confirmation map, exactly what the Tauri/Axum
    /// responder does) → stepCompleted → planCompleted.
    #[tokio::test]
    async fn confirmation_gate_approve_resumes_step() {
        let pending: PendingConfirmations = Arc::new(Mutex::new(HashMap::new()));
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![confirm_step("s1")],
        };
        let stream = execute_plan_stream_with_cancel(
            plan,
            echo_registry(),
            tokio_util::sync::CancellationToken::new(),
            pending.clone(),
            "st-a".into(),
            "test-user".into(),
            1,
            None,
        );
        let mut stream = Box::pin(stream);

        // Drive until confirmationRequested arrives.
        let mut saw_confirmed = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            assert!(std::time::Instant::now() < deadline, "timeout waiting for events");
            let ev = tokio::time::timeout(std::time::Duration::from_millis(500), stream.as_mut().next())
                .await
                .expect("stream stalled");
            match ev {
                Some(SupervisorEvent::PlanStarted { .. }) => {}
                Some(SupervisorEvent::StepStarted { step_id, .. }) => assert_eq!(step_id, "s1"),
                Some(SupervisorEvent::ConfirmationRequested { stream_id, step_id, .. }) => {
                    assert_eq!(stream_id, "st-a");
                    assert_eq!(step_id, "s1");
                    saw_confirmed = true;
                    break;
                }
                other => panic!("unexpected event before confirmation: {other:?}"),
            }
        }
        assert!(saw_confirmed);

        // Approve through the same oneshot map the responder command uses.
        let sender = pending
            .lock()
            .unwrap()
            .remove(&confirmation_key("st-a", "s1"))
            .expect("pending confirmation gate registered");
        let _ = sender.send(true);

        let mut finished = false;
        loop {
            let ev = tokio::time::timeout(std::time::Duration::from_millis(500), stream.as_mut().next())
                .await
                .expect("stream stalled after approval");
            match ev {
                Some(SupervisorEvent::StepStarted { step_id, .. }) if step_id == DELIVERABLE_STEP_ID => {}
                Some(SupervisorEvent::StepCompleted { step_id, .. }) if step_id == DELIVERABLE_STEP_ID => {}
                Some(SupervisorEvent::StepStarted { step_id, .. }) => assert_eq!(step_id, "s1"),
                Some(SupervisorEvent::StepCompleted { step_id, .. }) => assert_eq!(step_id, "s1"),
                Some(SupervisorEvent::PlanCompleted { final_output }) => {
                    assert_eq!(final_output.as_deref(), Some("done"));
                    finished = true;
                    break;
                }
                Some(other) => panic!("unexpected event after approval: {other:?}"),
                None => break,
            }
        }
        assert!(finished, "plan did not complete after approval");
        // The gate map is swept clean after the plan ends.
        assert!(pending.lock().unwrap().is_empty(), "stale confirmation gates left behind");
    }

    /// Rejection: respond(false) → the step fails and the plan reports failure.
    #[tokio::test]
    async fn confirmation_gate_reject_fails_plan() {
        let pending: PendingConfirmations = Arc::new(Mutex::new(HashMap::new()));
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![confirm_step("s1")],
        };
        let stream = execute_plan_stream_with_cancel(
            plan,
            echo_registry(),
            tokio_util::sync::CancellationToken::new(),
            pending.clone(),
            "st-r".into(),
            "test-user".into(),
            1,
            None,
        );
        let mut stream = Box::pin(stream);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            assert!(std::time::Instant::now() < deadline, "timeout waiting for events");
            let ev = tokio::time::timeout(std::time::Duration::from_millis(500), stream.as_mut().next())
                .await
                .expect("stream stalled");
            if matches!(ev, Some(SupervisorEvent::ConfirmationRequested { .. })) {
                break;
            }
        }

        let sender = pending
            .lock()
            .unwrap()
            .remove(&confirmation_key("st-r", "s1"))
            .expect("pending confirmation gate registered");
        let _ = sender.send(false);

        let mut failed = false;
        loop {
            let ev = tokio::time::timeout(std::time::Duration::from_millis(500), stream.as_mut().next())
                .await
                .expect("stream stalled after rejection");
            match ev {
                Some(SupervisorEvent::StepFailed { step_id, .. }) => assert_eq!(step_id, "s1"),
                Some(SupervisorEvent::PlanFailed { error }) => {
                    assert!(error.contains("s1"), "failure should name the rejected step: {error}");
                    failed = true;
                    break;
                }
                Some(other) => panic!("unexpected event after rejection: {other:?}"),
                None => break,
            }
        }
        assert!(failed, "plan did not report failure after rejection");
        assert!(pending.lock().unwrap().is_empty());
    }

    /// Non-confirmation steps dispatch without any gate round-trip.
    #[tokio::test]
    async fn plain_steps_need_no_confirmation() {
        let pending: PendingConfirmations = Arc::new(Mutex::new(HashMap::new()));
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![TaskStep {
                id: "p1".into(),
                agent_id: "echo".into(),
                task: "plain".into(),
                ..Default::default()
            }],
        };
        let stream = execute_plan_stream_with_cancel(
            plan,
            echo_registry(),
            tokio_util::sync::CancellationToken::new(),
            pending,
            "st-p".into(),
            "test-user".into(),
            1,
            None,
        );
        let events: Vec<SupervisorEvent> = Box::pin(stream)
            .take(8)
            .collect::<Vec<_>>()
            .await;
        let kinds: Vec<&str> = events
            .iter()
            .map(|e| match e {
                SupervisorEvent::PlanStarted { .. } => "planStarted",
                SupervisorEvent::StepStarted { .. } => "stepStarted",
                SupervisorEvent::StepCompleted { .. } => "stepCompleted",
                SupervisorEvent::PlanCompleted { .. } => "planCompleted",
                _ => "other",
            })
            .collect();
        assert!(kinds.contains(&"stepCompleted"), "{kinds:?}");
        assert!(kinds.contains(&"planCompleted"), "{kinds:?}");
        assert!(!kinds.contains(&"other"), "{kinds:?}");
    }
}

#[cfg(test)]
mod coerce_tests {
    use super::coerce_resolved_args;
    use serde_json::json;

    #[test]
    fn files_list_coerced_to_single_id_for_string_arg() {
        let schema = json!({
            "type": "object",
            "required": ["fileId"],
            "properties": {"fileId": {"type": "string"}}
        });
        let args = json!({"fileId": [{"id": "doc1", "ext": "pdf"}, {"id": "doc2", "ext": "md"}]});
        let out = coerce_resolved_args("pdf_extract_text", &args, Some(&schema));
        assert_eq!(out["fileId"], "doc1");
    }

    #[test]
    fn pdf_tool_prefers_pdf_entry_in_mixed_list() {
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let args = json!({"fileId": [{"id": "doc2", "ext": "md"}, {"id": "doc1", "ext": "pdf"}]});
        let out = coerce_resolved_args("pdf_extract_text", &args, Some(&schema));
        assert_eq!(out["fileId"], "doc1");
    }

    #[test]
    fn non_string_args_and_missing_schema_pass_through() {
        let schema = json!({"type": "object", "properties": {"query": {"type": "string"}}});
        let args = json!({"query": ["a", "b"], "limit": 5});
        let out = coerce_resolved_args("knowledge_search", &args, Some(&schema));
        assert_eq!(out, args);
        assert_eq!(coerce_resolved_args("t", &args, None), args);
    }

    #[test]
    fn file_object_coerced_to_handle() {
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let args = json!({"fileId": {"type": "file", "handle": "doc9", "filename": "x.pdf"}});
        let out = coerce_resolved_args("office_read_document", &args, Some(&schema));
        assert_eq!(out["fileId"], "doc9");
    }
}
