# Implementation Plan — Hybrid LLM: local orchestrator + cloud subagents (kawai)

Status: **IMPLEMENTED (2026-08-20)** — shipped in commit `3c79675`. Local Gemma 4
orchestrates; cloud subagents `deep_write` / `draft_document` are wired via
`agent_chat` prompt-based tool calling (`logic/remote.rs`, `logic/agent.rs`). CI
smoke gate lives in `.github/workflows/ci.yml`. This doc is now a design record;
the live status lives in `AGENTS.md` → Roadmap 5 ✅ and `ARCHITECTURE.md` → LLM.

Decision context (2026-08-20): after extensive testing, on-device LiteRT-LM
(Gemma 4 E2B, CPU) is **not feasible for medium/heavy work** — long synthesis,
multi-tool reasoning, large-context analysis. It IS fine for short structured
output (tool-call fences, compression, quick replies). Conclusion: combine with
a cloud LLM. The user explicitly rejected *separating* (an env switch
`KAWAI_LLM_PROVIDER=local|remote`, or pinning whole agents to one backend) in
favor of **hybrid: local and cloud working together inside the same turn**.

The chosen shape is the **subagent pattern**: the cloud LLM is exposed to the
local model as a *tool* in the existing toolset. The local model remains the
permanent orchestrator; cloud is the most expensive tool it can choose to use.

---

## 1. Core concept

> **Subagent = a tool whose implementation calls an LLM.** From the loop's
> point of view nothing changes: the model emits the same ```tool fence, gets a
> result back. Behind the scenes the tool executes one stateless cloud request
> with its own task brief.

Division of labor, derived from what testing proved local can/can't do:

| Work | Executor | Why |
|---|---|---|
| Tool-call decision (short JSON fence) | **local** | Short structured output — local's strength, free, private |
| Light chat turns ("ok, thanks", quick facts) | **local** | No reason to pay cloud |
| Compression / relevance filtering of tool results | **local** | Short output over already-in-context material |
| Deterministic tools (search, extract, file write, CRUD) | **Rust tools** | Not LLM work at all — never wrap these in an LLM |
| Long-form synthesis (reports, comparisons, drafts, code) | **cloud subagent** | The infeasible-on-CPU part |

One-line summary: **local plans and compresses; cloud writes.** Every heavy
turn is a collaboration; every light turn is pure local.

Why this works technically: cloud is stateless, so it can join/leave mid-turn
at zero reconciliation cost — the full prompt is always rebuilt from SQLite
(`compact_transcript` + `build_prompt` already exist in `logic/agent.rs`).
LiteRT stays stateful exactly as it is (K/V cache + opener/delta manifest
protocol untouched).

### What is NOT a subagent (hard rule)

Deterministic, cheap, or retrieval work stays plain tools:
`knowledge_search`, PDF/ooxcli extraction, index/chunk/embed, YouTube import,
weather/entity lookups, all CRUD, `office_create_*` file writing. Test: *must
the output be composed (drafted, analyzed, judged)?* If yes → LLM work. If the
output is identical for identical input → Rust.

---

## 2. Goals / Non-goals

**Goals**1. Heavy turns become feasible: local orchestrates, a cloud LLM synthesizes,
   the user sees one streaming answer. Light turns never leave the device.
2. Zero new UX surface: no provider toggle, no mode switch, no per-agent
   backend pickers. Choosing an agent stays the only user decision. (A small
   provenance badge is allowed, not required, in v1.)
3. Minimal new architecture: one new module (`logic/remote.rs`), subagents
   registered through the existing rig `ToolSet`, the existing fence-tool loop
   drives everything. No second tool-calling implementation.
4. Cost/privacy by construction: cloud receives only a curated task package
   (task + locally-compressed materials), never full documents; per-turn
   subagent call budget is capped in code.
5. All kawai invariants hold (pure logic, both wrappers per op, identity at
   the edge, `#[serde(tag = "type")]` events, camelCase web structs,
   feature-gated deps).

**Non-goals (v1)**

