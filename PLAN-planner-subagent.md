# Implementation Plan — Planner subagent: cloud high-thinking planning, local execution (kawai)

Status: **PROPOSED (2026-08-28)** — not started. Extends the hybrid subagent
rail (`PLAN-hybrid-llm-subagents.md`, shipped) with a third output mode: a
**planner**. Cloud reasoning models decompose a heavy task into an explicit
step plan; local Gemma 4 executes it step-by-step with the tools it already
has. Decision context (2026-08-28): Gemma 4's prompt-based tool calling is
reliable for short structured output but degrades on long-horizon planning —
step ordering, done-criteria, and fallbacks for multi-tool workflows come out
mushed and untracked. A cloud reasoning pass produces that skeleton once per
task, cheaply, and local follows it.

This rides the existing rail end-to-end: same pool (`crates/foundation/remote-llm`,
health-aware failover zai → … → empero), same dispatch (`SubagentHandler` via
`kind_for_capability`), same streaming machinery (`run_pending_subagent`),
same persistence (`TurnMemory` → `session_artifacts`), same telemetry
(`turn_log`). **No new transport op, no new event variant, no schema change.**

---

## 1. Core concept

> **Planner = a subagent whose output is the operating instructions for the
> local loop.** The user asks a multi-step question; local delegates the
> *decomposition* to a cloud reasoning model, then executes the returned steps
> itself with plain tools. Cloud plans; local acts.

```
user task (heavy / multi-tool)
  → local emits plan_task fence (persona rule: ≥3 tool steps, cross-tool workflow)
      → PlanHandler → remote-llm pool (reasoning tier, thinking streams to UI
        via the existing SubagentThinking event — zero new plumbing)
      → compact structured plan (capped 4k chars)
          step 1: tool + args sketch + done-criteria
          step 2: …
      → parsed in Rust (one correction round, draft_document pattern)
      → recorded as a TurnMemory artifact (survives epoch breaks)
      → re-enters local's context as the loop's operating script
  → local executes step-by-step:
      each tool result is checked against the step's done-criteria
      (the plan text in context + evidence_digest handles keep it on rails)
  → step deviates / fails → plan_revise (ONE revision call, same handler)
  → long-form final answer → deep_write / draft_document as today
  → vault empty → plan_task never registered → local self-plans (current behavior)
```

Division of labor:

| Work | Executor | Why |
|---|---|---|
| Multi-step decomposition, ordering, done-criteria, fallbacks | **cloud planner** (reasoning tier) | The weak spot of E4B-class models; reasoning models excel |
| Executing each step (tool choice, arg fill-in from real tool results) | **local** | Per-step decisions are short structured output — local's strength |
| Judging "did this step complete?" | **local**, against the plan's done-criteria | The criterion is one line in context; the judgment is compression |
| Long-form synthesis | **deep_write / draft_document** (unchanged) | Already shipped; planner composes with them, not replaces |

**One new output mode, narrowly carved.** The hybrid plan's hard rule "long
text must never re-enter local's loop context" stands. The planner's output
is the single sanctioned exception because it is compact by construction —
`PLAN_MAX_CHARS` (4 000) is enforced in Rust before anything re-enters the
loop, the same cap as `TOOL_RESULT_MODEL_CHARS`. A plan that overruns the cap
is a malformed plan (one correction round → tool error → local self-plans).

### Why a subagent and not the alternatives

| Alternative | Rejected because |
|---|---|
| Rust-side task classifier gates planning | "Rust code second-guesses what only the model knows" (hybrid plan decision log); routing must stay free and in the model's tool choice |
| Plan inside `agent_chat` pre-turn (transport edge) | Business logic in the wrapper; violates invariant 2; can't see tools/memory |
| Cloud orchestrates the whole task (plan AND execute) | Re-introduces separation; full tool results would leave the device; local stays orchestrator per the shipped architecture |
| Local self-plans with a better persona prompt | Tried implicitly — prompt text cannot give E4B reasoning depth; this is exactly the work cloud is for |

