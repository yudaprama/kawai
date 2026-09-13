# Deck renderer comparison — kawai vs Slidev vs Showmaker vs presenterm

Analysis after implementing the v2 structured deck format and the native
`DeckPreview` renderer (see `docs/` history: frame/content fit sessions).
Covers the reference systems, what each solves well, where kawai
stands, and the recommended path.

## The systems

| | **Slidev** (`slidev/`, local) | **Showmaker** (`showmaker/`, local) | **presenterm** (`presenterm/`, local) | **kawai** (current) |
|---|---|---|---|---|
| Shape | Web toolchain (Node/Vite/Vue) | Desktop app, Tauri + Rust (~545 lines) | Terminal tool, pure Rust (~17.5k lines) | Feature inside desktop app, Tauri + Rust |
| Input | Markdown (`---` separators, frontmatter per slide) | Markdown (Quarto/YAML header) | Markdown (`<!-- end_slide -->` separators, YAML frontmatter) + HTML-comment commands (`<!-- column_layout: [3,2] -->`, `<!-- pause -->`, includes) | JSON v2 structured layouts (`DeckSlideV2`) or Slidev-style markdown (`office_create_deck` `markdown` field) |
| Conversion engine | Vite compile per deck — Node required at build time | External `quarto render` subprocess — Quarto required on user machine | Fully in-process Rust: comrak markdown → presentation model → direct terminal render (kitty/iTerm2/wezterm/ghostty/sixel graphics protocols) | In-process Rust: fixed per-layout templates → reveal.js HTML (sanitize → probe → store) |
| Output | Static SPA; PDF/PNG/PPTX via headless browser | Self-contained reveal.js HTML | Terminal-native TUI presentation; self-contained HTML export (in-process); PDF via external weasyprint; no PPTX | Self-contained reveal.js HTML + deterministic PPTX (office_oxide) |
| Themes | ★★★ Mature npm theme packages (seriph, apple-basic, …) | ★★ Quarto reveal themes (~12, clean) | ★★ 13 built-in YAML themes + user theme YAML (colors, margins, alignment, footer, per-layout styling) | ★ 3 bundled starters + 187-pack catalogue (visual quality not yet on par) |
| Preview | The app itself | Webview shows rendered output | The terminal is the presenter; hot-reload on file change | Native DOM preview (`DeckPreview`): one slide at a time, no iframe |
| AI | None built-in (external Copilot/Gemini) | None — but "often authored with generative AI" | None | ★ AI-first: deck writer agent synthesizes slides from supervisor step outputs |
| Distribution | npm (developer tool) | Installer + user installs Quarto | Single Rust binary (crates.io/brew/nix/winget); PDF export needs weasyprint | Self-contained, zero external dependencies |

## Key findings

### 1. Slidev's quality does not come from markdown

Markdown is the plainest content format that exists. Slidev's decks look good
because of **themes**, **layout components**, and **a fixed canvas with
disciplined content** — all design work, not format work. kawai's v2 already
implements the same principle (model fills structured layouts; Rust renders
fixed templates), so the format is no longer the bottleneck. What is worth
adopting from Slidev:

- **The markdown dialect as a human-readable/editable surface** — implemented
  (`parse_deck_markdown`); users can read and request revisions in a format
  that reads like slides.
- **MIT theme designs** — port to template packs (`registry.json`). This is
  the single biggest visual-quality lever.
- **Layout idioms** — `two-cols`, `quote`, `fact`, `section`, `image` already
  exist as v2 layouts; theme ports should carry their per-layout styling.

The engine itself cannot be adopted: conversion is a Vite/Node build per deck
(no runtime renderer exists), which would require bundling Node into a
self-contained desktop app.

### 2. Showmaker validates the "external renderer" option

Showmaker ships as a Tauri app whose entire render pipeline is a subprocess
call to an installed Quarto binary — and users accept installing Quarto for
the output quality. This legitimizes an **opt-in external render path** for
kawai (e.g. `quarto render` as an alternative exporter) without changing the
architecture. It also shows the ceiling of that approach: minimal features,
no PPTX, no RAG, no AI orchestration.

Showmaker's output (self-contained reveal.js HTML) is the same artifact
species as `office_create_deck`'s — the difference is template quality and
who authors the content.

### 3. presenterm is the strongest validation of kawai's architecture shape

