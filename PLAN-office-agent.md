# Implementation Plan — `builtin.office` agent (kawai office agent)

> **Engine supersessions since this plan was written** (kept as a historical
> design record — the tool/op vocabulary below is still accurate):
>
> - **2026-08-20 — `docbuilder`/office-runtime: replaced by `office_oxide`**
>   (pure-Rust, in-process, markdown → IR → docx/xlsx/pptx). Document creation
>   needs no engine binary.
> - **2026-08-21 — `pdfcli`: replaced by `pdf_oxide`** (pure-Rust, in-process,
>   vendored submodule). ALL PDF ops (extract/search/replace/merge/split/info)
>   now call the pdf_oxide Rust API via `spawn_blocking` — no subprocess, no
>   bundled binary.
> - **ooxcli: dismantled** — OOXML read (`office_oxide::Document::to_markdown`),
>   info (Document IR + counts), and edit (`office_oxide::EditableDocument`
>   raw-part surgery) all run in-process; the `crates` `officeedit` /
>   `officemarkdown` tools and `ragloader` extraction were ported off the
>   subprocess too. No external engine binary remains anywhere in the stack.
>   See AGENTS.md Roadmap 5 for details.
>
> Sections 3–4 (engine inventory, CLI surfaces, bundling) describe the
> pre-migration subprocess architecture and are obsolete for PDF **and**
> OOXML; the store/tools/agent-loop sections remain the reference.

Status: DRAFT v2, not started. This plan deliberately pulls **Roadmap 5 (agent
tier foundation) forward** as a thin vertical slice, with the office agent as
its first consumer. Per AGENTS.md the agent tier is "do NOT start without the
user asking" — this document exists because the user asked. It does NOT pull
in the full catalog / three-pane UI (that stays Roadmap 5 proper).

v2 change: the document engines are **not** reimplemented in Rust. kawai
execs the existing CLI binaries — `ooxcli` (gooxml) and `pdfcli` (pdf) —
bundled with the app, plus optional `docbuilder` where the ONLYOFFICE runtime
is present. Design ports from `ai-orchestration/egent-office/` (Go/Eino): the
model-facing tool docs and the declarative edit-op vocabulary are identical
(they are battle-tested there); the engines behind them are the same Go
libraries the egents use, exposed as CLIs.

---

## 1. Goals / Non-goals

**Goals**

1. A `builtin.office` agent in kawai that runs on the on-device Gemma 4 via
   LiteRT-LM, using **prompt-based tool calling** (the Conversation API has no
   native function calling — Landmines).