---

## 2. Goals / Non-goals

**Goals**

1. Heavy multi-tool turns get an explicit, persisted, revisable plan authored
   by a cloud reasoning model; local executes it within the existing
   fence-tool loop and `MAX_TOOL_CALLS` budget.
2. Zero new UX surface in v1: planning thinking streams through the existing
   `SubagentThinking` display; the plan lands as a tool-result card; no new
   event variants, no toggles, no settings.
3. Zero-cost degradation: no vault key ⇒ `RemoteLlm::from_env() → None` ⇒
   `plan_task` is not registered on any agent ⇒ behavior identical to today.
4. All budgets explicit and code-enforced: plan calls have their own per-turn
   budget, separate from the synthesis (`MAX_SUBAGENT_CALLS = 1`) budget.
5. The plan survives epoch breaks / prefill resets via `TurnMemory`
   (`evidence_digest` handles + `artifact_recall`), so a long execution
   doesn't strand the script.

**Non-goals (v1)**

- No user-facing plan editor / approval step (a `PlanCard` UI is a later
  option once the loop proves out; the plan is visible in the tool card).
- No parallel subagent fan-out, no per-step cloud execution. Steps run on
  local tools; only decomposition and (one) revision touch the cloud.
- No heuristic pre-classification of "is this task heavy". v1 gates on the
  persona rule (the model decides to call `plan_task`); calibrate from
  `turn_log` before adding any Rust-side gate.
- No planning persistence across turns (plan is per-task/turn-scoped; it
  happens to survive within the session via artifacts, but a new user message
  means a new decision).

---

## 3. Contract

### Tool surface (model-facing)

```jsonc
// plan_task — registered wherever the agent already carries deep_write
// (i.e. every tool-carrying agent when the remote tier is on), PLUS a
// persona rule. Identity (user_id, session_id) stays bound server-side.
{
  "task": "Build a Q3 revenue report from the uploaded xlsx, chart it, and save as docx"
}
// output fed back into local's loop (compact, ≤ PLAN_MAX_CHARS):
{
  "handle": "mem7",                  // TurnMemory artifact — recallable
  "steps": 4,
  "plan": [
    { "id": 1, "tool": "data_import | knowledge_search | …", "goal": "…", "done_when": "…" },
    { "id": 2, "tool": "data_chart", "goal": "…", "done_when": "…",
      "fallback": "if chart fails, export table instead" },
    …
  ]
}
```

- **`task`** is written by local (the specific brief), like every subagent.
- The plan JSON is **validated in Rust** (`extract_plan_steps`): numbered
  steps, each with `goal` + `done_when`, optional `fallback`; one correction
  round with the parse error appended (the `draft_document` repair pattern);
  then a normal tool error — local proceeds without a plan, the turn never
  dies.
- On success the raw plan text is `state.memory.record("plan_task", args_key,
  plan_text)` — persistence to `session_artifacts` rides the existing
  `flush_new_artifacts`, and the `evidence_digest` keeps the handle alive
  across epoch breaks.

### Handler shape

`SubagentKind::Planner` + `PlannerHandler` in `crates/engines/agent/src/subagents.rs`,
selected via the existing `kind_for_capability(AgentCapability::Planner)`.

The `machine_payload() -> bool` flag grows into an explicit mode enum — two
subagents already made it binary; a third mode breaks the boolean:

```rust
enum SubagentOutputMode {
    /// Stream tokens to the user as they arrive; `final: true` passthrough.
    FinalPassthrough,      // deep_write
    /// Accumulate silently (machine payload), post-process in Rust.
    MachineFile,           // draft_document
    /// Accumulate silently, validate, then feed the COMPACT result back
    /// into the loop as operating context + record as artifact.
    CompactContext,        // plan_task  (NEW)
}
```

The planner is **never** `FinalPassthrough` — the plan is not the user's
answer. Its UI visibility in v1: `SubagentThinking` (already streams) during
generation + one `ToolResult` card whose `summary` is the compact step list
(`TOOL_RESULT_UI_CHARS`-capped) and whose `data` carries the plan JSON
(`TOOL_RESULT_DATA_CHARS`-capped) so the card can render all steps.

