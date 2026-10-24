//! Supervisor entry point: registry builder and streaming execution.
//!
//! Translates the existing per-agent `ToolSet` catalog into a flat
//! [`kawai_router::ToolRegistry`] so the deterministic scheduler can
//! dispatch steps directly against the application's tool implementations.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use futures_core::Stream;
use futures_util::StreamExt;
use kawai_router::{ToolCall, ToolDispatch, ToolKind, ToolMeta, ToolRegistry};
use kawai_events::{ArtifactInfo, PlanInputBinding, PlanStepInfo, SupervisorEvent};

use crate::agent_registry;

// ── Events ──────────────────────────────────────────────────────────────────


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
/// The goal text the ROUTER sees: the inner `<user-goal>` body when the
/// frontend wrapped the goal in a `<previous-deliverable>` quote envelope,
/// else the goal verbatim. The envelope's excerpt is arbitrary prior-run
/// text — its dates and month words must never reach slot extraction or the
/// keyword gate.
fn routing_goal(goal: &str) -> &str {
    match (goal.find("<user-goal>"), goal.find("</user-goal>")) {
        (Some(start), Some(end)) if end > start => goal[start + "<user-goal>".len()..end].trim(),
        _ => goal,
    }
}

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


// ── Registry builder ────────────────────────────────────────────────────────

/// Universal execution mode: the plan is built and dispatched against the
/// merged catalog of every available domain toolset. Explicit agent ids
/// remain as an optional narrowing hint.
pub const AUTO_AGENT_ID: &str = "auto";

/// Echo tool for statically-authored plans (`direct_greeting`,
/// `direct_identity`): `plan_task` pre-bakes the localized reply into the
/// step arguments, this tool surfaces it as the step output, and
/// `WRITER_RAW` promotes that output to the final answer — no planner
/// rounds, no LLM call. Never planner-visible: it rides no domain toolset,
/// the Turso catalog, or `PLAN_CORE_TOOLS` — the merged Auto toolset below
/// is its only registration.
#[derive(Default)]
pub struct DirectReplyTool;

/// Arguments of [`DirectReplyTool`].
#[derive(Debug, serde::Deserialize)]
pub struct DirectReplyArgs {
    /// The pre-authored reply text, delivered verbatim.
    pub text: String,
}

/// Failure type — the echo cannot fail, but the trait requires the
/// associated type.
#[derive(Debug)]
pub struct DirectReplyError;

impl std::fmt::Display for DirectReplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "direct_reply echo failed")
    }
}

impl std::error::Error for DirectReplyError {}

impl kawai_tools::AgentTool for DirectReplyTool {
    const NAME: &'static str = "direct_reply";
    type Args = DirectReplyArgs;
    type Output = String;
    type Error = DirectReplyError;

    fn description(&self) -> String {
        "Returns the pre-authored reply text verbatim.".into()
    }

