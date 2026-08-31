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

- `src/features/assets/components/asset/` — `AssetSplitLayout` (drag-resizable split, width persisted to localStorage), `AssetListPanel` (+ 4-line item subcomponents: Name/Id/Desc/Badges/Meta/Time), `AssetPageHeader`. CSS is namespaced (`_alp-*`, `_asset-split-*`) and themed through the `--tea-*` tokens in `index.css`.

**Trims applied when vendoring**: strip `react-i18next` (literal aria-labels), swap `tea-component` `Card` → `@/components/ui/card`, drop multi-tenant pieces (UserBadge, scope toggles), adapt the split height to the app shell (`calc(100dvh - 150px)` instead of the full-page console layout).

## Architecture

### Directory layout

```
frontend/
├── index.html              # entry point; inline script prevents theme flash (localStorage "kawai-theme")
├── src/
│   ├── main.tsx            # React root + TooltipProvider + Toaster (sonner)
│   ├── app/
│   │   └── App.tsx         # main app: three-pane UI (agents rail, chat+canvas, sessions sidebar)
│   ├── index.css           # Tailwind v4 + shadcn semantics aliased to Tea design tokens (--tea-* in :root/.dark)
│   │
│   ├── features/           # feature-organized domain code
│   │   ├── auth/            # authentication: auth-gate.tsx, use-auth.ts, supabase.ts
│   │   ├── agents/          # agent catalog rail + context pane composition: agents-rail.tsx, registry.tsx, context-panel.tsx
│   │   ├── chat/            # chat + supervisor execution
│   │   │   ├── components/  # chat-composer, conversation-panel, message-part-view, session-row, sessions-panel
│   │   │   ├── hooks/       # use-chat-model, use-chat-sessions, use-supervisor-chat, use-supervisor-plan
│   │   │   ├── lib/         # chat-helpers (+test)
│   │   │   └── index.ts    # public barrel export
│   │   ├── knowledge/       # knowledge/RAG panel
│   │   │   ├── components/  # knowledge-dialogs, knowledge-file-row, knowledge-file-summary, knowledge-library
│   │   │   ├── hooks/       # use-knowledge-actions, use-knowledge-files
│   │   │   └── lib/         # knowledge.ts (+test)
│   │   ├── memory/          # memory page: components/memory-page.tsx, hooks/use-memories, use-memory-tiers
│   │   ├── skills/          # skills page: components/skills-page.tsx, hooks/use-skills
│   │   ├── analytics/       # analytics: components/sql-profiles-section.tsx, lib/analytics.ts (+test)
│   │   ├── codegraph/       # code asset page: components/code-page.tsx
│   │   ├── tools/           # tool-workbench.tsx, tool-description.ts, tool-icon.ts
│   │   └── assets/          # shared asset-management UI primitives
│   │       ├── components/asset/  # vendored Tea-style: asset-split-layout, asset-list-panel, asset-page-header
│   │       ├── components/asset-nav.tsx  # ASSET_NAV + AssetViewId — the rail's Assets section metadata
│   │       ├── components/asset-shell.tsx  # shared shell: back-to-chat header + scroll body
│   │       └── pages/wiki-page.tsx  # knowledge base as wiki sources
│   │
│   ├── components/
│   │   ├── ui/             # shadcn primitives (vendored from web/)
│   │   ├── ai-elements/    # vendored chat components (from web/ SPA, trimmed)
│   │   │   └── tool-renderers/   # per-domain tool result cards
│   │   ├── notifications/   # NotificationCenter, NotificationItem
│   │   ├── shared/          # cross-feature reusable product UI: file-preview, file-icon, rename-input
│   │   └── error-boundary.tsx # top-level render crash fallback (mirrors to frontend_log)
│   ├── hooks/              # truly global hooks (use-theme, use-app-shortcuts, use-session-filter, etc.)
│   ├── lib/                # infrastructure: api.ts, stream.ts, utils.ts, logger.ts, ai-types.ts, preview-*.ts, ...
│   │   ├── streamdown/     # vendored streaming markdown renderer
│   │   └── native-notifications/ # tauriBridge.ts
│   ├── contexts/           # React contexts (NotificationContext.tsx)
│   ├── platform/           # platform adapter (types.ts, index.ts, shared-media.ts)
│   ├── generated/          # generated API types and events (never edit manually)
│   └── assets/             # static asset helpers (icon-map.json, type.ts, utils.ts)
```

### Data flow