### Persona (cloud side)

`PLAN_SYSTEM` — reasoning-tier persona: decompose the task into the MINIMUM
number of concrete steps; every step names the concrete tool from the
provided catalog (tools not in the catalog are forbidden), a one-line goal,
and a testable done-criterion; include a fallback only where a step can
realistically fail; output ONLY the plan JSON, no prose. Input: task +
a compact tool-catalog digest (rendered from the agent's registered tools,
NOT the full manifests) + relevant `TurnMemory.materials` head.

### Persona (local side)

`PLANNER_RULE` injected with the same mechanism as `DEEP_WRITE_RULE`:
"Before a task that needs 3+ tool calls or chains 2+ different tools, call
`plan_task` once with the task brief. Follow the returned steps in order;
after each tool result, check its done-criterion before moving on. If a step
fails or the situation contradicts the plan, call `plan_revise` (once) with
what changed. Simple tasks: never plan — answer or act directly."

---

## 4. Budgets (the one real architectural decision)

Today `MAX_SUBAGENT_CALLS = 1` per turn is shared by all subagent tools. The
planner breaks that arithmetic: a planned heavy turn plausibly wants
**plan + revise + deep_write** = 3 cloud calls. Fold them into one budget and
the planner starves synthesis; leave it at 1 and the planner can't exist.

Decision: **split the budget by phase, not by tool.**

```rust
pub const MAX_PLAN_CALLS: usize = 2;      // 1 initial + 1 revise, per turn
pub const PLAN_REVISIONS: usize = 1;      // max revise calls (≤ MAX_PLAN_CALLS - 1)
pub const MAX_SUBAGENT_CALLS: usize = 1;  // UNCHANGED — synthesis only
pub const PLAN_MAX_CHARS: usize = 4_000;  // re-entry cap (= TOOL_RESULT_MODEL_CHARS)
pub const PLAN_TOOL: &str = "plan_task";
pub const PLAN_REVISE_TOOL: &str = "plan_revise";
```

- `run_pending_subagent` gains a phase check: `kind == Planner` decrements
  the plan budget; synthesis kinds decrement the synthesis budget. The two
  budgets never borrow from each other — worst case per heavy turn is 3 cloud
  calls, each individually capped and logged.
