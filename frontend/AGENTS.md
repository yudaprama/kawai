# AGENTS.md — kawai frontend

This is a React 19 SPA for the kawai AI agents app. It lives at `frontend/` inside the broader `kawai/` monorepo. Read this before editing any frontend code.

## Essential context

- **This is a subdirectory of the `kawai/` monorepo.** All config files live at the repo root: `package.json` (bun), `vite.config.ts` (root=`frontend/`, outDir=`dist/`), `tsconfig.app.json` (frontend source), `components.json` (shadcn). There is no `package.json` inside `frontend/`.
- **Vite root is `frontend/`** — the dev server runs from `kawai/` via `bun run dev` (which calls `vite` with root=`frontend/`). Port 1420, strict port.
- **`@` alias → `frontend/src/`** — configured in both `vite.config.ts` and `tsconfig.app.json`. All imports use `@/` (e.g. `@/lib/api`, `@/components/ui/button`).
- **No AI SDK runtime.** `lib/ai-types.ts` is a local type shim — field names are AI-SDK-v5-compatible so the vendored ai-elements components render unmodified, but there is no `ai`/`@ai-sdk/*` npm package.

## Commands

```sh
# From kawai/ (the repo root, NOT frontend/):
bun install           # install all deps (must be done before tauri dev/build)
bun run dev           # vite dev server on :1420
bun run build         # tsc -b && vite build → dist/
bun run typecheck     # tsc -b --force (no build output)
bun run lint          # biome check frontend/src (vendored dirs excluded)
bun run lint:fix      # biome check --write (safe fixes + formatting)
bun run format        # biome format --write frontend/src
bun run test          # vitest run — unit tests for pure helpers
```

Lint/format is Biome (`biome.jsonc` at the repo root). The vendored trees
(`lib/streamdown/**`, `components/ai-elements/**`, `components/ui/**`) and CSS
are excluded from both linter and formatter so re-syncs from `web/` stay
diff-clean. CI runs `lint` + `test` + `build` in the `web` job.

## What's vendored (do NOT edit these unless syncing from upstream)

From the `web/` SPA (updates require the same trims to be reapplied):

- `src/components/ai-elements/` — chat UI components (conversation, message, tool, prompt-input, etc.)
- `src/components/ui/` — shadcn primitives (button, dialog, input, etc.)
- `src/lib/streamdown/` — markdown/streaming renderer (remark, rehype, mermaid, code highlighting)

**Trims applied when vendoring**: replace `ai` imports → `@/lib/ai-types`, strip `react-i18next`, slim `@/platform` to the local adapter (`src/platform/`), remove Lexical, `@xyflow`, `tokenlens`.

From `TencentDB-Agent-Memory/MemoryPanel/web/` (MIT; the Tea-style asset-management UI):

- `src/components/asset/` — `AssetSplitLayout` (drag-resizable split, width persisted to localStorage), `AssetListPanel` (+ 4-line item subcomponents: Name/Id/Desc/Badges/Meta/Time), `AssetPageHeader`. CSS is namespaced (`_alp-*`, `_asset-split-*`) and themed through the `--tea-*` tokens in `index.css`.

**Trims applied when vendoring**: strip `react-i18next` (literal aria-labels), swap `tea-component` `Card` → `@/components/ui/card`, drop multi-tenant pieces (UserBadge, scope toggles), adapt the split height to the app shell (`calc(100dvh - 150px)` instead of the full-page console layout).

## Architecture

### Directory layout

