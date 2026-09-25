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
    /// Explicit dataflow bindings — rendered in the plan review / progress
    /// UI as "arg ← step.output" so the wiring a step consumes is visible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<PlanInputBinding>,
}

/// One `inputs` binding of a plan step, display-shaped.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInputBinding {
    pub arg: String,
    pub from_step: String,
    pub output: String,
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

/// Fill `plan.summary` when the planner omitted it — deterministic, from the
/// goal and the steps' `produces` artifacts. Actions stay EMPTY: the step
/// list renders directly below the summary card, so copying step tasks here
/// would be read twice.
fn ensure_plan_summary(plan: &mut kawai_router::TaskPlan) {
    if plan.summary.is_some() {
        return;
    }
    let overview = plan.goal.trim().to_string();
    let outputs: Vec<String> = plan
        .steps
        .iter()
        .flat_map(|s| s.produces.iter())
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .take(5)
        .collect();
    plan.summary = Some(kawai_router::PlanSummary {
        overview,
        actions: Vec::new(),
        outputs,
    });
}

fn plan_summary_info(plan: &kawai_router::TaskPlan) -> kawai_router::PlanSummary {
    if let Some(s) = &plan.summary {
        return s.clone();
    }
    let mut fallback = plan.clone();
    ensure_plan_summary(&mut fallback);
    fallback.summary.unwrap()
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
            inputs: s
                .inputs
                .as_object()
                .map(|bindings| {
                    bindings
                        .iter()
                        .filter_map(|(arg, reference)| {
                            let from = reference.get("fromStep")?.as_str()?;
                            let output = reference.get("output").and_then(|v| v.as_str());
                            Some(PlanInputBinding {
                                arg: arg.clone(),
                                from_step: from.to_string(),
                                output: output.unwrap_or("").to_string(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
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
        /// User-facing "what will the agent do / produce" — LLM-written or
        /// backfilled deterministically from the steps (see
        /// `ensure_plan_summary`). Drives the Plan Summary card in the rail.
        summary: kawai_router::PlanSummary,
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
        /// Refreshed summary for the revised plan (same contract as
        /// `planStarted.summary`).
        summary: kawai_router::PlanSummary,
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
    /// Throttled trailing slice of the planner LLM's reasoning stream — live
    /// motion inside a round (one round can stream for minutes with no other
    /// event, which read as a frozen UI).
    PlanningActivity {
        text: String,
    },
    /// Personal context loaded into the planner call — surfaced so the UI can
    /// show what personalizes this run instead of a bare spinner. Emitted
    /// right after the context fan-out completes.
    PlanningContext {
        persona: bool,
        memories: u32,
        skills: u32,
        files: u32,
    },
    PlanCompleted {
        final_output: Option<String>,
        /// Deliverable artifacts produced by the run — most importantly the
        /// deck when `finalWriter: "deck_writer"` (the viewer renders the
        /// deck file as the deliverable hero). File artifacts from the steps
        /// ride along so the UI can surface them without re-parsing outputs.
        artifacts: Vec<ArtifactInfo>,
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
    let monad = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        { agent_registry::monad_tools_for_supervisor(&context, remote_configured) }
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
                agent_registry::coinmarketcap_tools_for_supervisor(&context, remote_configured),
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
            monad(),
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
        agent_registry::MONAD_AGENT_ID => monad(),
        _ => None,
    }
}

/// Convert a [`kawai_tools::ToolDefinition`] into a [`kawai_router::ToolMeta`].
/// The artifact contract rides the definition — declared at the tool, beside
/// the code that produces the output — so it can never drift from it.
fn tool_meta_from_definition(def: &kawai_tools::ToolDefinition) -> ToolMeta {
    ToolMeta {
        name: def.name.clone(),
        kind: ToolKind::Pure,
        description: def.description.clone(),
        input_schema: def.parameters.clone(),
        output_schema: serde_json::json!({}),
        produces: def.produces.clone(),
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
    experiences_block: String,
    profile_block: String,
) -> String {
    if persona_block.is_empty()
        && memories_block.is_empty()
        && skills_block.is_empty()
        && attached_files_block.is_empty()
        && experiences_block.is_empty()
        && profile_block.is_empty()
    {
        return String::new();
    }
    let mut out = String::from("<user-context>\nBackground about the user and this run's inputs. Ground decisions in it when relevant; ignore it when not.\n");
    for block in [
        persona_block,
        profile_block,
        memories_block,
        skills_block,
        attached_files_block,
        experiences_block,
    ] {
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
/// Total schema-summary chars embedded in the planner's attached-files block
/// (roughly two spreadsheets; anything beyond falls back to a data_schema hint).
const FILE_SCHEMA_CHARS_TOTAL: usize = 4_000;

/// Names of the files attached to this run's session, as a planner-context
/// block. Without it the planner is blind to attachments: a neutral goal
/// ("make a summary") would plan no knowledge_search step, and the attached
/// files would never be read by any step. Names give the planner the semantic
/// signal to plan retrieval and write good queries; tabular files are flagged
/// so the planner routes them to the analytics tools instead. Best-effort —
/// a read failure degrades to an empty block, planning never fails on it.
/// Builds the `<attached-files>` planner-context block. For tabular files
/// the schema (fileId, columns, sample row) is embedded so the planner can
/// phrase concrete `data_query_nl` queries — data execution is reserved for
/// `data_query_nl` at plan time (`data_query` is a revision-only tool).
async fn attached_files_block(user_id: &str, session_id: i64) -> String {
    let files = match crate::logic::rag::list_session_files(user_id, session_id).await {
        Ok(files) if !files.is_empty() => files,
        _ => return String::new(),
    };
    let mut out = String::from(
        "<attached-files>\nThe user attached these files to this run (their contents are searchable via knowledge_search):\n",
    );
    let mut schema_chars = 0usize;
    for f in files.iter().take(ATTACHED_FILES_MAX) {
        if kawai_office::store::is_tabular_ext(&f.ext) {
            if schema_chars < FILE_SCHEMA_CHARS_TOTAL {
                let Ok((path, _)) = kawai_office::store::resolve(user_id, &f.id) else {
                    continue;
                };
                let md = kawai_office::tabular_schema_markdown(&path, &f.ext, &f.original_name);
                if md.is_empty() {
                    out.push_str(&format!(
                        "- {} ({} — tabular; query via data_query_nl)\n",
                        f.original_name, f.id
                    ));
                    continue;
                }
                schema_chars += md.chars().count();
                out.push_str(&format!(
                    "\n--- Tabular file schema — fileId: {} ---\n{}\n",
                    f.id, md
                ));
            } else {
                out.push_str(&format!(
                    "- {} ({} — tabular; query via data_query_nl)\n",
                    f.original_name, f.id
                ));
            }
        } else {
            out.push_str(&format!("- {}\n", f.original_name));
        }
    }
    out.push_str(
        "\n</attached-files>\n\nAnswer data questions about tabular files above with `data_query_nl` — \
         the fileId and columns are exact.\n",
    );
    out
}

/// Prior runs' persisted step outputs, as a compact planner-context index
/// (run, step, tool, size, head snippet). With it the planner KNOWS a previous
/// run's outputs already exist (e.g. a 25k-char `office_extract_images`
/// report) and reads them via `session_step_results` + `fromStep` instead of
/// re-running the tools — and it can phrase `session_step_results` filters
/// that actually match. Observed live 2026: with no index the planner guessed
/// a query filter that matched nothing, then re-planned the extraction and
/// crashed the run on a PNG. Best-effort — a read failure degrades to an
/// empty block, planning never fails on it.
/// Last N agent experiences (PLAN-personal-context §2.2) as a planner-context
/// block — the planner avoids repeating tool sequences that already ran (and
/// sees recorded lessons). Ranked by recency + goal overlap; best-effort.
const PLANNER_EXPERIENCES: usize = 3;
const EXPERIENCE_HEAD_CHARS: usize = 200;

async fn experiences_block(user_id: &str, goal: &str) -> String {
    let items = match
        kawai_agent::experience_top_k(user_id, AUTO_AGENT_ID, goal, PLANNER_EXPERIENCES).await
    {
        Ok(items) => items,
        Err(_) => return String::new(),
    };
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "<experiences>\nWhat earlier runs of this workspace learned (newest first). Avoid repeating \
         a failed tool sequence; apply the recorded lessons when they fit:\n",
    );
    for e in &items {
        let head: String = e.task_summary.chars().take(EXPERIENCE_HEAD_CHARS).collect();
        let head = head.replace('\n', " ");
        out.push_str(&format!(
            "- [{}] {}\n  tools: {}\n",
            e.outcome,
            head,
            e.tool_sequence.join(", ")
        ));
        if !e.lesson.is_empty() {
            let lesson: String = e.lesson.chars().take(EXPERIENCE_HEAD_CHARS).collect();
            out.push_str(&format!("  lesson: {}\n", lesson.replace('\n', " ")));
        }
    }
    out.push_str("</experiences>");
    out
}

async fn previous_runs_block(user_id: &str, session_id: i64) -> String {
    const HEAD_CHARS: usize = 120;
    const MAX_ROWS: usize = 20;
    let rows =
        match kawai_db::list_supervisor_step_results_by_session(user_id, session_id, MAX_ROWS).await
        {
            Ok(rows) => rows,
            Err(_) => return String::new(),
        };
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "<previous-runs>\nPersisted step outputs from EARLIER runs in this session (newest first). \
These already exist — do NOT redo their tools. To use one, plan a `session_step_results` step \
(filters are exact: `tool` matches the tool name, `query` = ALL words must appear in the output; \
omit filters to list the latest entries) and pass its output onward with `fromStep`:\n",
    );
    let mut current_run = String::new();
    for r in &rows {
        if r.plan_key != current_run {
            current_run = r.plan_key.clone();
            let label = current_run.get(..12).unwrap_or(&current_run);
            out.push_str(&format!("Run {label}:\n"));
        }
        let head: String = r.output.chars().take(HEAD_CHARS).collect();
        let head = head.replace('\n', " ");
        out.push_str(&format!(
            "  - {} {} — {} chars — \"{}…\"\n",
            r.step_id,
            r.tool,
            r.output.chars().count(),
            head
        ));
    }
    out.push_str("</previous-runs>");
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
    bearer: Option<&str>,
    registry: &ToolRegistry,
    on_progress: impl Fn(SupervisorEvent),
) -> Result<(kawai_router::TaskPlan, remote_llm::RemoteUsage), String> {
    // Fase 0a, server side — the balance gate is FAIL-CLOSED: a balance that
    // cannot be read blocks the goal exactly like an empty one, because an
    // unreadable balance means this run cannot be billed. Two cases block:
    // worker error/HTTP failure, and tokens <= 0. The client pre-check in
    // use-workbench.run() is UX only (toast + Top Up handoff) and is
    // bypassable; this call at the composition root is the enforcement both
    // transports share, and it runs BEFORE the planner so no token is spent
    // on a goal that cannot be paid for. It runs BEFORE the planner so no
    // token is spent on a goal that cannot be paid for.
    //
    // The bearer comes from the TRANSPORT EDGE, not from reading the stored
    // `auth.token` file here: the web transport authenticates off the
    // `kawai_session` cookie, which can outlive that file (logout clears the
    // cookie but not the file, and a failed token write still lets sign-in
    // succeed), so a file read at this layer would both false-block a valid
    // web session and, if treated as "no bearer", let a zero-balance goal
    // run unbilled. Wrappers resolve identity/auth first (AGENTS.md #8) and
    // fail closed on a missing bearer; `None` reaches here only from
    // non-billing contexts (dev probes, headless examples). The SAME bearer
    // is reused by the debit at plan completion, so the two billing calls
    // can never disagree about which session was authorized.
    if let Some(token) = bearer {
        match crate::logic::topup::topup_balance(token).await {
            Ok(balance) if balance.tokens > 0 => {}
            Ok(_) => return Err("Token habis — isi ulang lewat Top Up".to_string()),
            Err(e) => return Err(format!("balance check failed: {e}")),
        }
    }

    // The remote pool serves the planner with a tight per-call output cap:
    // the loop's rounds must stay short (the 2026-02 benchmark showed 14.6k
    // output tokens = the whole 250 s latency).
    let remote = Some(
        remote_llm::RemoteLlm::from_env()
            .map(|r| {
                r.with_output_cap(4_000)
                    .with_agent("planner")
                    // Planner rounds emit short JSON — thinking only burns the
                    // output cap (measured: ~111 s of reasoning with zero
                    // content tokens before the thinking-off retry).
                    .with_thinking_disabled()
                    .with_conversation(format!("kawai-session-{session_id}"))
                    .with_user(user_id)
            })
            .ok_or_else(|| "remote LLM is not configured".to_string())?,
    );

    on_progress(SupervisorEvent::PlanningStarted {});

    // User context rides the planner call: persona + goal-relevant memories
    // + skills. All three are best-effort — planning never fails on them.
    // All independent, so they run concurrently — sequential awaits here were
    // the bulk of the dead time between submit and the first planner round.
    // The Turso catalog sync joins the same fan-out (best-effort).
    let (persona_block, memories_block, skills_block, attached_files_block, experiences_block, profile_block, catalog) = tokio::join! {
        kawai_memory::persona_prompt_block(user_id),
        kawai_memory::prompt_block_relevant(user_id, goal),
        kawai_skills::prompt_block(user_id),
        attached_files_block(user_id, session_id),
        experiences_block(user_id, goal),
        kawai_memory::profile_prompt_block(user_id),
        open_synced_catalog(PLAN_SEARCH_SYNC_TIMEOUT),
    };
    // Surface what got loaded into the planner call (coarse counts — the
    // blocks render as "- item" lines) so the UI can show personalization
    // context instead of a bare spinner during the silent planning phase.
    let count_items = |block: &str| {
        block
            .lines()
            .filter(|l| l.trim_start().starts_with("- "))
            .count() as u32
    };
    on_progress(SupervisorEvent::PlanningContext {
        persona: !persona_block.is_empty(),
        memories: count_items(&memories_block),
        skills: count_items(&skills_block),
        files: count_items(&attached_files_block),
    });
    let context = render_planner_context(
        persona_block,
        memories_block,
        skills_block,
        attached_files_block,
        experiences_block,
        profile_block,
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

    let system = plan_loop_system_prompt(
        &registry.catalog_lines_for(&core_tools),
        &kawai_cli::prompt_block(),
    );
    let mut task = if context.is_empty() {
        format!("User goal:\n{goal}")
    } else {
        format!("{context}\n\nUser goal:\n{goal}")
    };
    // Follow-up runs (the workbench's "build on this") quote an EXCERPT of a
    // previous deliverable into the goal. The excerpt alone caused fabricated
    // numbers (session 102: the planner invented equity/risk/SL and a
    // hardcoded `calculate` expression) because the earlier run's real
    // parameters lived in its full deliverable and step reports — readable
    // via `session_step_results`, which the planner neither knew about nor
    // discovered through search. Tell it explicitly, keyed off the same tag
    // the frontend's buildQuotedGoal emits.
    if goal.contains("<previous-deliverable") {
        task.push_str(
            "\n\n<system-note>The <previous-deliverable> block above is an EXCERPT of an earlier run's final answer. \
Its FULL body (tool 'deliverable_writer') and every step report of that and other runs in this session are readable \
via the always-available `session_step_results` tool. If the goal depends on details NOT visible in the excerpt \
(numbers, entry/stop levels, risk parameters, names, dates), plan a FIRST step that reads them via \
`session_step_results` and pass them onward with `fromStep` — never guess or invent user-specific values \
(equity, risk %, stop-loss distance); source them from that read, from another step's artifact, or from \
`memory_search`.</system-note>",
        );
    }
    // The index of what earlier runs in this session already produced —
    // injected on EVERY plan, not just quoted follow-ups. Observed live 2026:
    // a typed (unquoted) follow-up skipped the tag gate, the planner stayed
    // blind, and re-ran a 25k-char extraction a previous run had already
    // persisted. The block is bounded and best-effort — empty on first run.
    let prior = previous_runs_block(user_id, session_id).await;
    if !prior.is_empty() {
        task.push('\n');
        task.push_str(&prior);
    }
    let mut materials = String::new();
    let mut seen: std::collections::HashSet<String> = core_tools.iter().cloned().collect();
    let mut usage = remote_llm::RemoteUsage::default();
    let mut searches_used = 0usize;
    let mut repairs_used = 0usize;
    let mut calls = 0usize;
    // Rolling reasoning buffer + throttle for PlanningActivity — the UI gets
    // a trailing preview of the planner's thinking at most every 800 ms.
    let mut reasoning_tail = String::new();
    let mut last_activity = std::time::Instant::now();

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
        reasoning_tail.clear();
        last_activity = std::time::Instant::now();
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
                        // Content phase started — a reasoning preview, if any,
                        // is stale now; show plan-writing progress instead.
                        // Providers WITHOUT a reasoning channel (everything
                        // but zai) get their ONLY intra-round motion here.
                        reasoning_tail.clear();
                        if last_activity.elapsed() >= std::time::Duration::from_millis(800) {
                            last_activity = std::time::Instant::now();
                            let label = if must_plan { "writing plan" } else { "drafting round" };
                            on_progress(SupervisorEvent::PlanningActivity {
                                text: format!("{label} · {} chars", raw.len()),
                            });
                        }
                    }
                    remote_llm::RemoteEvent::Done { usage: u, provider, .. } => {
                        // #5 observability: which candidate served the round
                        // (latency tuning data — see PLAN-planner-search-loop.md).
                        tracing::info!(component = "supervisor", user_id = %user_id, round = calls, provider = %provider, "planning round served");
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
                    remote_llm::RemoteEvent::Reasoning { text, reset, .. } => {
                        if reset || text.is_empty() {
                            // Candidate reset (failover) — drop the stale tail
                            // so the preview tracks whoever actually serves.
                            reasoning_tail.clear();
                        } else {
                            reasoning_tail.push_str(&text);
                            // Cap the buffer (char-boundary safe), then emit a
                            // trailing slice at most every 800 ms.
                            if reasoning_tail.len() > 4_000 {
                                let cut = reasoning_tail.len() - 2_000;
                                let boundary = (cut..reasoning_tail.len())
                                    .find(|&i| reasoning_tail.is_char_boundary(i))
                                    .unwrap_or(reasoning_tail.len());
                                reasoning_tail.drain(..boundary);
                            }
                            if last_activity.elapsed() >= std::time::Duration::from_millis(800) {
                                last_activity = std::time::Instant::now();
                                let tail: String = reasoning_tail
                                    .chars()
                                    .rev()
                                    .take(220)
                                    .collect::<Vec<_>>()
                                    .into_iter()
                                    .rev()
                                    .collect();
                                on_progress(SupervisorEvent::PlanningActivity { text: tail });
                            }
                        }
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
                match parse_supervisor_plan_scoped(&raw, registry, PLANNER_FORBIDDEN_TOOLS) {
                    Ok(plan) => {
                        // Fase 0b billing (PLAN-qris-topup.md) — composition
                        // root: BOTH transports (Tauri command, web handler)
                        // call this fn, so the debit lives here and no
                        // wrapper carries billing logic. Amount = this plan's
                        // real token usage (input+output tokens), debited 1:1
                        // against the user's token balance — the integer unit
                        // of the worker ledger. FAIL-CLOSED: a debit that does
                        // not land means this plan was never paid for, so the
                        // plan is NOT returned. A fail-open debit here would
                        // let a balance too small to cover a plan run forever —
                        // the guard passes on `tokens > 0`, the D1 atomic guard
                        // rejects the debit with 409, the balance never reaches
                        // 0, and the entry gate never trips again.
                        // (docs/BALANCE-KV-ARCHITECTURE.md).
                        //
                        // The bearer is the SAME one the entry gate checked,
                        // so gate and debit can never disagree about which
                        // session was authorized. `None` means the caller is
                        // a non-billing context (the gate was skipped with
                        // it) — nothing to debit.
                        let amount = usage.input_tokens.saturating_add(usage.output_tokens);
                        match bearer {
                            Some(token) => {
                                if let Err(e) =
                                    crate::logic::topup::billing_debit(token, amount).await
                                {
                                    tracing::warn!(component = "billing", user_id = %user_id, amount, error = %e, "usage debit failed — refusing the unpaid plan (fail-closed)");
                                    return Err(format!(
                                        "billing failed — plan not delivered: {e}"
                                    ));
                                }
                            }
                            None => {
                                tracing::warn!(component = "billing", user_id = %user_id, amount, "no bearer — usage debit skipped (non-billing caller)");
                            }
                        }
                        return Ok((plan, usage));
                    }
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
                            eprintln!(
                                "[plan_task] plan rejected (repair {repairs_used}/2): {plan_err} — tools used: {}",
                                used_tools.join(", ")
                            );
                            // When the rejection was an unknown tool, the
                            // used-tools schemas are empty (they're not in the
                            // registry) — repaste the SUGGESTED tools' schemas
                            // instead so the model can actually fix the plan.
                            let mut schema_names = used_tools.clone();
                            for s in &suggestions {
                                if !schema_names.iter().any(|n| n == s) {
                                    schema_names.push(s.clone());
                                }
                            }
                            let schemas = registry.catalog_lines_for(&schema_names);
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
                        run_tool_search(catalog.as_deref(), &embedder, &registry, &queries, &mut seen).await;
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

/// Tools the INITIAL planner must never plan: internal-only machinery, plus
/// `data_query` — the planner is blind to file columns at plan time, so any
/// data_query step it writes is a guess (observed live 2026: `"*"` columns,
/// numeric filter literals, wrong ids) that burns a replan cycle. At plan
/// time the agent uses data_query_nl (which self-serves the schema); the
/// schema-AWARE reviser may emit data_query freely.
pub(crate) const PLANNER_FORBIDDEN_TOOLS: &[&str] = &[
    "deep_write",
    "draft_document",
    "plan_task",
    "plan_revise",
    "artifact_recall",
    // The plan-time planner is blind to file contents — any data_query it
    // writes is a guess that burns repair rounds (observed repeatedly). The
    // schema-aware plan REVISION may still emit data_query.
    "data_query",
    // Same blindness: mark/x/y/aggregations written at plan time are guesses.
    // The NL variant (data_chart_nl) self-serves the schema; the schema-aware
    // plan REVISION may still emit data_chart.
    "data_chart",
];
/// The schema-aware reviser may plan data_query (it sees the execution
/// report with real columns) — only the internal machinery stays forbidden.
pub(crate) const REVISE_FORBIDDEN_TOOLS: &[&str] = &[
    "deep_write",
    "draft_document",
    "plan_task",
    "plan_revise",
    "artifact_recall",
];

pub fn parse_supervisor_plan(raw: &str, registry: &ToolRegistry) -> Result<kawai_router::TaskPlan, String> {
    parse_supervisor_plan_scoped(raw, registry, &[])
}

/// Parse + validate a plan, additionally rejecting steps whose tool is in
/// `forbidden` (scoped enforcement: the initial planner and the reviser have
/// different tool vocabularies).
/// Non-fatal dataflow audit over a parsed plan: counts and logs (stderr) the
/// two plan-quality smells that validation deliberately tolerates —
/// (1) legacy `fromStep` references nested inside plain `arguments` (the
/// pre-`inputs` wiring style) and (2) `arguments` keys that an `inputs`
/// binding silently overrides. Pure: returns the counts, caller logs.
fn audit_dataflow(plan: &kawai_router::TaskPlan) -> (usize, usize) {
    fn has_legacy_ref(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(obj) => {
                obj.contains_key("fromStep")
                    || obj.values().any(has_legacy_ref)
            },
            serde_json::Value::Array(items) => items.iter().any(has_legacy_ref),
            _ => false,
        }
    }

    let mut legacy = 0usize;
    let mut collisions = 0usize;
    for step in &plan.steps {
        if has_legacy_ref(&step.arguments) {
            legacy += 1;
            eprintln!(
                "[supervisor] plan-quality: step \"{}\" uses a legacy fromStep reference inside arguments — move it to \"inputs\" (deprecated wiring)",
                step.id
            );
        }
        if let (Some(args), Some(bindings)) = (step.arguments.as_object(), step.inputs.as_object()) {
            for key in bindings.keys() {
                if args.contains_key(key) {
                    collisions += 1;
                    eprintln!(
                        "[supervisor] plan-quality: step \"{}\": argument \"{key}\" is OVERRIDDEN by an inputs binding — the literal value in arguments is discarded",
                        step.id
                    );
                }
            }
        }
    }
    (legacy, collisions)
}

pub fn parse_supervisor_plan_scoped(
    raw: &str,
    registry: &ToolRegistry,
    forbidden: &[&str],
) -> Result<kawai_router::TaskPlan, String> {
    let slice = kawai_router::extract_json_slice(raw).map_err(|e| e.to_string())?;
    let mut plan: kawai_router::TaskPlan = serde_json::from_str(slice)
        .map_err(|e| format!("invalid plan JSON: {e}"))?;
    // Explicit dataflow bindings ("inputs"): shape + target checks, and each
    // binding implies its dependency — the planner can never desynchronize
    // dependsOn from the dataflow it declared.
    kawai_router::bind_dataflow(&mut plan).map_err(|e| e.to_string())?;
    audit_dataflow(&plan);
    // Clamp an LLM-written summary to the UI contract, then backfill the
    // deterministic fallback when the planner omitted it — the summary is
    // always present on any plan leaving this parse path.
    plan.summary = plan.summary.take().map(kawai_router::sanitize_plan_summary);
    // Actions that restate a step task would be read twice (summary card +
    // step list directly below) — drop them.
    kawai_router::dedupe_plan_summary(&mut plan);
    ensure_plan_summary(&mut plan);
    // Models emit `""`, `"default"`, or other loose writer names meaning the
    // markdown deliverable — map them instead of burning a repair round.
    match plan.final_writer.as_deref().map(str::trim) {
        Some("") | Some("default") | Some("markdown") | None => {
            plan.final_writer = None;
        },
        Some(WRITER_DECK) => {
            // Deck synthesis is expensive (a full cloud round-trip per deck
            // round, with up to 3 rejection-retry rounds). Models over-pick
            // it for plain analysis/report goals despite the prompt saying
            // "ONLY when the user explicitly asks for slides" — guard it
            // deterministically: strip it unless the goal itself signals a
            // slide/deck/presentation deliverable.
            let goal = plan.goal.to_lowercase();
            let slide_intent = ["slide", "deck", "presentation", "presentasi", "ppt", "pptx", "pitch"]
                .iter()
                .any(|k| goal.contains(k));
            if !slide_intent {
                eprintln!(
                    "[supervisor] finalWriter \"deck_writer\" stripped — goal has no slide/deck/presentation intent"
                );
                plan.final_writer = None;
            }
        },
        Some(WRITER_DELIVERABLE) => {},
        Some(other) => {
            eprintln!(
                "[supervisor] unknown finalWriter \"{other}\" — using the default markdown writer"
            );
            plan.final_writer = None;
        },
    }
    for step in &plan.steps {
        let tool = step
            .tool
            .as_deref()
            .unwrap_or(step.agent_id.as_str())
            .to_ascii_lowercase();
        if forbidden.iter().any(|f| tool == *f) {
            return Err(format!(
                "step \"{}\" uses forbidden tool \"{tool}\" in this planning phase",
                step.id
            ));
        }
    }
    registry.enforce_confirmation_policy(&mut plan);
    enforce_cli_run_confirmation_tiering(&mut plan);
    registry.validate_plan(&plan).map_err(|e| e.to_string())?;
    Ok(plan)
}

/// cli_run tiering (deterministic, planner-proof): a step whose command is
/// NOT on the audited safe read-only allowlist gets confirmation forced on —
/// the manager only ever approves, in plain language, steps that can
/// actually mutate something; read/inspect steps run prompt-free.
fn enforce_cli_run_confirmation_tiering(plan: &mut kawai_router::TaskPlan) {
    for step in &mut plan.steps {
        if step.dispatch_key() != "cli_run" {
            continue;
        }
        let command = step
            .arguments
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !kawai_cli::is_safe_readonly(command) {
            step.requires_confirmation = Some(true);
        }
    }
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
                    tracing::warn!(component = "tool-catalog", error = %e, "catalog open failed");
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
            tracing::info!(component = "tool-catalog", frames, "catalog synced");
        }
        Ok(Ok(_)) => {} // already up to date
        Ok(Err(e)) => tracing::warn!(component = "tool-catalog", error = %e, "catalog sync failed"),
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
                Ok(_) => tracing::info!(component = "tool-catalog", "replica fresh after retry"),
                Err(e) => tracing::warn!(component = "tool-catalog", error = %e, "count check failed"),
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
                 planner restricted to core tools; re-seed via the ci.yml seed job \
                 (workflow_dispatch with the `prune` input — seeding is CI-only)"
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
/// `memory_search`: user context must be recalled before acting on nearly
/// every goal. `web_search`: goals about current events, markets, and news
/// must always be able to plan an up-to-date-information step even when
/// catalog retrieval ranks only domain specialists (measured: the cosine
/// gate crowds the generic web_search description out of crypto/market
/// queries). The planner prompt carries the counterweight guidance — prefer
/// a specialist when one covers the goal — so web_search is planned when the
/// goal genuinely needs fresh web data, not as a lazy default for every
/// goal.
/// All of them are DIRECTLY dispatchable toolset tools. Internal-dispatch
/// subagent tools (deep_write, draft_document, plan_task, plan_revise,
/// artifact_recall) are deliberately absent — the scheduler executes steps
/// via `ToolSet::execute`, where those tools return an "unavailable here"
/// error text instead of doing their work.
const PLAN_CORE_TOOLS: [&str; 4] = [
    "memory_search",
    "web_search",
    "session_step_results",
    // Per-device CLI executor (PLAN-cli-tools.md). Present in the registry
    // only when the machine's CLI inventory is non-empty — the filter below
    // drops it otherwise, exactly like the feature-gated domains.
    "cli_run",
];
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
/// not an incremental one) — a too-tight budget leaves the replica empty and
/// tool discovery blind. Frontend shows live "loading context" progress
/// during this window instead.
const PLAN_SEARCH_SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Cap on the accumulated search results package (matches the remote pool's
/// typical small-candidate materials budget).
const PLAN_MATERIALS_CAP: usize = 12_000;

fn plan_loop_system_prompt(core_tools: &str, cli_block: &str) -> String {
    format!(
        r#"You are a task planner for a deterministic supervisor.
The full tool catalog is NOT provided. Discover tools by searching.

Respond ONLY with ONE JSON object — either:
{{"action": "search", "queries": ["<search 1>", "<search 2>", "<search 3>"]}}
  (request tool search results; up to 3 diverse queries; describe CAPABILITIES, not tool names)
  — ALWAYS write the queries in ENGLISH: the catalog descriptions are English,
  so queries in any other language return junk and waste the search budget.
{{"goal": "<one-line goal>", "summary": {{"overview": "<1–3 sentences>", "actions": ["…"], "outputs": ["…"]}}, "steps": [{{"id": "s1", "tool": "<exact name>", "task": "…", "arguments": {{}}, "inputs": {{}}, "dependsOn": [], "produces": [], "timeoutMs": 30000, "retries": 0, "onError": "fail", "requiresConfirmation": false}}], "finalWriter": "deck_writer"}}
  (the final plan, once you know which tools to use)

Plan rules:
- "summary" is REQUIRED in the final plan: "overview" = 1–3 sentences (≤2
  recommended) in the USER'S LANGUAGE describing what the agent will do and
  why; "actions" = ≤4 plain-language actions that GROUP the steps into
  phases — NEVER restate an individual step's task verbatim (the step list
  is shown separately); "outputs" = ≤5 expected deliverables.
  Describe OUTCOMES, not tool mechanics — the user must understand the plan
  without reading the step list, and never promise an output no step
  produces (the supervisor's own final deliverable needs no entry).
- Decompose into 1..{} concrete steps; each step names exactly ONE tool.
- "task" is REQUIRED: a single line ≤80 chars describing the step in the
  USER'S LANGUAGE (the goal's language), for the progress UI — e.g.
  "Cek cuaca Tokyo", "Find 3 Bali beach photos". ALWAYS keep "arguments"
  complete and precise — the arguments are what the tool executes.
- Be concise overall: no prose outside the JSON, no repeated context.
- "dependsOn" lists step ids that must finish first; no cycles.
- To consume a previous step's output, bind it in "inputs": {{"<arg name>": {{"fromStep": "<step id>", "output": "<artifact name>"}}}} — never paste large content.
  A bound input implies its dependency (no separate dependsOn needed) and
  overrides "arguments" on the same key. Use fromStep ONLY for scalar string
  values (a fileId, a count). NEVER fill
  array-typed arguments (columns, groupBy, aggregations, filters, items) with
  fromStep — write the literal array yourself using the columns from
  data_schema.
- NEVER hardcode user-specific numbers (equity, risk %, prices, levels, dates)
  into step arguments — source them from a step artifact ("fromStep"), the
  quoted earlier run via "session_step_results", or "memory_search".
- "produces" names the artifacts a step emits for later steps. Tools listing
  a declared contract ("produces: …" in their catalog line) are AUTHORITATIVE:
  bindings from those steps must use exactly those names.
- Side-effect tools MUST set "requiresConfirmation": true with a short "confirmationDescription".
- For cli_run steps: read-only commands (ls, cat, grep, jq, du, …) run
  WITHOUT user approval — set "requiresConfirmation": false for those.
  Everything else that can mutate (ffmpeg, mv-class, installs, network
  fetches) REQUIRES "requiresConfirmation": true, and the
  confirmationDescription is what the user approves: state the concrete
  goal (e.g. "convert input.mov to h264 mp4 under 20MB"), not just
  "run ffmpeg". The validator enforces this: a non-read-only cli_run step
  without the flag is rejected. The binary is fixed at confirmation; the
  tool's translator may only vary that binary's arguments, under a static
  policy that blocks inline code and second-program execution.
- "onError" is one of "fail", "skip", "continue". Default "fail".
 - Keep each task description under {} chars.
 - Core tools below are ALWAYS available — never search for them. Their
   FULL argument schemas follow; copy required properties exactly:
{}
{cli_block}
 - CLI commands (see <cli-tools>): DEFAULT to passing `intent` — cli_run
   self-corrects internally (reads --help, retries on stderr) and can take
   1–2 minutes: set "timeoutMs": 120000 on cli_run steps that use `intent`.
   Pass exact `args` only when you are confident about the flags (fast
   path, instant). NEVER name a CLI that is not listed in <cli-tools>.
 - FORBIDDEN tools — validation will reject them: deep_write, draft_document, plan_task, plan_revise, artifact_recall, data_query, data_chart. Never name them in steps. For data questions use data_query_nl. For visualizations use data_chart_nl. To create documents use office_create_document / office_create_deck / pdf_create_from_markdown.
 - For data questions use data_query_nl and for charts use data_chart_nl — "data_query" and "data_chart" are NOT available at
   planning time (validation rejects them): the plan-REVISION phase writes
   the structured query/chart after data_schema has run.
 - The supervisor AUTOMATICALLY writes the final user-facing deliverable
   (answer / summary / report) from the step outputs after they finish — via a
   built-in writer agent you never see. NEVER plan a
   summarization / writing / "produce the answer" step yourself; plan only the
   data-gathering and artifact-producing steps that feed it.
 - "fileId" arguments MUST come from a real file id: a LITERAL id (from
   office_list_files or the attached-files context), OR an "inputs" binding
   to a step that actually produces a file id (e.g. office_list_files →
   {{"fileId": {{"fromStep": "<id>", "output": "files"}}}}). NEVER invent an id,
   NEVER reference a step whose output contains no file id (e.g.
   data_schema), and NEVER put a fromStep reference inside "arguments" —
   cross-step bindings belong in "inputs".
 - MANY steps, ONE file → ONE office_list_files step + "inputs" bindings.
   Do NOT copy a file id between steps or repeat a remembered id as a
   literal in several steps: plan office_list_files ONCE at the start, then
   bind "fileId" via "inputs" ({{"fromStep": "<list step>", "output": "files"}})
   in every consumer. Copy-pasted literals break every consumer at once when
   the id is wrong; a binding self-corrects against the listing.
 - "finalWriter" (optional): which writer synthesizes the deliverable. Omit it
   for the default markdown answer. Set "finalWriter":"deck_writer" ONLY when
   the user EXPLICITLY asks for a slide deck / presentation / .pptx as the
   final result — NEVER for data extraction, data analysis, documents, or
   images: those get the default markdown deliverable. When you set it, do
   NOT plan an office_create_deck step: plan only the research / data steps
   whose outputs the deck should be built from.
 - DEFAULT to data_query_nl for data questions: its arguments are trivial
   (fileId + query) and the tool self-corrects internally. NEVER use "*" as
   a column name anywhere.
 - data_query_nl translates via an LLM and can take 1–2 minutes end to end:
   set "timeoutMs": 120000 on data_query_nl steps (30000/60000 time them out).
 - If told the search budget is exhausted, respond ONLY with the final plan JSON.
"#,
        kawai_router::types::MAX_PLAN_STEPS,
        kawai_router::types::MAX_TASK_CHARS,
        core_tools,
    )
}

/// System prompt for the failure-driven PLAN REVISION call. Deliberately
/// NOT `plan_loop_system_prompt`: the reviser sees the FULL tool catalog
/// (no search rounds remain) and must never respond with the planner's
/// `{"action":"search"}` protocol — observed live 2026: both corrective
/// rounds were burned on search-protocol replies that fail plan validation.
fn revise_system_prompt(catalog: &str) -> String {
    format!(
        r#"You are a task-plan REVISER for a deterministic supervisor.
A previous plan failed mid-execution. Your job: produce a CORRECTED plan that
completes the original goal from the current state.

The FULL tool catalog is provided below — do NOT ask for more tools, do NOT
search. Respond ONLY with ONE JSON object, exactly this shape:
{{"goal": "<one-line goal>", "summary": {{"overview": "<1–3 sentences, user's language>", "actions": ["…"], "outputs": ["…"]}}, "steps": [{{"id": "s1", "tool": "<exact name>", "task": "…", "arguments": {{}}, "inputs": {{}}, "dependsOn": [], "produces": [], "timeoutMs": 30000, "retries": 0, "onError": "fail", "requiresConfirmation": false}}], "finalWriter": "deck_writer"}}

Rules:
- Reuse the outputs of already-completed steps by binding them in "inputs": {{"<arg name>": {{"fromStep": "<step id>", "output": "<artifact name>"}}}} — never redo work that succeeded. A bound input implies its dependency.
- Fix ONLY what failed: the failure reason is in the execution report.
- "task" is REQUIRED: one line ≤80 chars in the USER'S LANGUAGE.
- "summary" mirrors the planner's contract: overview = 1–3 sentences in
  the user's language; ≤4 actions that GROUP steps (never restate one); ≤5 expected outputs.
- Keep "arguments" complete and precise — they are what the tool executes.
- Side-effect tools MUST set "requiresConfirmation": true with a short "confirmationDescription".
- For cli_run steps: read-only commands (ls, cat, grep, jq, du, …) run
  WITHOUT user approval — set "requiresConfirmation": false for those.
  Everything else that can mutate (ffmpeg, mv-class, installs, network
  fetches) REQUIRES "requiresConfirmation": true, and the
  confirmationDescription is what the user approves: state the concrete
  goal (e.g. "convert input.mov to h264 mp4 under 20MB"), not just
  "run ffmpeg". The validator enforces this: a non-read-only cli_run step
  without the flag is rejected. The binary is fixed at confirmation; the
  tool's translator may only vary that binary's arguments, under a static
  policy that blocks inline code and second-program execution.
- Never name FORBIDDEN internal tools: deep_write, draft_document, plan_task, plan_revise, artifact_recall.
- data_query IS available to you (the execution report contains data_schema's
  real columns) — prefer it for data questions.
- NEVER use "*" as a column name — to count all rows, aggregate any real column.
- "fileId" arguments must be a real file id: a LITERAL id (from
  office_list_files or the attached-files context) or an "inputs" binding to
  a step that produces a file id. NEVER from data_schema output (no file id
  there), never an invented id, and never a fromStep reference inside
  "arguments" — cross-step bindings belong in "inputs". Do not copy the
  same literal id across several steps — bind via "inputs" instead.
- The supervisor writes the final user-facing deliverable itself — never plan a summarization step.
- "finalWriter" (optional): OMIT it for the default markdown answer. Set
  "finalWriter":"deck_writer" ONLY when the user EXPLICITLY asks for a slide
  deck / presentation / .pptx — NEVER for data analysis or when the user asks
  for a short/ringkas numeric answer.
- PREFER data_query for data questions — the execution report already
  contains the real columns. data_query_nl only for genuinely open-ended
  requests.
- Set "timeoutMs": 120000 on data_query_nl steps — translation can take
  1–2 minutes end to end.
- No prose outside the JSON.

FULL tool catalog (schemas included — copy required properties exactly):
{}"#,
        catalog
    )
}

/// Execute one search round: embed the queries, hit the Turso catalog AND
/// the device-local cli-catalog, dedupe against everything already shown,
/// and format the results block. Returns the block plus the names of the
/// newly surfaced tools/CLIs (planner progress telemetry).
async fn run_tool_search(
    catalog: Option<&kawai_tool_catalog::Catalog>,
    embedder: &kawai_embedding::TenantAwareEmbedder,
    registry: &kawai_router::ToolRegistry,
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
            tracing::warn!(component = "supervisor", error = %e, "catalog embedding failed");
            return ("\n<tool-search-results>\nTool search failed (embedding unavailable); rely on the core tools listed above.\n</tool-search-results>\n".to_string(), Vec::new());
        }
    };
    let mut block = String::from("\n<tool-search-results>\n");
    let mut found: Vec<String> = Vec::new();
    let mut cli_seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (query, qvec) in queries.iter().zip(vecs) {
        block.push_str(&format!("\nquery: {query}\n"));
        // k=8 (was 6): the vector side is noisy — generic-description tools
        // (crypto_price, get_sector_performance, …) rank for nearly every
        // query, crowding the specialist tools out of the fused top-k. More
        // slots give BM25-side specialist hits room to survive the fusion.
        let hits = match catalog.search(query, &qvec, 8).await {
            Ok(hits) => hits,
            Err(e) => {
                tracing::warn!(component = "supervisor", query = %query, error = %e, "catalog search failed");
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
            // The Turso catalog is seeded globally (all domains, all feature
            // combos) while THIS build's registry only contains the tools it
            // can dispatch (e.g. binance_* are feature-gated off). Surfacing a
            // catalog hit the registry cannot dispatch guarantees a validation
            // rejection — every such pick burns a corrective planner round.
            if registry.get(&hit.name).is_none() {
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

        // Device CLI side — the local cli-catalog (on-device EmbeddingGemma
        // space, same hybrid recipe, independent of the Turso catalog). A
        // not-yet-ready catalog skips silently: the <cli-tools> prompt block
        // already carries the inventory head as fallback.
        let mut cli_listed = 0;
        if let Ok(cli_hits) = kawai_cli::search_installed(query, 4).await {
            for hit in cli_hits {
                if !cli_seen.insert(hit.name.clone()) {
                    continue;
                }
                cli_listed += 1;
                found.push(hit.name.clone());
                surfaced.push(hit.name.clone());
                match hit.description {
                    Some(desc) => block.push_str(&format!(
                        "- {} — {desc}\n  (installed CLI — run it via `cli_run`)\n",
                        hit.name
                    )),
                    None => block.push_str(&format!(
                        "- {}\n  (installed CLI — run it via `cli_run`)\n",
                        hit.name
                    )),
                }
            }
        }
        if cli_listed > 0 {
            tracing::info!(component = "supervisor", query = %query, surfaced = ?surfaced, "cli-catalog search surfaced CLIs");
        }
        // Planner-search telemetry: which query surfaced which tools (the
        // search block itself is otherwise invisible outside the LLM call).
        tracing::info!(component = "supervisor", query = %query, surfaced = ?surfaced, "catalog search completed");
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
/// Falls back to the session's newest plan rows when `plan_key` has no match
/// — plan records written before the planKey field existed can still reach
/// their full bodies.
pub async fn step_output(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
    step_id: &str,
) -> Result<String, String> {
    let rows = kawai_db::list_supervisor_step_results(user_id, session_id, plan_key)
        .await
        .map_err(|e| format!("supervisor_step_output: {e}"))?;
    if let Some(r) = rows.into_iter().rev().find(|r| r.step_id == step_id) {
        return Ok(r.output);
    }
    let fallback = kawai_db::list_supervisor_step_results_by_session(user_id, session_id, 200)
        .await
        .map_err(|e| format!("supervisor_step_output: {e}"))?;
    fallback
        .into_iter()
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
            Err(e) => tracing::warn!(component = "supervisor", error = %e, "resume seed unavailable"),
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
            // Cooperative deadline: tools with internal retry loops (the NL
            // data tools) read this and return a structured "budget ran out"
            // error instead of being hard-killed into an opaque timeout.
            let step_deadline = call
                .timeout_ms
                .map(|ms| started + std::time::Duration::from_millis(ms));
            let result = kawai_analytics::deadline::scope(
                step_deadline,
                toolset.execute(&name, args.clone()),
            )
            .await;
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
                    tracing::warn!(component = "supervisor", error = %e, "step result persist failed");
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
    let mut out = arg_obj.clone();
    for (key, value) in arg_obj {
        let Some(prop_schema) = properties.get(key) else { continue };
        if !wants_string(prop_schema) {
            continue;
        }
        // Plain strings are the happy path — except stringified JSON, which
        // the whole-output fallback produces and pick_file_id unwraps.
        let stringified =
            matches!(value, serde_json::Value::String(s) if s.starts_with('{') || s.starts_with('['));
        if value.is_string() && !stringified {
            continue;
        }
        if let Some(coerced) = pick_file_id(tool, value, 2) {
            out.insert(key.clone(), coerced);
        }
    }
    serde_json::Value::Object(out)
}

/// Pick a single file id out of a resolver-produced value. Prefer the PDF
/// entry in a files list when the consumer is a pdf_ tool; otherwise the
/// first entry.
fn pick_file_id(
    tool: &str,
    v: &serde_json::Value,
    depth: usize,
) -> Option<serde_json::Value> {
    let candidate = |e: &serde_json::Value| -> Option<serde_json::Value> {
        // Only file-like objects are unambiguous; plain strings are left
        // alone so list→scalar mistakes fail loudly at the tool instead
        // of silently taking the first element.
        match e {
            serde_json::Value::Object(o) => o
                .get("id")
                .or_else(|| o.get("handle"))
                .filter(|v| v.is_string())
                .cloned()
                // Artifact-value shape from the named-output path:
                // {"type":"handle","value":…,"kind":…}.
                .or_else(|| {
                    if o.get("type").and_then(|v| v.as_str()) == Some("handle") {
                        o.get("value").filter(|v| v.is_string()).cloned()
                    } else {
                        None
                    }
                }),
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
        serde_json::Value::Object(_) => {
            candidate(v).or_else(|| {
                // Nested envelopes (e.g. {"data":{"files":[…]}}): search the
                // object's values one level down.
                (depth > 1).then_some(()).and_then(|_| {
                    v.as_object()?.values().find_map(|child| pick_file_id(tool, child, depth - 1))
                })
            })
        }
        // Stringified JSON: the resolver's last-resort whole-output
        // fallback hands the consumer the producer's serialized output
        // (e.g. office_list_files' {"data":{"files":[…]}} blob). Parse
        // it and pick the id from the embedded file entries.
        serde_json::Value::String(s) if s.starts_with('{') || s.starts_with('[') => {
            serde_json::from_str::<serde_json::Value>(s)
                .ok()
                .and_then(|parsed| pick_file_id(tool, &parsed, 4))
        }
        _ => None,
    }
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
    // Files-list envelopes (office_list_files: {"data":{"files":[…]},"ok":…
    // ,"summary":…}) carry a named `files` artifact so planner references like
    // `${s1.files}` resolve to a single file id directly, instead of the whole
    // envelope. Deterministic plans have no select mechanism: prefer the
    // spreadsheet entry, then pdf, else the first.
    let files = value
        .get("files")
        .or_else(|| value.get("data").and_then(|d| d.get("files")))
        .and_then(|v| v.as_array());
    if let Some(items) = files {
        if items.iter().all(|e| {
            e.get("id").and_then(|v| v.as_str()).is_some()
        }) {
            let chosen = items
                .iter()
                .find(|e| matches!(e.get("ext").and_then(|x| x.as_str()), Some("xlsx") | Some("xls") | Some("csv")))
                .or_else(|| items.iter().find(|e| e.get("ext").and_then(|x| x.as_str()) == Some("pdf")))
                .or_else(|| items.first())
                .and_then(|e| e.get("id").and_then(|v| v.as_str()));
            if let Some(id) = chosen {
                return vec![kawai_router::Artifact::Handle {
                    value: id.to_string(),
                    kind: Some("files".to_string()),
                }];
            }
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
/// frontend only previews (160 chars) and persists to history (≤2000-char
/// wire previews),
/// so the transport event carries a bounded preview. The plan's FINAL
/// output (`planCompleted.final_output`) is the user-visible answer and is
/// deliberately NOT capped here.
const STEP_EVENT_OUTPUT_MAX_CHARS: usize = 2000;

/// The virtual post-plan step that writes the user-facing deliverable.
/// Not part of the TaskPlan — emitted as lifecycle events so the UI can show
/// synthesis as real, trackable work.
pub const DELIVERABLE_STEP_ID: &str = "__deliverable";
pub const DELIVERABLE_TOOL: &str = "deliverable_writer";

/// The final-writer whitelist — the only `finalWriter` values a plan may
/// carry. Planner picks the synthesis agent; the supervisor executes it.
pub const WRITER_DELIVERABLE: &str = DELIVERABLE_TOOL; // "deliverable_writer"
pub const WRITER_DECK: &str = "deck_writer";

/// Char-boundary-safe prefix of `s` (at most `max_chars` characters).
fn preview_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Emit the workflow-step record for a finished scheduler node and end its
/// span (best-effort telemetry — never affects execution).
fn finish_step_telemetry(
    conversation: &str,
    step_id: &str,
    tool: &str,
    parent_step_ids: Vec<String>,
    started_at: std::time::SystemTime,
    span: &mut kawai_telemetry::TelemetrySpan,
    output: &str,
    error: Option<String>,
) {
    let (trace_id, span_id) = span.context_ids();
    span.end();
    kawai_telemetry::record_workflow_step(kawai_telemetry::WorkflowStepRecord {
        conversation_id: conversation.to_string(),
        step_name: format!("{tool}:{step_id}"),
        framework: "kawai-supervisor".into(),
        started_at,
        completed_at: std::time::SystemTime::now(),
        input_state: serde_json::json!({ "step_id": step_id, "tool": tool }),
        output_state: serde_json::json!({
            "chars": output.chars().count(),
            "preview": preview_chars(output, 1_000),
        }),
        error,
        tags: vec![("tool".into(), tool.into())],
        linked_generation_ids: kawai_telemetry::last_generation_id(conversation, tool)
            .into_iter()
            .collect(),
        parent_step_ids,
        agent_name: "kawai-supervisor".into(),
        agent_version: env!("CARGO_PKG_VERSION").into(),
        trace_span: Some((trace_id, span_id)),
    });
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

// ── Failure-triggered SURGICAL repair (replaces whole-plan replanning) ──

/// Hard cap on planner repair rounds per plan execution. Each round only
/// rewrites the FAILED subgraph — successful steps are frozen (and their
/// outputs replayed from the supervisor_step_results cache) — so a round is
/// cheap and its blast radius is small. 3 rounds = the system retries
/// itself instead of surfacing the failure to the user.
const MAX_REPLANS: u32 = 3;

/// The subgraph a repair round may rewrite: the failed steps plus every
/// step that (transitively) depends on one. Everything else is FROZEN —
/// the validator rejects a revision that alters it.
fn repairable_step_ids(
    plan: &kawai_router::TaskPlan,
    result: &kawai_router::ExecutionResult,
) -> std::collections::HashSet<String> {
    let mut repairable: std::collections::HashSet<String> = result
        .failures()
        .iter()
        .map(|f| f.step_id.clone())
        .collect();
    loop {
        let mut grew = false;
        for step in &plan.steps {
            if repairable.contains(&step.id) {
                continue;
            }
            if step.depends_on.iter().any(|d| repairable.contains(d)) {
                repairable.insert(step.id.clone());
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }
    repairable
}

/// Enforce the repair mandate mechanically: every step outside the
/// repairable subgraph is restored from the ORIGINAL plan — byte-identical
/// tool, arguments, and inputs — whether the reviser mutated it or dropped
/// it. The prompt asks nicely; this guarantees. Re-execution never re-runs
/// a restored step: the ExecutionMemo serves the identical completed call.
/// Returns the ids that drifted (non-empty = the reviser touched frozen
/// steps; logged, not fatal — rejection here used to burn the whole run).
fn restore_frozen_steps(
    revised: &mut kawai_router::TaskPlan,
    original: &kawai_router::TaskPlan,
    repairable: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut restored = Vec::new();
    for orig in &original.steps {
        if repairable.contains(&orig.id) {
            continue;
        }
        let drifted = match revised.steps.iter().position(|s| s.id == orig.id) {
            Some(idx) => {
                let existing = &revised.steps[idx];
                let drifted = existing.tool != orig.tool
                    || existing.arguments != orig.arguments
                    || existing.inputs != orig.inputs;
                revised.steps[idx] = orig.clone();
                drifted
            }
            None => {
                revised.steps.push(orig.clone());
                true
            }
        };
        if drifted {
            restored.push(orig.id.clone());
        }
    }
    restored
}

/// Rich per-step materials for the surgical repairer: each step carries its
/// FULL arguments (not a 300-char output preview) and its full error, plus
/// an explicit frozen/revisable marker and its dataflow bindings (with the
/// producing tool's contract). This is what makes the repair able to
/// actually fix args instead of re-emitting them blind.
fn repair_materials(
    plan: &kawai_router::TaskPlan,
    result: &kawai_router::ExecutionResult,
    repairable: &std::collections::HashSet<String>,
    tool_contracts: &std::collections::HashMap<String, Vec<String>>,
) -> String {
    const OUTPUT_CHARS: usize = 300;
    const ERROR_CHARS: usize = 4_000;
    let mut out = String::from("<original-plan>\n");
    for step in &plan.steps {
        let r = result.get(&step.id);
        let status = match r.map(|r| r.status) {
            Some(kawai_router::StepStatus::Completed) => "completed",
            Some(kawai_router::StepStatus::Failed) => "failed",
            _ => "skipped",
        };
        let frozen = !repairable.contains(&step.id);
        let args = serde_json::to_string(&step.arguments).unwrap_or_default();
        out.push_str(&format!(
            "<step id=\"{}\" tool=\"{}\" status=\"{status}\" frozen=\"{frozen}\">\n",
            step.id,
            step.tool.clone().unwrap_or_else(|| step.agent_id.clone()),
        ));
        out.push_str(&format!("arguments: {args}\n"));
        // Dataflow bindings + the producing contract, so the repairer sees
        // WHAT each step consumes and from WHOM — a failed step is often a
        // mis-wired binding, and dependents of a rewired step must be shown
        // the new source.
        if let Some(bindings) = step.inputs.as_object().filter(|b| !b.is_empty()) {
            let mut lines = Vec::new();
            for (arg, reference) in bindings {
                let from = reference.get("fromStep").and_then(|v| v.as_str()).unwrap_or("?");
                let name = reference.get("output").and_then(|v| v.as_str()).unwrap_or("?");
                let contract = plan
                    .steps
                    .iter()
                    .find(|p| p.id == from)
                    .map(|p| tool_contracts.get(p.dispatch_key()).cloned())
                    .flatten()
                    .unwrap_or_default();
                if contract.is_empty() {
                    lines.push(format!("  {arg} ← {from}.{name}"));
                } else {
                    lines.push(format!(
                        "  {arg} ← {from}.{name} (tool contract: {})",
                        contract.join(", ")
                    ));
                }
            }
            out.push_str(&format!("consumes:\n{}\n", lines.join("\n")));
        }
        if let Some(r) = r {
            match r.status {
                kawai_router::StepStatus::Completed => {
                    let preview: String = r.output.chars().take(OUTPUT_CHARS).collect();
                    out.push_str(&format!("output-preview: {preview}\n"));
                },
                kawai_router::StepStatus::Failed => {
                    let error: String = r
                        .error
                        .as_deref()
                        .unwrap_or("unknown")
                        .chars()
                        .take(ERROR_CHARS)
                        .collect();
                    out.push_str(&format!("error: {error}\n"));
                },
                _ => {},
            }
        }
        out.push_str("</step>\n");
    }
    out.push_str("</original-plan>");
    out
}

/// Targeted repair hints derived from known mis-tooling failure shapes. The
/// reviser sees the raw error but not WHY the tool choice itself was wrong —
/// observed live 2026: a `cli_run cat <attachment>` step failed with `spawn
/// failed: No such file or directory`, and the reviser kept `cli_run` and
/// only tweaked the argv, burning the repair round on a hopeless fix. Each
/// recognized shape states the actual replacement tool. Best-effort — no
/// match yields an empty string.
fn repair_hints(
    plan: &kawai_router::TaskPlan,
    result: &kawai_router::ExecutionResult,
) -> String {
    let mut hints: Vec<String> = Vec::new();
    for step in &plan.steps {
        let Some(r) = result.get(&step.id) else { continue };
        if r.status != kawai_router::StepStatus::Failed {
            continue;
        }
        let error = r.error.as_deref().unwrap_or("");
        let tool = step.tool.clone().unwrap_or_else(|| step.agent_id.clone());
        if tool == "cli_run" && error.contains("No such file or directory") {
            hints.push(format!(
                "- step {}: cli_run failed because the path does not exist on this \
                 machine's filesystem. Session attachments and knowledge files are NOT \
                 filesystem files — replace this step with knowledge_search (their \
                 content is indexed for this session). Do NOT retry cli_run with a \
                 different path.",
                step.id
            ));
        }
    }
    if hints.is_empty() {
        return String::new();
    }
    format!(
        "\n<repair-hints>\nKnown mis-tooling shapes in this failure — these are TOOL-CHOICE \
         problems, not argv problems; apply the stated replacement:\n{}\n</repair-hints>",
        hints.join("\n")
    )
}

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
/// Deterministic repair for a reviser reply that parses as JSON but omits
/// the required `goal` field: inject the original goal (an object without
/// `goal`), or wrap a bare steps array as `{goal, steps}`. Anything that
/// isn't JSON passes through unchanged so the normal parse error +
/// corrective-feedback path still applies.
fn repair_revised_plan_json(raw: &str, goal: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        return raw.to_string();
    };
    match &mut v {
        serde_json::Value::Object(map) => {
            let needs = map
                .get("goal")
                .and_then(|g| g.as_str())
                .map(str::trim)
                .is_none_or(str::is_empty);
            if needs {
                map.insert("goal".to_string(), serde_json::Value::String(goal.to_string()));
            }
        },
        serde_json::Value::Array(_) => {
            v = serde_json::json!({ "goal": goal, "steps": v });
        },
        _ => return raw.to_string(),
    }
    v.to_string()
}

/// Rewrite a revised plan so references to COMPLETED steps of the original
/// execution resolve without those steps being re-included:
/// - `dependsOn` entries not present in the revised plan are dropped
///   (completed steps need no waiting).
/// - `arguments` `{"fromStep": "<completed id>", "output": …}` become the
///   literal output value (bounded — a fileId, a count — with large outputs
///   truncated to a preview the model can still read).
fn resolve_completed_refs(raw: &str, result: &kawai_router::ExecutionResult) -> String {
    let mut plan = match serde_json::from_str::<serde_json::Value>(raw.trim()) {
        Ok(v) => v,
        Err(_) => return raw.to_string(),
    };
    let Some(steps) = plan.get_mut("steps").and_then(|s| s.as_array_mut()) else {
        return raw.to_string();
    };
    let plan_ids: std::collections::HashSet<String> = steps
        .iter()
        .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    let completed = |id: &str| -> Option<String> {
        result.get(id).and_then(|r| {
            (r.status == kawai_router::StepStatus::Completed)
                .then(|| r.output.clone())
        })
    };
    for step in steps.iter_mut() {
        // arguments: inline completed-step outputs referenced via fromStep.
        if let Some(args) = step.get_mut("arguments").and_then(|a| a.as_object_mut()) {
            for (_k, v) in args.iter_mut() {
                let Some(obj) = v.as_object() else { continue };
                let Some(from) = obj.get("fromStep").and_then(|f| f.as_str()) else {
                    continue;
                };
                if let Some(mut output) = completed(from) {
                    if output.chars().count() > 2_000 {
                        output = output.chars().take(2_000).collect::<String>()
                            + "… (truncated)";
                    }
                    *v = serde_json::Value::String(output);
                }
            }
        }
        // dependsOn: drop entries that are not steps of THIS plan.
        if let Some(deps) = step.get_mut("dependsOn").and_then(|d| d.as_array_mut()) {
            deps.retain(|d| {
                d.as_str()
                    .map(|s| plan_ids.contains(s))
                    .unwrap_or(true)
            });
        }
    }
    plan.to_string()
}

async fn revise_plan(
    goal: &str,
    original: &kawai_router::TaskPlan,
    reason: &str,
    result: &kawai_router::ExecutionResult,
    registry: &ToolRegistry,
    session_id: i64,
    user_id: &str,
    run_span: Option<&Arc<Mutex<kawai_telemetry::TelemetrySpan>>>,
) -> Result<kawai_router::TaskPlan, String> {
    eprintln!("[supervisor] revise_plan: entered (reason={} chars)", reason.len());
    // The repair mandate is surgical: only the failed subgraph may change.
    let repairable = repairable_step_ids(original, result);
    let repairable_list: Vec<&str> = original
        .steps
        .iter()
        .filter(|s| repairable.contains(&s.id))
        .map(|s| s.id.as_str())
        .collect();
    let frozen_list: Vec<&str> = original
        .steps
        .iter()
        .filter(|s| !repairable.contains(&s.id))
        .map(|s| s.id.as_str())
        .collect();
    let remote = remote_llm::RemoteLlm::from_env()
        .map(|r| {
            let mut r = r
                .with_output_cap(4_000)
                .with_agent("planner")
                // Same reasoning-burns-the-cap shape as the planner loop.
                .with_thinking_disabled()
                .with_conversation(format!("kawai-session-{session_id}"))
                .with_user(user_id);
            if let Some(rs) = run_span {
                if let Ok(guard) = rs.lock() {
                    r.with_span_parent(&guard);
                }
            }
            r
        })
        .ok_or_else(|| "remote LLM is not configured".to_string())?;
    // Reviser gets the FULL catalog and a search-free prompt — the revision
    // loop has no search handler, so a `{"action":"search"}` reply is an
    // automatic dead end (observed live 2026: both corrective rounds burned).
    let system = revise_system_prompt(&registry.catalog_lines());

    let mut materials = repair_materials(
        original,
        result,
        &repairable,
        // Tool → declared artifact contract — the repairer sees each
        // binding's provenance and the names the source tool guarantees.
        &registry
            .metas()
            .filter(|m| !m.produces.is_empty())
            .map(|m| (m.name.clone(), m.produces.clone()))
            .collect(),
    );
    // Known mis-tooling shapes get an explicit replacement directive — the
    // raw error alone led the reviser to keep the wrong tool (see
    // `repair_hints`). Rides BEFORE previous_runs/experiences so it sits
    // closest to the failure details.
    materials.push_str(&repair_hints(original, result));
    materials.push_str(&previous_runs_block(user_id, session_id).await);
    materials.push_str(&experiences_block(user_id, &goal).await);

    let task = format!(
        "The execution of the plan for this goal FAILED at some steps. Repair it SURGICALLY — \
         do NOT rewrite the whole plan.\n\nOriginal goal:\n{goal}\
         \n\nFailures:\n{reason}\
         \n\n{materials}\
         \n\nREPAIR MANDATE:\n\
         - FROZEN steps ({}) already succeeded: return them UNCHANGED — same id, tool, and arguments, byte-for-byte.\
         \n- You may rewrite ONLY these steps (the failed steps and their dependents): {}\
         \n- Produce the COMPLETE plan: every frozen step + the repaired steps. Never drop or alter a frozen step.\
         \nRespond ONLY with the plan JSON.",
        frozen_list.join(", "),
        repairable_list.join(", "),
    );

    for round in 0..2 {
        let mut raw = String::new();
        eprintln!(
            "[supervisor] revise round {round}: calling planner (materials={} chars)",
            materials.len()
        );
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
                eprintln!("[supervisor] revise round {round}: watchdog fired (300s), raw so far: {} chars", raw.len());
                return Err(format!("revised-planner call did not finish in 300s: {e}"));
            }
            eprintln!(
                "[supervisor] revise round {round}: planner returned {} chars, parsing",
                raw.len()
            );
        }
        // Deterministic repair: revisers routinely emit a bare steps array
        // (observed live 2026: `{"steps": [...]}` / `[...]` without `goal`).
        // The revision's goal is by definition the original goal — inject it
        // instead of burning the last corrective round on a mechanical fix.
        let raw = repair_revised_plan_json(&raw, goal);
        // Revisers routinely reference ORIGINAL-plan steps that already
        // completed (fromStep / dependsOn) without re-including them — the
        // validator rejects those as unknown ids (observed live 2026). Rewrite
        // the plan so completed outputs are inlined as literal arguments and
        // dangling dependsOn entries are dropped; then validate normally.
        let raw = resolve_completed_refs(&raw, result);
        match parse_supervisor_plan_scoped(&raw, registry, REVISE_FORBIDDEN_TOOLS) {
            Ok(plan) if !plan.steps.is_empty() => {
                let mut plan = plan;
                let restored = restore_frozen_steps(&mut plan, original, &repairable);
                if !restored.is_empty() {
                    eprintln!(
                        "[supervisor] revise round {round}: frozen-step drift auto-restored: {}",
                        restored.join(", ")
                    );
                }
                return Ok(plan);
            }
            Ok(_) => {
                materials.push_str(
                    "\n<plan-rejected>The revised plan had no steps. Respond ONLY with plan JSON.</plan-rejected>",
                );
            }
            Err(plan_err) => {
                eprintln!(
                    "[supervisor] revise round {round}: plan rejected: {plan_err}; raw: {raw}"
                );
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

/// A stored chart this run produced (from a `data_chart` step output).
struct RunChart {
    file_id: String,
    label: String,
    mark: String,
}

/// Deterministic scan of the run's step outputs for chart artifacts. The
/// deliverable writer may embed these via `![caption](kawai-file://<id>)`;
/// any other id it writes is stripped by [`strip_unknown_chart_tokens`].
fn collect_run_charts(result: &kawai_router::ExecutionResult) -> Vec<RunChart> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for r in &result.results {
        if r.status != kawai_router::StepStatus::Completed {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(r.output.trim()) else {
            continue;
        };
        if v.get("kind").and_then(|k| k.as_str()) != Some("chart") {
            continue;
        }
        let Some(file_id) = v.get("fileId").and_then(|f| f.as_str()) else {
            continue;
        };
        if !seen.insert(file_id.to_string()) {
            continue;
        }
        let mark = v
            .get("mark")
            .and_then(|m| m.as_str())
            .unwrap_or("chart")
            .to_string();
        let label = v
            .get("title")
            .and_then(|t| t.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{mark} chart"));
        out.push(RunChart {
            file_id: file_id.to_string(),
            label,
            mark,
        });
    }
    out
}

/// Chart guidance + inventory for the deliverable writer's materials.
fn charts_material_block(charts: &[RunChart]) -> String {
    if charts.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\n<charts>\nThis run stored chart images the user can see. If the answer discusses \
         one, embed it by writing the markdown image EXACTLY in this form — the \
         kawai-file:// scheme, the chart id in the parentheses, a short caption in the \
         brackets — alone on its own line:\n\
         ![caption](kawai-file://ID)\n\
         Never invent ids, never use http URLs, never wrap the image in a code fence.\n\
         Available charts:\n",
    );
    for c in charts {
        out.push_str(&format!("- kawai-file://{} — {} ({})\n", c.file_id, c.label, c.mark));
    }
    out.push_str("</charts>");
    out
}

/// Remove image tokens whose id is not one of this run's charts — the writer
/// occasionally parrots a malformed id, and a broken image must never reach
/// the deliverable. The caption text is kept.
fn strip_unknown_chart_tokens(text: &str, charts: &[RunChart]) -> String {
    static TOKEN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"!\[([^\]\n]*)\]\(kawai-file://([^)\s]+)\)").expect("chart token regex")
    });
    let valid: std::collections::HashSet<&str> =
        charts.iter().map(|c| c.file_id.as_str()).collect();
    TOKEN
        .replace_all(text, |caps: &regex::Captures| {
            let id = caps.get(2).map(|g| g.as_str()).unwrap_or_default();
            if valid.contains(id) {
                caps.get(0).expect("whole match").as_str().to_string()
            } else {
                caps.get(1).map(|g| g.as_str()).unwrap_or_default().to_string()
            }
        })
        .into_owned()
}

/// Attach an optional telemetry span parent to a remote LLM handle.
/// Returns `None` when `remote` is `None` (pool unavailable).
#[cfg(not(test))]
fn attach_span_parent(
    run_span: Option<&Arc<Mutex<kawai_telemetry::TelemetrySpan>>>,
    remote: &mut Option<remote_llm::RemoteLlm>,
) -> Option<remote_llm::RemoteLlm> {
    let mut r = remote.take()?;
    if let Some(rs) = run_span {
        if let Ok(guard) = rs.lock() {
            r.with_span_parent(&guard);
        }
    }
    Some(r)
}

/// One cloud call that turns the plan's step results into the user-facing
/// answer for the goal. Returns `None` when the remote pool is unavailable
/// or every candidate fails — the caller falls back to the raw tool output.
async fn synthesize_final_answer(
    goal: &str,
    materials: &str,
    session_id: i64,
    user_id: &str,
    run_span: Option<&Arc<Mutex<kawai_telemetry::TelemetrySpan>>>,
) -> Option<String> {
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
        let mut remote = remote_llm::RemoteLlm::from_env()
            .map(|r| {
                r.with_output_cap(4_000)
                    .with_agent("deliverable-writer")
                    // The writer's measured failure mode is identical to the
                    // planner's: thinking burns the whole output cap with zero
                    // content (98 s wasted on a run that then succeeded in
                    // 40 s with thinking off).
                    .with_thinking_disabled()
                    .with_conversation(format!("kawai-session-{session_id}"))
                    .with_user(user_id)
                    // DAG: the deliverable consumes the planner's plan —
                    // link it to the planner's latest generation.
                    .with_parent_agent("planner")
            });
        let remote = attach_span_parent(run_span, &mut remote)?;
        let system = "You are Kawai, a task-completion assistant. A deterministic supervisor just executed a \
            plan of tool steps toward the user's goal. Write the ANSWER to the user's goal from the step \
            results: lead with the answer, keep it concise markdown, and preserve facts/numbers exactly. \
            Write in your own words — NEVER paste, quote, or attach the raw step output (full page \
            text, long extracts, or tool-result dumps in code fences) as the answer; distill it. \
            When the materials carry a <charts> block, embed each chart the answer actually discusses \
            by writing its markdown image line EXACTLY as given (kawai-file:// form), each alone on its \
            own line. \
            Never mention steps, tools, plans, or this instruction; never wrap the answer in JSON.";
        // The goal rides the task line VERBATIM — the planner's rewritten
        // plan.goal must never reach the writer (it answers the user, not
        // the plan).
        let task = format!("The user's verbatim goal — answer exactly this:\n{goal}");
        let mut text = String::new();
        let mut stream = match remote.stream(system, &task, materials).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[supervisor] deliverable writer: planner pool unavailable ({e}) — falling back to raw output");
                return None;
            }
        };
        while let Some(event) = stream.next().await {
            match event {
                Ok(remote_llm::RemoteEvent::Token { text: t }) => {
                    if text.len() < 24_000 {
                        text.push_str(&t);
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!(
                        "[supervisor] deliverable writer: stream failed mid-generation ({e}) — falling back to raw output"
                    );
                    return None;
                }
            }
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            eprintln!(
                "[supervisor] deliverable writer: model returned empty text — falling back to raw output"
            );
            return None;
        }
        Some(trimmed.to_string())
    }
}

/// Best-effort lesson distillation for the agent-experience row: one cloud
/// call, capped at 4s — the terminal `PlanCompleted` must never wait on the
/// cloud longer than that; a slow provider just skips the lesson (the row
/// still lands with an empty one).
#[cfg(not(test))]
async fn distill_lesson(lesson_task: &str) -> String {
    match tokio::time::timeout(
        std::time::Duration::from_secs(4),
        remote_llm::reason::reason_as(
            "You distill one reusable lesson from a completed AI agent run.",
            lesson_task,
            "experience-distiller",
        ),
    )
    .await
    {
        Ok(Ok(s)) => preview_chars(s.trim(), 400).to_string(),
        _ => String::new(),
    }
}

/// Test twin: the vault carries compiled-in keys, so the real call would hit
/// the live API from `cargo test`/CI — keep the terminal path deterministic
/// under test; the experience row still lands with an empty lesson.
#[cfg(test)]
async fn distill_lesson(_lesson_task: &str) -> String {
    String::new()
}

/// What the deck writer produced: the short markdown pointer for the
/// deliverable text plus the deck artifact (viewer renders the file).
struct DeckSynthesis {
    note: String,
    artifact: ArtifactInfo,
}

/// The deck writer: one LLM pass turns the step outputs into slides, the
/// create-deck tool stores them, and ≤2 corrective rounds feed probe/template
/// failures back to the model. Returns `None` when synthesis is impossible
/// (no remote pool, empty materials) or the correction budget ran out — the
/// caller falls back to the default markdown deliverable.
async fn synthesize_deck(
    goal: &str,
    materials: &str,
    plan: &kawai_router::TaskPlan,
    registry: &ToolRegistry,
    session_id: i64,
    user_id: &str,
    run_span: Option<&Arc<Mutex<kawai_telemetry::TelemetrySpan>>>,
) -> Option<DeckSynthesis> {
    #[cfg(test)]
    {
        // Registry keys are compiled in — keep tests off the network and
        // deterministic; the markdown fallback path is what runs.
        let _ = (goal, materials, plan, registry);
        return None;
    }
    #[cfg(not(test))]
    {
        if materials.trim().is_empty() {
            return None;
        }
        let mut remote = remote_llm::RemoteLlm::from_env()
            .map(|r| {
                r.with_output_cap(16_000)
                    .with_agent("deck-writer")
                    // Structured JSON slides — same reasoning-burns-the-cap
                    // shape as the markdown writer.
                    .with_thinking_disabled()
                    .with_conversation(format!("kawai-session-{session_id}"))
                    .with_user(user_id)
                    .with_parent_agent("planner")
            });
        let remote = attach_span_parent(run_span, &mut remote)?;

        // Optional planner guidance: an office_create_deck step in the plan
        // may carry {filename, templateId, title} (outline intent) without
        // slides — pass it through so the writer honors the planned shape.
        let guidance: String = plan
            .steps
            .iter()
            .find(|s| {
                s.tool
                    .as_deref()
                    .is_some_and(|t| t.contains("create_deck"))
            })
            .and_then(|s| s.arguments.as_object())
            .map(|args| {
                let hints: [(&str, &str); 2] = [
                    ("filename", "Output filename"),
                    ("title", "Deck title"),
                ];
                let mut g = String::from("\n<deck-guidance>Planned deck shape:\n");
                for (key, label) in hints {
                    if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
                        g.push_str(&format!("- {label}: {v}\n"));
                    }
                }
                g.push_str("</deck-guidance>\n");
                g
            })
            .unwrap_or_default();

        let system = "You are Kawai's deck writer. A deterministic supervisor executed research/data steps \
            toward the user's goal; the SLIDE DECK is the answer. Turn the step outputs into a \
            reveal.js deck by producing ONE JSON object (no prose):\n\
            {\"filename\": \"deck-name.html\", \"title\": \"<deck title>\", \"slides\": [\"...\"]}\n\
            The template pack is assigned automatically — do NOT choose, mention, or include one.\n\
            Each slide PICKS A LAYOUT and fills its fields — you NEVER write HTML:\n\
            {\"layout\":\"title\",\"title\":…,\"kicker\":?,\"subtitle\":?}} — cover; \
            {\"layout\":\"section\",\"title\":…,\"kicker\":?}} — divider; \
            {\"layout\":\"bullets\",\"title\":…≤90 chars,\"items\":[2-6 points, EACH ≤140 chars]}} — workhorse; \
            {\"layout\":\"two-cols\",\"title\":?,\"leftTitle\":?,\"left\":[],\"rightTitle\":?,\"right\":[]}} — each entry ≤140 chars; \
            {\"layout\":\"fact\",\"big\":\"ONE number ≤14 chars\",\"caption\":\"1-140 chars\"}}; \
            {\"layout\":\"quote\",\"quote\":…≤220 chars,\"author\":?}}; \
            {\"layout\":\"table\",\"title\":…,\"headers\":[2-5 cols],\"rows\":[≤6 rows × ≤5 cols, EVERY cell ≤80 chars — abbreviate, never truncate a figure]}}; \
            {\"layout\":\"image\",\"title\":…,\"fileId\":\"<stored file id>\",\"caption\":?}}.\n\
            Use ONLY the fields listed for the chosen layout — any extra field is rejected. \
            HARD LIMITS enforced by validation — a violation rejects the WHOLE deck, so respect \
            them on the FIRST pass: titles ≤90 chars; bullets/entries/captions ≤140; table cells \
            ≤80; quotes ≤220; big numbers ≤14. Char limits are BYTES the validator counts — when \
            a string is near a limit, shorten it rather than risk rejection. Rules: ONE idea per slide; quote every number from \
            the step outputs EXACTLY — never invent or round figures; titles state the takeaway, \
            not a label; VARY the layouts — \
            never 3 same-layout slides in a row."
            .to_string();
        let mut task = format!(
            "The user's verbatim goal — the deck answers exactly this:\n{goal}\n\
             Step outputs to build the deck from:\n{materials}{guidance}"
        );

        let dispatch = registry.step_dispatch();
        let mut round = 0usize;
        loop {
            if round > 2 {
                eprintln!("[supervisor] deliverable writer: exhausted 3 synthesis rounds — falling back to raw output");
                return None;
            }
            round += 1;
            let raw = {
                let collect = async {
                    let mut stream = remote.stream(&system, &task, "").await.ok()?;
                    let mut text = String::new();
                    while let Some(event) = stream.next().await {
                        match event.ok()? {
                            remote_llm::RemoteEvent::Token { text: t } => {
                                if text.len() < 64_000 {
                                    text.push_str(&t);
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(text)
                };
                tokio::time::timeout(std::time::Duration::from_secs(300), collect)
                    .await
                    .ok()? // timeout → give up, markdown fallback
                    .filter(|t| !t.trim().is_empty())?
            };
            let Ok(mut args) =
                serde_json::from_str::<serde_json::Value>(&remote_llm::reason::extract_json(&raw))
            else {
                continue; // unparseable — next round the raw stays as-is; budget bounds this
            };
            // The writer must not try to invoke tools itself; only the deck args pass.
            if let Some(obj) = args.as_object_mut() {
                obj.retain(|k, _| {
                    matches!(k.as_str(), "filename" | "templateId" | "title" | "slides")
                });
            }
            let step = kawai_router::TaskStep {
                id: "__deck-synthesis".into(),
                tool: Some("office_create_deck".into()),
                task: "deck writer synthesis".into(),
                ..Default::default()
            };
            let step_result = dispatch(
                step,
                args,
                Vec::new(),
                tokio_util::sync::CancellationToken::new(),
                std::time::Duration::from_secs(300),
            )
            .await
            .ok()?;
            if step_result.status != kawai_router::StepStatus::Completed {
                let error = if step_result.output.is_empty() {
                    step_result
                        .error
                        .clone()
                        .unwrap_or_else(|| "tool failed".into())
                } else {
                    step_result.output.clone()
                };
                eprintln!(
                    "[supervisor] deck writer round {round}: tool error — {error}"
                );
                task.push_str(&format!(
                    "\n<deck-rejected>Your previous JSON was rejected by the deck tool:\n{error}\n\
                     Respond ONLY with the corrected deck JSON.</deck-rejected>"
                ));
                continue;
            }
            let output = step_result.output.clone();
            let parsed: serde_json::Value = serde_json::from_str(&output).unwrap_or_default();
            if parsed.get("needsRetry").is_some() {
                let instruction = parsed
                    .get("instruction")
                    .and_then(|v| v.as_str())
                    .unwrap_or("re-emit the deck JSON applying the provided style");
                task.push_str(&format!(
                    "\n<deck-style-handshake>{instruction}\n\
                     Respond ONLY with the full deck JSON again, now styled.</deck-style-handshake>"
                ));
                continue;
            }
            let file = parsed.pointer("/data/file");
            let (Some(file_id), filename) = (
                file.and_then(|f| f.get("id")).and_then(|v| v.as_str()),
                file.and_then(|f| f.get("originalName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("deck.html"),
            ) else {
                return None;
            };
            let slides = parsed
                .pointer("/data/slides")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let template = parsed
                .pointer("/data/template")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let note = format!(
                "Slide deck ready: **{filename}** — {slides} slides, template `{template}`. \
                 The deck is rendered above; the step outputs it was built from are in the reports."
            );
            return Some(DeckSynthesis {
                note,
                artifact: ArtifactInfo {
                    kind: "file".into(),
                    handle: Some(file_id.to_string()),
                    filename: Some(filename.to_string()),
                    label: Some(format!("presentation deck · {slides} slides · {template}")),
                },
            });
        }
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
    // Billing bearer from the transport edge (AGENTS.md #8) — same contract
    // as supervisor::plan_task. `None` = non-billing caller (legacy/test).
    bearer: Option<&str>,
) -> impl Stream<Item = SupervisorEvent> + Send {
    // Clone out of the borrow before the stream! block: the returned stream
    // must own its state, or `impl Stream` would have to capture the caller's
    // lifetime.
    let bearer = bearer.map(str::to_string);
    async_stream::stream! {
        // ── Fase 0a, execution side ─────────────────────────────────────────
        // The same balance gate the planner passed, enforced again here
        // because execution has an entry point that never re-enters
        // plan_task: Resume re-runs a stored plan straight through this
        // function. Fail-closed like the planner's copy (a balance that
        // cannot be read blocks exactly like an empty one) and it runs
        // BEFORE PlanStarted, so a rejected run never looks like it began.
        // Gate only — no debit here (billing is planner-token scoped today).
        if let Some(token) = &bearer {
            match crate::logic::topup::topup_balance(token).await {
                Ok(balance) if balance.tokens > 0 => {}
                Ok(_) => {
                    yield SupervisorEvent::PlanFailed {
                        error: "Token habis — isi ulang lewat Top Up".to_string(),
                    };
                    return;
                }
                Err(e) => {
                    yield SupervisorEvent::PlanFailed {
                        error: format!("balance check failed: {e}"),
                    };
                    return;
                }
            }
        }

        let step_count = plan.steps.len();
        yield SupervisorEvent::PlanStarted {
            goal: plan.goal.clone(),
            step_count,
            steps: plan_step_infos(&plan),
            plan_key: plan_key(&plan),
            summary: plan_summary_info(&plan),
        };

        // ── Telemetry: one Tempo trace per run + one workflow step per node ──
        // The run span roots the trace; every pool call inside (replan,
        // deliverable) and every scheduler step nests under it, so a run is
        // one trace from first step to deliverable (no silent gaps in Tempo).
        let telemetry_conversation = format!("kawai-session-{session_id}");
        // user.id rides every span/metric/log emitted from this run (empty
        // for legacy/test callers — telemetry drops the attr then).
        let telemetry_user = (!user_id.is_empty()).then(|| user_id.clone());
        let mut run_attrs = vec![
            (
                "kawai.goal".into(),
                preview_chars(&plan.goal, 200).to_string(),
            ),
            ("kawai.plan_key".into(), plan_key(&plan)),
            ("kawai.step_count".into(), step_count.to_string()),
            ("kawai.session_id".into(), session_id.to_string()),
        ];
        if let Some(u) = &telemetry_user {
            run_attrs.push(("user.id".into(), u.clone()));
        }
        let run_span = Arc::new(Mutex::new(kawai_telemetry::TelemetrySpan::start(
            "supervisor.run",
            run_attrs,
        )));
        // DAG edges between nodes, from the ORIGINAL plan (revised plans
        // dispatch with empty parents — acceptable, noted limitation).
        let parent_steps: HashMap<String, Vec<String>> = plan
            .steps
            .iter()
            .map(|s| (s.id.clone(), s.depends_on.clone()))
            .collect();
        let step_spans: Arc<Mutex<HashMap<String, (kawai_telemetry::TelemetrySpan, std::time::SystemTime, String)>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let confirmation_stream_id = stream_id.clone();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
        let observer: kawai_router::SchedulerObserver = {
            let run_span = run_span.clone();
            let step_spans = step_spans.clone();
            let parent_steps = parent_steps.clone();
            let conversation = telemetry_conversation.clone();
            let obs_user = telemetry_user.clone();
            Arc::new(move |event| {
                match &event {
                    kawai_router::SchedulerEvent::StepStarted { step_id, tool } => {
                        let mut span_attrs = vec![
                            ("kawai.step_id".into(), step_id.clone()),
                            ("kawai.tool".into(), tool.clone()),
                        ];
                        if let Some(u) = &obs_user {
                            span_attrs.push(("user.id".into(), u.clone()));
                        }
                        let span = run_span
                            .lock()
                            .expect("supervisor run span mutex")
                            .start_child(
                                format!("supervisor.step {tool}"),
                                span_attrs,
                            );
                        step_spans
                            .lock()
                            .expect("supervisor step spans mutex")
                            .insert(step_id.clone(), (span, std::time::SystemTime::now(), tool.clone()));
                    }
                    kawai_router::SchedulerEvent::StepCompleted { step_id, output, .. } => {
                        if let Some((mut span, started, tool)) =
                            step_spans.lock().expect("supervisor step spans mutex").remove(step_id)
                        {
                            span.set_attr("kawai.outcome", "ok");
                            finish_step_telemetry(
                                &conversation,
                                step_id,
                                &tool,
                                parent_steps.get(step_id).cloned().unwrap_or_default(),
                                started,
                                &mut span,
                                output,
                                None,
                            );
                        }
                    }
                    kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => {
                        if let Some((mut span, started, tool)) =
                            step_spans.lock().expect("supervisor step spans mutex").remove(step_id)
                        {
                            span.set_attr("kawai.outcome", "failed");
                            finish_step_telemetry(
                                &conversation,
                                step_id,
                                &tool,
                                parent_steps.get(step_id).cloned().unwrap_or_default(),
                                started,
                                &mut span,
                                "",
                                Some(error.clone()),
                            );
                        }
                    }
                    kawai_router::SchedulerEvent::StepSkipped { step_id, reason } => {
                        if let Some((mut span, started, tool)) =
                            step_spans.lock().expect("supervisor step spans mutex").remove(step_id)
                        {
                            span.set_attr("kawai.outcome", "skipped");
                            finish_step_telemetry(
                                &conversation,
                                step_id,
                                &tool,
                                parent_steps.get(step_id).cloned().unwrap_or_default(),
                                started,
                                &mut span,
                                "",
                                Some(reason.clone()),
                            );
                        }
                    }
                    _ => {}
                }
                let _ = event_tx.send(event);
            })
        };

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
            let execution = kawai_router::run_plan_scoped(
                current_plan.clone(),
                dispatch.clone(),
                limits.clone(),
                cancel.clone(),
                // Producer contracts (step id → declared artifact names):
                // bindings from contract-bearing tools resolve strictly.
                current_plan
                    .steps
                    .iter()
                    .filter_map(|s| {
                        let tool = s.dispatch_key();
                        let produces = registry.get(tool)?.produces.clone();
                        (!produces.is_empty()).then(|| (s.id.clone(), produces))
                    })
                    .collect::<kawai_router::StepContracts>(),
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
                        // Writer selection: the planner may route the final
                        // synthesis to the deck writer (finalWriter:
                        // "deck_writer"); everything else falls to the default
                        // markdown deliverable writer.
                        let chosen_writer = current_plan
                            .final_writer
                            .clone()
                            .unwrap_or_else(|| DELIVERABLE_TOOL.to_string());

                        // Collect the run's file artifacts (deck hero, stored
                        // files) — from the deck writer or from step outputs.
                        let mut run_artifacts: Vec<ArtifactInfo> = result
                            .results
                            .iter()
                            .flat_map(|r| artifact_infos(&r.output))
                            .filter(|a| a.kind == "file")
                            .collect();

                        let (synthesized, deck_artifact) = if chosen_writer == WRITER_DECK {
                            yield SupervisorEvent::StepStarted {
                                step_id: DELIVERABLE_STEP_ID.into(),
                                tool: WRITER_DECK.into(),
                            };
                            let materials = synthesis_materials(&current_plan, &result);
                            let synthesis_goal = user_goal
                                .clone()
                                .unwrap_or_else(|| current_plan.goal.clone());
                            let deck = synthesize_deck(
                                &synthesis_goal,
                                &materials,
                                &current_plan,
                                &registry,
                                session_id,
                                &user_id,
                                Some(&run_span),
                            )
                            .await;
                            match deck {
                                Some(s) => (Some(s.note), Some(s.artifact)),
                                None => {
                                    eprintln!(
                                        "[supervisor] deck writer unavailable — falling back to markdown deliverable"
                                    );
                                    (None, None)
                                }
                            }
                        } else {
                            (None, None)
                        };

                        // The scheduler's `final_output` is the LAST tool's raw
                        // output (e.g. 26k chars of extracted PDF text) — not an
                        // answer. One synthesis call turns the per-step results
                        // into the user-facing reply; on failure (no remote, all
                        // providers down) fall back to the raw output verbatim.
                        // The synthesis is a VISIBLE step (stepStarted/completed
                        // for the virtual writer agent) — invisible
                        // work reads as magic and breaks the workbench's trust
                        // contract.
                        if chosen_writer != WRITER_DECK {
                            yield SupervisorEvent::StepStarted {
                                step_id: DELIVERABLE_STEP_ID.into(),
                                tool: DELIVERABLE_TOOL.into(),
                            };
                        }
                        let raw_final = result.final_output().map(String::from);
                        let mut materials = synthesis_materials(&current_plan, &result);
                        // Charts the run produced — the writer may embed them
                        // via kawai-file:// tokens (rendered by the viewer,
                        // rasterized into pdf/docx exports).
                        let run_charts = collect_run_charts(&result);
                        materials.push_str(&charts_material_block(&run_charts));
                        let synthesis_goal = user_goal
                            .clone()
                            .unwrap_or_else(|| current_plan.goal.clone());
                        // Deck path already produced the answer text — skip the
                        // markdown writer entirely (one synthesis, not two).
                        let writer_tool: &str = if deck_artifact.is_some() {
                            WRITER_DECK
                        } else {
                            DELIVERABLE_TOOL
                        };
                        let mut dl_attrs = vec![("kawai.step_id".into(), DELIVERABLE_STEP_ID.into())];
                        if let Some(u) = &telemetry_user {
                            dl_attrs.push(("user.id".into(), u.clone()));
                        }
                        let mut dl_span = run_span
                            .lock()
                            .expect("supervisor run span mutex")
                            .start_child(
                                &format!("supervisor.{writer_tool}"),
                                dl_attrs,
                            );
                        let dl_started = std::time::SystemTime::now();
                        let synthesized = if deck_artifact.is_some() {
                            synthesized // the deck writer's note
                        } else {
                            synthesize_final_answer(
                                &synthesis_goal,
                                &materials,
                                session_id,
                                &user_id,
                                Some(&run_span),
                            )
                            .await
                        };
                        {
                            let (trace_id, span_id) = dl_span.context_ids();
                            dl_span.set_attr(
                                "kawai.outcome",
                                if synthesized.is_some() { "ok" } else { "fallback" },
                            );
                            dl_span.end();
                            kawai_telemetry::record_workflow_step(kawai_telemetry::WorkflowStepRecord {
                                conversation_id: telemetry_conversation.clone(),
                                step_name: format!("{writer_tool}:{DELIVERABLE_STEP_ID}"),
                                framework: "kawai-supervisor".into(),
                                started_at: dl_started,
                                completed_at: std::time::SystemTime::now(),
                                input_state: serde_json::json!({
                                    "goal": preview_chars(&synthesis_goal, 500),
                                    "steps": current_plan.steps.len(),
                                }),
                                output_state: serde_json::json!({
                                    "chars": synthesized.as_deref().map(|w| w.chars().count())
                                        .or_else(|| raw_final.as_deref().map(|w| w.chars().count()))
                                        .unwrap_or(0),
                                }),
                                error: synthesized.is_none().then(|| "synthesis unavailable — raw output fallback".into()),
                                tags: vec![("tool".into(), writer_tool.into())],
                                linked_generation_ids: kawai_telemetry::last_generation_id(
                                    &telemetry_conversation,
                                    writer_tool,
                                )
                                .into_iter()
                                .collect(),
                                parent_step_ids: parent_steps
                                    .keys()
                                    .cloned()
                                    .collect::<Vec<_>>(),
                                agent_name: "kawai-supervisor".into(),
                                agent_version: env!("CARGO_PKG_VERSION").into(),
                                trace_span: Some((trace_id, span_id)),
                            });
                        }
                        if let Some(answer) = &synthesized {
                            tracing::info!(component = "supervisor", user_id = %user_id, chars = answer.chars().count(), "synthesis completed");
                        } else {
                            eprintln!("[supervisor] synthesis unavailable — falling back to raw final output");
                        }
                        let written = synthesized
                            .map(|text| strip_unknown_chart_tokens(&text, &run_charts))
                            .or_else(|| raw_final.clone());
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
                                        tool: writer_tool.into(),
                                        args_key: "deliverable".into(),
                                        step_id: DELIVERABLE_STEP_ID.into(),
                                        output: written.clone(),
                                        artifacts_json: "[]".into(),
                                    },
                                )
                                .await;
                            }
                        }
                        if let Some(artifact) = &deck_artifact {
                            run_artifacts.push(artifact.clone());
                        }
                        yield SupervisorEvent::StepCompleted {
                            step_id: DELIVERABLE_STEP_ID.into(),
                            output: written
                                .as_deref()
                                .map(|o| preview_chars(o, STEP_EVENT_OUTPUT_MAX_CHARS).to_string())
                                .unwrap_or_default(),
                            artifacts: deck_artifact.clone().into_iter().collect(),
                            retries_used: 0,
                        };
                        // ── Agent experience (PLAN-personal-context §2.2) ──
                        // One distilled row per completed run: tools used,
                        // outcome, and (best-effort, cloud tier) a one-line
                        // lesson. The lesson is SKIPPED silently when no
                        // cloud provider is configured — the row still lands.
                        if !user_id.is_empty() {
                            let exp_tools: Vec<String> = current_plan
                                .steps
                                .iter()
                                .map(|s| s.tool.clone().unwrap_or_else(|| s.agent_id.clone()))
                                .filter(|t| !t.is_empty())
                                .collect();
                            let exp_outcome = if result.failures().is_empty() {
                                "success"
                            } else {
                                "partial"
                            };
                            let exp_tags: Vec<String> = exp_tools.iter().cloned().collect();
                            let lesson_task = format!(
                                "Goal: {}\nTools used in order: {}\nOutcome: {}. \
                                 In ONE sentence (max 40 words), state the single most useful \
                                 takeaway for a future run of a similar task — what worked or \
                                 what to do differently. No preamble.",
                                preview_chars(&current_plan.goal, 300),
                                exp_tools.join(", "),
                                exp_outcome,
                            );
                            let lesson = distill_lesson(&lesson_task).await;
                            if let Err(e) = kawai_agent::experience_record(
                                &user_id,
                                AUTO_AGENT_ID,
                                session_id,
                                &preview_chars(&current_plan.goal, 300).to_string(),
                                &lesson,
                                &exp_tools,
                                exp_outcome,
                                &exp_tags,
                            )
                            .await
                            {
                                eprintln!("[supervisor] experience record failed: {e:?}");
                            }
                        }
                        yield SupervisorEvent::PlanCompleted {
                            final_output: written,
                            artifacts: run_artifacts,
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
                            match revise_plan(
                                &current_plan.goal,
                                &current_plan,
                                &reason,
                                &result,
                                &registry,
                                session_id,
                                &user_id,
                                Some(&run_span),
                            )
                            .await
                            {
                                Ok(revised) => {
                                    let count = revised.steps.len();
                                    // A revision without an explicit finalWriter
                                    // keeps the original plan's writer choice.
                                    let mut revised = revised;
                                    if revised.final_writer.is_none() {
                                        revised.final_writer = current_plan.final_writer.clone();
                                    }
                                    yield SupervisorEvent::PlanRevised {
                                        attempt: replan_attempt,
                                        step_count: count,
                                        steps: plan_step_infos(&revised),
                                        plan_key: plan_key(&revised),
                                        summary: plan_summary_info(&revised),
                                    };
                                    current_plan = revised;
                                    continue 'plans;
                                }
                                Err(e) => {
                                    let error = format!(
                                        "{}; replan (attempt {replan_attempt}) failed: {e}",
                                        reason
                                    );
                                    eprintln!("[supervisor] PlanFailed: {error}");
                                    yield SupervisorEvent::PlanFailed {
                                        error,
                                    };
                                    break;
                                }
                            }
                        }
                    }
                    let error = result.failures().into_iter().map(|f| {
                        format!("step '{}' failed: {}", f.step_id, f.error.as_deref().unwrap_or("unknown"))
                    }).collect::<Vec<_>>().join("; ");
                    eprintln!("[supervisor] PlanFailed: {error}");
                    yield SupervisorEvent::PlanFailed {
                        error,
                    };
                    break;
                }
                Err(e) => {
                    eprintln!("[supervisor] PlanFailed: {e}");
                    yield SupervisorEvent::PlanFailed {
                        error: e.to_string(),
                    };
                    break;
                }
            }
        }
        // Close the run trace — every step span and pool call nested under it.
        if cancel.is_cancelled() {
            run_span
                .lock()
                .expect("supervisor run span mutex")
                .set_attr("kawai.outcome", "cancelled");
        }
        run_span
            .lock()
            .expect("supervisor run span mutex")
            .end();
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
    fn audit_dataflow_counts_legacy_refs_and_collisions() {
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![
                // Legacy: fromStep nested inside arguments.
                TaskStep {
                    id: "legacy".into(),
                    agent_id: "t".into(),
                    arguments: serde_json::json!({"fileId": {"fromStep": "x", "output": "y"}}),
                    ..Default::default()
                },
                // Collision: "fileId" bound in inputs AND present in arguments.
                TaskStep {
                    id: "clash".into(),
                    agent_id: "t".into(),
                    arguments: serde_json::json!({"fileId": "f_literal"}),
                    inputs: serde_json::json!({"fileId": {"fromStep": "legacy", "output": "y"}}),
                    ..Default::default()
                },
                // Clean: binding without a colliding literal.
                TaskStep {
                    id: "clean".into(),
                    agent_id: "t".into(),
                    inputs: serde_json::json!({"other": {"fromStep": "legacy", "output": "z"}}),
                    ..Default::default()
                },
            ],
            final_writer: None,
            summary: None,
        };
        let (legacy, collisions) = audit_dataflow(&plan);
        assert_eq!(legacy, 1, "one legacy ref");
        assert_eq!(collisions, 1, "one collision");
    }

    #[test]
    fn repair_hints_flags_cli_run_attachment_read() {
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![TaskStep {
                id: "s1".into(),
                agent_id: "t".into(),
                tool: Some("cli_run".into()),
                ..Default::default()
            }],
            final_writer: None,
            summary: None,
        };
        let failed = |error: &str| kawai_router::StepResult {
            step_id: "s1".into(),
            agent_id: "t".into(),
            status: kawai_router::StepStatus::Failed,
            output: String::new(),
            artifacts: Vec::new(),
            error: Some(error.into()),
            error_kind: kawai_router::FailureKind::Tool,
            retries_used: 0,
        };
        let spawn_miss = kawai_router::ExecutionResult {
            results: vec![failed("`cat` failed: exit code -1 in 2 ms. stderr: spawn failed: No such file or directory (os error 2)")],
        };
        let out = repair_hints(&plan, &spawn_miss);
        assert!(out.contains("<repair-hints>"), "{out}");
        assert!(out.contains("knowledge_search"), "{out}");
        // A different cli_run failure (not a filesystem miss) gets no hint.
        let timeout = kawai_router::ExecutionResult {
            results: vec![failed("`sleep` failed: step deadline exceeded")],
        };
        assert!(repair_hints(&plan, &timeout).is_empty());
        // A filesystem miss on a NON-cli_run tool gets no hint.
        let mut plan2 = plan.clone();
        plan2.steps[0].tool = Some("office_read_document".into());
        let out2 = repair_hints(&plan2, &spawn_miss);
        assert!(out2.is_empty(), "{out2}");
    }
    #[test]
    fn repair_materials_shows_bindings_and_contracts() {
        use std::collections::HashMap;
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![
                TaskStep {
                    id: "list".into(),
                    agent_id: "t".into(),
                    tool: Some("office_list_files".into()),
                    ..Default::default()
                },
                TaskStep {
                    id: "read".into(),
                    agent_id: "t".into(),
                    tool: Some("office_read_document".into()),
                    inputs: serde_json::json!({"fileId": {"fromStep": "list", "output": "files"}}),
                    ..Default::default()
                },
            ],
            final_writer: None,
            summary: None,
        };
        let result = kawai_router::ExecutionResult { results: vec![] };
        let mut contracts = HashMap::new();
        contracts.insert("office_list_files".to_string(), vec!["files".to_string()]);
        let out = repair_materials(&plan, &result, &Default::default(), &contracts);
        assert!(out.contains("consumes:"), "{out}");
        assert!(out.contains("fileId \u{2190} list.files"), "{out}");
        assert!(out.contains("tool contract: files"), "{out}");
    }

    #[test]
    fn repair_revised_plan_json_injects_missing_goal() {
        let raw = r#"{"steps": [{"id": "s1", "task": "t", "tool": "x"}]}"#;
        let out = repair_revised_plan_json(raw, "original goal");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["goal"], "original goal");
        assert_eq!(v["steps"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn repair_revised_plan_json_wraps_bare_array() {
        let out = repair_revised_plan_json(
            r#"[{"id": "s1", "task": "t", "tool": "x"}]"#,
            "original goal",
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["goal"], "original goal");
        assert!(v["steps"].is_array());
    }

    #[test]
    fn repair_revised_plan_json_keeps_existing_goal_and_non_json() {
        let with_goal = r#"{"goal": "mine", "steps": []}"#;
        let out = repair_revised_plan_json(with_goal, "other");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["goal"], "mine"); // existing goal preserved
        assert_eq!(repair_revised_plan_json("no json at all", "g"), "no json at all");
    }

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
            render_planner_context(
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new()
            ),
            ""
        );
        let out = render_planner_context(
            "<persona>likes dark UIs</persona>".into(),
            String::new(),
            "<skills>pdf skill</skills>".into(),
            String::new(),
            String::new(),
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
            String::new(),
            String::new(),
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
            produces: vec![],
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

    /// Tiering validator: a cli_run step whose command is on the audited
    /// safe read-only list stays prompt-free; anything else (including an
    /// absent/unknown command) gets confirmation FORCED on, whatever the
    /// planner authored.
    #[test]
    fn cli_run_confirmation_tiering() {
        let dispatch: ToolDispatch = Arc::new(|_| {
            Box::pin(async {
                Ok(kawai_router::StepResult {
                    step_id: String::new(),
                    agent_id: String::new(),
                    status: StepStatus::Completed,
                    output: String::new(),
                    artifacts: Vec::new(),
                    error: None,
                    retries_used: 0,
                    error_kind: kawai_router::FailureKind::Other,
                })
            })
        });
        let mut registry = ToolRegistry::new(dispatch);
        registry.register(ToolMeta {
            name: "cli_run".into(),
            kind: ToolKind::Pure,
            description: "test".into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            produces: vec![],
            requires_confirmation: false,
        });

        let mk_step = |id: &str, command: &str, flag: bool| TaskStep {
            id: id.into(),
            agent_id: "cli_run".into(),
            tool: Some("cli_run".into()),
            task: format!("task {id}"),
            requires_confirmation: Some(flag),
            arguments: serde_json::json!({ "command": command }),
            ..Default::default()
        };

        let mk_plan = |step: TaskStep| kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![step],
            final_writer: None,
            summary: None,
        };

        // Read-only grep authored WITHOUT the flag → stays prompt-free…
        let mut plan = mk_plan(mk_step("s1", "grep", false));
        enforce_cli_run_confirmation_tiering(&mut plan);
        assert_eq!(plan.steps[0].requires_confirmation, Some(false));

        // Mutating ffmpeg authored WITHOUT the flag → forced on.
        let mut plan = mk_plan(mk_step("s2", "ffmpeg", false));
        enforce_cli_run_confirmation_tiering(&mut plan);
        assert_eq!(plan.steps[0].requires_confirmation, Some(true));

        // Absent command (malformed step) → treated as unsafe.
        let mut plan = mk_plan(mk_step("s3", "", false));
        enforce_cli_run_confirmation_tiering(&mut plan);
        assert_eq!(plan.steps[0].requires_confirmation, Some(true));
    }

    #[test]
    fn frozen_step_drift_is_restored_not_rejected() {
        // The reviser routinely embellishes or drops frozen steps (observed
        // live 2026: it added a `limit` argument to a completed step, twice).
        // The mandate is enforced mechanically — restore, don't reject — so
        // the reviser's legitimate work on repairable steps survives.
        let mk = |id: &str, args: serde_json::Value| TaskStep {
            id: id.into(),
            agent_id: "a".into(),
            task: format!("do {id}"),
            arguments: args,
            ..Default::default()
        };
        let original = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![
                mk("s1", serde_json::json!({})),
                mk("s2", serde_json::json!({"q": "x"})),
                mk("s3", serde_json::json!({})),
                mk("s4", serde_json::json!({})),
            ],
            final_writer: None,
            summary: None,
        };
        // s2 failed; s3 depends on s2 → both repairable. s1 (root) and s4
        // (depends only on s1) are frozen.
        let mut repairable = std::collections::HashSet::new();
        repairable.insert("s2".to_string());
        repairable.insert("s3".to_string());

        let mut revised = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![
                // Frozen s1 mutated (planner-invented argument)…
                mk("s1", serde_json::json!({"limit": 20})),
                // Repairable s2/s3 legitimately rewritten…
                mk("s2", serde_json::json!({"q": "fixed"})),
                mk("s3", serde_json::json!({"q": "also fixed"})),
                // …and frozen s4 dropped entirely.
            ],
            final_writer: None,
            summary: None,
        };

        let restored = restore_frozen_steps(&mut revised, &original, &repairable);
        assert_eq!(restored, vec!["s1".to_string(), "s4".to_string()]);
        assert_eq!(revised.steps[0].arguments, serde_json::json!({}));
        assert_eq!(
            revised
                .steps
                .iter()
                .find(|s| s.id == "s2")
                .unwrap()
                .arguments,
            serde_json::json!({"q": "fixed"}),
            "the reviser's fix on a repairable step must survive"
        );
        assert_eq!(
            revised
                .steps
                .iter()
                .find(|s| s.id == "s3")
                .unwrap()
                .arguments,
            serde_json::json!({"q": "also fixed"}),
        );
        assert!(
            revised.steps.iter().any(|s| s.id == "s4"),
            "dropped frozen step re-inserted"
        );
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
            final_writer: None,
            summary: None,
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
            // 5s headroom per event: under test the terminal path is
            // local-only (the experience-distiller call is gated off), so
            // this bounds SQLite contention with the parallel tests that
            // share the per-user data dir.
            let ev = tokio::time::timeout(std::time::Duration::from_secs(5), stream.as_mut().next())
                .await
                .expect("stream stalled after approval");
            match ev {
                Some(SupervisorEvent::StepStarted { step_id, .. }) if step_id == DELIVERABLE_STEP_ID => {}
                Some(SupervisorEvent::StepCompleted { step_id, .. }) if step_id == DELIVERABLE_STEP_ID => {}
                Some(SupervisorEvent::StepStarted { step_id, .. }) => assert_eq!(step_id, "s1"),
                Some(SupervisorEvent::StepCompleted { step_id, .. }) => assert_eq!(step_id, "s1"),
                Some(SupervisorEvent::PlanCompleted { final_output, .. }) => {
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
            final_writer: None,
            summary: None,
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
            final_writer: None,
            summary: None,
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

    #[test]
    fn stringified_whole_output_blob_coerced_to_file_id() {
        // The resolver's last-resort whole-output fallback can hand the
        // consumer the producer's SERIALIZED envelope (session 4 regression:
        // data_schema received the entire office_list_files JSON as fileId).
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let blob = serde_json::to_string(&json!({
            "data": {"files": [
                {"id": "f89462861576850000-0001", "ext": "xlsx", "originalName": "Dukcapil Backtest.xlsx"},
                {"id": "f89462144956843000-0000", "ext": "png", "originalName": "pasted-image.png"}
            ]},
            "ok": true,
            "summary": "2 files listed"
        }))
        .unwrap();
        let args = json!({"fileId": blob});
        let out = coerce_resolved_args("data_schema", &args, Some(&schema));
        assert_eq!(out["fileId"], "f89462861576850000-0001");
    }

    #[test]
    fn handle_artifact_value_unwrapped_to_id() {
        // Named-output path: ${s1.files} hits the files Handle artifact →
        // resolve_args returns {"type":"handle","value":…,"kind":"files"}.
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let args = json!({"fileId": {"type": "handle", "value": "f1", "kind": "files"}});
        let out = coerce_resolved_args("data_schema", &args, Some(&schema));
        assert_eq!(out["fileId"], "f1");
    }
}

#[cfg(test)]
mod produces_contracts_tests {
    /// The contract now lives AT the tool (AgentTool::produces →
    /// ToolDefinition.produces), beside the code that produces the output —
    /// guarded by the office/analytics crates' own contract tests. The
    /// supervisor only forwards it (see tool_meta_from_definition).
    #[test]
    fn contracts_are_declared_at_the_tool() {
        let def = kawai_tools::ToolDefinition {
            name: "t".into(),
            description: "t".into(),
            parameters: serde_json::json!({}),
            requires_confirmation: false,
            produces: vec!["file".into()],
        };
        let meta = super::tool_meta_from_definition(&def);
        assert_eq!(meta.produces, vec!["file".to_string()]);
    }
}