2. Document/PDF processing via the existing `ooxcli` / `pdfcli` binaries
   (exec'd subprocesses) — **pptx read+edit and PDF text ops are in v1 scope**,
   because the CLIs already cover them.
3. The generic tool-calling loop lands as a reusable module so Roadmap 5's
   agent catalog plugs into it later.
4. All kawai invariants hold: pure logic, both wrappers per op, identity at
   the edge, `#[serde(tag = "type")]` events, camelCase web structs, feature-gated
   deps.

**Non-goals (deferred, tracked in §9)**

- **Rendering conversion** (docx/xlsx/pptx → pdf) — needs the x2t runtime
  tree (frameworks + sdkjs, ~GB); revisit after MVP 2 dylib bundling.
  (Text extract/read/edit do NOT need x2t — see §3.1.)
- Remote-model agents via `rig` providers.
- Three-pane UI, agent catalog UI, per-agent model prefs.
- **Mobile office tools** — iOS/Android prohibit subprocess exec from app
  sandboxes; office tools surface "unavailable" there (§5.5).

---

## 2. Architecture overview

```
src/main.js ──(agent_chat: stream op)──▶ commands.rs / web.rs   (thin wrappers)
                                            │  user_id (edge-resolved), args
                                            ▼
                                   logic::agent::agent_chat    (PURE loop)
                                     │            │
                                     │            └── logic::office::*   (PURE tools)
                                     │                   │ document store (fs)
                                     │                   └── tokio::process ──▶ ooxcli / pdfcli / docbuilder
                                     ▼
                            logic::local_llm         (existing LiteRT engine)
```

- **`logic::agent`** — generic prompt-based tool-calling loop: tool manifest
  rendering into the prompt, JSON tool-call parsing, dispatch via rig
  `ToolSet`, iteration cap, event stream. Knows nothing about office.
- **`logic::office`** — office domain: the per-user document store + CLI
  runner + N tool impls registered into a `rig::tool::ToolSet`. Tools take/
  return JSON; no transport types.
- The loop is model-agnostic in shape but v1 drives only `local_llm`
  (feature `litert`). If `litert` is off, `agent_chat` returns a clear error.

### Module layout (Phase 0 refactor — needs explicit OK)

`logic.rs` is 781 lines and about to grow a second domain. Split into a
directory module, preserving all public paths (`logic::x` imports in
commands.rs / web.rs keep working):

```
src-tauri/src/logic/mod.rs        # re-exports; greet/whoami/activity stay here
src-tauri/src/logic/db.rs         # DbError, token mint, chat sessions
src-tauri/src/logic/local_llm.rs  # moved verbatim from `pub mod local_llm`
src-tauri/src/logic/office.rs     # NEW (Phase 1-2) — see §4-§5
src-tauri/src/logic/agent.rs      # NEW (Phase 3) — see §6
```

### Feature gates & deps

```toml
[features]
office = []   # no new crates — the engines are external binaries
# agent loop has NO gate: always compiled (Roadmap-5 infrastructure);
# agent_chat requires litert at RUNTIME (clear error when absent).

[dependencies]
# NOTHING new for office. No zip/quick-xml/calamine/rust_xlsxwriter —
# the CLIs are the engines. rig is already a dep (pinned rev 4232abdb).
```

No new external deps. Do NOT create a
`crates/tools/office` crate — those are generated HTTP catalogs; office
tools are local-file tools that need kawai's document store.

---

## 3. Office runtime — embedding ooxcli / pdfcli / docbuilder

### 3.1 The binaries

| Binary | Source | Platforms (release assets) | Role |
|---|---|---|---|
| `ooxcli` v0.1.3 | github.com/yudaprama/gooxml `cmd/ooxcli` | darwin amd64/arm64, linux amd64/arm64, windows amd64/arm64 | OOXML read/edit/info/validate — docx, xlsx, **and pptx** |
| `pdfcli` v0.1.4 | github.com/yudaprama/pdf `cmd/pdfcli` | same 6 | PDF extract/search/replace/merge/split/info/metadata/images |
| `docbuilder` (+ sdkjs) | **office-runtime tarball** from github.com/yudaprama/Docker-DocumentServer releases (**runtime-v8**) | darwin amd64/arm64, linux amd64/arm64, windows amd64/arm64 (7 assets as of runtime-v8) — mobile: no subprocess | High-fidelity create engine (docbuilder JS) |

**docbuilder provenance & how-to** (verified 2026-08-17 on this darwin arm64
machine — `TestCreateDocument_Docx` passes with
`DOCBUILDER_PATH=.plano/bin/office-runtime/bin/docbuilder`):

- The runtime is extracted by
  `yudaprama/Docker-DocumentServer/.github/workflows/extract-office-runtime.yml`
  (master) — the authoritative how-to. Sources per its header: **linux** =
  `onlyoffice/documentserver` Docker image (docker-cp from a *created*, never
  started container → cross-arch safe); **darwin** = the
  `ONLYOFFICE/DocumentBuilder` release archive (docbuilder + x2t +
  frameworks — the Desktop Editors DMG ships x2t but NOT docbuilder) + sdkjs
  from the Desktop Editors DMG. Each tarball expands to `bin/` + `sdkjs/`.
- Consumer wiring in this workspace: `main.go:57-65` (repo consts, version
  pin) and `binaries.go` `ensureOnlyofficeRuntime()` (download, extract,
  chmod, version-stamp cache). Reference Go client:
  `components/tool/officecreate` (env vars `DOCBUILDER_PATH` /
  `ONLYOFFICE_SDKJS_DIR`, invocation below).
- **A Rust rig Tool already exists**: `crates/tools/officecreate/`
  (parent workspace, same rig pin `4232abdb`) — `OfficeCreateTool` with
  `with_binary`/`with_timeout_secs`, `<outDir>` substitution, output routing.
  Reuse it (git dep or vendored port) rather than writing a third client.
- **Invocation recipe** (docbuilder is picky; this is the working form,
  `components/tool/officecreate/docbuilder.go:37`):
  `docbuilder --check-fonts=0 --save-use-only-names=<outDir> <script>` with
  **cwd = the docbuilder binDir** (framework/DoctRenderer.config resolution)
  and `LD_LIBRARY_PATH=<binDir>`; the script must save to
  `<outDir>/output.<ext>` (substitute `<outDir>` with the absolute path
  BEFORE writing the script); on success the file appears at
  `<outDir>/output.<ext>`. 180s timeout, kill on deadline.
- **License**: free Document Builder permits `builder.CreateFile` (new
  documents — all kawai needs); `builder.OpenFile` (editing existing) is
  commercial-gated. Editing goes through `ooxcli edit` instead — no license.
- **Known trap**: running the darwin docbuilder with the wrong invocation
  (plain `docbuilder script.js`, no flags, cwd elsewhere) exits 0 SILENTLY
  with no output file and no error. Always use the recipe above; on missing
  output, fail with the "no output file at <path>" error like the Go client.
- NOTE: `.plano/bin/office-runtime.version` says `runtime-v6` while
  `main.go` pins `runtime-v5` — the workspace's own docs still claim
  "docbuilder linux-only" (stale); when touching those files, fix the claim.

CLI surfaces (verified from source):

```
ooxcli extract [--baseurl <url>] <in.docx|xlsx|pptx>      # Markdown → stdout
ooxcli edit <in.docx|xlsx|pptx> [--out <out>]             # ops JSON via --ops <file> or STDIN
ooxcli info <in.docx|xlsx|pptx>                           # JSON → stdout
ooxcli validate <in.docx|xlsx|pptx>

pdfcli extract [--pages N,N] <in.pdf>                     # text → stdout
pdfcli search <pattern> [--pages N,N] <in.pdf>            # JSON → stdout
pdfcli replace <pat> <repl> [--pages N,N] <in> <out>
pdfcli merge <in.pdf>... <out.pdf>
pdfcli split [--ranges R,R] <in.pdf> <outdir/>
pdfcli info <in.pdf> / metadata get|set / images
```

`ooxcli edit` accepts the SAME declarative op vocabulary as egent-office
office-edit (verified in `gooxml/cmd/ooxcli/edit.go`): docx
`replace_text`/`append_paragraphs`/`append_table`/`delete_paragraph`/
`format_paragraph`; xlsx `replace_text`/`append_rows`/`set_cell`; pptx
`replace_text`/`append_slides`/`remove_slide`. **The model-facing docs in the
kawai system prompt port 1:1 from egent-office's prompt** — same op names,
same JSON shapes.

### 3.2 Embedding / bundling mechanics

Resolution order for the binaries dir (checked at first use, then cached in
a `OnceLock`, mirroring `engine_slot` patterns — keeps `logic.rs` pure; the
transport shell injects its path at startup):

1. `KAWAI_OFFICE_BIN_DIR` env (dev override; also how kawai-web finds them).
2. Bin dir injected by the app shell: desktop `lib.rs` setup hook calls
   `logic::office::set_bin_dir(resource_dir/office-bin)` from
   `app.path().resource_dir()`. (Pure logic stays pure — the shell owns
   Tauri types.)
3. Fallback: `<exe_dir>/office-bin` (kawai-web deployed with sibling binaries).

Distribution per platform:

| Target | Mechanism |
|---|---|
| **Desktop .app/.dmg/.deb/.msi** | CI (release.yml) fetches the engines per platform, then tauri-action builds with `--features litert,office --config .github/tauri-office.json` — a merge config adding `bundle.resources: [office-bin/*, office-runtime/**/*]`. Base `tauri.conf.json` stays clean (local non-office builds never need the dirs). At runtime the lib.rs setup hook injects `resource_dir/{office-bin,office-runtime}`. |
| **Dev** | `scripts/fetch-office-bins.sh` downloads into `src-tauri/office-bin/` (gitignored): pinned `ooxcli` v0.1.3 + `pdfcli` v0.1.4 assets for the host triple, plus the `office-runtime-<slug>.tar.gz` (runtime-v8 default, override with `RUNTIME_TAG=…`) extracted to `src-tauri/office-runtime/`, synced to `target/debug/{office-bin,office-runtime}` for the exe-dir fallback. (sha256 lock file: still TODO.) Default resolution picks these up in `cargo run`/`tauri dev`. |
| **kawai-web (linux)** | Deploy `kawai-web` + `office-bin/` + `office-runtime/` siblings (or set `KAWAI_OFFICE_BIN_DIR` / `KAWAI_OFFICE_RUNTIME_DIR`). |
| **Mobile** | Not bundled (exec prohibited). Capability probe reports unavailable; tools return a friendly error. |

Correctness details that WILL bite otherwise:

- **Exec bit**: verify resources keep `+x` through bundling (Risk R4); the
  runner copies a binary to app-data on first use + `chmod 755` if the
  bundled copy isn't executable (also sidesteps macOS read-only resource
  fences and gives a per-user warm cache).
