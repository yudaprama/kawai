# Integration Plan — NautilusTrader ↔ kawai (reference-first, staged adoption)

Status: **DRAFT (2026-08-24)** — decision record + staged plan. Nothing in this
doc is scheduled work; every stage below is gated on an explicit user request.
Live status stays in `AGENTS.md` → Roadmap (Binance agent entry).

Decision context (2026-08-24): the fork/submodule
`rig-components/nautilus_trader/` (upstream nautechsystems/nautilus_trader) was
added as a **reference-only** submodule. It is NOT a workspace member
of `rig-components/Cargo.toml` and NOT a path dependency of anything; it must
stay out of the build graph unless a stage below is explicitly started.

---

## 0. Ground rules (apply to every stage)

- **`rig-components/nautilus_trader/` stays reference-only** until a stage is
  explicitly started. Never add it to `rig-components/Cargo.toml` `[members]`
  or as a path dep "to try something".
- **Nothing from nautilus becomes a dependency while the current tool works.**
  The Binance agent Phase 1 (keyless reads via crates.io `binance-sdk` +
  in-process `ta`) is CI-gated (`binance_smoke` in 3 smoke jobs, 6 TA unit
  tests) and stays the runtime path.
- **Study-and-verify, not copy-paste.** Nautilus file headers (LGPL-3.0) and
  the project's own `AGENTS.md` rules apply inside the submodule dir. We read
  it for patterns, formulas, and fixtures; code that enters kawai is written
  against kawai's types (compact JSON out, `round8`, one-line results for the
  on-device orchestrator) and kawai's dependency rules.
- **Each stage below lists a trigger** (the condition under which it becomes
  relevant) and an exit check. No trigger → stage stays dormant indefinitely.

---

## 1. Stage R — active reference use (available now, zero build cost)

**Trigger: any work on `rig-components/binance/` or the Binance agent.**

What to consult, and for what:

| Area in nautilus | Read for | Applies to kawai |
|---|---|---|
| `crates/adapters/binance/src/common/` (error mapping, rate-limit weight accounting, URL routing) | Error-code taxonomy; which responses are retryable | Improving `market.rs` error strings fed back to the model |
| `crates/adapters/binance/src/spot/http/` (REST client structure) | Header handling, `recvWindow`, time-sync discipline | Phase 2 signing prep (see Stage 2) |
| `crates/adapters/binance/src/spot/sbe/README.md` | The full SBE regen pipeline + pitfalls (SBE tool v1.38 API break, schema rollout semantics, block-length drift) | Institutional knowledge only. SBE is a microsecond-scale concern; kawai's orchestrator (on-device Gemma 4, seconds-scale turns) has no use for it — see "AI vs SBE" note below |
| `crates/analysis/src/statistics/` (33 metric files, each ~130-200 lines) | Verified formulas: Sharpe, Sortino, Calmar, Omega, max drawdown, CAGR, VaR, expected shortfall, profit factor, expectancy, win rate | Stage 3 (portfolio tools) — formula reference, not import |
| `crates/indicators/` | Indicator catalog beyond the 16 in kawai's `ta` crate | Extending `binance_ta_analyze` indicator set |
| `test_data/` + adapter test fixtures | Kline/depth/orderbook snapshots for parser tests | Hardening `market.rs::parse_candle_row` unit tests with real-world malformed rows |

**Exit check:** none — this stage is standing. Cost is zero (no build graph
membership); value compounds as Binance-agent work continues.

### AI vs SBE (why SBE stays out of scope)

