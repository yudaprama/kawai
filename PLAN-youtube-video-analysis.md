# Plan — YouTube Video Analysis: a fixed pipeline (no planner) from a link to a seven-section brief

Status: **SHIPPED** (this file documents the current architecture).

## Product contract

One YouTube link in → seven-section brief out. Language: the device locale
when it maps to the supported menu (`resolve_user_language` in
`supervisor.rs` — same names as the deliverable viewer's translate picker),
otherwise the transcript's language:

```
1. TL;DR
2. Key points
3. Timestamps      (chronological `mm:ss — what happens`)
4. Quotes          (verbatim, with timestamps — ALWAYS in their original language)
5. Fact-check      (claim → Supported / Contradicted / Unverifiable + source URL)
6. Analysis        (argument, evidence, framing, implications, limits)
7. Action items
```

Verification and analysis are part of every run — there is no toggle and no
extra form: the pipeline always extracts the checkable claims, checks them
against independent web sources, and assesses the reasoning.

No planning round, no review gate, no configuration. The section ORDER is
fixed. With a locale match, every report — map notes, composed summary, and
the final deliverable, headings included — is written in the user's
language; `language` rides every step's arguments from both wrappers
(body field, `Accept-Language` fallback on web). English/unmapped locales
keep the transcript-language behavior unchanged. Entry: Workbench
landing → template chip `YouTube Video Analysis` → URL form (progressive
disclosure, same mechanism as the Analysis Desk panel).

## Execution model — Opsi B (locked)

The run is a CLIENT of the supervisor execution system, not a new engine:

```
run_youtube_analysis (both wrappers)
  1. fetch transcript INSIDE the op — BEFORE any stream/plan exists
  2. build_youtube_plan → deterministic TaskPlan
     (map → compose → claims → verify ‖ analysis)
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
wave 3   yt_claims → yt_verify  ‖  yt_analysis    on_error: Continue
+ the supervisor's built-in deliverable writer
```

`yt_claims` extracts at most `MAX_CLAIMS` checkable claims (with `mm:ss` and
a search query) from the composed notes; `yt_verify` runs one web search per
claim (in parallel, via `webread::search_web`) and decides each claim against
that evidence only; `yt_analysis` runs in parallel with the fact-check and
assesses argument/evidence/framing/implications/limits. All three degrade to
`Continue`: a failed verification or analysis leaves an honest gap in the
deliverable instead of discarding the summary.

Invariants this plan respects (learned the hard way on the desk plan):

- **`MAX_PLAN_STEPS` is 16** — `validate_structure` runs on EVERY execution
  path (`run_plan_scoped`), deterministic plans included. N ≤ 7 parts +
  compose + claims + verify + analysis = at most 11 steps. A longer
  transcript yields WIDER parts, never extra steps.
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
  `userGoal` (the seven-section request), never `plan.goal`.
- Stage tools are NEVER in the tool catalog or `PLAN_CORE_TOOLS` —
  they exist only in `build_youtube_registry` (the dispatch view).

## Constants (`crates/engines/youtube/src/lib.rs`)

| constant | value | why |
|---|---|---|
| `MAX_PLAN_STEPS` (router) | 16 | router cap; 7 parts + compose + 3 analysis steps = 11 |
| `MAX_CHUNKS` | 7 | prompt-budget choice; longer videos get wider parts |
| `CHUNK_TARGET_CHARS` | 14 000 | one map call's reading budget |
| `MAX_TRANSCRIPT_CHARS` | 98 000 | `MAX_CHUNKS × CHUNK_TARGET`; longer → truncate at a cue boundary + coverage note |
| `PART_MAX_CHARS` | 2 000 | notes cap per part (writer materials budget) |
| `COMPOSE_MAX_CHARS` | 3 800 | composed notes must survive the writer's 4 000-char per-step preview WHOLE |
| `MAX_CLAIMS` | 4 | one web search per claim bounds the fact-check wave |
| `CLAIMS_MAX_CHARS` | 1 200 | claims JSON (the verify step's input) |
| `VERIFY_MAX_CHARS` | 2 000 | fact-check verdicts body |
| `ANALYSIS_MAX_CHARS` | 1 800 | analysis body |
| map / compose / claims / analysis timeouts | 120 s / 240 s / 120 s / 120 s | one remote call each |
| verify timeout | 300 s | parallel web searches plus the verdict call |

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
- `claims` — reads the bound composed notes, renders `prompts::claims()`,
  returns the JSON claim list (capped at `CLAIMS_MAX_CHARS`).
- `verify` — parses the claims JSON (tolerant of fences/prose), runs
  `webread::search_web` for every claim in parallel, builds the evidence
  block (≤ 2 hits per claim) and renders `prompts::verify()`, capped at
  `VERIFY_MAX_CHARS`. A search failure marks the claim's evidence as absent —
  the verdict then is `Unverifiable`, never a failed run.
- `analysis` — reads the bound composed notes, renders
  `prompts::analysis()`, capped at `ANALYSIS_MAX_CHARS`.

Args are `#[serde(rename_all = "camelCase")]` (the dispatcher deserializes
plan JSON verbatim — no case folding) with `#[serde(flatten)]` for the
bound parts. `description`/`parameters` exist for the registry but the
planner never sees them.

## Ops (both wrappers, gated `litert`)

```
Tauri:  run_youtube_analysis(sessionId, url, streamId, onEvent)
Web:    POST /api/run_youtube_analysis  { sessionId, url, streamId }  → SSE
```

Identity/bearer resolve at the transport edge (AGENTS.md #8); the session
must exist. Billing is the status-quo execution gate (balance > 0 before
`PlanStarted`, no debit) — same as the desk.

`planStarted.videoId` carries the source video (`None` on every other
pipeline) — the step `arguments` that also hold it never reach the wire, so
this event field is the frontend's only channel to the id. The field rides
the persisted plan record (`supervisor-plan.videoId`), so a reopened session
still shows the player.

## Frontend

- `goal-templates.tsx` — `GoalTemplateId += "youtube"`; the chip discloses
  `YoutubeAnalysisForm` (`templateOpensYoutube`), mirroring
  `templateOpensDesk`.
- `youtube-analysis-form.tsx` — URL input, loose host check only (the
  backend validates the id and fetches).
- `workbench-page.tsx` `submitYoutube` → `use-workbench.runYoutube`
  (balance gate → lazy session → run record → `onStart`) →
  `use-supervisor-plan.runYoutube` → `startStream(…, "run_youtube_analysis")`.
- A pre-stream rejection surfaces as a failed run in the run view (the
  `onError` path) — the same transport-error handling every stream op has.

## Canvas player (`youtube-embed.tsx`)

The deliverable canvas renders the video above the summary when the run has
a `videoId` (`youtube-embed.tsx`, mounted by `DeliverableBody`, fed by
`planStarted.videoId` / the persisted record — so live runs and restored
sessions both get it):

- **Click-to-load facade** — a poster (`i.ytimg.com`, with an offline
  placeholder) plus a play button; the `youtube-nocookie.com` iframe with
  `enablejsapi=1` mounts only on click, so reading a summary never loads
  YouTube's player JS. "YouTube" in the caption bar hands off to the OS
  browser (`plugin-opener` on desktop, `window.open` on web).
- **Timestamp seek** — `linkifyTimestamps` rewrites every `mm:ss` that LEADS
  a list item/line into a link to the canonical watch URL (`?t=<n>s`),
  skipping fenced code blocks (transcript excerpts are data, not
  navigation). `MarkdownWithCharts` intercepts those clicks (`onClickCapture`
  + `youtubeSeekSeconds`), preventDefaults, and `seekTo`s the player via the
  IFrame-API postMessage handshake (`listening` → `seekTo`); a seek that
  arrives before the iframe mounts flushes on load. The href stays a real
  watch URL, so a failed interception still opens the video at the right
  time.

Embedded-disabled / age-gated videos degrade inside YouTube's own player
UI — the facade still opens; playback is between the user and YouTube.

## Verification

`bun run build`; `bun run test` (the embed's pure helpers + facade smoke +
the reducer's `videoId` fold); `cargo check`; `cargo check --features
litert`; `cargo check --features web`; `cargo check -p kawai
--no-default-features --features web`; `cargo check -p kawai-youtube`
(crates workspace); `cargo test -p kawai-youtube` (plan shape, step cap,
language propagation, claim parsing); `cargo test --features litert --lib
plan_started_carries_source_video_id` pins the wire field.
