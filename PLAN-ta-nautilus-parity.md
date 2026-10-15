# PLAN — `data_ta` indicator parity with NautilusTrader

Goal: close the gap between kawai's `data_ta` suite (50 canonical kinds in
`crates/engines/analytics/src/ta_suite.rs::kind_table`, currently backed by the
vendored `ta` crate) and NautilusTrader's indicator library. The repository
also vendors `crates/vendor/quant-indicators`, but `analytics` does **not**
depend on it today; it is currently consumed only by vendored `quant-metrics`
for HRP composition. NautilusTrader's list is
taken from knowledge of the upstream repo (the local Python env only has a
stub package — no `nautilus_trader.indicators` to enumerate) — **verify each
row against upstream sources when implementing.**

Architecture reminder: every new kind touches exactly one table plus two match
arms:

1. `kind_table()` ENTRIES row in `ta_suite.rs` (canonical kind + aliases +
   `Need` + default period) — the tool schema's `kind` enum and the Binance
   preset derive from `canonical_kinds()`, so nothing downstream needs editing.
2. `warmup()` match arm in `Resolved`.
3. `compute()` match arm (currently folds via `ta::indicators::*`,
   `fold_close!`/`fold_bar!`). New indicator types either go into
   `crates/vendor/ta/src/indicators/` (when they benefit other consumers),
   `crates/vendor/quant-indicators` (when Decimal/Candle batch semantics are
   preferable), or fold natively in `ta_suite.rs`.
4. Test: fold the indicator against a fixed CSV fixture in the analytics test
   module; assert the final value (or the JSON multi-field object).
5. If a new parameter is needed, prefer REUSING an existing `TaIndicator`
   field (`period`/`fast`/`slow`/`signal`/`multiplier`) with a documented
   mapping — only add a genuinely new field when no existing one fits.

## Vendored `quant-indicators` inventory

This crate is a useful implementation source, but not evidence of `data_ta`
coverage: `crates/engines/analytics/Cargo.toml` has no dependency on it. Its
`Indicator` trait is batch-oriented (`compute(&[quant_primitives::Candle]) ->
Series`), Decimal-backed, and currently provides: `Sma`, `Ema`, `Wma`,
`HullMa`, `Rsi`, `Macd`, `Momentum`, `EfficiencyRatio`, `BollingerBands`,
`Atr`, `StdDev`, `VarianceRatio`, `Supertrend`, `DetrendedOscillator`,
`VolumeSignalIndicator`, `Hrp`, and combinators (`Diff`, `Ratio`, `Lag`,
`Scale`, `Close`).

Most overlap with `data_ta` is already supplied by `ta`; unique potentially
useful items are **Momentum** (verify whether it should map to or remain
distinct from `roc`), the classification-oriented **VolumeSignalIndicator**,
and **HRP**. HRP is portfolio allocation, not a single-series TA indicator,
so it belongs in a portfolio/analytics operation rather than `data_ta`.
Do not migrate the existing suite merely to use this crate: that would change
f64/stream-fold behavior to Decimal/batch behavior without creating
NautilusTrader parity.

## Status legend

- ✅ parity — already exposed in kawai under the same semantics.
- 🟡 partial — concept exists but output/params differ (action noted).
- ➕ gap — not in kawai; proposed kind specified below.
- 🚫 not portable — microstructure/feed-native in Nautilus; does not fit the
  column-fold model over a file.

## Already at parity (no action)

| NautilusTrader | kawai kind | note |
|---|---|---|
| average/sma, ema, wma, rma, hma, dema, vidya, lr | `sma` `ema` `wma` `rma` `hma` `dema` `vidya` `lr` | lr outputs the full object (value/slope/intercept/degree/cfo/r2) |
| atr | `atr` / `tr` | |
| bias | `bias` | |
| bollinger_bands | `bb` | |
| cci | `cci` | |
| cmo | `cmo` | |
| donchian_channel | `dc` | |
| efficiency_ratio | `er` | |
| hurst_exponent | `hurst` | |
| ichimoku_cloud | `ichimoku` | |
| keltner_channel | `kc` + `kp` (position) | |
| klinger_volume_oscillator | `kvo` | |
| macd | `macd` | |
| maximum / minimum | `max` / `min` | |
| obv | `obv` | |
| pressure | `pressure` | |
| rsi | `rsi` | |
| stochastic_oscillator | `stoch_fast` / `stoch_slow` | |
| true_range | `tr` | |
| vwap | `vwap` | |
| variance_ratio (Lo-MacKinlay) | `vr_lm` | kawai's separate `vr` is VolatilityRatio (ATR slow/fast) — unrelated despite the shared abbreviation |
| ppo-family | `ppo` | |
| roc | `roc` | |

