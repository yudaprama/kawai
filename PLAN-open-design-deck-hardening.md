# PLAN — Deck hardening: lessons ported from open-design

**Status:** implemented (Phases 1–3 + 6 complete; Phase 4 superseded by mandatory templates; Phase 5 deferred)
**Origin:** open-design (`ai-orchestration/open-design`) is in production and
validated by real usage. This plan ports the *architectural* lessons that fit
kawai's pure-Rust, no-browser architecture. **Nothing Chromium-based is ported**
— open-design's capture pipeline (hidden BrowserWindow, CDP screenshots,
stitch budgets) is explicitly rejected; kawai's deterministic
parse → PptxWriter export is strictly better for this product and stays.

Reference material (read-only):
- `open-design/packages/contracts/src/api/artifacts.ts` — `ArtifactManifest`
- `open-design/apps/daemon/src/prompts/deck-framework.ts` — skeleton + SLOT directive
- `open-design/apps/daemon/src/import-export-routes.ts` — deck/page mode gating
- `open-design/apps/web/src/runtime/srcdoc.ts` — slide bridge message contract

## What kawai already has (do not rebuild)

- `crates/engines/office/src/deck.rs`: `render_deck`, `sanitize_html_fragment`,
  `parse_deck` → `ParsedDeck`/`ParsedSlide`, `deck_to_markdown`, `export_pptx`.
- `crates/engines/office/src/store.rs`: per-user docs store (opaque ids +
  meta.json).
- `office_create_deck` → reveal.js self-contained HTML (vendored runtime,
  sanitized model HTML); `office_export_deck` → deterministic PptxWriter.

The gap is not capability — it is **enforcement**: validation stops before
render, the artifact contract is implicit, and the exporter has no regression
net.

---

## Phase 1 — ArtifactManifest (explicit contract)

**Goal:** replace the implicit "deck = reveal.js self-contained HTML" convention
with a typed manifest, mirroring open-design's `ArtifactManifest` (simplified —
no `renderer` registry yet).

**Changes:**
- `crates/engines/office/src/store.rs`: new serde struct `ArtifactManifest`:

  ```rust
  pub struct ArtifactManifest {
      pub kind: ArtifactKind,        // Deck | Document | Spreadsheet | Pdf | DeckHtml
      pub entry: String,             // main file name within the doc dir
      pub status: ArtifactStatus,    // Streaming | Complete | Error
      pub source_tool: String,       // e.g. "office_create_deck"
      pub schema_version: u32,
  }
  ```

- Written into the existing `<id>.meta.json` on every create/write that
  produces an artifact.
- **Big-bang (dev status, breaking OK):** no backfill-on-read. The manifest
  is REQUIRED on every read; meta files without one fail with a typed error.
  Old local files are disposable — re-create them.
- `deck.rs::parse_deck` and `export_pptx` consumers read the manifest instead
  of guessing from extension; mismatch (manifest says deck, parse finds 0
  slides) is a hard error.

**Acceptance:**
- Round-trip: create deck → meta.json contains manifest; `office_export_deck`
  on a manifest-less/corrupt file fails with a typed error.
- `cargo check` + `cargo check --features office` green; existing store tests
  pass.

## Phase 2 — Render/parse probe before accept (validate like open-design Stage 4)

**Goal:** no artifact is committed to the office store unless it parses. This
is the pure-Rust equivalent of open-design's pre-persist validation — their
checks are syntactic + stub-guard; ours ends one step further (actually parses).

**Changes:**
- `crates/engines/office/src/deck.rs`: `pub fn probe_deck(html: &str) ->
  Result<DeckProbe, String>` — runs `parse_deck`, then asserts:
  - ≥ 1 slide;
  - every slide has non-empty title or body;
  - no `<script>` outside the vendored reveal runtime allowlist (extends
    `sanitize_html_fragment`, which currently runs before this);
  - referenced file ids (via existing `collect_file_refs`) resolve in the
    store.
