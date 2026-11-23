# PLAN-neurosploit.md — in-process NeuroSploit harness on kawai (path B)

Decision: vendor the NeuroSploit Rust harness **in-process** (lonkero precedent) and
expose it as one confirmation-gated deep-audit agent tool beside the fast lonkero
scan lane. Desktop-only MVP; kawai-web and Android runtime stay out (see §9).

Upstream: JoasASantos/NeuroSploit, MIT, v4.4.3 (`neurosploit-rs/`: `crates/harness`
lib ~53k LOC + `app/` CLI). Harness drives its own OpenAI-compatible LLM pool —
kawai's local Gemma 4 cannot drive it; every run is remote-LLM spend, metered to
the usage ledger (§7).

Integration surface (verified against the vendored copy, file:line in
`NeuroSploit/neurosploit-rs/`):

- Entry: `pipeline::run(cfg: RunConfig, lib: &Library, pool: &ModelPool, tx: Sender<String>) -> RunOutput`
  (`pipeline.rs:1600`). Web black-box only for MVP (`run_whitebox` et al. are later lanes).
- `RunConfig::new(target)` + defaults (`types.rs:387`); only `target` + `models`
  (`"provider:model"`) are required; `cfg.workdir` sets the output dir;
  `cfg.budget` = token budget (`Budget::with_mode` presets: eco 120k / balanced
  250k / aggressive 800k, `budget.rs:215`).
- **No whole-run wall-clock exists** — kawai must wrap the future in its own
  `tokio::time::timeout` backstop. Safe: state is persisted incrementally
  (`run_snapshot.json`, salvage, `resilience.rs:580`) and a re-run with the same
  `workdir` resumes (skips completed agents, `pipeline.rs:2183-2241`).
- `tx` carries plain text progress lines (`notify: …`, `▶/✓/✗/⚠ …`,
  `@<agent> ai: <snippet>`) — lossy/try_send is fine; forward as stream progress.
- Core web black-box run needs **zero external binaries** in API-key mode
  (browser prefetch degrades, recon tools are `which`-gated, typst optional).
- Core futures are `Send` (no Rc/RefCell/thread_local; the upstream CLI itself
  `tokio::spawn`s them) — no dedicated-thread shim needed, unlike lonkero.
- Findings: `RunOutput.findings: Vec<Finding>`; `findings.json` = bare array
  (`pipeline.rs:5062`); `report.json` carries `{summary{confirmed,needs_review,total}, confirmed[], needs_review[]}`
  (`report.rs:872`). Metering: per-call usage parsed into a **global** ledger
  (`usage.rs:17-66`, `snapshot()`/`total()`, per-agent labels) — see §7.
- State written outside the run dir: CWD-relative `.neurospilot/cache/llm` LLM
  cache (on by default, TTL 7d) + `.neurospilot/recon_cache/<host>.json`
  (`cache.rs:55`, `pipeline.rs:6277`) — must be redirected per user (§3 P4).

## 1. Position in the product

- Agent: **`builtin.security` keeps one agent.** The deep-audit tool joins
  `security_tools::registry::all_tools()` (composed at
  `src-tauri/src/agent_registry.rs:366`); the persona already carries the
  authorized-targets directive. No new catalog agent in MVP.
- Semantics: lonkero = fast deterministic scan (240 s budget, auto-approved);
  NeuroSploit = autonomous multi-model engagement (minutes-to-hours, many LLM
  calls, active exploitation) → **confirmation-gated** (`requires_confirmation = true`)
  with the cost ceiling quoted in the confirmation prompt.
- MVP scope: `neurosploit_audit` (web black-box) only. Whitebox/host/mobile/
  container lanes are parked.

## 2. Vendor layout

- **Fork required** (repo convention: every vendored dep is a submodule pinned
  to a remotely-fetchable commit — lonkero is a gitlink inside the `crates`
  repo → `yudaprama/lonkero` with patch commits; pdf_oxide/office_oxide/
  LiteRT-LM are all `yudaprama/*` forks). Fork `JoasASantos/NeuroSploit` →
  `yudaprama/NeuroSploit` (private is fine — CI fetches private submodules via
  the PAT insteadOf rewrite), carry the patch series on branch `kawai/core`.
