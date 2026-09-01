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
            task: s.task.clone(),
            depends_on: s.depends_on.clone(),
        })
        .collect()
}

/// Progress events emitted by the supervisor as it executes a plan.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
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
    #[cfg(feature = "analytics")]
    let sql_profiles = kawai_analytics::effective_profiles(user_id).await;
    let context = kawai_agent_contract::AgentContext {
        user_id,
        session_id,
        sql_profiles: {
            #[cfg(feature = "analytics")]
            { Some(sql_profiles.as_slice()) }
            #[cfg(not(feature = "analytics"))]
            { None }
        },
    };

    // Domain builders. Do not expose the office superset to analytics/binance
    // plans when a specialist is chosen explicitly.
    let office = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "office")]
        { agent_registry::office_tools(&context, remote_configured) }
        #[cfg(not(feature = "office"))]
        {
            let _ = (&context, remote_configured);
            None
        }
    };
    let presentation = || -> Option<kawai_tools::ToolSet> {
        #[cfg(feature = "office")]
        { agent_registry::presentation_tools_for_supervisor(&context, remote_configured) }
        #[cfg(not(feature = "office"))]
        {
            let _ = (&context, remote_configured);
            None
        }
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

    if agent_id == AUTO_AGENT_ID {
        // Merged catalog: first-wins per tool name. Office first — its
        // knowledge/memory/subagent tools are the broadest base — then the
        // specialists fill in their exclusive domain tools.
        let mut merged: Option<kawai_tools::ToolSet> = None;
        for set in [office(), presentation(), binance(), analytics()].into_iter().flatten() {
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
) -> Result<kawai_router::TaskPlan, String> {
    let remote = remote_llm::RemoteLlm::from_env()
        .ok_or_else(|| "remote LLM is not configured".to_string())?;

    // User context rides the planner call: persona + goal-relevant memories
    // + skills. All three are best-effort — planning never fails on them.
    let persona_block = kawai_memory::persona_prompt_block(user_id).await;
    let memories_block = kawai_memory::prompt_block_relevant(user_id, goal).await;
    let skills_block = kawai_skills::prompt_block(user_id).await;
    let context = render_planner_context(persona_block, memories_block, skills_block);

    let prompt = kawai_router::plan_prompt_with_tools(registry);
    let user_message = if context.is_empty() {
        format!("{prompt}\n\nUser goal:\n{goal}")
    } else {
        format!("{context}\n\n{prompt}\n\nUser goal:\n{goal}")
    };
    let mut stream = remote.stream(
        "You produce valid JSON plans and never execute tools.",
        &user_message,
        "",
    ).await?;
    let mut raw = String::new();
    while let Some(event) = stream.next().await {
        if let remote_llm::RemoteEvent::Token { text } = event? {
            if raw.len() < 32_000 { raw.push_str(&text); }
        }
    }
    parse_supervisor_plan(&raw, registry)
}

pub fn parse_supervisor_plan(raw: &str, registry: &ToolRegistry) -> Result<kawai_router::TaskPlan, String> {
    let slice = kawai_router::extract_json_slice(raw).map_err(|e| e.to_string())?;
    let plan: kawai_router::TaskPlan = serde_json::from_str(slice)
        .map_err(|e| format!("invalid plan JSON: {e}"))?;
    registry.validate_plan(&plan).map_err(|e| e.to_string())?;
    Ok(plan)
}

pub async fn build_supervisor_registry(
    user_id: &str,
    session_id: i64,
    agent_id: &str,
 ) -> Option<ToolRegistry> {
    let toolset = build_supervisor_toolset(user_id, session_id, agent_id).await?;

    // Convert definitions → ToolMeta.
    let definitions = toolset.get_tool_definitions().to_vec();

    // Build the dispatch closure — captures a cloned ToolSet.
    let dispatch_toolset = toolset;
    let dispatch: ToolDispatch = Arc::new(move |call: ToolCall| {
        let toolset = dispatch_toolset.clone();
        Box::pin(async move {
            let name = call.step.dispatch_key().to_string();
            let args = call.args.to_string();
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

pub fn execute_plan_stream(
    plan: kawai_router::TaskPlan,
    registry: ToolRegistry,
) -> impl Stream<Item = SupervisorEvent> {
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
) -> impl Stream<Item = SupervisorEvent> {
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
                    yield match event {
                        kawai_router::SchedulerEvent::StepStarted { step_id, tool } => SupervisorEvent::StepStarted { step_id, tool },
                        kawai_router::SchedulerEvent::ConfirmationRequested { step_id, task, description } => SupervisorEvent::ConfirmationRequested { stream_id: event_stream_id.clone(), step_id, task, description },
                        kawai_router::SchedulerEvent::StepCompleted { step_id, output } => SupervisorEvent::StepCompleted { step_id: step_id.clone(), output: output.clone(), artifacts: artifact_infos(&output) },
                        kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => SupervisorEvent::StepFailed { step_id, error },
                        kawai_router::SchedulerEvent::StepSkipped { step_id, reason } => SupervisorEvent::StepSkipped { step_id, reason },
                    };
                }
                result = &mut execution => break result,
            }
        };
        // Drain observer events still queued when the scheduler finished —
        // otherwise late stepCompleted/stepFailed events are lost and the UI
        // shows a terminal row without its per-step lifecycle.
        while let Ok(event) = event_rx.try_recv() {
            yield match event {
                kawai_router::SchedulerEvent::StepStarted { step_id, tool } => SupervisorEvent::StepStarted { step_id, tool },
                kawai_router::SchedulerEvent::ConfirmationRequested { step_id, task, description } => SupervisorEvent::ConfirmationRequested { stream_id: event_stream_id.clone(), step_id, task, description },
                kawai_router::SchedulerEvent::StepCompleted { step_id, output } => SupervisorEvent::StepCompleted { step_id: step_id.clone(), output: output.clone(), artifacts: artifact_infos(&output) },
                kawai_router::SchedulerEvent::StepFailed { step_id, error, .. } => SupervisorEvent::StepFailed { step_id, error },
                kawai_router::SchedulerEvent::StepSkipped { step_id, reason } => SupervisorEvent::StepSkipped { step_id, reason },
            };
        }
        match result {
            Ok(result) => {
                // Per-step lifecycle events were forwarded live above. Emit
                // only the terminal plan event here to avoid duplicate UI rows.
                if result.all_completed() {
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

#[cfg(all(test, feature = "router"))]
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
