# Supervisor Implementation Plan

## Goal

Supervisor adalah program Rust yang mengeksekusi plan secara deterministik. LLM (Gemma 4 atau remote) hanya dipakai di dalam subagent yang membutuhkan reasoning.

## Terminologi

| Istilah | Definisi |
|---|---|
| **Supervisor** | Program Rust. Membaca plan JSON, mengeksekusi step per step, mengumpulkan artifacts. Tidak ada LLM, tidak ada context, tidak ada inference. |
| **Subagent** | Tool yang di dalamnya ada loop LLM. Menerima task + artifacts → reasoning → hasil. Contoh: `analyze_data`, `create_deck`, `plan_task`. |
| **Pure tool** | Tool Rust murni tanpa LLM: `pdf_merge`, `stock_market_api`, `email_send`. |
| **Planner** | Subagent remote LLM yang menghasilkan ExecutionPlan. |

## Prinsip desain

```
Supervisor berpikir? Tidak. Supervisor = workflow engine Rust.

Siapa yang berpikir? LLM di dalam subagent.
```

```text
Rust Supervisor membaca plan:
  step 1 → dispatch analyze_data → subagent LLM bekerja → artifact
  step 2 → dispatch create_deck → subagent LLM bekerja → artifact
  step 3 → dispatch email_send → Rust execute → selesai

Tidak ada Gemma di level supervisor.
Gemma hanya di dalam subagent yang butuh reasoning.
```

## Architecture

```
User task
  ↓
Planner (subagent, remote LLM)
  ↓ ExecutionPlan JSON
  ↓
Rust Supervisor (deterministik, tanpa LLM)
  ↓ dispatch per step
  ↓
Subagent / pure tools:
  analyze_data    → LLM remote/lokal + data tools (context fresh, dibuang setelah selesai)
  create_deck     → LLM remote/lokal + office tools (context fresh, dibuang setelah selesai)
  stock_market_api → Rust murni
  email_send      → Rust murni
  ↓
Artifacts dikumpulkan → input step berikutnya
  ↓
Final answer dari step terakhir
```

### Siapa yang berpikir kapan

| Level | Siapa | Berpikir? | Context |
|---|---|---|---|
| Supervisor | **Rust** | **Tidak** — eksekusi mekanis | Tidak ada |
| Planner | **Remote LLM** | **Ya** — decompose task → plan | Remote pool (selesai → dibuang) |
| Subagent (analyze_data) | **LLM** | **Ya** — data_schema → data_query → chart | Fresh per call, dibuang setelah selesai |
| Subagent (create_deck) | **LLM** | **Ya** — susun konten → create deck | Fresh per call, dibuang setelah selesai |
| Pure tool (pdf_merge) | **Rust** | **Tidak** | Tidak ada |

### Gemma 4 hanya dipakai di

```text
1. Planner       → remote LLM (satu call)
2. Subagent      → remote LLM atau Gemma lokal (per step yang butuh reasoning)
```

**Supervisor tidak pernah memakai Gemma.** Supervisor = Rust.

### Kenapa ini lebih baik dari Supervisor Gemma

| Supervisor Gemma | Supervisor Rust |
|---|---|
| Prefill supervisor setiap task | Tidak ada prefill — Rust instant |
| Context supervisor hidup sepanjang task | Tidak ada context |
| Epoch/reset per subagent + rebuild supervisor | Tidak perlu rebuild — supervisor tidak punya context |
| Supervisor persona + tools manifest | Tidak ada persona — supervisor cuma pembaca plan |
| Risk: Gemma lupa ikuti plan | Tidak ada risk — Rust mengikuti plan persis |
| Multi-prefill per task (supervisor + subagents) | Prefill HANYA per subagent (0 untuk supervisor) |

## ExecutionPlan Schema

