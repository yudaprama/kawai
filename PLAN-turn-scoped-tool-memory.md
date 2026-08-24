# Implementation Plan — Turn-scoped tool memory: store oversized outputs, recall on demand (kawai)

Status: **IMPLEMENTED (2026-08-24)** — all phases shipped: `TurnMemory`
process log + `artifact_recall` + end-of-turn cloud close in
`logic/agent.rs`. Gates: `agent_eval` 20/20 (E4B), 110 lib tests, full cargo
check matrix incl. mobile, and a live e2e — the new binance-gated MEMORY turn
in `agent_smoke` (klines 500 → stored as `mem1` → cloud close → `deep_write`
from the full log) passes on a vault build. Live status in
`AGENTS.md` → Roadmap 5 ✅.

Implementation deltas from the original design (discovered while building):

- **`digest_line` was dropped.** The handle response embeds its digest inline
  (`[stored as memN — N chars total]`) and budget exhaustion uses
  `chain_digest()` — a per-handle digest accessor had no caller.
- **Recall interception sits AFTER the budget gate** (counts toward AND is
  bounded by `MAX_TOOL_CALLS`), not before it — the plan's "counts toward the
  budget" is enforced structurally.
- **`artifact_recall` registers for office + binance only** (both pure-local
  and remote paths in `toolset_for`). Tool-less agents produce no oversized
  outputs, so no toolset carries it gratuitously.

Decision context: local Gemma 4 orchestrates every agent turn. Plain tool
outputs reach 60k chars (`office_read_document`, `web_read`, `pdf_extract_text`,
klines). Today the dispatch arm hard-truncates what re-enters the conversation
at `TOOL_RESULT_MODEL_CHARS = 4000` (`agent.rs:78`) with a
`[output truncated — narrow the query]` note — lossy in a dumb way: the model
cannot get the missing 56k chars back except by re-running the tool with
narrower args and hoping. The cloud-subagent `materials` side already
accumulates up to 32k per turn *outside* local K/V (`turn_tool_results`,
`agent.rs:1306`), proving out-of-band buffering works. This plan upgrades that
flat buffer to a handle-addressed, per-turn store with a paging recall tool, so
truncation becomes recoverable instead of destructive. Every completed process
(tool call, recall page, subagent receipt) appends to the store — it is the
turn's process log. Tool-heavy turns additionally close with a
**cloud-synthesized answer**: the full log is handed to `RemoteLlm`
(`logic/remote.rs`, the existing `deep_write` path) so the user-facing response
is written from complete data, not excerpts — local gathers, cloud writes.

---

## 1. Core concept

> **Oversized tool outputs become turn-scoped artifacts. Every completed
> process appends to a turn-local process log; the model receives a handle +
> excerpt + char count instead of a truncated body, and pages the full content
> back through a new `artifact_recall(handle, offset)` tool. When the turn
> gathered real payload and a cloud provider is configured, the final answer is
> synthesized by `RemoteLlm` from the full log (cloud close).** The store lives
> only for the duration of one user message's stream — no SQLite, no
> cross-turn persistence, no eviction policy.

```
user message ──▶ agent_chat loop (one stream)
                   │
                   ├─ plain tool dispatch (≤ MAX_TOOL_CALLS = 8)
                   │    EVERY completed result ──▶ memory.record(...) (process log)
                   │    ≤ 4k chars  ──▶ inline `response:<tool>:` body (unchanged)
                   │    > 4k chars  ──▶ model gets: handle (mem1) + 2.4k excerpt + chars
                   │                    + "call artifact_recall to page the rest"
                   │
                   ├─ artifact_recall dispatch (loop-intercepted, counts toward budget)
                   │    → 3.6k-char page from the stored content, with next-offset marker
                   │    → also recorded in the log (a completed process)
                   │
                   ├─ deep_write / draft_document delegation (mid-turn, model-initiated)
                   │    materials = memory.materials() — the joined log (same shape
                   │    + 32k cap as today's turn_tool_results)
                   │
                   ├─ CLOUD CLOSE (end of turn): remote configured + log carries
                   │    real payload (≥ CLOUD_CLOSE_MIN_CHARS) + no subagent call
                   │    used yet ⇒ the last tool-result feedback prompt directs
                   │    the model to delegate the final answer via deep_write;
                   │    cloud synthesizes from the full log, tokens stream as
                   │    the user-facing answer
                   │
                   └─ stream ends (Finished/Error/cancel) ──▶ store dropped, zero cleanup
```

