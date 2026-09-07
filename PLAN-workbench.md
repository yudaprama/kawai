# Plan — Kawai Workbench: the work-centric primary surface

Status: **SHIPPED (S1)** — the Workbench is the app's only surface (landing hero composer → three-pane run view, deliverable-writer synthesis, planner progress streaming). S2 backlog: tool-args + per-step LLM-usage timeline events, deliverable persistence to the office store, planner-authored agent names. (Supersedes the
trading-desk framing in `PLAN-analysis-desk.md`; that file's pipeline content
remains as a future domain pack, not the product.)

## The UX thesis (what "adopting TradingAgents' UX" means here)

Not the trading domain — the **interaction pattern**:

1. **The work is the screen.** The user watches the deliverable being produced
   (a document growing live), never a chat transcript piling up.
2. **Progress = named work structure.** A rail shows who is working on what,
   each part's status, and `see report` to open each part's output.
3. **The machine is transparent.** Every tool call and model usage is visible
   in a timeline — trust through visibility.
4. **Config first, then locked.** The user states the goal once; the machine
   runs; no back-and-forth dialogue mid-run.
5. **Chat is not the container for results.** Conversation is only the intake;
   deliverables live in the workbench.

Applied to **every** supervisor run (PDF, documents, decks, anything) — the
dynamic `plan_task` planner stays; only the container changes.

## The three-pane workbench

```text
┌──────────────┬────────────────────────────┬──────────────────┐
│ PROGRESS     │ DELIVERABLE VIEWER         │ RUN + TIMELINE   │
│ (w-72,       │ (flex-1, scrollable)       │ (w-80)           │
│  scrollable) │                            │                  │
│ ⚡ <goal>     │ <Deliverable title>        │ GOAL COMPOSER    │
│   ⏱ 01:24    │ (final synthesis, growing  │ (textarea + Run; │
│              │  live while it is written; │  locked during   │
│ ▾ PHASE 1    │  before that: the newest   │  a run)          │
│   ✓ <agent>  │  step report via switcher) │──────────────────│
│     ↗ report │                            │ MESSAGES & TOOLS │
│ ▸ PHASE 2    │ [final][s1 report][s2]…    │ 00:04 ⚒ Tool     │
│   ⟳ <agent>  │  ← report switcher grid    │   pdf_extract_…  │
│              │                            │   {fileId: …}    │
│              │                            │ 00:16 ◈ Model    │
│              │                            │   zai · 1.2k out │
└──────────────┴────────────────────────────┴──────────────────┘
```

## Flow

**History-first.** The surface opens on the run list (past supervisor runs,
from the persisted `supervisor-plan` records: goal, date, step tally, status).
"New run" opens the composer in the right rail. Submitting:

1. Composer locks (state 4 — config first, then locked).
2. `plan_task` runs → the rail fills with **named phases/agents** as the plan
   validates (the review gate renders IN the rail; approve starts execution).
3. Execution streams into the rail (statuses, durations) and the timeline
   (tool calls, model usage). The center pane follows the *current* thing:
   while agents work, it shows the newest completed report or the live
   final-synthesis once that step runs; after completion it settles on the
   deliverable with the report switcher grid beneath.
4. Terminal: the deliverable is the screen. `Analyze new goal` returns to the
   composer; the run joins history.

## Naming: agents, not steps

Steps render as **named agents** doing human tasks. v1 derives the name
client-side from the planner's human `task` (title-cased lead phrase, e.g.
"Extract full text" → agent `EXTRACT FULL TEXT`), keeping the tool chip
(`[pdf_extract_text]`) as the machine identity. S2 adds an optional
`agent` display-name field the planner emits per step (one prompt-line change
+ `TaskStep` field) so names are model-authored ("PDF Analyst", "Document
Sweeper") — the reference's personality, done in kawai's planner.

## Deliverable policy

- The synthesized final answer (already shipped) is the **primary
  deliverable**, rendered as a document in the viewer — never as a chat bubble.
- Each step's output (the 2000-char transport preview) is a **report** in the
  switcher — honest about its bound, per the earlier workbench-card decision.
- S2: persist the final deliverable as a real markdown document in the office
  store (run-keyed) so it opens in the existing preview and survives restarts
  as a first-class file.

## Timeline (Messages & Tools)

- v1 derives from existing events: `stepStarted` (⚒ tool row) / `stepFailed`
  / `stepCompleted` (◈ model row — provider known from `planningRound`
  telemetry only for the planner; per-step provider arrives in S2).
- S2 backend enrichments: `stepStarted` gains `args`; per-step LLM usage
  (model, tokens in/out) rides `stepCompleted`; optionally a live `sectionDelta`
  equivalent for the deliverable as it is synthesized.

## Chat's fate

Removed from the run flow entirely — results never enter chat. The composer
lives in the workbench. The existing chat surface stays reachable as a
secondary rail entry for free-form conversation; no capability is deleted, it
is simply no longer the container for work.

## Stages

1. **S1 — the shell, frontend-only.** Workbench surface (3 panes), history
   list, rail (phases/agents/durations/see-report), deliverable viewer +
   switcher, composer, timeline v1. Consumes the existing
   `SupervisorEvent` stream unchanged. Verification: full state matrix on real
   runs; chat regression pass.
2. **S2 — the transparency layer.** `stepStarted.args`, per-step LLM usage
   events, deliverable persistence to the office store, planner-authored agent
   names. Backend + both wrappers, small.
3. **S3 — polish.** Export deliverable (pdf/docx via office tools), run
   comparison, reflection memory (lessons carried into future runs — the one
   TradingAgents idea worth stealing for quality, not UX).

## Verification

- S1: manual matrix — new run → planning → review/approve → multi-phase run →
  deliverable + switcher → history replay of a persisted record; chat still
  functional as secondary.
- S2: headless smoke asserting timeline events carry args + usage; office
  store contains the persisted deliverable.
- Both stages: `bun run build` + `cargo check` battery green.