- `tools.rs` (`office_create_deck`, and the edit path): run the probe after
  sanitize, before `store.put`. Failure returns a tool result the model can
  self-correct from (include the probe message verbatim — this is the
  self-correcting-errors pattern the analytics engine already uses).
- Deck **edit** path re-probes the full document, not just the fragment.

**Acceptance:**
- Unit tests: deck with 0 slides / broken fragment / foreign `<script>` /
  dangling file ref → probe errors with actionable messages.
- Tool-level test: agent asked to create a deck with a poisoned payload gets
  the probe error back and a corrected retry succeeds.

## Phase 3 — Golden-fixture regression net for the exporter

**Goal:** commit a set of representative deck fixtures and assert exporter
output. This is the golden-fixture test open-design *lacks* (their slide
selector is synced manually across two apps — kawai should not repeat that).

**Changes:**
- `crates/engines/office/tests/deck_fixtures/`:
  - one deck per built-in template output of `render_deck`;
  - 2–3 fixtures from real model output (post-sanitize), including edge cases:
    tables, embedded images, `<img data-file>` chart refs, long titles,
    empty bullet lists;
  - a deliberately non-deck HTML page using a `.slide` class (must NOT parse
    as a deck — ports open-design's `shouldCaptureAsDeck` explicit-vs-implicit
    gating idea to the parse side).
- `deck.rs` test module: for each fixture assert `ParsedSlide` count, slide
  titles, element order, and `ExportStats`; `export_pptx` output parses back
  (pptx zip → slide count match).
- Exporter chrome-exclusion: `parse_deck` ignores reveal.js chrome
  (progress bar, nav controls) — verify via a fixture containing them.

**Acceptance:**
- `cargo test -p kawai-office` runs the fixture suite; any future parser change
  that shifts output fails loudly with a per-fixture diff.

## Phase 4 — Skeleton + SLOT prompt containment (superseded by Phase 6)

**Trigger:** folded into Phase 6. With template-seeding mandatory, the
open-design lesson applies in its original form: the **template seed wins**
and no generic fallback skeleton is injected alongside it (a seed plus a
generic skeleton produce conflicting directives — open-design learned this in
production). The frozen-framework idea below only returns if a generic
"blank" template is ever added to the catalogue as an explicit pack.