Division of labor:

| Concern | Owner | Why |
|---|---|---|
| Storing the process log | `TurnMemory` (plain local var in the `agent_chat` stream) | Per-turn scope ⇒ no schema, no cleanup, no privacy questions |
| Summarizing for the model | deterministic excerpt (head chars + counts) | The summarizer must not be local Gemma 4 — it is the model that can't hold the content; a deterministic head-excerpt is free and offline |
| Recovering the tail | `artifact_recall(handle, offset)` paging tool | Makes truncation recoverable; same 4k-class cap per page |
| Cloud subagent materials | `memory.materials()` — the joined log, rendered on demand | Already out-of-band; delegation needs full text, not digests |
| Final user-facing synthesis (tool-heavy turns) | **cloud close** via the existing `deep_write` delegation (`RemoteLlm::stream`, remote.rs:341) | Local saw only excerpts; the cloud sees the full log — and it is the model that can hold it |
| Cross-turn re-access | re-run the tool (deterministic, cheap for local tools) | Files live in the office store, answers in `messages`, web pages in the 15-min LRU — per-turn memory does not need to persist |

## 2. Goals / Non-goals

**Goals**

1. No tool output information is destroyed for the local model within a turn:
   anything over the 4k model cap is stored whole (≤ the 32k materials cap) and
   pageable in 3.6k slices.
2. Zero persistence: the store is born with the turn's stream and dropped when
   it ends. No new tables, migrations, files, or eviction logic.
3. Bounded growth: `MAX_TOOL_CALLS = 8` already bounds dispatches per turn, so
   the store holds at most 8 artifacts × ≤ 32k chars; recall calls draw from the
   same budget (no new loop risk).
4. Model-agnostic registration: `artifact_recall` appears in every toolset's
   compact manifest via the existing `PortableTool`-stub pattern
   (`DeepWrite`/`DraftDocument` precedent — registered for the manifest,
   intercepted in the loop before rig dispatch).
5. Tool-heavy turns end with a cloud-synthesized answer when the vault is
   configured: the full memory log goes to `RemoteLlm` as `materials` through
   the existing `deep_write` path. No-vault builds and trivial turns stay
   pure-local, byte-identical to today.
6. All invariants respected: `logic.rs` purity (change is entirely inside
   `agent.rs`; `remote.rs` is reused as-is), no new RPC op (tool-only — no
   `commands.rs`/`web.rs`/frontend changes, no new `AgentChatEvent` variants —
   `ToolCall`/`ToolResult` render recall like any tool), all cargo checks stay
   green.

**Non-goals**

- No cross-turn or cross-session memory (a follow-up turn re-runs the tool;
  deterministic local tools make that cheap — persisting memory is a separate
  product decision).
- No LLM-generated summaries of stored artifacts (deterministic excerpts only;
  the cloud close supersedes this need — the cloud sees the full text).
- No changes to the `RemoteLlm` call protocol — system/task/materials shape,
   the 32k materials cap, failover, and timeouts are reused untouched; the
   close only changes WHO triggers the delegation and WHAT the materials are
   rendered from.
- No indexing of ephemeral outputs into the RAG store (a candidate
  unification — route oversized outputs through chunk+embed like uploaded
  files — deferred; RAG retrieval latency and embedding cost are not justified
  by the per-turn use case).
- No frontend changes.

## 3. Architecture

### 3.1 The store — `TurnMemory`, the turn's process log

