# Implementation Plan — Chart → Document embedding (kawai)

Status: **DRAFT (2026-08-26)** — not started. Scope proposal for review; no
code has been written against this plan. Prerequisite context: `data_chart`
shipped (`crates/engines/analytics` `chart` module + `DataChartTool`, office store
accepts `.svg`); this plan opens the "full report with charts" use case the
chart tier was chosen for.

---

## 1. Problem

`data_chart` saves a rendered chart as an svg in the office store, but that
chart is a dead end: it can be previewed in the chat panel and nothing else.
The natural user ask — "buat laporan penjualan bulanan dengan grafiknya" —
cannot be answered in one document: `office_create_document` composes
Title/Heading/Paragraph/Bullets/Table blocks only; there is no image concept
anywhere in the create path (markdown IR → office_oxide), and OOXML cannot
embed SVG anyway.

## 2. Target experience

```
user:   Buat laporan docx penjualan Q1 — ringkasan, tabel per produk,
        dan grafik pendapatan per bulan.
model:  data_chart  (bar, x=bulan, y=total)        → fileId C
        office_create_document(blocks=[
          Title "Laporan Penjualan Q1",
          Paragraph "...",
          Table rows…,
          Image { fileId: C, caption: "Pendapatan per bulan" },
        ])                                          → fileId D
```

One turn, two tools, one document containing the chart. The Image block is
the only new surface the model sees.

## 3. Design decisions (proposals)

### D1 — Image rides `DocBlock`, resolved store-side

```rust
pub enum DocBlock {
    Title { text },
    Heading { text, level },
    Paragraph { text, bold, italic },
    Bullets { items },
    Table { rows },
    Image { file_id: String, alt: Option<String> },   // NEW
}
```

- `blocks_to_markdown` renders `![alt](file_id)` so the IR stays
  inspectable; office_oxide's create path branches on the image token.
- `user_id` binding follows the existing tool pattern: `CreateDocumentTool`
  already holds the user; it resolves `file_id` → store path → bytes before
  calling office_oxide. The model never sees or sends a path.
- Same-shape read path: `read_document` gains a block-level marker so
  round-trips don't silently drop images (lossless edit is explicitly
  out of scope — edits preserve the part untouched, like raw-part surgery).

### D2 — Rasterize at embed time (PNG), keep SVG as source of truth

- OOXML (docx/pptx) has no portable SVG story: docx needs DrawingML
  (`a:blip` on a `pic:pic` in `w:drawing`); pptx the same on a slide. PNG
  via `a:blip r:embed` is the universally-rendering path.
- office_oxide gains an optional `image` feature: `image::PngEmbedder`
  re-encodes bytes to PNG. Two candidate paths:
  1. **charton `png` feature** (tiny-skia + ab_glyph + fontdb — pure Rust,
     no C; safe for the mobile check battery), or
  2. the `image` crate (pure-Rust PNG encode; svg *decode* drags in
     `resvg` — heavy; avoid).
  Preferred: charton already rasterizes its own SVG faithfully (same
  renderer family), so `charton = { features = ["png"] }` behind the
  office_oxide `image` feature — but charton is SVG-*generation*; rasterizing
  an arbitrary stored svg needs `resvg`/`usvg`. **Open question O1.**
- Sizing: embed at the chart's intrinsic 900×500 (`@2x` render for print
  sharpness = 1800×1000), EMU conversion `px * 9525`. No cropping, no
  model-facing size params in v1 — the chart already chose its aspect.

### D3 — Non-chart images?

The office store already holds png/jpg (knowledge ingestion). v1 scope:
Image block accepts **any image ext the store allows**; SVG is rasterized,
rasters pass through. Cost is one extra branch; value is "logo in the
report" for free. Alternative (charts only) saves the rasterizer question
for later — decide in review.

### D4 — pptx

Same Image block; pptx create path places the picture in the slide's shape
tree with a content-file relationship (`ppt/media/imageN.png`). docx first,
pptx second (create-from-markdown already shares the block walker, so the
delta is the part template).

## 4. Work breakdown

| # | Item | Repo | Size |
|---|---|---|---|
| 1 | `DocBlock::Image` + markdown token + create-path branch | office_oxide (submodule) | M |
| 2 | docx media part + relationship + DrawingML anchor | office_oxide | L |
| 3 | pptx slide media + shape tree entry | office_oxide | M |
| 4 | Rasterizer decision + `image` feature (O1) | office_oxide | S–M |
| 5 | `CreateDocumentTool` schema (Image block) + store-side resolve | kawai `logic/office` | S |
| 6 | Persona guidance: chart→report composition (office agent + analytics agent share the pattern) | kawai `logic/agent.rs` | S |
| 7 | Frontend: nothing new (docx preview renders embedded images already — verify) | — | S |
| 8 | Smoke: chart → create_document → re-read shows image marker; eval scenario T21 ("report with chart") | kawai | S |

Dependency order: 4 → 1 → 2 → 5 → 6 → 8 → 3 (pptx can land after).

## 5. Risks / open questions

- **O1 rasterizer**: charton `png` renders *from Dataset*, not from an svg
  file — re-rendering needs the query+spec again (they are NOT persisted
  with the chart). Options: (a) persist spec+query in the chart's
  `.meta.json` and re-render to PNG at embed time; (b) `resvg`-family dep.
  (a) keeps deps zero and is the current lean — costs a re-query (fast,
  local, deterministic).
- **OOXML DrawingML boilerplate** is the bulkiest pure-code part; office
  docs' `extents` must match the embedded PNG or Word clips — fixed EMU
  math, no user input.
- **Model confusion**: two fileIds in one turn (chart + document). Persona
  line must be explicit: "office_create_document with an Image block
  referencing the chart's fileId".
- **Edit path**: `office_edit_document` raw-part surgery must not corrupt
  media parts — v1 states "images survive edits untouched" and the edit
  allowlist stays text-only (it already is).

## 6. Non-goals (v1)

- Image sizing/cropping/positioning params.
- Embedding charts into *existing* documents (create-path only).
- SVG embedded as-is in docx (Word's svg support needs a PNG fallback
  anyway — we ship only the PNG).
- LoRA, GPU, sqld — unrelated.