**Design (ported from `DECK_SKELETON_HTML` + `DECK_FRAMEWORK_DIRECTIVE`, with
one upgrade open-design doesn't have):**
- `crates/engines/office/src/deck_framework.rs` (new): frozen reveal.js
  scaffold as a string constant — framework `<style>` + nav JS marked
  DO-NOT-EDIT; `:root` tokens, per-deck `<style>`, and `<section class="slide">`
  bodies marked SLOT. Injected into the `office_create_deck` tool prompt.
- **Hash-verify enforcement:** the probe from Phase 2 additionally compares the
  framework region against a SHA-256 of the frozen section — a model that
  "blends" its own scale-to-fit JS is rejected with the SLOT rules quoted.
  open-design enforces this by instruction only; kawai verifies
  mechanically.
- Fallback behavior on rejection: one retry with the directive re-pinned
  (matches the analytics self-correction loop); second failure returns the
  error to the supervisor step.

**Acceptance:**
- Prompt-injection unit test: directive present, skeleton verbatim, SLOTs
  marked.
- Tamper test: modified framework region → hash mismatch → rejected.

## Phase 5 — Preview upgrade: slide bridge + thumbnail rail (optional, later)

**Goal:** host-driven slide navigation + per-slide thumbnails in the deck
asset page, porting open-design's `od:slide` / `od:slide-state` message
contract (see `apps/web/src/runtime/srcdoc.ts`) — simplified for Tauri (no
sandboxed-iframe bridge needed; the vendored runtime is trusted).

**Changes:**
- Vendored reveal runtime: post `deck:navigated {index,total}` to the host on
  every slide change; accept `deck:navigate {action, index}` from the host.
- Frontend (`frontend/src/features/assets/…deck…`): counter + dot rail;
  thumbnails rendered from `parse_deck` output (slide bodies → offscreen
  render or CSS-scaled clones) — start with the counter/rail only, thumbnails
  as a follow-up.
- Rust side unchanged (navigation is webview-internal JS; host uses
  `eval`-style bridge already available in the webview layer).

**Acceptance:** navigation from host buttons works without keyboard focus;
state stays in sync after programmatic jumps.

---

## Phase 6 — Template seed library (download on init, not bundled)

**Product rule: decks are ALWAYS template-seeded.** There is no
create-from-scratch deck path. Every `office_create_deck` call carries a
`templateId` (required arg); the seed is injected into the prompt and the
probe verifies the output against it. This mirrors open-design's own finding
that a seed must **win outright** — a template seed plus a generic fallback
skeleton produce conflicting directives, so the fallback skeleton is removed
from the deck path entirely (see Phase 4 note).

**Goal:** bring the open-design template catalogue users already like
(validated in production; manually confirmed by the product owner) into kawai
as **downloaded seed packs**, not bundled assets — the full catalogue is
~38MB and must never enter the installer or the repo.

**Mandatory-template consequences:**
- Because every deck needs a seed, a small **starter set of vocabulary packs
  (2–3, KB-scale text) IS bundled** so first-run deck creation works with
  zero network. The full catalogue stays download-only.
- `templateId` resolution: explicit arg → session default → workspace
  default → bundled starter pack. Never "none".
- Offline with no cached catalogue: user can still make decks from the
  bundled starter packs; browsing/downloading new templates needs network,
  and the tool result says so plainly.

**Two-layer adoption (per template):**
- **Vocabulary seed (default, low risk):** `SKILL.md` + `references/` are
  injected into the `office_create_deck` prompt as *style* — typography,
  palette, composition. Slide structure stays kawai's reveal.js dialect, so
  `export_pptx` and `office_read_document` keep working unchanged. This
  carries most of the visual appeal at zero architectural cost.
- **Adapted template (opt-in, per template):** `template.html` ported to the
  parse_deck dialect, gated by the Phase-2 `probe_deck` + Phase-3 fixtures.
  Templates whose structure can't be ported (WebGL heroes, heavy
  `<deck-stage>` runtimes) are excluded from the registry entirely.

### Registry & hosting

- **Hosted in this repo** (`crates/engines/office/registry.json`, committed
  alongside the code that reads it): a static `index.json`-style document
  served via the repo's raw URL (`REGISTRY_URL`). Licence curation happens at
  commit time — only permissive packs (MIT/Apache, attribution preserved)
  enter the file, so no fetch-time filtering is needed. Update by editing +
  committing; clients pick it up on their next init.

  ```json
  {
    "schemaVersion": 1,
    "templates": [{
      "id": "html-ppt-retro-quarterly-review",
      "version": "1.2.0",
      "license": "MIT",
      "licenseUrl": "...",
      "upstream": "open-design/design-templates/html-ppt",
      "seedFiles": ["SKILL.md", "references/*.md"],
      "adaptedHtml": null,
      "sha256": {"SKILL.md": "..."},
      "sizeBytes": 51200
    }]
  }
  ```

- **Only curated permissive-license entries are published.** Bundled
  third-party templates in open-design retain their own licenses (MIT/Apache);
  each pack ships its `LICENSE` file and attribution header. Anything with a
  non-permissive or unverifiable license never enters the index.

### Download mechanism (reuse the proven kawai pattern)

Mirror the PaddleOCR/model auto-download machinery:
- Trigger: background fetch of `index.json` on app init (non-blocking,
  silent-fail offline); template packs download **lazily** — on first use in
  `office_create_deck` (tool description lists cached packs; uncached ones
  trigger a download before the prompt is assembled, with a timeout and a
  graceful "template unavailable offline" tool result).
- Atomicity: `<file>.part` → verify sha256 → rename (same recipe as the OCR
  models); per-process `tokio::sync::Mutex` on a template id; per-chunk stall
  timeout.
- Storage: `<data_root>/templates/<id>/<version>/…`, beside the per-user data
  layout; the directory resolves through `kawai_paths::template_packs_dir()`
  (`~/.kawai/templates`, hardcoded — no env override; internal plumbing, not
  user configuration).
