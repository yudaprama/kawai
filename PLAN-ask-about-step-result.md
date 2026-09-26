# Plan: Ask About Step Result

**Goal**: Let non-technical users ask follow-up questions about any supervisor step result (e.g., `data_query`, `data_ta`, `knowledge_search`) directly from the Workbench step report view. The system runs a focused 1-step sub-plan with a specialized "explain" tool and streams the answer back.

---

## Scope

- **In scope**: Deliverable viewer step reports only (not progress rail). One new operation + one new agent tool + UI affordance.
- **Out of scope**: Persistence of Q&A pairs, multi-turn conversation on a step, progress rail integration (can be added later).

---

## Architecture

```
User clicks "Ask about this result" in step report
       │
       ▼
Frontend: useWorkbench.askAboutResult(stepId, question)
       │
       ▼
Tauri command: ask_about_step_result(session_id, plan_key, step_id, question)
       │
       ▼
Logic: load step result from supervisor_step_results(plan_key, step_id)
       │
       ▼
Execute 1-step supervisor plan:
  - Tool: explain_step_result
  - Args: { step_tool, step_args, step_output, step_artifacts, question }
       │
       ▼
Stream SupervisorEvent (stepStarted → stepCompleted)
       │
       ▼
Frontend: render answer in modal / side panel below the step report
```

---

## Files to Create / Modify

### 1. New Agent Tool: `explain_step_result`

**File**: `crates/engines/agent/src/explain_tool.rs` (SHIPPED)

- `ExplainStepResultTool` implements `kawai_tools::AgentTool` (`NAME`, `ExplainStepResultArgs`, `Output = String`).
- One remote-LLM one-shot via `remote_llm::reason::reason_as(..., "explain-step-result")` — pool failover + on-device fallback included.
- Prompt: conversational Indonesian explainer persona; grounded on tool name + args + output + artifacts.
- `step_artifacts` is a raw JSON pass-through of the persisted `kawai_router::Artifact` array.
- Exported from `kawai_agent` (`crates/engines/agent/src/lib.rs`).

---

### 2. Supervisor Toolset Builder

**File**: `src-tauri/src/supervisor.rs` (SHIPPED)

- `supervisor_toolset_with_explainer(user_id, session_id)`: the merged `auto` supervisor catalog + `ExplainStepResultTool` (`toolset.add_tool`).
- The explainer is deliberately NOT planner-visible (never in the Turso catalog / `PLAN_CORE_TOOLS`) — this builder is its only ride.
- `build_registry_from_toolset` widened to `pub(crate)` for `logic.rs`.

---

### 3. Backend Logic

**File**: `src-tauri/src/logic.rs` — `ask_about_step_result` (SHIPPED, `#[cfg(feature = "litert")]`)

1. Load the step result via `kawai_db::list_supervisor_step_results` (plan-key scoped, newest row wins) with the session-scope fallback (`list_supervisor_step_results_by_session`, same contract as `supervisor::step_output`).
2. Extract `tool` / `output` / `artifacts_json` (typed `SupervisorStepResult`).
3. Build the 1-step `TaskPlan`: one step, id `explain`, dispatch key `explain_step_result`, `arguments` = serialized `ExplainStepResultArgs`.
4. Registry via `supervisor_toolset_with_explainer` → `build_registry_from_toolset`.
5. Execute via `execute_plan_stream_with_cancel` (same scheduler lifecycle: `StepStarted` → `StepCompleted`, full-output persistence, memo).
6. `user_goal` = the question; no billing bearer (internal call).

---

### 4. Tauri Command Wrapper

**File**: `src-tauri/src/commands.rs` (SHIPPED) + registered in `lib.rs` `generate_handler!`

`ask_about_step_result(session_id, plan_key, step_id, question, stream_id, on_event, registry, session)` — resolves identity at the edge, drives the logic stream through `run_streaming`.

---

### 5. Axum Route (Web)

**File**: `src-tauri/src/web.rs` (SHIPPED)

`POST /api/ask_about_step_result` on the protected router — `AskAboutStepResultRequest` (camelCase rename), logic stream bridged to SSE via `supervisor_sse_frame`.

