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
| **ExecutionMemo** | Dedup dispatch dalam satu eksekusi plan: panggilan identik (tool + canonical args) yang sudah `Completed` dilayani dari memo, tidak dieksekusi ulang. Kegagalan tidak pernah di-memo — semantik retry utuh. (`crates/router/src/registry.rs`) |
| **TurnMemory** | Log proses di dalam loop subagent (`session_artifacts`): hasil tool subagent di-record dengan handle `memN`, di-paging via `artifact_recall(handle, offset)`. Bukan milik scheduler — supervisor tidak menulis log ini. |

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
                                  │                             │                                   ExecutionMemo dedup (memN)
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
      "tool": "data_query",              // dispatch key (agent_id sebagai fallback)
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
step selesai sebelum dispatch. **Hard-fail hanya terjadi jika:** (1) `fromStep`
merujuk step yang tidak dikenal (`UnknownDependency`), atau (2) predecessor
belum selesai (`Dispatch("artifact source did not complete")`). Named-output miss
**tidak** menggagalkan step — `resolve_args` menjalankan fallback berlapis:
artifact by name → top-level JSON key pada `result.output` → satu-satunya key
(obj tunggal) → seluruh output string. Alasannya pragmatis: tool-side
`validate_arguments` dijalankan saat plan validation sebelum dispatch, dan
`coerce_resolved_args` menambah safety net untuk shape mismatch yang umum;
menggagalkan di resolver akan membuang run percuma. **Trade-off:** planner
tidak pernah menerima sinyal bahwa nama artifact-nya fiktif — error sampai
sebagai generic `tool` failure di failure-driven replan tanpa diagnosa yang
spesifik. Lihat "Artifact reference fallback" di bawah untuk detail.

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
     + `ExecutionMemo.insert` — panggilan identik (tool + canonical args)
     berikutnya dalam plan yang sama dilayani dari memo, tidak dieksekusi
     ulang (guard efek-ganda untuk step duplikat); kegagalan tidak di-memo;
   - gagal → `effective_on_error`:
     - `fail` (default) → plan berhenti, semua step tersisa `Skipped`;
     - `skip` / `continue` → step `Failed`, dependen **transitif** di-skip
       (`propagate_skip_transitive`); cabang independen LANJUT.
4. **Cancellation** — token dibatalkan → wave berikutnya tidak dimulai,
   `cancelled_result`; tool yang aktif menyelesaikan diri dulu (follow-up).
5. **Hasil** — `ExecutionResult { results }` in plan order (step yang tidak
   jadi jalan = `Skipped`); `final_output()` = output step `Completed`
   terakhir; `artifacts()` = semua artifact step selesai.
6. **Resume & replan** — hasil step selesai dipersist ke `supervisor_step_results`
   (migrasi 0015, kunci `session_id + plan_key` = hash plan JSON). Eksekusi ulang
   plan yang sama men- **preseed** `ExecutionMemo` dari tabel itu (step selesai
   dilewati, `fromStep` tetap ter-resolve); kegagalan non-user-decision
   memicu replan (`revise_plan`, budget 1) yang menghasilkan plan baru dengan
   hash baru — tidak pernah memakai baris cache plan lama.

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
| TurnMemory + session_artifacts | Log proses loop subagent; `artifact_recall` paging di dalam subagent (bukan jalur scheduler) |
| Remote LLM pool | Subagent remote + planner |
| Tool catalog (Turso, crates/foundation/tool-catalog) | Discovery tool planner (drift-gated di CI) |

## Current state

