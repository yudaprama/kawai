# Kawai — Visual Design

The app runs in **auto mode**: every request goes through the supervisor planner
against the merged all-domain tool registry. There is no agent picker. The
primary surface is the **Workbench** — a goal-centric two-pane layout:

```text
┌──────────┬───────────────────────────────────────────┐
│ ASSETS   │ deliverable viewer                        │
│ RAIL     │  · status header (step count, duration)   │
│ (left)   │  · rendered deliverable (markdown)        │
│          │  · AGENT REPORTS switcher                 │
│ New Task ├───────────────────────────────────────────┤
│ Wiki     │ sidebar: ProgressRail (lg+)               │
│ Code     │  · status header + phase list             │
│ Skills   │  · collapsible phases with step states    │
│ Memory   │  · Messages & Tools timeline (collapsible)│
│ Databases│  · deliverable writer row                 │
│          │  · stop / resume / new goal buttons       │
│          ├───────────────────────────────────────────┤
│          │ sidebar footer: goal composer (pinned)    │
├──────────┴───────────────────────────────────────────┤
│ rail footer: avatar · user · sign out · appearance    │
└──────────────────────────────────────────────────────┘
```

## Landing (home)

Full-screen hero with a centered capsule composer. The goal is the whole
screen — no rails, no distractions. One primary input: below the composer sit
a hint about `@` file attachments, a **Try** row of example-goal chips
(first session only — each drops an editable draft into the composer, never
auto-submits), and the **Templates** chip row (single-select,
click again to clear) — Research, Market Analysis, Coding, Data Analysis.
Research-flavored picks disclose the **Analysis Desk** panel (the fixed
stock-research pipeline: ticker, optional as-of date, analyst team, Run desk);
Coding/Data Analysis only reframe the composer's placeholder. The desk is
never visible uninvited. Below that: history — the in-session run history when
the current session has runs, otherwise the cross-session **Recent runs** strip
(the newest plan record from every session with runs: goal or session title,
relative time, step count, status icon; clicking one opens that session and
its report; while the first fetch is in flight the strip shows skeleton rows).
Submitting a goal transitions to the Workbench run
view.

## Panes

- **Assets rail (left, 190–210px, collapsible).** New Task plus six asset
  workspaces (Wiki, Code, Skills, Memory, Databases, Wallet). An asset view
  replaces the center pane; Esc or Back returns to the Workbench. Below `lg`
  the rail becomes a full-screen overlay drawer (dark backdrop, Esc/tap-out
  to close).
- **ProgressRail (left, 72px wide, lg+).** Visible during a run. Shows the
  status header (mapped from supervisor state — Planning, Running, Complete,
  Failed, etc.), duration, a determinate progress bar (settled steps over the
  planned total, hidden while planning), and collapsible phases. Each phase
  header is an `aria-expanded` toggle with a rotating chevron; clicking
  collapses or expands the step list. Step rows show: agent name (truncated
  to 48 chars), state icon (pending/running/completed/failed/skipped), tool
  name or live duration, and a "see report" link for completed steps. Below
  the phases: the deliverable writer row, then context-sensitive buttons
  (Stop, Resume, New goal). When the run needs the user — plan review or a
  confirmation gate — the corresponding card takes keyboard focus (after the
  mobile drawer auto-opens), so the request is announced and reachable.
- **DeliverableViewer (center).** The main content area. Shows the rendered
  deliverable (markdown via Streamdown), individual step reports, or the
  run history when idle. A header shows the title and step count + duration
  (`planning…` and a live elapsed clock while the plan is being written).
  While a run is in flight the final view carries a compact status strip —
  planning round and activity, the current running step, a "Writing your
  answer…" skeleton while the deliverable writer synthesizes (its output
  lands only at plan completion), an approval prompt, or the stop state —
  so the canvas never sits blank between submit and the deliverable; a
  visually-hidden `aria-live` region announces phase transitions once each.
  Below the document: the AGENT REPORTS switcher (grid of step name buttons —
  a Deliverable row plus one per completed/failed step) switches the canvas
  between this run's documents; the rail's "see report" links stay as a
  second path. Export buttons appear below the deliverable when a run is
  completed — Copy (markdown to the clipboard), PDF, DOCX — on the live
  canvas and on past-run deliverables alike; success renders the saved
  filename as a button that opens the file in the preview dialog, failure
  shows an inline error message.
- **Sidebar (left, 384px wide, lg+).** Upper region (scrolls): ProgressRail
  (status header, collapsible phases, deliverable writer row, stop/resume/new
  goal buttons). While the plan awaits review the rail shows the review card
  (summary, collapsible step list, Run / Discard): Discard arms on first
  click — it reads "Confirm discard" for 3s, then discards or reverts — so a
  misclick can't throw away a long planner round. Below sits the collapsible
  "Messages & Tools" timeline —
  chronological machine log of planner rounds, step starts, completions, and
  failures, each with a colored badge (Plan, Tool, Done, Failed) and
  wall-clock offset from plan start. Footer (pinned): the goal composer.

## Composer

Capsule input (max-w-2xl) with attachment chips on top. The composer is
shared between the Workbench landing, the sidebar footer during a run, and any
asset workspace that needs text input. Left tools: `@` file mention
(knowledge search + import entry points), template picker, speech input.
Right: submit; while a run is in flight it becomes stop. The textarea stays
editable during a run — drafting the next goal is allowed, and a submit
attempt rejects with the reason shown under the composer (the draft is kept).
ArrowUp recalls the last user message; Esc stops a running plan in two steps —
the first press arms with a "Press Esc again to stop" toast (2s window), the
second stops (except inside dialogs and other editable contexts outside the
composer). Placeholder changes
by context: "Describe your goal…" by default on the Workbench (the Coding/Data
Analysis templates reframe it), "Draft your next goal — submit after this run
finishes…" while a run executes, "Message <agent>…" for chat-style agents.