```rust
// src-tauri/src/logic/agent.rs  (litert-gated, pure)

const ARTIFACT_EXCERPT_CHARS: usize = 2_400; // inline excerpt in the handle response
const ARTIFACT_PAGE_CHARS: usize    = 3_600; // per artifact_recall response
const CLOUD_CLOSE_MIN_CHARS: usize  = 6_000; // log payload needed to trigger the cloud close

struct TurnArtifact {
    handle: String,   // "mem1", "mem2", … sequential, mirrors the docN alias style
    tool: String,
    args_key: String, // canonical (tool, resolved-args) string — dedup key, exact compare
    content: String,  // full body, already capped at TOOL_RESULT_MATERIALS_CHARS
}

#[derive(Default)]
struct TurnMemory { artifacts: Vec<TurnArtifact> }

impl TurnMemory {
    /// Append one completed process (every dispatch: tools, recall pages,
    /// subagent receipts). Same tool + same resolved args returns the
    /// existing handle — the log grows per DISTINCT step, never per repeat.
    fn record(&mut self, tool: &str, args_key: &str, content: String) -> &str;
    /// Model-facing digest row for the chain block: "mem1 office_read_document 61_234 chars".
    fn digest_line(&self, handle: &str) -> String;
    /// The whole chain as a compact block (valid handles + chars) — fed on
    /// budget exhaustion so the model closes the turn knowing what it did.
    fn chain_digest(&self) -> String;
    /// Paged slice for artifact_recall: (page_text, next_offset: Option<usize>).
    fn page(&self, handle: &str, offset: usize) -> Result<(String, Option<usize>), String>;
    /// Join the log into the cloud-materials package ("--- tool ---" bodies,
    /// capped at TOOL_RESULT_MATERIALS_CHARS) — rendered on demand.
    fn materials(&self) -> String;
    /// Total stored content chars — the cloud-close trigger metric.
    fn total_content_chars(&self) -> usize;
}
```

Design notes:

- **Append-always**: every completed process appends, regardless of size.
  Small results cost nothing to store, and a complete log is what makes
  `materials()` and `chain_digest()` faithful — the log IS the turn's process
  chain, not a cache of overflows. Inline-vs-handle (§3.2) only decides what
  ALSO enters local K/V.
- **No `Arc<Mutex<…>>`**: the loop intercepts `artifact_recall` before rig
  dispatch, so the log is only touched inside the single stream — it stays a
  plain local `let mut memory = TurnMemory::default();` replacing
  `turn_tool_results` (agent.rs:1306).
- **Handles are `memN`**: short, sequential, model-friendly — same rationale as
  the `docN` store-id aliases (agent.rs:371) which already prove the model
  round-trips opaque handles reliably.
- **Dedup is exact**: the key is the full `(tool, resolved-args)` string, not a
  hash — no collision class at all. Re-calling the same tool with the same args
  in one turn returns the existing handle and does not grow the log.
- **The log never re-enters K/V wholesale**: the model touches it only through
  (a) each step's inline result, (b) the `chain_digest()` block on budget
  exhaustion, (c) `artifact_recall` pages.

### 3.2 The write path — dispatch arm change

Today (agent.rs:2005-2023): `materials_body` (≤ 32k) accumulates into
`turn_tool_results`; `model_body` is the ≤ 4k truncation fed back as
`response:<tool>:`.

Change, in the same block:

```text
memory.record(tool, args_key, body.clone())   // ALWAYS — append to the process log

model_body =
    if body.chars().count() > TOOL_RESULT_MODEL_CHARS:
        format!("{{\"handle\": \"{handle}\", \"chars\": {n}, \"excerpt\": \"{first 2400 chars}\"}}\n\
                 Full output stored for this turn. To read more, call artifact_recall \
                 with {{\"handle\": \"{handle}\", \"offset\": <char offset>}}.")
    else:
        body                                     // unchanged inline path
```

- `turn_tool_results` (agent.rs:1306, 2020) is DELETED — `memory.materials()`
  renders the same package (same `--- tool ---` separators, same 32k cap) from
  the log at delegation time. One store, one source of truth.
- The old `[output truncated — narrow the query…]` note is replaced by the
  handle response — the model's escape hatch upgrades from "guess narrower
  args" to "page the exact bytes you already paid for".
- **UI echo unchanged**: `AgentChatEvent::ToolResult` keeps its ≤ 500-char
  summary of the raw body; the frontend never learns handles.

### 3.3 The read path — `artifact_recall`, intercepted like the subagents

