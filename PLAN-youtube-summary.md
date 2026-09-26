# Plan — YouTube Summary: a fixed pipeline (no planner) from a link to a five-section summary

Status: **SHIPPED** (this file documents the current architecture).

## Product contract

One YouTube link in → five-section summary out, in the transcript's language:

```
1. TL;DR
2. Key points
3. Timestamps      (chronological `mm:ss — what happens`)
4. Quotes          (verbatim, with timestamps)
5. Action items
```

No planning round, no review gate, no configuration. The section ORDER is
fixed; only the headings' language follows the content. Entry: Workbench
landing → template chip `YouTube Summary` → URL form (progressive
disclosure, same mechanism as the Analysis Desk panel).

## Execution model — Opsi B (locked)

The run is a CLIENT of the supervisor execution system, not a new engine:

```
run_youtube_summary (both wrappers)
  1. fetch transcript INSIDE the op — BEFORE any stream/plan exists
  2. build_youtube_plan → deterministic TaskPlan (map → compose)
  3. execute_plan_stream_with_cancel — same SupervisorEvent lifecycle as
     planner runs: rail, deliverable viewer, AGENT REPORTS, retries,
     cancel, artifacts, persisted plan record all come for free
  4. built-in deliverable writer answers the USER's goal (userGoal param)
```

**Fetch-before-stream is the error model**: a bad URL or a transcript-less
video is an ordinary op error (`Err(String)` / HTTP 4xx with the reason) —
no half-built plan, no steps, no run record.

Rejected alternative (Opsi A): a planner-driven run with a new tool. It
would re-introduce the review gate, cost planning rounds, and let the
planner reshape the output — the pipeline shape IS the product here.

## Plan shape (deterministic, `crates/engines/youtube/src/plan.rs`)

```text
wave 1   yt_part_1 ‖ yt_part_2 ‖ … ‖ yt_part_N   on_error: Continue
wave 2   yt_compose                               on_error: Fail (default)
+ the supervisor's built-in deliverable writer
```

Invariants this plan respects (learned the hard way on the desk plan):

- **`MAX_PLAN_STEPS` is 8** — `validate_structure` runs on EVERY execution
  path (`run_plan_scoped`), deterministic plans included. N ≤ 7 parts +
  compose. A longer transcript yields WIDER parts, never extra steps.
- **`bind_dataflow` MUST run** — it turns compose's `inputs`
  (`{"fromStep": "yt_part_k"}`) into the `dependsOn` edges the scheduler
  actually reads. Without it every dependent step fails
  `UnknownDependency`.
- **Part bindings omit the `output` key** → `resolve_inner` yields
  `{"stepId": …, "output": <full step output>}`; the tool unwraps it.
- **Per-run `nonce`** on compose's arguments (ignored by the tool) keeps
  the plan-JSON hash unique, so re-running the same video never replays a
  previous run's `supervisor_step_results` memo.
- `plan.goal` is the pipeline's own framing; the writer answers
  `userGoal` (the five-section request), never `plan.goal`.
- Stage tools are NEVER in the Turso tool catalog or `PLAN_CORE_TOOLS` —
  they exist only in `build_youtube_registry` (the dispatch view).

## Constants (`crates/engines/youtube/src/lib.rs`)

| constant | value | why |
|---|---|---|
| `MAX_PLAN_STEPS` (router) | 8 | router cap; 7 parts + compose |
| `MAX_CHUNKS` | 7 | `8 − 1` |
| `CHUNK_TARGET_CHARS` | 14 000 | one map call's reading budget |
| `MAX_TRANSCRIPT_CHARS` | 98 000 | `MAX_CHUNKS × CHUNK_TARGET`; longer → truncate at a cue boundary + coverage note |
| `PART_MAX_CHARS` | 2 000 | notes cap per part (writer materials budget) |
| `COMPOSE_MAX_CHARS` | 3 800 | composed notes must survive the writer's 4 000-char per-step preview WHOLE |
| map / compose timeouts | 120 s / 240 s | one remote call each |

Transcript tracks: `YT_LANGS = ["en", "id"]` first, else any existing track
(same preference as `knowledge_import_youtube`). Every cue is formatted
`mm:ss | text` — stages are taught to CARRY timestamps, never recompute
them.

## The one tool — `youtube_stage` (`crates/engines/youtube/src/tool.rs`)

Every step dispatches the same `AgentTool` with a `stage` key:

- `chunk` — reads its literal transcript slice (rides `arguments`), renders
  `prompts::chunk_notes()` through `remote_llm::reason_as`, output capped
  at `PART_MAX_CHARS`.
- `compose` — collects bound `part_1..part_N` outputs (sorted numerically),
  renders `prompts::compose()`, output capped at `COMPOSE_MAX_CHARS`.

Args are `#[serde(rename_all = "camelCase")]` (the dispatcher deserializes
plan JSON verbatim — no case folding) with `#[serde(flatten)]` for the
bound parts. `description`/`parameters` exist for the registry but the
planner never sees them.

## Ops (both wrappers, gated `litert`)

```
Tauri:  run_youtube_summary(sessionId, url, streamId, onEvent)
Web:    POST /api/run_youtube_summary  { sessionId, url, streamId }  → SSE
```

Identity/bearer resolve at the transport edge (AGENTS.md #8); the session
must exist. Billing is the status-quo execution gate (balance > 0 before
`PlanStarted`, no debit) — same as the desk.

## Frontend

- `goal-templates.tsx` — `GoalTemplateId += "youtube"`; the chip discloses
  `YoutubeSummaryForm` (`templateOpensYoutube`), mirroring
  `templateOpensDesk`.
- `youtube-summary-form.tsx` — URL input, loose host check only (the
  backend validates the id and fetches).
- `workbench-page.tsx` `submitYoutube` → `use-workbench.runYoutube`
  (balance gate → lazy session → run record → `onStart`) →
  `use-supervisor-plan.runYoutube` → `startStream(…, "run_youtube_summary")`.
- A pre-stream rejection surfaces as a failed run in the run view (the
  `onError` path) — the same transport-error handling every stream op has.

## Verification

`bun run build`; `cargo check`; `cargo check --features litert`;
`cargo check --features web`; `cargo check --features full`;
`cargo check -p kawai --no-default-features --features web`;
`cargo check -p kawai-youtube` (crates workspace). No unit tests: the
crates workspace has no test gate for engines (desk ships the same way).