## Confirmations

Sensitive plan steps pause the run with `status: "awaitingConfirmation"`. The
confirmation card appears twice: in the progress rail and as a card on the
center-pane canvas (shield icon, the step's action prompt, Approve / Deny
buttons — both mounts act on the same supervisor actions and disappear
together once answered). When the gate opens, focus moves to the rail card;
on mobile the progress drawer auto-opens in the same commit.

## Run history

Visible on the landing hero (below the composer) and in the center pane when
a run is idle. Each run shows: goal, timestamp, step count, output preview
(first 60 chars). Every finished run is a clickable button with a "View
report" affordance and hover state; clicking opens the Workbench run view
with that run's deliverable (the canvas renders past runs from their
persisted records — live supervisor state holds only the active run). A
still-running row is inert but keeps full contrast: it's live, just not
clickable yet. When the session has no in-memory runs, the landing hero
instead shows **Recent runs** — `list_recent_runs` across sessions, same row
shape. Restored runs
take their timestamps from the persisted record's write time, so a reopened
session shows when each run actually finished. Failed runs fall back to the
plan-level error in the row preview.

## Failure visibility

A failed run always says WHY: the progress rail header carries the
plan-level error (rendered as an `alert`), each failed/skipped step shows its
error inline in the tree (live and history rows) and gained a "see report"
link, and the canvas shows a `Run failed` card on the deliverable view plus a
`Step failed` card on a failed step's report. Blocked submits reject the
composer promise (the draft is kept) and surface the reason under both
composer mounts (landing hero and mid-run sidebar, both `role="alert"`).

## Session switcher

Cmd/Ctrl+K (or the Sessions button) opens the session history dialog: a
search box over sessions grouped by last activity (Today / Yesterday /
Earlier) plus a collapsible Archive. Search filters titles instantly and,
after 250ms, queries message content server-side (failures fall back to
the local filter). Rows show the goal/title with a relative timestamp and
hover-revealed actions — export (writes the transcript as a stored `.md`
and opens its preview), rename (inline input), archive, and delete.
Delete is immediate to the eye but deferred to the backend: the row
disappears optimistically and a sonner toast offers **Undo** for 5 seconds
before `delete_chat_session` fires (one toast covers a bulk batch). The
header's **Select** button swaps rows to checkboxes behind a bulk bar —
Archive/Restore (enabled per selection side), Delete, Cancel. Arrow keys
move a highlighted cursor over the flat row list (groups, then archive),
Enter opens the selected session (toggles it in Select mode); hover moves
the same cursor.

## Keyboard shortcuts

`?` (outside editable fields and dialogs) opens a cheat-sheet dialog listing
the live keys: Cmd/Ctrl+K sessions, Cmd/Ctrl+N new session, Cmd/Ctrl+1 assets
rail, Esc drawer-close then two-step stop-run, ArrowUp last-goal recall, `@` file
mention. The dialog's list mirrors the handlers in `useAppShortcuts` and the
workbench — update them together.

## Notifications

The bell (rail footer) opens a popover: category filter tabs (All, agents,
messages, skills, system — `aria-pressed`), a newest-first item list, and
mark-all-read / clear-all actions. Category badges use token classes
(`primary`/`success`/`warning`/muted) — never raw palette hex, so they track
the `.dark` overrides. Tapping an item marks it read and closes the popover.
Clear-all is optimistic with a 5s Undo toast (snapshot restore).

## Visual language

- **Tokens:** Tea Design tokens (tea-component default palette) aliased into
  shadcn semantic variables (`src/index.css`); `.dark` overrides only the raw
  `--tea-*` values. Step-state and status colors use token classes
  (`text-success`, `text-primary`, `text-destructive`) — never raw palette
  hex classes.
- **Typography:** system sans (`--tea-font-family-default`) for body text and
  labels; monospace (`--tea-font-family-code`) for tool names, handles,
  durations, phase headers, step rows, and the Messages & Tools timeline.
  Deliverable body renders as markdown (system sans). Composer placeholder
  and rail hints use `text-[10px]`–`text-xs` sizes.
- **Radii/elevation:** `--radius: 0.375rem` base; cards `rounded-lg` with
  `border`; pills only for small controls (status pills, chips).
- **Motion:** press feedback `scale(0.97)` under `prefers-reduced-motion:
  no-preference`; phase chevron rotates 90° on collapse; spinner animation
  for running steps and loading states; all animation collapses under
  `prefers-reduced-motion: reduce` (spinners slow to 2.5s, pings disabled).
- **Iconography:** lucide, 16px stroke icons; icon-only controls always carry
  `aria-label` + `title`. State icons: CheckCircle2 (completed), CircleX
  (failed), LoaderCircle (running), ChevronDown (collapsed/skipped), empty
  circle (pending).

## Mobile (< lg)

Assets rail becomes a full-screen overlay drawer (hamburger button, dark
backdrop, Esc/tap-out to close). The Workbench run view has a top bar
(hamburger → assets drawer, Progress → the sidebar as an overlay drawer with
backdrop/Esc close, ← → back to the landing composer, disabled mid-run).
The progress sidebar auto-opens when the plan needs the user (review,
confirmation gates) so a run can't stall invisibly; Esc closes the drawer
first, then arms the two-step stop — the second press stops the run. Run
history and the goal composer are available on the landing hero throughout.