Latency budget reality: LLM turn = 1–30 s; Binance REST round trip = 10–100 ms;
JSON parse ≈ 1 ms; SBE decode ≈ 1 µs. SBE only matters when the decision-maker
is REMOVED from the hot loop (Stage 4's executor model). For every kawai stage
where the model or a human is in the loop, JSON is sufficient forever.

---

## 2. Stage 1 — Phase 2 signing patterns (signed account reads)

Status update (2026-08-24): **Phase 2 core has SHIPPED** —
`binance_balances` / `binance_open_orders` are live (signed via
user-supplied `BINANCE_API_KEY`/`BINANCE_API_SECRET` from `.env`,
capability-probe registration; see AGENTS.md → Binance agent entry). The
client choice this stage argued for (`binance-sdk`, no nautilus) is the
shipped reality. What remains here are the hardening residuals below —
pick them up opportunistically, not as a project:

- [ ] `recvWindow` + local-clock drift correction (time-sync against
      `/api/v3/time` before signing) — port the discipline from
      `crates/adapters/binance/src/spot/http/client.rs`, not the code.
- [ ] Weight-based rate-limit accounting (mirror nautilus's per-client
      budget struct; Binance reports used weight in response headers).
- [ ] Error taxonomy in tool-result strings: retryable (`-1021` timestamp,
      `-1003` rate limit) vs fatal (bad key, missing permission) so the
      model reacts correctly.
- [ ] Key storage upgrade: `.env` → OS keychain (Roadmap 7 mechanism),
      read-only permissions enforced at key-creation time (user instruction).

Reference reading while hardening: `common/` error mapping and the signed
request surface of `binance-sdk` 68. Tests: recorded fixtures
(nautilus `test_data/` shapes); live smoke stays opt-in and skip-aware.

**Exit check:** residuals above closed or explicitly waived; no nautilus
crate in the graph.

---

## 3. Stage 2 — Phase 3 order placement + portfolio metrics

**Trigger: Binance agent Phase 3 (order placement with human confirmation)
scheduled by the user.**

Two sub-tracks:

### 3a. Execution correctness (the part nautilus is genuinely better at)

Study and replicate in kawai's tool layer:

- **Symbol filters** — LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL / tick & step
  size, from `exchangeInfo` (nautilus `common/` filter parsing is the
  reference). Orders that violate filters must be rejected CLIENT-side with a
  plain-language reason before they ever reach the exchange.
- **Order state reconciliation** — what nautilus's execution client tracks
  between submit → ack → fill/partial-fill/cancel → reject. For kawai's
  human-confirmed, one-shot orders the state machine is small, but the
  terminal-state set and timeout handling must be copied deliberately.
- **Precision:** kawai's tools are f64 + `round8` today — fine for read-only
  display. Order placement must move to decimal string pass-through (send the
  user-visible quantity verbatim, never reformat a float) — nautilus's
  `rust_decimal` discipline is the model; the cheapest correct version is
  "strings in, strings out, validate against filters".

**Human confirmation is a hard product rule** (already in the Roadmap entry):
the agent may prepare an order; the UI confirms; the tool executes exactly what
was confirmed. No agent-initiated execution in any stage of this plan.

### 3b. Portfolio analysis tools (`nautilus-analysis` as formula reference)

After Phase 3 lands, trade history exists and these become agent tools
(`binance_portfolio_analyze` family), implemented fresh against kawai types
with formulas verified side-by-side against
`crates/analysis/src/statistics/*.rs`:

- First wave: `win_rate`, `profit_factor`, `expectancy`, `max_drawdown`,
  `returns_volatility` (simple, high explanatory value for the model).
- Second wave: `sharpe`, `sortino`, `calmar`, `omega`, `value_at_risk`,
  `expected_shortfall` (period-return plumbing first; nautilus's return
  computation cadence is the reference).

Why not import `nautilus-analysis` even though it is the cheapest nautilus
crate (only `nautilus-core`/`nautilus-model` deps, no C, no network): its
statistics consume nautilus typed models (`PortfolioAnalyzer`,
fixed-point position/account states). The adapter layer would be larger than
the ~40 lines of math per metric. Revisit ONLY if Stage 4 (below) happens, in
which case the types unify for free.

**Exit check:** portfolio tools unit-tested against nautilus-computed
reference values on shared fixtures (their `rstest` cases are the oracle).

---

## 4. Stage 3 — nautilus as a SERVER-side executor (the real integration, if ever)

**Trigger: a product decision that kawai users deploy STRATEGY BOTS —
agent-designed rules executing unattended at machine speed.** This is a
product-direction change, not a feature of the Binance agent; nothing in the
current Roadmap points here.

### 4.1 Placement decision: server, not desktop

The nautilus live node belongs on a **server** (hosted by us or self-hosted by
the user), for three reasons a desktop app cannot solve:

1. **24/7 execution** — a strategy must run while the user's laptop is closed.
   The Tauri app dies with its process; a server does not.
2. **Network quality** — datacenter links to the exchange are stable and close;
   a home connection dropping mid-order is how state gets lost.
3. **Multi-device** — design on desktop, monitor from mobile: one source of
   truth, not a desktop-held process.

This mirrors kawai's existing Roadmap 8 pattern (sensitive keys and minting
stay server-side; devices hold scoped tokens) and keeps the product's
local-first character for every non-trading function.

### 4.2 Architecture

