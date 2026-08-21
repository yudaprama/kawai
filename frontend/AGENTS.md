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
```

## What's vendored (do NOT edit these unless syncing from `web/`)

The following are copied from the `web/` SPA and trimmed. Updates from `web/` require the same trims to be reapplied:

- `src/components/ai-elements/` — chat UI components (conversation, message, tool, prompt-input, etc.)
- `src/components/ui/` — shadcn primitives (button, dialog, input, etc.)
- `src/lib/streamdown/` — markdown/streaming renderer (remark, rehype, mermaid, code highlighting)

**Trims applied when vendoring**: replace `ai` imports → `@/lib/ai-types`, strip `react-i18next`, slim `@/platform` to the local adapter (`src/platform/`), remove Lexical, `@xyflow`, `tokenlens`.

## Architecture

### Directory layout

```
frontend/
├── index.html              # entry point; inline script prevents theme flash (localStorage "kawai-theme")
├── src/
│   ├── main.tsx            # React root + TooltipProvider wrapper
│   ├── App.tsx             # main app: three-pane UI (agents rail, chat+canvas, sessions sidebar)
│   ├── index.css           # Tailwind v4 + shadcn + custom CSS variables ("Hatchet" design tokens)
│   ├── lib/
│   │   ├── ai-types.ts     # LOCAL type shim: UIMessage, UIMessagePart, ToolUIPart, etc. (no ai-sdk dep)
│   │   ├── api.ts          # call() — RPC via Tauri invoke + errText helper + backend payload types
│   │   ├── stream.ts       # streamOperation() — streaming via Tauri Channel + cancel_stream
│   │   ├── clipboard.ts    # clipboard read/write helpers (browser APIs)
│   │   ├── download.ts     # triggerDownload() — creates and clicks a temp <a>
│   │   ├── file-types.ts   # fileExtension(), fileKind(), shikiLanguage(), guessMimeType()
│   │   ├── utils.ts        # cn() (clsx+tailwind-merge), formatSize(), errorMessage(), etc.
│   │   ├── preview-file.ts # useFilePreview() hook — fetches + decodes office store files
│   │   └── streamdown/     # vendored streaming markdown renderer
│   ├── hooks/
│   │   ├── use-local-chat.ts    # central chat state: LocalChatEvent → UIMessage parts, sessions, model mgmt
│   │   ├── use-knowledge-files.ts # knowledge panel list: refresh, markIndexing, markInSession, remove
│   │   ├── use-streamdown.ts    # streamdown plugins (cjk, code, math, mermaid) + translations
│   │   ├── use-theme.ts         # dark/light/system theme with localStorage persistence
│   │   ├── use-copy-button.ts   # copy button with Check/Copy icon swap
│   │   └── use-copy-to-clipboard.ts # copy-to-clipboard primitive with timed reset
│   ├── components/
│   │   ├── ai-elements/    # vendored chat components (from web/ SPA, trimmed)
│   │   │   ├── tool-renderers/   # per-domain tool result cards (cards, connector, finance, geo, media, etc.)
│   │   │   └── ... (conversation, message, tool, prompt-input, code-block, artifact, etc.)
│   │   ├── ui/             # shadcn primitives (vendored from web/)
│   │   ├── file-icon.tsx   # CDN file-type icons (jsdelivr @lobehub/assets-fileicon)
│   │   └── file-preview.tsx # dispatches to renderer by file kind (image, video, pdf, text, markdown, fallback)
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
User prompt → App.tsx → use-local-chat.send()
  → streamOperation("agent_chat", {agentId, sessionId, message})
  → Tauri Channel<LocalChatEvent> (via @tauri-apps/api/core)
  → events: "started" | "token" | "toolCall" | "toolResult" | "finished" | "error"
  → use-local-chat folds events into UIMessage[] parts
  → App.tsx renders via Conversation/Message/Tool components
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
| CSS | `index.css` uses CSS variables for theme (Hatchet design tokens); `.dark` variant |
| Components | Prefer `ai-elements/` → `ui/` first; add new shadcn components via `bunx shadcn@latest add` only when nothing fits |
| Hooks | Custom hooks in `hooks/`; each hook is a single file |
| Platform | All platform capabilities go through the `Platform` interface in `platform/types.ts` — never use browser globals directly in components |
| Chat state | `use-local-chat.ts` is the single source of truth for all chat state (messages, sessions, model status) |
| Events | `LocalChatEvent` in `use-local-chat.ts` mirrors the backend's `#[serde(tag = "type")]` enum — add arms for new variants in all matchers or events are silently dropped |