- **Quarantine/codesign**: binaries inside the signed .app inherit trust on
  macOS; the first-use copy re-signs nothing (ad-hoc exec of signed content
  is fine). Windows: SmartScreen only applies to downloads, not MSI payloads.
- **Version pinning**: `office-bin.lock` records tag + sha256 per binary and
  the office-runtime tag. Startup probe (§3.3) logs resolved versions.

### 3.3 CLI runner (in `logic/office.rs`)

```rust
async fn run_cli(bin: &str, args: &[&str], stdin: Option<&[u8]>) -> Result<Output, String>
```
- `tokio::process::Command`, `.kill_on_drop(true)`, output captured;
  `tokio::time::timeout(60s)` per call (create via docbuilder: 180s);
- ops JSON passed via **stdin** (`--ops` would need a temp file; stdin is
  what `ooxcli edit` already supports);
- a `Semaphore(2)` caps concurrent CLI processes (low-RAM devices);
- non-zero exit → `Err(stderr)` (CLIs print errors to stderr, exit 1).
- **Capability probe** (startup + on-demand): `office_capabilities()` →
  `{ ooxcli: bool, pdfcli: bool, docbuilder: bool }` by checking
  presence+executable (+ for docbuilder, platform == linux). Exposed as an
  RPC op so the UI/agent prompt can degrade gracefully. The agent's tool
  manifest is built from the probe — tools absent engines are never offered
  to the model.

