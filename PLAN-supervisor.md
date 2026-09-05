# Supervisor

## Goal

Supervisor adalah program Rust yang mengeksekusi plan secara deterministik. LLM hanya menulis plan (planner) dan bekerja di dalam subagent — supervisor sendiri tidak pernah melakukan inference.

## Terminologi

| Istilah | Definisi |
|---|---|
| **Supervisor** | Program Rust. Membaca `TaskPlan` tervalidasi, mengeksekusi step dalam gelombang (waves), mengumpulkan artifacts. Tidak ada LLM, tidak ada context. |
| **Subagent** | Tool yang di dalamnya ada loop LLM (remote pool, atau lokal saat tak ada kandidat cloud). Contoh: `deep_write`, `draft_document`, `plan_task`. |
| **Pure tool** | Tool Rust murni tanpa LLM: `pdf_merge`, `binance_price`, `data_query`. |
| **Planner** | LLM (bounded search loop) yang menghasilkan `TaskPlan`, tervalidasi `ToolRegistry` sebelum dieksekusi. |
| **TurnMemory** | Log proses per session (`session_artifacts`): hasil tiap step selesai di-record dengan handle `memN`; output besar di-paging via `artifact_recall(handle, offset)`. |

## Prinsip desain

```
Supervisor berpikir? Tidak. Supervisor = workflow engine Rust.

Siapa yang berpikir? Planner saat menyusun plan; subagent saat step dieksekusi.
```

```text
Rust Supervisor membaca plan tervalidasi:
  wave 1 → dispatch step tanpa dependensi (paralel ≤ max_parallel)
  wave 2 → dispatch step yang dependensinya Completed
  ...
  final_output = output step Completed terakhir

Tidak ada LLM di level supervisor. LLM hanya di planner dan subagent.
```

## Architecture (end to end)

```
frontend                          commands.rs                 supervisor.rs                 crates/router
────────                          ───────────                 ─────────────                 ─────────────
streamOperation(                  execute_supervisor_plan
  "execute_supervisor_plan",      │ verify session
   plan, sessionId, streamId) ───▶│ agent_id dikenal? →
                                  │   specialist, else auto    ◀─ registry yang SAMA
                                  │ build_supervisor_ ────────▶   dengan yang dipakai
                                  │   registry                   plan_task
                                  │ execute_plan_stream_ ─────▶ execute_plan_stream_
                                  │   with_cancel(plan,          with_cancel:
                                  │   registry, token,           │ yield PlanStarted
                                  │   pending, stream_id)        │ run_plan_with_cancel ──▶ 1. validate_structure
                                  │                             │ + ConfirmationHandler        2. LOOP waves: ready =
                                  │                             │   (park oneshot per step)       dependsOn semua Completed;
                                  │                             │ + SchedulerObserver ──────▶     spawn ≤ max_parallel
                                  │                             │   (SchedulerEvent → mpsc)       per step: resolve args
                                  │                             │                                 (fromStep → artifacts)
                                  │                             │                                 ▶ confirmation? park
                                  │                             │                                 ▶ timeout × (1+retries)
                                  │                             │                                   dispatch → ToolSet::
                                  │                             │                                   execute → AgentTool.call
                                  │                             │                                 ▶ sukses → StepResult +
                                  │                             │                                   TurnMemory record (memN)
                                  │                             │                                 ▶ gagal → onError:
                                  │                             │                                   fail → halt plan;
                                  │                             │                                   skip/continue → step
                                  │                             │                                   Failed + dependen
                                  │                             │                                   transitif Skipped;
                                  │                             │                                   cabang independen jalan
                                  │                             │ 3. ExecutionResult +
                                  │                             │    final_output()
                                  │ tokio::select!              │
                                  │   cancelled() → break       │
                                  │   stream.next() → send ─────┼── SupervisorEvent → Channel
                                  ▼
use-supervisor-plan.ts: switch(ev.type) → step state → PlanProgressPanel
                        + persist PersistedPlan ke SQLite (append_chat_message)
```

### Siapa yang berpikir kapan

