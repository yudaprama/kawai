# PLAN-accounting.md — accounting agent (BACKLOG / parked, design finalized)

**Status: parked, design finalized.** The accounting feature exists
end-to-end but ships nowhere: not in `bun tauri dev`, not in
`.github/workflows/ci.yml`, not in `.github/workflows/release.yml`. The
`accounting` cargo feature is opt-in for local experiments only.

**Decision (2026-10-18): the wedge use case is trading books** — clean PnL
bookkeeping for crypto/futures traders. Reasons: it is the only persona ~80%
built and tested (import → PnL → reconcile → reports), its audience stacks
with kawai's existing Binance/monad/crypto-research features, and it avoids
the India-GST tax-scope question entirely (the GST layer stays dormant until
a different market is chosen).

## The workflow portfolio (three jobs, three workflows)

| Workflow | Domain | Reads | Question |
|---|---|---|---|
| **Futures Risk Audit** (exists) | Venue — current state | open positions, margin, SL/TP | *"how exposed am I right now?"* |
| **Trading Performance** (NEW — the flagship) | Books — period history | realized PnL, fees, win rate | *"how did I do this period?"* |
| Monthly Close (exists) | Compliance | statements + integrity + GSTR-1 | *"books clean and filing-ready?"* — GSTR-1 irrelevant to traders; stays as a bookkeeping utility |

**Accounting boundary (design law):** unrealized PnL never enters the books
— mark-to-market needs a different ledger design. Venue state lives in the
audit; the books record realized events only (fills). Triggered SL/TP become
fills on the exchange and enter the books on the next sync — never at order
placement.

## Auto-sync on audit (books always fresh, no asking)

The audit's wave 1 syncs the Binance POSITIONS mirror, not the fill history —
`crypto_futures_trade_stats` is the only writer of the fill table, so a fresh
install must run it before the import has anything to post. So "update the books automatically on
every audit" is one new step in the fixed pipeline:

```
audit (fixed pipeline)
├─ wave 1:  binance_futures_risk_audit  (sync mirror + grading)   — exists
├─ wave 1b: books sync (NEW)            — post unposted fills, idempotent
└─ synthesis: venue risk + books PnL in one narrative               — fusion
```

- **Mechanics**: rolling 30-day window per audit run; idempotency by
  `(margin, trade_id)` makes overlap free — no cursor state.