---

## 4. Document store (files on disk, no sqld blobs)

- Root: `KAWAI_DOCS_DIR` env override, else sibling of the replica dir
  (desktop/mobile: app-data-adjacent; web: server-local dir).
  Layout: `<root>/<user_id>/<file_id>__<slug>.<ext>`; sidecar
  `<file_id>.meta.json` carries `{ id, originalName, createdAt, bytes }`.
- `file_id` = timestamp+random unique id; slug = sanitized original name.
- **Path safety (non-negotiable):** tools address files by `file_id` ONLY.
  The store resolves id → canonical path and enforces `starts_with(root)`
  after canonicalization. Import is the ONLY op accepting outside paths
  (desktop) or base64 blobs (drag-drop / web).
- Ops: `import` (copy in), `list`, `read bytes`, `export` (copy out).
- Note: `ooxcli extract --baseurl` prefixes image URLs in the emitted
  markdown — pass a virtual prefix (e.g. `/office-files/<user_id>/<file_id>/`)
  and wire a later op to serve extracted images; v1 can also pass a bare
  placeholder and let the model ignore image refs.

---

## 5. Office tool catalog (v1)

Tools address files by `fileId`. Model-facing names/docs port from
egent-office where semantics match.

| # | Tool | Backing | Gated on |
|---|---|---|---|
| 1 | `office_list_files` | store | — |
| 2 | `office_read_document` | `ooxcli extract` → markdown (docx/xlsx/pptx) | ooxcli |
| 3 | `office_document_info` | `ooxcli info` (paragraphs/sheets/slides, core props) | ooxcli |
| 4 | `office_edit_document` | `ooxcli edit` (ops JSON via stdin; docx/xlsx/pptx) | ooxcli |
| 5 | `office_create_document` | `docbuilder` (LLM writes docbuilder JS, port egent-office's condensed API reference) | docbuilder (darwin+linux) |
| 6 | `pdf_extract_text` | `pdfcli extract` | pdfcli |
| 7 | `pdf_search_text` | `pdfcli search` | pdfcli |
| 8 | `pdf_replace_text` | `pdfcli replace` | pdfcli |
| 9 | `pdf_merge` / `pdf_split` | `pdfcli merge` / `split` | pdfcli |
| 10 | `pdf_info` | `pdfcli info` | pdfcli |

(`metadata set` / `images` are trivial additions later; keep v1 surface
small — every tool in the manifest costs prompt tokens and Gemma 4 attention.)

### 5.4 Create on every desktop platform

`docbuilder` ships for darwin + linux in the office-runtime tarball (§3.1) —
verified working on this Mac — so `office_create_document` is available on
all desktop targets and kawai-web. Mobile has no subprocess exec → probe
reports absent → tool stays out of the manifest (§5.5). The free Document
Builder license covers `builder.CreateFile` (create) — exactly the kawai use;
editing existing files is commercial-gated and routed to `ooxcli edit` anyway.

### 5.5 Mobile

No subprocess exec → probe reports all engines absent → manifest is empty →
the `builtin.office` agent answers from general knowledge and says so.
No `#[cfg]` gymnastics; `std::process::Command` compiles everywhere.

---

## 6. Agent runtime — `logic::agent` (the Roadmap-5 slice)

### 6.1 Tool contract

Reuse rig's `ToolSet` (the declared Roadmap 5 dispatch mechanism): each
office tool = `impl rig::tool::Tool`, `Error = String`, JSON Input/Output.
`ToolSet::call(&name, &args_json)` gives dispatch; `ToolDefinition` gives the
manifest (name/description/parameters).

### 6.2 Prompt protocol (Gemma 4, Conversation API)

Every turn is sent as one user message (Conversation API takes user messages
only; history is in-engine):

```
<agent_context>
persona (office agent system prompt + condensed op reference, ported from egent-office)
<tools> [ToolDefinition JSON schemas, compacted, PROBE-FILTERED] </tools>
rules: to use a tool reply with ONE fenced block:
```tool
{"tool": "<name>", "args": { ... }}
```
If you have the final answer, reply WITHOUT a tool block.
</agent_context>
<user_request> … </user_request>
```

- Loop turn: model reply → scan for the fence → parse JSON:
  - **no fence** → final answer; stream tokens to UI.
  - **valid** → `toolCall` event → `ToolSet::call` → `toolResult` event →
    next user message: `TOOL_RESULT <name>: <json or error>` + `Now continue.`
  - **malformed** → `TOOL_ERROR: …` repair prompt — **one** repair round,
    then end the turn with a visible error. Never loop on garbage.
- **Iteration cap:** 5 tool calls/turn; on cap force a final answer
  (`TOOL_BUDGET_EXHAUSTED — answer with what you have.`).
- **Engine concurrency:** the loop takes the conversation slot exactly like
  `local_chat` (take/restore; reject concurrent generations). Tool exec
  happens BETWEEN generations — the slot is held across the whole user turn
  so reset/unload/load reject mid-turn (they already reject while taken).
- **Cancellation:** same registry pattern; on cancel the blocking task still
  finishes (LiteRT landmine); the loop then discards any pending tool call.
- **Spike (Phase 3):** (a) fence reliability on Gemma 4, (b) cost of
  re-sending `<agent_context>` per turn (KV-cache?). If re-send is
  prohibitive: send manifest once as turn 1 ("reply READY"), re-inject on
  schema change or hallucinated tool call.

### 6.3 Event enum

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentChatEvent {
    Started,
    Token { text: String },
    ToolCall { tool: String, args: serde_json::Value },
    ToolResult { tool: String, ok: bool, summary: String }, // ~500-char summary
    Finished,
    Error { message: String },
}
```
Terminal variants `finished`/`error` (invariant 6).

### 6.4 Persistence

Existing sessions/messages tables untouched; office sessions carry
`agent_id = 'builtin.office'`. Persist the user message on send and the
**final answer only** as the assistant message (tool chatter is ephemeral UI
events). Engine context stays in-memory across restarts (same trade-off as
MVP 1).

---

## 7. New operations (checklist-conformant)

One snake_case string each; both wrappers; identity at the edge.

| Op | Kind | Notes |
|---|---|---|
| `office_import_file` | RPC | `sourcePath` (desktop) or `name`+`dataBase64` (drag-drop/web). Auth-required. |
| `office_list_files` | RPC | → `Vec<OfficeFile>` |
| `office_read_document` | RPC | `fileId` → `{markdown}` |
| `office_export_file` | RPC | `fileId`, `destPath?` → path |
| `office_capabilities` | RPC | probe → which engines/bin versions are available |
| `agent_chat` | STREAM | `sessionId?`, `agentId?`, `message`, `stream_id`, `Channel<AgentChatEvent>`; lazy session creation + title seeding + final-answer persistence. Web: SSE twin. Auth-required. |

Web request structs: `#[serde(rename_all = "camelCase")]` (Landmines).
Streaming commands take `stream_id` + registry token (asymmetric
cancellation).

---

## 8. Phases

Each phase ends with the verify block green: `cargo check` &&
`cargo check --features web` && `cargo check --features litert` (+ mobile
checks when shared code changes).

### Phase 0 — module split (no behavior change)
1. Split `logic.rs` → `logic/{mod,db,local_llm}.rs` (verbatim moves, same
   `pub` paths). **Requires user OK (moves a file).**

### Phase 1 — runtime bundle + store + read path (feature `office`)
1. `scripts/fetch-office-bins.sh` + `office-bin.lock` (pin ooxcli v0.1.3,
   pdfcli v0.1.4 + sha256 per platform).
2. `logic/office.rs`: bin-dir resolution (env → injected → exe-sibling),
   first-use copy+chmod, `run_cli` (timeout/kill_on_drop/semaphore),
   capability probe; document store (import/list/resolve/export) with
   traversal guard.
3. Read tools: `office_read_document` (ooxcli extract), `office_document_info`,
   `pdf_extract_text`, `pdf_search_text`, `pdf_info` + the RPC ops (both
   wrappers, registered in `lib.rs`) + `office_capabilities`.
4. `tauri.conf.json` resources wiring (mac first; windows/linux file sets
   noted for MVP 14).
5. Tests: fixture docs through `run_cli` (golden markdown), traversal
   rejection, probe behavior with empty bin dir.
6. Manual: `bun tauri dev` with `KAWAI_OFFICE_BIN_DIR` unset → confirm
   resource/exe-sibling resolution + exec bit.

### Phase 2 — edit/create path
1. `office_edit_document` → `ooxcli edit` (ops via stdin) — op validation in
   Rust BEFORE exec (reject unknown op types; cheap guard against model
   hallucination producing CLI garbage).
2. `pdf_replace_text` / `pdf_merge` / `pdf_split` tools.
3. `office_create_document` → docbuilder (capability-gated; condensed
   docbuilder JS reference ported into the prompt). Verified locally on
   darwin via `.plano/bin/office-runtime/` — dev-test without linux.
4. Tests: each op end-to-end on fixtures (create → edit → read round-trip).

### Phase 3 — agent runtime (feature `litert`)
1. `logic/agent.rs`: manifest renderer (probe-filtered), fence parser,
   dispatch loop, repair-once, cap-5, cancellation-safe slot handling.
2. Spike on Gemma 4: fence reliability + context re-send cost; record
   findings; adjust protocol if needed (§6.2 fallbacks).
3. `agent_chat` op (both wrappers) + registry + persistence.
4. Decide §5.4 create gap (defer vs Rust writer).

### Phase 4 — UI (vanilla JS, no build step)
1. `src/lib/office.js`: file list, import (drag-drop → base64), export,
   capabilities badge.
2. Agent pane: agent switcher chip (`builtin.office`),
   `toolCall`/`toolResult` collapsible rows, file chips.
3. Manual pass `bun tauri dev` (litert env recipe); errors via `errText`.

### Phase 5 — hardening + docs
1. Malformed-model-output matrix (no fence, broken JSON, fence inside final
   answer, hallucinated tool/op names → TOOL_ERROR path).
2. Cancel mid-tool-call; CLI timeout kill; concurrent tool calls.
3. Update AGENTS.md: Where-things-live, auth-required op list, office-bin
   bundling landmines (exec bit, codesign), Roadmap 5 cross-link.
4. Full verify matrix incl. mobile checks.

---

## 9. Risks / open questions

| # | Risk | Mitigation |
|---|---|---|
| R1 | Gemma 4 unreliable at emitting valid JSON tool calls | One-fence protocol; repair-once; cap-5; Phase 3 spike gates Phase 4. Fallbacks: fewer tools, flat args, few-shot in manifest. |
| R2 | Per-turn manifest re-send latency | Measure; send-once fallback (§6.2). |
| R3 | Tauri resources lose exec bit / macOS fences | First-use copy to app-data + chmod (§3.2); manual check in Phase 1.6. |
| R4 | Binary size (+~30-60 MB Go CLIs, +~100-200 MB office-runtime with frameworks + sdkjs) | Acceptable vs GB-scale models; ship create (docbuilder) as an opt-in download later if size hurts. |
| R5 | Version skew: ooxcli op set vs prompt docs | Pin tag in `office-bin.lock`; prompt docs generated from the probe/manifest, op list unit-tested against `ooxcli edit --help` output in CI-ish test. |
| R6 | Tool-seam consistency (kawai-tools `AgentTool`) | Office tools implement the repo-root `kawai-tools` trait like every other agent tool. |
| R7 | Loop holds the conversation slot across a user turn (N generations + tool exec) | Intentional: reset/unload/load already reject while taken; loop restores unconditionally like `local_chat`. Document in code. |
| R8 | docbuilder silent-no-op when misinvoked (exit 0, no output, no error — observed on runtime-v6 without `builder.CloseFile()`; **runtime-v8 produces output in both cases**, verified 2026-08-17) | Keep the exact recipe (§3.1: flags + cwd=binDir + `<outDir>` substitution + output-path stat); runner appends `builder.CloseFile();` + trailing newline defensively; e2e create test in Phase 2. Free license = CreateFile only — fine (edit goes via ooxcli). |
| R9 | CLI stderr format drift | Errors surfaced verbatim to the model as TOOL_ERROR (it can react); we never parse stderr beyond display. |
| R10 | Mobile: no exec → office dead on mobile | By design (§5.5): probe-gated, graceful message; mobile office needs in-process engines — a future decision, not v1. |

---

## 10. Deferred backlog (explicitly out of v1)

- Rendering conversion docx/xlsx/pptx → pdf (x2t runtime tree bundling).
- `pdfcli metadata set` / `images` tools; extracted-image serving op.
- Reusing `crates/tools/officecreate` as a git dep (needs publishing the
   crate to a kawai-reachable git repo; v1 ports/execs the same recipe).
- File pick/save dialogs (tauri-plugin-dialog).
- Multi-device file sync (sqld blobs or content-addressed store).
- Agent catalog UI + per-agent toolset curation (Roadmap 5 proper).
- Mobile in-process office engines (pure-Rust read-only fallback?).
