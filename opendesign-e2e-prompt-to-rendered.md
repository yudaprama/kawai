# E2E: Prompt → Rendered Output (Preview & Export)

Verified end-to-end flow from a user prompt to rendered output — covering both
consumers of the same artifact: the **web preview** and the **desktop export**.
All file paths, symbols, and line numbers below were verified against the
source (2026-06).

> **Scope:** chat → daemon run → artifact/project file → two independent
> consumers (FileViewer preview, deck capture export). Agent CLI internals may
> vary by runtime; the daemon↔web contract is stable.

## Why one document

The deck preview and the deck export used to be documented separately and read
like different projects. They are not: **both consume the same deck HTML
artifact through the same contracts.** The renderers are intentionally
platform-specific, but the artifact, the manifest, the `<deck-stage>` fallback,
and the slide-structure conventions are shared. This document covers the whole
chain with the shared layer made explicit.

## The one artifact, two consumers

```
User types prompt
      │
      ▼
ChatComposer  (prompt + attachments + metadata, stable clientRequestId)
      │
      ▼
POST /api/chat
      │
      ▼
Daemon (registerChatRoutes, apps/daemon/src/routes/chat.ts:65)
      ├── creates/reuses ChatRun (clientRequestId-keyed, SSE events)
      ├── runs agent → deck HTML produced
      │     (brand renderDeck(brand, tokens) OR LLM-authored HTML)
      ├── validates against artifact contract, saves as project file
      └── emits run events via SSE
      │
      ▼
ProjectView matches artifact to project file
      │
      ├──────────────► CONSUMER A — WEB PREVIEW (Part I)
      │                FileViewer iframe: interactive slides,
      │                streaming status, thumbnails
      │
      └──(user export request)──► CONSUMER B — DESKTOP EXPORT (Part II)
                                   hidden Electron BrowserWindow,
                                   CDP capture → PNG / PDF / PPTX
```

**HTML is the visual source of truth.** Neither consumer re-renders the deck
from brand data — both open the same HTML. Consumers A and B are independent:
the export is a separate user action/request that starts from the saved
project file, not from the preview session.

---

# Part I — Prompt → Rendered preview (web)

## Stage 1 — User sends a prompt

**Files:** `apps/web/src/components/ChatComposer.tsx`, `apps/web/src/components/ChatPane.tsx`

`ChatComposer` fires `onSend` with the prompt, attachments, context, and
metadata including a stable `clientRequestId` for idempotent retries. The UI
never sends `user_id` — identity is resolved server-side.

## Stage 2 — Daemon receives the chat request

**File:** `apps/daemon/src/routes/chat.ts` (`registerChatRoutes`)

Daemon validates the request body, checks project/workspace access, rejects
invalid context combinations, creates or reuses a `ChatRun` (keyed by
`clientRequestId`), and connects the client to the run's SSE event stream.
Supporting modules live in `apps/daemon/src/runtimes/` (`chat-run-records.ts`,
`chat-run-lifecycle.ts`, `chat-run-messages.ts`, `run-artifacts.ts`).

## Stage 3 — Agent executes via ChatRun

`ChatRun` holds `id`, `projectId`, `conversationId`, `status`, event stream,
and artifact metadata. The agent produces an event stream: text deltas, tool
calls, artifact creation/modification, errors, terminal events.

Artifacts carry a status contract:

```ts
type ArtifactStatus = 'streaming' | 'complete' | 'error';
```

A `streaming` artifact is not final — the UI must not treat it as done.

## Stage 4 — Artifact becomes a project file

Agent output is saved as project files conforming to the `ProjectFile`
contract (`packages/contracts/src/api/files.ts`): `name`, `path`, `kind`,
`artifactKind`, `artifactManifest`, `traceObjectReason`.

The `ArtifactManifest` (`packages/contracts/src/api/artifacts.ts`) specifies:
- **`kind`** — `html`, `deck`, `deck-html`, `markdown-document`, `react-component`, etc.
- **`entry`** — main file to render
- **`renderer`** — which web renderer to use
- **`status`** — streaming / complete / error
- supporting files, export formats, provenance (`sourceRunId`, `sourceProjectId`)