```
frontend/
├── index.html              # entry point; inline script prevents theme flash (localStorage "kawai-theme")
├── src/
│   ├── main.tsx            # React root + TooltipProvider + Toaster (sonner)
│   ├── App.tsx             # main app: three-pane UI (agents rail, chat+canvas, sessions sidebar)
│   ├── index.css           # Tailwind v4 + shadcn semantics aliased to Tea design tokens (--tea-* in :root/.dark; source: tea-component@2.8.0 default theme)
│   ├── lib/
│   │   ├── ai-types.ts     # LOCAL type shim: UIMessage, UIMessagePart, ToolUIPart, etc. (no ai-sdk dep)
│   │   ├── api.ts          # call() — RPC via Tauri invoke + errText helper + backend payload types
│   │   ├── stream.ts       # streamOperation() — streaming via Tauri Channel + cancel_stream
│   │   ├── base64.ts       # bytesToBase64, base64ToBytes, dataUrlToFile, fileToBase64
│   │   ├── extensions.ts   # ADD_FILE_ACCEPT, OFFICE_EXTS, IMAGE_EXTS (single source)
│   │   ├── knowledge.ts    # isYouTubeUrl, classifySource — pure knowledge helpers
│   │   ├── analytics.ts    # analytics agent: detectQueryChart, rowsToCsv, maskSource, isRemoteSource (pure, tested)
│   │   ├── chat-helpers.ts # historyToMessages, toFriendlyError, sessionPeriod, stripToolMarkup
│   │   ├── clipboard.ts    # clipboard read/write helpers (browser APIs)
│   │   ├── download.ts     # triggerDownload() — creates and clicks a temp <a>
│   │   ├── file-types.ts   # fileExtension(), fileKind(), shikiLanguage(), guessMimeType()
│   │   ├── utils.ts        # cn(), formatBytes, isRecord, errText alias + showErrorToast
│   │   ├── preview-file.ts # useFilePreview() hook — fetches + decodes office store files
│   │   ├── preview-bridge.ts # event bridge: tool-renderer cards → App PreviewDialog (no callbacks through vendored tree)
│   │   ├── html-security.ts # containsHTML() — wraps raw HTML outside code fences in safe ```html blocks
│   │   ├── url-security.ts  # SAFE/BLOCKED_PROTOCOLS + customUrlTransform() gating rendered markdown links
│   │   ├── logger.ts        # logError/Warn/Info → Sentry (env-gated) + backend frontend_log + toast
│   │   ├── tool-icon.ts     # tool name → lucide icon for tool cards (getToolCallIcon, extractToolName)
│   │   ├── tool-description.ts # getToolDescription(name, args) — one-line summary for tool cards
│   │   └── streamdown/     # vendored streaming markdown renderer
│   ├── hooks/
│   │   ├── use-supervisor-chat.ts  # session/history shell slice (facade over use-chat-model + use-chat-sessions)
│   │   ├── use-supervisor-plan.ts  # Supervisor execution: plan_task → execute_supervisor_plan → UIMessage parts
│   │   ├── use-chat-model.ts        # model slice: loadModel, resetModelContext, toggleThinking, unloadModel
│   │   ├── use-chat-sessions.ts     # session slice: CRUD, ensureSessionId, groupedSessions
│   │   ├── use-knowledge-actions.ts # knowledge mutations: import, index, session binding, delete + UI state
│   │   ├── use-knowledge-files.ts # knowledge panel list: refresh, markIndexing, markInSession, remove
│   │   ├── use-context-onboarding.ts # empty-data onboarding policy for agents with a sources tab (profile probe + tab focus)
│   │   ├── use-session-filter.ts    # filteredGroups / filteredArchived from query (extracted from SessionsPanel)
│   │   ├── use-app-shortcuts.ts     # ⌘1/2/3 + ⌘N global shortcuts (extracted from App)
│   │   ├── use-auth.ts          # useAuth(): whoami → set_session dev-bypass bootstrap (userId | null)
│   │   ├── use-streamdown.ts    # streamdown plugins (cjk, code, math, mermaid) + translations
│   │   ├── use-theme.ts         # dark/light/system theme with localStorage persistence
│   │   ├── use-copy-button.ts   # copy button with Check/Copy icon swap
│   │   ├── use-retryable-toast.ts # run a promise; on failure toast with a Retry action
│   │   ├── use-skills.ts     # skills asset page: list + create/get/update/remove over the skill_* ops (optimistic)
│   │   ├── use-memories.ts   # memory page L1: list + create/update/remove + memory_extract (cloud tier; guidance toast offline)
│   │   └── use-copy-to-clipboard.ts # copy-to-clipboard primitive with timed reset
│   ├── components/
│   │   ├── ai-elements/    # vendored chat components (from web/ SPA, trimmed)
│   │   │   ├── tool-renderers/   # per-domain tool result cards (cards, connector, finance, geo, media, etc.)
│   │   │   └── ... (conversation, message, tool, prompt-input, code-block, artifact, etc.)
│   │   ├── ui/             # shadcn primitives (vendored from web/)
│   │   ├── asset/          # vendored Tea-style asset-management primitives (from TencentDB-Agent-Memory MemoryPanel): asset-split-layout, asset-list-panel (+ item subcomponents), asset-page-header
│   │   ├── rename-input.tsx # inline rename field (Enter/blur commit, Escape cancel)
│   │   ├── error-boundary.tsx # top-level render crash fallback (Try again / Reload app; mirrors to frontend_log)
│   │   ├── file-icon.tsx   # CDN file-type icons (jsdelivr @lobehub/assets-fileicon)
│   │   ├── file-preview.tsx # dispatches to renderer by file kind (image, video, pdf, text, markdown, fallback)
│   │   ├── message-part-view.tsx  # MessagePartView: tool cards + reasoning + text + copy
│   │   ├── knowledge-file-row.tsx # KnowledgeFileRow + StatusBadge + SectionLabel
│   │   ├── knowledge-dialogs.tsx  # PreviewDialog + LinkDialog (extracted from App)
│   │   ├── session-row.tsx        # SessionRow: active/archived row with rename/archive/delete
│   │   └── sql-profiles-section.tsx # SQL data sources (Knowledge panel): list/add/edit/test/delete profiles
│   ├── panels/
│   │   ├── registry.tsx            # per-agent context-pane composition (CONTEXT_TABS, keyed by agent id)
│   │   ├── agents-rail.tsx        # pane 1: agent catalog rail + Assets section (Wiki/Code/Skills/Memory navigation)
│   │   ├── assets/                # center-pane asset workspace pages (opened from the rail's Assets section; assetView state in App swaps chat → asset page, Esc/agent click returns)
│   │   │   ├── asset-nav.tsx      # ASSET_NAV + AssetViewId — the rail's Assets section metadata
│   │   │   ├── asset-shell.tsx    # shared shell: back-to-chat header + scroll body
│   │   │   ├── wiki-page.tsx      # knowledge base as wiki sources (Tea panel structure): header + Sources list (status/pages/chunks) + Pages|Graph detail tabs (Pages = live preview)
│   │   │   ├── memory-page.tsx    # ChatMemoryPanel structure: header + agent filter + Blocks list + L0–L3 layer tabs (L0 transcript + L1 memories CRUD/extract real; L2/L3 honest empty — no pipeline tier yet)
│   │   │   ├── skills-page.tsx    # Skills over the real skill_* ops: list ↔ detail (markdown body via streamdown) + create/edit dialog + delete (use-skills hook)
│   │   │   └── code-page.tsx      # Code asset workspace over the real codegraph_* ops: status + Register repo (codegraph_init) + explore input + result view
│   │   ├── conversation-panel.tsx # pane 2: chat + model status (virtualization)
│   │   ├── chat-composer.tsx      # composer: @-mention + file chips + speech
│   │   ├── context-panel.tsx      # right context pane: renders the tabs the registry gives it (session/library/databases)
│   │   ├── knowledge-library.tsx  # library tab as a Tea-style asset manager: file list ↔ detail (inline preview + session binding) on the vendored asset primitives
│   │   └── sessions-panel.tsx     # pane 3: session list — search, inline rename, archive/restore, delete
│   ├── platform/
│   │   ├── types.ts        # Platform interface (pickFiles, dictation, screenshots, clipboard, share)
│   │   ├── index.ts        # platform adapter — browser APIs + Tauri dialog for native file picker
│   │   └── shared-media.ts # capability detection + shared Web API implementations
│   └── assets/
│       ├── type.ts         # icon-map type definitions
│       ├── utils.ts        # getIconNameForFileName, getIconForFilePath, etc.
│       └── icon-map.json   # filename/extension → icon name mapping
```

### Data flow

```
User goal → App.tsx → use-supervisor-plan.planAndRun()
  → call("plan_task", {goal, sessionId}) → validated TaskPlan
  → streamOperation("execute_supervisor_plan", {plan, sessionId, streamId})
  → Tauri Channel<SupervisorEvent> (via @tauri-apps/api/core)
  → events: "planStarted" | "stepStarted" | "confirmationRequested" | "stepCompleted" | "stepFailed" | "stepSkipped" | "planCompleted" | "planFailed"
  → use-supervisor-plan folds events into UIMessage[] parts
  → App.tsx renders via Conversation/Message/Tool components + plan progress panel