- **No consent gate (decision 2026-10-18)**: the wave posts silently on
  every audit and the synthesis reports what was posted (*"books: +12 fills
  posted, wallet +14.45"*). Safe to automate: postings are idempotent,
  derived from the exchange (source of truth), keyed by trade id
  (auditable), and the Monthly Close integrity gate catches any drift.

## Trading Performance (the flagship workflow, new)

Plan template with a `period` slot (the Monthly Close pattern — it is
period-driven, unlike the state-driven fixed audit pipeline). Keywords:
*"performa trading"*, *"trading performance"*, *"review pnl"*. Rides the
merged `Auto` registry (both toolsets) — zero registry work. Review gate
attaches automatically (the sync step is a write).

Steps (from existing tools except one):

1. `venue_fills_import(period, venue?)` — freshness (idempotent)
2. `crypto_futures_trade_stats(period)` — win rate, expectancy, profit
   factor, FIFO round-trips (exists in the binance toolset)
3. `trading_pnl_by_symbol(period)` — per-pair realized PnL (NEW)
4. `trading_fee_summary(period)` — fees and fees-as-%-of-volume (NEW)
5. `ledger_integrity_check(period end)` — gate before the narrative
6. Synthesis: best/worst pair, fee drag, period-over-period, venue context
   (unrealized) from the audit when available

## What exists (all compile + test green at time of writing)

- **Vendored library** `crates/vendor/accounting-core` — double-entry ledger,
  Indian GST (dormant under this use case), reconciliation engine (pure,
  4-pass). Invoice PDF renders via pdf_oxide.
- **Toolset** `crates/toolsets/accounting` (`accounting-tools`): 24 tools —
  ledger CRUD, 5 reports, GST calculator (dormant), invoice create/list,
  GSTR-1 export (dormant), 7 pattern writers, `reconcile_run`, `reconcile_csv`
  (paste **or** Library `file_id`), `venue_fills_import` (idempotent).
- **Storage**: per-user SQLite, migration `0034_accounting_ledger.sql`
  (`acct_*` tables; BigDecimal as TEXT, zero f64).
- **Agent + routing**: `builtin.accounting` (feature-gated); Monthly Close
  template, router `period` slot + question-intent guard; 24 tools seeded to
  Turso.
- **Frontend**: Monthly Close chip + form; Accounting context pane (Session +
  Library — the statement-upload intake).
- **Binance side**: `crypto_futures_trade_stats` (win rate/expectancy/profit
  factor, FIFO round-trips), `binance_futures_risk_audit` fixed pipeline,
  fills mirror sync.
- **Tests**: 115 router, 10 templates, 12 accounting-tools. **No agent_eval
  scenarios** — local-model tool-picking quality is uncalibrated.

## Activation plan (ordered)

1. **DONE** — per-pair data plumbing: migration `0035_accounting_fill_meta`
   (superseded by `0036_venue_fills` → `venue_fill_meta`), tools
   `trading_pnl_by_symbol(from, to, venue?)` +
   `trading_fee_summary(from, to, venue?)` +
   `books_auto_sync` (automatic audit wave, rolling 30-day window);
   `venue_fills_import` upserts fill metadata for every scanned fill.
2. **DONE** — audit wave "books sync": `append_books_sync_step` in
   supervisor.rs, appended at both `build_audit_plan` call sites
   (commands.rs + web.rs) behind
   `cfg(all(feature = "accounting", feature = "binance", not(android)))`;
   fully automatic, no consent gate.
3. **DONE** — Trading Performance as a FIXED pipeline (the `kawaii_desk`
   pattern): the plan builder lives in the domain crate
   (`accounting_tools::plan::build_trading_performance_plan`), the Tauri
   command `run_trading_performance` + web route run it directly, and the
   `trading_performance` router template wraps the SAME builder for
   free-text. The chip no longer touches the router or the planner at all —
   no string routing, no silent planner fallback. Steps: sync → stats →
   pnl-by-symbol → fee summary → integrity gate. Accounting write tools are
   **ungated** (decision 2026-10-18): the review gate is the consent, so no
   per-write dialog repeats it. `enforce_confirmation_policy` still runs in
   the plan executor — the single choke point every entry path passes
   (planner, router template, fixed command, resume) — which keeps any
   FUTURE gated tool honest.
4. **DONE** — agent_eval accounting suite (`EVAL_SUITE=accounting`): 7-tool
   manifest, 8 scenarios (F01–F08) incl. a no-invented-dates refusal; office
   suite untouched; harness tests pass without features.
5. **DONE** — dev flag: `accounting` back in `scripts/tauri.sh`.
6. **PENDING** — live smoke (user, manual): S1–S6 playbook on real synced
   fills.
7. **PENDING** — CI feature matrix + release bundles (product call).

Catalog: 27 accounting tools seeded to Turso. Known pre-existing (not from
this work): `kawai-db::usage` window test fails on main independent of the
accounting changes.

## Deferred personas (revisit after the wedge proves out)

- **UMKM / solo (biggest market, one sprint away)**: photo-nota → OCR →
  extraction → `txn_expense`. `kawai-vision` paddle-ocr exists; the missing
  piece is the OCR→LLM-extraction→proposal pipeline. Positioning question
  first: is kawai a trading app or an SME app?
- **Freelancer/consultant**: invoicing exists (invoice + auto-posting + PDF);
  missing AR aging + collection-draft templates.
- **India-GST businesses**: fully built and dormant (invoice, GSTR-1, GSTIN
  validation) — activates only if/when that market is chosen.

## Deferred (explicitly out, not forgotten)

- Mobile builds (android gate already in place)
- `plan_task` on kawai-web (plan execution is desktop-only today)
- Ledger dashboard / accounting context-pane data views
- parquet/xlsx statements into `reconcile_csv` (route via `data_export`)
- Spot-trade cost-basis policy (FIFO/average) — needed only if spot books
  become a requirement; futures fills carry Binance's own realized PnL