- Submodule at **`crates/NeuroSploit/`** (inside the `crates` submodule, the
  lonkero slot; capital casing matches the `.gitmodules` entry and the
  case-sensitive volume), pinned to the `kawai/core` commit. Add `NeuroSploit`
  to `crates/Cargo.toml` → `workspace.exclude` (beside `"lonkero"`).
- Upgrades: `git fetch upstream && git rebase upstream/main kawai/core`, re-pin
  (LiteRT-LM `update-litert-lm.sh` pattern; a `scripts/update-neurosploit.sh`
  wrapper is optional once the rebase proves routine).
- kawai never depends on the `app` CLI crate; only
  `crates/neurosploit/neurosploit-rs/crates/harness` (package
  `neurosploit-harness`, lib name `harness`) as a path dep of the new toolset
  crate.
- Keep `agents_md/` (493 markdown agents, 2.4 MB) inside the vendored repo —
  it is the source the pinned runtime download serves from (§3 P1).
  Kawai never copies it loose into its own tree; the binary does not embed it.

## 3. Harness patch series (branch `kawai/core`, one commit per patch)

Ordered so each keeps `cargo check -p neurospilot-harness` and the upstream CLI
(`-p neurosploit`, features default) green.

**P1 — agents library: RESOLVED OUTSIDE THE HARNESS (landed 2026-11-24).**
`crates/integrations/neurosploit-agents` (commit `1a27901`) downloads
`agents_md/` (GitHub tree API + raw files, path-traversal-guarded,
per-user `<data_root>/<user_id>/agents_md`, `verify_local` completeness
check) so the harness keeps using upstream `Library::load(&Path)`
(`agents.rs:42-58`) UNPATCHED — the include_dir patch is dropped and the
fork surface shrinks. Required hardening before any op wires it in:
1. **Pin the ref.** `DEFAULT_BRANCH = "main"` floats — upstream pushes
   weekly, so every user's agent library would drift silently. Default to a
   pinned commit SHA (tree API + raw URLs both accept a SHA; content at a
   SHA is immutable, which also makes the size-skip idempotence sound) and
   point `DEFAULT_REPO` at the kawai fork once Phase 0 lands. Bumping the
   pin is a deliberate act.
2. **Tree truncation.** `GitTree.truncated` is parsed but unchecked — a
   truncated tree must produce a failure entry, not a silently partial
   library that `verify_local` can miss mid-category.
3. **Op-layer ensure flow** (Phase 3): `verify_local()` → if incomplete,
   `download_agents_md` (pinned ref) → `verify_local()` again → refuse the
   run with guidance if still incomplete. Never start an audit against a
   partial library.
Upstream CLI keeps using `load(Path)`; kawai does too — from the fetched
dir.

**P2 — kawai-gateway provider.** In `providers()` (`models.rs:23-96`) add:

```rust
Provider { key: "kawai", label: "Kawai Gateway",
           base_url: KAWAI_GATEWAY_BASE_URL, env_key: "", kind: "api",
           models: ["zai/glm-5.3-flash", "deepseek/deepseek-chat",
                    "venice/deepseek-v4.1-flash"] }
```

`base_url` resolves at call time from an injected `OnceLock<String>` set by
`harness::set_gateway_endpoint(Option<String>)` (worker URL + `/v1`), mirroring
`remote_llm::set_gateway_bearer`. `resolve_key` (`models.rs:105-113`) is patched
to consult an injected bearer (`harness::set_gateway_bearer`) before env. The
gateway's `/v1/*` passthrough is OpenAI-compatible and already answers
`chat/completions` with bearer auth — `ChatClient::chat_labeled`
(`models.rs:196-330`) needs no transport change. Model refs become
`kawai:zai/glm-5.3-flash` etc.; `ModelRef::parse` splits on `:`, and the model
ids carry only `/` — no parser change. `resolve_key` never logs the bearer.