**Validation before accepting a result:**
1. Artifact has a valid `entry`.
2. `entry` is inside the project (no path traversal).
3. Manifest and file type are consistent.
4. Status is `complete`.
5. Stub guard doesn't flag output as regression (`422 ARTIFACT_REGRESSION` in reject mode).
6. Multi-file outputs have valid supporting references.

## Stage 5 — ProjectView matches artifact to file

**File:** `apps/web/src/components/ProjectView.tsx`

`ProjectView` matches new artifacts to project files using normalized
identifiers and `mtime`, ensuring it selects the current turn's file — not an
old file with a similar name.

Key functions: `artifactBaseNameFor`, `artifactFileNamePattern`,
`findExistingArtifactProjectFile`, `findExistingNonHtmlArtifactProjectFile`.

## Stage 6 — FileViewer renders the document

**Files:** `apps/web/src/components/FileWorkspace.tsx`, `apps/web/src/components/FileViewer.tsx`

`FileWorkspace` passes the active file to `FileViewer`, which picks the render
path:

| Output kind | Path | Result |
|---|---|---|
| HTML | `HtmlViewer` / iframe | Renders with supporting assets |
| Deck HTML (`deck-html`) | deck viewer | Slides previewable and navigable — see Part II for the export counterpart of this same artifact |
| Markdown | `MarkdownViewer` | Markdown preview (split mode may include editor) |
| SVG/image | image renderer | Media displayed without layout breakage |
| React component | `ReactComponentViewer` | Component renders in sandbox |
| Other | artifact renderer registry | Manifest-declared renderer |

`FileViewer` is memoized (iframe subtrees are expensive). On file change, it
reloads by project/file key + `mtime`. For Markdown, content comes from
`fetchProjectFileText`. Streaming/error states must be reflected in the UI.
The srcDoc assembly (`apps/web/src/runtime/srcdoc.ts`) injects the shared
`<deck-stage>` fallback — see Shared layer below.

---

# Part II — Deck HTML → Rendered export (desktop)

The export pipeline does not interpret the prompt; it assumes a valid deck HTML
artifact already exists (produced in Part I, Stages 3–4).

## 1. Deck content prepared

For deterministic brand decks, the core function is:

```ts
// apps/daemon/src/brands/engine/artifacts/deck.ts:305
renderDeck(brand: Brand, tokens: DesignTokens): string
```

Builds slides deterministically from brand fields: Cover, Problem, Solution,
Why Now, Market, Product, Business Model, Competition & Moat, Traction, Team,
The Ask. Content sourced from helpers in
`apps/daemon/src/brands/engine/artifacts/_shared.ts` (`brandTagline()`,
`featureCards()`, `pricingTiers()`, `statItems()`, etc.).

Output structure: `<main class="deck"><section class="slide">...</section></main>`
with inline CSS (`DECK_CSS`) and navigation JS (`DECK_SCRIPT`).

Alternative path: design templates using `<deck-stage>` custom element with
`design-templates/*/assets/deck-stage.js`.

## 2. HTML assembled

`document()` in `apps/daemon/src/brands/engine/artifacts/_shared.ts` wraps deck
body into a full HTML document with `rootVars(tokens)` → CSS custom properties
and `brandFontAssets(brand)` → Google Fonts links.

## 3. Daemon prepares render input

```ts
// apps/daemon/src/deck-export.ts:78
buildDeckRenderInput(options): Promise<DeckRenderRequest>
```

Selects HTML source: `sourceHtml` (direct) or `readProjectFile()` (project
path — i.e. the artifact saved in Part I). Injects `baseHref` for relative
assets and `injectDeckStageFallback()` when `<deck-stage>` is used but the
runtime JS is missing.

Route entry: `apps/daemon/src/import-export-routes.ts`.

## 4. Desktop loads HTML in hidden BrowserWindow

```ts
// apps/desktop/src/main/deck-capture.ts:233
renderDeckSlides(input: DesktopRenderSlidesInput): Promise<DesktopRenderSlidesResult>
```

Creates a hidden `BrowserWindow` (1920×1080, sandboxed,
`contextIsolation: true`, `nodeIntegration: false`). Loads the HTML via
`data:text/html` URL after injecting `baseHref`. Waits for `dom-ready` with a
timeout.

## 5. Fonts/assets loaded, stage measured

`waitForPrintableContent(window)` (`apps/desktop/src/main/pdf-export.ts:338`)
ensures fonts and images finish loading before capture.

