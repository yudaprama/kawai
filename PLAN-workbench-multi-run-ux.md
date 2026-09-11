# PLAN: Workbench Multi-Run UX — honest relationships, one quote affordance

Status: approved plan (not yet implemented)
Scope: `frontend/src/features/workbench/` only — no Rust, no supervisor protocol changes.
Related: `PLAN-workbench.md`, `PLAN-followup-composer.md`

## Problem

On the 2nd+ goal run in the same session the Workbench confuses users:

1. **One-shot supervisor state.** `useSupervisorPlan` holds exactly one plan. Submitting goal #2 instantly wipes the rail's phases, resets the viewer to `auto`, and clears the `fullOutputs` cache. The only trace of run #1 is the `PreviousRunRail`, which itself only holds `runs[length-2]` in memory — run #3 erases run #1 from the UI entirely.
2. **Dishonest relationship badge.** `DeliverableViewer` renders `builds on "<previous goal>"` unconditionally whenever `previousRun` exists — even when run #2 was submitted **clean** (no quote) and is in fact unrelated. `quotedLastRun` exists in state but is never used to gate any UI.
3. **Opaque quote model.** Three interacting concepts (`followUp` flag, `quotedLastRun` flag, `canFollowUp` gate) drive what the planner sees, but the UI exposes them as two separate affordances (the `QuoteIndicator` opt-in row + the chips) with different behavior. The user cannot answer: "does run #2 know about run #1?"
4. **"New goal" nukes the session.** `newRun()` / `abandonSession()` are identical (`setSessionId(null)` + flag resets) — the button named "New goal" actually exits the session and kills cross-run recall. Semantics don't match the label.
5. **Dead history.** `RunHistory` renders every past run but only the latest is clickable ("S1: supervisor holds one run's state"); clicking an older row silently opens the *latest* run's final report.

## Goals

- A user can always tell which runs exist, which one the rail/viewer shows, and whether the current run was connected to a previous one.
- Exactly ONE way to attach the previous deliverable to a new goal.
- No UI claims a relationship that doesn't exist.
- Frontend-only: reuse the persisted `supervisor_step_results` (already keyed by planKey) for read-back; no schema or Rust change.

## Non-goals (explicitly deferred)

- Full per-run rail history with per-run step trees from persistence (needs a supervisor state redesign — Rust-adjacent; track separately if wanted).
- Cross-restart run history (S2 in PLAN-workbench.md).
- Changing the quote wire format (`buildQuotedGoal`) or planner behavior.

## Changes

### 1. Gate relationship UI on the actual quote (bug fix, highest priority)

**Files:** `hooks/use-workbench.ts`, `components/workbench-page.tsx`

- `PreviousRunRail` renders **only when `quotedLastRun === true`** (currently: whenever `runs.length >= 2`).
- The viewer's `builds on "…"` badge renders **only when `quotedLastRun === true`**.
- `previousRun` stays as-is (runs[length-2]) — but when the last run was clean, nothing claims a relationship.

### 2. One quote affordance: chips attach, a composer badge shows/removes

**Files:** `components/workbench-page.tsx`, `hooks/use-workbench.ts`

- **Delete `QuoteIndicator`** (the `Quote previous deliverable? include` opt-in row). It is the second, conflicting entry point.
- Chips keep their current behavior: click → `setFollowUp(true)` + seed the composer draft.
- New single indicator, rendered **only when `followUp === true`**: a compact composer-attached badge —

  ```
  📎 Will include the previous deliverable · ✕
  ```

  (`✕` = `setFollowUp(false)`). Shows the run's goal truncated on hover via `title`.
- `followUp` resets on every submit (already does). `quotedLastRun` remains the source of truth for change #1.

### 3. Viewer transition: keep the old deliverable until new work arrives

**Files:** `components/workbench-page.tsx`

- On submit, do **not** reset `selectedReport` to `"auto"` while the previous `finalOutput` is still displayed. Instead:
  - When a new run starts, the viewer keeps showing the previous deliverable, with a slim strip above it: `Run 2 started — <goal>` + a subtle "follow" button that switches to `auto`.
  - Auto-follow engages (switches the viewer to the new run's first report / in-progress state) when the user clicks "follow", or when the new plan enters `reviewing`/`running` **and** the user hasn't pinned a report — i.e. only the *first* report of the new run steals focus, never the previous deliverable silently disappearing.
- Minimal implementation: track `followNewRun: boolean` (set true by the strip button and by `selectedReport === "auto"` when the submit happened); reset the `fullOutputs` cache and pins only when the new run's first report or final output actually lands — not at submit time.

### 4. Honest naming for the session controls

**Files:** `components/workbench-page.tsx`, `hooks/use-workbench.ts`

- Collapse `newRun`/`abandonSession` into **one** exported function `startNewSession()` (delete the duplicate).
- The failed-run action button label changes `New goal` → `New session`; a `title` tooltip: "Starts a fresh session — the next run will not recall these runs."
- Add a small session marker above the composer: `Session · N run(s)` (N = `runs.length`). Purely informational; clicking it is a no-op for now.

### 5. History strip: stop pretending dead rows are clickable

**Files:** `components/workbench-page.tsx`

- In `RunHistory`, render rows for runs without an inspectable report as plain rows (already the case) **and** drop the "View report" affordance from any row where `clickable === false` (currently the span only renders when clickable — verify and add a short test/comment; also make `onReopen` take the runId it already receives and open that run's `final` when it *is* the latest, keeping current S1 behavior).

## Acceptance checks

- Clean 2nd run: NO "builds on" badge, NO PreviousRunRail; viewer keeps run #1's deliverable visible with the "Run 2 started" strip until follow or first report.
- Quoted 2nd run (via chip): PreviousRunRail + "builds on" badge shown; composer badge shows "Will include …" and is dismissible.
- `QuoteIndicator` no longer exists anywhere (`grep -rn QuoteIndicator frontend/src` is empty).
- `bun run typecheck` and `bun run build` green.
- Manual: 3 consecutive runs in one session — run #1 remains findable (history strip) and nothing claims a false relationship between any pair.

## Follow-up: A2 run journal (approved, replaces #3's strip-only approach)

Decision (brainstorm 2026-02): the viewer becomes a **chronological run
journal** — one collapsible section per run, newest appended at the bottom,
latest section open, older ones collapsed. Supersedes the standalone
transition strip (change #3 above): a newly submitted run appends a section
in `running…` state inside the journal itself.

- **Section body = the run's STEP TIMELINE** (state icon, task, tool, per-
  step `report` button loading the full body on demand from
  `supervisor_step_results` via the run's stored planKey). The deliverable is
  an ACCESSORY behind a small `deliverable` toggle — never the section's main
  content (user correction: expanding a section to reveal the deliverable is
  backwards; the journal is the history of the WORK).
- The run's steps + planKey are snapshotted into the run record at terminal
  state (the supervisor state is single-run and gets wiped by the next run).
- Collapsed sections don't render their body (page weight stays bounded).
- **Export** stays on the active run's viewer (uses `supervisor.finalOutput`).
- Step reports live INSIDE each section's timeline (per-step `report`
  button); the active run's viewer keeps its pin/switcher flow.
- Failed runs also append (❌ + reason + Resume/New session).
- In-memory `runs[].outputFull` + `planKey` → `supervisor_step_output` is the
  data source; cross-restart persistence stays deferred (S2).

## Out-of-scope follow-ups (file later)

- Per-run rail trees backed by `supervisor_step_results` read-back (removes the "only latest run is inspectable" S1 limit).
- Persisting runs to the office store for cross-restart history (PLAN-workbench S2).