**P3 — `core` cargo feature (offensive surface off).** Upstream gains
`[features] default = ["full"]`, `full = ["core", "offensive", "graph"]`;
kawai depends with `default-features = false, features = ["core"]`.
Modules behind `offensive`: `c2`, `pivot`, `sandbox` (+ `toolbox`), `tunnel`,
`oob`, `browser`, `neo4j_managed`, `neo4j_exploration`, `mcp_*`, `c2/client`.
Behind `graph`: `graph_memory`. Gate the ~8 core call sites with cfg'd no-op
fallbacks — all are already runtime-optional (scout-verified):
`pipeline.rs:611` (c2 doctrine, env-gated), `:616`+`:6603-6666` (toolbox,
env-gated), `:1748` (oob, only when `cfg.oob_domain` — kawai never sets it),
`:1805-1830`/`:6343-6375` (sandbox lane), `:2998` (neo4j, only when
`cfg.neo4j`), `:3051` (PivotManager construction — no-op when `pivot_proxy=off`,
which kawai's default RunConfig leaves), `:660-790`/`:4030` (browser prefetch +
`BrowserProbe`, degrade to warnings like the no-node path), `models.rs:957-1003`
(Playwright MCP spawn, subscription lane kawai never uses). Cut
`graph_memory.rs:1980 → neo4j_managed` under `core`; `report.rs:964`
`write_artifacts` already best-effort ("graph: skipped"). Net effect: no C2,
webshell, pivot, payload-generation, or container-exec code in kawai's binary.

**P4 — per-run cache roots.** Replace the two CWD-relative roots with
workdir-relative paths (patch `cache.rs:55-61` and `pipeline.rs:6277-6283`):
LLM cache + recon cache live under `<workdir>/cache/`. Mandatory: desktop CWD is
not app-controlled, and mobile sandboxes have no writable CWD. The 7-day TTL
stays; a run slot (§5) keeps the global-vs-per-run ambiguity of the usage ledger
honest.

**P5 — reqwest 0.12 → 0.13.** Workspace dep → `reqwest = { version = "0.13",
default-features = false, features = ["json", "rustls"] }` (feature renamed
`rustls-tls` → `rustls`; lonkero made the same jump). Scout inventory: no
`bytes_stream`/multipart/websocket anywhere in the harness; only
`Proxy::all` (probe/proxy/transport), `Policy::custom` (probe.rs:115) and
`.timeout()` builders to re-verify. One reqwest major across the kawai graph —
keeps the landmine rule intact.

**P6 — usage snapshot API.** Expose `harness::usage_snapshot() -> UsageTotals`
(pub over `usage.rs:17-66`). Metering is a snapshot-delta around the run (§7),
not a patch of the call path.

**P7 — (optional, only if §5 streaming needs it) structured progress events.**
MVP forwards the text lines as-is; defer a typed event enum until the UI proves
it needs more than lines.

## 4. New toolset crate `crates/toolsets/neurosploit-tools/`

Shape copied from `crates/toolsets/security-tools/` (lib.rs 264 LOC, tools.rs,
agent.rs, plan.rs, registry.rs). Deps: `neurosploit-harness` (path, `core`
feature), `kawai-tools`, `kawai-agent-contract`, `serde`, `serde_json`, `tokio`.

- **`lib.rs` — the run helper.** Unlike lonkero (engine `!Send` → dedicated
  thread), harness futures are `Send`: `tokio::spawn` + `tokio::time::timeout`
  over `pipeline::run`. Constants:
  `AUDIT_TOKEN_BUDGET = 120_000` (eco preset; the confirmation prompt quotes
  this ceiling) and `AUDIT_BACKSTOP = 45 min` (`KAWAI_NEUROSPLOIT_BACKSTOP_SECS`
  overrides; step timeout derives from it like security-tools'
  `STEP_TIMEOUT_MS = SCAN_BACKSTOP*1000 + 30_000`).
  On backstop: return the envelope with `timedOut: true` + `resumable: true`
  and the workdir path — a re-invocation with the same workdir resumes from
  `run_snapshot.json` (never silently restart a half-spent run).
  **Run slot:** a process-global `tokio::sync::Mutex` serializes audits. Two
  reasons: the harness usage ledger is a process global (delta metering, §7),
  and a gateway account should not carry two concurrent 8-way waves.