- Versioning: packs are immutable per version; a new `index.json` version
  downloads to a new dir and swaps a pointer — old versions garbage-collected
  only when no longer referenced (no auto-delete of user-referenced packs).
- No cache-bloat: vocabulary seeds are text (KB-scale); the 38MB figure is
  the whole catalogue — a user only ever pulls the handful they pick.

**Changes:**
- `crates/engines/office/src/templates.rs` (new): registry fetch, pack store,
  prompt-seed rendering (`render_template_seed(id) -> String`, capped — same
  budget discipline as `skills::prompt_block`), license/attribution access,
  starter-pack fallback resolution.
- `tools.rs`: `office_create_deck` gains a **required `templateId` arg from
  day one** (no optional-arg migration period); tool description enumerates
  locally available packs and instructs the model to offer a choice from
  cached packs when the user hasn't picked one (the model asks, the user
  chooses — the model never invents a deck without a seed).
- Phase 2 probe: when a template seed was injected, the probe additionally
  checks template-compliance signals (token usage, required slide roles per
  the pack's manifest) — soft warnings, not rejections, until calibrated.
- Frontend (optional, later): template picker on the deck asset page reading
  the cached registry; new-deck flow defaults to picking a template first.

**Acceptance:**
- Cold start offline: app boots fine, deck creation works from the bundled
  starter packs; tool result communicates that the full catalogue is
  unavailable offline.
- **No-scratch guarantee:** `office_create_deck` without a resolvable
  `templateId` is impossible — arg is required and resolution always lands on
  a seed (explicit → default → starter).
- First `office_create_deck` with an uncached template: downloads atomically,
  verifies sha256, renders the seed into the prompt; second call hits cache.
- Corrupt/interrupted download (kill mid-`fetch`): `.part` file discarded on
  next attempt, no partial pack ever served.
- Every served pack exposes its license; index containing a non-permissive
  entry is rejected at fetch time.


---

# Division of labor — LLM vs Rust vs React

Who does what in the deck pipeline, precisely. The invariant underneath:
**everything deterministic lives in Rust; the LLM only authors content;
React only displays.**

## LLM (cloud subagent via the remote-llm pool) — content author

The model's entire job is *writing content*. It:

1. **Picks `templateId`** — required arg. Reads the bundled pack directives in
   the tool description; asks the user when the request doesn't clearly match
   a pack. It never invents ids.
2. **Writes slide content** as `slides: [{title, bodyHtml}]`:
   - semantic HTML (h3/p/ul/table/blockquote),
   - the class vocabulary (`.card`, `.grid g2`, `.kicker`, `.big-number`, …),
   - free CSS in `<style>` blocks or `style=` attributes — colors, gradients,
     layout experiments — within the sanitized subset (no remote `url()`/`@import`),
   - `<img data-file="<fileId>">` to embed stored charts/images.
3. **Self-corrects** when the probe or the resolver rejects: error strings are
   written to be actionable and are returned verbatim.
4. **Honors the retry handshake** for catalogue packs: first call returns the
   pack's style directive + reference fixture; the model re-invokes with the
   same args, now applying the style.

The model does **not**: choose templates (that's user + Rust via `office_bind_template`), render, scale, paginate, persist, validate, export,
resolve file ids to data URLs, pick fonts, or touch the network. Every
infrastructure concern is deliberately outside its reach — the historical
failure mode (models re-implementing slide scaffolding per turn) is
structurally impossible.

## Rust (`crates/engines/office`) — everything deterministic

Rust owns the entire pipeline around the content:

| Stage | Rust component | Role |
|---|---|---|
| Template resolution | `templates.rs` | bundled packs (in-binary) → cached registry → one network fetch (`registry.json`, sha-of-schema check, atomic `.part`→rename cache in `kawai_paths::template_packs_dir()`); id unknown → error enumerating all valid ids. **User picks are structured**: `office_bind_template` stores the choice; `office_create_deck` consumes it and overrides the model's arg — user intent is deterministic, not LLM-mediated |
| Themes | `deck.rs::DECK_THEMES` + `theme_css()` | vendored open-design token blocks (MIT); design systems supply raw `themeCss` tokens that bypass the id table entirely |
| Fonts | `deck.rs::font_face_css()` | OFL latin subsets (Inter 400/700, Playfair 700, JetBrains Mono 400) embedded as data:-URL `@font-face` — decks are offline-complete |
| Rendering | `render_deck_with_theme_tokens()` | fixed reveal.js skeleton + vendored runtime (REVEAL_JS/REVEAL_CSS), theme `:root` tokens, `.deck-scope` layout CSS; the model's HTML is inserted into slide sections verbatim (post-sanitize) |
| Sanitization | `sanitize_html_fragment()` + `sanitize_css()` | drops scripts/handlers/unsafe URLs; CSS-neutralizes `@import` and remote `url()`; keeps class/style/data-file |
| Validation | `probe_deck()` | rejects unreadable structure, smuggled scripts, unresolved `data-file` refs — before the store accepts anything |
| Persistence | `store.rs` | opaque file ids, required `ArtifactManifest` (kind/status/source_tool/template) in `<id>.meta.json`; pre-manifest files fail with a typed error |
| Export | `parse_deck()` → `deck_to_markdown()` / `export_pptx()` | deterministic parse → PptxWriter (no LLM, no browser); markdown readback feeds `office_read_document` + RAG |
| Registry tooling | `tools/gen-template-registry.py`, `gen-design-systems.py` | idempotent generators; manual packs always win (`ALIASES`), catalogue served from the repo root via raw URL |

## React (frontend) — display only

The frontend holds **zero deck logic**:

- surfaces office-store files (list, open) and renders the deck HTML
  (self-contained reveal.js document — the webview/iframe is the whole story),
- shows the tool result / probe error text that the supervisor stream delivers
  (the model's self-correction loop is driven entirely by those strings),
- template selection currently happens in chat (model offers cached packs);
  the template **picker UI** and the Phase-5 slide bridge + thumbnail rail are
  the only planned frontend additions — both cosmetic layers over a pipeline
  that works without them.

## Sequence diagram — `office_create_deck` end to end

Actor boundaries marked; loops are Rust-controlled (the LLM only responds).

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  USER (chat)                                                                     │
│  "buat pitch deck pakai design system Apple"                                     │
│       atau: memilih pak di TemplatePicker (pilihan structured)                   │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────────────┐
│  REACT (frontend)  — display only, nol logika deck                               │
│  • ChatComposer mengirim prompt (supervisor stream)                              │
│  • TemplatePicker → office_list_templates → [Rust: baca bundled + cache saja]    │
│  • Saat user memilih: office_bind_template → [Rust: simpan binding terstruktur]  │
│  • menampilkan stream events / error / hasil                                     │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │ prompt (binding sudah disimpan Rust, tidak di tangan model)
┌──────────────▼──────────────────────────────────────────────────────────────────┐
│  RUST #1 — resolusi template (templates.rs)                                      │
│  • Jika ada binding user → OVERRIDE args.template_id (model dilampaui)           │
│  • Jika tidak ada binding → biarkan model menyimpulkan/menanyakan                │
│  1. bundled packs (in-binary) ──┐                                                │
│  2. cache ~/.kawai/templates ───┤→ ResolvedPack {directive, themeCss/tokens,     │
│  3. fetch registry.json (1×) ───┘                reference fixture}              │
│  • bundled: langsung OK                                                          │
│  • katalog: HANDSHAKE → kembali ke LLM: "directive + fixture, call AGAIN"        │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │ directive + fixture (+ deskripsi tool)
┌──────────────▼──────────────────────────────────────────────────────────────────┐
│  LLM (cloud subagent) — CONTENT ONLY                                             │
│  ✓ memilih templateId        ✗ render      ✗ persist      ✗ network             │
│  ✓ menulis slides:           ✗ sanitasi    ✗ validasi     ✗ export               │
│     [{title, bodyHtml}]      ✗ fonts       ✗ theme tokens ✗ file ids            │
│    (semantic HTML + class vocab + <style> bebas + <img data-file>)               │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │ slides[] (content murni)
┌──────────────▼──────────────────────────────────────────────────────────────────┐
│  RUST #2 — pipeline deterministik (deck.rs / store.rs / tools.rs)                │
│                                                                                  │
│  1. resolve file refs      : data-file handle → baca store → data: URL           │
│  2. sanitize_html_fragment : buang script/handler/URL berbahaya; CSS di-scan:    │
│                              @import dibuang, url() remote → inert               │
│  3. render_deck_with_theme : skeleton reveal.js FIXED (REVEAL_JS/REVEAL_CSS)     │
│                              + tema tokens (vendored / design system)            │
│                              + font OFL embedded (data: @font-face)              │
│                              + .deck-scope layout CSS (port base.css)            │
│  4. probe_deck             : ≥1 slide berkonten? script asing? data-file nyangkut?│
│         │ gagal → error actionable ──────────────► kembali ke LLM (self-correct)│
│         ▼ lolos                                                                  │
│  5. import_as + ArtifactManifest → office store (meta.json wajib manifest)       │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │ {file, slides, template}
┌──────────────▼──────────────────────────────────────────────────────────────────┐
│  REACT — render: FileViewer/asset page memuat self-contained HTML (webview)      │
│  (deck jalan offline; font & tema embedded)                                      │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │ (saat user minta .pptx)
┌──────────────▼──────────────────────────────────────────────────────────────────┐
│  RUST #3 — export deterministik (office_export_deck) — LLM TIDAK IKUT SAMA SEKALI│
│  parse_deck → deck_to_markdown (RAG) → export_pptx (PptxWriter, native shapes)   │
│  + ArtifactManifest (source_tool: "office_export_deck")                          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## The contract in one sentence

The LLM writes **what** each slide says (in a sanitized, class-vocabularied
HTML dialect); Rust owns **how it looks, whether it's valid, where it lives,
and how it exports**; React owns **showing it** — and no layer can reach into
another's responsibilities.


---

## Out of scope (rejected from open-design, on purpose)

- Chromium capture export path (CDP, stitch, capturePage fallback) —
  contradicts kawai's pure-Rust, mobile-viable architecture.
- Dual-iframe URL/srcDoc mounting — not applicable to Tauri webviews.
- Artifact→file matching by name + `mtime` — kawai's opaque file ids +
  manifest (Phase 1) are strictly stronger.
- Generic HTML/react-component viewer registry — kawai decks are
  reveal.js-dialect by construction.

## Sequencing & risk

**Delivery mode: big-bang.** kawai is in development — breaking changes to
the office store format, tool signatures, and prompts are acceptable in one
coherent PR. No backfill, no dual-path migration period, no optional-arg
compat shims. Anything that would exist only to keep pre-change local files
or call-sites working is cut.

| Phase | Depends on | Risk | Notes |
|---|---|---|---|
| 1 Manifest | — | low | required on read, no backfill (dev) |
| 2 Probe | Phase 1 (manifest) | low | tool-result errors enable model self-correction |
| 3 Fixtures | Phase 2 (probe API) | low | pure test infrastructure |
| 4 Skeleton | Phase 2 (probe + hash) | medium | **conditional** — only with free-layout decks |
| 5 Bridge | — | low | independent frontend work, defer |
| 6 Templates | Phase 2 (probe gates adapted HTML) | low–medium | **mandatory template path**; bundled starter packs + lazy catalogue download (OCR model pattern) |

**Phases 1+2+3+6-starter (manifest, probe, fixtures, bundled starter packs +
required `templateId`) land as ONE breaking PR** — they are mutually
reinforcing (probe needs the manifest, fixtures validate the probe, the
mandatory template path needs the probe) and splitting them only produces
intermediate states nobody ships. Registry/lazy-download (rest of Phase 6)
and Phase 5 stay follow-ups: they add capability without re-shaping what the
first PR establishes.