- `plan_revise` is the same handler with the current plan + the deviation
  appended to `task` ("STEP 3 FAILED: …; remaining goal: …; return the
  revised remaining steps"). It replaces the plan artifact (`record` dedup
  won't apply — different `args_key` by design) and resets the step pointer.
- Cost ceiling stays bounded and visible in `turn_log` (`tool` =
  `plan_task`/`plan_revise`, `outcome` = `"plan"`/`"plan_revise"`).

---

## 5. Loop integration (`crates/engines/agent/`)

The loop skeleton, `MAX_TOOL_CALLS`, repairs, overflow recovery — unchanged.
Additions:

1. **Registration** (`toolset_for` path): `plan_task` joins every toolset
   that gets `deep_write` (remote tier on). The manifest protocol picks it up
   automatically.
2. **Dispatch**: the existing fence parser routes `plan_task`/`plan_revise`
   into `state.pending_subagent` with `kind: Planner` (parse site where
   `deep_write` is intercepted).
3. **Post-processing** in `run_pending_subagent` (new `CompactContext` arm):
   validate → record artifact → build the compact JSON → set
   `state.prompt = "response:plan_task:\n<plan>\n\nExecute the steps in
   order. After each tool result, verify its done-criterion. NO call: line
   for planning."` → `Continue` (never `Finished`).
4. **Step pointer** (`TurnState`): `plan_step: Option<usize>` — advanced by
   the per-step prompt scaffold so each subsequent prompt opens with
   `PLAN step 2/4: <goal> (done_when: …)` before the transcript. This is
   guidance text, not enforcement — local still chooses fences, and
   `MAX_TOOL_CALLS` still bounds the whole execution.
5. **Deviation → revise**: when local emits `plan_revise` (persona rule) or a
   tool errors twice on the current step, the revision call fires under the
   plan budget. Beyond the budget: the teaching-message pattern ("planning
   budget used — continue with what you have"), never a hard turn failure.
6. **Escalation unchanged**: malformed-fence ×2 escalation and prefill-overflow
   recovery behave exactly as shipped; the planner is orthogonal to both.

---

## 6. Telemetry

No schema change — `turn_log` already carries everything:

- `tool = 'plan_task' | 'plan_revise'`, `outcome = 'plan' | 'plan_revise'`,
  provider/usage/latency as with all cloud calls.
- New `examples/turn_log_report` lens (Phase 3): plan rate per agent,
  plan→success rate (did planned turns error less?), average steps, revise
  frequency, and **over-planning** (plan_task on turns that ended in ≤1 tool
  call — the metric that says the persona rule is too eager).

---

## 7. Implementation phases

### Phase 1 — vertical slice (plan produced, followed, logged)

1. `agent-contract`: `AgentCapability::Planner` (+ capability-id string in
   the mapping used by `capabilities_map_to_runtime_capability_ids`).
2. `subagents.rs`: `SubagentKind::Planner`, `PlannerHandler`, `PLAN_SYSTEM`,
   `SubagentOutputMode` refactor (replaces `machine_payload`), capability arm,
   handler test (mirror `capability_kinds_select_the_expected_handlers`).
3. `extract_plan_steps` (parsing.rs or subagents.rs): JSON validation + cap +
   one correction round; unit tests for: valid plan, prose-wrapped JSON,
   oversized plan, missing done_when, empty steps.
4. `run_pending_subagent`: `CompactContext` arm + plan budget split.
5. Constants in BOTH copies (`crates/engines/agent/src/constants.rs` +
   `src-tauri/src/logic/agent/constants.rs` — they duplicate today by design).
6. `PLANNER_RULE` into the persona path where `DEEP_WRITE_RULE` lands;
   `plan_task` registered in `toolset_for` next to `deep_write`.
7. Verify: `bun run build` (frontend untouched), `cargo check`,
   `--features web`, `--features litert`, `--features litert,office`,
   `--features analytics`, mobile checks (shared `logic/` touched),
   `cargo test --features litert,office --lib`.
8. Manual smoke (`remote_smoke` pattern): heavy analytics prompt → thinking
   streams → plan card → steps executed → `turn_log` rows. Keyless run →
   no `plan_task` in any manifest, zero behavior change.

### Phase 2 — closed loop (revise + step scaffold)

1. `TurnState.plan_step` pointer + per-step prompt scaffold.
2. `plan_revise` tool + budget enforcement + teaching messages on exhaustion.
3. Epoch-break drill: plan → force prefill overflow (long tool results) →
   plan survives via artifact + `evidence_digest`; execution resumes.
4. `agent_eval` additions (H1-style gate): 3–5 multi-step tasks scored
   plan-vs-no-plan (task completion + total tool calls + wall time).

### Phase 3 — calibration (gated on real usage, like the hybrid plan)

1. `turn_log_report` planner lens (§6).
2. Persona tuning from data: plan-rate per agent, over-planning rate.
3. Only if data demands: heuristic offer-gating (e.g. suppress `plan_task`
   on tool-less agents) — still manifest-level, never a Rust classifier.
4. Optional `PlanCard` UI rendering the steps + live checkmarks (needs one
   new event variant or ToolResult data convention — design then).

---

## 8. Risks & mitigations

| Risk | Reality | Mitigation |
|---|---|---|
| Over-planning (cloud call for "what's 2+2") | The core waste risk; silent cost | Persona rule + `turn_log` over-planning lens; cap is 2 plan calls/turn, worst case bounded |
| Local ignores the plan mid-execution | E4B drift is exactly the failure being fixed | Step-scaffold prompts (§5.4), done-criteria in every step line, revise path when drift is detected |
| Stale plan after tool surprises | Plans meet reality and lose | `plan_revise` (1/turn) + fallback lines per step; revise replaces the artifact, loop continues |
| Plan bloats K/V context | A 4k plan + 8-step transcript is real pressure | `PLAN_MAX_CHARS` enforced in Rust; plan is ONE artifact (not re-fed whole per turn — the scaffold re-feeds one step); epoch-break recovery already exists |
| Double/triple cloud spend per heavy turn | plan + revise + deep_write = 3 calls | Phase-split budgets (§4), every call logged with usage; total is still ≪ an all-cloud turn |
| Planner hallucinates tools not on the agent | Reasoning models invent plausible tool names | `PLAN_SYSTEM` forbids non-catalog tools; validation rejects unknown tool names against the registered set (cheap, deterministic) |
| Latency before first action | Reasoning models think for tens of seconds | Thinking already streams to the user (`SubagentThinking`) — the wait is visible work, not a hang |
| Third output mode erodes the "no long text into the loop" rule | slippery slope | The mode is `CompactContext` with a hard Rust-enforced cap; the plan doc records the boundary explicitly (§1) |

---

## 9. Verification checklist (per phase)

- `bun run build`; `cargo check` (axum must NOT compile in);
  `cargo check --features web`; `--features litert`; `--features litert,office`;
  `--features litert,analytics`; mobile: `cargo ndk -t arm64-v8a -P 24 check`,
  `cargo check --target aarch64-apple-ios`.
- Behavioral with key: heavy multi-tool prompt → `SubagentThinking` streams →
  plan tool-result card → steps execute within `MAX_TOOL_CALLS` → `turn_log`
  plan rows. Keyless: manifests identical to today, zero new tools.
- Behavioral deviation: force a step-1 tool failure → revise call fires once →
  revised plan artifact replaces the old → execution continues.
- Budget check: second `plan_task` in one turn → teaching message, no cloud
  call. Plan + `deep_write` in one turn → both budgets decremented correctly.
- Invariant spot-checks: no transport types in the new code; identity still
  server-bound; no event-union change in v1 (if Phase 3 adds one: regenerate
  TS + update BOTH matchers per AGENTS.md #7).

## 10. File-level change map

```
crates/foundation/agent-contract/src/lib.rs   ADD  AgentCapability::Planner (+ id mapping)
crates/engines/agent/src/subagents.rs         ADD  SubagentKind::Planner, PlannerHandler, PLAN_SYSTEM,
                                                   SubagentOutputMode (replaces machine_payload),
                                                   extract_plan_steps, capability/handler arms + tests
crates/engines/agent/src/constants.rs         ADD  PLAN_TOOL, PLAN_REVISE_TOOL, MAX_PLAN_CALLS,
                                                   PLAN_REVISIONS, PLAN_MAX_CHARS
src-tauri/src/logic/agent/constants.rs        ADD  same (kept in sync — dual-copy layout)
crates/engines/agent/src/runtime.rs           ADD  TurnState: plan_calls_used, plan_revisions_used, plan_step
crates/engines/agent/src/dispatch.rs          ADD  pending_subagent routing for plan tools; scaffold prompt
crates/engines/agent/src/lib.rs               (touch only where toolsets/persona rules assemble)
crates/engines/agent/src/parsing.rs           OPT  extract_plan_steps lives here if subagents.rs is crowded
src-tauri/src/agent_registry.rs               OPT  PLANNER_RULE resolver wiring per agent definition
src-tauri/examples/turn_log_report.rs         ADD  planner lens (Phase 3)
src-tauri/examples/agent_eval.rs              ADD  plan-vs-no-plan tasks (Phase 2/3)
```

No changes: `commands.rs`, `web.rs`, `crates/foundation/events` (v1),
`kawai-db` schema, frontend (v1), `crates/foundation/remote-llm` (the pool
already streams `Reasoning`; nothing to add).