- **Zero config is the product (decision 2026-08-20).** No BYOK, no model
  picker, no provider settings, no cloud on/off UI — ever. The vault key
  (compiled-in, zai default) makes the cloud tier work out of the box for
  every user; cloud costs are the product's costs. `KAWAI_REMOTE_LLM_*` env
  vars are dev/internal knobs (kill-switch, A/B), never user surface. If key
  extraction from shipped binaries ever becomes a real concern, the fix is a
  server-side token broker (Roadmap 8 pattern) — which preserves the
  zero-config UX — NOT BYOK.

- Native function calling for the cloud path — the fence protocol is used for
  both tiers (validated pattern: rig-examples `manual_tool_calls`). Revisit as
  an optimization only if fence reliability on cloud proves poor.
- Local-as-tool for cloud (cloud calling back into on-device models), critic /
  evaluator loops, parallel subagents. Tracked in §8.
- Any UI for choosing compute. Routing emerges from the model's own tool
  choices, not from user settings.
- Mobile/web orchestrator variants (see §9 for the future option).

---

## 3. Architecture overview

```
user message
     │
     ▼
logic::agent::agent_chat            (PURE loop — unchanged skeleton)
  │  session mgmt, SQLite persistence, tool dispatch, budgets, repair
  │
  ├─ every turn ──────────────► logic::local_llm::local_chat   (LOCAL, stateful)
  │      │                        delta prompt via manifest protocol
  │      │
  │      ├─ answers directly (no fence) ──► done. Free/private/offline.
  │      │
  │      └─ emits ```tool fence
  │              │
  │              ├── plain tool (knowledge_search, office_*, …)
  │              │        → executed locally in Rust, result fed back
  │              │
  │              └── subagent tool (deep_write, draft_document, …)
  │                       → logic::remote.rs  (NEW — one stateless call)
  │                          rig 0.42 streaming client, task brief + materials
  │                       → result streams to user + persists
  │
  └─ pathology (malformed fence ×2, prefill overflow, timeout)
           → turn retried with cloud assistance (§6.3)