- **`tools.rs` — `NeuroSploitAuditTool` (`neurosploit_audit`).** Args
  (camelCase, mirror `SecurityScanArgs` style): `url` (required, one origin),
  `budget` (`eco|balanced|aggressive`, default eco), `voteN` (default 1 — the
  upstream default 3 triples spend; cap 3), `concurrency` (default 4, cap 8 —
  gateway politeness), `resume` (bool: reuse the last workdir for this target).
  `requires_confirmation() -> true`. The tool builds `RunConfig::new(target)`,
  sets `models = ["kawai:zai/glm-5.3-flash", "kawai:deepseek/deepseek-chat",
  "kawai:venice/deepseek-v4.1-flash"]` (failover order = pool priority),
  `vote_n`, `concurrency`, `workdir = <data_root>/<user_id>/neurosploit/runs/ns-<ts>-<target>`,
  `pivot_proxy` untouched (off), no `oob_domain`, no `neo4j`, `scope` locked to
  the target origin, and the agent library root passed in from
  `neurosploit_agents::agents_md_dir` (runtime-fetch design, §3 P1).
- **Envelope** (flat, `kind` discriminator — repo rule):

```json
{ "kind": "neurosploit_audit", "target": "…", "timedOut": false, "resumable": false,
  "workdir": "…", "durationMs": 0,
  "summary": { "confirmed": 3, "needsReview": 2, "total": 5 },
  "findings": [ { "title", "severity", "confidence", "cwe", "cvss", "url",
                  "evidence", "impact", "remediation", "validated": true } ],
  "agentsRan": ["…"], "usage": { "calls": 0, "input": 0, "output": 0 } }
```

  Producer notes (from the `Finding` serde shape): `confidence` is f64
  0.0–1.0; the harness field is `endpoint` — the envelope maps it to `url`
  for the security-card contract; `usage` reuses the harness `Usage` keys
  verbatim. Finding fields are the producer's `Finding` fields flattened
  (fixture comes from a real run — §8). `severity/confidence/evidence/cwe/
  remediation` match the security card contract so the renderer work is
  additive. Findings are capped inline (top 25 + `truncated: true`) — a full
  engagement can emit hundreds; the report stays on disk.
- **`plan.rs` — `build_neurosploit_audit_plan(target, budget, language)`.**
  Domain-crate builder per the checklist: one recon-skipping step (the harness
  does its own recon) dispatching `neurosploit_audit`, `timeout_ms = AUDIT_BACKSTOP
  + margin`, `kawai_router::stamp_run_nonce` as the last step (the plan carries
  no other nonce), goal language through `goal_in_language_verbatim`. Builder
  tests: `check_plan_conventions`, `registry.validate_plan`, step-timeout pin.
  Router template `neurosploit_audit` registered beside `security_audit`
  (`templates.rs:244` pattern, same builder — no second implementation).

## 5. src-tauri wiring

- **Cargo feature** `neurosploit = ["dep:neurosploit-tools"]` (mirror
  `security = ["dep:security-tools"]`, `src-tauri/Cargo.toml:227`). Rides
  `release-desktop`; NOT in `release-android` and NOT in the kawai-web binary
  (§9). `cargo ndk check --features release-android` stays green because the
  feature is absent there; compile-greenness of the harness itself for aarch64
  is checked once via a temporary `cargo ndk -t arm64-v8a -P 24 check -p
  neurospilot-harness --no-default-features --features core` when P3 lands.
