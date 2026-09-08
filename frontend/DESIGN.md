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
screen — no rails, no distractions. Below the composer: a hint about `@`
file attachments. Below that: run history (clickable rows for the most
recent completed run). Submitting a goal transitions to the Workbench run
view.

## Panes

- **Assets rail (left, 190–210px, collapsible).** New Task plus six asset
  workspaces (Wiki, Code, Skills, Memory, Databases, Wallet). An asset view
  replaces the center pane; Esc or Back returns to the Workbench. Below `lg`
  the rail becomes a full-screen overlay drawer (dark backdrop, Esc/tap-out
  to close).
- **ProgressRail (left, 72px wide, lg+).** Visible during a run. Shows the
  status header (mapped from supervisor state — Planning, Running, Complete,
  Failed, etc.), duration, and collapsible phases. Each phase header is an
  `aria-expanded` toggle with a rotating chevron; clicking collapses or
  expands the step list. Step rows show: agent name (truncated to 48 chars),
  state icon (pending/running/completed/failed/skipped), tool name or live
  duration, and a "see report" link for completed steps. Below the phases:
  the deliverable writer row, then context-sensitive buttons (Stop, Resume,
  New goal).
- **DeliverableViewer (center).** The main content area. Shows the rendered
  deliverable (markdown via Streamdown), individual step reports, or the
  run history when idle. A header shows the title and step count + duration.
  Below the deliverable: the AGENT REPORTS switcher (grid of step name
  buttons — "★ Deliverable" plus one per completed/failed step). Clicking a
  step name pins the viewer to that report; "auto" mode follows the newest
  completed work. Export buttons (PDF, DOCX) appear below the deliverable
  when a run is completed; success shows the saved filename, failure shows
  an inline error message.
- **Sidebar (left, 384px wide, lg+).** Upper region (scrolls): ProgressRail
  (status header, collapsible phases, deliverable writer row, stop/resume/new
  goal buttons) then the collapsible "Messages & Tools" timeline —
  chronological machine log of planner rounds, step starts, completions, and
  failures, each with a colored badge (Plan, Tool, Done, Failed) and
  wall-clock offset from plan start. Footer (pinned): the goal composer.

## Composer

Capsule input (max-w-2xl) with attachment chips on top. The composer is
shared between the Workbench landing, the sidebar footer during a run, and any
asset workspace that needs text input. Left tools: `@` file mention
(knowledge search + import entry points), template picker, speech input.
Right: submit; while streaming it becomes stop. ArrowUp recalls the last
user message; Esc stops a running plan (except inside dialogs and other
editable contexts outside the composer). Placeholder changes by context:
"Describe your goal…" on the Workbench, "Message <agent>…" for chat-style
agents.

## Confirmations

Sensitive plan steps pause the run with `status: "awaitingConfirmation"`. The
confirmation card appears in the center pane: icon and tool badge derived from
the executing step's tool, the action prompt, and Approve / Reject buttons.
Buttons disable while the plan is busy.

## Run history

Visible on the landing hero (below the composer) and in the center pane when
a run is idle. Each run shows: goal, timestamp, step count, output preview
(first 60 chars). The most recent completed/failed run is a clickable button
with a "View report" affordance and hover state; clicking opens the
Workbench run view with that run's deliverable. Older runs are non-interactive
(S1: only the latest run's supervisor state is held in memory).

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

Assets rail becomes a full-screen overlay drawer (dark backdrop, Esc/tap-out
to close). The Workbench run view shows only the deliverable viewer pane —
the sidebar (ProgressRail, timeline, composer) is hidden. Run history is
visible on the landing hero. Mobile composer access is available on landing;
during a run, the composer is only accessible on lg+ screens.