```
kawai app — desktop/mobile (agent tier, slow, context-rich)
   1. DESIGN    agent drafts a strategy spec (kawai strategy language →
                nautilus config); risk caps explicit
   2. BACKTEST  server runs nautilus backtest (deterministic simulation);
                results stream back to the agent → plain-language verdict
   3. DEPLOY    the ONLY human-confirmation point: user approves the spec +
                caps + venue + key scope. One confirmed action.
   4. MONITOR   read-only tools: positions, PnL, drawdown, order events →
                agent explains, proposes adjustments; adjustments re-enter
                at DEPLOY (never hot-path)
        │  REST/SSE over authenticated API (kawai-web surface)
        ▼
kawai server (kawai-web + supervisor)
   - per-user nautilus live node (process boundary; arrow/SBE/engine never
     enter the Tauri binary)
   - user API keys: encrypted at rest, per-user isolation (Roadmap 16
     namespaces apply); keys never transit to devices
   - backtest workers on historical Parquet data
        │ supervised child process(es)
        ▼
nautilus live node(s), one per running strategy (or per user)
   - SBE/WS market data, order state machine, reconciliation
   - unattended execution under the confirmed risk caps
```

The two-tier loop is the only architecture where SBE / nautilus's engine earn
their cost: the decision-maker (LLM, seconds-scale) is out of the hot path;
the executor (engine, µs-scale) never talks to the LLM.

### 4.3 Semantics changes this implies (product decisions, not tech)

- **Confirmation shifts from order to strategy.** Desktop Phase 3 confirms
  each order; the server model confirms the STRATEGY (with caps) — individual
  orders then execute under those rules unattended. This is a real product
  change and must be presented as such in any UI that offers it.
- **Key custody moves server-side.** Hosting user Binance keys makes kawai a
  hosted trading service for this feature: encryption at rest, per-user
  isolation, audit log of key access. Self-hosting the server (single user,
  keys stay on the user's own box) is the escape hatch for key-averse users
  and should stay a supported deployment.
- **The agent never gains execution authority.** `strategy_deploy` is the only
  mutating tool, and it is confirmation-gated; monitoring tools are read-only.
  This rule is the safety boundary of the whole tier.

### 4.3a Credentials: one account, TWO keys — never one shared key

Technically one API key CAN serve client and server simultaneously (signatures
are per-request; Binance does not bind a key to one connection), but three
hazards make the shared-key setup wrong:

1. **IP whitelist conflict.** A key locked to the server's datacenter IP
   cannot be used from the client's residential IP (and an unlocked key is
   strictly weaker security).
2. **Shared order-rate budget.** Order-rate limits are per ACCOUNT, not per
   connection: an aggressive bot can exhaust the budget and get the user's
   manual orders rejected (`-1015`).
3. **User-data stream ownership.** The order/execution event stream
   (listenKey) is per-key; two consumers on one stream invite lost/duplicated
   events. One writer deserves one listener — the server.

The correct split (Binance supports per-key permissions, so use them):

| Key | Permission | IP lock | Lives | Used for |
|---|---|---|---|---|
| client key | **read-only** | none needed | device keychain | balances, open orders, history |
| server key | read + **trade** | server IP | server, encrypted at rest | nautilus execution, manual-order relay (option (a) below) |

Market data (price, klines, depth) needs NO key at all — public endpoints; the
Phase 1 agent and any live price panel stay keyless.

**Option (a) vs (b) for manual orders (decide before Phase 3 ships):**

- **(a) Server-relayed manual orders** — UI confirms, SERVER signs and sends;
  client key stays read-only forever; trade permission exists in exactly one
  place; user-data stream has one consumer. This is the end-state and aligns
  with the Stage 3 architecture, but requires the server to exist even for
  Phase 3 desktop.
- **(b) Client-signed manual orders** (current Phase 3 sketch: user trade key
  in `.env`/keychain, `binance-sdk` signs in-app) — simpler, works pre-server,
  but the trade key then lives on the desktop AND later on the server once
  Stage 3 lands: two storage locations, two stream consumers, IP-lock
  impossible. Acceptable ONLY as the transitional shape before the server
  exists; if Stage 3 ships, Phase 3 manual orders should migrate to (a).

Rule of thumb: **one key = one permission set = one location = one consumer.**
Any future feature that violates one of those four needs a redesign note in
this plan before it ships.

### 4.4 Implementation shape (when started)

1. Server = `kawai-web` surface grows a supervisor module: spawn/stop/health
   per-user nautilus nodes, backtest job queue. Nautilus stays a separate
   process — configured BY kawai, not linked INTO kawai.