`measureSlideStage(window)` reads the authored deck geometry; falls back to
1920×1080 if invalid. Then `pinDeckStage()` locks `html`, `body`, `.deck`, and
stage to that fixed size so capture is independent of the host viewport.

## 6. Deck vs Page mode

Desktop counts slides via
`SLIDE_SELECTOR = ".slide, [data-screen-label], .deck-slide, .ppt-slide"`
(excluding `.mini-slide`, `.overview`, `.notes-overlay`, `.thumb`).
`shouldCaptureAsDeck(hasSlides, deckSignal)` decides: explicit `deck: true`
forces deck mode, explicit `deck: false` forces page mode, otherwise slide
presence determines it. This prevents plain pages with a `.slide` class from
being captured as a deck.

## 7. Slides activated one by one

```ts
showDeckSlide(window, index, stage)
```

Injects JS to: activate the target slide, wait two animation frames, read its
bounding rect, confirm it's in the capture viewport, and restack if it's
inside a carousel/strip.

## 8. Chromium captures each slide

```ts
captureDeckSlide(window, dbg, index, stage)
```

**Primary path (CDP):** `Page.captureScreenshot` with a clip rect matching the
pinned stage dimensions → base64 decoded to `NativeImage`. CDP is preferred
because it captures the current DOM frame directly, avoiding stale composited
frames.

**Fallback (Electron):** `window.webContents.capturePage(rect)` when the CDP
debugger isn't available.

Output loop produces PNG or JPEG per slide, written to `outputDir` or returned
as data URLs.

## 9. Stitched tall image (optional)

When `input.stitch` is enabled, `stitchDeckSlides()` captures all slides,
copies BGRA bitmaps into a single vertical buffer, and encodes once as
PNG/JPEG. Memory/height budget enforced (`DECK_STITCH_MAX_H = 30000`,
`DECK_STITCH_MAX_BYTES = 320 MB`) — downscales rather than dropping slides.

## 10. PDF output

```ts
// apps/daemon/src/deck-export.ts:204
buildScreenshotPdf(images)
```

Creates one PDF page per image, sized from the image aspect ratio.
**Screenshot-based PDF** — text lives inside images, not as selectable PDF
text.

## 11. PPTX output — two modes

**Screenshot PPTX** (`buildScreenshotPptx()`, `deck-export.ts:159`): one
full-bleed image per PowerPoint slide. Pixel-perfect visually, but no native
editable objects.

**Editable PPTX** (`renderEditablePptx()`): shows all slides at authored
geometry, loads `dom-to-pptx` bundle, normalizes DOM, optionally captures
layered backgrounds separately, then runs `dom-toPptx()` to produce native
PowerPoint shapes/text where possible. Output is a real `.pptx`, not
screenshots.

---

# How the LLM generates the deck HTML

The LLM never invents a deck from scratch. There are **two bases**, in strict
priority order:

