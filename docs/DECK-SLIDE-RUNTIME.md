# Deck slide runtime — markdown deck system

How kawai decks work end-to-end: creation by AI, storage, the three render
paths, the markdown dialect, themes, and the debugging rules for this area.
Includes the condensed comparison against Slidev / Showmaker / presenterm
(the reference implementations studied while designing this).

## Overview

A deck is a **markdown document**. One markdown file is the single source of
truth; every surface renders from it:

```
User goal → planner → research tools (web_search, data_query, …)
  → deck writer agent: markdown (Slidev/presenterm dialect)
  → validation (bounds, structure — over-fill rejected, model self-corrects)
  → stored as the deck artifact: <id>.source.md (+ manifest)

Render paths (all read the same source):
  ├── Preview in-app: office_read_deck → markdown → Vue island
  │     (markdown-it → DOM, one slide at a time, 16:9 frame)
  ├── Present: the same runtime fullscreen in the app (Esc exits)
  ├── Export HTML: on-demand render → self-contained reveal.js file
  │     (shareable, opens in any browser, full animations)
  └── Export PPTX: markdown → layouts → office_oxide PptxWriter
        (deterministic; titles/bullets/tables/images)
```

The model never writes HTML. It picks layouts and fills bounded fields —
either as JSON (`slides[]`) or directly as markdown. Anything that would not
fit the canvas is rejected at validation time, so frame/content overflow is
impossible by construction.

## Markdown dialect

kawai accepts the union of the Slidev and presenterm dialects:

| Feature | Syntax | Support |
|---|---|---|
| Slide separator | `---` or `<!-- end_slide -->` | ✅ (`---` inside code fences is content) |
| Slide frontmatter | leading `key: value` lines (layout, title, kicker, subtitle, big, caption, author, fileId, leftTitle, rightTitle) | ✅ flat keys (no nested YAML) |
| Layout inference | slide shape decides the layout when `layout:` is omitted | ✅ |
| Layouts | `title`, `section`, `bullets`, `two-cols`, `fact`, `quote`, `table`, `image` | ✅ (v2 enum: `DeckSlideV2`) |
| Headings as titles | `#` deck title, `##` slide title | ✅ |
| Bullets | `- item` | ✅ 2–6 items, ≤140 chars each |
| Inline styling | `**bold**`, `*italic*`, `~~strike~~` | ✅ |
| Quote | `> quote` + frontmatter `author:` | ✅ |
| Table | GFM pipe table | ✅ ≤6 rows × 5 cols |
| Image | `![caption](fileId)` — fileId from the office store | ✅ |
| Two columns | `::right::` (Slidev) or `<!-- column_layout: [1,1] -->` + `<!-- column: 0/1 -->` (presenterm) | ✅ |
| HTML comments | dropped (never rendered); presenterm commands recognized | ✅ |
| Code fences | ``` fenced blocks — `---`/kv inside is content | ✅ |

Not supported (requires a component runtime or build toolchain — out of
scope by design): `v-click` step animations, transitions, Vue components in
slides, Shiki highlighting, KaTeX, Monaco, per-slide HTML/styles, `src:`
multi-file imports.

## Backend (Rust)

- `parse_deck_markdown` (`deck.rs`): stateful parser — slide separation,
  frontmatter, code-fence guard, column commands, layout inference, bounds
  validation with actionable per-slide errors.
- `render_deck_with_theme_tokens` / `theme_css`: fixed per-layout templates +
  theme token CSS + embedded fonts → the reveal.js HTML (used by
  "Export HTML" and legacy decks).
- `export_v2_pptx`: layout-aware PPTX — `fact` = hero number + caption,
  `two-cols` = two titled bullet groups, `quote` = styled quote,
  `table` = rows, `image` = store-resolved embed. Written via
  `office_oxide::PptxWriter` (deterministic, no LLM).
- `office_read_deck` → `{title, template, themeCss, markdown}` for the
  frontend runtime (markdown-primary decks: the stored `.md` file IS the
  source; legacy HTML decks: extracted + regenerated).
- Template selection is **system-owned** (`next_system_template_id` rotates
  across the bundled packs); a user template-picker binding overrides. The
  model never chooses the template — example anchoring produced four
  identical decks before this became mechanical.
- Bundled template packs: consulting-clean, dark-pitch, minimal-editorial,
  slidev-light, gruvbox-dark — each with a style directive the deck writer
  follows. The 187-pack catalogue (registry.json, incl. catppuccin
  palettes) works the same way via cached tokens.

## Frontend (Vue island in the React canvas)

- `DeckPreview` (workbench): fetches `office_read_deck`, splits the markdown
  into slides (`## `), renders the current slide with markdown-it inside a
  16:9 `aspect-video` frame; nav ← → + dots + counter; **Present** = the same
  runtime fullscreen (Esc exits); **Export PPTX** / **Export HTML** buttons.
- The frame fits by construction (`aspect-video`, content scrolls inside) —
  no JS measurement anywhere.
- `DeckDemoPage` (Assets → Deck Preview) is the same runtime standalone,
  fed by an inline demo markdown string.

## Reference implementations (condensed)

| | Slidev | Showmaker | presenterm |
|---|---|---|---|
| Shape | Node/Vite/Vue toolchain | Tauri app (~545 lines) delegating to Quarto | Rust terminal presenter |
| Markdown → slides | Build-time compile (Vite) | External `quarto render` | In-process Rust parse → terminal render |
| Adopted by kawai | Markdown dialect, theme designs (MIT), fixed-canvas preview pattern | Validation that opt-in external renderers are acceptable UX | Layout/overflow-validation semantics; column command dialect |

Not adopted: Node/Vite toolchain per deck (distribution blocker for a
self-contained desktop app), headless-Chromium export (office_oxide's
deterministic PptxWriter is strictly better here), terminal rendering.

## Debugging rules for this area

- `turn_log.latency_ms = 0` + `outcome = error` on a tool call = instant
  validation/deserialization failure — read the tool's args parsing, not the
  renderer.
- Deck notes render in TWO canvas views ("final" and the deck_writer step
  report) — cover both or users report "it doesn't render".
- Embedded data:-URL fonts change text metrics after first paint — any
  measurement must re-run via ResizeObserver + `document.fonts.ready`.
- Reproduce visual bugs with eyes first: standalone HTML repro of the exact
  DOM + browser automation screenshots settles in minutes what theory cannot
  in hours.
- Rules the model must follow live in validation code, not prompts — prompt
  rules proved insufficient (template anchoring, layout variety).

## Remaining backlog

- Port production theme CSS (Slidev `seriph`/`apple-basic`/`shards`,
  Quarto reveal themes — MIT) into the frontend runtime + reveal export.
- Golden exemplar per theme (worked slide-set injected into the deck writer
  prompt — catalogue packs already carry reference fixtures).
- Critique pass (deck writer self-reviews layout variety/content density,
  +1 bounded LLM call).
- Optional `quarto render` as an opt-in external exporter (Showmaker model).
- Multi-device sync: deck markdown (small text) is the first artifact to
  move into libsql when sqld sync ships; binaries stay file-based.