2. New ops (all dual-wrapper per invariant #2): `strategy_backtest`,
   `strategy_deploy`, `strategy_list`, `strategy_status`, `strategy_stop`,
   plus agent monitoring tools (`portfolio_positions`, `portfolio_pnl`).
   Streaming ones reuse the `stream_id` + cancel-registry pattern.
3. Desktop app gains a Strategy panel (three-pane layout keeps): list,
   backtest results, deploy confirmation with caps displayed, live status.
   Market-price streaming INTO the UI (if built) uses `binance-sdk`'s own
   WebSocket directly — nautilus is not needed for display-grade streams.
4. Inside the server, `nautilus-analysis` becomes importable as-is (types
   unify in the node), and Stage 2's hand-written metrics can migrate there
   if duplication ever hurts.
5. Process boundary also keeps LGPL obligations at arm's length (separate
   process, not a linked dependency).

**Exit check:** separate design doc first (this section is a direction, not a
build plan); user sign-off on the product change (§4.3) — including the
credential split (§4.3a: two keys; manual orders via (a) or (b)) — before any
code.

---

## 5. Dependency-decision ledger (what we learned, recorded so it survives)

Findings from the 2026-08-24 evaluation — keep these; they re-justify the
staging whenever the question recurs:

- **`nautilus-binance` as a `binance-sdk` replacement: rejected for Phase 1–2.**
  Costs that outweighed the benefit at current scope:
  - Build: adapter pulls `nautilus-common/live/model/network/serialization`
    (SBE + **arrow** — multi-minute cold compile alone), `dashmap`,
    `ed25519-dalek`; the nautilus workspace carries 141 `[workspace.dependencies]`
    entries vs kawai-binance's ~20-crate graph.
  - Seam: nautilus returns typed models (fixed-point, `Bar`/`OrderBookDelta`);
    kawai tools must return compact one-line JSON for the on-device
    orchestrator — the conversion layer would be larger than the code it
    replaces (`market.rs` is 226 lines).
  - Architecture: the adapter is designed against the nautilus kernel/message
    bus; standalone use is unnatural. `binance-sdk` does the same keyless
    REST job with rustls and zero ceremony.
- **C-dep argument is WEAK — recorded correction.** Initial evaluation flagged
  nautilus's `aws-lc-rs` as new C cost. Audit of `src-tauri/Cargo.lock` showed
  `aws-lc-sys` 0.44 + `ring` 0.17 already in kawai's graph today (libsql/tonic
  stack — also an AGENTS.md landmine entry). The real migration cost is
  arrow/SBE/`nautilus-model` + the conversion seam, not crypto C.
- **`nautilus-analysis` import: deferred, not rejected.** Cheapest nautilus
  crate (no C, no network, `rust_decimal`+`indexmap` only) but still typed to
  `nautilus-model`. Formula reference until Stage 3 unifies the types.
- **SBE: never inside the app process.** µs-scale decode under a
  seconds-scale orchestrator is wasted motion; it is an executor-tier concern
  (Stage 3, server-side) by construction.
- **`binance-sdk` WS is sufficient for display-grade streaming.** Verified in
  the crate source (`common/websocket.rs` — connection handling, heartbeat,
  reconnect utilities; `spot/websocket_streams` + signed `websocket_api`):
  it provides the PIPE, not trading semantics. For UI price feeds the pipe is
  enough (a missed tick during reconnect is harmless); order-book state
  keeping, order reconciliation, and 24/7 recovery remain nautilus's tier
  (Stage 3). `binance-sdk` therefore remains the in-app layer for ALL of
  Stages 1–2 AND for any live price panel in Stage 3.
- **`binance-sdk` remains the HTTP layer for all in-app stages (1–2).** It has
  signed-endpoint support for Phase 2; swap was evaluated and rejected on
  cost/benefit, not on capability.

---

## 6. Housekeeping (one-time, this doc's commit)

- [x] `AGENTS.md` — layout tree now notes `rig-components/nautilus_trader/`
      is a reference-only submodule, pointing at this doc. (done 2026-08-24)
- [x] Verify `rig-components/Cargo.toml` `[members]` does NOT include
      `nautilus_trader` (already true as of 2026-08-24; guard against
      accidental `cargo add`/workspace globs).
- [ ] Never run `cargo` commands inside `rig-components/nautilus_trader/` in
      CI or scripts — its toolchain pin (`rust-toolchain.toml`) and lockfile
      are the submodule's own business.
- [ ] When Stage 3 is ever started: the server-side design (§4) supersedes the
      earlier "node configured by kawai" sketch; Roadmap cross-links (8, 16)
      must be added to the actual Roadmap entries at that time.