```
User goal → app/App.tsx → use-supervisor-plan.planAndRun()
  → call("plan_task", {goal, sessionId}) → validated TaskPlan
  → streamOperation("execute_supervisor_plan", {plan, sessionId, streamId})
  → Tauri Channel<SupervisorEvent> (via @tauri-apps/api/core)
  → events: "planStarted" | "stepStarted" | "confirmationRequested" | "stepCompleted" | "stepFailed" | "stepSkipped" | "planCompleted" | "planFailed"
  → use-supervisor-plan folds events into UIMessage[] parts
  → app/App.tsx renders via Conversation/Message/Tool components + plan progress panel
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
| Chat state | `features/chat/hooks/use-supervisor-plan.ts` owns execution state (plan messages, steps, confirmations); `features/chat/hooks/use-supervisor-chat.ts` owns the session/history shell |
| Events | `SupervisorEvent` mirrors the Rust enum in `src-tauri/src/supervisor.rs` (scheduler events come from `kawai-router`). `LocalChatEvent` in `frontend/src/generated/events.ts` (raw `local_chat` stream) is generated from `crates/foundation/events` via `cargo run -p kawai-bindings --bin export-bindings` — never edit generated files manually. Add variant in the source then regenerate to avoid silent drops. |

## Non-obvious patterns

- **Every submission routes through the Supervisor.** `onSend` calls `planAndRun` (session is ensured lazily first). There is exactly one path — the legacy `agent_chat` engine loop, command, handler, and `AgentChatEvent` are fully removed.
- **Tool call events strip `\`\`\`tool` fences** from the display text. The backend may emit tool call frames inside code fences; the frontend removes them from the text part and renders them as separate `ToolUIPart` cards.
- **Session management is lazy.** A session is created on the first user message via `ensureSession()`. The title is seeded from the first message (first 80 chars) and generated server-side.
- **Image paste goes through knowledge, never the model context.** At submit `ChatComposerInner` awaits `onImageToKnowledge` (import + session-bound index; the session is ensured first, so first-message pastes bind correctly) and rides the returned file IDs along like @-mentions (`onSubmit(text, fileIds)`). No image parts are rendered in the user bubble; image data never enters the plan payload.
- **File @-mentions carry IDs, not content.** The composer's @ button opens a `knowledge_list` popover; picked files render as chips and their IDs ride along on the next submit (`onSubmit(text, fileIds)`). The backend binds them to the session and the supervisor tools read them from session scope. Chips clear after submit.
- **Auth bootstrap is in use-auth.ts.** On mount: Supabase session → `set_session`; fallback → `whoami` → `restore_session` (OS keychain). Deep-link handler listens for `kawai://auth` callbacks (PKCE code exchange + implicit token). OAuth opens in system browser via `skipBrowserRedirect` + `openUrl`. The dev bypass (`KAWAI_AUTH_DEV_USER_ID`) is env-gated in the Rust backend, never in the frontend.
- **Theme is applied before React mounts** via an inline script in `index.html:7-20`. The `use-theme.ts` hook writes to the same `localStorage` key (`"kawai-theme"`).
- **Agent presentation is a frontend map** (`AGENT_META` in `features/agents/agents-rail.tsx`). The backend owns agent ids via `list_agents`; the frontend adds icons, subtitles, and suggested prompts. Unknown ids fall back to a generic entry. The right context pane follows the same pattern — `CONTEXT_TABS` in `features/agents/registry.tsx` decides which tabs each agent gets; agents absent from the map (or tool-less) get no pane and its toggles disappear.
- **Asset workspace navigation is frontend-owned** (`ASSET_NAV` in `features/assets/components/asset-nav.tsx`; `assetView` state in `app/App.tsx`). Opening an asset swaps the center pane (chat → asset page) without touching the chat state — the stream keeps folding in the background; Esc or an agent click returns. Wiki reuses the app's knowledge state, Memory reads `list_chat_sessions`/`list_chat_messages` directly; Skills/Code pages state plainly that their backend tier doesn't exist yet.
- **`file-preview.tsx`** (in `components/shared/`) uses `useFilePreview` from `lib/preview-file.ts` which calls `office_read_file` — every mount triggers a backend call. The preview switch mounts only one renderer at a time, so only one fetch happens.
- **`useKnowledgeFiles`** (in `features/knowledge/hooks/use-knowledge-files.ts`) is feature-gated — if the backend rejects `knowledge_list` (no `office` feature), it settles on an empty list with `unavailable=true`.

## Testing / verification

```sh
# From kawai/:
bun run lint           # biome check — lint + format gate (vendored dirs excluded)
bun run test           # vitest run — unit tests for pure helpers (lib/*.test.ts)
bun run build          # tsc -b + vite build — check for type errors and build failures
bun run typecheck      # tsc -b --force — type-only check, faster
```

Unit tests cover pure helpers only (`base64`, `utils`, and colocated
`*.test.ts` files inside `features/chat/lib/`, `features/analytics/lib/`,
`features/knowledge/lib/`) — no DOM/component tests. They run in the CI
`web` job alongside lint and build.

## Gotchas

- **`@types/hast` pinned to 3.0.4** via `resolutions` in the root `package.json`. Version 3.0.5 rewrites `Properties.className` to `string[]` and splits the `hast` module identity, breaking the vendored streamdown markdown renderer. Do not bump it.
- **Vite root is `frontend/`** — all paths in `vite.config.ts` are relative to the repo root, not `frontend/`. The `resolve.alias` uses `path.resolve(__dirname, "frontend/src")`.
- **`bun install` must run from the repo root** before any `tauri dev`/`tauri build`. The `node_modules` lives at the repo root, not inside `frontend/`.
- **Tauri `invoke` rejects with a bare string, not an Error.** Always use `errText()` from `@/lib/api` to normalize error messages.
- **Streaming commands must register a `stream_id`** — the frontend generates a `crypto.randomUUID()` in `streamOperation()` and passes it to the backend. The `cancel()` method invokes `cancel_stream` with that ID.
- **No `window.__TAURI__`** — the frontend uses `@tauri-apps/api/core` imports. The `withGlobalTauri` flag is a leftover from the deleted vanilla frontend.
- **Sentry is env-gated.** `main.tsx` initializes Sentry only when `VITE_SENTRY_DSN` is set at build time (`.env.local` or release CI). Without it the SDK is inert — `logger.ts` calls no-op — and the error boundary still renders its fallback locally.
- **The vendored `PromptInput` still captures pasted images** into attachment state. `ChatComposerInner.handleSubmit` intercepts them at submit: each image is awaited through the knowledge import (`imageToKnowledge` — session ensured first, imported file IDs returned) and its IDs join the @-mention IDs on the send.