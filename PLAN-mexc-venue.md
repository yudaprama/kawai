# PLAN — MEXC as a second venue

## The shape of the problem

Binance was the only exchange, so nothing in the stack carries a venue: the
venue was a literal in a table name (`binance_futures_trades`), a Rust struct
name (`BinanceFill`), a tool name (`binance_import_trades`), an account id
(`binance-wallet`), a ledger transaction prefix (`bns_`), a credential table
(`binance_api_credentials`) and an agent id (`builtin.binance`). `VenueOutcome`
in `crates/toolsets/binance/src/venue_error.rs` is an error taxonomy, not a
venue identity.

The ledger is the one thing that must NOT fork per exchange: a trader who runs
Binance and MEXC has **one** books. So the venue seam goes in at the fill
boundary — the fills are stored per venue, everything downstream reads "one
venue" or "all venues".

## What is in place

| Piece | Where |
|---|---|
| `Venue` enum, `VenueFill` / `VenuePosition` / `VenueAsset`, `VenueError`, `VenueClient` trait | `crates/foundation/venue` |
| Venue-keyed storage: `venue_fills`, `venue_fill_meta`, `venue_credentials`, `venue_trading_consent` (Binance rows backfilled; old tables dropped; ledger ids rewritten `bns_` → `binance_`) | `crates/foundation/db/migrations/0036_venue_fills.sql` |
| Venue-generic ledger reads/writes, `venue_fills_import` (was `binance_import_trades`), venue-aware `books_auto_sync` / `trading_pnl_by_symbol` / `trading_fee_summary`, per-venue wallet accounts | `crates/toolsets/accounting` |
| Venue slot on the trading-performance plan, router template, Tauri command and Axum route | `crates/toolsets/accounting/src/plan.rs`, `src-tauri/src/{templates,commands,web,supervisor}.rs` |
| MEXC client: signer, fills (v2 + v3 fallback), positions, assets, public market data, own-keys-only credentials, probe example | `crates/toolsets/mexc` |
| `mexc_futures_fill_sync` writing `venue_fills`, dispatched through the ACCOUNTING agent's toolset (feature `mexc`); `mexc_credentials_{set,status,delete}` on both transports; the MEXC card in Settings; a venue selector on the trading-performance chip | `crates/toolsets/mexc/src/{sync,registry}.rs`, `src-tauri/src/logic/mexc_credentials.rs`, `frontend/src/features/credentials/providers/mexc.tsx` |
| The audit offer's two placement batches on MEXC — `mexc_auto_protect_positions` / `mexc_auto_take_profit_positions` (both transports), placing reduce-only **plan orders** at the levels the shared risk crate recommends | `crates/toolsets/mexc/src/protect.rs`, `src-tauri/src/logic/mexc_trade.rs`, `frontend/src/features/workbench/components/binance-audit-offer.tsx` |

## Why the MEXC protocol needs care

MEXC signs with **HMAC-SHA256, raw secret as key**, over
`apiKey + requestTime + parameterString` in the `Signature` header — not a
query-string `signature` like the spot v3 API. Two traps, both handled in
`crates/toolsets/mexc/src/signer.rs` and pinned by tests:

1. GET/DELETE sign the **sorted but URL-unencoded** query while the request
   line carries the percent-encoded one. Signing a single string and sending it
   is the classic failure.
2. POST signs the **raw JSON body**, so key order matters (compact, alphabetical
   — `BTreeMap` gives that deterministically).

Rate limit on the private fills endpoints: 20 requests / 2 s.

Field translation (`crates/toolsets/mexc/src/fills.rs`), MEXC → `VenueFill`:

| Venue field | `VenueFill` | Note |
|---|---|---|
| `id` | `trade_id` | numeric string, fits i64 |
| `vol` | `qty` | |
| `price` | `price` | |
| `quote_qty` | — | derived as `price × vol` |
| `profit` | `realized_pnl` | **UNVERIFIED**: signed? settlement asset? |
| `fee` / `feeCurrency` | `commission` / `commission_asset` | **UNVERIFIED**: always positive? |
| `taker` | `maker` | inverted — MEXC reports taker, Binance reports maker |
| `side` (`"1"`/`"2"`) | `side` | **UNVERIFIED**: open/close? buy/sell? |
| `category` | `DealKind` | **UNVERIFIED** |
| `positionType` (`1`/`2`, JSON number) | `position_side` + size sign | confirmed 2026-10-20 (`1` long, `2` short; read via `positions::position_type_code`) |
| `positionMode` | — | isolated/cross, Binance reports it separately |

Every unverified mapping is a single named function or constant with a doc
comment, so the probe result fixes one line each.

## Open protocol questions (need a live MEXC account)

1. **v2 vs v3 fills.** `/api/v1/private/order/list/order_deals` takes
   `start_time`/`end_time` and pages cross-symbol; the `v3` variant in the
   official demo requires `symbol`. The client tries v2 and falls back to v3 on
   rejection — which is slow if v2 does not exist.
2. **Host.** The demo material names `api.mexc.com`, `contract.mexc.com` and
   `api.mexc.co`. The client uses `contract.mexc.com` and
   `KAWAI_MEXC_REST_BASE` overrides it.