```json
{
  "userObjective": "Analisa data CSV lalu buat presentasi untuk direksi",
  "plannerStatus": "success",
  "execution": {
    "allowParallel": true,
    "defaultTimeoutMs": 30000,
    "defaultOnError": "fail",
    "maxSteps": 8
  },
  "executionPlan": [
    {
      "id": "analyze",
      "task": "Baca CSV penjualan, identifikasi tren revenue per bulan dan top 5 produk",
      "tool": "analyze_data",
      "arguments": {
        "input": { "artifact": "user_file_xyz" }
      },
      "dependsOn": [],
      "produces": ["analysis_result"],
      "timeoutMs": 60000,
      "retries": 1,
      "onError": "fail"
    },
    {
      "id": "create_deck",
      "task": "Buat presentasi 8 slide untuk direksi berdasarkan hasil analisis: executive summary, revenue trend, top produk, kesimpulan",
      "tool": "create_deck",
      "arguments": {
        "input": { "fromStep": "analyze", "output": "analysis_result" }
      },
      "dependsOn": ["analyze"],
      "produces": ["presentation_deck"],
      "timeoutMs": 60000
    },
    {
      "id": "send_email",
      "task": "Kirim laporan ke boss@company.com",
      "tool": "email_send",
      "arguments": {
        "to": "boss@company.com",
        "subject": "Laporan Analisis Bulanan",
        "attachment": { "fromStep": "create_deck", "output": "presentation_deck" }
      },
      "dependsOn": ["create_deck"],
      "requiresConfirmation": true
    }
  ]
}
```

## Rust Supervisor (pseudocode)

```rust
async fn execute_plan(
    plan: ExecutionPlan,
    tool_registry: &ToolRegistry,
    user_id: &str,
    session_id: i64,
) -> Result<ExecutionResult, Error> {
    let mut artifacts: HashMap<String, Artifact> = HashMap::new();
    let mut step_status: HashMap<String, StepStatus> = HashMap::new();

    loop {
        // Cari step yang ready (all dependencies completed)
        let ready = plan.steps.iter()
            .filter(|s| !step_status.contains_key(&s.id))
            .filter(|s| s.depends_on.iter().all(|dep| step_status.get(dep) == Some(&StepStatus::Completed)));

        if ready.is_empty() { break; }

        for step in ready {
            // Resolve artifact references → actual handles
            let args = resolve_args(&step.arguments, &artifacts)?;

            // Dispatch ke tool
            let result = timeout(
                Duration::from_millis(step.timeout_ms.unwrap_or(default_timeout)),
                dispatch_tool(&step.tool, &args, user_id, session_id),
            ).await;

            match result {
                Ok(Ok(artifact)) => {
                    artifacts.insert(step.id.clone(), artifact);
                    step_status.insert(step.id.clone(), StepStatus::Completed);
                }
                Ok(Err(e)) | Err(_) => {
                    match step.on_error {
                        OnError::Fail => return Err(...),
                        OnError::Skip => { step_status.insert(step.id, StepStatus::Skipped); }
                        OnError::Continue => { /* mark failed but continue */ }
                    }
                }
            }
        }
    }

    Ok(ExecutionResult { artifacts, step_status })
}

async fn dispatch_tool(
    tool_name: &str,
    args: &ResolvedArgs,
    user_id: &str,
    session_id: i64,
) -> Result<Artifact, Error> {
    match tool_registry.get(tool_name)? {
        // Pure Rust tool — instant, no LLM
        Tool::Pure(handler) => handler(args).await,

        // Subagent — loop LLM di dalam
        Tool::Subagent(handler) => handler.execute(args, user_id, session_id).await,
    }
}
```

## Execution properties

### onError + retries

| onError | Perilaku |
|---|---|
| `fail` (default) | Step Failed → plan berhenti, dependents Skipped |
| `skip` | Step Skipped → plan lanjut, dependents juga Skipped |
| `continue` | Step Failed → plan lanjut, dependents jalan dengan penanda gagal |

`retries: N` — ulang N kali, backoff linear (1s, 2s, 4s…). Habis retry → onError.

### allowParallel

Root-level. Step independen bisa paralel via JoinSet.

```text
Subagent remote → paralel aman (cloud calls independen)
Pure tools      → paralel aman (Rust async)
Subagent lokal  → sequential (Gemma singleton)
```

### timeoutMs

Per-step. Default: network 15-30s, subagent 60s, pure local 60s. Timeout → failure → retries/onError.

### requiresConfirmation

Side-effect tools butuh approval user sebelum eksekusi. `ConfirmationRequest` event yang sudah ada.

### fromStep + output

Artifact hand-off. Data tidak masuk context — hanya handles.

## Existing infrastructure

| Component | Dipakai untuk |
|---|---|
| Scheduler wave-based (crates/router) | Parallel dispatch, failure propagation |
| plan.rs validation | Validasi ExecutionPlan |
| deep_write handler | Pola subagent handler baru |
| ConfirmationRequest | Gate sebelum side-effect |
| TurnMemory + session_artifacts | Artifact storage |
| Remote LLM pool | Subagent remote + planner |