Of the four systems, presenterm is the only one that matches kawai's shape:
**pure Rust, fully in-process, single self-contained binary, zero external
dependencies at present time**. It parses markdown (comrak) into an internal
presentation model and renders it directly — no Node build (Slidev), no
installed subprocess (Showmaker/Quarto). It proves that a Rust-only pipeline
is a complete, production-grade way to run decks end to end.

What transfers to kawai:

- **The bounded control surface, third instance.** presenterm deliberately
  rejects HTML inside markdown — the author's stated reasons are nesting
  chaos in the rendering code and forcing users into markup for a narrow
  need. Instead, layout is HTML-comment commands (`column_layout: [3,2]`,
  `column: 0`, `pause`, `end_slide`). This is the same conclusion kawai
  reached the hard way (finding 1): the renderer must own markup; the author
  gets bounded commands, not free-form output. Slidev's markdown dialect and
  kawai's v2 bounded fields are the other two instances.
- **Theme-file shape.** presenterm themes are YAML files covering colors,
  margins, alignment, footer, and **per-layout styling** — the same
  vocabulary a kawai template pack needs. The designs themselves are
  terminal-grid color schemes (catppuccin, tokyonight, gruvbox), so they are
  not visual porting sources; the transferable asset is the file structure.
- **In-process HTML export precedent.** Its `--export-html` path emits a
  single self-contained file (images + styles embedded) from pure Rust, no
  browser or external tool — the same artifact contract as
  `office_create_deck`, independently proven feasible without a render
  engine.

What does not transfer: the output medium. presenterm renders into a
character grid, so its decks (and its HTML export, which is a faithful
terminal-aesthetic mirror — monospace, fixed grid) are developer tools, not
designed business deliverables. There is no PPTX, no fixed-canvas layout
system (only proportional column splits), and no imagery/typography tier.
Its distinctive runtime features — snippet execution in PTYs, mermaid/d2 and
LaTeX/typst rendering, selective code highlighting — are live-demo features
for terminal talks, out of scope for kawai's stored-deliverable model.

### 4. kawai's differentiator is real

No comparison target has an AI-first pipeline: a deterministic scheduler that
gathers facts, then a deck-writer agent that synthesizes slides from
structured step outputs. That pipeline is now layout-aware (v2) and
self-correcting (probe + validation errors fed back to the model).

## Lessons learned (frame/content sessions)

1. **Free-form LLM HTML in a fixed frame is an unbounded bug class.** A dozen
   failed fix attempts (sanitizer, fitScale, ResizeObserver, fonts.ready)
   each patched one leak. The v2 structured format closed the entire class by
   construction: the renderer owns markup; the model owns bounded fields.
2. **Recurring "trivial" bugs are an architecture symptom.** Fix the
   representation, not the renderer.
3. **For visual bugs, reproduce with eyes first.** The standalone
   browser-act reproduction settled in 2 screenshots what theory could not in
   a dozen iterations.
4. **Timing bugs are real**: embedded data:-URL fonts swap after first paint,
   changing text metrics — any measurement must re-run on `document.fonts.ready`
   / ResizeObserver.

## Current architecture (post-v2)

```
LLM (deck writer) — picks layout, fills bounded fields
  → validation (bounds enforced; over-fill = actionable rejection, self-correct)
  → fixed per-layout templates (Rust) → bodyHtml
  → file-ref substitution → sanitize → probe → store (reveal.js HTML + manifest)
  → office_read_deck → fragments + theme CSS
  → DeckPreview (native DOM, 980×551 canvas scaled via CSS transform,
     shrink-to-fit on overflow) + "Open full deck" in system browser
  → office_export_deck → PPTX (deterministic)
```

## Recommended next steps (impact/cost order)

1. **Theme ports** — port 2–3 MIT Slidev themes (`seriph`, `apple-basic`,
   `shards`) and/or Quarto reveal themes into template packs; carry
   per-layout styling for the v2 layout vocabulary.
2. **Golden exemplar per theme** — one worked slide-set injected into the
   deck writer prompt (same mechanism the catalogue packs already use for
   their reference fixtures). Models copy patterns far better than they
   follow prose directives.
3. **Layout-variety validation** — promote "never 3 same-layout slides in a
   row" from prompt to Rust validation (mechanical, self-correcting).
4. **Optional external render path** (later) — `quarto render` as an opt-in
   alternative exporter for users who have Quarto installed, inspired by
   Showmaker's model.
5. **Optional critique pass** (later) — deck writer self-reviews layout
   variety, content density, and figure accuracy once (+1 bounded LLM call)
   before storing.
