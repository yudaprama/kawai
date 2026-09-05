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
}

fn artifact_infos(output: &str) -> Vec<ArtifactInfo> {
    tool_output_artifacts(output)
        .iter()
        .map(|a| match a {
            kawai_router::Artifact::File { handle, filename, .. } => ArtifactInfo {
                kind: "file".into(),
                handle: Some(handle.clone()),
                filename: filename.clone(),
            },
            kawai_router::Artifact::Structured { .. } => ArtifactInfo {
                kind: "structured".into(),
                handle: None,
                filename: None,
            },
            kawai_router::Artifact::Handle { kind, .. } => ArtifactInfo {
                kind: "handle".into(),
                handle: kind.clone(),
                filename: None,
            },
            kawai_router::Artifact::Text { .. } => ArtifactInfo {
                kind: "text".into(),
                handle: None,
                filename: None,
            },
        })
        .collect()
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
    },
    StepFailed {
        step_id: String,
        error: String,
    },
    StepSkipped {
        step_id: String,
        reason: String,
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

    if agent_id == AUTO_AGENT_ID {
        // Merged catalog: first-wins per tool name. Office first — its
        // knowledge/memory/subagent tools are the broadest base — then the
        // specialists fill in their exclusive domain tools.
        let mut merged: Option<kawai_tools::ToolSet> = None;
        for set in [office(), presentation(), binance(), analytics(), finance()]
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
/// goal-relevant memories (relevance-ranked; bumps access counters), and the
/// user's skills. Each block degrades to empty on failure. Pure string
/// assembly so tests can pin the shape.
fn render_planner_context(
    persona_block: String,
    memories_block: String,
    skills_block: String,
) -> String {
    if persona_block.is_empty() && memories_block.is_empty() && skills_block.is_empty() {
        return String::new();
    }
    let mut out = String::from("<user-context>\nBackground about the user. Ground decisions in it when relevant; ignore it when not.\n");
    for block in [persona_block, memories_block, skills_block] {
        if !block.is_empty() {
            out.push_str(&block);
            out.push('\n');
        }
    }
    out.push_str("</user-context>");
    out
}

/// Build a [`ToolRegistry`] from the supervisor's toolset.
///
/// The registry contains metadata for the planner prompt and a dispatch
/// closure that delegates to [`kawai_tools::ToolSet::execute`].
pub async fn plan_task(
    user_id: &str,
    goal: &str,
    registry: &ToolRegistry,
) -> Result<(kawai_router::TaskPlan, remote_llm::RemoteUsage), String> {
    // The remote pool serves the planner with a tight per-call output cap:
    // the loop's rounds must stay short (the 2026-02 benchmark showed 14.6k
    // output tokens = the whole 250 s latency).
    let remote = Some(
        remote_llm::RemoteLlm::from_env()
            .map(|r| r.with_output_cap(2_500))
            .ok_or_else(|| "remote LLM is not configured".to_string())?,
    );

    // User context rides the planner call: persona + goal-relevant memories
    // + skills. All three are best-effort — planning never fails on them.
    let persona_block = kawai_memory::persona_prompt_block(user_id).await;
    let memories_block = kawai_memory::prompt_block_relevant(user_id, goal).await;
    let skills_block = kawai_skills::prompt_block(user_id).await;
    let context = render_planner_context(persona_block, memories_block, skills_block);

    // The planner sees NO full catalog. It discovers tools through bounded
    // search rounds against the Turso tool catalog, then emits the plan.
    // Core cross-cutting tools are always visible (retrieval misses them
    // disproportionately — measured, see tool_search_probe).
    let core_tools: Vec<String> = PLAN_CORE_TOOLS
        .iter()
        .filter(|name| registry.get(name).is_some())
        .map(|s| s.to_string())
        .collect();

    // Turso catalog, best-effort: unavailable means searches report empty —
    // the planner then plans from the core set or fails validation. There is
    // deliberately NO full-catalog fallback (mode A).
    let catalog = match kawai_tool_catalog::RemoteConfig::from_env() {
        Some(cfg) => match kawai_tool_catalog::Catalog::open_default(&cfg).await {
            Ok(c) => {
                let _ = tokio::time::timeout(PLAN_SEARCH_SYNC_TIMEOUT, c.sync()).await;
                Some(c)
            }
            Err(_) => None,
        },
        None => None,
    };
    let embedder = kawai_embedding::build_providers_from_env();

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
                    materials.push_str(&run_tool_search(
                        catalog.as_ref(),
                        &embedder,
                        &queries,
                        &mut seen,
                    )
                    .await);
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

/// Search rounds the planner may spend before it must emit the plan.
/// 2 rounds × up to 3 queries per round proved sufficient (probe: every
/// benchmark goal resolved in ≤1 effective round).
const PLAN_SEARCH_ROUNDS: usize = 2;
/// Hard cap on total LLM calls (search rounds + corrections + violations).
const PLAN_MAX_CALLS: usize = 6;
/// Cross-cutting tools retrieval misses disproportionately — always visible.
/// All of them are DIRECTLY dispatchable toolset tools. Internal-dispatch
/// subagent tools (deep_write, draft_document, plan_task, plan_revise,
/// artifact_recall) are deliberately absent — the scheduler executes steps
/// via `ToolSet::execute`, where those tools return an "unavailable here"
/// error text instead of doing their work.
const PLAN_CORE_TOOLS: [&str; 2] = ["web_search", "memory_search"];
/// Subagent/internal-dispatch tools: excluded from the supervisor registry
/// entirely so the planner can neither see nor plan against them.
const NON_DISPATCHABLE_TOOLS: [&str; 5] = [
    "deep_write",
    "draft_document",
    "plan_task",
    "plan_revise",
    "artifact_recall",
];
/// Sync budget — an unreachable Turso must never stall planning.
const PLAN_SEARCH_SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
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
{{"goal": "<one-line goal>", "steps": [{{"id": "s1", "tool": "<exact name>", "task": "…", "arguments": {{}}, "dependsOn": [], "produces": [], "timeoutMs": 30000, "retries": 0, "onError": "fail", "requiresConfirmation": false}}]}}
  (the final plan, once you know which tools to use)

Plan rules:
- Decompose into 1..{} concrete steps; each step names exactly ONE tool.
- "task" is OPTIONAL: a single line ≤80 chars for the progress UI. Omit it
  when the tool name is self-explanatory. ALWAYS keep "arguments" complete
  and precise — the arguments are what the tool executes.
- Be concise overall: no prose outside the JSON, no repeated context.
- "dependsOn" lists step ids that must finish first; no cycles.
- To pass a previous step's artifact: {{"fromStep": "<step id>", "output": "<artifact name>"}} — never paste large content.
- "produces" names the artifacts a step emits for later steps.
- Side-effect tools MUST set "requiresConfirmation": true with a short "confirmationDescription".
- "onError" is one of "fail", "skip", "continue". Default "fail".
- Keep each task description under {} chars.
- Core tools below are ALWAYS available — never search for them:
{}
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
async fn run_tool_search(
    catalog: Option<&kawai_tool_catalog::Catalog>,
    embedder: &kawai_embedding::TenantAwareEmbedder,
    queries: &[String],
    seen: &mut std::collections::HashSet<String>,
) -> String {
    let Some(catalog) = catalog else {
        return "\n<tool-search-results>\nTool catalog is unavailable; rely on the core tools listed above.\n</tool-search-results>\n".to_string();
    };
    let Ok(vecs) = embedder.embed_strings(queries.to_vec()).await else {
        return "\n<tool-search-results>\nTool search failed (embedding unavailable); rely on the core tools listed above.\n</tool-search-results>\n".to_string();
    };
    let mut block = String::from("\n<tool-search-results>\n");
    for (query, qvec) in queries.iter().zip(vecs) {
        block.push_str(&format!("\nquery: {query}\n"));
        let hits = match catalog.search(query, &qvec, 6).await {
            Ok(hits) => hits,
            Err(_) => {
                block.push_str("- (search failed for this query)\n");
                continue;
            }
        };
        let mut listed = 0;
        for hit in hits {
            if !seen.insert(hit.name.clone()) {
                continue; // already visible to the planner
            }
            listed += 1;
            let desc: String = hit.description.chars().take(160).collect();
            let schema: String = hit.input_schema.chars().take(300).collect();
            block.push_str(&format!("- {} — {desc}\n  args: {schema}\n", hit.name));
        }
        if listed == 0 {
            block.push_str("- (no new tools beyond those already listed)\n");
        }
    }
    block.push_str("</tool-search-results>\n");
    truncate_chars(&block, PLAN_MATERIALS_CAP)
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
const NARROW_SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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
    let catalog = kawai_tool_catalog::Catalog::open_default(&cfg)
        .await
        .ok()?;
    let _ = tokio::time::timeout(NARROW_SYNC_TIMEOUT, catalog.sync()).await;
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

pub async fn build_supervisor_registry(
    user_id: &str,
    session_id: i64,
    agent_id: &str,
 ) -> Option<ToolRegistry> {
    let toolset = build_supervisor_toolset(user_id, session_id, agent_id).await?;

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
    let dispatch: ToolDispatch = Arc::new(move |call: ToolCall| {
        let toolset = dispatch_toolset.clone();
        let schemas = Arc::clone(&schemas);
        Box::pin(async move {
            let name = call.step.dispatch_key().to_string();
            let args = coerce_resolved_args(&name, &call.args, schemas.get(&name));
            let args = args.to_string();
            let result = toolset.execute(&name, args).await;

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
                tool_output_artifacts(&output)
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
            })
        })
    });

    let mut registry = ToolRegistry::new(dispatch);
    for def in &definitions {
        registry.register(tool_meta_from_definition(def));
    }

    Some(registry)
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
fn log_scheduler_event(stream_id: &str, event: kawai_router::SchedulerEvent) -> SupervisorEvent {
    let label = match &event {
        kawai_router::SchedulerEvent::StepStarted { step_id, tool } => {
            format!("stepStarted step={step_id} tool={tool}")
        }
        kawai_router::SchedulerEvent::ConfirmationRequested { step_id, .. } => {
            format!("confirmationRequested step={step_id}")
        }
        kawai_router::SchedulerEvent::StepCompleted { step_id, output } => {
            format!("stepCompleted step={step_id} output_len={}", output.len())
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
        kawai_router::SchedulerEvent::StepCompleted { step_id, output } => {
            let artifacts = artifact_infos(&output);
            SupervisorEvent::StepCompleted { step_id, output, artifacts }
        }
        kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => SupervisorEvent::StepFailed { step_id, error },
        kawai_router::SchedulerEvent::StepSkipped { step_id, reason } => SupervisorEvent::StepSkipped { step_id, reason },
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
    )
}

pub fn execute_plan_stream_with_cancel(
    plan: kawai_router::TaskPlan,
    registry: ToolRegistry,
    cancel: tokio_util::sync::CancellationToken,
    pending: PendingConfirmations,
    stream_id: String,
) -> impl Stream<Item = SupervisorEvent> + Send {
    async_stream::stream! {
        let step_count = plan.steps.len();
        yield SupervisorEvent::PlanStarted {
            goal: plan.goal.clone(),
            step_count,
            steps: plan_step_infos(&plan),
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
            pending.lock().expect("pending confirmations poisoned").insert(key.clone(), tx);
            Box::pin(async move {
                match rx.await {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(kawai_router::RouterError::ConfirmationRejected(step_id)),
                    Err(_) => {
                        pending.lock().expect("pending confirmations poisoned").remove(&key);
                        Err(kawai_router::RouterError::ConfirmationRequired(step_id))
                    }
                }
            })
        });

        let limits = kawai_router::SchedulerLimits {
            max_parallel: 2,
            observer: Some(observer),
            confirmation_handler: Some(gate),
            ..Default::default()
        };
        let dispatch = registry.step_dispatch();

        let execution = kawai_router::run_plan_with_cancel(plan.clone(), dispatch, limits, cancel);
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
                        "[supervisor] plan '{}' produced no step results (steps in plan: {step_count})",
                        plan.goal
                    );
                    yield SupervisorEvent::PlanFailed {
                        error: "scheduler produced no step results".into(),
                    };
                } else if result.all_completed() {
                    yield SupervisorEvent::PlanCompleted {
                        final_output: result.final_output().map(String::from),
                    };
                } else {
                    yield SupervisorEvent::PlanFailed {
                        error: result.failures().into_iter().map(|f| {
                            format!("step '{}' failed: {}", f.step_id, f.error.as_deref().unwrap_or("unknown"))
                        }).collect::<Vec<_>>().join("; "),
                    };
                }
            }
            Err(e) => {
                yield SupervisorEvent::PlanFailed {
                    error: e.to_string(),
                };
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
    fn planner_context_omits_empty_blocks_and_wraps_present_ones() {
        assert_eq!(render_planner_context(String::new(), String::new(), String::new()), "");
        let out = render_planner_context(
            "<persona>likes dark UIs</persona>".into(),
            String::new(),
            "<skills>pdf skill</skills>".into(),
        );
        assert!(out.starts_with("<user-context>"));
        assert!(out.contains("<persona>likes dark UIs</persona>"));
        assert!(out.contains("<skills>pdf skill</skills>"));
        assert!(out.ends_with("</user-context>"));
        // No empty block placeholders.
        assert!(!out.contains("<memories>"));
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