- **Streaming op** `run_neurosploit_audit` (one snake_case string, both
  wrappers): `stream_id` + `Channel` + `State<StreamRegistry>` + `State<Session>`;
  identity → `user_id` first arg into pure logic. Events (`#[serde(tag = "type")]`,
  mirrored in `use-local-chat.ts` + `agent.rs`):
  `progress {line}` (tx lines, forwarded lossy), `result {envelope}`,
  terminal `finished`/`error`. Cancel: registry `CancellationToken` breaks the
  select loop AND calls the spawned handle's `pool.cancel()` — the pool exposes
  cancel/soft/pause handles (`pool.rs:63-98`) so generation spend stops, not
  just the consumer. The op runs through `android_foreground::run_streaming`
  like every streaming op (no-op off Android, keeps the invariant).
- **Supervisor** `prepare_neurosploit_audit_run` beside
  `prepare_security_audit_run` (`supervisor.rs:3779`): builds the plan through
  the shared builder, persists the run, returns the streamed execution. Web
  route `POST /api/run_neurosploit_audit` on `protected` with
  `#[serde(rename_all = "camelCase")]` on the request struct.
- **Toolset registration** (`agent_registry.rs:366` composition arm): the tool
  joins `builtin.security`'s registry only when the gateway is usable — gate on
  `remote_llm` availability (`remote.is_some()`), the same rule as `deep_write`.
  No bearer ⇒ no tool ⇒ agents can't discover a run that would fail anyway.
- **Catalog**: `seed_tool_catalog` row for `neurosploit_audit` (composition arm
  with stub identity, civitai precedent) + drift check.

## 6. Frontend

- New kinds in BOTH registries (checklist rule): chat
  `tool-renderers/index.tsx` + workbench `tool-views`; `registry-coverage.test.ts`
  gains `neurosploit_audit`.
- Renderer: progress phase = the forwarded text lines in the terminal card
  style (`terminal.tsx` pattern); result = summary chips (confirmed /
  needs-review / total / tokens / duration) + severity-sorted finding cards
  reusing the `security.tsx` card contract; `timedOut`/`resumable` state shows
  a resume affordance that re-submits with `resume: true`.