## Non-obvious patterns

- **`use-local-chat.ts` hardcodes `"agent_chat"`** as the stream operation name for every agent. The `local_chat` path is legacy and no longer invoked by the frontend.
- **Tool call events strip `\`\`\`tool` fences** from the display text. The backend may emit tool call frames inside code fences; the frontend removes them from the text part and renders them as separate `ToolUIPart` cards.
- **Session management is lazy.** A session is created on the first user message via `ensureSession()`. The title is seeded from the first message (first 80 chars) and generated server-side.
- **Image paste goes to knowledge panel, not the model.** The `ChatComposerInner` routes pasted images (data: URLs) to the knowledge import pipeline via `onImageToKnowledge`. The composer is text + speech only.
- **Auth bootstrap is in use-local-chat.ts** (lines 96-118). The hook first tries `whoami`, then falls back to `set_session` with a dev token. This is the MVP dev-bypass — no Clerk UI is wired in the React frontend.
- **Theme is applied before React mounts** via an inline script in `index.html:7-20`. The `use-theme.ts` hook writes to the same `localStorage` key (`"kawai-theme"`).
- **Agent presentation is a frontend map** (`AGENT_META` in `App.tsx`). The backend owns agent ids via `list_agents`; the frontend adds icons, subtitles, and suggested prompts. Unknown ids fall back to a generic entry.
- **`file-preview.tsx`** uses `useFilePreview` from `lib/preview-file.ts` which calls `office_read_file` — every mount triggers a backend call. The preview switch mounts only one renderer at a time, so only one fetch happens.
- **`useKnowledgeFiles`** (in `use-knowledge-files.ts`) is feature-gated — if the backend rejects `knowledge_list` (no `office` feature), it settles on an empty list with `unavailable=true`.

## Testing / verification

There are no unit tests in the frontend. Verification is:

```sh
# From kawai/:
bun run build          # tsc -b + vite build — check for type errors and build failures
bun run typecheck      # tsc -b --force — type-only check, faster
```

## Gotchas

- **`@types/hast` pinned to 3.0.4** via `resolutions` in the root `package.json`. Version 3.0.5 rewrites `Properties.className` to `string[]` and splits the `hast` module identity, breaking the vendored streamdown markdown renderer. Do not bump it.
- **Vite root is `frontend/`** — all paths in `vite.config.ts` are relative to the repo root, not `frontend/`. The `resolve.alias` uses `path.resolve(__dirname, "frontend/src")`.
- **`bun install` must run from the repo root** before any `tauri dev`/`tauri build`. The `node_modules` lives at the repo root, not inside `frontend/`.
- **Tauri `invoke` rejects with a bare string, not an Error.** Always use `errText()` from `@/lib/api` to normalize error messages.
- **Streaming commands must register a `stream_id`** — the frontend generates a `crypto.randomUUID()` in `streamOperation()` and passes it to the backend. The `cancel()` method invokes `cancel_stream` with that ID.
- **No `window.__TAURI__`** — the frontend uses `@tauri-apps/api/core` imports. The `withGlobalTauri` flag is a leftover from the deleted vanilla frontend.
- **The vendored `PromptInput` still captures pasted images** into attachment state. `ChatComposerInner.handleSubmit` intercepts them and routes them to the knowledge panel instead of discarding.