| Level | Siapa | Berpikir? | Context |
|---|---|---|---|
| Supervisor | **Rust** | **Tidak** — eksekusi mekanis | Tidak ada |
| Planner | **Remote LLM** | **Ya** — decompose task → plan | Remote pool (selesai → dibuang) |
| Subagent (deep_write / draft_document) | **LLM** | **Ya** — loop sintesis di dalam tool | Remote pool + TurnMemory materials; context agent di-reset saat takeover |
| Subagent (data_query_nl) | **LLM** | **Ya** — terjemahan NL → structured query | Fresh per call |
| Pure tool (pdf_merge, data_query) | **Rust** | **Tidak** | Tidak ada |

### LLM hanya dipakai di

```text
1. Planner    → cloud pool (failover sehat; KAWAI_PLANNER_LLM=local untuk dev)
2. Subagent   → deep_write / draft_document / plan_task / plan_revise (remote;
               on-device engine hanya kandidat terakhir pool)
```

**Supervisor tidak pernah memakai LLM.** Supervisor = Rust.

### Kenapa ini lebih baik dari Supervisor Gemma

| Supervisor Gemma (hypothetical) | Supervisor Rust |
|---|---|
| Prefill supervisor setiap task | Tidak ada prefill — Rust instant |
| Context supervisor hidup sepanjang task | Tidak ada context |
| Risk: LLM lupa ikuti plan | Tidak ada risk — Rust mengikuti plan persis |
| Multi-prefill per task (supervisor + subagents) | Prefill HANYA per subagent (0 untuk supervisor) |

## TaskPlan Schema

Sumber tipe: `crates/router/src/types.rs`. Plan yang diteruskan ke
`execute_supervisor_plan` selalu sudah lolos `ToolRegistry::validate_plan`
(struktur, dispatch key ada di registry, confirmation policy, args vs
`input_schema` tool — subset JSON-Schema, fail-fast).

```jsonc
{
  "goal": "Analisa data CSV lalu buat presentasi untuk direksi",
  "steps": [
    {
      "id": "analyze",
      "tool": "data_query",              // dispatch key (agent_id sebagai fallback lama)
      "task": "Identifikasi tren revenue per bulan dan top 5 produk",
      "agentId": "",                       // LLM tidak mengisi; eksekusi tetap by tool
      "dependsOn": [],
      "produces": ["analysis_result"],
      "arguments": { "input": { "artifact": "user_file_xyz" } },
      "timeoutMs": 60000,                  // opsional; override default per step
      "retries": 1,                        // opsional
      "onError": "fail",                   // fail | skip | continue (default fail)
      "requiresConfirmation": false,       // registry-owned policy TIDAK bisa
                                           // dinaikkan oleh planner
      "confirmationDescription": ""
    }
  ]
}
```

Artifact reference di dalam `arguments`: `{ "fromStep": "<id>", "output":
"<artifact name>" }` — di-resolve rekursif oleh `resolve_args` terhadap hasil
step selesai sebelum dispatch; resolution error menggagalkan step tanpa retry.

## Deterministic scheduler (implementasi)

Sumber: `crates/router/src/scheduler.rs` (`run_plan_with_cancel`), lengkap
dengan test. Bukan pseudocode — ini perilaku aktual:

1. **validate_structure** — dependensi harus ada, tidak boleh cycle.
2. **Wave loop** — tiap iterasi mengambil semua step yang `dependsOn`-nya
   sudah `Completed`, spawn paralel sampai `SchedulerLimits::max_parallel`.
3. **Per step (dispatch task):**
   - resolve args (`fromStep` references → artifacts predecessor);
   - `requires_confirmation` → emit `ConfirmationRequested`, park di `oneshot`
     sampai handler approve/reject (key `(stream_id, step_id)` di
     `PendingConfirmations`; reject → `ConfirmationRejected`); stream di-drop
     → `ConfirmationRequired` (gagal);
   - `tokio::time::timeout(effective_timeout)` × `(1 + effective_retries)`
     di sekitar `StepDispatch` (`ToolSet::execute` → `AgentTool.call`);
     `retries_used` tercatat di `StepResult`;
   - sukses → `StepResult { output, artifacts: Vec<Artifact>, retries_used }`
     + `TurnMemory.record(tool, args_key, content)` → handle `mem1, mem2, …`
     (dedup per `(tool, args_key)` yang sama);
   - gagal → `effective_on_error`:
     - `fail` (default) → plan berhenti, semua step tersisa `Skipped`;
     - `skip` / `continue` → step `Failed`, dependen **transitif** di-skip
       (`propagate_skip_transitive`); cabang independen LANJUT.