```

### Backend communication primitives

- **RPC**: `call<T>(command, args?)` — wraps `invoke()` from `@tauri-apps/api/core`. Rejects with a bare string (use `errText()` to normalize).
- **Streaming**: `streamOperation<E>(operation, args, handlers)` — creates a `Channel<E>`, calls `invoke(operation, ..., onEvent: channel)`, returns `{ cancel() }`. Terminal events: `type === "finished"` or `type === "error"`.

## Code conventions

| Concern | Convention |
|---------|------------|
| Imports | `@/` alias for all local imports (`@/lib/api`, `@/components/ui/button`, `@/hooks/use-theme`) |
| Lucide icons | Import individually: `import { MoonIcon, SunIcon } from "lucide-react"` |
| Styling | Tailwind v4 utility classes + `cn()` from `@/lib/utils` for conditional classes |
| CSS | `index.css` defines the raw `--tea-*` tokens (light + dark) and aliases the shadcn semantics to them — theme both via the tea vars, never hardcode colors |
| Components | Prefer `ai-elements/` → `ui/` first; add new shadcn components via `bunx shadcn@latest add` only when nothing fits |
| Hooks | Custom hooks in `hooks/`; each hook is a single file |
| Platform | All platform capabilities go through the `Platform` interface in `platform/types.ts` — never use browser globals directly in components |
| Chat state | `use-supervisor-plan.ts` owns execution state (plan messages, steps, confirmations); `use-supervisor-chat.ts` owns the session/history shell |
| Events | `SupervisorEvent` mirrors the Rust enum in `src-tauri/src/supervisor.rs` (scheduler events come from `kawai-router`). `LocalChatEvent` in `frontend/src/generated/events.ts` (raw `local_chat` stream) is generated from `crates/foundation/events` via `cargo run -p kawai-bindings --bin export-bindings` — never edit generated files manually. Add variant in the source then regenerate to avoid silent drops. |

## Non-obvious patterns

- **Every submission routes through the Supervisor.** `onSend` calls `planAndRun` (session is ensured lazily first). There is exactly one path — the legacy `agent_chat` engine loop, command, handler, and `AgentChatEvent` are fully removed.
- **Tool call events strip `\`\`\`tool` fences** from the display text. The backend may emit tool call frames inside code fences; the frontend removes them from the text part and renders them as separate `ToolUIPart` cards.
- **Session management is lazy.** A session is created on the first user message via `ensureSession()`. The title is seeded from the first message (first 80 chars) and generated server-side.
- **Image paste goes through knowledge, never the model context.** At submit `ChatComposerInner` awaits `onImageToKnowledge` (import + session-bound index; the session is ensured first, so first-message pastes bind correctly) and rides the returned file IDs along like @-mentions (`onSubmit(text, fileIds)`). No image parts are rendered in the user bubble; image data never enters the plan payload.
- **File @-mentions carry IDs, not content.** The composer's @ button opens a `knowledge_list` popover; picked files render as chips and their IDs ride along on the next submit (`onSubmit(text, fileIds)`). The backend binds them to the session and the supervisor tools read them from session scope. Chips clear after submit.
- **Auth bootstrap is in use-supervisor-chat.ts.** The hook first tries `whoami`, then falls back to `set_session` with a dev token. This is the MVP dev-bypass — no Clerk UI is wired in the React frontend.
- **Theme is applied before React mounts** via an inline script in `index.html:7-20`. The `use-theme.ts` hook writes to the same `localStorage` key (`"kawai-theme"`).
- **Agent presentation is a frontend map** (`AGENT_META` in `panels/agents-rail.tsx`). The backend owns agent ids via `list_agents`; the frontend adds icons, subtitles, and suggested prompts. Unknown ids fall back to a generic entry. The right context pane follows the same pattern — `CONTEXT_TABS` in `panels/registry.tsx` decides which tabs each agent gets; agents absent from the map (or tool-less) get no pane and its toggles disappear.
- **Asset workspace navigation is frontend-owned** (`ASSET_NAV` in `panels/assets/asset-nav.tsx`; `assetView` state in `App.tsx`). Opening an asset swaps the center pane (chat → asset page) without touching the chat state — the stream keeps folding in the background; Esc or an agent click returns. Wiki reuses the app's knowledge state, Memory reads `list_chat_sessions`/`list_chat_messages` directly; Skills/Code pages state plainly that their backend tier doesn't exist yet.
- **`file-preview.tsx`** uses `useFilePreview` from `lib/preview-file.ts` which calls `office_read_file` — every mount triggers a backend call. The preview switch mounts only one renderer at a time, so only one fetch happens.
- **`useKnowledgeFiles`** (in `use-knowledge-files.ts`) is feature-gated — if the backend rejects `knowledge_list` (no `office` feature), it settles on an empty list with `unavailable=true`.