## Implementation Status

- **Phase 1 — Scheduler resilience: implemented.** `kawai-router` now supports per-step/default timeouts, retries with linear backoff, `onError` policies (`fail`/`skip`/`continue`), confirmation handlers, retry accounting, and result helpers. The scheduler remains backward-compatible with plans that omit these optional fields.
  - Default `OnError::Fail` stops the entire plan on any step failure (all unresolved steps become Skipped).
  - `OnError::Skip` / `OnError::Continue` propagate to transitive dependents only; independent steps keep running.
  - A step requiring confirmation blocks dispatch until the handler approves or rejects.
- **Phase 2 — Typed artifacts: implemented.** `StepResult` carries typed `Artifact` values (`Text`, `File`, `Structured`, `Handle`) alongside the human-readable summary. Artifact hand-off is metadata-first: large payloads are represented by stable handles, never copied through planner context.
- **Phase 2A — Artifact references: implemented.** `TaskStep.arguments` accepts nested `{ "fromStep": ..., "output": ... }` references. `kawai_router::resolve_args` resolves them recursively against completed step results before dispatch.
- **Phase 3 — Tool dispatch registry: implemented.** `kawai-router` now provides a transport-agnostic tool registry, richer planner prompt, and resolved-argument dispatch.
  - `ToolKind` (`Pure` / `Subagent`) + `ToolMeta` (name, description, I/O schemas) in `types.rs`.
  - `TaskStep::tool: Option<String>` preferred over `agent_id`; `TaskStep::produces: Vec<String>` declares artifact names.
  - `ToolRegistry` (new `registry.rs`): validates plans against the catalog, renders catalog lines for the planner prompt, and provides a `step_dispatch()` adapter that bridges the registry's `ToolDispatch` closure into the scheduler's `StepDispatch` type.
  - `plan_prompt_with_tools` in `plan.rs` emits the full ExecutionPlan contract: `tool`, `arguments` with artifact references, `produces`, `timeoutMs`, `retries`, `onError`, `requiresConfirmation`, `confirmationDescription`.
  - Scheduler now resolves artifact references via `resolve_args` before invoking the dispatcher (3-arg `StepDispatchFn`); resolution errors fail the step deterministically without retries.
  - Unknown-tool and unknown-artifact-reference failures are surfaced through the existing `onError` / retry paths.
- **Phase 4 — Composition-root wiring: implemented.** `src-tauri/src/supervisor.rs` now builds a per-session supervisor registry from the existing office toolset, converts tool definitions into `ToolMeta`, and dispatches resolved arguments through `ToolSet::execute`. `SupervisorEvent` provides plan/step lifecycle events, and `execute_plan_stream` wraps the deterministic router scheduler. The operation is exposed as `execute_supervisor_plan` through both Tauri (`commands.rs`) and Axum SSE (`web.rs`), with edge-authenticated user identity and stream cancellation on desktop.
  - Current registry uses the office toolset as the broadest available catalog; concrete artifact extraction (`File`/`Handle`/`Structured`) remains the next adapter refinement because `ToolSet::execute` currently exposes only a string body.
  - The endpoint is feature-gated behind `router + litert`, and office-backed registry construction is unavailable without the `office` feature.
- **Phase 5A — Session-aware dispatch and typed artifacts: implemented.** Supervisor requests require `sessionId`; both Tauri and Axum validate it against the authenticated user's per-user database before constructing the registry. Tool output is retained as text and promoted to typed `Text`, `Structured`, or file-backed `File` artifacts when the output envelope contains a file id and filename.
- **Phase 5B — Live progress streaming: implemented.** `SchedulerObserver` and `SchedulerEvent` provide synchronous step lifecycle notifications. `StepStarted` is emitted immediately before dispatch; `ConfirmationRequested` is emitted when a confirmation gate is reached. Completion, failure, and skip events are forwarded through the supervisor stream without duplicate terminal step events. Tauri Channel and Axum SSE expose the same event sequence.
- **Phase 5C — Cooperative cancellation: implemented.** `run_plan_with_cancel` and `execute_plan_stream_with_cancel` accept the transport cancellation token. Cancellation prevents subsequent waves from starting and terminates the plan stream with a terminal failure event. Existing `run_plan` and `execute_plan_stream` remain backward-compatible wrappers. Active tool calls currently finish before cancellation is observed.
- **Phase 6 — Confirmation UX: implemented end to end.** `ConfirmationRequested` events carry `streamId + stepId`. Pending gates are parked on oneshot channels in `PendingConfirmations` state, keyed by the composite identity. The frontend `useSupervisorPlan` hook runs `execute_supervisor_plan`, tracks per-step progress and pending confirmations, and responds through `respond_supervisor_confirmation` (Tauri command + Axum `POST /api/respond_supervisor_confirmation`). Stale senders are swept when a plan stream terminates. Legacy `run_plan` callers can still pass a blocking `ConfirmationHandler`.