4. **Cancellation** — token dibatalkan → wave berikutnya tidak dimulai,
   `cancelled_result`; tool yang aktif menyelesaikan diri dulu (follow-up).
5. **Hasil** — `ExecutionResult { results }` in plan order (step yang tidak
   jadi jalan = `Skipped`); `final_output()` = output step `Completed`
   terakhir; `artifacts()` = semua artifact step selesai.

`SchedulerEvent` (`StepStarted` / `ConfirmationRequested` / `StepCompleted` /
`StepFailed` / `StepSkipped`) dikirim via `SchedulerObserver` (wajib cepat &
non-blocking — forward ke channel) dan diterjemahkan `supervisor.rs` menjadi
`SupervisorEvent` untuk transport (Tauri Channel / Axum SSE).

## Existing infrastructure

| Component | Dipakai untuk |
|---|---|
| Scheduler wave-based (crates/router) | Parallel dispatch, failure propagation |
| plan.rs validation | Validasi TaskPlan (struktur + args vs input_schema) |
| deep_write handler | Pola subagent handler |
| ConfirmationHandler + PendingConfirmations | Gate sebelum side-effect |
| TurnMemory + session_artifacts | Artifact storage + `artifact_recall` paging |
| Remote LLM pool | Subagent remote + planner |
| Tool catalog (Turso, crates/foundation/tool-catalog) | Discovery tool planner (drift-gated di CI) |

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
  - `plan_prompt_with_tools` in `plan.rs` emits the full TaskPlan contract: `tool`, `arguments` with artifact references, `produces`, `timeoutMs`, `retries`, `onError`, `requiresConfirmation`, `confirmationDescription`.
  - Scheduler now resolves artifact references via `resolve_args` before invoking the dispatcher (3-arg `StepDispatchFn`); resolution errors fail the step deterministically without retries.
  - Unknown-tool and unknown-artifact-reference failures are surfaced through the existing `onError` / retry paths.
- **Phase 4 — Composition-root wiring: implemented.** `src-tauri/src/supervisor.rs` now builds a per-session supervisor registry from the existing office toolset, converts tool definitions into `ToolMeta`, and dispatches resolved arguments through `ToolSet::execute`. `SupervisorEvent` provides plan/step lifecycle events, and `execute_plan_stream` wraps the deterministic router scheduler. The operation is exposed as `execute_supervisor_plan` through both Tauri (`commands.rs`) and Axum SSE (`web.rs`), with edge-authenticated user identity and stream cancellation on desktop.
  - Current registry uses the office toolset as the broadest available catalog; concrete artifact extraction (`File`/`Handle`/`Structured`) remains the next adapter refinement because `ToolSet::execute` currently exposes only a string body.
  - The endpoint is feature-gated behind `router + litert`, and office-backed registry construction is unavailable without the `office` feature.
- **Phase 5A — Session-aware dispatch and typed artifacts: implemented.** Supervisor requests require `sessionId`; both Tauri and Axum validate it against the authenticated user's per-user database before constructing the registry. Tool output is retained as text and promoted to typed `Text`, `Structured`, or file-backed `File` artifacts when the output envelope contains a file id and filename.
- **Phase 5B — Live progress streaming: implemented.** `SchedulerObserver` and `SchedulerEvent` provide synchronous step lifecycle notifications. `StepStarted` is emitted immediately before dispatch; `ConfirmationRequested` is emitted when a confirmation gate is reached. `PlanStarted` carries the full step structure (`id`/`tool`/`task`/`dependsOn`) so the frontend renders the plan before any step runs; `StepCompleted` carries typed artifact infos (`file` with handle+filename, `structured`, `handle`). Completion, failure, and skip events are forwarded through the supervisor stream without duplicate terminal step events. Tauri Channel and Axum SSE expose the same event sequence, and `PlanProgressPanel` renders it.
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

Supervisor is the sole desktop execution path. Every composer submission follows:

```text
goal → plan_task → validated TaskPlan → execute_supervisor_plan → deterministic scheduler
```

