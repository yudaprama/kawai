# Plan — Workbench-style plan card (TradingAgents-inspired restyle, Option C)

Status: **APPROVED FOR IMPLEMENTATION** (design frozen; no backend changes).

## Problem

The supervisor plan UI (PlanningCard / PlanReviewPanel / PlanProgressPanel) reads as
chat chrome, not as an analysis workbench. Three gaps against the TradingAgents
reference (`./TradingAgents`, terminal-desk aesthetic):

1. No sense of a *machine at work*: no total duration, phases are flat, the
   machine identities (`office_list_files`) leak as primary labels.
2. Step outputs are truncate-at-160-chars with no way to see more.
3. Planning / review / progress read as three unrelated surfaces instead of one
   lifecycle.

## Non-goals (explicitly out of scope)

- No backend changes — zero new events, zero Rust edits.
- No structured per-domain input (ticker/date forms), no named fixed pipelines
  (that is the Option A territory — a separate workbench surface).
- No hardcoded palette. TradingAgents' `#42DCA3`-everywhere violates the theme
  token rule (see the comment in `StepIcon`); everything stays on
  `primary/success/destructive/warning/muted`.
- Chat as a surface is NOT removed — the card lives in the inline chat slot
  shipped earlier this week.

## Design

### One chrome, five states

All three surfaces merge into one visual chrome (`bg-card rounded-xl border`
with a mono header row). State is the pill:

```text
PLANNING : ⚡ ANALYSIS · PLANNING · starting…                    ⟳
           round 2 · zai · searching tools
           Found: office_list_files, pdf_info, …

REVIEW   : ⚡ ANALYSIS · REVIEW · 3 steps
           List the user's stored PDFs → inspect → extract text
           ✓ s1 …  ✓ s2 …  ✓ s3 …                      [Approve] [Cancel]

RUNNING  : ⚡ ANALYSIS · RUNNING · 2/3 · ⏱ 01:24            [■ Stop]
           Summarize this PDF
           ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░
           ▾ PHASE 2
             ⟳ Inspect page count and layout   [pdf_info]     3s
             ⟳ Extract full text               [pdf_extract]  running…

COMPLETED: ⚡ ANALYSIS · COMPLETED · 3/3 · ⏱ 01:46          [details]

FAILED   : ⚡ ANALYSIS · FAILED · 2/3                       [Resume] [New plan]
```

### Human-language step labels (the core ask)

`planStarted` already ships a human `task` per step (planner-written;
`plan_step_infos` falls back to the tool name only when the planner omitted it).
Step rows flip the hierarchy:

- Primary label = `step.task` (human sentence, normal font)
- Tool name = small mono chip on the right (`[pdf_info]`) — kept for
  transparency, de-emphasized
- Per-step duration (mono, tabular-nums) reuses the `Elapsed` pattern; needs
  `finishedAt` on completion (new, frontend-only)
- Retry badge condenses to `↻2` inline

### Phases = waves, collapsed by default

`computeWaves` (already derived from real `dependsOn`) gets collapsible
sections labeled `PHASE N` (mono uppercase). Collapse policy: a phase is
collapsed iff every step in it is `completed`/`skipped` and the user hasn't
pinned it open. The active phase is always expanded. Single-phase plans
collapse the header to just `STEPS` (current behavior).

### See output

Each completed step with a non-empty `output` gets a `↗ see output` toggle that
expands an in-row mono block with the full step output **as the frontend has
it** — the 2000-char transport preview (`STEP_EVENT_OUTPUT_MAX_CHARS`). The
backend does not send more today; showing the preview honestly is still a big
upgrade over truncate-160. Full-body access remains the artifact links /
`artifact_recall` path (unchanged).

### Total plan duration

- Hook: set `planStartedAt` on `planStarted`, freeze `planCompletedAt` on
  `planCompleted`/`planFailed` (both new fields on `SupervisorPlanState`,
  frontend-only).
- Header timer ticks like `Elapsed` while terminal time is unset.
- Per-step `finishedAt` set in `stepCompleted`/`stepFailed` so durations freeze
  instead of ticking forever.

### Review gate & planning merge into the same chrome

- `PlanningCard` becomes the card's planning state: same header row
  (`⚡ ANALYSIS · PLANNING`), round/provider/search line, `Found: …` tool list.
  Keeps its optimistic `round 0 → starting…` semantics.
- `PlanReviewPanel` re-renders inside the same chrome (`REVIEW` pill, steps
  read-only with human labels, Approve/Cancel in the header row).
- `conversation-panel.tsx` slot is unchanged — same components, same props
  (`PlanningState` shape gains nothing; `SupervisorPlanState` gains the two
  timestamps which the panel reads from new optional props).

## Files touched

| File | Change |
|---|---|
| `frontend/src/features/chat/components/plan-progress-panel.tsx` | The rework: shared chrome header, phase sections (collapsible), human-label step rows with `finishedAt` durations + `see output` toggles, planning/review states merged into the chrome |
| `frontend/src/features/chat/hooks/use-supervisor-plan.ts` | `planStartedAt` / `planCompletedAt` on state; `finishedAt` per step; wire in existing event handlers (±15 lines) |
| `frontend/src/features/chat/components/conversation-panel.tsx` | Pass the two new optional props (±2 lines) |

## Effort

Half a day, frontend-only. No migrations, no bindings, no web-wrapper changes.

## Verification

- `bun run typecheck` + `bun run build` (green)
- Manual states matrix from `bun tauri dev`:
  planning (round/tool-found lines) → review (approve path AND cancel) →
  running (multi-wave parallel, single-step plan) → completed (collapsed
  default, details expand, see-output on each step) → failed (resume + new
  plan) → stop mid-run (stopping pill).
- Regression guard: history replay of a persisted `supervisor-plan` record
  renders unchanged (record shape untouched).