    fn parameters(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The pre-authored reply text."}
            },
            "required": ["text"]
        })
    }

    fn call(
        &self,
        arguments: Self::Args,
    ) -> impl Future<Output = Result<Self::Output, Self::Error>> + Send {
        std::future::ready(Ok(arguments.text))
    }
}

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
    let accounting = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "litert")]
        { agent_registry::accounting_tools_for_supervisor(&context, remote_configured) }
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
                agent_registry::composio_tools_for_supervisor(&context, remote_configured),
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
            accounting(),
            generated(),
        ]
            .into_iter()
            .flatten() {
            match &mut merged {
                Some(base) => base.merge(&mut { set }),
                None => merged = Some(set),
            }
        }
        // Static replies (greetings, identity questions) dispatch this tool
        // even on a bare build with no domain toolset — this merged Auto set
        // is the tool's only registration.
        match &mut merged {
            Some(base) => base.add_tool(DirectReplyTool),
            None => {
                let mut set = kawai_tools::ToolSet::default();
                set.add_tool(DirectReplyTool);
                merged = Some(set);
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
        agent_registry::ACCOUNTING_AGENT_ID => accounting(),
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
    environment_block: String,
) -> String {
    if persona_block.is_empty()
        && memories_block.is_empty()
        && skills_block.is_empty()
        && attached_files_block.is_empty()
        && experiences_block.is_empty()
        && profile_block.is_empty()
        && environment_block.is_empty()
    {
        return String::new();
    }
    let mut out = String::from("<user-context>\nBackground about the user and this run's inputs. Ground decisions in it when relevant; ignore it when not.\n");
    for block in [
        environment_block,
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

/// The `<environment>` planner-context block: the device's IANA timezone and
/// the user's current local time, computed FRESH on every plan — never stored
/// (it is a property of the moment, not of the user; travel changes it).
/// Best-effort: an unavailable timezone degrades to an empty block.
fn planner_environment_block() -> String {
    let tz = iana_time_zone::get_timezone().unwrap_or_default();
    if tz.is_empty() {
        return String::new();
    }
    let now = chrono::Local::now();
    format!(
        "<environment>Local time for the user: {} ({}). Timezone: {}.</environment>",
        now.format("%Y-%m-%d %H:%M (%A)"),
        now.format("UTC%:z"),
        tz,
    )
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
///
/// The pre-authored reply for a statically-classified goal, localized.
/// `indonesian` comes from `resolve_user_language` naming Bahasa Indonesia;
/// everything else falls back to English.
fn static_reply_text(
    intent: kawai_router::StaticIntent,
    thanks: bool,
    indonesian: bool,
) -> String {
    match intent {
        kawai_router::StaticIntent::Greeting if thanks => {
            if indonesian {
                "Sama-sama! 😊 Senang bisa membantu. Ada lagi yang ingin Anda kerjakan?".into()
            } else {
                "You're welcome! 😊 Happy to help. Anything else you'd like to work on?".into()
            }
        }
        kawai_router::StaticIntent::Greeting => {
            if indonesian {
                "Halo! 👋 Senang bertemu Anda. Saya Kawai, asisten kerja Anda — saya bisa membantu analisis saham & crypto, audit portofolio futures, rangkum video YouTube, tutup buku akunting, dan olah dokumen/PDF. Mau mulai dari mana?".into()
            } else {
                "Hi! 👋 Great to meet you. I'm Kawai, your work assistant — I can analyze stocks & crypto, audit your futures portfolio, summarize YouTube videos, close your books, and work on documents/PDFs. Where would you like to start?".into()
            }
        }
        kawai_router::StaticIntent::Identity => {
            if indonesian {
                "Saya Kawai — asisten kerja Anda di aplikasi Kawai. Saya bisa membantu: analisis saham & crypto (research desk, screener), audit & performa trading, rangkuman YouTube, akunting (tutup buku, laporan keuangan), serta pengolahan dokumen & PDF. Tulis saja tujuan Anda di composer — saya yang menyusun langkah-langkahnya.".into()
            } else {
                "I'm Kawai — your work assistant in the Kawai app. I can help with: stock & crypto analysis (research desk, screener), portfolio audit & trading performance, YouTube summaries, accounting (book close, financial reports), and document & PDF work. Just type your goal in the composer and I'll plan the steps.".into()
            }
        }
    }
}

/// The one-step plan behind a statically-authored reply: the pre-baked text
/// rides the `direct_reply` step arguments, `WRITER_RAW` makes that output
/// the final answer (no synthesis call), and the template stamp carries the
/// intent class for the review card, telemetry, and `registry_kind_for_plan`
/// (a non-`desk` stamp resolves to the Auto registry, where the tool lives).
/// No per-run nonce: the reply text is constant, so a repeated plan_key can
/// only replay the identical output.
fn static_reply_plan(
    goal: &str,
    intent: kawai_router::StaticIntent,
    thanks: bool,
    indonesian: bool,
) -> kawai_router::TaskPlan {
    let reply = static_reply_text(intent, thanks, indonesian);
    let (task, overview) = match intent {
        kawai_router::StaticIntent::Greeting => (
            "Balas sapaan pengguna",
            "Balasan instan untuk sapaan — tanpa perencanaan.",
        ),
        kawai_router::StaticIntent::Identity => (
            "Memperkenalkan asisten",
            "Perkenalan asisten dan kemampuan utamanya — tanpa perencanaan.",
        ),
    };
    kawai_router::TaskPlan {
        goal: goal.to_string(),
        steps: vec![kawai_router::TaskStep {
            id: "reply".into(),
            agent_id: AUTO_AGENT_ID.into(),
            tool: Some(<DirectReplyTool as kawai_tools::AgentTool>::NAME.into()),
            task: task.into(),
            arguments: serde_json::json!({ "text": reply }),
            ..Default::default()
        }],
        final_writer: Some(WRITER_RAW.to_string()),
        summary: Some(kawai_router::PlanSummary {
            overview: overview.into(),
            actions: vec![],
            outputs: vec![],
        }),
        template: Some(intent.label().to_string()),
    }
}

/// `language` is the device locale tag from the transport edge (e.g.
/// "id-ID") — it only feeds the template path (`resolve_user_language`), so a
/// composer-routed desk run renders its reports in the user's language
/// exactly like the fixed-pipeline form does.
/// Slot values the rule gate's own fact extraction supplies — shared by the
/// layer-1 claim arm and the Laya fast-claim so both resolve identically
/// (the universe-matched member, period/venue verbatim, output language).
fn facts_slots(
    facts: &kawai_router::GoalFacts,
    universe: Option<&kawai_router::MarketUniverse>,
    language: Option<&str>,
) -> kawai_router::ResolvedSlots {
    let mut slots = kawai_router::ResolvedSlots::new();
    let ticker = facts
        .candidates
        .iter()
        .find(|c| universe.is_some_and(|u| u.contains(*c)))
        .cloned();
    if let Some(ticker) = ticker.as_deref().or(facts.ticker.as_deref()) {
        slots.set("ticker", ticker);
    }
    if let Some(url) = &facts.url {
        slots.set("url", url);
    }
    if let Some(period) = &facts.period {
        slots.set("period", period);
    }
    if let Some(venue) = &facts.venue {
        slots.set("venue", venue);
    }
    slots.set("language", &resolve_user_language(language, None).unwrap_or_default());
    slots
}

#[allow(clippy::too_many_arguments)]
pub async fn plan_task(
    user_id: &str,
    session_id: i64,
    goal: &str,
    bearer: Option<&str>,
    language: Option<&str>,
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
    // non-billing contexts (dev probes, headless examples). This read-only
    // gate is the client's only billing involvement — usage itself is
    // debited server-side by the recap cron from telemetry (`user.id`).
    if let Some(token) = bearer {
        match crate::logic::topup::topup_balance(token).await {
            Ok(balance) if balance.tokens > 0 => {}
            Ok(_) => return Err("Token habis — isi ulang lewat Top Up".to_string()),
            Err(e) => return Err(format!("balance check failed: {e}")),
        }
    }

    // ── Template routing — layer 1, 1.5, 2 (PLAN-template-routing.md §2.5) ─
    //
    // Layer 1 (deterministic, this block): the keyword gate claims goals it
    // is SURE about and skips the planner entirely. Three deliberate
    // refusals, all falling through to layer 1.5, layer 2 or the planner:
    // - Follow-ups whose user-goal carries no complete pipeline spec — a
    //   vague "lanjutkan" has no keyword/period, so the keyword gate
    //   declines it (routing happens on the clean `<user-goal>` text, never
    //   the quote envelope).
    // - Required slots the goal does not carry — never a user-facing prompt.
    // - `build` errors (a template that cannot build must never fail the
    //   submit).
    //
    // Layer 1.5 (between the match and layer 2, `laya_router.rs`): an
    // on-device zero-shot classifier (~250 ms) that may fast-claim a
    // registered template on the grey band — only when the rule-extracted
    // facts already fill every required slot (the classifier cannot extract
    // one), through the same build + confirmation machinery, logged
    // route_log source="laya". Assets auto-download on first grey-band goal;
    // absent ⇒ clean no-op and layer 2 runs unchanged.
    //
    // Layer 2 (below the match): when layer 1's decision is `plan` — the
    // grey band — one small LLM call re-validates the decision with real
    // language understanding (micron → MU, "Bank BRI" is IDX). Rust still
    // owns execution: the claim must be a registered template with a ticker
    // the exchange itself lists, else planner. `direct` decisions are NOT
    // re-validated (a short tool-free goal answered from memory should not
    // pay an LLM call to be told it might be research).
    //
    // The remote pool serves this resolver AND the planner (the planner
    // handle keeps the tight 4k output cap — the 2026-02 benchmark showed
    // 14.6k output tokens = the whole 250 s latency). Built before the gate;
    // the not-configured error stays at the planner stage so a
    // template-routed goal still resolves on a no-vault build.
    let remote_pool = remote_llm::RemoteLlm::from_env();

    // Route on the USER'S goal, not the quoted envelope: the
    // `<previous-deliverable>` excerpt is arbitrary prior-run text — a date
    // or month word inside it would poison the period slot, and skipping the
    // rule router for quoted goals sent every post-first-run chip submit
    // (Monthly Close, Trading Performance) to the planner instead of its
    // template. A vague follow-up ("lanjutkan") carries no template keyword
    // in its user-goal and still falls through to the planner.
    let routing = routing_goal(goal);
    // The layer-2 resolver is a real LLM call — its usage must survive
    // whichever way it decides (claimed template ⇒ returned; declined or
    // fall-through ⇒ folded into the planner's usage below).
    let mut resolver_usage = remote_llm::RemoteUsage::default();
    {
        let universe = usdm_universe_cached().await;
        let decision = kawai_router::route_goal(routing, universe.as_ref(), &crate::templates::registry());
        // (chosen, template_id, source, routed plan key). The actual insert
        // is awaited once below — a sync closure calling the async writer
        // would drop the future unawaited and silently lose the row (caught
        // by the routing-gate test).
        let mut logged: Option<(&'static str, Option<&'static str>, &'static str, Option<String>)> =
            None;
        let mut grey_band = false;
        let facts = kawai_router::extract_facts(routing);
        match &decision.route {
            kawai_router::Route::Template(template) => {
                let slots = facts_slots(&facts, universe.as_ref(), language);
                match (template.build)(&slots) {
                    Ok(mut plan) => {
                        // The registry is authoritative for write tools: the
                        // template step never carries the flag itself, and
                        // the scheduler reads ONLY the step flag — without
                        // this, a routed plan would dispatch
                        // venue_fills_import (a write) with no gate.
                        registry.enforce_confirmation_policy(&mut plan);
                        plan.template = Some(template.id.to_string());
                        let key = plan_key(&plan);
                        on_progress(SupervisorEvent::PlanningStarted {});
                        tracing::info!(
                            component = "supervisor",
                            template = template.id,
                            goal_chars = goal.len(),
                            "routed to template — planner skipped"
                        );
                        kawai_db::log_route_decision(
                            user_id,
                            kawai_db::RouteLogEntry {
                                session_id,
                                plan_key: Some(key.as_str()),
                                goal,
                                chosen: "template",
                                template_id: Some(template.id),
                                source: "rule",
                                offered: &serde_json::to_string(&decision.offered)
                                    .unwrap_or_default(),
                                matched: &serde_json::to_string(&decision.matched)
                                    .unwrap_or_default(),
                                blocked_by_slots: &serde_json::to_string(
                                    &decision.blocked_by_slots,
                                )
                                .unwrap_or_default(),
                            },
                        )
                        .await;
                        return Ok((plan, remote_llm::RemoteUsage::default()));
                    }
                    Err(e) => {
                        // A template whose builder cannot run must not fail
                        // the submit — the planner takes over — but the
                        // reason must be searchable, not a local stderr line
                        // (AGENTS.md: `eprintln!` never reaches Grafana). The
                        // paired `route_log` row carries source="fallback";
                        // this warn carries WHY.
                        tracing::warn!(
                            component = "supervisor",
                            template = template.id,
                            error = %e,
                            "template build failed — falling back to the planner"
                        );
                        eprintln!(
                            "[supervisor] template {} build failed ({e}) — falling back to the planner",
                            template.id
                        );
                        logged = Some(("plan", None, "fallback", None));
                    }
                }
            }
            kawai_router::Route::Direct => {
                // Statically-authored replies: a goal whose every token is
                // greeting or self-identity vocabulary cannot name a subject,
                // a ticker, or a tool — there is nothing to route on — so it
                // is answered with a pre-written localized text: no planner
                // rounds, no LLM call, review gate still applies. Anything
                // else (a greeting carrying content, an unmatched prefix) is
                // only logged and the planner runs.
                if let Some(intent) = kawai_router::static_reply_intent(routing) {
                    let indonesian =
                        resolve_user_language(language, None).as_deref() == Some("Bahasa Indonesia");
                    let mut plan = static_reply_plan(
                        routing,
                        intent,
                        kawai_router::static_reply_is_thanks(routing),
                        indonesian,
                    );
                    registry.enforce_confirmation_policy(&mut plan);
                    let key = plan_key(&plan);
                    on_progress(SupervisorEvent::PlanningStarted {});
                    tracing::info!(
                        component = "supervisor",
                        intent = intent.label(),
                        goal_chars = goal.len(),
                        "static reply — planner skipped"
                    );
                    kawai_db::log_route_decision(
                        user_id,
                        kawai_db::RouteLogEntry {
                            session_id,
                            plan_key: Some(key.as_str()),
                            goal,
                            chosen: intent.label(),
                            template_id: None,
                            source: "rule",
                            offered: &serde_json::to_string(&decision.offered)
                                .unwrap_or_default(),
                            matched: &serde_json::to_string(&decision.matched)
                                .unwrap_or_default(),
                            blocked_by_slots: &serde_json::to_string(&decision.blocked_by_slots)
                                .unwrap_or_default(),
                        },
                    )
                    .await;
                    return Ok((plan, remote_llm::RemoteUsage::default()));
                }
                // Reserved: a tool-free goal answered in one writer step. The
                // composer path does not route here yet (Direct skips tool
                // discovery entirely — see TOOL_FREE_INTENTS), so a Direct
                // decision is recorded and the planner runs.
                logged = Some(("direct", None, "rule", None));
            }
            kawai_router::Route::Plan => {
                // Grey band — layer 2 decides below.
                logged = None;
                grey_band = true;
            }
        }

        // ── Layer 1.5: Laya zero-shot fast claim ───────────────────────────
        //
        // On the grey band one ~250 ms on-device forward pass either names a
        // registered template — short-circuiting the layer-2 LLM resolver
        // call below — or declines and layer 2 runs exactly as before.
        // Constraints that keep a fast claim as safe as a resolver claim:
        // - It can only claim when the rule-extracted facts ALREADY fill
        //   every required slot (`missing_required`): the classifier names a
        //   pipeline, it cannot extract a period or a ticker, and a
        //   default-filled slot would build a plausible-but-wrong plan.
        // - The claim passes the same `build` + `enforce_confirmation_policy`
        //   machinery and lands in `route_log` with source="laya".
        // - Greeting/question/direct goals never reach here (static layers
        //   run first — the PoC measured Laya mis-claiming questions at 0.96
        //   confidence; those guards are code, not model).
        // Optional capability: the assets are NOT bundled — a build without
        // `~/.kawai/models/laya/multilingual` (or `<app_data>/models/…`)
        // never loads the gate and this block is a clean no-op.
        {
            if !crate::laya_router::assets_ready() {
                // Assets absent: the gate stays a no-op here. The first-use
                // download is kicked once at app startup (Tauri shell setup),
                // NOT per goal — a plan_task/test invocation must never
                // trigger a 679 MB download.
            } else {
                let templates = crate::templates::registry();
                let gate_goal = goal.to_string();
                // The gate may NEVER fail the submit: a panic inside the
                // classifier degrades to "no claim" and layer 2 runs.
                let laya_claim = match tokio::task::spawn_blocking(move || {
                    crate::laya_router::claim(&gate_goal, &templates)
                })
                .await
                {
                    Ok(claim) => claim,
                    Err(e) => {
                        tracing::warn!(
                            component = "supervisor",
                            error = %e,
                            "laya gate panicked — skipping to layer 2"
                        );
                        None
                    }
                };
                if let Some((template_id, confidence)) = laya_claim {
                    if let Some(template) = crate::templates::registry().get(&template_id) {
                        let slots = facts_slots(&facts, universe.as_ref(), language);
                        let missing = slots.missing_required(template.slots);
                        if missing.is_empty() {
                            match (template.build)(&slots) {
                                Ok(mut plan) => {
                                    registry.enforce_confirmation_policy(&mut plan);
                                    plan.template = Some(template.id.to_string());
                                    let key = plan_key(&plan);
                                    on_progress(SupervisorEvent::PlanningStarted {});
                                    tracing::info!(
                                        component = "supervisor",
                                        template = template.id,
                                        confidence = %confidence,
                                        goal_chars = goal.len(),
                                        "laya fast claim routed to template — resolver and planner skipped"
                                    );
                                    kawai_db::log_route_decision(
                                        user_id,
                                        kawai_db::RouteLogEntry {
                                            session_id,
                                            plan_key: Some(key.as_str()),
                                            goal,
                                            chosen: "template",
                                            template_id: Some(template.id),
                                            source: "laya",
                                            offered: &serde_json::to_string(&decision.offered)
                                                .unwrap_or_default(),
                                            matched: &serde_json::to_string(&decision.matched)
                                                .unwrap_or_default(),
                                            blocked_by_slots: &serde_json::to_string(
                                                &decision.blocked_by_slots,
                                            )
                                            .unwrap_or_default(),
                                        },
                                    )
                                    .await;
                                    return Ok((plan, resolver_usage));
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        component = "supervisor",
                                        template = template.id,
                                        error = %e,
                                        "laya claim build failed — layer 2"
                                    );
                                }
                            }
                        } else {
                            tracing::info!(
                                component = "supervisor",
                                template = template.id,
                                confidence = %confidence,
                                ?missing,
                                "laya claim missing required slots — layer 2"
                            );
                        }
                    }
                }
            }
        }

        // ── Layer 2: LLM re-validation of planner decisions ────────────────
        // The keyword gate is a precision instrument — it claims only what
        // its vocabulary is sure about. Everything else (micron → MU,
        // phrasings outside the keyword list) lands here, and one small LLM
        // call decides with real language understanding whether a registered
        // pipeline should run. Rust still owns execution: the claim must
        // name a registered template whose ticker the exchange itself lists.
        // `direct` goals skip this entirely (see the layer-1 arm).
        if grey_band && decision.route == kawai_router::Route::Plan {
            if let Some(pool) = remote_pool.as_ref() {
                let (claim, r_usage) =
                    llm_route_resolve(pool, goal, &crate::templates::registry()).await;
                // The resolver is a real LLM call — its tokens survive every
                // outcome: a template claim returns them, every fall-through
                // to the planner folds them in below.
                resolver_usage = r_usage;
                match claim {
                    Some((template_id, ticker)) => {
                        if let Some(template) = crate::templates::registry().get(&template_id) {
                            let member = ticker
                                .to_uppercase()
                                .split_whitespace()
                                .next()
                                .map(str::to_string);
                            let listed = member.as_deref().is_some_and(|t| {
                                universe.as_ref().is_some_and(|u| {
                                    u.symbols.contains(t)
                                        // Equity intent resolves ONLY to the
                                        // tokenized-equity subset — the BANK
                                        // meme coin is not the bank.
                                        && (!facts.equity_intent || u.equities.contains(t))
                                })
                            });
                            if listed {
                                let mut slots = kawai_router::ResolvedSlots::new();
                                if let Some(t) = member.as_deref() {
                                    slots.set("ticker", t);
                                }
                                slots.set(
                                    "language",
                                    &resolve_user_language(language, None).unwrap_or_default(),
                                );
                                match (template.build)(&slots) {
                                    Ok(mut plan) => {
                                        plan.template = Some(template.id.to_string());
                                        let key = plan_key(&plan);
                                        on_progress(SupervisorEvent::PlanningStarted {});
                                        tracing::info!(
                                            component = "supervisor",
                                            template = template.id,
                                            ticker = member.as_deref().unwrap_or(""),
                                            "layer-2 LLM resolution routed to template — planner skipped"
                                        );
                                        kawai_db::log_route_decision(
                                            user_id,
                                            kawai_db::RouteLogEntry {
                                                session_id,
                                                plan_key: Some(key.as_str()),
                                                goal,
                                                chosen: "template",
                                                template_id: Some(template.id),
                                                source: "llm",
                                                offered: &serde_json::to_string(
                                                    &decision.offered,
                                                )
                                                .unwrap_or_default(),
                                                matched: &serde_json::to_string(
                                                    &decision.matched,
                                                )
                                                .unwrap_or_default(),
                                                blocked_by_slots: &serde_json::to_string(
                                                    &decision.blocked_by_slots,
                                                )
                                                .unwrap_or_default(),
                                            },
                                        )
                                        .await;
                                        return Ok((plan, r_usage));
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            component = "supervisor",
                                            "layer-2 claim {} build failed ({e}) — planner",
                                            template.id
                                        );
                                    }
                                }
                            } else {
                                tracing::warn!(
                                    component = "supervisor",
                                    "layer-2 claim {} ticker {ticker:?} is not listed — planner",
                                    template.id
                                );
                            }
                        } else {
                            tracing::warn!(
                                component = "supervisor",
                                "layer-2 claimed unknown template {template_id:?} — planner"
                            );
                        }
                    }
                    None => {
                        // The resolver saw the goal and said "no pipeline" —
                        // that is a decision, logged as one (its tokens are
                        // already folded into `resolver_usage` above).
                        grey_band = false;
                        logged = Some(("plan", None, "llm", None));
                    }
                }
            }
        }

        if let Some((chosen, template_id, source, plan_key)) = logged {
            kawai_db::log_route_decision(
                user_id,
                kawai_db::RouteLogEntry {
                    session_id,
                    plan_key: plan_key.as_deref(),
                    goal,
                    chosen,
                    template_id,
                    source,
                    offered: &serde_json::to_string(&decision.offered).unwrap_or_default(),
                    matched: &serde_json::to_string(&decision.matched).unwrap_or_default(),
                    blocked_by_slots: &serde_json::to_string(&decision.blocked_by_slots)
                        .unwrap_or_default(),
                },
            )
            .await;
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
        planner_environment_block(),
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
    // Composio actions prefetched at plan time (toolkits the goal names) —
    // feeds both the `<composio-actions>` materials block and the post-parse
    // slug validation. `None` = no prefetch; the runtime 404 guidance stays
    // the safety net.
    let mut composio_index: Option<
        std::collections::HashMap<String, Vec<composio::ToolInfo>>,
    > = None;
    let mut seen: std::collections::HashSet<String> = core_tools.iter().cloned().collect();
    let mut usage = remote_llm::RemoteUsage::default();
    // The layer-2 resolver ran before the planner — its tokens belong to
    // this turn's usage too.
    usage.input_tokens += resolver_usage.input_tokens;
    usage.output_tokens += resolver_usage.output_tokens;
    let mut searches_used = 0usize;
    let mut repairs_used = 0usize;
    let mut calls = 0usize;
    // Rolling reasoning buffer + throttle for PlanningActivity — the UI gets
    // a trailing preview of the planner's thinking at most every 800 ms.
    let mut reasoning_tail = String::new();
    let mut last_activity: std::time::Instant;

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
                        // Lazy prefetch: the planner can write composio steps
                        // WITHOUT a search round — tool names leak in via the
                        // <experiences> block (observed live: a run planned
                        // composio_list_tools + composio_execute with zero
                        // searches, so the prefetch hook in the search branch
                        // never fired and the gates had no index). If the plan
                        // touches composio and we hold no index, fetch one NOW
                        // so the gates below still apply.
                        if composio_index.is_none()
                            && plan.steps.iter().any(|s| {
                                matches!(
                                    s.tool.as_deref(),
                                    Some("composio_execute") | Some("composio_list_tools")
                                )
                            })
                        {
                            match composio_prefetch(goal).await {
                                Some((prefetch_block, index)) => {
                                    eprintln!(
                                        "[plan_task] composio prefetch (lazy): {} toolkit(s) [{}] injected",
                                        index.len(),
                                        {
                                            let mut names: Vec<String> =
                                                index.keys().cloned().collect();
                                            names.sort();
                                            names.join(", ")
                                        }
                                    );
                                    materials.push_str(&prefetch_block);
                                    composio_index = Some(index);
                                }
                                None => {}
                            }
                        }
                        // Plan-time slug gate: a composio_execute step whose
                        // action slug is not in the prefetched toolkit list is
                        // rejected NOW (cheap corrective round, no wasted
                        // execution) instead of 404ing at runtime.
                        let mut gate_rejection: Option<String> =
                            composio_slug_rejection(&plan, composio_index.as_ref());
                        // …and a composio_list_tools step for an already-
                        // prefetched toolkit is a wasted round-trip: the
                        // complete list is in the planner's context.
                        if gate_rejection.is_none() {
                            gate_rejection = composio_discovery_rejection(
                                &plan,
                                composio_index.as_ref(),
                            );
                        }
                        if let Some(rejection) = gate_rejection {
                            eprintln!(
                                "[plan_task] plan rejected (composio gate): {rejection}"
                            );
                            if repairs_used < 2 {
                                repairs_used += 1;
                                materials.push_str(&format!(
                                    "\n<plan-rejected>\n{rejection}\nRespond ONLY with the \
                                     corrected plan JSON, copying the slug EXACTLY from the \
                                     <composio-actions> block above.</plan-rejected>\n"
                                ));
                                continue;
                            }
                            return Err(format!("plan validation failed: {rejection}"));
                        }
                        // Usage is debited server-side: the local recap
                        // cron reads token counters from Grafana telemetry
                        // (`user.id` attribution) and posts deltas to the
                        // worker — the client never debits
                        // (PLAN-qris-topup.md §15).
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
                            let suggestions = suggest_tools(registry, &plan_err.to_string());
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
                        tools: found.clone(),
                    });
                    // The goal touches Composio: prefetch real action slugs
                    // for the toolkits it names so the planner never has to
                    // guess one (invented slugs cost a 404 + repair round).
                    if found
                        .iter()
                        .any(|t| t == "composio_execute" || t == "composio_list_tools")
                    {
                        match composio_prefetch(goal).await {
                            Some((prefetch_block, index)) => {
                                eprintln!(
                                    "[plan_task] composio prefetch: {} toolkit(s) [{}] injected",
                                    index.len(),
                                    {
                                        let mut names: Vec<String> =
                                            index.keys().cloned().collect();
                                        names.sort();
                                        names.join(", ")
                                    }
                                );
                                materials.push_str(&prefetch_block);
                                composio_index = Some(index);
                            }
                            None => {}
                        }
                    }
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

/// Shared planner/reviser prompt block: the side-effect confirmation rule
/// and the cli_run read-only carve-out (identical contract in both prompts).
const CONFIRMATION_PROMPT_RULES: &str = "- Side-effect tools MUST set \"requiresConfirmation\": true with a short \"confirmationDescription\".\
  \n- For cli_run steps: read-only commands (ls, cat, grep, jq, du, …) run\
  \n  WITHOUT user approval — set \"requiresConfirmation\": false for those.\
  \n  Everything else that can mutate (ffmpeg, mv-class, installs, network\
  \n  fetches) REQUIRES \"requiresConfirmation\": true, and the\
  \n  confirmationDescription is what the user approves: state the concrete\
  \n  goal (e.g. \"convert input.mov to h264 mp4 under 20MB\"), not just\
  \n  \"run ffmpeg\". The validator enforces this: a non-read-only cli_run step\
  \n  without the flag is rejected. The binary is fixed at confirmation; the\
  \n  tool's translator may only vary that binary's arguments, under a static\
  \n  policy that blocks inline code and second-program execution.";

pub fn parse_supervisor_plan(raw: &str, registry: &ToolRegistry) -> Result<kawai_router::TaskPlan, SupervisorError> {
    parse_supervisor_plan_scoped(raw, registry, &[])
}

/// Errors surfaced by the supervisor's plan/registry/step-read paths.
/// Transports render via `Display`; the plan-repair loop matches on the
/// parse variants to decide corrective rounds.
#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    /// Planner/reviser output could not be parsed into a valid plan
    /// (JSON extraction, schema validation, dataflow binding).
    #[error("invalid plan: {0}")]
    PlanParse(String),
    /// A step names a tool forbidden in this planning phase.
    #[error("step \"{step}\" uses forbidden tool \"{tool}\" in this planning phase")]
    ForbiddenTool { step: String, tool: String },
    /// No persisted output exists for the requested step.
    #[error("no persisted output for step '{0}'")]
    StepNotFound(String),
    /// Persistence layer failure while reading step results.
    #[error("supervisor step results read failed: {0}")]
    Db(#[from] kawai_db::DbError),
    /// No domain builder produced a toolset for the requested agent.
    #[error("no supervisor toolset available for agent '{0}'")]
    NoToolset(String),
    /// Bug-shaped failure that is not caller-fixable (e.g. serializing a
    /// locally-constructed struct).
    #[error("internal error: {0}")]
    Internal(String),
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
            tracing::warn!(
                component = "supervisor",
                "plan-quality: step \"{}\" uses a legacy fromStep reference inside arguments — move it to \"inputs\" (deprecated wiring)",
                step.id
            );
        }
        if let (Some(args), Some(bindings)) = (step.arguments.as_object(), step.inputs.as_object()) {
            for key in bindings.keys() {
                if args.contains_key(key) {
                    collisions += 1;
                    tracing::warn!(
                        component = "supervisor",
                        "plan-quality: step \"{}\": argument \"{key}\" is OVERRIDDEN by an inputs binding — the literal value in arguments is discarded",
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
) -> Result<kawai_router::TaskPlan, SupervisorError> {
    let slice = kawai_router::extract_json_slice(raw)
        .map_err(|e| SupervisorError::PlanParse(e.to_string()))?;
    let mut plan: kawai_router::TaskPlan = serde_json::from_str(slice)
        .map_err(|e| SupervisorError::PlanParse(format!("deserialization failed: {e}")))?;
    // Explicit dataflow bindings ("inputs"): shape + target checks, and each
    // binding implies its dependency — the planner can never desynchronize
    // dependsOn from the dataflow it declared.
    kawai_router::bind_dataflow(&mut plan)
        .map_err(|e| SupervisorError::PlanParse(e.to_string()))?;
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
            return Err(SupervisorError::ForbiddenTool {
                step: step.id.clone(),
                tool: tool.clone(),
            });
        }
    }
    registry.enforce_confirmation_policy(&mut plan);
    enforce_cli_run_confirmation_tiering(&mut plan);
    registry
        .validate_plan(&plan)
        .map_err(|e| SupervisorError::PlanParse(e.to_string()))?;
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
            tracing::warn!(
                component = "tool-catalog",
                "sync exceeded {sync_timeout:?} — continuing in background"
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
            tracing::warn!(
                component = "tool-catalog",
                "replica STALE ({local} vs {remote} on remote) — retrying sync"
            );
            let _ = tokio::time::timeout(sync_timeout, catalog.sync()).await;
            catalog.sync_detached(); // never leave a dropped sync behind
            *LAST_SYNC_AT.lock().unwrap() = Some(std::time::Instant::now());
            match catalog.row_counts(&cfg).await {
                Ok((local, remote)) if local < remote => tracing::error!(
                    component = "tool-catalog",
                    "CRITICAL: replica still stale after retry \
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
/// Desktop-only: the only caller is the tauri shell's setup hook.
#[cfg(feature = "desktop")]
pub fn prefetch_tool_catalog() {
    tauri::async_runtime::spawn(async {
        if shared_catalog().await.is_none() {
            return;
        }
        for _ in 1..=5 {
            sync_shared_catalog(std::time::Duration::from_secs(60)).await;
            let Some(catalog) = shared_catalog().await else { return };
            let Some(cfg) = kawai_tool_catalog::RemoteConfig::from_env() else { return };
            match catalog.row_counts(&cfg).await {
                Ok((local, remote)) if local >= remote => break, // converged
                Ok((local, remote)) => {
                    tracing::warn!(
                        component = "tool-catalog",
                        "prefetch: replica still stale ({local} vs {remote}), retrying"
                    );
                }
                Err(e) => {
                    tracing::error!(component = "tool-catalog", "prefetch count check failed: {e}");
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
            tracing::error!(
                component = "tool-catalog",
                "local replica is EMPTY (sync failed or the shared catalog \
                 is unseeded) — planner restricted to core tools; re-seed with \
                 `--example seed_tool_catalog --features litert,binance,monad` using the \
                 ADMIN token (KAWAI_TURSO_WRITE_TOKEN); verify with \
                 `--example tool_catalog_drift_check` on the data_read client token"
            );
            None
        }
        Err(e) => {
            tracing::error!(component = "tool-catalog", "replica unreadable: {e}");
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
{confirmation_rules}
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
        confirmation_rules = CONFIRMATION_PROMPT_RULES,
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
{confirmation_rules}
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
        catalog,
        confirmation_rules = CONFIRMATION_PROMPT_RULES,
    )
}

/// Plan-time Composio action prefetch — real slugs in front of the planner
/// (`composio::plan_index`). Best-effort on every failure: no API key, no
/// toolkit explicitly named in the goal, or a failed fetch simply yields
/// `None` and the runtime discovery path stays the safety net.
async fn composio_prefetch(
    goal: &str,
) -> Option<(
    String,
    std::collections::HashMap<String, Vec<composio::ToolInfo>>,
)> {
    let key = kawai_constants::composio::get_composio_api_key();
    if key.trim().is_empty() {
        return None;
    }
    let toolkits = composio::plan_index::toolkits_in_text(goal);
    if toolkits.is_empty() {
        return None;
    }
    let client = composio::ComposioClient::new(key);
    let index = composio::plan_index::fetch_toolkits(&client, &toolkits).await;
    if index.is_empty() {
        return None;
    }
    Some((
        composio::plan_index::render_materials_block(&index),
        index,
    ))
}

/// Reject a plan whose `composio_execute` steps name a slug outside the
/// prefetched toolkit lists. Only prefetched toolkits constrain — an absent
/// toolkit means no prefetch happened, and the runtime 404 guidance applies.
fn composio_slug_rejection(
    plan: &kawai_router::TaskPlan,
    index: Option<&std::collections::HashMap<String, Vec<composio::ToolInfo>>>,
) -> Option<String> {
    let index = index?;
    for step in &plan.steps {
        let Some(tool) = step.tool.as_deref() else {
            continue;
        };
        if tool != "composio_execute" {
            continue;
        }
        let Some(slug) = step.arguments.get("tool").and_then(|t| t.as_str()) else {
            continue;
        };
        let toolkit = slug.split('_').next().unwrap_or("").to_ascii_lowercase();
        if toolkit.is_empty() {
            continue;
        }
        if let Err(msg) = composio::plan_index::validate_slug(&toolkit, slug, index) {
            return Some(format!("step \"{}\": {msg}", step.id));
        }
    }
    None
}

/// Reject a `composio_list_tools` step whose toolkit is already covered by
/// the prefetched index — the `<composio-actions>` block in the planner's
/// context already lists those actions, so a discovery step is a wasted
/// round-trip (observed live: the planner still planned one because the
/// composio_execute description says "discover first"). Uncovered toolkits
/// are legitimate discovery and pass.
fn composio_discovery_rejection(
    plan: &kawai_router::TaskPlan,
    index: Option<&std::collections::HashMap<String, Vec<composio::ToolInfo>>>,
) -> Option<String> {
    let index = index?;
    for step in &plan.steps {
        let Some(tool) = step.tool.as_deref() else {
            continue;
        };
        let toolkit_arg = step.arguments.get("toolkit").and_then(|t| t.as_str());
        if let Err(msg) = composio::plan_index::validate_no_discovery_step(tool, toolkit_arg, index)
        {
            return Some(format!("step \"{}\": {msg}", step.id));
        }
    }
    None
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
    let vecs = match embedder.embed_primary(kawai_embedding::EmbedRole::Query, queries.to_vec()).await {
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
pub async fn narrow_registry_for_goal(
    user_id: &str,
    registry: &ToolRegistry,
    goal: &str,
) -> Option<ToolRegistry> {
    narrow_registry_for_goal_with(user_id, registry, goal, NARROW_MIN_TOOLS, NARROW_TOP_K).await
}

/// Parametrized variant of [`narrow_registry_for_goal`] (inspection/test
/// seam): `min_tools` is the activation threshold, `top_k` the admitted set.
pub async fn narrow_registry_for_goal_with(
    user_id: &str,
    registry: &ToolRegistry,
    goal: &str,
    min_tools: usize,
    top_k: usize,
) -> Option<ToolRegistry> {
    if registry.len() <= min_tools {
        return None;
    }
    let _cfg = kawai_tool_catalog::RemoteConfig::from_env()?;
    let model = kawai_embedding::build_providers_from_env(user_id);
    let query_vec = model
        .embed_strings(kawai_embedding::EmbedRole::Query, vec![goal.to_string()])
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
///
/// `requires_confirmation` is REGISTRY-DERIVED: `enforce_confirmation_policy`
/// flips it on at execution time, after the registry was built with its own
/// `plan_key`. Hashing the raw flag made one run produce two keys (step rows
/// under the pre-enforcement key, the deliverable under the post-enforcement
/// one), so the key is computed over a copy with that field cleared — the
/// same plan yields the same key before and after enforcement.
pub fn plan_key(plan: &kawai_router::TaskPlan) -> String {
    use sha2::Digest;
    let mut normalized = plan.clone();
    for step in &mut normalized.steps {
        step.requires_confirmation = None;
    }
    let serialized = serde_json::to_string(&normalized)
        .expect("plan serialization must not fail (all TaskPlan fields are infallible)");
    let hash = sha2::Sha256::digest(serialized.as_bytes());
    hex::encode(hash)
}

/// Resolve the output language for the FIXED pipelines (Analysis Desk,
/// YouTube Summary) from the transport edge — same edge-resolution invariant
/// as identity (AGENTS.md #8): the frontend never decides prompt semantics,
/// it only reports the device locale.
///
/// `explicit` is the raw `navigator.language` tag the client sent (e.g.
/// "id-ID"); `accept_language` is the raw `Accept-Language` header value
/// (web fallback, e.g. "id-ID,id;q=0.9,en;q=0.8"). The primary subtag maps
/// to a display name from the SAME fixed menu the deliverable viewer's
/// translate picker carries (`TRANSLATE_LANGUAGES`), so a later translate of
/// the deliverable names the language identically.
///
/// English and unknown subtags return `None` = the pipelines' default
/// content-language behavior, byte-identical to pre-language runs. `zh`
/// maps to Simplified Chinese (the menu carries no Traditional variant).
pub fn resolve_user_language(
    explicit: Option<&str>,
    accept_language: Option<&str>,
) -> Option<String> {
    let tag = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            accept_language
                .map(str::trim)
                .filter(|s| !s.is_empty())
                // First entry wins; strip any q-weight ("id;q=0.9").
                .and_then(|al| al.split(',').next())
                .and_then(|tag| tag.split(';').next())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })?;
    let subtag = tag.split(['-', '_']).next()?.to_ascii_lowercase();
    let name = match subtag.as_str() {
        "en" => return None,
        "id" => "Bahasa Indonesia",
        "ja" => "Japanese",
        "ko" => "Korean",
        "zh" => "Simplified Chinese",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "pt" => "Portuguese",
        "ru" => "Russian",
        "ar" => "Arabic",
        "hi" => "Hindi",
        _ => return None,
    };
    Some(name.to_string())
}

/// Scope a CLIENT-SUPPLIED goal with the resolved output language.
///
/// Fixed pipelines compose their own rule into the goal they hand the writer
/// (`desk_user_goal`, `screener_user_goal`, the accounting plan builders, …).
/// A planner-driven or template-routed goal is the user's own text, so without
/// this the deliverable writer answered in English no matter the locale — the
/// `language` argument stopped at the plan and never reached the report.
///
/// The marker check keeps it idempotent: a goal that already carries a rule is
/// left untouched, so two instructions never stack (a resume re-runs the same
/// goal, and the fixed-pipeline goals already carry theirs).
pub fn goal_in_language(goal: String, language: Option<&str>) -> String {
    let language = language.map(str::trim).unwrap_or_default();
    if language.is_empty() || goal.contains("LANGUAGE: Write your ENTIRE report in") {
        return goal;
    }
    format!(
        "{goal}\n\nLANGUAGE: Write your ENTIRE report in {language}. Keep numbers, tickers, \
         tool labels and quoted tool output verbatim."
    )
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
) -> Result<String, SupervisorError> {
    let rows = kawai_db::list_supervisor_step_results(user_id, session_id, plan_key).await?;
    if let Some(r) = rows.into_iter().rev().find(|r| r.step_id == step_id) {
        return Ok(r.output);
    }
    let fallback = kawai_db::list_supervisor_step_results_by_session(user_id, session_id, 200).await?;
    fallback
        .into_iter()
        .find(|r| r.step_id == step_id)
        .map(|r| r.output)
        .ok_or_else(|| SupervisorError::StepNotFound(step_id.to_string()))
}

pub async fn build_supervisor_registry(
    user_id: &str,
    session_id: i64,
    agent_id: &str,
    plan_key: &str,
) -> Result<ToolRegistry, SupervisorError> {
    let toolset = build_supervisor_toolset(user_id, session_id, agent_id)
        .await
        .ok_or_else(|| SupervisorError::NoToolset(agent_id.to_string()))?;

    build_registry_from_toolset(user_id, session_id, toolset, plan_key).await
}

/// Which execution registry a plan needs. Template-stamped plans dispatch
/// their pipeline's own stage tools (`desk_role` et al.), which the merged
/// supervisor catalog deliberately does NOT carry — a template plan against
/// the supervisor registry dies at `validate_plan` with `UnknownTool` before
/// the first wave even starts.
///
/// Pure and exhaustive-by-default: an unknown template id degrades to `Auto`
/// (the plan validation then reports the unknown tool, which is the honest
/// failure) — it can only happen if a writer stamps an id that is not in
/// [`crate::templates::TEMPLATES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanRegistryKind {
    /// A registered fixed pipeline — its own stage tool rides the registry.
    Template,
    /// The merged supervisor catalog (planner-authored plans, and templates
    /// whose tools live in the merged catalog).
    Auto,
}

pub fn registry_kind_for_plan(plan: &kawai_router::TaskPlan) -> PlanRegistryKind {
    match plan.template.as_deref() {
        Some(id) if crate::templates::TEMPLATES.iter().any(|t| t.id == id) => {
            // Pipeline dispatch tools live outside the merged catalog today
            // (desk_role). A future template whose tools DO ride the merged
            // catalog would map to `Auto` here.
            match id {
                "desk" => PlanRegistryKind::Template,
                _ => PlanRegistryKind::Auto,
            }
        }
        _ => PlanRegistryKind::Auto,
    }
}

/// The registry a plan executes against — the ONE selection point both
/// transports share (`execute_supervisor_plan` command + Axum handler). The
/// plan carries the hint (`TaskPlan.template`); the LLM planner cannot set
/// it, so template registries are unreachable from planner-authored plans.
pub async fn build_registry_for_plan(
    user_id: &str,
    session_id: i64,
    plan: &kawai_router::TaskPlan,
) -> Result<ToolRegistry, SupervisorError> {
    match registry_kind_for_plan(plan) {
        PlanRegistryKind::Template => {
            build_desk_registry(user_id, session_id, &plan_key(plan)).await
        }
        PlanRegistryKind::Auto => {
            build_supervisor_registry(user_id, session_id, AUTO_AGENT_ID, &plan_key(plan)).await
        }
    }
}

// ── Template symbol-universe eligibility (PLAN-template-routing.md) ─────────

type UniverseCell = std::sync::RwLock<Option<(std::time::Instant, kawai_router::MarketUniverse)>>;

#[cfg(feature = "binance")]
use binance::UsdmListing;
#[cfg(not(feature = "binance"))]
#[derive(Clone)]
struct UsdmListing {
    symbol: String,
    base: Option<String>,
    equity: bool,
}

/// The market's authoritative symbol set for market-bound templates, cached
/// process-wide with a daily refresh (listings change rarely; a stale set
/// only mis-prices a brand-new listing for a day). The FETCH is the source —
/// `binance::usdm_symbols`, the exchange's own listing, zero curation.
/// Unavailable (offline/fetch failure/no binance feature) ⇒ the cached set is
/// empty ⇒ market-bound templates fail CLOSED (never claim; the planner is
/// the always-valid fallback). The cache/seed are unconditional so the
/// routing tests run on every feature set.
static USDM_UNIVERSE: std::sync::LazyLock<UniverseCell> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

const UNIVERSE_TTL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

async fn usdm_universe_cached() -> Option<kawai_router::MarketUniverse> {
    let lock = &*USDM_UNIVERSE;
    {
        let guard = lock.read().expect("universe lock");
        if let Some((fetched, set)) = guard.as_ref() {
            if fetched.elapsed() < UNIVERSE_TTL {
                return Some(set.clone());
            }
        }
    }
    #[cfg(feature = "binance")]
    let fresh = binance::usdm_symbols().await.ok()?;
    #[cfg(not(feature = "binance"))]
    // No market module ⇒ no instruments ⇒ an empty listing that can never
    // match (fail-closed), not `None`-forever — same semantics, testable.
    let fresh: Vec<UsdmListing> = Vec::new();
    // Two views of one listing: membership (every symbol + base) and the
    // EQUITY subset (tokenized stocks) — equity-intent goals must resolve
    // there, so `analisis saham Bank BRI` cannot land on the BANK meme coin.
    let mut u = kawai_router::MarketUniverse::default();
    for l in fresh {
        u.symbols.insert(l.symbol.clone());
        if let Some(base) = &l.base {
            u.symbols.insert(base.clone());
        }
        if l.equity {
            u.equities.insert(l.symbol.clone());
            if let Some(base) = &l.base {
                u.equities.insert(base.clone());
            }
        }
    }
    let mut guard = lock.write().expect("universe lock");
    *guard = Some((std::time::Instant::now(), u.clone()));
    Some(u)
}

/// Layer-2 route resolver (PLAN-template-routing.md §2.5): one small
/// completion that decides — with real language understanding — whether a
/// grey-band goal matches a registered pipeline, resolving company names to
/// exchange symbols on the way ("micron" → MU). Output is FORCED JSON and
/// capped: this call must never approach a planner round's cost.
///
/// Returns `(template_id, ticker)` or `None` ("no pipeline") / unparseable
/// (treated the same — planner). Validation is NOT this function's job: the
/// caller checks registration, universe membership, and build.
const ROUTER_RESOLVER_PROMPT: &str = "\
You are a task router. Decide whether the user's goal requests one of the \
registered pipelines, and if so resolve its subject to an exchange symbol.\n\
Respond with ONLY minified JSON, no prose, no markdown:\n\
{\"template\":\"<pipeline-id or null>\",\"ticker\":\"<SYMBOL or null>\"}\n\
Rules:\n\
- Resolve company/product names to their exchange ticker (micron → MU, \
nvidia → NVDA, bitcoin → BTC). Uppercase, no exchange suffix.\n\
- ticker must be null when template is null.\n\
- A question, chat, translation, or anything that is not a request to run a \
research/analysis pipeline ⇒ {\"template\":null,\"ticker\":null}.";

async fn llm_route_resolve(
    pool: &remote_llm::RemoteLlm,
    goal: &str,
    registry: &kawai_router::TemplateRegistry<'_>,
) -> (Option<(String, String)>, remote_llm::RemoteUsage) {
    let mut menu = registry.menu_lines();
    menu.push_str(
        "\nEach pipeline's subject is an exchange symbol; the market is \
         Binance USDⓈ-M futures (crypto and tokenized stocks/ETFs).",
    );
    let owned: remote_llm::RemoteLlm = pool.clone();
    let resolver = owned
        .with_output_cap(160)
        .with_agent("route-resolver")
        .with_thinking_disabled();
    let mut stream = match resolver.stream(ROUTER_RESOLVER_PROMPT, goal, &menu).await {
        Ok(s) => s,
        Err(_) => return (None, remote_llm::RemoteUsage::default()),
    };
    let mut text = String::new();
    let mut usage = remote_llm::RemoteUsage::default();
    while let Some(ev) = stream.next().await {
        let Ok(ev) = ev else { break };
        match ev {
            remote_llm::RemoteEvent::Token { text: t } => {
                if text.len() <= 400 {
                    text.push_str(&t);
                }
                // Over the cap: stop appending but KEEP draining — `Done`
                // carries this call's real usage and must not be dropped.
            }
            remote_llm::RemoteEvent::Done { usage: u, .. } => {
                usage.input_tokens += u.input_tokens;
                usage.output_tokens += u.output_tokens;
                break;
            }
            _ => {}
        }
    }
    (parse_router_claim(&text), usage)
}

/// Parse the resolver's output into a `(template_id, ticker)` claim.
/// Pure — unit-tested. Accepts fenced JSON and prose-wrapped JSON via the
/// shared extractor; anything else is `None` (planner).
fn parse_router_claim(text: &str) -> Option<(String, String)> {
    let json = kawai_router::extract_json_slice(text).ok()?;
    #[derive(serde::Deserialize)]
    struct Claim {
        template: Option<String>,
        ticker: Option<String>,
    }
    let claim: Claim = serde_json::from_slice(json.as_bytes()).ok()?;
    let template = claim.template?.trim().to_string();
    if template.is_empty() {
        return None;
    }
    let ticker = claim.ticker.unwrap_or_default().trim().to_uppercase();
    if ticker.is_empty() {
        return None;
    }
    Some((template, ticker))
}

/// Read-only view of the cached universe — the eval harness routes goals
/// through the SAME eligibility data the runtime gate uses.
pub fn universe_for_eval() -> Option<kawai_router::MarketUniverse> {
    let lock = &*USDM_UNIVERSE;
    let guard = lock.read().expect("universe lock");
    guard.as_ref().map(|(_, set)| set.clone())
}

/// Test/eval seam: seed the symbol universe without network. route_eval and
/// the routing-gate test seed a small representative set so the eligibility
/// decision is deterministic offline.
pub fn seed_usdm_universe_for_test(symbols: &[&str], equities: &[&str]) {
    let lock = &*USDM_UNIVERSE;
    let equities: std::collections::HashSet<String> =
        equities.iter().map(|s| s.to_uppercase()).collect();
    let mut set: std::collections::HashSet<String> =
        symbols.iter().map(|s| s.to_uppercase()).collect();
    set.extend(equities.iter().cloned());
    *lock.write().expect("universe lock") =
        Some((std::time::Instant::now(), kawai_router::MarketUniverse { symbols: set, equities }));
}

/// The Stock Research execution registry: the merged auto catalog narrowed
/// the planner (never in the Turso tool catalog or `PLAN_CORE_TOOLS`) — this
/// registry is the dispatch view only.
#[cfg(feature = "litert")]
pub async fn build_desk_registry(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
) -> Result<ToolRegistry, SupervisorError> {
    let mut toolset = build_supervisor_toolset(user_id, session_id, AUTO_AGENT_ID)
        .await
        .ok_or_else(|| SupervisorError::NoToolset(AUTO_AGENT_ID.to_string()))?;
    let desk_news = onboarding::adapter::webread_search_fn(user_id).map(|search| {
        let search: kawai_desk::NewsSearchFn = Arc::new(move |query: String| {
            let search = search.clone();
            Box::pin(async move {
                let hits = search(query).await?;
                Ok(hits
                    .into_iter()
                    .map(|h| kawai_desk::NewsHit {
                        url: h.url,
                        title: h.title,
                        snippet: h.snippet,
                    })
                    .collect())
            })
        });
        search
    });
    // The desk's ledger material — the user's OWN realized record on the
    // symbol, read from the LOCAL fill ledger (a SQLite read, never a
    // signed endpoint). Absent without a venue feature or on Android: the
    // decision roles simply run without it.
    #[cfg(all(feature = "binance", not(target_os = "android")))]
    let desk_ledger: Option<kawai_desk::LedgerFn> = {
        let user_id = user_id.to_string();
        Some(Arc::new(move |symbol: String| {
            let user_id = user_id.clone();
            Box::pin(async move {
                // One record per (venue, market): the exchanges spell the same
                // pair differently (`BTCUSDT` vs `BTC_USDT`) and keep separate
                // books, so each venue is asked in its own spelling and the
                // first record with enough history wins.
                for (venue, market, symbol) in venue_symbol_spellings(&symbol) {
                    match binance::trades::symbol_realized_record(&user_id, venue, market, &symbol)
                        .await
                    {
                        Ok(Some(record)) => return Some(record),
                        Ok(None) => continue,
                        Err(e) => {
                            tracing::warn!(
                                component = "desk",
                                symbol = %symbol,
                                venue = %venue,
                                error = %e,
                                "ledger record unavailable"
                            );
                        }
                    }
                }
                None
            })
        }))
    };
    #[cfg(not(all(feature = "binance", not(target_os = "android"))))]
    let desk_ledger: Option<kawai_desk::LedgerFn> = None;

    toolset.add_tool(kawai_desk::DeskRoleTool::default().with_user(user_id));
    toolset.add_tool(
        kawai_desk::DeskDataTool::default()
            .with_web_news(desk_news)
            .with_ledger(desk_ledger),
    );
    build_registry_from_toolset(user_id, session_id, toolset, plan_key).await
}

/// Every (venue, market, symbol-spelling) the local fill history could hold a
/// user's record under, most-recorded-first.
///
/// The exchanges disagree on the pair spelling — Binance writes `BTCUSDT`, MEXC
/// writes `BTC_USDT` — and each keeps its own book, so a ticker the user typed
/// has to be asked of every venue in that venue's own spelling. Order follows
/// the feature set, so a build without MEXC never asks for a MEXC record.
fn venue_symbol_spellings(symbol: &str) -> Vec<(kawai_venue::Venue, &'static str, String)> {
    let t = symbol.trim().to_uppercase();
    let base = t
        .strip_suffix("USDT")
        .or_else(|| t.strip_suffix("USD"))
        .unwrap_or(&t)
        .trim_end_matches("/_ ")
        .to_string();
    let base = base.replace(['/', '_'], "");
    let mut out = Vec::new();
    if base.is_empty() {
        return out;
    }
    out.push((kawai_venue::Venue::Binance, "USDM", format!("{base}USDT")));
    #[cfg(feature = "mexc")]
    out.push((kawai_venue::Venue::Mexc, "USDTM", format!("{base}_USDT")));
    out
}

/// The YouTube Summary execution registry: the merged auto catalog narrowed
/// for dispatch PLUS the one youtube stage tool. Stage steps are never
/// visible to the planner (never in the Turso tool catalog or
/// `PLAN_CORE_TOOLS`) — this registry is the dispatch view only.
#[cfg(feature = "litert")]
pub async fn build_youtube_registry(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
) -> Result<ToolRegistry, SupervisorError> {
    let mut toolset = build_supervisor_toolset(user_id, session_id, AUTO_AGENT_ID)
        .await
        .ok_or_else(|| SupervisorError::NoToolset(AUTO_AGENT_ID.to_string()))?;
    toolset.add_tool(kawai_youtube::YoutubeStageTool::default().with_user(user_id));
    build_registry_from_toolset(user_id, session_id, toolset, plan_key).await
}

/// Shared dispatch registry for the FIXED Binance pipelines (Futures Risk
/// Audit, Crypto Screener): the merged auto catalog. Both pipeline tools —
/// `binance_futures_risk_audit` and `crypto_screener` — are tools the binance
/// toolset registers UNCONDITIONALLY (`registry::all_tools` — each user brings
/// their own keys, so the signed tools ship and a missing pair surfaces as a
/// guidance error naming Settings, never as an un-dispatchable step; the
/// screener is keyless market data and needs no pair at all).
#[cfg(all(feature = "litert", feature = "binance", not(target_os = "android")))]
pub async fn build_fixed_binance_registry(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
) -> Result<ToolRegistry, SupervisorError> {
    let toolset = build_supervisor_toolset(user_id, session_id, AUTO_AGENT_ID)
        .await
        .ok_or_else(|| SupervisorError::NoToolset(AUTO_AGENT_ID.to_string()))?;
    build_registry_from_toolset(user_id, session_id, toolset, plan_key).await
}

/// Shared dispatch registry for the FIXED MEXC Futures Risk Audit pipeline.
#[cfg(all(feature = "litert", feature = "mexc", not(target_os = "android")))]
pub async fn build_fixed_mexc_registry(
    user_id: &str,
    session_id: i64,
    plan_key: &str,
) -> Result<ToolRegistry, SupervisorError> {
    let toolset = build_supervisor_toolset(user_id, session_id, AUTO_AGENT_ID)
        .await
        .ok_or_else(|| SupervisorError::NoToolset(AUTO_AGENT_ID.to_string()))?;
    build_registry_from_toolset(user_id, session_id, toolset, plan_key).await
}

/// The futures risk audit's books wave: when the `accounting` feature is on,
/// append a step after the mirror sync that posts fills not yet recorded in
/// the ledger (idempotent, rolling 30-day window). The step dispatches
/// `books_auto_sync` — present in the AUTO toolset this registry is built
/// from — and is fully automatic: postings derive from the exchange and are
/// idempotent, and the audit's synthesis reports what was posted.
#[cfg(all(feature = "accounting", feature = "binance", not(target_os = "android")))]
pub fn append_books_sync_step(
    mut plan: kawai_router::TaskPlan,
    venue: &str,
) -> kawai_router::TaskPlan {
    plan.steps.push(kawai_router::TaskStep {
        id: "books_sync".into(),
        agent_id: ::binance::BINANCE_AUDIT_AGENT_ID.into(),
        task: "Post fills not yet recorded in the ledger (idempotent, last 30 days); include the posted summary in the audit narrative".into(),
        tool: Some("books_auto_sync".into()),
        // The ledger is venue-generic; the audit that carries this wave is
        // not, so the wave names the venue whose fills it posts.
        arguments: serde_json::json!({ "venue": venue }),
        depends_on: vec!["audit_data".into()],
        ..kawai_router::TaskStep::default()
    });
    plan
}

pub(crate) async fn build_registry_from_toolset(
    user_id: &str,
    session_id: i64,
    toolset: kawai_tools::ToolSet,
    plan_key: &str,
) -> Result<ToolRegistry, SupervisorError> {
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
        match kawai_db::list_supervisor_step_results(user_id, session_id, plan_key)
            .await
        {
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
            // Legacy tool names (persisted plans, stale catalog) resolve to the
            // current tool here — the single dispatch choke point.
            let name = kawai_router::legacy::canonical_tool_name(call.step.dispatch_key()).to_string();
            let args_value = coerce_resolved_args(
                &name,
                &call.args,
                schemas.get(&name),
                &resolved_arg_keys(&call.step),
            );
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
            // Evidence for post-run diagnosis: which resolved arguments the
            // step actually executed with (invented slugs / wrong args were
            // previously invisible — neither the plan record nor stepStarted
            // persists arguments).
            eprintln!(
                "[supervisor] dispatch step={} tool={name} args={}",
                call.step.id,
                preview_chars(&args, 200)
            );
            let started = std::time::Instant::now();
            // Usage attribution scope (PLAN-tool-usage-charging.md Fase 1):
            // every remote LLM call inside this tool (a `reason` one-shot, a
            // subagent round) folds its provider-reported usage into
            // `step_charge` and lands its ledger row with this tool's name —
            // and with this step's user when the call carries none (web).
            let step_charge = std::sync::Arc::new(kawai_telemetry::ToolCharge::new(
                name.clone(),
                db_user_id.as_str(),
            ));
            // Cooperative deadline: tools with internal retry loops (the NL
            // data tools) read this and return a structured "budget ran out"
            // error instead of being hard-killed into an opaque timeout.
            let step_deadline = call
                .timeout_ms
                .map(|ms| started + std::time::Duration::from_millis(ms));
            let result = kawai_analytics::deadline::scope(
                step_deadline,
                kawai_telemetry::scoped_tool_charge(
                    step_charge.clone(),
                    toolset.execute(&name, args.clone()),
                ),
            )
            .await;
            let latency_ms = started.elapsed().as_millis() as i64;
            // Per-step telemetry (turn_log) — best-effort, never fails a step.
            // Real provider-reported token totals replace the NULL/estimate
            // pair whenever the step drove at least one remote call; a
            // pure-local step keeps the old shape (input unknown, output
            // estimated) — on-device tokens are free and unreported.
            let success = result.is_success();
            let (step_in, step_out) = (
                step_charge.input_tokens(),
                step_charge.output_tokens(),
            );
            let remote_ran = step_in + step_out > 0;
            kawai_db::log_turn(
                &db_user_id,
                kawai_db::TurnLogEntry {
                    session_id: db_session_id,
                    agent_id: call.step.agent_id.as_str(),
                    provider: "supervisor",
                    tool: Some(name.as_str()),
                    input_tokens: remote_ran.then_some(step_in as i64),
                    output_tokens: if remote_ran {
                        Some(step_out as i64)
                    } else {
                        result.text().map(|t| t.len() as i64 / 4)
                    },
                    latency_ms,
                    outcome: if success { "tool" } else { "error" },
                },
            )
            .await;

            // Fase 2 surcharge (PLAN-tool-usage-charging.md): a priced tool
            // charges its flat app-token fee on COMPLETED steps only — a
            // failed step or scheduler retry that fails buys nothing, and a
            // memo hit returned before this line. The fee rides the two
            // existing sinks — the telemetry counter (the recap's debit
            // source) and the ledger row (the sqld-phase source) — under the
            // meter_media contract: fire-and-forget, never fails the step.
            // The counter carries NO tool label (low-cardinality rule); the
            // breakdown lives in the ledger row.
            if success {
                if let Some(price) = crate::logic::tool_pricing::tool_price(&name) {
                    kawai_telemetry::metric_counter(
                        kawai_telemetry::TOOL_TOKEN_USAGE_COUNTER,
                        price,
                        vec![("user.id".to_string(), db_user_id.clone())],
                    );
                    kawai_db::record_usage(
                        &db_user_id,
                        kawai_db::UsageRecord {
                            kind: kawai_db::KIND_TOOL.to_string(),
                            role: Some("supervisor-step".to_string()),
                            provider: Some("kawai".to_string()),
                            billed_tokens: Some(price as i64),
                            session_id: Some(db_session_id),
                            tool: Some(name.clone()),
                            ..Default::default()
                        },
                    );
                }
            }

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

/// The ask-about-step-result toolset: the merged `auto` supervisor catalog
/// (which already carries every dispatchable tool the run used) plus the
/// `explain_step_result` explainer. The explainer is deliberately NOT part
/// of the planner-visible catalog — it is an internal reflection tool the
/// planner must never plan against; this builder is the only place it rides.
#[cfg(feature = "litert")]
pub async fn supervisor_toolset_with_explainer(
    user_id: &str,
    session_id: i64,
) -> Result<kawai_tools::ToolSet, SupervisorError> {
    let mut toolset = build_supervisor_toolset(user_id, session_id, AUTO_AGENT_ID)
        .await
        .ok_or_else(|| SupervisorError::NoToolset(AUTO_AGENT_ID.to_string()))?;
    toolset.add_tool(kawai_agent::ExplainStepResultTool::default().with_user(user_id));
    Ok(toolset)
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
    resolved_keys: &std::collections::HashSet<String>,
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
        // A stringified blob is only ever produced by dataflow resolution, so
        // only keys the resolver actually wrote may be unwrapped. Without this
        // guard a LITERAL argument the model wrote (a JSON-shaped document
        // body, an expression) that happens to parse into a file-shaped value
        // would be silently replaced by a file id.
        if stringified && !resolved_keys.contains(key) {
            continue;
        }
        if let Some(coerced) = pick_file_id(tool, value, 2) {
            out.insert(key.clone(), coerced);
        }
    }
    serde_json::Value::Object(out)
}

/// The argument keys a step's dataflow resolution can own: keys whose planned
/// value is a `{"fromStep": …}` reference or a `${step.output}` interpolation,
/// plus every explicit `inputs` binding. Used to keep
/// [`coerce_resolved_args`] off literal arguments.
fn resolved_arg_keys(step: &kawai_router::TaskStep) -> std::collections::HashSet<String> {
    fn is_reference(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::String(s) => s.contains("${"),
            serde_json::Value::Object(_) => v.get("fromStep").is_some(),
            _ => false,
        }
    }
    let mut keys = std::collections::HashSet::new();
    if let Some(obj) = step.arguments.as_object() {
        for (k, v) in obj {
            if is_reference(v) {
                keys.insert(k.clone());
            }
        }
    }
    if let Some(obj) = step.inputs.as_object() {
        keys.extend(obj.keys().cloned());
    }
    keys
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
/// Internal-only writer: skip ALL synthesis — the last step's raw output IS
/// the final answer. Used by the ask-about-step-result mini-plan
/// (`logic::ask_about_step_result`); never planner-choosable (plan
/// validation rejects unknown `finalWriter` values, so only in-process
/// callers can set it). Skips the deliverable synthesis call, the
/// `__deliverable` lifecycle events, the deliverable persistence row, and
/// the agent-experience distillation — a reflection op must not bill a
/// second cloud call nor pollute the planner's `<experiences>` context.
pub const WRITER_RAW: &str = "raw";

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
        agent_version: kawai_telemetry::app_version().into(),
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
                tracing::warn!(component = "supervisor", "revise round {round}: watchdog fired (300s), raw so far: {} chars", raw.len());
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
                    let suggestions = suggest_tools(registry, &plan_err.to_string());
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

/// Long strings are clipped before fitting — headers/subjects/snippets
/// survive, fat HTML bodies don't.
const SYNTHESIS_STRING_CAP: usize = 240;
/// JSON bodies get a larger share: compaction keeps whole array elements,
/// so more room = more complete items (a 5-email Gmail result fits whole).
const COMPACT_STEP_CHARS: usize = 12_000;
/// Cap for non-JSON bodies (plain head-truncation).
const SYNTHESIS_PER_STEP_CHARS: usize = 4_000;

fn clip_strings(v: &mut serde_json::Value, cap: usize) {
    match v {
        serde_json::Value::String(s) => {
            if s.chars().count() > cap {
                let clipped: String = s.chars().take(cap).collect();
                *s = format!("{clipped}…");
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(|i| clip_strings(i, cap)),
        serde_json::Value::Object(map) => map.values_mut().for_each(|v| clip_strings(v, cap)),
        _ => {}
    }
}

/// Render within `budget` chars. Arrays keep WHOLE elements in order and
/// replace the rest with an "… N more items omitted" marker (valid JSON);
/// head-truncating the serialized body used to cut mid-element, so the
/// writer saw only the first email of a 5-email result (1-of-5 bug).
fn render_bounded(v: &serde_json::Value, budget: usize, cap: usize) -> String {
    let full = serde_json::to_string(v).unwrap_or_default();
    if full.chars().count() <= budget {
        return full;
    }
    match v {
        serde_json::Value::Array(items) => {
            let reserve = 64; // room for the omission marker
            let mut taken: Vec<String> = Vec::new();
            let mut used = 2usize;
            for item in items {
                let s = serde_json::to_string(item).unwrap_or_default();
                let cost = s.chars().count() + usize::from(!taken.is_empty());
                if used + cost > budget.saturating_sub(reserve) {
                    break;
                }
                used += cost;
                taken.push(s);
            }
            if taken.is_empty() {
                return truncate_chars(&full, budget);
            }
            let omitted = items.len() - taken.len();
            if omitted > 0 {
                taken.push(format!("\"… {omitted} more items omitted\""));
            }
            format!("[{}]", taken.join(","))
        }
        serde_json::Value::Object(map) => {
            let reserve = 64;
            let mut parts: Vec<String> = Vec::new();
            let mut used = 2usize;
            for (k, val) in map {
                let remaining = budget.saturating_sub(used + reserve);
                if remaining < 32 {
                    break;
                }
                let rendered = render_bounded(val, remaining, cap);
                let cost = rendered.chars().count()
                    + k.chars().count()
                    + 4
                    + usize::from(!parts.is_empty());
                if used + cost > budget.saturating_sub(reserve) {
                    break;
                }
                used += cost;
                parts.push(format!("{k}:{rendered}"));
            }
            if parts.is_empty() {
                return truncate_chars(&full, budget);
            }
            format!("{{{}}}", parts.join(","))
        }
        _ => truncate_chars(&full, budget),
    }
}

/// `Some(compacted)` for JSON bodies, `None` otherwise (caller falls back
/// to plain head-truncation).
fn compact_step_output(body: &str, budget: usize, cap: usize) -> Option<String> {
    let mut v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    clip_strings(&mut v, cap);
    Some(render_bounded(&v, budget, cap))
}

/// Per-step result digest for the synthesis call: tool + status + a bounded
/// output preview per step, overall-capped so the materials stay within the
/// providers' budgets.
fn synthesis_materials(plan: &kawai_router::TaskPlan, result: &kawai_router::ExecutionResult) -> String {
    const TOTAL_CHARS: usize = 24_000;
    // Structured outputs (kind-marked JSON: "ta", "chart", "data") ride
    // FIRST: they are small and carry the exact numbers the answer needs —
    // a long webread page must never starve them out of the budget. The
    // sort is stable, so plan order is kept inside each group.
    let mut blocks: Vec<(bool, String)> = Vec::new();
    for step in &plan.steps {
        let Some(r) = result.get(&step.id) else { continue };
        let tool = step.tool.clone().unwrap_or_else(|| step.agent_id.clone());
        let (status, body) = match r.status {
            kawai_router::StepStatus::Completed => ("ok", r.output.as_str()),
            kawai_router::StepStatus::Failed => ("failed", r.error.as_deref().unwrap_or("")),
            _ => continue, // skipped steps carry nothing answerable
        };
        let structured = serde_json::from_str::<serde_json::Value>(body.trim())
            .ok()
            .map(|v| v.get("kind").is_some())
            .unwrap_or(false);
        let preview = compact_step_output(body, COMPACT_STEP_CHARS, SYNTHESIS_STRING_CAP)
            .unwrap_or_else(|| preview_chars(body, SYNTHESIS_PER_STEP_CHARS).to_string());
        blocks.push((
            structured,
            format!(
                "<step id=\"{}\" tool=\"{}\" status=\"{status}\">\n{}\n</step>\n",
                step.id, tool, preview,
            ),
        ));
    }
    blocks.sort_by_key(|(structured, _)| !*structured);
    let mut out = String::new();
    for (_, block) in blocks {
        out.push_str(&block);
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

/// Completed step outputs that parse as JSON with `kind == wanted`, in plan
/// order. Shared scaffold for the deliverable collectors
/// ([`collect_run_charts`], [`collect_ta_summaries`]).
fn completed_kind_outputs(
    result: &kawai_router::ExecutionResult,
    kind: &str,
) -> Vec<serde_json::Value> {
    result
        .results
        .iter()
        .filter(|r| r.status == kawai_router::StepStatus::Completed)
        .filter_map(|r| serde_json::from_str::<serde_json::Value>(r.output.trim()).ok())
        .filter(|v| v.get("kind").and_then(|k| k.as_str()) == Some(kind))
        .collect()
}

/// Deterministic scan of the run's step outputs for chart artifacts. The
/// deliverable writer may embed these via `![caption](kawai-file://<id>)`;
/// any other id it writes is stripped by [`strip_unknown_chart_tokens`].
fn collect_run_charts(result: &kawai_router::ExecutionResult) -> Vec<RunChart> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for v in completed_kind_outputs(result, "chart") {
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

/// Gaps a step declared about its OWN coverage, surfaced to the deliverable
/// writer verbatim.
///
/// A tool that cannot see everything must say so in data, and the writer must
/// repeat it: a bare COIN-M PnL table presented as "analysis" implied a risk
/// review that never ran. Collected from the steps' own `limitations` array,
/// deduplicated — the writer states facts, it does not invent them.
fn limitations_material_block(steps: &[kawai_router::StepResult]) -> String {
    let mut seen = std::collections::BTreeSet::new();
    let mut out: Vec<String> = Vec::new();
    for st in steps {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(st.output.as_str()) else {
            continue;
        };
        let Some(items) = v.get("limitations").and_then(|l| l.as_array()) else {
            continue;
        };
        for item in items {
            let Some(text) = item.as_str() else { continue };
            if !text.is_empty() && seen.insert(text.to_string()) {
                out.push(format!("- {text}"));
            }
        }
    }
    if out.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n<limitations>\nA step above could NOT fully cover part of what was asked. You MUST          state each limitation in the answer, in plain words, wherever it is relevant — do not          present a partial result as if it were complete, and do not drop the limitation to make          the answer read better. Limitations:\n",
    );
    s.push_str(&out.join("\n"));
    s.push_str("\n</limitations>");
    s
}

/// Remove image tokens whose id is not one of this run's charts AND does not
/// resolve in the user's office store — the writer occasionally parrots a
/// malformed id, and a broken embed must never reach the deliverable. The
/// caption text is kept. Store-resolving ids keep their token so non-chart
/// media (a Generator video the user referenced by id) renders inline.
fn strip_unknown_chart_tokens(text: &str, charts: &[RunChart], user_id: &str) -> String {
    strip_chart_tokens_with(text, charts, &|id| {
        kawai_office::store::resolve(user_id, id).is_ok()
    })
}

/// Pure core of [`strip_unknown_chart_tokens`] — `is_known` answers whether
/// an id may survive (run charts OR anything resolvable in the user's store).
fn strip_chart_tokens_with(
    text: &str,
    charts: &[RunChart],
    is_known: &dyn Fn(&str) -> bool,
) -> String {
    static TOKEN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"!\[([^\]\n]*)\]\(kawai-file://([^)\s]+)\)").expect("chart token regex")
    });
    let valid: std::collections::HashSet<&str> =
        charts.iter().map(|c| c.file_id.as_str()).collect();
    TOKEN
        .replace_all(text, |caps: &regex::Captures| {
            let id = caps.get(2).map(|g| g.as_str()).unwrap_or_default();
            if valid.contains(id) || is_known(id) {
                caps.get(0).expect("whole match").as_str().to_string()
            } else {
                caps.get(1).map(|g| g.as_str()).unwrap_or_default().to_string()
            }
        })
        .into_owned()
}

/// One `data_ta` step's parsed summary: the computed latest indicator values
/// plus the metadata needed for price-relative signals, and the optional
/// whole-series statistics (`metrics`) that sit beside them.
struct TaSummary {
    source: String,
    indicators: serde_json::Map<String, serde_json::Value>,
    /// Present only when the step asked for performance statistics. They are
    /// magnitudes rather than directions (a Sharpe is neither bullish nor
    /// bearish), so they get their own table instead of a fabricated signal
    /// in the indicator one.
    metrics: serde_json::Map<String, serde_json::Value>,
    last_close: Option<f64>,
}

/// Deterministic scan of the run's step outputs for `data_ta` results
/// (`kind:"ta"` — the same pattern as [`collect_run_charts`]). Feeds the
/// indicator-summary table appended to the deliverable.
fn collect_ta_summaries(result: &kawai_router::ExecutionResult) -> Vec<TaSummary> {
    let mut out = Vec::new();
    for v in completed_kind_outputs(result, "ta") {
        let Some(indicators) = v.get("indicators").and_then(|i| i.as_object()) else {
            continue;
        };
        let metrics = v
            .get("metrics")
            .and_then(|m| m.as_object())
            .cloned()
            .unwrap_or_default();
        let meta = v.get("_meta");
        let source = meta
            .and_then(|m| m.get("source"))
            .and_then(|s| s.as_str())
            .unwrap_or("series")
            .to_string();
        let last_close = meta
            .and_then(|m| m.get("lastClose"))
            .and_then(|c| c.as_f64());
        out.push(TaSummary {
            source,
            indicators: indicators.clone(),
            metrics,
            last_close,
        });
    }
    out
}

/// Threshold signal: `hi_label` at/above `hi`, `lo_label` at/below `lo`.
fn ta_thr(n: f64, hi: f64, lo: f64, hi_label: &'static str, lo_label: &'static str) -> &'static str {
    if n >= hi {
        hi_label
    } else if n <= lo {
        lo_label
    } else {
        "Netral"
    }
}

/// Sign signal at zero — standard momentum/oscillator reading.
fn ta_sign(x: f64) -> &'static str {
    if x > 0.0 {
        "Bullish"
    } else if x < 0.0 {
        "Bearish"
    } else {
        "Netral"
    }
}

/// Price-relative signal — needs the series' last close to decide.
fn ta_price_vs(level: f64, last_close: Option<f64>) -> Option<&'static str> {
    last_close.map(|c| if c > level { "Bullish" } else { "Bearish" })
}

/// Standard threshold signal for one indicator value, or `None` when the kind
/// carries no conventional directional reading (volatility, raw volume, …).
/// Aliases are matched by their alphabetic prefix (`rsi14` → `rsi`,
/// `stoch_slow14_3` → `stoch_slow`), so explicit `alias` overrides still hit.
fn ta_signal(base: &str, v: &serde_json::Value, last_close: Option<f64>) -> Option<&'static str> {
    let num = || v.as_f64();
    let field = |k: &str| v.get(k).and_then(|x| x.as_f64());
    Some(match base {
        "rsi" => ta_thr(num()?, 70.0, 30.0, "Overbought", "Oversold"),
        "stoch" | "stoch_fast" | "stoch_slow" => {
            ta_thr(num()?, 80.0, 20.0, "Overbought", "Oversold")
        },
        "mfi" => ta_thr(num()?, 80.0, 20.0, "Overbought", "Oversold"),
        "cci" => ta_thr(num()?, 100.0, -100.0, "Overbought", "Oversold"),
        "macd" | "ppo" | "kvo" => ta_sign(field("histogram")?),
        "roc" | "cmo" => ta_sign(num()?),
        "aroon" => ta_sign(field("up")? - field("down")?),
        "dm" => ta_sign(field("pos")? - field("neg")?),
        "ema" | "sma" | "wma" | "dema" | "hma" | "rma" | "vidya" | "ama" | "vwap" => {
            return ta_price_vs(num()?, last_close)
        },
        "bb" | "kc" | "dc" => {
            let close = last_close?;
            if close > field("upper")? {
                "Overbought"
            } else if close < field("lower")? {
                "Oversold"
            } else {
                "Netral"
            }
        },
        "ichimoku" => {
            let close = last_close?;
            let a = field("senkou_span_a")?;
            let b = field("senkou_span_b")?;
            if close > a.max(b) {
                "Bullish"
            } else if close < a.min(b) {
                "Bearish"
            } else {
                "Netral"
            }
        },
        // The detrended oscillator's sign is the reading: above its own trend
        // is bullish, below it bearish.
        "dto" => ta_sign(num()?),
        // The supertrend output is a trailing stop, so the reading is
        // price-relative rather than taken from the number's own sign.
        "supertrend" => return ta_price_vs(num()?, last_close),
        // The Lo-MacKinlay ratio is a regime classifier: above 1.1 the market
        // persists, below 0.9 it reverts. This is NOT the `vr` entry above,
        // which is a different indicator measuring something else entirely.
        "vr_lm" => ta_thr(num()?, 1.1, 0.9, "Trending", "Mean-reverting"),
        // The Kalman slope is the directional component; the other four
        // readings are magnitudes.
        "kalman" => ta_sign(field("slope")?),
        // `hurst` and `volsig` deliberately carry no directional reading.
        // R/S is biased away from 0.5 at finite windows, so a threshold there
        // would be a confident wrong answer; volume activity says how busy the
        // market is, not which way it is going. "—" is the honest cell.
        _ => return None,
    })
}

/// Compact fixed-point formatting — integers plain, fractions ≤6 decimals
/// with trailing zeros trimmed.
fn ta_fmt_num(x: f64) -> String {
    if !x.is_finite() {
        return "—".into();
    }
    if (x - x.trunc()).abs() < 1e-9 && x.abs() < 1e15 {
        return format!("{}", x as i64);
    }
    let s = format!("{x:.6}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// One indicator value rendered for the table's Nilai column: scalars plain,
/// multi-field objects as compact `key value` pairs.
fn ta_value_text(v: &serde_json::Value) -> String {
    if let Some(n) = v.as_f64() {
        return ta_fmt_num(n);
    }
    if let Some(o) = v.as_object() {
        let parts: Vec<String> = o
            .iter()
            .map(|(k, x)| format!("{k} {}", x.as_f64().map(ta_fmt_num).unwrap_or_else(|| "—".into())))
            .collect();
        return parts.join(", ");
    }
    "—".into()
}

/// `rsi14` → `RSI (14)`, `macd12_26_9` → `MACD (12,26,9)`, `vr_lm5` → `VR_LM (5)`.
fn ta_prettify_alias(alias: &str) -> String {
    // Underscores belong to the name, not to the parameter list: kinds like
    // `vr_lm` and `stoch_slow` carry one. Splitting at the first non-letter
    // renders `vr_lm5` as the nonsense `VR (,lm5)`.
    let alpha: String = alias
        .chars()
        .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
        .collect();
    let alpha = alpha.trim_end_matches('_');
    let rest: String = alias.chars().skip(alpha.len()).collect();
    let upper = alpha.to_uppercase();
    if rest.is_empty() {
        upper
    } else {
        format!("{upper} ({})", rest.replace('_', ","))
    }
}

/// Deterministic indicator-summary table appended to the deliverable when the
/// run computed technical indicators. Numbers come straight from the full
/// step outputs — the writer's output cap never gates them, and the table
/// survives even the raw-output fallback. Empty string when no TA step ran.
fn indicator_summary_block(summaries: &[TaSummary]) -> String {
    if summaries.is_empty() {
        return String::new();
    }
    let multi = summaries.len() > 1;
    let mut out =
        String::from("\n\n## Ringkasan Indikator Teknikal\n\n| Indikator | Nilai | Sinyal |");
    if multi {
        out.push_str(" Sumber |");
    }
    out.push_str("\n|---|---|---|");
    if multi {
        out.push_str("---|");
    }
    out.push('\n');
    for s in summaries {
        for (alias, v) in &s.indicators {
            let base: String = alias
                .chars()
                .take_while(|c| c.is_ascii_alphabetic() || *c == '_')
                .collect();
            let signal = ta_signal(&base, v, s.last_close).unwrap_or("—");
            out.push_str(&format!(
                "| {} | {} | {} |",
                ta_prettify_alias(alias),
                ta_value_text(v),
                signal
            ));
            if multi {
                out.push_str(&format!(" {} |", s.source));
            }
            out.push('\n');
        }
    }
    out.push_str(&perf_summary_block(summaries));
    out
}

/// Human label for one performance metric. `max_drawdown` renders as a
/// positive fraction, so it is labelled a drawdown rather than a return.
fn perf_metric_label(kind: &str) -> &'static str {
    match kind {
        "total_return" => "Total Return",
        "annualized_return" => "Return Annual",
        "sharpe" => "Sharpe Ratio",
        "sortino" => "Sortino Ratio",
        "calmar" => "Calmar Ratio",
        "max_drawdown" => "Max Drawdown",
        "volatility" => "Volatilitas Annual",
        _ => "Metrik",
    }
}

/// Deterministic performance-statistics table, appended after the indicator
/// table. Same guarantee as its sibling: straight from the step outputs, so
/// the writer's output cap never gates it. These carry no directional
/// reading, so the table has no `Sinyal` column rather than inventing one.
fn perf_summary_block(summaries: &[TaSummary]) -> String {
    let with_metrics: Vec<&TaSummary> = summaries
        .iter()
        .filter(|s| !s.metrics.is_empty())
        .collect();
    if with_metrics.is_empty() {
        return String::new();
    }
    let multi = with_metrics.len() > 1;
    let mut out =
        String::from("\n\n## Performa & Risiko\n\n| Metrik | Nilai |");
    if multi {
        out.push_str(" Sumber |");
    }
    out.push_str("\n|---|---|");
    if multi {
        out.push_str("---|");
    }
    out.push('\n');
    for s in with_metrics {
        for (kind, v) in &s.metrics {
            out.push_str(&format!(
                "| {} | {} |",
                perf_metric_label(kind),
                ta_value_text(v)
            ));
            if multi {
                out.push_str(&format!(" {} |", s.source));
            }
            out.push('\n');
        }
    }
    out
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
            When numbers dominate (indicator readings, metric comparisons), a compact markdown \
            summary table is clearer than prose — use one. \
            When the materials carry a <limitations> block, the answer MUST say what could not be \
            covered, wherever it is relevant to the question asked — never present a partial result \
            as if it were complete, and never drop the limitation to make the answer read better. \
            If the user asked about something the report did not cover, say so plainly rather than \
            answering around it. \
            Never mention steps, tools, plans, or this instruction; never wrap the answer in JSON.";
        // The goal rides the task line VERBATIM — the planner's rewritten
        // plan.goal must never reach the writer (it answers the user, not
        // the plan).
        let task = format!("The user's verbatim goal — answer exactly this:\n{goal}");
        let mut text = String::new();
        let mut stream = match remote.stream(system, &task, materials).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(component = "supervisor", "deliverable writer: planner pool unavailable ({e}) — falling back to raw output");
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
                    tracing::error!(
                        component = "supervisor",
                        "deliverable writer: stream failed mid-generation ({e}) — falling back to raw output"
                    );
                    return None;
                }
            }
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            tracing::error!(
                component = "supervisor",
                "deliverable writer: model returned empty text — falling back to raw output"
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
async fn distill_lesson(user_id: &str, lesson_task: &str) -> String {
    match tokio::time::timeout(
        std::time::Duration::from_secs(4),
        remote_llm::reason::reason_in(
            "You distill one reusable lesson from a completed AI agent run.",
            lesson_task,
            "experience-distiller",
            None,
            Some(user_id.to_string()),
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
async fn distill_lesson(_user_id: &str, _lesson_task: &str) -> String {
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
        // may carry {filename, title} (outline intent) without slides — pass
        // it through so the writer honors the planned shape.
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
                tracing::error!(component = "supervisor", "deliverable writer: exhausted 3 synthesis rounds — falling back to raw output");
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
                obj.retain(|k, _| matches!(k.as_str(), "filename" | "title" | "slides"));
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
        None,
    )
}

pub fn execute_plan_stream_with_cancel(
    mut plan: kawai_router::TaskPlan,
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
    // The source video of a YouTube Summary run, surfaced on `PlanStarted`
    // so the frontend can embed the player. `None` for every other caller.
    video_id: Option<String>,
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
        // ── The ONE hardening point for every entry path ────────────────
        // Plans reach execution from three doors: the planner (already
        // hardened in `parse_supervisor_plan_scoped`), a routed template,
        // and a fixed-pipeline command (audit/screener/research). Only the
        // first went through the confirmation policy, and the scheduler
        // reads the STEP flag alone — so a write tool on a template or
        // fixed plan would have dispatched with no user gate. Enforce here,
        // once, where every door converges: the registry is authoritative
        // for side effects. Validation follows, so an undispatchable plan
        // fails with the reason instead of a mid-run scheduler error.
        // The registry is authoritative for side effects; the scheduler
        // reads the STEP flag alone.
        registry.enforce_confirmation_policy(&mut plan);
        enforce_cli_run_confirmation_tiering(&mut plan);
        if let Err(e) = registry.validate_plan(&plan) {
            yield SupervisorEvent::PlanFailed {
                error: format!("plan is not dispatchable: {e}"),
            };
            return;
        }

        // ── Telemetry: one Tempo trace per run + one workflow step per node ──
        let step_count = plan.steps.len();
        yield SupervisorEvent::PlanStarted {
            goal: plan.goal.clone(),
            step_count,
            steps: plan_step_infos(&plan),
            plan_key: plan_key(&plan),
            summary: plan_summary_info(&plan),
            video_id: video_id.clone(),
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
                        // A replan / resume re-emits StepStarted for a step id
                        // that already has a span (the earlier attempt was
                        // replaced, not completed). Close the stale span first
                        // or it is orphaned in the map: never ended, never
                        // exported, and it holds its trace id forever.
                        if let Some((mut stale, _, _)) = step_spans
                            .lock()
                            .expect("supervisor step spans mutex")
                            .remove(step_id)
                        {
                            stale.set_attr("kawai.outcome", "superseded");
                            stale.end();
                        }
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
            /// Owns one pending-confirmation slot and releases it on EVERY
            /// exit path. The awaiting future can be dropped mid-await (plan
            /// cancelled, transport disconnected, run torn down) — no branch
            /// body runs then, so a remove-in-each-branch leaks the entry for
            /// the life of the process, keyed by stream id.
            struct PendingGuard {
                pending: PendingConfirmations,
                key: String,
            }
            impl Drop for PendingGuard {
                fn drop(&mut self) {
                    self.pending
                        .lock()
                        .expect("pending confirmations mutex held across panic")
                        .remove(&self.key);
                }
            }
            let pending = gate_pending.clone();
            let key = confirmation_key(&confirmation_stream_id, &step_id);
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            pending.lock().expect("pending confirmations mutex held across panic").insert(key.clone(), tx);
            Box::pin(async move {
                let _guard = PendingGuard { pending, key };
                match rx.await {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(kawai_router::RouterError::ConfirmationRejected(step_id)),
                    Err(_) => Err(kawai_router::RouterError::ConfirmationRequired(step_id)),
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
                        tracing::error!(
                            user_id = %user_id,
                            component = "supervisor",
                            "plan '{}' produced no step results (steps in plan: {})",
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

                        // Internal raw writer: the last step's output is the
                        // answer — no synthesis, no `__deliverable` step, no
                        // experience row (see WRITER_RAW).
                        if chosen_writer == WRITER_RAW {
                            let raw_final = result.final_output().map(String::from);
                            yield SupervisorEvent::PlanCompleted {
                                final_output: raw_final,
                                artifacts: run_artifacts,
                            };
                            break;
                        }

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
                                    // Degradation, not loss — the markdown deliverable still lands.
                                    tracing::warn!(
                                        user_id = %user_id,
                                        component = "supervisor",
                                        "deck writer unavailable — falling back to markdown deliverable"
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
                        // What a step could not cover — the writer must say so.
                        materials.push_str(&limitations_material_block(&result.results));
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
                                agent_version: kawai_telemetry::app_version().into(),
                                trace_span: Some((trace_id, span_id)),
                            });
                        }
                        if let Some(answer) = &synthesized {
                            tracing::info!(component = "supervisor", user_id = %user_id, chars = answer.chars().count(), "synthesis completed");
                        } else {
                            tracing::error!(user_id = %user_id, component = "supervisor", "synthesis unavailable — falling back to raw final output");
                        }
                        let written = synthesized
                            .map(|text| strip_unknown_chart_tokens(&text, &run_charts, &user_id))
                            .or_else(|| raw_final.clone());
                        // The indicator summary is appended DETERMINISTICALLY
                        // from the full step outputs (deck deliverables keep
                        // their own structure — no table there).
                        let written = written.map(|text| {
                            if deck_artifact.is_some() {
                                text
                            } else {
                                format!(
                                    "{text}{}",
                                    indicator_summary_block(&collect_ta_summaries(&result))
                                )
                            }
                        });
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
                            let lesson = distill_lesson(&user_id, &lesson_task).await;
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
                                tracing::error!(user_id = %user_id, component = "supervisor", "experience record failed: {e:?}");
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
                                    tracing::error!(user_id = %user_id, component = "supervisor", "PlanFailed: {error}");
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
                    tracing::error!(user_id = %user_id, component = "supervisor", "PlanFailed: {error}");
                    yield SupervisorEvent::PlanFailed {
                        error,
                    };
                    break;
                }
                Err(e) => {
                    tracing::error!(user_id = %user_id, component = "supervisor", "PlanFailed: {e}");
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

/// Pure mapping tests — no feature gate, they must hold under every build.
#[cfg(test)]
mod user_language_tests {
    use super::resolve_user_language as r;

    #[test]
    fn maps_primary_subtag_to_menu_names() {
        assert_eq!(r(Some("id-ID"), None).as_deref(), Some("Bahasa Indonesia"));
        assert_eq!(r(Some("ja"), None).as_deref(), Some("Japanese"));
        assert_eq!(r(Some("pt-BR"), None).as_deref(), Some("Portuguese"));
    }

    #[test]
    fn english_and_unknown_are_none() {
        assert_eq!(r(Some("en-US"), None), None);
        assert_eq!(r(Some("en"), None), None);
        assert_eq!(r(Some("sv-SE"), None), None);
        assert_eq!(r(Some(""), None), None);
        assert_eq!(r(None, None), None);
    }

    #[test]
    fn accept_language_fallback_takes_first_entry_without_q_weight() {
        assert_eq!(
            r(None, Some("id-ID,id;q=0.9,en;q=0.8")).as_deref(),
            Some("Bahasa Indonesia")
        );
        // Explicit body field wins over the header.
        assert_eq!(
            r(Some("ja-JP"), Some("id-ID")).as_deref(),
            Some("Japanese")
        );
    }
}

#[cfg(test)]
mod tool_charge_tests {
    //! Fase 1 tool-charge wiring (PLAN-tool-usage-charging.md): the dispatch
    //! closure wraps every execution in its step's `ToolCharge` scope — the
    //! tool observes ITS OWN tool name, a serial next step never sees the
    //! previous step's scope (R3 leak guard), and the per-dispatch turn_log
    //! row still lands. Runs only under `litert` (the whole supervisor module
    //! is litert-gated), but the probes make no remote calls, so the token
    //! pair keeps the old shape: input unknown, output = estimate.

    use super::*;
    use kawai_router::{StepStatus, TaskStep};

    #[derive(serde::Deserialize)]
    struct EmptyArgs {}

    /// Records the tool name its execution observed in the charge scope.
    fn record_scope_name(sink: &parking_lot::Mutex<Vec<String>>) {
        let observed = kawai_telemetry::current_tool_charge()
            .map(|c| c.tool().to_string())
            .unwrap_or_else(|| "<none>".into());
        sink.lock().push(observed);
    }

    struct ProbeA(Arc<parking_lot::Mutex<Vec<String>>>);
    struct ProbeB(Arc<parking_lot::Mutex<Vec<String>>>);

    impl kawai_tools::AgentTool for ProbeA {
        const NAME: &'static str = "probe_a";
        type Args = EmptyArgs;
        type Output = String;
        type Error = std::io::Error;

        fn description(&self) -> String {
            "test probe".into()
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
            record_scope_name(&self.0);
            Ok("probe ok".into())
        }
    }

    impl kawai_tools::AgentTool for ProbeB {
        const NAME: &'static str = "probe_b";
        type Args = EmptyArgs;
        type Output = String;
        type Error = std::io::Error;

        fn description(&self) -> String {
            "test probe".into()
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
            record_scope_name(&self.0);
            Ok("probe ok".into())
        }
    }

    #[derive(Debug)]
    struct ProbeFail;

    impl std::fmt::Display for ProbeFail {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("probe fails on purpose")
        }
    }

    impl std::error::Error for ProbeFail {}

    /// Reuses the REAL priced name (`cli_run`, 1.000) so the test pins the
    /// actual table, not a test-only entry.
    struct ProbePriced;

    impl kawai_tools::AgentTool for ProbePriced {
        const NAME: &'static str = "cli_run";
        type Args = EmptyArgs;
        type Output = String;
        type Error = ProbeFail;

        fn description(&self) -> String {
            "test probe on a priced name".into()
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
            Ok("priced ok".into())
        }
    }

    struct ProbeFails;

    impl kawai_tools::AgentTool for ProbeFails {
        const NAME: &'static str = "probe_err";
        type Args = EmptyArgs;
        type Output = String;
        type Error = ProbeFail;

        fn description(&self) -> String {
            "test probe that always fails".into()
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn call(&self, _args: Self::Args) -> Result<String, Self::Error> {
            Err(ProbeFail)
        }
    }

    #[tokio::test]
    async fn dispatch_scopes_tool_charge_per_step_and_logs_turn() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = "toolcharge-probe";

        let observed = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let mut toolset = kawai_tools::ToolSet::new();
        toolset.add_tool(ProbeA(Arc::clone(&observed)));
        toolset.add_tool(ProbeB(Arc::clone(&observed)));
        toolset.add_tool(ProbePriced);
        toolset.add_tool(ProbeFails);
        let registry = build_registry_from_toolset(user, 42, toolset, "")
            .await
            .expect("registry builds");
        let dispatch = registry.step_dispatch();

        for (i, (step_id, tool)) in [
            ("s0", "probe_a"),
            ("s1", "probe_b"),
            ("s2", "cli_run"),
            ("s3", "probe_err"),
        ]
        .into_iter()
        .enumerate()
        {
            let step = TaskStep {
                id: step_id.into(),
                agent_id: "test-agent".into(),
                tool: Some(tool.into()),
                ..TaskStep::default()
            };
            let result = dispatch(
                step,
                serde_json::json!({}),
                Vec::new(),
                tokio_util::sync::CancellationToken::new(),
                std::time::Duration::from_secs(300),
            )
            .await
            .expect("dispatch resolves");
            if tool == "probe_err" {
                assert_ne!(
                    result.status,
                    StepStatus::Completed,
                    "the failing probe must fail: {result:?}"
                );
            } else {
                assert_eq!(
                    result.status,
                    StepStatus::Completed,
                    "step {i} ({tool}) failed: {}",
                    result.error.unwrap_or_default()
                );
            }
        }

        // Each execution saw its own step's scope — never the sibling's,
        // never none (an unscooped dispatch would attribute its LLM spend to
        // no tool and skip the ledger tool column).
        assert_eq!(
            observed.lock().as_slice(),
            ["probe_a".to_string(), "probe_b".to_string()]
        );

        // One turn_log row per dispatch, named per tool, estimate-shaped
        // (no remote call ran inside the probes).
        let rows = kawai_db::list_turn_log(user, 0).await.unwrap();
        assert_eq!(rows.len(), 4, "expected 4 turn_log rows");
        assert_eq!(rows[0].tool.as_deref(), Some("probe_a"));
        assert_eq!(rows[1].tool.as_deref(), Some("probe_b"));
        assert_eq!(rows[3].outcome, "error", "the failing probe logs an error");

        // Fase 2 surcharge, revenue model: EVERY completed dispatch leaves a
        // KIND_TOOL row at its tier (default 100), the failing step buys
        // nothing. Rows ride the flusher in dispatch order (serial steps).
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        let conn = kawai_db::db_connection(user).await.unwrap();
        let mut tool_rows = conn
            .query(
                "SELECT tool, billed_tokens, session_id, role FROM usage_ledger \
                 WHERE kind = 'tool' ORDER BY seq",
                (),
            )
            .await
            .unwrap();
        let mut seen = Vec::new();
        while let Some(r) = tool_rows.next().await.unwrap() {
            assert_eq!(r.get::<String>(3).unwrap(), "supervisor-step");
            assert_eq!(r.get::<i64>(2).unwrap(), 42);
            seen.push((r.get::<String>(0).unwrap(), r.get::<i64>(1).unwrap()));
        }
        assert_eq!(
            seen,
            vec![
                ("probe_a".to_string(), 100),
                ("probe_b".to_string(), 100),
                ("cli_run".to_string(), 1_000),
            ],
            "completed steps bill at tier; the failed step must be absent"
        );
    }
}

#[cfg(all(test, feature = "litert"))]
mod tests {

    use super::*;
    use kawai_router::{StepStatus, TaskStep};

    /// Layer-2 resolver output parsing (PLAN-template-routing.md §2.5): the
    /// claim must survive fenced/prose-wrapped JSON and case slop, and must
    /// be REJECTED when the template is absent — an unparsable or hedging
    /// answer means the planner, never a guessed pipeline.
    #[test]
    fn parse_router_claim_accepts_json_and_rejects_hedges() {
        for text in [
            r#"{"template":"desk","ticker":"MU"}"#,
            "```json\n{\"template\": \"desk\", \"ticker\": \"mu\"}\n```",
            "Sure — this is a market research request.\n{\"template\":\"desk\",\"ticker\":\"MU\"}",
        ] {
            assert_eq!(
                parse_router_claim(text),
                Some(("desk".into(), "MU".into())),
                "input: {text}"
            );
        }
        // No pipeline / hedging / garbage → None (planner).
        assert_eq!(parse_router_claim(r#"{"template":null,"ticker":null}"#), None);
        assert_eq!(parse_router_claim(r#"{"template":"","ticker":"MU"}"#), None);
        assert_eq!(parse_router_claim(r#"{"template":"desk"}"#), None, "ticker missing");
        assert_eq!(parse_router_claim("bukan json"), None);
        assert_eq!(parse_router_claim(""), None);
    }

    /// Regression for the 1-of-5 deliverable bug: a fat JSON array
    /// (5 Gmail-sized messages) must compact to whole elements with an
    /// omission marker — never a mid-element cut that leaves the writer
    /// seeing only message #1.
    #[test]
    fn compact_step_output_keeps_whole_array_elements() {
        let fat_item = |i: usize| {
            serde_json::json!({
                "messageId": format!("id{i}"),
                "payload": { "headers": [
                    {"name": "From", "value": "LinkedIn <notifications@linkedin.com>"},
                    {"name": "Subject", "value": format!("Subject {i}")},
                ]},
                "messageText": "x".repeat(2_000),
            })
        };
        let body = serde_json::json!({
            "messages": (0..5).map(fat_item).collect::<Vec<_>>(),
            "resultSizeEstimate": 201,
        })
        .to_string();

        let out = compact_step_output(&body, 3_000, 240).expect("json body compacts");
        // All five items survive with their identifying fields…
        for i in 0..5 {
            assert!(out.contains(&format!("\"Subject {i}\"")), "item {i} lost");
        }
        // …no omission marker needed at this budget…
        assert!(!out.contains("more items omitted"));
        // …and within budget.
        assert!(out.chars().count() <= 3_000);

        // A tighter budget drops whole items with an explicit marker, never
        // a partial element.
        let tight = compact_step_output(&body, 1_200, 240).expect("json body compacts");
        assert!(tight.contains("more items omitted"));
        assert!(tight.starts_with('{'));
        // every listed item is complete (balanced quotes on the id field)
        assert!(tight.contains("\"id0\""));
    }

    #[test]
    fn compact_step_output_clips_long_strings_and_falls_back_on_non_json() {
        let body = serde_json::json!({ "messageText": "y".repeat(5_000) }).to_string();
        let out = compact_step_output(&body, 1_000, 240).expect("json body compacts");
        assert!(out.contains('…'));
        assert!(out.chars().count() <= 1_000);

        assert!(compact_step_output("plain text, not json", 100, 240).is_none());
    }

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
            template: None,
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
            template: None,
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
            template: None,
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
                String::new(),
                String::new(),
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
            "<environment>Local time for the user: 2026-09-26 14:05 (Saturday). Timezone: Asia/Jakarta.</environment>".into(),
        );
        assert!(out.starts_with("<user-context>"));
        assert!(out.contains("<environment>Local time"));
        // Environment rides FIRST (fresh context before user background).
        assert!(out.find("<environment>").unwrap() < out.find("<persona>").unwrap());
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
            template: None,
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
            template: None,
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
            template: None,
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
            template: None,
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
            template: None,
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
            template: None,
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

    /// The YouTube Summary's source video rides `planStarted` — the frontend
    /// embeds the player from this field, so a dropped id silently degrades
    /// the canvas to a text-only deliverable.
    #[tokio::test]
    async fn plan_started_carries_source_video_id() {
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
            template: None,
        };
        let stream = execute_plan_stream_with_cancel(
            plan,
            echo_registry(),
            tokio_util::sync::CancellationToken::new(),
            pending,
            "st-v".into(),
            "test-user".into(),
            1,
            None,
            Some("abc123xyz".into()),
            None,
        );
        let events: Vec<SupervisorEvent> = Box::pin(stream).take(4).collect::<Vec<_>>().await;
        match events.into_iter().find(|e| matches!(e, SupervisorEvent::PlanStarted { .. })) {
            Some(SupervisorEvent::PlanStarted { video_id, .. }) => {
                assert_eq!(video_id.as_deref(), Some("abc123xyz"));
            }
            other => panic!("planStarted never arrived: {other:?}"),
        }
    }

    /// End-to-end: a pure greeting and a self-identity question claim
    /// through plan_task with ZERO planner tokens, and the pre-authored
    /// localized text rides the direct_reply step under WRITER_RAW. A
    /// greeting carrying content must NOT claim — it falls to the planner
    /// stage, which fails closed without a remote pool.
    #[tokio::test(flavor = "multi_thread")]
    async fn plan_task_answers_static_goals_without_the_planner() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("static-reply-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let registry = build_supervisor_registry(&user, session, AUTO_AGENT_ID, "")
            .await
            .expect("supervisor registry");

        let (plan, usage) = plan_task(
            &user,
            session,
            "hi halo",
            None,
            Some("id-ID"),
            &registry,
            |_| {},
        )
        .await
        .expect("greeting must claim statically");
        assert_eq!(plan.template.as_deref(), Some("direct_greeting"), "plan: {plan:?}");
        assert_eq!(usage.input_tokens, 0, "the planner must not run");
        assert_eq!(usage.output_tokens, 0, "the planner must not run");
        assert_eq!(plan.final_writer.as_deref(), Some(WRITER_RAW), "raw passthrough");
        let [step] = plan.steps.as_slice() else {
            panic!("exactly one step: {plan:?}");
        };
        assert_eq!(step.tool.as_deref(), Some("direct_reply"), "plan: {plan:?}");
        let text = step.arguments.get("text").and_then(|v| v.as_str()).expect("reply text");
        assert!(text.contains("Kawai"), "localized indonesian greeting: {text}");

        // Identity questions ride the same mechanism with their own stamp.
        let (plan, usage) = plan_task(
            &user,
            session,
            "siapa anda?",
            None,
            None,
            &registry,
            |_| {},
        )
        .await
        .expect("identity question must claim statically");
        assert_eq!(plan.template.as_deref(), Some("direct_identity"), "plan: {plan:?}");
        assert_eq!(usage.input_tokens, 0, "the planner must not run");
        let [step] = plan.steps.as_slice() else {
            panic!("exactly one step: {plan:?}");
        };
        let text = step.arguments.get("text").and_then(|v| v.as_str()).expect("reply text");
        assert!(text.contains("Kawai"), "english identity reply: {text}");

        // A greeting carrying content is NOT static — the canned reply must
        // never swallow it. Whatever comes back is planner-authored (a real
        // pool plans the NVDA analysis) or the planner stage fails closed on
        // a keyless build — never the direct_greeting stamp.
        match plan_task(
            &user,
            session,
            "halo, analisis NVDA minggu ini",
            None,
            None,
            &registry,
            |_| {},
        )
        .await
        {
            Ok((plan, _usage)) => {
                assert_ne!(
                    plan.template.as_deref(),
                    Some("direct_greeting"),
                    "canned reply swallowed a content goal: {plan:?}"
                );
            }
            Err(err) => {
                assert!(
                    err.contains("remote LLM is not configured"),
                    "unexpected planner failure: {err}"
                );
            }
        }
    }

    /// End-to-end: the Trading Performance goal claims through plan_task
    /// with the REAL merged registry — the exact path the workbench chip
    /// takes after the review gate.
    #[cfg(all(feature = "accounting", feature = "binance"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn plan_task_claims_trading_performance() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("trading-perf-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let registry = build_supervisor_registry(&user, session, AUTO_AGENT_ID, "")
            .await
            .expect("supervisor registry");

        let (mut plan, usage) = plan_task(
            &user,
            session,
            "performa trading 2026-10",
            None,
            Some("id-ID"),
            &registry,
            |_| {},
        )
        .await
        .expect("trading goal must claim through plan_task");
        assert_eq!(plan.template.as_deref(), Some("trading_performance"), "plan: {plan:?}");
        assert_eq!(usage.input_tokens, 0, "the planner must not run");
        let tools: Vec<_> = plan.steps.iter().filter_map(|s| s.tool.clone()).collect();
        assert!(tools.contains(&"venue_fills_import".to_string()), "{tools:?}");
        assert!(tools.contains(&"trading_pnl_by_symbol".to_string()), "{tools:?}");
        assert!(
            tools.contains(&"crypto_futures_trade_stats".to_string()),
            "stats step dispatches a binance tool: {tools:?}"
        );
        // The stats tool is ALSO Binance's fill sync, and this goal names no
        // exchange — so the plan is unscoped and must fetch EVERY exchange
        // this build can sync before the ledger import. An import over a cold
        // fill history reports "no synced fills" and halts the review;
        // fetching only Binance silently reports a partial book.
        let fetches: Vec<String> = plan
            .steps
            .iter()
            .filter(|s| s.id.starts_with("fetch-"))
            .map(|s| s.id.clone())
            .collect();
        let syncable: Vec<String> = crate::templates::TRADING_SYNC_VENUES
            .iter()
            .map(|v| format!("fetch-{v}"))
            .collect();
        assert_eq!(
            fetches, syncable,
            "the routed plan must fetch EVERY syncable exchange: {plan:?}"
        );
        let import = plan
            .steps
            .iter()
            .find(|s| s.tool.as_deref() == Some("venue_fills_import"))
            .expect("import step");
        assert_eq!(
            import.depends_on, fetches,
            "the routed plan must fetch fills before importing: {plan:?}"
        );
        // The execution registry is the MERGED catalog (no pipeline stage
        // tool), and every step must resolve in it with a valid schema — a
        // claim that builds an undispatchable plan is as broken as no claim.
        assert_eq!(
            registry_kind_for_plan(&plan),
            PlanRegistryKind::Auto,
            "trading performance dispatches merged-catalog tools"
        );
        registry
            .validate_plan(&plan)
            .unwrap_or_else(|e| panic!("the routed plan must validate: {e}"));
        // The registry policy runs for every entry path, and accounting write
        // tools are ungated by policy (decision 2026-10-18 — the review gate is
        // the consent), so the import step must stay ungated here.
        registry.enforce_confirmation_policy(&mut plan);
        let import_step = plan
            .steps
            .iter()
            .find(|s| s.tool.as_deref() == Some("venue_fills_import"))
            .expect("import step");
        assert_ne!(
            import_step.requires_confirmation,
            Some(true),
            "accounting write tools must not add a per-write confirmation"
        );
    }

    /// A goal that NAMES an exchange must scope the routed plan to it. The
    /// template declares a `venue` slot, but the router only ever filled
    /// ticker/url/period — so "review MEXC performance" silently reviewed
    /// every venue, fetched every venue's fills, and reported the combined
    /// book the user did not ask about.
    #[cfg(all(feature = "accounting", feature = "binance", feature = "mexc"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn plan_task_scopes_the_trading_review_to_the_named_exchange() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("trading-venue-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let registry = build_supervisor_registry(&user, session, AUTO_AGENT_ID, "")
            .await
            .expect("supervisor registry");

        let (plan, usage) = plan_task(
            &user,
            session,
            "performa trading mexc 2026-10",
            None,
            Some("id-ID"),
            &registry,
            |_| {},
        )
        .await
        .expect("a venue-named trading goal must claim through plan_task");
        assert_eq!(usage.input_tokens, 0, "the planner must not run");
        assert_eq!(plan.template.as_deref(), Some("trading_performance"));
        let fetches: Vec<&str> = plan.steps.iter().map(|s| s.id.as_str()).collect();
        assert!(
            fetches.contains(&"fetch-mexc") && !fetches.contains(&"fetch-binance"),
            "a MEXC-scoped review must fetch only MEXC's fills: {fetches:?}"
        );
        for id in ["sync", "pnl", "fees"] {
            let step = plan.steps.iter().find(|s| s.id == id).expect(id);
            assert_eq!(
                step.arguments.get("venue").and_then(|v| v.as_str()),
                Some("mexc"),
                "step {id} lost the venue scope"
            );
        }
        registry
            .validate_plan(&plan)
            .unwrap_or_else(|e| panic!("the venue-scoped plan must validate: {e}"));
        // ... and the device locale rides the plan's goal (the writer's brief).
        assert!(
            plan.goal.contains("LANGUAGE: Write your ENTIRE report in Bahasa Indonesia"),
            "{}",
            plan.goal
        );
    }

    /// The merged supervisor registry is how the agent reaches a venue's tools
    /// at all: MEXC has no agent of its own, so its positions mirror rides the
    /// accounting agent's toolset. A registry without it means the agent cannot
    /// see the user's MEXC risk, whatever the toolset crate exports.
    #[cfg(all(feature = "accounting", feature = "mexc", feature = "litert"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn the_merged_registry_carries_the_mexc_positions_mirror() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("mexc-pos-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let toolset = build_supervisor_toolset(&user, session, AUTO_AGENT_ID)
            .await
            .expect("supervisor toolset");
        let names: Vec<String> = toolset
            .get_tool_definitions()
            .into_iter()
            .map(|d| d.name.to_string())
            .collect();
        assert!(names.contains(&"mexc_futures_positions".to_string()), "{names:?}");
        assert!(names.contains(&"venue_fills_import".to_string()), "{names:?}");
    }

    /// A venue-scoped review of an exchange whose fills must be FETCHED first
    /// (MEXC): the plan has to carry the venue's sync tool and the import has
    /// to depend on it, and every step must resolve in the REAL merged
    /// registry. A plan that validates but imports an empty history is exactly
    /// the failure this pins.
    #[cfg(all(feature = "accounting", feature = "binance", feature = "mexc"))]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_mexc_scoped_trading_plan_fetches_before_it_imports() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("trading-mexc-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let registry = build_supervisor_registry(&user, session, AUTO_AGENT_ID, "")
            .await
            .expect("supervisor registry");

        let plan = accounting_tools::plan::build_trading_performance_plan(
            "2026-10",
            chrono::Local::now().date_naive(),
            Some("mexc"),
            crate::templates::TRADING_SYNC_VENUES,
            None,
        )
        .expect("mexc-scoped plan");
        let tools: Vec<_> = plan.steps.iter().filter_map(|s| s.tool.clone()).collect();
        assert_eq!(tools.first().map(String::as_str), Some("mexc_futures_fill_sync"), "{tools:?}");
        let import = plan
            .steps
            .iter()
            .find(|s| s.tool.as_deref() == Some("venue_fills_import"))
            .expect("import step");
        assert_eq!(
            import.depends_on,
            vec![plan.steps[0].id.clone()],
            "the import must wait for the venue fetch"
        );
        assert_eq!(import.arguments["venue"], "mexc");
        registry
            .validate_plan(&plan)
            .unwrap_or_else(|e| panic!("the venue-scoped plan must validate: {e}"));
    }

    /// The Monthly Close template claimed the same class of bug as the
    /// trading template (the supervisor resolved no `period` slot for its
    /// builder) and shipped broken for days — this pins the whole template
    /// family, not one goal.
    #[cfg(feature = "accounting")]
    #[tokio::test(flavor = "multi_thread")]
    async fn plan_task_claims_monthly_close() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("monthly-close-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let registry = build_supervisor_registry(&user, session, AUTO_AGENT_ID, "")
            .await
            .expect("supervisor registry");

        let (plan, usage) =
            plan_task(&user, session, "tutup buku 2026-10", None, Some("id-ID"), &registry, |_| {})
                .await
                .expect("close goal must claim through plan_task");
        assert_eq!(plan.template.as_deref(), Some("accounting_monthly_close"), "plan: {plan:?}");
        assert_eq!(usage.input_tokens, 0, "the planner must not run");
        let tools: Vec<_> = plan.steps.iter().filter_map(|s| s.tool.clone()).collect();
        assert!(tools.contains(&"ledger_trial_balance".to_string()), "{tools:?}");
        registry
            .validate_plan(&plan)
            .unwrap_or_else(|e| panic!("the routed close plan must validate: {e}"));
    }

    /// The routing regression behind the Trading Performance chip: a quoted
    /// goal must route on the USER'S text — the envelope excerpt's dates and
    /// month words never reach slot extraction or the keyword gate.
    #[test]
    fn routing_goal_reads_the_user_goal_not_the_quote_envelope() {
        let quoted = "<previous-deliverable planKey=\"k\" session=\"1\" chars=\"9\">\n\
                      volatility spiked; closing narrative referenced oktober 2025\n\
                      </previous-deliverable>\n\
                      \n<user-goal>\nperforma trading 2026-10\n</user-goal>";
        let clean = routing_goal(quoted);
        assert_eq!(clean, "performa trading 2026-10");
        // The poisoned shape: without the strip, the excerpt's month wins
        // the period slot.
        assert_eq!(
            kawai_router::route::extract_period(clean).as_deref(),
            Some("2026-10")
        );
        assert_eq!(
            kawai_router::route::extract_period(quoted).as_deref(),
            Some("oktober 2025"),
            "documents the bug this strip fixes"
        );
        assert_eq!(routing_goal("tutup buku 2026-10"), "tutup buku 2026-10");
        assert_eq!(routing_goal("no envelope here"), "no envelope here");
    }

    /// The runtime registry is NOT a single-template fixture: desk, monthly
    /// close and trading performance sit together. A claim that works
    /// against a lone-template fixture can still die in the full set
    /// (ambiguity, guard ordering) — this pins the shipped regression.
    #[cfg(all(feature = "accounting", feature = "binance"))]
    #[test]
    fn trading_performance_claims_in_the_full_runtime_registry() {
        let registry = kawai_router::template::TemplateRegistry::new(crate::templates::TEMPLATES);
        let d = kawai_router::route_goal("performa trading 2026-10", None, &registry);
        match &d.route {
            kawai_router::Route::Template(t) => assert_eq!(t.id, "trading_performance"),
            other => panic!(
                "expected the trading template, got {other:?} matched={:?} blocked={:?}",
                d.matched, d.blocked_by_slots
            ),
        }
    }

    /// Fase 5 runtime gate (PLAN-template-routing.md): a market goal claimed
    /// by the desk template resolves to a Rust-authored plan with ZERO
    /// planner involvement — `usage == 0` proves the short-circuit fired
    /// before any remote round (this env compiles provider keys in, so an
    /// actual planner run would carry real tokens) — and the decision lands
    /// in `route_log`. Deliberately NOT tested here: the fall-through to the
    /// planner (it would make a live cloud call in a unit test) — that
    /// behaviour is pinned offline in `route.rs`'s unit tests.
    #[tokio::test]
    async fn template_gate_routes_without_planner_and_logs_the_decision() {
        let dir = tempfile::tempdir().unwrap();
        kawai_db::set_data_root(dir.path());
        std::mem::forget(dir);
        let user = format!("route-gate-{}-{}", std::process::id(), kawai_db::unix_now());
        let session = kawai_db::create_chat_session(&user).await.unwrap().id;
        let registry = build_supervisor_registry(&user, session, AUTO_AGENT_ID, "")
            .await
            .expect("supervisor registry");

        // Eligibility needs a market listing — seeded offline (NVDA in,
        // the BRI/BBRI black-hole class out).
        seed_usdm_universe_for_test(&["NVDA", "BTC", "ETH", "EURUSD", "BANK"], &["NVDA"]);

        let (plan, usage) =
            plan_task(&user, session, "analisis teknikal saham NVDA", None, Some("id-ID"), &registry, |_| {})
                .await
                .expect("template gate must resolve the plan");
        assert_eq!(plan.template.as_deref(), Some("desk"));
        assert_eq!(usage.input_tokens, 0, "the planner must not run");
        assert_eq!(usage.output_tokens, 0, "the planner must not run");
        assert!(!plan.steps.is_empty());
        assert!(
            plan.steps
                .iter()
                .all(|s| matches!(s.dispatch_key(), "desk_role" | "desk_data")),
            "a routed desk plan dispatches only desk stage tools (data phase + role stages)"
        );
        // The language slot rode the edge locale into every writer step.
        let first_role = plan
            .steps
            .iter()
            .find(|s| s.dispatch_key() == "desk_role")
            .expect("the desk plan has role steps");
        assert_eq!(
            first_role.arguments["language"], "Bahasa Indonesia",
            "resolve_user_language must map the locale tag for the writer"
        );

        // ── The decision is logged with its evidence ───────────────────────
        let conn = kawai_db::db_connection(&user).await.unwrap();
        let mut rows = conn
            .query("SELECT chosen, template_id, source, offered, matched FROM route_log", ())
            .await
            .unwrap();
        let mut decisions: Vec<(String, Option<String>, String, String, String)> = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            decisions.push((
                row.get(0).unwrap(),
                row.get(1).unwrap(),
                row.get(2).unwrap(),
                row.get(3).unwrap(),
                row.get(4).unwrap(),
            ));
        }
        assert_eq!(decisions.len(), 1, "{decisions:?}");
        let (chosen, template_id, source, offered, matched) = &decisions[0];
        assert_eq!((chosen.as_str(), template_id.as_deref(), source.as_str()), ("template", Some("desk"), "rule"));
        assert!(offered.contains("\"desk\""), "menu: {offered}");
        assert!(matched.contains("teknikal"), "keyword evidence: {matched}");
    }
}

#[cfg(test)]
mod plan_key_tests {
    use super::plan_key;
    use kawai_router::{TaskPlan, TaskStep};

    fn plan(flag: Option<bool>) -> TaskPlan {
        TaskPlan {
            goal: "g".into(),
            steps: vec![TaskStep {
                id: "s1".into(),
                agent_id: "builtin.x".into(),
                task: "t".into(),
                requires_confirmation: flag,
                ..Default::default()
            }],
            final_writer: None,
            summary: None,
            template: None,
        }
    }

    #[test]
    fn confirmation_enforcement_does_not_change_the_key() {
        // `enforce_confirmation_policy` flips the flag at execution time, but
        // the registry was already built with the RAW plan's key. One run must
        // not file step rows under one key and the deliverable under another.
        assert_eq!(plan_key(&plan(None)), plan_key(&plan(Some(true))));
        assert_eq!(plan_key(&plan(Some(true))), plan_key(&plan(Some(false))));
    }

    #[test]
    fn a_changed_step_gets_a_new_key() {
        let mut changed = plan(None);
        changed.steps[0].arguments = serde_json::json!({"nonce": 1});
        assert_ne!(plan_key(&plan(None)), plan_key(&changed));
    }
}

#[cfg(test)]
mod coerce_tests {
    use super::coerce_resolved_args;
    use serde_json::json;

    /// The resolver-owned keys for a test step.
    fn keys(names: &[&str]) -> std::collections::HashSet<String> {
        names.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn files_list_coerced_to_single_id_for_string_arg() {
        let schema = json!({
            "type": "object",
            "required": ["fileId"],
            "properties": {"fileId": {"type": "string"}}
        });
        let args = json!({"fileId": [{"id": "doc1", "ext": "pdf"}, {"id": "doc2", "ext": "md"}]});
        let out = coerce_resolved_args("pdf_extract_text", &args, Some(&schema), &keys(&["fileId"]));
        assert_eq!(out["fileId"], "doc1");
    }

    #[test]
    fn pdf_tool_prefers_pdf_entry_in_mixed_list() {
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let args = json!({"fileId": [{"id": "doc2", "ext": "md"}, {"id": "doc1", "ext": "pdf"}]});
        let out = coerce_resolved_args("pdf_extract_text", &args, Some(&schema), &keys(&["fileId"]));
        assert_eq!(out["fileId"], "doc1");
    }

    #[test]
    fn non_string_args_and_missing_schema_pass_through() {
        let schema = json!({"type": "object", "properties": {"query": {"type": "string"}}});
        let args = json!({"query": ["a", "b"], "limit": 5});
        let out = coerce_resolved_args("knowledge_search", &args, Some(&schema), &keys(&["query"]));
        assert_eq!(out, args);
        assert_eq!(coerce_resolved_args("t", &args, None, &keys(&[])), args);
    }

    #[test]
    fn file_object_coerced_to_handle() {
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let args = json!({"fileId": {"type": "file", "handle": "doc9", "filename": "x.pdf"}});
        let out = coerce_resolved_args("office_read_document", &args, Some(&schema), &keys(&["fileId"]));
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
        let out = coerce_resolved_args("data_schema", &args, Some(&schema), &keys(&["fileId"]));
        assert_eq!(out["fileId"], "f89462861576850000-0001");
    }

    #[test]
    fn stringified_literal_is_left_alone_when_the_resolver_did_not_write_it() {
        // A literal argument the model wrote can be JSON-shaped (a document
        // body, an expression) and parse into a file-shaped value. Only keys
        // the resolver owns may be unwrapped.
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let blob = serde_json::to_string(&json!({
            "data": {"files": [{"id": "f1", "ext": "xlsx"}]},
            "ok": true
        }))
        .unwrap();
        let args = json!({"fileId": blob});
        let out = coerce_resolved_args("data_schema", &args, Some(&schema), &keys(&[]));
        assert_eq!(out, args);
    }

    #[test]
    fn resolver_owned_keys_cover_references_and_bindings() {
        let mut step = kawai_router::TaskStep {
            id: "s".into(),
            arguments: json!({
                "fileId": {"fromStep": "list", "output": "files"},
                "template": "${s1.files}",
                "query": "a literal",
            }),
            ..Default::default()
        };
        step.inputs = json!({"source": {"fromStep": "list", "output": "files"}});
        let resolved = super::resolved_arg_keys(&step);
        assert!(resolved.contains("fileId"));
        assert!(resolved.contains("template"));
        assert!(resolved.contains("source"));
        assert!(!resolved.contains("query"));
    }

    #[test]
    fn handle_artifact_value_unwrapped_to_id() {
        // Named-output path: ${s1.files} hits the files Handle artifact →
        // resolve_args returns {"type":"handle","value":…,"kind":"files"}.
        let schema = json!({"type": "object", "properties": {"fileId": {"type": "string"}}});
        let args = json!({"fileId": {"type": "handle", "value": "f1", "kind": "files"}});
        let out = coerce_resolved_args("data_schema", &args, Some(&schema), &keys(&["fileId"]));
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

#[cfg(test)]
mod indicator_summary_tests {
    use super::*;
    use kawai_router::{StepStatus, TaskStep};

    fn step(step_id: &str, output: &str) -> kawai_router::StepResult {
        kawai_router::StepResult {
            step_id: step_id.into(),
            agent_id: "analytics".into(),
            status: StepStatus::Completed,
            output: output.into(),
            artifacts: Vec::new(),
            error: None,
            error_kind: kawai_router::FailureKind::default(),
            retries_used: 0,
        }
    }

    fn failed_step(step_id: &str, output: &str) -> kawai_router::StepResult {
        kawai_router::StepResult {
            status: StepStatus::Failed,
            ..step(step_id, output)
        }
    }

    const TA_OUTPUT: &str = r#"{
        "kind": "ta",
        "indicators": {
            "rsi14": 62.31,
            "macd12_26_9": {"macd": 1.5, "signal": 0.9, "histogram": 0.6},
            "ema9": 101.5,
            "bb20_2": {"average": 100.0, "upper": 104.0, "lower": 96.0},
            "atr14": 1.75
        },
        "_meta": {"rowsUsed": 120, "sortedBy": "timestamp", "lastClose": 103.2, "source": "btcusdt"}
    }"#;

    const TA_WITH_METRICS: &str = r#"{
        "kind": "ta",
        "indicators": {"rsi14": 62.31},
        "metrics": {
            "sharpe": 1.82,
            "max_drawdown": 0.243
        },
        "_meta": {"rowsUsed": 120, "sortedBy": "timestamp", "lastClose": 103.2,
                  "source": "btcusdt", "returns": 119, "annualized": 365.0}
    }"#;

    #[test]
    fn ta_summaries_parse_kind_marker_and_skip_other_steps() {
        let result = kawai_router::ExecutionResult {
            results: vec![
                step("page", "long page text, not json"),
                step("ta1", TA_OUTPUT),
                failed_step("failed_ta", r#"{"kind":"ta","indicators":{}}"#),
            ],
        };
        let s = super::collect_ta_summaries(&result);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].source, "btcusdt");
        assert_eq!(s[0].last_close, Some(103.2));
        assert_eq!(s[0].indicators.len(), 5);
    }

    #[test]
    fn indicator_table_signals_match_standard_thresholds() {
        let summaries = super::collect_ta_summaries(&kawai_router::ExecutionResult {
            results: vec![step("ta1", TA_OUTPUT)],
        });
        let table = super::indicator_summary_block(&summaries);
        assert!(table.contains("## Ringkasan Indikator Teknikal"));
        assert!(table.contains("| RSI (14) | 62.31 | Netral |"));
        // serde_json object iteration is alphabetical (BTreeMap), so the
        // MACD fields render histogram → macd → signal.
        assert!(table.contains("| MACD (12,26,9) | histogram 0.6, macd 1.5, signal 0.9 | Bullish |"));
        // lastClose 103.2 above EMA9 101.5 → Bullish; inside the BB bands → Netral.
        assert!(table.contains("| EMA (9) | 101.5 | Bullish |"));
        assert!(table.contains("| BB (20,2) | average 100, lower 96, upper 104 | Netral |"));
        // Volatility kinds carry no directional reading.
        assert!(table.contains("| ATR (14) | 1.75 | — |"));
        // Single source → no Sumber column.
        assert!(!table.contains("Sumber"));
    }

    /// The six indicators added to `ta` must each report the signal their
    /// meaning supports — and, just as importantly, must report "—" where no
    /// directional reading exists rather than inventing one.
    #[test]
    fn new_kinds_report_only_the_signals_they_support() {
        let doc = r#"{
            "kind": "ta",
            "indicators": {
                "dto14": 0.42,
                "supertrend10_3": 98.0,
                "vr_lm5": 1.35,
                "kalman20": {"level": 103.0, "slope": 0.4, "kalmanGain": 0.3},
                "hurst128": 0.66,
                "volsig20": 2.1
            },
            "_meta": {"rowsUsed": 300, "lastClose": 103.2, "source": "btcusdt"}
        }"#;
        let summaries = super::collect_ta_summaries(&kawai_router::ExecutionResult {
            results: vec![step("ta1", doc)],
        });
        let table = super::indicator_summary_block(&summaries);

        // Directional where the reading genuinely has one.
        assert!(table.contains("| DTO (14) | 0.42 | Bullish |"), "{table}");
        assert!(table.contains("| VR_LM (5) | 1.35 | Trending |"), "{table}");
        assert!(table.contains("| SUPERTREND (10,3) | 98 | Bullish |"), "{table}");
        // Hurst and volume activity carry no direction, so the cell is "—".
        assert!(table.contains("| HURST (128) | 0.66 | — |"), "{table}");
        assert!(table.contains("| VOLSIG (20) | 2.1 | — |"), "{table}");
    }

    /// A step that asked for no statistics must not produce the table, and one
    /// that did must get it — under its own heading, with no `Sinyal` column,
    /// because a Sharpe ratio has no direction to report.
    #[test]
    fn performance_table_renders_only_requested_metrics() {
        let bare = super::collect_ta_summaries(&kawai_router::ExecutionResult {
            results: vec![step("ta1", TA_OUTPUT)],
        });
        assert!(super::indicator_summary_block(&bare).contains("Ringkasan Indikator"));
        assert!(!super::indicator_summary_block(&bare).contains("Performa & Risiko"));

        let with_metrics = super::collect_ta_summaries(&kawai_router::ExecutionResult {
            results: vec![step("ta1", TA_WITH_METRICS)],
        });
        let table = super::indicator_summary_block(&with_metrics);
        assert!(table.contains("## Performa & Risiko"), "{table}");
        assert!(table.contains("| Sharpe Ratio | 1.82 |"), "{table}");
        assert!(table.contains("| Max Drawdown | 0.243 |"), "{table}");
        // Magnitudes, not directions — the signal column stays indicator-only.
        assert!(table.contains("| RSI (14) | 62.31 | Netral |"), "{table}");
        assert!(!table.contains("Bullish | 1.82"));
    }

    #[test]
    fn performance_labels_cover_every_metric_kind() {
        // A metric the supervisor does not recognize must still render a row
        // rather than silently vanishing from the deliverable.
        let unknown = r#"{"kind":"ta","indicators":{"rsi14":50.0},
            "metrics":{"some_new_ratio":1.5},"_meta":{"source":"x"}}"#;
        let summaries = super::collect_ta_summaries(&kawai_router::ExecutionResult {
            results: vec![step("ta1", unknown)],
        });
        assert!(super::indicator_summary_block(&summaries).contains("| Metrik | 1.5 |"));
    }

    #[test]
    fn empty_request_is_the_only_way_to_get_no_tables() {
        let result = kawai_router::ExecutionResult {
            results: vec![step("page", "plain text")],
        };
        assert!(super::indicator_summary_block(&super::collect_ta_summaries(&result)).is_empty());
    }

    #[test]
    fn indicator_table_empty_without_ta_steps() {
        let result = kawai_router::ExecutionResult {
            results: vec![step("page", "plain text")],
        };
        assert!(super::indicator_summary_block(&super::collect_ta_summaries(&result)).is_empty());
    }

    #[test]
    fn synthesis_materials_rank_structured_outputs_first() {
        let long_page = "x".repeat(5_000);
        let plan = kawai_router::TaskPlan {
            goal: "g".into(),
            steps: vec![
                TaskStep {
                    id: "page".into(),
                    agent_id: "webread".into(),
                    ..Default::default()
                },
                TaskStep {
                    id: "ta".into(),
                    agent_id: "analytics".into(),
                    ..Default::default()
                },
            ],
            final_writer: None,
            summary: None,
            template: None,
};
        let result = kawai_router::ExecutionResult {
            results: vec![
                step("page", &long_page),
                step("ta", r#"{"kind":"ta","indicators":{"rsi14":71.0},"_meta":{}}"#),
            ],
        };
        let materials = super::synthesis_materials(&plan, &result);
        let ta_pos = materials.find("\"ta\"").expect("ta step present");
        let page_pos = materials.find("webread").expect("page step present");
        // The small kind-marked step outranks the 5k page regardless of plan order.
        assert!(ta_pos < page_pos);
        assert!(materials.contains("\"rsi14\":71.0"));
    }
}

#[test]
fn chart_tokens_survive_run_charts_and_store_ids() {
    let charts = vec![RunChart {
        file_id: "chart-1".into(),
        label: "Harga".into(),
        mark: "bar".into(),
    }];
    let text = "lead\n\n![Harga](kawai-file://chart-1)\n\n![Klip](kawai-file://video-9)\n\n![hantu](kawai-file://nope)";
    let out = strip_chart_tokens_with(text, &charts, &|id| id == "video-9");
    assert!(out.contains("![Harga](kawai-file://chart-1)"), "run chart token survives");
    assert!(out.contains("![Klip](kawai-file://video-9)"), "store-resolving token survives");
    assert!(!out.contains("kawai-file://nope"), "unknown id stripped");
    assert!(out.contains("hantu"), "caption text kept");
}

#[test]
fn chart_tokens_strip_when_nothing_resolves() {
    let charts: Vec<RunChart> = Vec::new();
    let text = "a ![x](kawai-file://gone) b";
    let out = strip_chart_tokens_with(text, &charts, &|_| false);
    assert_eq!(out, "a x b");
}