`agent_chat`, `AgentChatEvent`, the prompt-based agent loop, and the legacy `useLocalChat` hook have been removed. Session/history shell state lives in `useSupervisorChat`; execution state, plan progress, and confirmations live in `useSupervisorPlan`.

The planner is remote-LLM-backed. The executor is Rust-only and performs no inference. Tool registries default to **`auto`**: a merged catalog of every available domain toolset (office → presentation → binance → analytics, first-wins per tool name), so the planner picks tools across domains and plans execute cross-domain. An explicit agent id (`builtin.office`, `builtin.presentation`, `builtin.binance`, `builtin.analytics`) narrows the catalog to that domain — the frontend rail is an optional hint, not a requirement. Analytics receives per-user SQL profiles through `effective_profiles(user_id)`.

### Known follow-ups

These are enhancements, not migration blockers:

- **Active cancellation:** cancellation currently stops at wave boundaries; active tools need a cancellation-aware execution contract.
- **Cross-domain plans: implemented for `auto`.** The `auto` registry merges all domain toolsets, so plans may mix tools from any domain. Per-domain narrowing via explicit agent id remains available; a policy for merging *restricted* cross-domain catalogs (e.g. analytics without office write tools) is open if needed.
- **Artifact contracts:** file detection currently recognizes common output envelopes; explicit per-tool output schemas and store-aware adapters would improve reliability.
- **Scheduler tuning:** `max_parallel` is currently conservative (`2`) and retry backoff is fixed; make them configurable only when workload evidence requires it.
- **Transport coverage:** executor-level confirmation tests exist; a Tauri Channel/UI-level integration test would add release confidence.
- **Offline planning:** without a configured remote provider, `plan_task` returns a clear configuration error. A local or rule-based fallback is a product decision.

## Delivered implementation

| Area | Status |
|---|---|
| Router schema, validation, artifact references | ✅ Complete |
| Deterministic scheduler: dependencies, waves, parallelism, retries, timeout, `onError` | ✅ Complete |
| Tool registry and metadata-driven planner prompt | ✅ Complete |
| Tauri + Axum Supervisor execution endpoints | ✅ Complete |
| Office, presentation, analytics, and Binance registry composition | ✅ Complete |
| Per-user analytics SQL profile binding | ✅ Complete |
| Typed artifacts and file output mapping | ✅ Complete; schema refinement remains optional |
| Confirmation gates and composite `streamId + stepId` identity | ✅ Complete |
| Tauri Channel/SSE progress events | ✅ Complete |
| Cooperative cancellation | ✅ Complete; active-tool cancellation remains a follow-up |
| Frontend hard cutover and session persistence | ✅ Complete |
| Legacy `agent_chat` engine, event, transport, hook, and examples | ✅ Purged |
| Supervisor confirmation integration tests | ✅ Complete |

The original implementation sequence is complete. Future work is tracked under **Known follow-ups** and should be treated as product hardening or feature expansion, not migration work.

## Current file map

| Area | Responsibility |
|---|---|
| `crates/router/` | Transport-agnostic plan types, validation, registry, scheduler, artifacts, and planner prompt |
| `src-tauri/src/supervisor.rs` | Composition-root registry adapter, execution stream, confirmation state, Supervisor events, and tests |
| `src-tauri/src/agent_registry.rs` | Domain toolset composition for office, presentation, analytics, and Binance |
| `src-tauri/src/commands.rs` | Authenticated Tauri planner, executor, cancellation, and confirmation wrappers |
| `src-tauri/src/web.rs` | Authenticated Axum planner/executor/confirmation transport wrappers |
| `frontend/src/features/chat/hooks/use-supervisor-plan.ts` | Plan state (source of truth), plan creation, execution progress, confirmation actions, UI message projection, and persistence |
| `frontend/src/features/chat/hooks/use-supervisor-chat.ts` | Session/history shell and auth bootstrap |
| `frontend/src/features/chat/components/plan-progress-panel.tsx` | Live plan view: step structure (tool, task, dependencies), per-step status, and artifact rendering (file preview / structured / handle) |
| `.github/workflows/ci.yml` | Supervisor planner smoke coverage |

Legacy agent-chat files and event types are not part of the current architecture.