```

Unchanged: `local_llm` module (stateful conversation, epochs, manifest
tracking), SQLite schema for sessions/messages, event unions
(`LocalChatEvent` / `AgentChatEvent` shapes), both transport wrappers,
frontend chat flow.

New: `logic/remote.rs` (cloud client), subagent tool impls, a `final: true`
convention in the loop, a telemetry table, `.env` keys for the provider.

### Why not the alternatives (decision log)

| Alternative | Rejected because |
|---|---|
| `KAWAI_LLM_PROVIDER=local\|remote` switch | Separates instead of combines; user explicitly rejected |
| Per-agent `backend: Local\|Remote\|Auto` field | "Office → Remote" is separation in disguise; whole agents migrate campuses instead of collaborating per turn |
| Stateless local (rebuild conversation per turn) | Repeated CPU prefill (~seconds per turn, multiplied per tool-loop iteration) — a real UX regression; also stateless doesn't remove the segfault landmine |
| Step classification (`Plan/Compact/Synthesize` hardcoded per step) | Rust code second-guesses what only the model knows; subagent pattern lets the model decide, with zero router code |
| LLM classifier routing (rig-examples `agent_routing`) | Paying a cloud round-trip to decide whether to pay cloud; routing here must be free and exact |

---

## 4. The subagent contract

All subagent tools share one shape (registered in the agent's rig `ToolSet`,
bound server-side to `user_id` + `session_id` exactly like `knowledge_search` —
the model can never supply identity):

```rust
// args (model-facing)
{
  "task":      "Compare contracts A and B; focus on payment clauses and liability",
  "materials": "<locally-compressed context: RAG snippets, prior extracts>"  // capped
}
// output (fed back into the loop)
{
  "text":  "<short receipt: what was produced / where it lives>",
  "final": true   // when true: this result IS the turn's answer (§6.2)
}
```

**Two output modes, nothing else** (rule sharpened 2026-08-20 — a large
payload must NEVER re-enter local's loop context):

1. **Streamed text** (`deep_write`): the composed answer streams to the user
   via the `final: true` passthrough; local persists it but never rewrites it.
2. **Artifact + receipt** (`draft_document`): the tool writes the artifact
   (file) itself and returns only a short receipt (filename, section count,
   outline). Local closes the turn from the receipt alone.

There is deliberately no third mode "long text back into the loop" — that is
the infeasible long-output work this entire plan exists to avoid.

- **`task`** is written by the local model: the specific brief, not the chat
  history. **`materials`** is what local chose/filtered/compressed — this is
  the privacy and cost firewall (full docs never leave; char cap enforced in
  Rust before the request, mirroring `TOOL_RESULT_MODEL_CHARS`).
- Each subagent carries its own system persona inside `remote.rs` (v1: hardcoded
  consts; the local model does not control it).
- Output validation: a subagent returning malformed output is retried once
  with an appended correction instruction, then surfaces as a normal tool
  error (`ToolExecutionError` + `with_model_feedback`, pattern from
  rig-examples `tool_result_outcomes`).

### v1 catalog: `deep_write`

The single v1 subagent. Universal, no file-format coupling.

- Persona: analytical long-form writer. Input: task + materials. Output:
  markdown answer, `final: true`.
- Persona guidance for the *calling* agents (added to their system prompts):
  "answers that are long, analytical, comparative, or creative MUST be
  delegated to `deep_write`; short factual replies answer directly."
- Cap: at most **1** `deep_write` call per turn in v1 (loop budget counter,
  same mechanism as `MAX_TOOL_CALLS`).

### v2 catalog: `draft_document`

The visible product win: knowledge → real document.

**Design rule (2026-08-20 revision): the subagent writes the file itself.**
A two-step variant (draft JSON fed back into the loop, then a separate
`office_create_*` call) was rejected: it would push the full draft (30–60k
chars) back through local's K/V context — the exact long-output work this
plan offloads, and a budget burner (8192-token context).

```
local: knowledge_search / extract (plain tools, on-device)
  → draft_document(task, materials, format: "docx"|"pptx"|"xlsx",
                   outline_hint?)
      INSIDE the tool (Rust — never enters local's context):
        cloud composes STRUCTURED content JSON (sections, tables, bullets)
        → validate shape (cheap, deterministic)
        → office engine writes the actual file into the document store
      RETURNS ONLY a short receipt:
        {"file":"report-q3.docx","sections":5,"outline":"..."}
  → local closes the turn: "Dokumen dibuat: report-q3.docx (5 bagian)"
```

- Big data flows **cloud → Rust → disk**, bypassing local's K/V entirely.
  Local never sees the draft body — only the receipt metadata.
- The cloud returns **structured content JSON** (a schema we define per
  format), not prose — so validation is cheap and the deterministic office
  engine consumes it directly.
- `draft_document` wraps the existing office machinery internally (same
  store, same create code paths as `office_create_*`); it does not call it as
  a separate loop tool. `office_create_*` remains a plain tool for
  non-composed uses (templates, user-supplied content).

### Later catalog (only after telemetry proves need — §7)

`analyze_spreadsheet` (interpret computed results: anomalies, trends),
`code_write`, `translate/polish`, `critic` (evaluator-optimizer loop),
`research_plan` (multi-hop retrieval orchestration), parallel fan-out.

---

## 5. `logic/remote.rs` (new module)

Pure module — no tauri/axum types. One public surface:

```rust
pub struct RemoteLlm { /* rig client, model id, char caps, call budget */ }

impl RemoteLlm {
    pub fn from_env() -> Option<Self>;              // None ⇒ subagents disabled
    pub async fn stream(&self, system: &str, task: &str, materials: &str)
        -> Result<impl Stream<Item = Result<String, String>>, String>;
}
```

- **Provider**: one to start (whichever account exists; Gemini or OpenAI via
  rig 0.42 — already pinned graph-wide, zero new deps). Config in `.env`:
  `KAWAI_REMOTE_LLM_PROVIDER`, `KAWAI_REMOTE_LLM_API_KEY`,
  `KAWAI_REMOTE_LLM_MODEL`, optional `KAWAI_REMOTE_LLM_BASE_URL`.
- **Graceful degradation**: no API key ⇒ `from_env() → None` ⇒ subagent tools
  are simply not registered in any toolset; agents behave exactly as today
  (pure local). No errors, no UI changes.
- **Streaming map** (pattern: rig-examples `openai_streaming_per_call_usage`):
  `MultiTurnStreamItem::StreamAssistantItem(Text)` → text chunks;
  per-call `Usage` is captured for telemetry before being discarded.
- **Cancellation**: the stream is dropped when the turn's `CancellationToken`
  fires (desktop `cancel_stream`; web AbortController) — reqwest/rig abort on
  drop, so no extra plumbing.
- **Hard caps in code**: `materials` char limit (default 24k chars ≈ 6k
  tokens), `max_output_tokens`, 10-min request timeout, 1 subagent call per
  turn (v1).

---

## 6. Loop modifications in `logic/agent.rs`

The loop skeleton, session handling, persistence, `MAX_TOOL_CALLS`,
`repairs_used`, overflow recovery — all unchanged. Three additions:

### 6.1 Subagent registration

Where toolsets are built (`toolset_for`): when `RemoteLlm::from_env()` is
`Some`, append `deep_write` to the toolset (v1: every agent that has any
tools). Tool manifest rendering into the prompt picks it up automatically —
the manifest/delta protocol re-sends definitions only when the epoch resets,
unchanged.

### 6.2 `final: true` passthrough

Today a tool result is always fed back to local for the next generation
(`agent.rs` — the `TOOL_RESULT …` prompt construction). For a `final:true`
subagent result that would force local to re-type a long cloud answer:
slow, lossy, and exactly the infeasible work we're offloading. New branch:

- Cloud tokens are forwarded to the UI **as they arrive** as
  `AgentChatEvent::Token` (same event, so `use-local-chat.ts` and tool-card
  rendering need no new variant; optionally a `source` field later for the
  provenance badge).
- On completion the text is persisted as the assistant message and the turn
  ends (`AgentChatEvent::Finished`) — local never rewrites it.
- Local still participates: it chose the task, curated `materials`, and can
  issue a *short* follow-up fence before delegating (e.g. one more
  `knowledge_search`). Only the final synthesis is passed through.

### 6.3 Pathology escalation (reuses existing detection)

Existing signals stay; add one behavior — when local fails on a heavy-looking
turn, the turn is retried with cloud help instead of erroring:

| Signal (already detected) | Today | New |
|---|---|---|
| malformed fence ×2 (`repairs_used`) | turn fails | if `deep_write` available: one delegated retry; else fail as today |
| prefill overflow (`is_prefill_overflow`) | reset + smaller transcript retry | unchanged (local problem, not cloud's) |

Light turns that local answers directly never touch this path.

---

## 7. Telemetry (lands with v1, calibrated in v2)

SQLite table in the per-user DB (same rules as other tables — no user_id
column, structural isolation):

```sql
CREATE TABLE IF NOT EXISTS turn_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,        -- 'local' | 'cloud'
  tool TEXT,                     -- subagent name when provider='cloud'
  input_tokens INTEGER,          -- from rig Usage when cloud; est (chars/4) when local
  output_tokens INTEGER,
  latency_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,         -- 'answer' | 'tool_call' | 'escalated' | 'error'
  created_at INTEGER NOT NULL
);
```

Written inside `agent_chat` (pure db calls, no new ops/wrappers needed for v1 —
rows are read locally during calibration, not exposed to the frontend yet).
This data answers the two open questions: how often local answers without
delegating when it should have (quality risk, §10) and what cloud actually
costs per agent per day.

---

## 8. Implementation phases

### Phase 1 — `deep_write` end-to-end (the vertical slice)

**✅ Implemented 2026-08-20** (all items below landed and verified):

1. ✅ `src-tauri/src/logic/remote.rs` — `RemoteLlm` (streaming, usage capture,
   caps, cancellation-by-drop). One code path: OpenAI-compatible
   `CompletionsClient` for all providers (`zai` default w/ kawai-vault key
   fallback → glm-5.3, or `openai`/`openrouter`/`custom` via env).
2. ✅ `deep_write` registered as a manifest tool (`PortableTool`) in every
   tool-carrying agent's ToolSet when `RemoteLlm::from_env()` is `Some`;
   dispatch intercepted in the loop (before `ToolSet::execute` — rig tools
   return final values only; the subagent needs per-token streaming).
   Budget: 1 cloud call per turn (`MAX_SUBAGENT_CALLS`).
3. ✅ Loop: `final:true` passthrough (cloud tokens stream to the user,
   persist as the assistant message, turn ends; local never rewrites);
   escalation on malformed-fence ×2 (task = user message, materials =
   compacted transcript, `outcome: "escalated"` in turn_log); cloud failure
   degrades to local (fed back as TOOL_RESULT error); 600s deadline per call.
4. ✅ `turn_log` table + best-effort `db::log_turn` (local answers, cloud
   answers w/ provider usage, errors, escalations).
5. ✅ Persona rule injected when remote is configured (DEEP_WRITE_RULE):
   "long/analytical/comparative/creative ⇒ MUST delegate to deep_write".
6. ✅ `.env` keys in AGENTS.md; verification green: `bun run build`,
   `cargo check`, `--features web`, `--features litert`, `--features
   litert,office`, iOS + Android ndk checks, `cargo test --features litert
   --lib` 19/19. (Known pre-existing: `litert,office,web` combined fails in
   `web.rs` on the reqwest 0.13 landmine — fails on the clean tree too.)
7. Pending manual smoke (needs a live key): dev run with
   `KAWAI_REMOTE_LLM_PROVIDER=zai` on the office agent — heavy prompt streams
   a cloud answer, `turn_log` rows written, cancel mid-stream aborts; and
   without a key — agents behave exactly as today.

### Phase 2 — `draft_document` + calibration

**✅ Implemented 2026-08-20** (the subagent; calibration is ongoing usage):

1. ✅ `draft_document` subagent (office-gated): local supplies `task` +
   `filename` + curated `materials` → cloud composes structured
   `{"blocks":[...]}` JSON (same DocBlock vocabulary as
   `office_create_document`) → `extract_draft_blocks` validates (fence/prose
   stripping, bare-array acceptance, schema validation; 4 unit tests) →
   `ooxml::create_document_from_blocks` writes the file in-process → short
   receipt `{file, blocks, outline}` fed back so local closes the turn.
   Draft JSON is machine payload: streamed tokens accumulate silently
   (capped 120k chars), never yielded as user-facing Token events.
2. ✅ One cloud correction round for malformed draft JSON (retry with the
   parse error appended), then surface as a normal tool error → local
   degrades gracefully.
3. ✅ Shared per-turn cloud budget (1 call across all subagent tools);
   DRAFT_DOCUMENT_RULE persona line for the office agent.
4. ✅ Smoke-tested end-to-end (`examples/draft_smoke.rs`): zai/glm-5.3 →
   9 blocks in 9.5s → valid .docx in the store + receipt. Full verify:
   `bun run build`, all `cargo check` variants, iOS + Android ndk checks,
   `cargo test --features litert,office --lib` 40/40.
5. ☐ Calibration from `turn_log` (ongoing — needs real usage days).
6. ☐ Provenance badge in the UI (optional, deferred — no UI surface wanted).

### Phase 3 — catalog growth (each gated on telemetry)

**Partially implemented 2026-08-20** — the parts that had code-level
justification today; the rest stay telemetry-gated per this section's rule:

1. ✅ **`deep_write` for the Chat agent** (the flagship item): when the
   remote tier is on, EVERY agent carries `deep_write` — including the
   tool-less chat agent, which now gets a subagent-only `ToolSet` (so the
   fence protocol + manifest are actually rendered; previously the persona
   rule was injected without a manifest — teaching a tool the model could
   not call). Fixed the "fully on-device" overclaim in the chat persona and
   catalog description at the same time. With remote off, behavior is
   byte-for-byte pre-hybrid (chat = no toolset).
2. ✅ **Calibration tooling** (Phase 2 leftover): `db::list_turn_log` reader
   + `examples/turn_log_report.rs` — per agent/provider calls, tokens,
   latency, escalations, errors; per-cloud-tool breakdown; and the
   under-delegation lens (cloud share of answered turns per agent).
   Zero surface: no ops, no wrappers, no frontend.
3. ☐ **`analyze_spreadsheet` / `code_write` / `translate`** — deferred:
   with one cloud budget per turn these are persona variants of
   `deep_write` (expressed via the task brief), not distinct tools. A
   separate tool is justified only when the input/output CONTRACT differs
   (like `draft_document`'s file artifact) or when telemetry shows the
   model can't express the intent through `task`. `code_write` also has no
   home agent yet.
4. ☐ **`critic` / parallel fan-out** — deferred: both need ≥2 cloud calls
   per turn (budget is 1); revisit when MAX_SUBAGENT_CALLS grows.
5. ☐ **Per-agent subagent allowlists** — deferred: with a 2-agent catalog
   the `toolset_for` match arms ARE the allowlist; introduce a declarative
   field when the catalog grows.

---

## 9. Future options explicitly NOT in scope now (recorded so they aren't lost)

- **Mobile/web before LiteRT-mobile ships**: the loop's orchestrator is local
  (`local_chat`, feature `litert`). A cloud-orchestrated variant (loop drives
  `remote.rs` directly, subagent tools become plain tools) would make
  `agent_chat` work on mobile/web today — tempting, but it re-introduces
  "separate modes"; only do it if mobile demand gets concrete.
- **Local as a cloud tool** (`into_tool()` pattern): privacy-preserving
  drafting inside cloud-orchestrated flows. Reversed direction of v1; revisit
  with Phase 3.
- **Draft-then-refine UX**: local streams an instant stub, cloud replaces it.
  Mid-stream text swap is risky UX; needs a design demo first
  (`design-demos/`).

---

## 10. Risks & mitigations

| Risk | Reality | Mitigation |
|---|---|---|
| Local under-delegates (answers shallowly without calling `deep_write`) | The core quality risk — silent, no error surfaces | Explicit persona instruction; `turn_log` `outcome` rows make the rate measurable; Phase 2 prompt tuning; worst case a per-agent "force delegation for long-form" persona rule |
| Local mis-formats the fence on heavy turns | Already observed historically | Existing `repairs_used` round + NEW cloud retry (§6.3) — heavy turns cannot end in a fence error while cloud is configured |
| Cost spikes | One `deep_write` per turn max, materials capped in chars, output token cap | Per-turn budget is code-enforced; `turn_log` gives per-agent cost; per-agent allowlists in Phase 3 |
| Privacy regression | Transcript snippets + curated materials leave the device on heavy turns | Full documents never leave (RAG stays local, snippets already capped); the delegation package is the only egress; no key ⇒ feature off entirely |
| Cloud outage / latency | Heavy turns degrade | Degradation is graceful: local still answers (shorter/shallower); light turns unaffected; timeout surfaces as a normal tool error the loop can answer around |
| Two-tier fence drift | Cloud models are *more* reliable fence-writers than local — risk is inverted (cloud adds prose around fences) | Subagent persona says "return ONLY the requested artifact"; `final:true` bypasses re-feeding anyway |
| Segfault landmine (dropping engine mid-generation) | Unchanged by this plan — `remote.rs` adds no engine lifetime complexity | Existing blocking-until-final-callback contract stays untouched |

---

## 11. Verification checklist (per phase)

- `bun run build` (frontend untouched in Phase 1 except optional badge — still run it)
- `cargo check` — axum must NOT compile in
- `cargo check --features web`
- `cargo check --features litert`
- Mobile (Phase 1 touches shared `logic/`): `cargo ndk -t arm64-v8a -P 24 check`
  and `cargo check --target aarch64-apple-ios`
- Behavioral: with API key — heavy prompt on office agent streams a cloud answer,
  `turn_log` rows written, cancel mid-stream aborts cleanly; without API key —
  agents behave exactly as today (pure local, no errors)
- Invariant spot-checks: no transport types in `remote.rs`; identity still
  bound server-side in toolset construction; event union changes (if any)
  mirrored in `use-local-chat.ts` AND `agent.rs` matchers

---

## 12. File-level change map (Phase 1)

```
src-tauri/src/logic/remote.rs        NEW  RemoteLlm + streaming + usage capture
src-tauri/src/logic/agent.rs         ADD  deep_write tool, final:true branch,
                                         escalation, turn_log writes, persona line
src-tauri/src/logic/mod.rs           ADD  pub mod remote;
src-tauri/src/logic/db.rs            ADD  turn_log table + insert helper
.env / .env.example (docs)           ADD  KAWAI_REMOTE_LLM_* keys
AGENTS.md                            ADD  .env keys; one-paragraph hybrid summary
frontend/src/hooks/use-local-chat.ts OPT  provider/source field on events (badge)
```

No changes: `commands.rs`, `web.rs` (no new ops — subagents are internal to
`agent_chat`), `local_llm` module, transport wrappers, frontend chat flow.