1. **Skill/template seed (wins when present):** when the user starts from a
   template (the New-project "Start from" rail → `skills/` or
   `design-templates/` registries) whose `assets/template.html` exists, the
   daemon injects **that seed** into the prompt and **skips the generic
   skeleton** (`system.ts:13-26`, `1312-1320`: "Skill seeds (when present)
   win" — a seed plus the generic skeleton would conflict).
2. **Generic frozen skeleton (fallback):** projects with no bound skill get
   the `DECK_SKELETON_HTML` scaffold described below.

On top of either base, a bound design system's tokens must be bound into the
seed/skeleton `:root` before layout (`system.ts:1213`).

The template registries surfaced in the UI:

- `skills/` — functional skills + templates (e.g. `html-ppt-retro-quarterly-review`);
  each entry: `SKILL.md` + `assets/template.html` seed + `references/`.
- `design-templates/` — the rendering catalogue (`html-ppt`, `dashboard`, …);
  served via `/api/design-templates` with the same `SkillSummary` shape as
  `/api/skills`, so the web client renders both in one rail.

## 0. Deck intent detection → what gets injected

`apps/daemon/src/prompts/system.ts` detects deck briefs through two paths:

- **Explicit:** skill mode = `deck`, or project metadata `kind === 'deck'`.
- **Heuristic:** `detectDeckIntentSignal` (`system.ts`, regex over `slides?`,
  `deck`, `pitch deck`, `pptx`, 演示， 提案， …) — for freeform projects without a
  deck skill. The detection is deliberately "generous": a false positive only
  injects the ~20K framework directive; a false negative means the agent
  hand-rolls deck scaffolding, which is the historically buggy outcome.

On detection, `DECK_FRAMEWORK_DIRECTIVE` (`apps/daemon/src/prompts/deck-framework.ts`)
is pinned **last** in the system prompt.

## 1. Fallback basis: the generic skeleton with SLOTs

With no skill seed, `DECK_SKELETON_HTML` (a string constant in
`apps/daemon/src/prompts/deck-framework.ts:47` — never a file on disk) is the
basis. It is a literal HTML document the model must copy verbatim.
Motivation (from the file's own header): regenerating the scale-to-fit JS,
keyboard handler, and slide visibility toggle every turn produced subtly
different bugs each time — wrong focus, scaling drift inside the iframe
wrapper, swallowed arrow keys. So the fragile parts are frozen in the prompt;
the model only fills the safe parts:

| Skeleton part | Model may edit? |
|---|---|
| Framework `<style>` + JS (1920×1080 canvas, fit/scale, keyboard, print rules, OD Deck Protocol v1) | ❌ DO NOT EDIT |
| `:root` theme tokens (`--bg`, `--accent`, …) | ✅ SLOT |
| Per-deck `<style>` block | ✅ SLOT |
| `<section class="slide">` bodies | ✅ SLOT — first slide must be `class="slide active"` |

The directive closes with: *"your output is this skeleton with theme tokens
tuned, per-deck classes added, and slide blocks filled in — nothing more,
nothing less."* The 1920×1080 pattern was chosen deliberately because it is
the pattern the model has the strongest prior on, so the framework gets
adopted verbatim instead of being "blended" with the model's own instincts.

## 2. Style constraints from design systems

When the project has a bound design system, the system prompt additionally
injects (`system.ts`):

- **Component manifest** — the component inventory (selectors, class names,
  token references) the generated artifact must match.
- **Reference fixture** — verbatim `components.html` as a worked example;
  copying fragments is encouraged as long as `var(--*)` references stay intact.

## 3. File writes via native tools

The model writes/edits the HTML file through the runtime's native file tool
(the file becomes visible in the file panel + preview immediately). Emitting
source in an `<artifact>` block in chat is forbidden. New artifacts use
semantic filenames (`investor-pitch-deck.html`), not `index.html`.

## 4. Validation → artifact

The produced file passes the artifact validation (Part I, Stage 4), becomes a
`kind: 'deck'` project file, and is consumed by both the preview (FileViewer)
and the export (deck capture).

## Two production paths

- **LLM-authored** (above): general decks from a user prompt.
- **Deterministic:** `renderDeck(brand, tokens)` (`brands/engine/artifacts/deck.ts:305`)
  — no LLM at all; a brand template assembles the standard 11 slides (Cover,
  Problem, … The Ask) for reproducible brand decks.

The skeleton's structure (`<section class="slide">` on a 1920×1080 canvas) is
exactly the contract read by `SLIDE_SELECTOR` in the export pipeline and by
the web thumbnail rail — which is why prompt, preview, and export stay in
sync.

---

# Files that handle HTML generation

Reference map for the HTML-generation path described above:

| File | Role |
|---|---|
| `skills/*/assets/template.html`, `design-templates/*/` | Template seeds — the primary basis when the user picks one in the New-project rail. |
| `apps/daemon/src/prompts/system.ts` | System-prompt assembly. Base priority: skill seed > generic skeleton. Detects deck intent (`detectDeckIntentSignal`, skill mode / `kind === 'deck'`) and pins `DECK_FRAMEWORK_DIRECTIVE` last; injects design-system component manifest + reference fixture. |
| `apps/daemon/src/prompts/deck-framework.ts` | The frozen fallback scaffold: `DECK_SKELETON_HTML` (literal HTML the model copies verbatim — framework CSS/JS, SLOTs) + `DECK_FRAMEWORK_DIRECTIVE` (what is fixed vs editable). Used only when no skill seed exists. |
| `apps/daemon/src/prompts/discovery.ts` | Discovery/requirements-gathering prompt shaping the brief before generation. |
| `packages/contracts/src/runtime/deck-protocol.ts` | `DECK_PROTOCOL_V1_INLINE_RUNTIME` — the OD Deck Protocol v1 navigation/slide-state JS embedded in the skeleton. |
| `apps/daemon/src/skills.ts` (+ `apps/daemon/src/skills/`) | Skill resolution — a deck skill layers typography/theme/layout vocabulary on top of the framework. |
| Runtime file tools (`write_file` / edit, dispatched per runtime — see `apps/daemon/src/runtimes/json-event-stream.ts`, `claude-stream.ts`) | The tool interface through which the model writes/edits the HTML file into the project folder. |
| `apps/daemon/src/brands/engine/artifacts/deck.ts` | `renderDeck(brand, tokens)` — the deterministic (non-LLM) production path for brand decks; `_shared.ts` supplies `document()`, content helpers, `rootVars`, `brandFontAssets`. |
| `apps/daemon/src/run-artifacts.ts` (via `apps/daemon/src/runtimes/`) | Validation + persistence of the produced HTML as a project file (`ArtifactManifest`), making it consumable by preview and export. |

---

# How React renders the LLM-generated HTML

The rendered preview is **not** a server-rendered page — it is the raw HTML
file displayed inside a **sandboxed iframe in `FileViewer.tsx`**, with the
host injecting bridges into it at load time.

## 1. From artifact to iframe

1. The agent's `write_file` lands → run event over SSE → `ProjectView.tsx`
   matches the artifact to a project file (Part I, Stage 5).
2. `FileViewer.tsx` reads the manifest `renderer` (`html` / `deck-html`) and
   mounts an `<iframe>` for the active file. Iframes are expensive subtrees,
   so the component is memoized and reloads by project/file key + `mtime`.

## 2. Two load modes — URL vs srcDoc

`file-viewer-render-mode.ts` (`UrlLoadDecision` → `shouldUrlLoadHtmlPreview`)
decides between:

- **URL load** — plain preview, no bridges needed: the iframe `src` points at
  the daemon-served file URL (faster, browser-native loading).
- **srcDoc injection** — required whenever a feature must inject JS into the
  artifact: deck navigation, comment/inspect selection, edit mode, tweaks
  palette, draw/snapshot, sandbox shim, redirect guard. Per repo convention,
  bridges can ONLY go through the srcDoc path, and the host keeps BOTH iframes
  mounted (URL + srcDoc) swapping CSS visibility, so toggling render mode
  never reloads the iframe.

## 3. The srcDoc assembly pipeline — `apps/web/src/runtime/srcdoc.ts`

`buildSrcdoc(html, options)` (line 345) takes the raw artifact HTML and wraps
it in a layered pipeline, each layer injecting one bridge:

```
raw HTML
  → full-doc check / fragment wrap  (doctype shell if needed)
  → sanitizeTitleInDoc              (title safety)
  → annotateMissingOdIds            (stable element ids for bridges)
  → injectBaseHref + baseHref bridge (relative assets resolve)
  → injectSandboxShim               (opaque-origin storage/history sandbox)
  → injectPreviewRedirectGuard      (redirect-loop protection)
  → observability bridge            (preview telemetry)
  → deck: keydown registry, motion freeze,
          injectDeckStageFallback,  ← shared with export (see Shared layer)
          deck chrome hiding,
          injectDeckBridge          ← host↔iframe postMessage controls
  → selection / palette / edit / tweaks bridges (feature-gated)
  → snapshot / export-capture / content-size bridges
  → data-od-reload-key              (reload identity)
```

## 4. The deck bridge — how the host drives slides

For `deck-html` artifacts, the injected deck bridge lets the React host
advance/rewind slides without the iframe having keyboard focus, via
`postMessage`:

- host → iframe: `{ type: 'od:slide', action: 'next' | 'prev' | 'first' | 'last' | 'go', index? }`
- iframe → host: a Protocol-v1-native artifact announces `od:deck-ready`, then
  emits versioned `od:slide-state` after every navigation, so the host renders
  its own counter/dots (`DeckThumbnailRail`, `DeckSlideThumbnail` consume the
  same slide structure via `deck-slide-structure.ts` / `deck-thumbnail-parser.ts`).
- Legacy persisted decks (no protocol markers) are kept working by injected
  keyboard/hash/DOM adapters.

This is also why the AGENTS.md rule exists that feature bridges must be added
as `UrlLoadDecision` disqualifiers: any new injection requirement must force
the srcDoc path, or it silently breaks in URL-loaded previews.

---

# Shared layer — the actual reuse

The two parts above read differently because their renderers are
platform-specific. The reuse lives one layer down:

### 1. Artifact contract — `packages/contracts/src/api/artifacts.ts`

`ArtifactManifest` with `kind: 'deck' | 'deck-html'`, `entry`, `renderer`,
`status`. The same type decides which renderer `FileViewer` picks (Part I,
Stage 6) and which export mode `import-export-routes.ts` offers (Part II,
step 3). `ProjectFile` lives in `packages/contracts/src/api/files.ts`.

### 2. `<deck-stage>` fallback — `packages/contracts/src/runtime/deck-stage-fallback.ts`

`injectDeckStageFallback(html)` is one function consumed by all three apps:

| App | Call site |
|---|---|
| web preview | `apps/web/src/runtime/srcdoc.ts` (srcDoc assembly, Part I) |
| daemon export | `apps/daemon/src/deck-export.ts` (`buildDeckRenderInput`, Part II step 3) |
| desktop capture | `apps/desktop/src/main/deck-capture.ts` (shadow-DOM rule awareness) |

When an agent authors `<deck-stage>` without shipping its runtime JS, this
fallback guarantees the deck still lays out at authored geometry — in the
browser preview and in the capture window alike.

### 3. Slide-structure conventions

- Desktop selector: `SLIDE_SELECTOR = ".slide, [data-screen-label], .deck-slide, .ppt-slide"` and `DECK_STAGE_SELECTOR = "deck-stage, #deck-stage, .deck-stage"` (`apps/desktop/src/main/deck-capture.ts`).
- Web equivalents: `apps/web/src/runtime/deck-slide-structure.ts`
  (`collectLegacyDeckScreenSlides`), `apps/web/src/runtime/deck-thumbnail-parser.ts` —
  consumed by `DeckSlideThumbnail.tsx`, `DeckThumbnailRail.tsx`, `FileViewer.tsx`.

Both sides agree on what counts as a slide, so the preview's thumbnail rail and
the export's per-slide capture stay in sync.

### 4. What is intentionally NOT shared

- **Renderer code.** Web preview is an interactive iframe (srcDoc bridges,
  navigation, streaming status); desktop export is an offscreen Chromium
  capture (`Page.captureScreenshot` → `capturePage` fallback).
  Platform-native code cannot cross, and the requirements conflict
  (interactivity vs pixel determinism).
- **Producers.** `renderDeck(brand, tokens)` (deterministic brand template)
  and LLM-authored HTML (framework skeleton + slots — see "How the LLM
  generates the deck HTML" above) are just two producers of the same
  artifact; neither consumer knows or cares which produced it.

---

# Contracts to uphold

1. **HTML is the visual source of truth.** Both consumers open and render HTML — neither draws slides from brand data directly.
2. **Brand renderer is deterministic.** `renderDeck(brand, tokens)` is template-based, not LLM-generated.
3. **`.slide` ≠ `<deck-stage>`.** Brand decks use `.deck` + `.slide`; some templates use `<deck-stage>`. Web preview and desktop capture handle both.
4. **Deck vs Page mode is explicit.** A plain page with a `.slide` class won't be captured as a deck when `deck: false` is set.
5. **Editable PPTX ≠ Screenshot PPTX.** Screenshot PPTX embeds images; editable PPTX runs `dom-to-pptx`.
6. **All slides are preserved.** Stitching downscales to fit budget rather than dropping the last slide.
7. **Relative assets need base href.** `data:` URL loading requires an injected `baseHref` for asset resolution.
8. **Presenter chrome is excluded.** Navigation overlays and UI chrome are hidden before capture.
9. **Preview and export are independent consumers.** The export starts from the saved project file, not from the preview session — breaking the preview must not break export and vice versa.

# Maintenance notes

- When changing `deck-stage-fallback`, slide selectors, or the artifact
  manifest, update the relevant sections of **both** parts plus both consumers
  (web + desktop) in the same change.
- The preview section (Part I) and export section (Part II) were previously
  separate docs; they were merged because they describe two consumers of one
  pipeline.