---

### 6. Frontend Hook Extension

**File**: `frontend/src/features/workbench/hooks/use-workbench.ts` (SHIPPED)

`askAboutResult(stepId, question, planKeyOverride?) => Promise<string | null>` — rides `callWithEvents` (own Channel; the main supervisor state is untouched), captures `stepCompleted` where `stepId === "explain"`, resolves with the explanation text.

---

### 7. UI Components

**Files**: `frontend/src/features/workbench/components/ask-about-result.tsx` (new, SHIPPED) + `shared-canvas.tsx` + `deliverable-viewer.tsx` + `workbench-page.tsx`

- `AskAboutResult`: inline "Tanya tentang hasil ini…" input + `Tanya` button below a step report; states idle → running → done/error; answer renders as markdown with a `Tutup` dismiss.
- `StepReportBody` gained an optional `onAsk` prop; wired in `DeliverableViewer` (live run, `supervisor.planKey`) and `PastRunCanvas` (past run, its own `planKey` passed through the override param).

---

## Event Flow (Frontend)

1. User types question → clicks "Kirim"
2. Frontend generates `streamId = `ask-${stepId}-${Date.now()}`
3. Calls `askAboutResult(stepId, question)` → invokes Tauri command
4. Tauri streams `SupervisorEvent`:
   - `stepStarted { stepId: "explain", tool: "explain_step_result" }`
   - `stepCompleted { stepId: "explain", output: "<explanation>", ... }`
5. Frontend collects `stepCompleted.output` → sets `answer` state → renders in `AnswerPanel`

---

## Database

No schema changes. Reads the existing `supervisor_step_results` table (migration 0015) via the typed loaders in `kawai-db`:
- `list_supervisor_step_results(user_id, session_id, plan_key)` — resume-scope rows (tool, args_key, step_id, output, artifacts_json)
- `list_supervisor_step_results_by_session(user_id, session_id, limit)` — cross-plan fallback (plan_key, tool, step_id, output)

The `tool` name IS persisted — the explainer receives the real producing tool, no placeholder.

---

## Testing

| Layer | Test |
|---|---|
| Tool | Unit test `ExplainStepResultTool.call` with mock LLM response |
| Logic | Integration test: insert step result → call `ask_about_step_result` → verify stream emits `stepCompleted` |
| Command | Tauri command smoke: invoke with valid session/plan/step → events received |
| Frontend | Component test: `StepReportWithAsk` renders button, modal opens, submits question |

---

## Rollout Steps

1. ✅ **Backend tool + logic** (`crates/engines/agent/src/explain_tool.rs`, `src-tauri/src/logic.rs`, `src-tauri/src/supervisor.rs`)
2. ✅ **Command + route** (`src-tauri/src/commands.rs` + `lib.rs` handler + `src-tauri/src/web.rs`)
3. ✅ **Frontend hook** (`frontend/src/features/workbench/hooks/use-workbench.ts`)
4. ✅ **UI components** (`ask-about-result.tsx`, `shared-canvas.tsx`, `deliverable-viewer.tsx`, `workbench-page.tsx`)
5. ✅ **Verified**: `bun run build`, `bun run typecheck`, `biome check frontend/src`, `cargo check` (default/web/litert), `cargo check -p kawai --no-default-features --features web`, `cargo check --manifest-path kawai-web/Cargo.toml`, `cargo test -p kawai-agent --lib`
6. ⏳ **Manual smoke** (needs a full app build — user-run): run a `data_query` step → open its report → ask "Apa artinya angka ini?" → explanation renders inline

**Known foreign breakage (not this feature)**: `cargo check --features full` currently fails in `crates/toolsets/analytics-tools/src/sql_remote.rs:345` (syntax error from parallel in-flight work) — unrelated to the ask-about path.

---

## Future Enhancements (Not in This Plan)

- Persist Q&A to `supervisor_step_results` (new `qa` JSONB column)
- Multi-turn follow-up on same step
- Progress rail "Ask" button (compact inline)
- Auto-suggest common questions based on tool type
- Locale-aware explanations (currently Indonesian default)