Precedent: `deep_write`/`draft_document` are registered as `PortableTool`
stubs (their `call` bodies are unreachable errors — they exist so the compact
manifest renders them, agent.rs:495-496) and special-cased in the loop before
`toolset.execute`. `artifact_recall` copies the pattern:

1. **Stub registration** — `ArtifactRecall` `PortableTool` (name
   `artifact_recall`, args `handle: string, required — memN handle from a
   stored tool result`; `offset: integer, optional — char offset, default 0`),
   added in `toolset_for` to every agent's toolset (office, binance, any future
   one). Its `call` returns an "internal dispatch" error, exactly like
   `DeepWrite::call`. The manifest entry materializes automatically through
   `build_prompt` → `get_tool_definitions()` (agent.rs:650-666) at ~140 chars.
2. **Loop interception** — in the dispatch arm, *before* `set.execute`:
   if `tool == "artifact_recall"`, parse args, `memory.page(handle, offset)`,
   emit `ToolCall`/`ToolResult` events, feed the page back as
   `response:artifact_recall: <page>\n(chars X..Y of N; next offset: Z)`,
   append the page to `turn_tool_results`, `calls_used += 1`, `continue`.
3. **Errors teach the protocol**: unknown handle → list valid handles + chars;
   `offset ≥ chars` → reply with the valid range. Error bodies are prompts, not
   failures (house style — same as the tool-budget and unknown-tool messages).

Recall pages count toward `MAX_TOOL_CALLS` — the model that pages forever
still terminates at the budget, and the budget-exhausted message already
forces a final answer.

### 3.4 End-of-turn cloud close — `RemoteLlm` prepares the user response

When the turn gathered real payload, local composed its understanding from
excerpts (≤ 4k per result) while the full text lives in the log. The close
hands synthesis to the tier that can hold it — through the seam that already
exists:

- **Seam**: `RemoteLlm::stream(system, task, materials)` (remote.rs:341) —
  stateless, one streaming completion, `materials` capped server-side at 24k
  (remote.rs:48). `system` = the existing `DEEP_WRITE_SYSTEM` writer persona;
  `task` = the brief the local model writes (it is the only side that has seen
  the conversation); `materials` = `memory.materials()`.
- **Insertion point — prompt-forced, never post-hoc**: the local final answer
  streams to the user as it generates and `AgentChatEvent` has no
  replace/rewrite semantics — a cloud rewrite after a streamed local answer
  would double-print. So the trigger is deterministic and lives in the
  tool-result feedback prompt: when the close condition holds, the `Continue.`
  suffix is replaced with "you have gathered substantial materials — deliver
  the final answer via deep_write with a task brief; do NOT answer inline".
  The model replies `call:deep_write{…}` and the existing delegation path
  streams the answer (already final-answer semantics: tokens → user,
  persisted as the assistant message, `turn_log` outcome `answer`).

**Close condition** (all must hold, checked before building each feedback
prompt):

```text
remote.is_some()                        // vault keys configured
&& memory.total_content_chars() >= CLOUD_CLOSE_MIN_CHARS   // default 6k —
                                        // a couple of real reads; trivial turns
                                        // (office_list_files etc.) stay local+free
&& subagent_calls_used == 0             // the one cloud call per turn budget
                                        // (MAX_SUBAGENT_CALLS = 1)
```

- **Budget-exhausted variant**: when `MAX_TOOL_CALLS` fires and the condition
  holds, the exhaustion prompt ALSO offers the delegation (subagent budget is
  separate from the tool budget) plus `memory.chain_digest()` — a model that
  paged itself out of tools still closes from the full materials.
- **Fallbacks**: no vault keys ⇒ the instruction never appears and the model
  answers from excerpts + recall (§3.2/3.3) — identical to the pre-close
  design. Mid-turn `deep_write`/`draft_document` already used ⇒ condition's
  third clause fails ⇒ local closes. A model that ignores the instruction and
  answers inline: the turn still succeeds — the nudge is not a hard gate
  (rejecting local answers would need heuristics worse than the problem).
