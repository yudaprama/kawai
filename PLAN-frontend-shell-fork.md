# Implementation Plan — Frontend shell fork from Spacedrive `packages/interface`

Status: DRAFT v1, **not started**. Per AGENTS.md this is post-MVP work — this
document exists because the user asked for the plan. Do not start Phase 1
without an explicit go.

Origin: `spacedrive/` submodule @ `6dfeccf2113039e35f2ce735f945e70dc3e4ea45`
(2026-07-28). All paths below are relative to
`spacedrive/packages/interface/src/` unless marked otherwise.

---

## 1. Decision recap

Replace kawai's hand-rolled app chrome (three-pane `App.tsx`) with a
**fork-and-strip of Spacedrive's `packages/interface`** to get a mature shell:
tab manager, keybind system, settings app, modal/overlay infra, theming —
without building each piece ourselves.

- **License**: kawai repo is now GPL-3.0 (LICENSE at root, public repo). The
  interface package is GPL-3.0-only — derivative frontend must be GPL with
  source available: already satisfied. Two mechanical duties remain (§3).
- **This is a shell swap, not a chat swap.** The chat stack survives verbatim:
  `components/ai-elements/*`, `hooks/use-local-chat.ts`, `lib/streamdown/`,
  `lib/stream.ts`, `lib/api.ts` embed into the new shell's center pane.
- **Cost frame**: strip + rewire ≈ effort of building our own shell, output is
  battle-tested interactions. Accepted trade-off.

## 2. Goals / Non-goals

**Goals**

1. Shell chrome from SD: TabManager (tabs + ⌘T/⌘W navigation), keybind system
   (`util/keybinds`, `useKeybind*`), Settings app (General/Appearance/Privacy/
   About), modal + tooltip + toaster infra, theming (`useTheme`), drag-drop
   (`DndProvider` + dnd-kit).
2. Data layer rewired from `@sd/ts-client`/OpenAPI/daemon → kawai
   `lib/api.ts` (`invoke`) / `lib/stream.ts` (Channel).
3. Kawai agent chat (existing components) mounted as the primary tab content;
   sessions sidebar and knowledge panel re-homed into the shell layout.
4. `bun run build` green; no new backend deps; cargo side untouched.

**Non-goals**

- Porting explorer/media viewer/redundancy/tag graph (dead domain code — dropped).
- Sync UI, JobManager, QuickPreview, Spacedrop, voice (re-vendor from upstream
  later when the matching backend feature ships).
- Mobile-responsive shell (Tauri mobile comes with Roadmap 13; shell is
  desktop-first now).
- Following upstream SD interface evolution (fork is frozen at the pinned SHA;
  re-syncs are manual and discouraged).

## 3. GPL compliance mechanics (Phase 0 checklist)

1. **Provenance file** `shell/PROVENANCE.md`: origin repo URL,
   pinned commit SHA, list of copied directories, date. (SD source files carry
   no per-file copyright headers — provenance lives in this file instead.)
2. **Notice preservation**: any copyright/license headers found in copied
   files stay intact; stripped files that retain SD-authored code keep their
   origin noted in PROVENANCE.
3. **npm deps license check** (blocker for Phase 1):
   `@spacedrive/primitives` + `@spacedrive/tokens` (the shell's UI kit and
   design tokens, consumed from npm). If permissive → keep as deps. If
   GPL/AGPL → vendor their sources into `shell/src/vendor/` (GPL is
   compatible with our GPL frontend, but we must comply + can then patch).
   Record the finding in PROVENANCE.
4. All other new deps are permissive (react-router MIT, react-query MIT,
   framer-motion MIT, dnd-kit MIT, phosphor-icons MIT, radix MIT,
   prismjs MIT) — no issue, but re-verify at install time.

## 4. Inventory — keep / drop / rewrite

Audit numbers at the pinned SHA: 268 ts/tsx files in the package; **101 import
`@sd/ts-client`**; 14 use react-query. The drop list removes most of the 101.

### 4.1 KEEP verbatim (shell core, ~40-60 files)

| Area | Path | Notes |
|---|---|---|
| TabManager | `components/TabManager/*` (~850 LOC) | tabs, dnd sorting, per-tab router, defaults sync |
| Keybinds | `util/keybinds/*`, `hooks/useKeybind{,Meta,Scope}.ts` | registry + scopes; rebind to kawai actions |
| Settings | `Settings/pages/{General,Appearance,Privacy,About}Settings.tsx` | content rewired; scaffolding kept |
| Modals | `components/modals/*` (infra parts) | dialog manager; domain modals dropped |
| Hooks | `useTheme`, `useEvent`, `useClipboard`, `usePopover`, `useAudioRecorder` | self-contained |
| Contexts | `contexts/PlatformContext.tsx` | swap impl for `@tauri-apps/api` (no daemon) |
| DnD | `components/DndProvider.tsx` | powers file drag-drop → knowledge import |
| Router | `router.tsx` (pattern) | kawai gains react-router; routes = ours |
| CSS | `apps/tauri/src/index.css` (token + `@utility` layer) | import into kawai's css entry |

