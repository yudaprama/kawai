# Implementation Plan — Adopting markra's CodeMirror editor (kawai)

Status: **DESIGN ONLY — no code landed.** Every claim below was verified by
reading files in the `markra/` checkout (v2.13.0, HEAD `4560ba1`) and
kawai's own sources. Nothing from markra has been vendored, no dependency has
been added, and no build config has been touched.

Read this before writing any code. The plan's job is to decide *how* the
editor enters kawai without duplicating capability kawai already owns.

---

## 1. Why this is not a "copy the files" job

`markra/` is a pnpm workspace. `packages/editor` + `packages/editor-react`
are **31,359 + 576 lines** of TypeScript source (unbuilt — `exports` point at
`./src/index.ts`). kawai has **no CodeMirror dependency at all** and, today,
**no document-editing surface**: the React frontend only ever *displays*
output through the vendored streamdown fork.

So this is an adoption, not a refactor: the question is which parts of the
editor are genuinely new capability, and which are markra's private
implementations of things kawai already has.

---

## 2. What markra's editor actually is

Two layers, and the distinction decides everything in §3.

### 2a. CodeMirror-free primitives (`packages/editor/src/*`, 3,203 LoC)

Importable without any CodeMirror dependency. External edges are exactly
`katex`, `lowlight`, dynamic `mermaid`, `unified` (type-only),
`cspell-trie-lib` (type-only), `@lezer/markdown`.

| File | LoC | Responsibility |
|---|---|---|
`math-render.ts` | 139 | `katex.renderToString` wrapper + `\newcommand` TeX scanner |
`math-syntax.ts` | 208 | `$$`/`\[…\]`/`$`/`\(…\)` range finder, code-block-aware |
`mermaid.ts` | 92 | lazy mermaid import, theme mapping, SVG render |
`code-support.ts` | 119 | lowlight `common` registry → class-name spans |
`raw-html-sanitize.ts` | 369 | DOM allowlist sanitizer (tag/attr/CSS-property) |
`html-table.ts` | 235 | `<table>` grid model: rowspan/colspan, merge/split |
`html-table-actions.ts` | 187 | table structure ops serialised back to HTML |
`hugo-math.ts` | 437 | micromark extension for Hugo `\(…\)` math |
`plain-text-paste.ts` | 326 | lezer-driven markdown-literal escaping on paste |
`spellcheck.ts` | 332 | tokenizer + trie/wordset checkers + Levenshtein |
`markdown-source-detection.ts` | 25 | does this text look like markdown |
`shortcuts.ts` | 28 | pure re-export façade over `@markra/shared` |
`html-attributes.ts` | 8 | `rowspan`/`colspan` range parsing |
`clipboard-asset-types.ts` | 27 | type-only |
`ai-preview-events.ts` | 43 | event names for the AI diff surface |
`index.ts` | 11 | barrel |

### 2b. CodeMirror plugin layer (`packages/editor/src/codemirror/*`, 31,359 LoC)

Every file here imports `@codemirror/state` and/or `@codemirror/view`. Largest:

`table.ts` (1,761) · `code-block.ts` (1,642) · `ai-preview.ts` (1,028) ·
`preview.ts` (988) · `block-drag.ts` (823) · `clipboard-assets.ts` (666) ·
`image.ts` (664) · `controller.ts` (658) · `inline-markdown.ts` (618) ·
`blocks.ts` (577) · `html-table-widget.ts` (563)

`editor-react/` adds 576 LoC: `MarkraEditorProvider`, `useMarkraEditorView`, a
`ViewPlugin`→`useSyncExternalStore` bridge, and hooks for the slash menu,
selection toolbar, and document links.

**This layer is 100% new capability for kawai.** No equivalent exists, so the
reuse analysis in §3 applies almost entirely to §2a.

---

## 3. Reuse analysis — file by file

Rule: if kawai already does the job, kawai's implementation wins and markra's
is dropped or reduced to a seam. Verified against kawai's actual sources.