- **`remote.rs` is reused as-is** — no protocol, cap, failover, or timeout
  changes. The close only changes the trigger (deterministic condition instead
  of model discretion) and the materials source (the memory log).

### 3.5 What enters each context (budget table)

| Context | Before | After |
|---|---|---|
| Local K/V, per tool result | ≤ 4k truncated, tail lost | ≤ ~2.7k handle+excerpt (common case: one page is enough) or ≤ 3.7k recall page, tail recoverable |
| Local K/V, total per turn | ≤ 8 × 4k = 32k | ≤ 8 × ~3.7k ≈ 30k (slightly tighter; excerpt is smaller than the old truncation) |
| Cloud `materials` | ≤ 32k full bodies | same shape + cap, rendered from the memory log (`materials()`) |
| Final answer, tool-heavy turn | local, built from 4k excerpts | cloud close: `RemoteLlm` synthesizes from the full ≤ 32k log (when vault configured) |
| Manifest | per-agent tool list | + ~140 chars (one tool) |
| RAM, per turn | — | ≤ 8 × 32k chars ≈ 1 MB worst case |

## 4. Implementation plan

### Phase 1 — `TurnMemory` + tests (pure addition, no behavior change)

- Add the `TurnMemory` / `TurnArtifact` types and fns (`record`, `digest_line`,
  `chain_digest`, `page`, `materials`, `total_content_chars`) plus the three
  constants in `agent.rs` (litert-gated, next to the other loop constants at
  agent.rs:66-120).
- Unit tests in the existing `mod tests`: record dedup (same tool+args → same
  handle, different args → new), page boundaries (offset 0, mid, last partial
  page, `offset ≥ chars` error), materials rendering (separators + 32k cap),
  chain-digest format.

### Phase 2 — wire the loop

1. `let mut memory = TurnMemory::default();` replacing `turn_tool_results`
   (agent.rs:1306).
2. Dispatch arm (agent.rs:2005-2023): `record()` every result, then
   store-or-inline per §3.2; delete the `turn_tool_results.push_str` line
   (agent.rs:2020). Build `args_key` from the already alias-resolved
   `exec_args` string (agent.rs:1957).
3. `ArtifactRecall` stub `PortableTool` + `toolset_for` registration for every
   agent arm (agent.rs — the `toolset_for` fn).
4. Loop interception for `artifact_recall` before `set.execute` (§3.3):
   emit events, page, feed back, count the call, `record()` the page.
5. Unit tests: interception parse (valid args, missing handle, bogus offset)
   mirroring the existing `parse` tests for the call protocol.

### Phase 3 — end-of-turn cloud close

1. Close condition helper (remote present + `total_content_chars()` ≥
   `CLOUD_CLOSE_MIN_CHARS` + `subagent_calls_used == 0`) + the feedback-prompt
   variant directing the model to `deep_write` (§3.4).
2. Budget-exhausted prompt variant: delegation offer + `chain_digest()` when
   the condition holds.
3. Mid-turn delegation arms switch their materials source to
   `memory.materials()` (the `turn_tool_results` reads at agent.rs:1819-1887).
4. Unit tests: condition matrix (no remote / under threshold / subagent used /
   all-true), prompt-variant content.
5. Manual: `chat_route_check` + `agent_smoke` examples on a vault build — a
   summarization turn must close via `deep_write` (turn_log `outcome=answer`,
   `tool=deep_write`); a trivial `office_list_files` turn must stay local.

### Phase 4 — calibration + verification

- `cargo run --example agent_eval --features litert,office` — must stay
  **20/20** (the office scenarios exercise `office_read_document` +
  `knowledge_search`; the handle path and close condition must not regress
  them).
- `cargo run --example turn_log_report --features litert,office` — compare
  tool-call counts and close outcomes pre/post: recall round-trips only where
  the old path produced truncated reads; cloud closes only on turns with real
  payload.
- Full check matrix (below).

## 5. Testing

