# Deck slide runtime — markdown rendering in the app

How deck previews render inside the kawai workbench, how the pipeline was
built, the debugging method that cracked it, and the pitfalls (as rules).
See `DECK-RENDERER-COMPARISON.md` for the Slidev / Showmaker / kawai analysis.

## Current architecture

One deck, three render paths from structured content:

```
Deck stored in the office store (self-contained reveal.js HTML + manifest)

├── PREVIEW (in-app)
│     office_read_deck → Slidev-style markdown
│     → DeckPreview (Vue island: markdown-it → DOM, one slide at a time,
│       16:9 frame, ← → nav) — no iframe, no measurement, by-construction fit
│
├── PRESENT (full fidelity)
│     "Open full deck" → reveal.js file in the system browser
│
└── EXPORT
      office_export_deck → deterministic PPTX (office_oxide)
```

### Backend

- `office_create_deck`: the model picks **layouts and fills bounded fields**
  (`DeckSlideV2` enum: title/section/bullets/two-cols/fact/quote/table/image)
  **or** submits Slidev-style markdown (`markdown` field). It NEVER writes
  HTML. Every slide is validated against bounds (3–6 bullets ≤140 chars,
  ≤14-char fact numbers, ≤6×5 tables, …) — over-fill is rejected with
  actionable messages and the model self-corrects.
- Rendering is fixed per-layout templates in Rust (`DeckSlideV2::body_html`)
  → the same sanitize → probe → store pipeline as before. Because templates
  are hand-fitted to the 980×551 canvas, frame/content overflow is impossible
  by construction.
- `office_read_deck` returns `{title, template, themeCss, slides, markdown}`:
  `slides` = sanitized `<section>` fragments (legacy path), `markdown` = the
  deck body as Slidev-style markdown — the source for the frontend runtime.

### Frontend

- `DeckPreview` (workbench): fetches `office_read_deck`, then renders via a
  **Vue island** (Vue 3 full build + markdown-it, ~200 KB bundled once):
  markdown → DOM at runtime, one slide at a time, inside a 16:9
  `aspect-video` frame. `html: false` in markdown-it keeps rendering inert;
  content was already sanitized server-side.
- The frame is correct **by construction**: `aspect-video` + `overflow-y-auto`
  — no JS measurement anywhere.
- `DeckDemoPage` (Assets → Deck Preview) is the same runtime standalone,
  fed by an inline demo markdown string.

## How it was built — the method

The frame/content fit problem consumed ~a dozen failed iterations while the
fix, once found, was small. The difference was method, not difficulty:

1. **Evidence before theory.** Every debugging round started from the store
   (meta.json, manifest), `turn_log` (outcome, latency 0 ms = validation
   failure, not rendering), and app.log — never from guessing. Latency-0
   errors meant deserialization; that single clue eliminated half the
   hypotheses.
2. **Reproduce with eyes before theorizing.** The turning point was a
   standalone HTML reproduction of the exact preview DOM rendered in a real
   browser via automation, screenshotted and measured (`getBoundingClientRect`,
   computed styles). Two screenshots settled what a dozen theory rounds
   could not. For anything visual: build the smallest repro, look at it,
   measure the actual layout values.
3. **When a hypothesis can't be tested from outside, put the runtime values
   on screen.** A temporary debug line (`artifacts=N · kind:handle:filename`)
   resolved a state-chain dispute in one round trip.
4. **Each fix must be enforced by code, not by prompt.** Rules that live only
   in prompts ("vary the layouts", "don't default to consulting-clean") do
   not hold: the model anchored on the tool-description example and produced
   four identical decks. Promotion to mechanics (system-owned template
   rotation, bounds validation) is what actually holds.
5. **Close bug classes, don't patch bugs.** The final redesign — structured
   layouts + fixed templates — made the overflow bug class impossible rather
   than fixable. If a fix is the Nth patch on the same symptom, the
   representation is wrong.

## Pitfalls — as rules for anyone touching this code

- **Never let the model emit markup** (HTML or HTML-ish). Structured layouts
  only; new visual capabilities = new layout variant + template, not more
  model freedom.
- **`vue` package default export is runtime-only** (no template compiler).
  The deck runtime needs `vue/dist/vue.esm-bundler.js` plus the Vue feature
  flags (`__VUE_OPTIONS_API__` etc.) defined in `vite.config.ts`. Symptom of
  getting this wrong: the island mounts and silently renders nothing.
- **`---` has a double role in markdown decks**: slide separator AND
  frontmatter fence. Parsing it naively splits a slide's frontmatter from its
  content. The parser is a state machine (frontmatter open/close); a slide's
  fenced frontmatter must always open with `---` before its keys.
- **Embedded fonts change text metrics after first paint.** Any measurement
  (fit/shrink) must re-run via ResizeObserver + `document.fonts.ready`.
- **The deck note renders in TWO canvas views**: the "final" deliverable and
  the deck_writer step report. Any hero/preview must cover both
  (`effective === "final" || effective === "__deliverable"`), or users will
  report "it doesn't render" while looking at the step report.
- **`turn_log.latency_ms = 0` with `outcome=error`** on a tool call means an
  instant validation/deserialization failure — go read the tool's args
  parsing, not the rendering.
- Template example in a tool description **anchors the model**: rotate it,
  or better, remove the choice from the model entirely (system-owned
  selection).

## Remaining work

- Port production theme CSS (Slidev/Quarto, MIT) into the frontend runtime
  and the reveal.js export — the visual-quality lever.
- Persist the deck's source markdown at create time so markdown-authored
  decks preview 100% faithfully (currently regenerated from HTML).
- Optional: `quarto render` as an opt-in external exporter (Showmaker's
  model — user-installed renderer is acceptable UX).