### Artifact contract

- `Text` — small textual results only (bounded summaries).
- `File` — files in the user store; carries `handle` + optional `mime`/`filename`.
- `Structured` — compact JSON data (query results, market data).
- `Handle` — persisted/paginated results; `kind` names the retrieval channel (e.g. `artifact_recall`).
- Reference form in arguments: `{ "fromStep": "<id>", "output": "<artifact name>" }` — `output` matches `File.filename` or `Handle.kind`; omitting `output` yields `{ "stepId", "output" }` summary metadata.
- Large bodies must never ride inside `Structured`/`Text`; use handles.

### Current execution policy

Supervisor is now the sole desktop execution path. `agent_chat` is no longer selected by the frontend, including as an error fallback, and is no longer registered as a Tauri command or Axum route. The legacy `useLocalChat` hook has been removed. Session/history shell state now lives in `useSupervisorChat`, while Supervisor owns desktop execution, messages, confirmations, and progress.

### Known follow-ups

- Active dispatch cancellation is not yet interruptible; tool implementations need a cancellation-aware execution contract.
- The frontend has no planner entry point yet: `useSupervisorPlan.runPlan` exists but nothing in the app produces a validated `TaskPlan` (next milestone: a `plan_task` planner command/agent-chat integration).
- Registry composition currently uses the office toolset as a broad superset; register analytics/binance/domain-specific tools based on actual feature availability.
- File artifact detection is envelope-based; add store-aware adapters and explicit output schemas for reliable `File`/`Handle` distinction.
- Retry backoff is hard-coded seconds; consider a configurable backoff strategy.
- `max_parallel: 0` should be clamped or rejected at validation time.

## Implementation Order

| Step | What |
|---|---|
| 1 | Schema types: `ExecutionPlan`, `PlanStep`, `ExecutionPolicy`, `Artifact` di `crates/router` |
| 2 | Rust Supervisor executor: read plan → resolve args → dispatch → collect artifacts → onError/retries/parallel |
| 3 | Tool dispatch: `Tool::Pure` + `Tool::Subagent` enum, registry lookup |
| 4 | Tool catalog metadata (nama + deskripsi + I/O) untuk planner prompt |
| 5 | Planner prompt: task → ExecutionPlan JSON |
| 6 | Subagent handler baru (remote pool): `analyze_data`, `create_deck`, `fetch_market_data` — pola `deep_write` |
| 7 | `requiresConfirmation` gate |
| 8 | `allowParallel` untuk step independen |
| 9 | Integration test |

## What gets removed

| Component | Nasib |
|---|---|
| Supervisor persona/Gemma | Tidak perlu — supervisor = Rust |
| Keyword matching | Sudah terhapus |
| LLM routing classifier | Hapus — planner + subagent menggantikan |
| Agent-as-executor | Tidak dibangun — digantikan subagent tools |
| AgentDefinition sebagai entry point | Agent domain → metadata subagent + persona internal |
| Frontend agent selection | Hapus |

## File changes summary

| File | Change |
|---|---|
| `crates/router/src/types.rs` | ExecutionPlan, PlanStep, ExecutionPolicy, Artifact types |
| `crates/router/src/scheduler.rs` | Rust executor loop (retries, timeout, onError, parallel) |
| `crates/router/src/plan.rs` | ExecutionPlan validation |
| `crates/engines/agent/src/subagents.rs` | analyze_data/create_deck/fetch_market_data handlers + planner prompt |
| `src-tauri/src/agent_registry.rs` | Tool registry: Tool::Pure + Tool::Subagent |
| `src-tauri/src/commands.rs` | Rust supervisor entry point |
| `src-tauri/src/web.rs` | Rust supervisor entry point |
| `src-tauri/src/logic/agent/routing.rs` | Delete |
| `crates/router/src/classifier.rs` | Delete |
| `frontend/src/App.tsx` | Hapus agent selection |