| Layer | Test | Gate |
|---|---|---|
| Unit | `TurnMemory` record/dedup/page/materials/digest (phase 1) | `cargo test --features litert,office --lib` |
| Unit | recall-args parse + error-body teaching (phase 2) | same |
| Unit | close-condition matrix + prompt variants (phase 3) | same |
| Behavioral | summarization turn closes via cloud on a vault build; trivial turns stay local | `chat_route_check` / `agent_smoke` manual + `turn_log` outcome audit |
| Regression | `agent_eval` 20 office scenarios | 20/20, unchanged |
| Regression | `local_llm_smoke`, `remote_smoke`, `draft_smoke` | CI smoke jobs green |
| Calibration | `turn_log_report` before/after | no call-count blowup; recall calls only after oversized reads; cloud closes only on real payload |
| Static | checks below | all green |

```sh
bun run build                        # no frontend change expected — still run it
cargo check                          # axum must NOT compile here
cargo check --features web
cargo check --features litert,office
cargo check --features litert,binance
cargo test --features litert,office --lib
# shared-code change ⇒ mobile checks apply:
cargo ndk -t arm64-v8a -P 24 check
cargo check --target aarch64-apple-ios
```

## 6. Risks and mitigations

- **Cloud spend per tool-heavy turn**: the close fires once per qualifying
  turn; `CLOUD_CLOSE_MIN_CHARS` (6k) keeps trivial turns free, every close is
  visible in `turn_log` (`tool=deep_write`) for calibration, and raising the
  threshold keeps more turns local.
- **Model ignores the close instruction** (answers inline anyway): the turn
  still succeeds — the local answer is exactly the pre-close fallback. The
  instruction is a nudge, not a hard gate; gating would require rejecting
  local answers, whose heuristics are worse than the problem.
- **Latency**: a cloud close adds one streaming completion (failover-capped by
  `REMOTE_TIMEOUT_SECS = 600`) to turns that already ran multiple tools;
  tokens stream live so perceived latency is the time-to-first-token of the
  cloud writer.
- **Small model confuses handle indirection** (forgets the handle, calls the
  tool again): dedup makes the re-call return the same handle + fresh excerpt —
  the failure mode degrades to today's behavior, never worse. Error bodies
  enumerate valid handles to re-teach cheaply.
- **Recall pages eat the tool budget** (`MAX_TOOL_CALLS = 8`): the 2.4k excerpt
  covers the majority of single-page needs (the old path gave 4k once and
  lost the rest); pathological paging terminates at the budget with the
  existing force-answer message. Calibration in phase 3 watches the
  call-count distribution.
- **Per-turn K/V slightly tighter** (2.4k excerpt vs 4k truncation): recovered
  by recallability; if calibration shows models routinely needing page 1,
  raise `ARTIFACT_EXCERPT_CHARS` to 3.2k (still under the 4k cap with the
  wrapper) — one constant.
- **Manifest growth**: one ~140-char entry; `build_prompt`'s compact renderer
  keeps it negligible vs the existing toolset manifest.

## 7. Alternatives considered (rejected)

- **Post-hoc cloud rewrite**: let local answer, then have the cloud rewrite it
  from the full log. Rejected — the local answer streams to the user as it
  generates and `AgentChatEvent` has no replace semantics; the rewrite would
  double-print. The prompt-forced close (§3.4) is the only insertion point
  that avoids streaming both.
- **Always cloud-close every turn**: burns a call + latency even for chatty
  no-tool turns. Rejected via `CLOUD_CLOSE_MIN_CHARS` — only turns that
  actually gathered payload pay.
- **Cloud-summarize on overflow** (ask a vault provider to digest each 60k
  body): adds latency + spend to the common path, and makes tool results
  depend on vault availability. Deterministic excerpts are free and offline;
  the cloud close already gives the cloud the full text.
- **Persist artifacts in SQLite (session-scoped table)**: schema + eviction +
  privacy surface, and every cross-turn need is already served (office store,
  `messages` transcript, web LRU, deterministic re-runs). Revisit only if
  re-execution cost shows up in `turn_log` calibration.
- **Index ephemeral outputs into the RAG pipeline**: unifies with knowledge
  ingestion but pays embedder latency + chunk storage per oversized result for
  a need (this turn's tail) that exact paging serves better.
- **Raise `TOOL_RESULT_MODEL_CHARS`**: burns K/V permanently for every
  oversized call — the original problem, amplified.