| markra file | kawai already has | Decision |
|---|---|---|
`code-support.ts` (lowlight) | `lib/streamdown/plugins/code.ts` — **shiki 4**, async, dual-theme, token + highlighter caches | **Drop lowlight.** The plugin takes `highlight` as an injected function; kawai supplies a shiki-backed implementation. lowlight is a second highlighter with a second palette. |
`mermaid.ts` | `lib/streamdown/plugins/mermaid.ts` + `lib/streamdown/lib/mermaid/*` (pan-zoom, fullscreen, PNG export) | **Drop markra's loader.** `codeBlockPreviewPlugin` takes `renderMermaid`; point it at the existing plugin. kawai's `securityLevel: "strict"` is stricter than markra's `"antiscript"` — keep kawai's. |
`math-render.ts` | katex 0.18 in the tree; `rehype-katex` in the pipeline | **Use kawai's katex.** The renderer is a 10-line `renderToString` call; the `math-preview.ts` call site is the only consumer. |
`raw-html-sanitize.ts` | `rehype-raw` → `rehype-sanitize` → `rehype-harden` → `lib/rehype/data-image-src.ts` | **Keep, but it is NOT duplication.** markra's sanitizer operates on a **DOM** (CodeMirror `WidgetType.toDOM`); kawai's operates on **HAST** (unified pipeline). Two contexts, two input shapes. Verified: kawai's pipeline already drops `script`, `on*`, `style`, and non-`http(s)` `href` — the markra sanitizer adds nothing kawai's lacks. |
`hugo-math.ts` (437) | `remark-math` in kawai | **Drop.** Hugo `\(…\)`/`\[…\]` delimiters are a static-site-generator dialect. kawai renders chat/agent output, not Hugo sites. 437 LoC for zero kawai use cases. |
`shortcuts.ts` (28) | pure re-export of `@markra/shared` | **Drop.** It has no behaviour of its own; kawai's menu/shortcut wiring is `lib/settings/` + Tauri native menu. |
`spellcheck.ts` | none | **Keep, with `cspell-trie-lib` replaced.** markra imports `type ITrie` only — the trie is constructed by tests. A structural `SpellcheckTrie` interface drops the dependency at zero behavioural cost. |
`plain-text-paste.ts` | none (kawai's only paste handler is image→knowledge) | **Keep.** lezer-driven escaping is genuinely new. |
`html-table*.ts` | none | **Keep.** Interactive table editing is new. |
`math-syntax.ts` | `remark-math` (deliberately `singleDollarTextMath: false`) | **Keep as a supplement** if inline-`$` math is ever wanted. Verified the current setting is *correct*: enabling it turns `$5 and $6` and `$HOME and $PATH` into math. |
`ai-preview.ts` + `ai-selection-hold.ts` + `ai-preview-events.ts` (1,162) | kawai's `kawai-agent` tool loop | **Defer.** All four `@markra/ai` imports are `import type` — zero runtime coupling, so this is separable. Wire to `kawai_tools` later or skip. |

### Dependency verdicts

**Dead in markra's own manifest** — declared but **0 source imports**, so
installing them buys nothing: `@codemirror/search`, `remark-frontmatter`,
`remark-math`, `@cspell/cspell-types`.

**Genuinely new** (unpacked sizes, npm registry):

| Package | Size | Why |
|---|---|---|
`@codemirror/view` | 1,237 KB | editor core |
`@lezer/markdown` | 452 KB | parser |
`@codemirror/state` | 434 KB | document model |
`@codemirror/language` | 310 KB | syntax tree |
`@codemirror/commands` | 243 KB | undo / `isolateHistory` |
`@lezer/common` | 246 KB | tree types |
`turndown` | 192 KB | HTML→markdown paste; no kawai equivalent |
`@lezer/highlight` | 100 KB | `==mark==` tag names |
`@codemirror/lang-markdown` | 72 KB | language extension |
`@replit/codemirror-vim` | 717 KB | **lazy** — `vim.ts:197` dynamic-imports it; out of the initial bundle |

**Rejected:**

| Package | Size | Reason |
|---|---|---|
`lucide` | **20 MB** | 5 icons (`Minus`, `Plus`, `Trash2`, `TableCellsMerge`, `TableCellsSplit`) in 2 files. kawai has `components/ui/`. Inline the SVGs. |
`lowlight` | 60 KB | duplicate highlighter |
`cspell-trie-lib` | 331 KB | type-only import |

Net: **~3.3 MB unpacked**, entering as a lazy chunk. Nothing lands in the
initial bundle.

### The `@codemirror/view` patch

markra carries one patched dependency (`patches/@codemirror__view@6.41.1.patch`):
on macOS 26+, WebKit reads `focus({preventScroll: true})` but still resets
ancestor scroll. Upstream CodeMirror works around it for Safari 26+, but
**WKWebView omits the `Version/` UA token** and is detected as version 0. The
patch widens the condition to `>= 26 || == 0` in both `dist/index.js` and
`dist/index.cjs`.

kawai runs in Tauri/WKWebView, so this likely matters — a single click becoming
a range selection is exactly the bug it prevents. markra's patch is pnpm-
formatted; kawai is bun. `patchedDependencies` works in both, but the patch
must be copied and re-verified, not symlinked. **Decision required:** port the
patch, or verify the symptom first.

### Dependency landscape — kawai vs markra (full inventory)

Side-by-side of both package graphs (kawai root `package.json` vs markra
`packages/*` + `apps/*`, markra v2.13.0). Three groups: same role / different
library, same library / different version, and one-sided.

**Same role, different library:**

| Role | kawai | markra |
|---|---|---|
| Markdown → React | `marked` + `hast-util-to-jsx-runtime` (+ vendored `streamdown`) | `react-markdown` (app) |
| HTML sanitisation | `rehype-sanitize` + `rehype-harden` + `rehype-raw` (HAST pipeline) | `raw-html-sanitize.ts` DOM allowlist (§3, §5 — not duplication) |
| Line breaks / CJK | `remark-cjk-friendly` + `remark-cjk-friendly-gfm-strikethrough` | `remark-breaks` |
| Syntax highlighting | `shiki` 4.4.3 | `lowlight` (highlight.js) — rejected, see §5 |
| Editing surface | none (streamdown is read-only) | CodeMirror 6 (`@codemirror/*`) + `@lezer/*` — the whole point of this plan |
| HTML → markdown | none in JS (Rust `logic/scrape.rs`) | `turndown` (+ `@mozilla/readability` + `jsdom` in `packages/ai`) |
| LLM runtime | no SDK — hand-written Rust SSE client (`crates/foundation/remote-llm`) + on-device LiteRT-LM | `ai` 6 + 11 `@ai-sdk/*` providers + `@earendil-works/pi-agent-core` / `pi-ai` |
| UI primitives | `radix-ui` + `cmdk` | `@base-ui/react` |
| Icons | none (inline SVG / `components/ui/`) | `lucide` / `lucide-react` — rejected, see §5 |
| Fonts | `@fontsource-variable/inter`, `jetbrains-mono` | `@fontsource-variable/noto-sans`, `noto-sans-sc` |
| Animation / drag | `motion` (Framer Motion) | `@dnd-kit/{core,sortable,utilities}` (no animation lib) |
| Telemetry | `@sentry/react` | none |

**Same library, different version (potential conflicts if the seam shares
them):**

| Package | kawai | markra | Note |
|---|---|---|---|
| `katex` | 0.18.4 (pinned) | 0.16.45 | §5 says "use kawai's katex" — markra pins 0.16.45 exactly, so the adapter must compile against kawai's 0.18 and markra's 0.16 call sites are dropped. |
| `mermaid` | 11.16.1 | 11.15.0 | kawai's loader wins (§5). |
| `unified` | 11.0.5 | 11.0.5 | identical |
| `remark-parse` / `remark-gfm` / `remark-math` | 11.0.0 / 4.0.1 / 6.0.0 | same | identical (but `remark-math` is dead in markra's manifest, §3) |
| `sonner` | ^2.0.8 | ^2.0.7 | compatible range |
| `@tanstack/react-virtual` | ^3.14.9 | 3.14.2 | compatible |
| `react` / `react-dom` | ^19.2.7 | 19.2.5 exact peer | §4 open question 4 |
| `@tauri-apps/api` | ^2.12.1 | 2.11.0 (pinned in `packages/markdown`) | §4 open question 4 |
| `vite` / `tailwindcss` / `typescript` / `vitest` | ^8.1.1 / ^4.3.2 / ~6.0.2 / ^4.1.11 | 8.0.10 / ^4.2.4 / 6.0.3 / 4.1.5 | build-time only |

**One-sided (present in only one graph):**

| Only kawai | Only markra |
|---|---|
| `@rive-app/react-webgl2`, `d3-force`, `qrcode.react`, `media-chrome`, `embla-carousel-react`, `ansi-to-react`, `nanoid`, `use-stick-to-bottom`, `vue` (root-level legacy), `@sentry/react`, `shiki`, `marked`, `streamdown` (vendored) | `@codemirror/*`, `@lezer/*`, `@replit/codemirror-vim`, `turndown`, `@mozilla/readability`, `jsdom`, `cspell-trie-lib`, `css-tree`, `@noble/hashes`, `yaml`, `remark-frontmatter`, `@dnd-kit/*`, `lucide`, `@base-ui/react`, `mdast-util-to-string`, `ignore` (apps/web) |

Takeaway for this plan: the only dependencies the adoption genuinely adds are
the CodeMirror/Lezer family + `turndown` + `mdast-util-to-string` (§5 "kept
whole" list); everything else markra pulls in is either already in kawai's
tree under a different version (katex, mermaid), already rejected as
duplicate capability (lowlight, lucide), or dead in markra's own manifest.

---

## 4. Integration mechanism — three options

### A. Vendor the sources into `frontend/src/lib/markra/` — simplest

`cp -R` the two packages under the frontend tree. One workspace, one package
manager, no boundary to configure. This is what the current `markra/` checkout
is set up for (unbuilt TS sources, resolved through the workspace graph).

Costs: 31k lines are now kawai's to maintain; re-syncing from upstream means a
manual diff, and `biome` needs an override (131 `noNonNullAssertion` hits).

### B. Git submodule / tracked fork — recommended

`markra/` becomes a submodule. kawai's frontend imports across the submodule
boundary via a path alias. markra's own release cadence and patch management
keep working — including `patchedDependencies`.

Costs to plan for: the submodule's `pnpm` workspace vs kawai's `bun`; the
`@markra/*` packages ship unbuilt TS sources so `tsc` must consume them
directly; and markra pins `@codemirror/*` **exactly** and peers
`react@19.2.5` **exactly** while kawai has `react@^19.2.7` and
`@tauri-apps/api@^2.12.1` (markra pins `2.11.0` in `packages/markdown`).

### C. Consume as a published package — blocked

markra's packages are `"private": true` and unbuilt. Publishing requires
vendoring or forking either way.

---

---

## 5. Seam mapping — what kawai injects, what it drops

markra's editor is built for dependency injection: 16 `*PluginOptions`
interfaces, four of which are injection points for exactly the functions
kawai already owns. Every option name below was read from the source.

### Injected: kawai's implementation replaces markra's

| Plugin option | markra default (dropped) | kawai adapter | New deps |
|---|---|---|---|
`codeBlockPreviewPlugin({ highlight })` | `highlightMarkraCode` → lowlight | `plugins/code.ts` (shiki) | 0 |
`codeBlockPreviewPlugin({ renderMermaid })` | `renderMermaidToSvg` → own loader | `plugins/mermaid.ts` | 0 |
`imagePreviewPlugin({ resolveSource })` | `resolveSafeImageSource` → local allowlist | `preview-file.ts` base64 | 0 |
`linksPlugin({ resolveTarget })` | scheme allowlist | `url-security.ts` + `LinkSafetyModal` | 0 |

`tablePreviewPlugin({ images, links })` forwards to the image and link
resolvers; `rawHtmlPreviewPlugin({ resolveImageSrc })` forwards to the DOM
sanitizer. Both are covered by the four rows above.

### Dropped outright

| File | Reason |
|---|
`code-support.ts` (lowlight) | second highlighter, second palette |
`mermaid.ts` | second mermaid loader and init path |
`math-render.ts` | a 10-line `katex.renderToString` wrapper; call it directly at `math-preview.ts:163` |
`shortcuts.ts` (28 LoC) | pure re-export of `@markra/shared`, no behaviour |
`hugo-math.ts` (437 LoC) | Hugo `\( \)`/`\[ \]` dialect, no kawai use case |
`lucide` (20 MB) | 5 icons; `components/ui/` covers them |

### Kept whole

`plain-text-paste.ts` · `spellcheck.ts` · `search.ts` · `links.ts` (reference
links, `![[wikilinks]]`, Windows paths) · `table.ts` · `html-table*.ts` ·
`raw-html-sanitize.ts` · `markdown.ts` (outline + CJK word count) ·
`markdown-source-detection.ts` · `clipboard-assets.ts`

`raw-html-sanitize.ts` is **not** duplication: it sanitises a **DOM** (a
CodeMirror `WidgetType.toDOM`), while kawai's pipeline sanitises **HAST**
(unified). Different contexts, different input shapes.

### Dependencies actually added

```
@codemirror/{state,view,language,commands,lang-markdown}   ~2.3 MB
@lezer/{markdown,common,highlight}                        ~0.8 MB
turndown                                                   192 KB
mdast-util-to-string                                        13 KB
@replit/codemirror-vim                717 KB — lazy (dynamic import, vim.ts:197)
```

Rejected: `lowlight`, `lucide`, `cspell-trie-lib` (type-only → local
`SpellcheckTrie`). Dead in markra's own manifest (0 source imports, so
installing them buys nothing): `@codemirror/search`, `remark-frontmatter`,
`remark-math`, `@cspell/cspell-types`.

Net **~3.3 MB unpacked**, entering as a lazy chunk. Nothing overlaps a
dependency kawai already has.

---

## 6. Image resolution — async resolver (decided)

**Decision: make `ImagePreviewPluginOptions["resolveSource"]` accept a
promise.** This is the only place kawai's storage model genuinely diverges
from markra's.

### The conflict

| | Contract |
|---|
markra | `(context) => string \| null`, called synchronously from `ImageWidget.toDOM` (`image.ts:298`) and `syncImageSource` (`:298`). A `null` marks the widget `markra-image-node-source-invalid` (`image.ts:301`) and it never retries. `ImageWidget` has `eq()` (`:337`) but **no `update()`**. |
kawai | Bytes are read over IPC: `office_read_file` → `crates/engines/office/src/store.rs:526` `read_file_b64` → base64. `preview-file.ts` already does this correctly (LRU 64 at `:57`, in-flight dedupe at `:60-61`) but exposes it as `useFilePreview` — a React hook, asynchronous. |

A synchronous resolver cannot await a promise, and returning `null` kills the
widget permanently.

### Why not the alternatives

**`convertFileSrc` + asset protocol (rejected).** The files *are* on disk —
`store.rs:251` writes them and `store.rs:540` `file_path` returns the absolute
path. But serving them to the webview means granting it a path scope over
`<data_root>/<user_id>/`, which leaks every other document that user owns.
`commands.rs:1901-1902` deliberately avoids exactly this: `tauri_open_file`
resolves the id to a path **in Rust** and opens it, with the comment *"no
webview-side path scope needed."* `tauri.conf.json` today sets only
`security.csp`, no `assetProtocol`. This option contradicts a settled
security decision.

**Cache-peek + re-dispatch ViewPlugin (rejected).** Keeps `image.ts`
byte-identical, but creates two resolution paths — synchronous `peek()` plus
asynchronous `prime()` plus a `view.dispatch` when bytes land. Correctness
then depends on every call site remembering to prime; a caller that forgets
fails **silently** (the widget just stays `…-source-invalid`, no error). It
also stacks a second cache on top of the LRU that already exists, and bakes
in a synchronous-only assumption that breaks if kawai's storage model ever
moves off base64.

### The change

1. `ImagePreviewPluginOptions["resolveSource"]` returns
   `string | null | Promise<string | null>`.
2. `ImageWidget` gains `update()` — the CodeMirror idiom for a widget whose
   content settles after first render. It awaits the promise and assigns
   `src` directly. `updateImageElement` (`image.ts:176-178`) already skips
   reassigning an unchanged `src`, so the async path must do the same to
   avoid a reload flash.
3. `syncImageSource` (`image.ts:296-303`) awaits before deciding invalid vs
   valid — it currently decides in one synchronous step.

Two call sites total (`resolveImageSource` is invoked from `syncImageSource`
and from the widget constructor).

### Why this one

One resolution path, one cache, one mechanism. It is also the only option that
does not foreclose a future storage model: a `resolveSource` that may return a
promise keeps working if images move from base64 to a URL. The cost is that
`image.ts` (664 LoC) is no longer byte-identical to markra, so re-syncing
upstream needs this patch applied — a narrow, stable contract change that
markra would accept as a PR, and the same treatment `lib/streamdown/**`
already gets in `biome.jsonc`.

---

## 7. Build-size strategy

kawai's `vite.config.ts` externalises heavy markdown/highlight deps to esm.sh
via the importmap in `frontend/index.html` (shiki, mermaid, katex, remark*,
unified, marked — about 15.4 MB kept out of the bundle). Two constraints
follow:

1. **The editor must be code-split.** Import it from a lazily-loaded route or
   panel, never from the app root, or CodeMirror lands in the initial chunk.
2. **If the editor uses shiki, the importmap must cover its entry points.**
   markra's `code-support.ts` uses `lowlight`; a shiki-backed replacement
   reaches `shiki/core`, `shiki/themes/*`, `shiki/langs/*`, which the current
   importmap does not map. Verified that esm.sh serves all of those paths
   (`/shiki@4.4.3/core`, `/themes/github-dark.mjs`, `/langs/rust.mjs` all
   return 200) — the importmap just needs the entries.

An alternative is to bundle CodeMirror locally and skip externalisation for it.
That trades ~3.3 MB of lazy chunk for a self-contained module. **Decide when
wiring, not before.**

---

## 8. Open questions

1. **Integration mechanism.** Submodule fork vs vendored copy. (§4)
2. **CodeMirror patch.** Port markra's Safari/WKWebView patch, or verify the
   symptom first? (§3)
3. **Package manager seam.** markra is pnpm, kawai is bun. Does the editor
   build inside its own workspace, or does kawai install its deps?
4. **Version pins.** markra pins every `@codemirror/*` exactly and peers
   `react@19.2.5` exactly. Relax the peers, or pin kawai down?
5. **AI preview.** Wire markra's `ai-preview.ts` (1,162 LoC, type-only
   coupling) to `kawai_tools`, or defer it?
6. **Mode.** markra ships `source` / `split` / `visual` (`App.tsx:305`). Which
   does kawai need first? `visual` alone is the smallest coherent surface.
7. **Image resolution.** Decided — async `resolveSource`. (§6)
8. **Table widget width mode** persists to `localStorage` under markra's own
   key. Adopt kawai's settings store instead, or keep the local key?

---

## 9. Suggested sequencing

Each step is independently verifiable; none of them requires deciding every
open question up front.

1. **Stand up the editor read-only** — `liveMarkdown()` + `MarkraEditorProvider`
   in a lazy panel, `visual` mode only, no AI. This exercises the CodeMirror
   integration, the bun/pnpm seam, and the bundle-split strategy with the
   smallest possible surface.
2. **Swap the four seams** — shiki `highlight`, kawai mermaid `renderMermaid`,
   kawai katex `renderToString`, kawai `url-security` link resolver (§5).
   Each is an injected function in markra's plugin options, so each is a single
   adapter and one test.
3. **Make `resolveSource` async** (§6) and wire `preview-file.ts` into it.
4. **Drop the dead weight** — `hugo-math.ts`, `shortcuts.ts`, the four
   zero-import dependencies, `lucide` → inline SVG, `cspell-trie-lib` →
   structural type.
5. **Add editing features in value order** — tables, images, links, math
   preview, paste.
6. **AI preview last**, once the editing surface is stable.
7. **Delete** anything §3 marked "drop" rather than carrying it.

---

## Appendix — verification commands

Run at every step; all must pass clean:

```sh
bun run typecheck
bun run lint
bun run test
bun run build
```

Two adjustments will be needed:

- **Test environment.** The editor's own tests need `jsdom`; kawai's current
  tests are pure functions. A `vitest.config.ts` with two projects (node for
  kawai, jsdom for the editor) avoids forcing jsdom globally. Note that under
  this Node version jsdom's `window.localStorage` getter returns `undefined`,
  so a `Storage` shim is needed for `lib/i18n.ts` and the editor's table
  width-mode persistence.
- **Lint/format.** markra's source uses non-null assertions and dense widget
  builders throughout (131 `noNonNullAssertion` hits). If the editor is vendored
  rather than a submodule, it needs a `biome.jsonc` override like the existing
  `**/lib/streamdown/**` one, so re-syncs stay diff-clean.