## 🟡 Partial parity (extend, don't duplicate)

| NautilusTrader | kawai today | action |
|---|---|---|
| dmi (DirectionalMovement → +DI/−DI/**ADX/ADXR**) | `dm` outputs only `pos`/`neg` | Extend the `dm` compute arm to carry `adx` (+ optional `adxr`) — same stateful fold, extra smoothed-ratio accumulators. Do NOT add a separate `adx` kind. |
| average/adaptive_moving_average (KAMA) | `ama` — ER-scaled EMA with a single `period_efficiency_ratio` param (no fast/slow smoothing constants) | Add a true `kama` kind with `period` + `fast` (fastest constant, default 2) + `slow` (slowest constant, default 30). Keep `ama` as-is. |
| average/emaclamp | — | Skip: a clamped-EMA wrapper, not a standalone indicator; no agent value. |

## ➕ Gaps — proposed kinds (portable)

Columns: **kind** (proposed canonical) · aliases · `Need` · defaults
(`period`/`fast`/`slow`/`signal`/`multiplier`) · output · warmup (bars before
the first real reading) · confidence that NautilusTrader ships it and that the
formula transcription is exact.

| kind | aliases | Need | defaults | output | warmup | conf |
|---|---|---|---|---|---|---|
| `zlema` | `zlema`, `zero_lag_ema` | CloseOnly | period 9 | f64 | period + lag + 1, lag = ⌊(p−1)/2⌋ | high |
| `tma` | `tma`, `triangular` | CloseOnly | period 9 | f64 | ~p + 2 (SMA of SMA, each leg ⌈p/2⌉) | high |
| `kama` | `kama` | CloseOnly | period 10, fast 2, slow 30 | f64 | period + 1 | high |
| `vwma` | `vwma` | Volume | period 20 | f64 | period | high |
| `wr` | `wr`, `willr`, `williams_r` | HighLow | period 14 | f64 (−100…0) | period | high |
| `vortex` | `vortex`, `vip` | HighLow | period 14 | `{pos, neg}` (VI+/VI−) | period + 1 | high |
| `fisher` | `fisher`, `fisher_transform` | HighLow | period 9 | `{fisher, signal}` | period + 1 | high |
| `chop` | `chop`, `choppiness` | HighLow | period 14 | f64 (0–100) | period + 1 | high |
| `mi` | `mi`, `mass_index` | HighLow | period 9, signal 25 (sum window) | f64 | period + signal | medium |
| `wt` | `wt`, `wavetrend` | HighLow | period 10, fast 21 (channel), signal 4? | `{wt1, wt2}` | fast + period | medium — verify channel/avg param names upstream |
| `crsi` | `crsi`, `connors_rsi` | CloseOnly | period 3, fast 2 (streak RSI), slow 100 (percent-rank window) | f64 (0–100) | slow + 1 | high |
| `ewma_sd` | `ewma_sd`, `ewma_std` | CloseOnly | period 20 (λ = 2/(p+1)) | f64 | period | high |
| `ma_cross` | `ma_cross`, `macross` | CloseOnly | fast 10, slow 50 | `{fast, slow, spread, state}` state ∈ {1,−1,0} | slow + 1 | high |
| `psar` | `psar`, `sar`, `parabolic_sar` | HighLow | signal 0.02 (accel step), multiplier 0.2 (accel max) — documented field reuse; no period | f64 (SAR value; optionally `{sar, trend}`) | 2 | high |
| `acc` | `acc`, `acc_channel`, `acceleration_bands` | HighLow | period 20, multiplier (default per upstream) | `{upper, lower}` | period | medium — verify band multiplier semantics |
| `wfractal` | `wfractal`, `williams_fractal` | HighLow | period 2 (fractal arm length) | `{up, down}` boolean flags | 2·period + 1 | medium |
| `zigzag` | `zigzag`, `zz` | HighLow | multiplier = deviation % (0.05) | `{lastPivot, direction, depth}` state summary — NOT the full path (output must stay small) | 2 | medium — upstream stores a path; kawai returns summary state |
| `quantile` | `quantile`, `qtl` | CloseOnly | period 20, q 0.5 (NEW param field) | f64 | period | high |
| `entropy` | `entropy`, `shannon` | CloseOnly | period 20, base e (reuse `multiplier`? no — verify upstream param) | f64 | period | medium |
| `prand` | `prand`, `p_rand` | CloseOnly | period 20 | f64 (random-walk probability) | period | low — verify formula upstream |
| `tscount` | `tscount` | CloseOnly | period 20 | f64 (turning-point count) | period | low — verify what Nautilus tscount counts |
| `fsk` | `fsk` | HighLow | period 13, signal 3 | `{fsk, signal}` | period + signal | low — composite Fisher/Stoch; verify formula |

## ➕ Gaps — portable with schema adaptation

| NautilusTrader | why not a plain row | adaptation needed |
|---|---|---|
| correlation, ewma_correlation | Needs TWO input columns; `TaArgs` has one `close` + per-kind `column` override only | Add optional `columnB` to `TaIndicator` (falls back to `column`). Kinds: `corr` (pearson over rolling window), `ewma_corr`. Output f64. |
| marubozu (candle pattern) | `Bar` (ta_suite private struct) has no `open` — `Open` trait impls to `close` | Add optional `open` to `TaArgs` → real `Bar.open`. Kind `marubozu` outputs `{bull, bear}` booleans. Only kind that consumes `open` so far. |
| pivots | Classic pivot points recompute per bar from a window; multi-field output (PP/R1–R3/S1–S3) | Kind `pivots`, HighLow, period 20. Output 7 fields — acceptable under the "final value only" rule. |
| value_area | Volume-profile computation (bins over price × volume) | Kind `value_area`, HighLowVolume, multiplier = VA % (0.7). Output `{poc, vah, val}`. Needs binning logic in ta_suite, not the `ta` crate. |

## 🚫 Not portable (microstructure / feed-native — out of scope)

These NautilusTrader indicators consume tick/order-book deltas or live feed
handlers, not ordered bars; the column-fold model over a stored file has no
equivalent input:

- `price_ticker` — rolling last/bid/ask from ticks.
- `imbalance` — order-book/trade imbalance.
- `spread_analysis` — bid/ask spread analytics.
- `sweep` — order-book sweeps.
- `vol_cliff` — intrabar volume deltas from a live feed.

If a future tier ever ingests L2/tick data, revisit — they belong in a new
tick-domain tool, not `data_ta`.

## Implementation order (suggested)

1. **Wave 1 — cheap close-only wins:** `zlema`, `tma`, `vwma`, `ewma_sd`, `ma_cross`, `quantile` (+ the single new `q` field).
2. **Wave 2 — bar kinds:** `wr`, `vortex`, `fisher`, `chop`, `psar`, plus the `dm`→ADX extension.
3. **Wave 3 — verify-heavy:** `kama` (full-constant version), `crsi`, `mi`, `wt`, `acc`, `wfractal`, `zigzag`, `entropy`, `prand`, `tscount`, `fsk`.
4. **Wave 4 — schema adaptations:** `columnB` + `corr`/`ewma_corr`, `open` column + `marubozu`, `pivots`, `value_area`.

Each wave ships one `kind_table` diff + one `canonical_kinds()`-derived schema
bump; the Binance preset list is pinned against the table (see the comment on
`kind_table()`), so re-derive it in the same commit.

## Open questions

- `entropy`/`prand`/`tscount`/`fsk` formulas need transcription against the
  upstream Cython/Rust sources at implementation time (low-confidence rows above).
- Whether NautilusTrader has gained new indicators since this comparison
  (list was compiled from knowledge, upstream moves fast) — re-diff before
  closing the item.
- Agent-value triage: microstructure kinds (🚫) are dropped, not deferred —
  `data_ta` serves file-based analysis, not live feeds.