### 4.2 DROP (dead domain code, ~200 files)

- `routes/{explorer,file-kinds,overview,redundancy,tag,sources,daemon}` —
  file-manager domain. Explorer's grid/keyboard-handler patterns are the
  reference for a future file-list view; note in PROVENANCE, don't copy.
- `components/{Inspector,QuickPreview,Tags,Sources,SyncMonitor,JobManager}` —
  backends don't exist yet. Re-vendor per feature later (§8).
- `windows/{Spacedrop,VoiceOverlay,FloatingControls,DemoWindow}`,
  `components/overlays/*` (daemon lifecycle — kawai backend is in-process).
- `Spacebot/*` — **pattern reference only** (ConversationScreen /
  ChatComposer / InlineWorkerCard show how chat lives inside this shell).
  Studied, not copied; kawai chat is strictly better (streaming, tool cards).
- Deps leaving with them: `@react-three/*`, `@mkkellogg/gaussian-splats-3d`,
  `ogl`, `maplibre-gl`, `d3`, `@types/d3`, `qrcode`, `@sd/assets`,
  `@sd/ts-client`, `openapi-fetch`.

### 4.3 REWRITE (thin glue, ~10-15 files)

| File | Rewire |
|---|---|
| `Shell.tsx` | drop `ServerProvider`/daemon gate; kawai providers (auth, chat state) |
| `contexts/SpacedriveContext.tsx` | → `shell/client.ts`: typed wrapper over `lib/api.ts` + `lib/stream.ts` |
| `TopBar/*` | library switcher → agent switcher + model status (local LLM) |
| `Settings/pages/*` | kawai settings (theme, data dir, remote-tier providers) |
| `hooks/useDaemonStatus.ts` | delete; replace with trivial "backend = Tauri, always up" |
| `routes/settings/index.tsx` etc. | route table → kawai routes |

### 4.4 KEEP from kawai, unchanged

`components/ai-elements/*` + `components/ui/*` + `lib/*` + `hooks/use-local-chat.ts`
(chat stack), `platform/` (local adapter). These mount inside the shell.

## 5. Target layout — second app at `shell/` (outside `frontend/`)

The fork is a **separate Vite app** at the repo root, parallel to `frontend/`
— the existing MVP frontend stays byte-identical (and keeps serving
`bun tauri dev`) until cutover. Same packaging model as `frontend/`: NO
package.json inside the app dir; deps + scripts live in the root `package.json`.

```
shell/                          # NEW app — fork from spacedrive packages/interface (GPL)
├── PROVENANCE.md               # §3 license provenance
├── index.html                  # own entry (theme-flash inline script copied from frontend/)
├── vite.config.ts              # root=shell/, port 1422, outDir dist-shell/, alias @shell/ + @/
├── tauri.dev.json              # tauri overlay: devUrl :1422 + beforeDevCommand "bun run dev:shell"
└── src/
    ├── Shell.tsx               # rewired mount
    ├── client.ts               # SpacedriveClient-shape → kawai api/stream
    ├── index.css               # tokens + @utility layer (from SD apps/tauri css)
    ├── TabManager/  keybinds/  Settings/  modals/  hooks/  contexts/
    └── vendor/                 # only if primitives/tokens turn out copyleft

frontend/                       # UNTOUCHED until Phase 5 — MVP keeps shipping from here
dist-shell/                     # shell build output during parallel phase
```

**Build wiring (one-time, Phase 1):**

- `vite.config.ts` (root, frontend) is NOT modified. New `shell/vite.config.ts`:
  `root: "shell"`, port **1422** strictPort (1420 = frontend, 1421 = reserved
  for LAN HMR per existing config), `outDir: dist-shell/`, aliases
  `@shell → shell/src` **and `@ → frontend/src`** — the second alias is what
  lets the shell embed kawai's chat stack (`@/components/ai-elements`,
  `@/hooks/use-local-chat`, `@/lib/*`) **without copying it**. Watch ignores
  `src-tauri/**` + `frontend/src/**` (mirror of the frontend config's rule,
  reversed).
- `tsconfig.app.json` include grows `shell/src` (one TS program → one
  `bun run typecheck` covers both apps; paths gain `@shell/*`).
- Root `package.json` scripts: `dev:shell`, `build:shell` (`vite build -c
  shell/vite.config.ts` — no separate tsc step needed since the shared
  `tsc -b` already covers shell/src).
- `bun tauri dev` against the shell: `tauri dev --config shell/tauri.dev.json`
  (same overlay-merge mechanism as `.github/tauri-litert.json`) — merges
  `build.devUrl` + `beforeDevCommand`, leaves everything else alone.