- Confirmation UI quotes the budget ceiling ("Deep audit: up to ~120k gateway
  tokens on <target>") — the spend prompt IS the price path (civitai precedent).

## 7. Billing / metering

The harness calls the gateway directly (P2), so — like every remote tier call —
the **client** meters. Snapshot `harness::usage_snapshot()` before and after the
run, diff → `usage_ledger` row + `kawai_billing::bill_usage(input, output)`
(`crates/foundation/billing/src/lib.rs:85-91`), attributed to the run's
`user_id` + session, mirroring how the supervisor folds `RemoteUsage`
(`supervisor.rs:1285-1297`). The run slot (§4) makes the global-ledger delta
exact. `RunOutput`/envelope also reports usage to the UI. Agent-level labels
(`usage::record(label=agent-name)`) land in `usage.json` in the workdir for
per-step debugging.

## 8. Verification (one smoke, not the job)

1. **Producer fixture first** (checklist rule 4): one MANUAL real run via the
   gateway against a test target the user owns → capture `findings.json` +
   `report.json` into `crates/toolsets/neurosploit-tools/tests/fixtures/`.
2. `cargo test -p neurosploit-tools`: envelope test CALLS the tool with
   `offline = true` mode (harness runs without model API) against a local
   vulnerable server (security_smoke pattern) and pins the JSON paths above
   against the real fixture; plan-builder tests (§4).
3. `plan_task` e2e through the REAL merged registry: offline harness lane so
   CI spends zero gateway tokens; asserts `usage.input_tokens == 0` (planner
   skipped) and that the step dispatches.
4. Manual gateway smoke (dev only): `cargo run --example neurosploit_smoke
   --features litert,neurosploit` — one eco-budget run, asserts confirmed
   findings + ledger delta > 0.
5. Gates: `cargo check`, `cargo check --features web`, `cargo check --features
   litert,neurosploit`, `bun run build`; harness dual-feature
   (`cargo check -p neurospilot-harness` default AND `--no-default-features
   --features core`).
6. Docs same-commit: AGENTS.md (where-things-live + Roadmap entry +
   landmine for the CWD-relative cache patch if it ever regresses),
   ARCHITECTURE.md, this plan → current-state text. No new credentials
   (gateway bearer is the existing session bearer) → no CREDENTIALS.md row.

## 9. Explicit exclusions (MVP)

- **kawai-web**: never — multi-user process, hours-long runs, shared usage
  ledger slot. The feature is not in the web binary.
- **Android runtime**: not in `release-android`. Compile-green check only (§5).
  Hours-long autonomous runs on mobile radios + foreground-service budget are a
  post-MVP product call.
- **Offensive modules**: c2/webshell/pivot/payload/sandbox/container never ship
  in kawai's binary (P3). Upstream CLI keeps them via `full`.
- **Other lanes** (whitebox/greybox/host/mobile/container/aitest): parked;
  each would be a separate tool + args surface behind the same run slot.

## 10. Risks

- **Upstream velocity**: 4.4.x moves fast and its docs already lag its lib
  (doc-comment says 4.4.2). Pin the submodule commit; patches are a rebaseable
  series; the harness API surface this plan touches (`pipeline::run`,
  `Library::load`, `ModelPool::with_auth`, `providers()`) is small — re-patch
  cost is bounded.
- **Gateway load**: concurrency 8 × N agents × vote 3 is real spend. Defaults
  (eco, vote 1, concurrency 4) are the guard; `balanced`/`aggressive` exist for
  opted-in users.
- **Harness error text**: the harness prints upstream/provider error bodies
  into `tx` lines (its own product behavior). kawai forwards them as progress
  events — acceptable for the user's own engagement view, but they must never
  become Loki labels; keep them out of `tracing` fields (log the generic line
  only).
- **Windows/MSVC**: harness is pure Rust (json5/walkdir/sha2/hmac/base64/regex)
  and the release build compiles it there — CI is the proof; no C deps to
  stage.
- **Resume across app restarts**: snapshot lives in the workdir under the
  user's data dir — survives restarts; the MVP resume affordance is the `resume`
  arg, not automatic.

## 11. Phase order

| Phase | Deliverable | Proof | Status |
|---|---|---|---|
| 0 | Vendor to `crates/NeuroSploit`, workspace exclude, branch `kawai/core` | submodule gitlink pinned `e38381f`, pushed | ✅ 2026-11-24 |
| 1 | Harness patches P5–P3 (P1 superseded, see §3) | five commits on `kawai/core` (yudaprama/NeuroSploit), triple cargo-check green | ✅ 2026-11-24 |
| 2 | `neurospilot-tools` crate + fixture + tests | committed `179f39d` + casing/member follow-ups (`44e37ec`, `5d62df4`); `cargo check` + `cargo test` 8/8 at the canonical path (harness worktree re-materialized from origin `e38381ff` after the concurrent-automation damage) | ✅ 2026-11-24 |
| 3 | src-tauri feature + streaming op + supervisor + template + catalog | `cargo check --features neurospilot` / default / `--no-default-features --features web` all green; toolset tests 8/8; plan_task execution deferred (the harness `offline` flag is not wireable through the tool's camelCase arg struct — noted in `examples/neurosploit_plan_smoke.rs`, which pins builder + merged-registry + policy without executing) | ✅ code 2026-11-24 |
| 4 | Frontend registries + cards + coverage test | `neurosploit.tsx` in both registries, coverage 46/46, typecheck+build green, commit `e4111c2` | ✅ 2026-11-24 |
| 5 | Docs + manual gateway smoke | AGENTS.md/ARCHITECTURE updated, ledger delta observed | — |

Rough size: Phase 1 is the deep end (P3 touches ~10 files); Phases 2–4 are the
security-tools checklist replayed.