| Capability | Behavior |
|---|---|
| Plan types & validation | `TaskPlan`/`TaskStep` in `crates/router/src/types.rs` (caps, unique ids, acyclic deps); `ToolRegistry::validate_plan` checks structure, dispatch keys against the catalog, confirmation policy, and arguments vs each tool's `input_schema` (JSON-Schema subset) — fail-fast before execution. `tool` is the dispatch key; `agent_id` is the fallback. |
| Deterministic scheduler | `run_plan_with_cancel` (wave loop, `max_parallel`), per-step/default timeouts, retries with linear backoff, `onError` (`fail`/`skip`/`continue`), transitive skip propagation. `dispatch_with_retry` owns `retries_used` on the final `StepResult` regardless of what the dispatcher reports — pinned by regression tests. `run_plan` is the blocking-cancellation wrapper. |
| Typed artifacts | `StepResult.artifacts: Vec<Artifact>` (`Text`/`File`/`Structured`/`Handle`). Size policy below. |
| Artifact references | `arguments` accepts nested `{ "fromStep": ..., "output": ... }`; `resolve_args` resolves recursively before dispatch (fallback behavior below). |
| Tool registry & planner prompt | `ToolKind` (`Pure`/`Subagent`) + `ToolMeta` (name, description, I/O schemas); `ToolRegistry` validates plans, renders the planner catalog, and adapts `ToolDispatch` → scheduler `StepDispatch`; `plan_prompt_with_tools` emits the full contract. The `auto` registry merges all domain toolsets (first-wins per tool name); explicit agent ids narrow to a domain. |
| Composition root | `src-tauri/src/supervisor.rs` builds a per-session registry (requires `sessionId`, validated against the authenticated user's per-user DB), converts tool definitions to `ToolMeta`, dispatches via `ToolSet::execute`, and extracts typed artifacts from output envelopes. Exposed as `execute_supervisor_plan` on Tauri (`commands.rs`) + Axum SSE (`web.rs`), feature-gated behind `router + litert`. |
| Progress streaming | `SchedulerObserver`/`SchedulerEvent` → `SupervisorEvent` (Tauri Channel / Axum SSE): `PlanStarted` (full step structure), `StepStarted`, `ConfirmationRequested`, `StepCompleted` (typed artifact infos, ≤2000-char output preview), `StepFailed` (typed `FailureKind`), `StepSkipped`; rendered by `PlanProgressPanel`. |
| Confirmation gates | `ConfirmationRequested` carries `streamId + stepId`; gates park on oneshot channels in `PendingConfirmations`; the frontend responds via `respond_supervisor_confirmation` (Tauri + Axum). Stale senders are swept when a plan stream terminates. |
| Cooperative cancellation | Transport token via `execute_plan_stream_with_cancel`: later waves never start; the plan stream terminates with a terminal failure event; in-flight tools finish first. |
| Failure-driven replan | `StepFailed` carries a typed `FailureKind` (`timeout`/`confirmation`/`cancelled`/`tool`/`other`) set by the scheduler at each error site — no string heuristics. `replan_reason` checks `error_kind` directly to separate user decisions (confirmation rejected, cancelled) from auto-recoverable failures; non-user-decided failures ask the planner for a revised plan (`MAX_REPLANS = 1`, same validation contract). |
| Plan resume | Completed steps persist to `supervisor_step_results` (migration 0015; keyed by `session_id + plan_key`, `plan_key` = SHA-256 of the plan JSON) and preseed the `ExecutionMemo` on re-execution — Resume skips finished steps while `fromStep` references resolve from stored typed artifacts. A revised/edited plan hashes differently and never reuses rows. |
| Tests | Scheduler unit tests (waves, retries, `onError`, `retries_used` contract, cancellation) + executor-level confirmation integration tests; planner smoke coverage in CI. |

### Artifact contract

- `Text` — small textual results only (bounded summaries).
- `File` — files in the user store; carries `handle` + optional `mime`/`filename`.
- `Structured` — compact JSON data (query results, market data).
- `Handle` — persisted/paginated results; `kind` names the retrieval channel (e.g. `artifact_recall`).
- Reference form in arguments: `{ "fromStep": "<id>", "output": "<artifact name>" }` — `output` matches `File.filename` or `Handle.kind`; omitting `output` yields `{ "stepId", "output" }` summary metadata.
- Size policy: full tool output lives in the scheduler (`StepResult.output`, dependent-step `inputs`), the resume memo, and `supervisor_step_results`. Transport events are bounded — `stepCompleted` carries a ≤2000-char preview (`STEP_EVENT_OUTPUT_MAX_CHARS` in `supervisor.rs`); the frontend previews 160 chars and persists 500 chars to history. The plan's final output (`planCompleted.final_output`) is the user-visible answer and is not previewed. `Structured`/`Text` artifacts in persisted step results may therefore hold large bodies — that is the recovery cache's job; the wire never carries them.

### Artifact reference fallback

When `resolve_args` (`crates/router/src/artifacts.rs`) resolves a `{"fromStep": "<id>", "output": "<name>"}` reference, only `fromStep` to an unknown or non-completed predecessor hard-fails. A named-output miss triggers a four-layer fallback (each attempted only if the previous fails):

1. **Artifact by name** — search the predecessor's typed `Vec<Artifact>` by `File.filename` or `Handle.kind`. This is the intended path.
2. **Top-level JSON key** — parse `result.output` as JSON and look up `output` as a key (e.g. `output:"files"` on `{"files":[…]}`). What planners naturally reference for `Structured` outputs.
3. **Single-key object** — if the parsed JSON object has exactly one top-level key, return its value regardless of the requested name. Planners frequently name references after the consuming argument (e.g. `"fileId"`) instead of the produced key.
4. **Whole output string** — `serde_json::json!(result.output)`. The entire source output is forwarded as a JSON string to the consumer.

Fallback 4 is a **diagnostic dead-end**: the consumer's `coerce_resolved_args` (`src-tauri/src/supervisor.rs:817`) can rescue shape mismatches (list→scalar ID extraction, file object unwrapping) **only if** the tool has an `input_schema` with string-typed properties — tools without a schema skip coercion entirely and receive the raw blob. A `eprintln!` warning is emitted on fallback 4 so it is visible in app.log.

**Feedback-loop impact**: the planner never learns that the artifact name was wrong. The step proceeds with whatever the fallback resolved; if the consumer rejects the result, `StepFailed` carries a generic `tool` error kind with no indication that the failure traces back to a misnamed reference. Failure-driven replan (`plan_revise`) re-asks the planner with the execution report, but the report contains only the tool's error message, not the fact that the argument was resolved via a last-resort fallback. This is a **known trade-off** — hard-failing on named-output miss would waste valid runs where the intent is unambiguous (single-key object, list→ID coercion); the trade-off is acceptable because plan validation + tool-side `validate_arguments` catch malformed args before dispatch, and `coerce_resolved_args` handles the common list-to-scalar pattern. Monitoring the `eprintln!` warning rate in app.log will indicate whether this trade-off needs revisiting in production.

### Current execution policy

Supervisor is the sole desktop execution path. Every composer submission follows:

```text
goal → plan_task → validated TaskPlan → execute_supervisor_plan → deterministic scheduler
```

Session/history shell state lives in `useSupervisorChat`; execution state, plan progress, and confirmations live in `useSupervisorPlan`.

The planner is remote-LLM-backed. The executor is Rust-only and performs no inference. Tool registries default to **`auto`**: a merged catalog of every available domain toolset (office → presentation → binance → analytics, first-wins per tool name), so the planner picks tools across domains and plans execute cross-domain. An explicit agent id (`builtin.office`, `builtin.presentation`, `builtin.binance`, `builtin.analytics`) narrows the catalog to that domain — the frontend rail is an optional hint, not a requirement. Analytics receives per-user SQL profiles through `effective_profiles(user_id)`.

### Known follow-ups

UI/UX work for this surface (plan review gate, confirmation card, wave
visualization, artifact language, replan versioning, resume affordances):
see **PLAN-supervisor-ui-ux.md**.

Enhancements and hardening, all open:

- **Active-tool cancellation:** cancellation stops at wave boundaries; active tools need a cancellation-aware execution contract.
- **Replan-usage accounting:** replan calls are not metered (dormant billing).
- **Step-result pruning:** `supervisor_step_results` grows without bound (no pruning yet).
- **Artifact output schemas:** file detection recognizes common output envelopes; explicit per-tool output schemas and store-aware adapters would improve reliability.
- **Restricted cross-domain catalogs:** a policy for merging restricted catalogs (e.g. analytics without office write tools) is open if needed.
- **Scheduler tuning:** `max_parallel` is conservative (`2`) and retry backoff is fixed; make them configurable only when workload evidence requires it.
- **Transport integration test:** a Tauri Channel/UI-level test would add release confidence.
- **Offline planning:** without a configured remote provider, `plan_task` returns a clear configuration error. A local or rule-based fallback is a product decision.

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