## Testing / verification

```sh
# From kawai/:
bun run lint           # biome check — lint + format gate (vendored dirs excluded)
bun run test           # vitest run — unit tests for pure helpers (lib/*.test.ts)
bun run build          # tsc -b + vite build — check for type errors and build failures
bun run typecheck      # tsc -b --force — type-only check, faster
```

Unit tests cover pure helpers only (`chat-helpers`, `base64`, `knowledge`,
`utils`) — colocated `*.test.ts` files, no DOM/component tests. They run in
the CI `web` job alongside lint and build.

## Gotchas

- **`@types/hast` pinned to 3.0.4** via `resolutions` in the root `package.json`. Version 3.0.5 rewrites `Properties.className` to `string[]` and splits the `hast` module identity, breaking the vendored streamdown markdown renderer. Do not bump it.
- **Vite root is `frontend/`** — all paths in `vite.config.ts` are relative to the repo root, not `frontend/`. The `resolve.alias` uses `path.resolve(__dirname, "frontend/src")`.
- **`bun install` must run from the repo root** before any `tauri dev`/`tauri build`. The `node_modules` lives at the repo root, not inside `frontend/`.
- **Tauri `invoke` rejects with a bare string, not an Error.** Always use `errText()` from `@/lib/api` to normalize error messages.
- **Streaming commands must register a `stream_id`** — the frontend generates a `crypto.randomUUID()` in `streamOperation()` and passes it to the backend. The `cancel()` method invokes `cancel_stream` with that ID.
- **No `window.__TAURI__`** — the frontend uses `@tauri-apps/api/core` imports. The `withGlobalTauri` flag is a leftover from the deleted vanilla frontend.
- **Sentry is env-gated.** `main.tsx` initializes Sentry only when `VITE_SENTRY_DSN` is set at build time (`.env.local` or release CI). Without it the SDK is inert — `logger.ts` calls no-op — and the error boundary still renders its fallback locally.
- **The vendored `PromptInput` still captures pasted images** into attachment state. `ChatComposerInner.handleSubmit` intercepts them at submit: each image is awaited through the knowledge import (`imageToKnowledge` — session ensured first, imported file IDs returned) and its IDs join the @-mention IDs on the send.