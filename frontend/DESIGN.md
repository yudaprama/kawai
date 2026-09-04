# Kawai — Visual Design

The app runs in **auto mode**: every request goes through the supervisor planner
against the merged all-domain tool registry. There is no agent picker. The
layout is identical for every task:

```text
┌──────────┬──────────────────────────────────────────┬─────────────┬──────────┐
│ ASSETS   │ header: session title · model status ·   │             │ SESSIONS │
│ RAIL     │         thinking · canvas · history      │   CHAT      │ (xl+)    │
│ (left)   ├──────────────────────────────────────────┤   (center)  │ search + │
│          │  Plan panel (while a plan runs)          │             │ grouped  │
│ New Task │  Conversation (max-w-2xl)                │   CANVAS    │ list,    │
│ Wiki     │  Composer (capsule, max-w-2xl)           │   (xl+)     │ rename / │
│ Code     │                                          │             │ archive  │
│ Skills   │                                          │             │          │
│ Memory   │                                          │             │          │
│ Databases│                                          │             │          │
├──────────┴──────────────────────────────────────────┴─────────────┴──────────┤
│ rail footer: avatar · user · sign out · appearance (light/dark/system)        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Panes

- **Assets rail (left, 190–210px, collapsible).** New Task plus five asset
  workspaces (Wiki, Code, Skills, Memory, Databases). An asset view replaces
  the center pane; Esc or Back returns to chat. Below `lg` the rail becomes an
  overlay drawer opened from the header menu.
- **Chat (center).** Header carries the session title, model warm-up status,
  the Thinking toggle, the Canvas toggle, and session history (below `xl`; at
  `xl+` the persistent sessions rail replaces that button). The plan panel
  renders above the conversation while a plan executes: progress rail,
  per-step status icons, tool badges, artifacts (files are clickable and open
  the preview), and the final output disclosure. Empty state shows the agent
  icon, description, and prompt chips that drop their text into the composer
  for editing. Analytics adds an onboarding card (import file / connect
  database) when no data sources exist.
- **Canvas (tool output, optional).** Toggle from the header (⌘2). At `xl+` it
  is a third inline pane; from `lg` to `xl` it overlays the conversation as a
  drawer so the chat keeps its reading width. Hosts tool workbenches and
  document previews.
- **Sessions.** At `xl+` a persistent 224px rail with search, date grouping,
  rename, archive, and two-click delete; below `xl` the same list lives in the
  ⌘K dialog. Both surfaces share the row component and filter logic.

## Composer

Capsule input (max-w-2xl) with attachment chips on top. Left tools: `@` file
mention (knowledge search + import entry points), template picker, speech
input. Right: submit; while streaming it becomes stop. ArrowUp recalls the
last user message; Esc stops a running plan (except inside dialogs and other
editable contexts outside the composer).

## Confirmations

Sensitive plan steps pause for an in-composer confirmation card: icon and tool
badge derived from the executing step's tool, the action prompt (two lines),
Approve / Reject. Buttons disable while the plan is busy.

## Visual language

- **Tokens:** Tea Design tokens (tea-component default palette) aliased into
  shadcn semantic variables (`src/index.css`); `.dark` overrides only the raw
  `--tea-*` values. Step-state and status colors use token classes
  (`text-success`, `text-primary`, `text-destructive`) — never raw palette
  hex classes.
- **Typography:** system sans (`--tea-font-family-default`), monospace only
  for tool names, handles, and data. Conversation measure is `max-w-2xl`.
- **Radii/elevation:** `--radius: 0.375rem` base; cards `rounded-xl` with
  `shadow-xs`; pills only for small controls (status pills, chips).
- **Motion:** press feedback `scale(0.97)` under `prefers-reduced-motion:
  no-preference`; progress bar animates width 500ms ease-out; all animation
  collapses under `prefers-reduced-motion: reduce`.
- **Iconography:** lucide, 16px stroke icons; icon-only controls always carry
  `aria-label` + `title`.

## Mobile (< lg)

Assets rail becomes a left overlay drawer (dark backdrop, Esc/tap-out to
close). Sessions move to the ⌘K dialog entry point in the header; canvas
stays hidden below `lg`.