- Tailwind v4 via the same `@tailwindcss/vite` plugin; shell's own
  `index.css` vendors SD's token/`@utility` layer.

**CSS collision work item**: SD token vars vs kawai's Tailwind v4 dark theme.
Same Tailwind major version (v4) — merge token layers, namespace colliding
CSS custom properties, verify ai-elements still renders correctly under the
SD token set (both are shadcn-lineage, expect low friction). Note: because
the apps are separate bundles, a collision can never break the running MVP
frontend — worst case it's shell-only.

## 6. Data-layer contract (what `shell/client.ts` must expose)

Shell survivors consume ~8 endpoints. All backend ops already exist:

| Shell consumer | Kawai op(s) |
|---|---|
| agent switcher / tab defaults | `list_agents` (public) |
| auth gate | `whoami` → dev-bypass bootstrap (existing `use-auth` logic moves into Shell) |
| sessions pane | `list_chat_sessions`, `delete_chat_session` |
| knowledge pane | `knowledge_list`, `knowledge_forget`, `office_delete_file` |
| settings | theme (local), `capabilities`-style introspection if needed |

Keep `@tanstack/react-query` as a dep (MIT): cheaper than rewriting the 14
survivor hooks that use it; it also gives the panes free cache/refetch. The
daemon/OpenAPI transport never lands — `client.ts` calls `invoke` directly.

## 7. Phases & gates

| Phase | Work | Gate |
|---|---|---|
| **0 — Preflight** (0.5d) | §3 license checks; spike: copy TabManager alone into a scratch vite page, confirm it renders + dnd works in isolation | findings in PROVENANCE draft; spike screenshot |
| **1 — Fork & strip** (2-4d) | scaffold `shell/` app (vite config + tsconfig include + scripts, §5 wiring); copy §4.1 into `shell/src/`, delete §4.2, stub `client.ts` with mock data until it compiles | `bun run typecheck` green (both apps) + `bun run build` (frontend, untouched) + `bun run build:shell` green with shell rendering stubbed data on :1422 | 
| **2 — Rewire** (2-3d) | real `client.ts` (§6), Shell providers, TopBar → agent switcher, settings pages wired | shell navigable against real backend via `tauri dev --config shell/tauri.dev.json`; frontend app untouched & still green |
| **3 — Embed chat** (2-3d) | mount ai-elements Conversation + PromptInput (imported via `@/` alias — no copies) as primary tab; re-home sessions sidebar + knowledge panel as shell panes; keybinds rebound (⌘1/2/3, ⌘T/W) | full agent-chat e2e in shell: stream, tool cards, thinking toggle, cancel |
| **4 — Polish** (2-4d) | CSS token merge + collision pass, drag-drop import via DndProvider, settings completeness, empty/loading states, error boundary; add `build:shell` to the CI web job | visual parity checklist vs old UI + SD reference; `bun run build` + `bun run build:shell` |
| **5 — Cutover** (1d) | make shell THE app: root `vite.config.ts` → either point tauri at `dist-shell/` or move shell's outDir to `dist/`; swap `beforeBuildCommand` in release workflow; retire `frontend/` (delete; absorb any stragglers into `shell/src`); update AGENTS.md layout tree + both frontend docs + this status | clean `grep` for `frontend/src` references; `bun run build`; CI + release green |

Total ≈ **2-3 focused weeks**. Frontend-only throughout: `cargo check` gates
are unaffected (run once at the end for hygiene).

Rollback: zero-risk through Phase 4 — the MVP frontend is never touched, so
reverting is `rm -rf shell/ dist-shell/` + dropping the three root-config
additions (scripts, tsconfig include, CI line). Even after Phase 5, revert =
flip the tauri/dist wiring back and restore `frontend/` from git.

## 8. Deferred re-vendor list (from upstream pin, when backend ships)

- JobManager UI → kawai job system (jobs plan TBD)
- SyncMonitor + Spacedrop → P2P sync tier (iroh/sqld decision, Roadmap 8/13+)
- QuickPreview → office/pdf preview cards (`office_read_file` exists; viewers don't)
- fs-watcher-driven location index → "sources" pane (workspace-mode plan TBD)

## 9. Risks

| Risk | Mitigation |
|---|---|
| `primitives`/`tokens` npm license incompatible | Phase 0 blocker check; vendor if copyleft |
| Token/CSS collision breaks ai-elements | Phase 4 dedicated pass; namespace vars; fallback = keep kawai palette as a theme |
| Strip underestimates coupling (101 ts-client importers) | Phase 1 target is "compiles with stubs" — mocks reveal the true seam; anything too tangled gets dropped, not fixed |
| Fork freezes; upstream fixes missed | accepted; PROVENANCE pins SHA; security-relevant upstream fixes ported manually |
| Hidden dep on daemon behaviors (query invalidation storms, etc.) | shell gate in Phase 2 e2e; react-query cache is client-side, no daemon dependency survives `client.ts` |