3. **`side` / `category` semantics** — see the table above.
4. **Deal-history retention.** Binance's `/fapi/v1/userTrades` reaches far
   back; MEXC's window is unverified and `books_auto_sync` defaults to 30 days.
5. **Fee sign** — the ledger posts a fee only when positive; a credited
   (negative) fee would silently vanish until the sign is mapped.

Run `cargo run -p mexc --example mexc_probe` with MEXC keys in the demo user's
local DB. It prints the answering base URL, the raw fills payload, the parsed
count, positions, assets, and a one-line `VERDICT:` naming what the payload
does and does not settle.

## Remaining phases

**P3a — DONE: the live mirror and the desk.** `venue_positions` /
`venue_open_orders` (migration 0037, Binance rows backfilled), `mexc_futures_positions`
writing the same tables with a venue-scoped prune, the desk accepting MEXC's
`BTC_USDT` spelling and asking every venue for the user's own realized record,
and a shared frontend card both venues render.

**P3b — DONE: shared risk crate + MEXC audit.** The shared crate
`crates/engines/futures-risk` (`kawai-futures-risk`) now owns the candle
fetch + stop-spec math, keyed on a `CandleSource` trait; Binance's 162 tests
and `stop_grading_envelope_is_golden` still pass on it, so the extraction
changed nothing. MEXC now grades through the SAME policy via
`mexc_futures_risk_audit` + `mexc_futures_audit_data` (read-only; empty mirror
returns an actionable guidance error instead of syncing), mapping
`4h`→`Hour4`/`1h`→`Min60`/… in one named function, with coverage + naked-
notional rollup and the same envelope the Binance card renders. The frontend
renders both under `renderBinanceFuturesRiskAudit`.

**P3 — positions and the audit.** `venue_positions` mirror, `mexc_futures_positions`,
venue-aware `symbol_realized_record` and the desk `LedgerFn`
(`crates/engines/desk/src/tool.rs:1949`, bound at `supervisor.rs:2516`),
`build_audit_plan` generalized, and `crypto_pair`
(`crates/engines/desk/src/tool.rs:502`) taught the `BTC_USDT` underscore form.

**P4 — execution.** DONE: order placement/cancel (`mexc_futures_create_order`,
`mexc_futures_cancel_order`) and the post-audit offer's two batches — protective stops and the advised
take-profit ladder — as reduce-only plan orders
(`crates/toolsets/mexc/src/protect.rs`). Levels come from
`kawai-futures-risk`, the same policy the audit grades with; coverage is read
from BOTH the book and the untriggered plan orders (MEXC keeps conditional
orders out of the resting book, so the book alone would re-stop a position);
prices and sizes are floored to the contract's own `priceUnit` / `volUnit`
from `/contract/detail`, never to a guessed tick. Still open: a stop-MOVE
batch (MEXC has none, so the offer lists no "tighten" row there) and per-venue
trading consent (`venue_trading_consent`, Binance-only today).

## Deployment note

The shared tool catalog (Turso) still holds a `binance_import_trades` row. Run
`cargo run --release --example seed_tool_catalog --features litert,binance,monad,accounting,mexc -- --prune`
after this ships, or the catalog keeps suggesting a tool the registry cannot
dispatch (`run_tool_search` guards against the hit, but the hit itself is
noise).

## Fixed along the way

- `binance_import_trades` over an unsynced window returned
  `{"scanned": 0}` — success-shaped, meaning "the exchange says you did not
  trade". It now fails with guidance naming the missing sync.
- The fill history had exactly one writer (`crypto_futures_trade_stats`), so
  the import silently posted nothing on a cold database. A venue-scoped review
  now emits that venue's sync step ahead of the import and makes the import
  depend on it, so a MEXC review fetches before it posts.

## Proof so far

|Claim|Evidence|
|---|---|
|An existing books survives the venue cutover|`kawai-db` `venue_cutover_carries_an_existing_books_across` — fills, mirror, credentials, consent fingerprint and the rewritten ledger ids|
|Two venues post into two wallets, idempotently|`accounting-tools` `venue_import_posts_fills_idempotently_per_wallet`|
|An unsynced venue fails with guidance; an untraded month does not|`venue_import_refuses_an_unsynced_window`, `venue_import_reports_an_untraded_window_without_erroring`|
|A MEXC review dispatches real tools in the real merged registry|`supervisor::a_mexc_scoped_trading_plan_fetches_before_it_imports` — fetch first, import depends on it, `validate_plan` passes|
|MEXC signing is byte-correct|the `mexc` signer tests pin three digests with their python3 derivation in the comment|
|A MEXC sync never deletes another venue's mirror|`mexc` `another_venues_rows_survive_a_mexc_sync`|
|A closed MEXC position leaves the mirror, an open one is replaced not appended|`second_write_prunes_the_vanished_position`, `changed_mark_replaces_rather_than_appends`|
|The merged registry reaches the MEXC mirror|`supervisor::the_merged_registry_carries_the_mexc_positions_mirror`|
|The positions cutover carries an open book across|`kawai-db` `venue_positions_cutover_carries_the_open_set_across`|
|Live protocol behaviour|`mexc_probe` — needs a MEXC account; not yet run|