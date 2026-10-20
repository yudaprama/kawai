import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BinanceAuditForm, ownsAuditScope } from "./binance-audit-form";
import { auditRunStep, parseAuditOffer, placementSummary, tightenSummary } from "./binance-audit-offer";
import { GoalTemplates, templateOpensAudit, templateOpensDesk, templateOpensYoutube } from "./goal-templates";

/**
 * Render-level smoke for the Futures Risk Audit landing entry. The properties
 * worth pinning are the ones a user would notice breaking: the form must offer
 * exactly the presets the backend accepts (an unknown interval silently falls
 * back to `4h`, so a drifted chip is a silent lie), every chip must announce
 * its pressed state, the read-only guarantee must stay on screen — this
 * panel asks about real money — and NO placement controls may appear here:
 * placement is offered by the audit's run view (BinanceAuditOffer), where the
 * user reviews the report first.
 *
 * The credential read (`binance_credentials_status` / `mexc_credentials_status`)
 * runs in an effect, which `renderToStaticMarkup` never fires, so both sources
 * stay null here and the no-keys branch is covered by its own assertion on the
 * pure predicate below.
 */

const render = () => renderToStaticMarkup(<BinanceAuditForm onSubmit={() => {}} />);

describe("BinanceAuditForm", () => {
  it("offers exactly the backend's candle intervals", () => {
    const html = render();
    for (const iv of ["15m", "1h", "4h", "1d", "1w"]) {
      expect(html).toContain(`>${iv}</button>`);
    }
    // A near-miss preset would be normalized server-side to `4h` — the chip
    // must not exist at all.
    expect(html).not.toContain(">4hr</button>");
  });

  it("offers exactly the backend's stop-distance presets", () => {
    const html = render();
    for (const r of ["Tight", "Standard", "Wide"]) {
      expect(html).toContain(`>${r}</button>`);
    }
    expect(html).not.toContain(">Loose</button>");
  });

  it("caps the graded positions at the tool's maximum and offers the whole book", () => {
    const html = render();
    expect(html).toContain(">50</button>");
    expect(html).toContain(">All</button>");
    expect(html).not.toContain(">100</button>");
  });

  it("marks the active preset with aria-pressed so the selection is announced", () => {
    const html = render();
    // Defaults are Binance / 4h / Standard / 25 / All — each of the FIVE
    // groups must render exactly one pressed chip (the exchange row is a
    // preset group like the others).
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(5);
  });

  it("offers exactly the two venues the fixed audit pipeline has a plan for", () => {
    const html = render();
    expect(html).toContain(">Binance</button>");
    expect(html).toContain(">MEXC</button>");
    // A venue without an audit command would 404 the submit after the gates.
    expect(html).not.toContain(">OKX</button>");
  });

  it("offers exactly the backend's market scopes", () => {
    const html = render();
    expect(html).toContain(">All</button>");
    expect(html).toContain(">USDⓈ-M</button>");
    expect(html).toContain(">COIN-M</button>");
    // The scope names ride the backend enum verbatim — an unknown chip would
    // silently fall back to "all" server-side and grade the wrong book.
    expect(html).not.toContain(">Spot</button>");
  });

  it("keeps the read-only guarantee on screen", () => {
    const html = render();
    expect(html).toContain("never places, modifies, or cancels an order");
    // And it says WHERE placement happens instead.
    expect(html).toContain("run view offers");
  });

  it("offers no placement on the landing form — the audit proposes, the run view approves", () => {
    const html = render();
    // The old inline placement UI must stay gone (it moved to the run view's
    // BinanceAuditOffer, behind the report the user is meant to read first).
    expect(html).not.toContain("Protect naked book");
    expect(html).not.toContain("trigger price");
    expect(html).not.toContain("Or place one yourself");
  });
});

describe("parseAuditOffer", () => {
  const matrix = JSON.stringify({
    params: { interval: "1h", risk: "tight", limit: 10 },
    summary: { usdmPositions: 4, graded: 4, withStopLoss: 2, naked: 2, nakedNotional: 123.5, withTakeProfit: 3 },
  });

  it("extracts the counts and the echoed params the placement re-runs under", () => {
    const offer = parseAuditOffer(matrix);
    expect(offer).not.toBeNull();
    expect(offer?.naked).toBe(2);
    expect(offer?.noTp).toBe(1);
    expect(offer?.params).toEqual({ interval: "1h", risk: "tight", limit: 10 });
  });

  it("falls back to the tool defaults when the params echo is missing", () => {
    const legacy = JSON.stringify({ summary: { usdmPositions: 1, graded: 1, naked: 0, withTakeProfit: 1 } });
    const offer = parseAuditOffer(legacy);
    expect(offer?.params).toEqual({ interval: "4h", risk: "standard", limit: 25 });
    expect(offer?.naked).toBe(0);
  });

  it("lists only actionable rows with the engine-computed levels", () => {
    const rich = JSON.stringify({
      params: { interval: "4h", risk: "standard", limit: 25 },
      summary: { usdmPositions: 4, graded: 4, withStopLoss: 1, naked: 3, nakedNotional: 1, withTakeProfit: 1 },
      // The wire key is `positions` (risk_audit's emit) — pin it so a rename
      // on either side fails this test instead of silently emptying the offer.
      positions: [
        {
          // Naked + no TP: both actions list it. The 2R rung already traded
          // through — the batch never places it, so it must be dropped.
          symbol: "BTCUSDT",
          positionAmt: 1.5,
          markPrice: 98000,
          // In profit — the "Dalam untung" scope keys off this.
          unRealizedProfit: 4200,
          restingStops: 0,
          restingTps: 0,
          advice: {
            symbol: "BTCUSDT",
            verdict: "missing",
            recommended: { price: 95000, method: "chandelier_exit", distancePct: 3.06 },
            takeProfit: {
              shape: "ladder_runner",
              verdict: "missing",
              rungs: [
                { label: "1R", price: 101000, allocPct: 40, passed: false },
                { label: "2R", price: 104000, allocPct: 30, passed: true },
              ],
              bandExit: null,
            },
          },
        },
        {
          // Resting orders exist: the batch skips this position even though
          // the advice carries recommendations — neither list may show it.
          symbol: "ETHUSDT",
          positionAmt: -2,
          markPrice: 3000,
          restingStops: 1,
          restingTps: 1,
          advice: {
            symbol: "ETHUSDT",
            verdict: "ok",
            recommended: { price: 3200, method: "dc20", distancePct: 6.6 },
            takeProfit: {
              shape: "ladder",
              verdict: "missing",
              rungs: [{ label: "1R", price: 2900, allocPct: 100, passed: false }],
            },
          },
        },
        {
          // Band-exit shape: no rungs, one whole-position level.
          symbol: "SOLUSDT",
          positionAmt: -10,
          markPrice: 150,
          // In loss — must be EXCLUDED by the winners-only scope.
          unRealizedProfit: -85.5,
          restingStops: 0,
          restingTps: 0,
          advice: {
            symbol: "SOLUSDT",
            verdict: "missing",
            recommended: null,
            takeProfit: {
              shape: "band_exit",
              verdict: "missing",
              rungs: [],
              bandExit: { method: "donchian_20", price: 140 },
            },
          },
        },
        {
          // Grading failed (thin market): no advice, nothing to offer.
          symbol: "XRPUSDT",
          positionAmt: 100,
          markPrice: 0.5,
          restingStops: 0,
          restingTps: 0,
          advice: { symbol: "XRPUSDT", error: "only 12 usable candles returned" },
        },
      ],
    });
    const offer = parseAuditOffer(rich);
    expect(offer?.stops).toEqual([
      {
        symbol: "BTCUSDT",
        long: true,
        size: 1.5,
        mark: 98000,
        price: 95000,
        method: "chandelier_exit",
        distancePct: 3.06,
      },
    ]);
    expect(offer?.tps).toEqual([
      {
        symbol: "BTCUSDT",
        long: true,
        size: 1.5,
        mark: 98000,
        shape: "ladder_runner",
        rungs: [{ label: "1R", price: 101000, allocPct: 40 }],
        bandExit: null,
        trailingExit: null,
      },
      {
        symbol: "SOLUSDT",
        long: false,
        size: 10,
        mark: 150,
        shape: "band_exit",
        rungs: [],
        bandExit: { method: "donchian_20", price: 140 },
        trailingExit: null,
      },
    ]);
    // The approval table merges both sides per symbol: BTCUSDT (stop + TP in
    // one row), SOLUSDT (TP only), while the resting-covered and error rows
    // stay out.
    expect(offer?.rows).toEqual([
      {
        symbol: "BTCUSDT",
        entry: 0,
        long: true,
        size: 1.5,
        mark: 98000,
        notional: 147000,
        pnl: 4200,
        riskReward: null,
        sl: { price: 95000, method: "chandelier_exit", distancePct: 3.06 },
        locked: false,
        tighten: null,
        tp: {
          symbol: "BTCUSDT",
          long: true,
          size: 1.5,
          mark: 98000,
          shape: "ladder_runner",
          rungs: [{ label: "1R", price: 101000, allocPct: 40 }],
          bandExit: null,
          trailingExit: null,
        },
      },
      {
        symbol: "SOLUSDT",
        entry: 0,
        long: false,
        size: 10,
        mark: 150,
        notional: 1500,
        pnl: -85.5,
        riskReward: null,
        sl: null,
        tighten: null,
        locked: false,
        tp: {
          symbol: "SOLUSDT",
          long: false,
          size: 10,
          mark: 150,
          shape: "band_exit",
          rungs: [],
          bandExit: { method: "donchian_20", price: 140 },
          trailingExit: null,
        },
      },
    ]);
  });

  it("keeps a trailing-only exit that has no rungs and no band", () => {
    // The parser dropped `trailingExit`, so a `trailing_only` position — the
    // one shape with neither rungs nor a band — lost its whole take-profit
    // row and read as "nothing to place" for the runner leg it does have.
    const out = JSON.stringify({
      summary: { usdmPositions: 2, graded: 2, withStopLoss: 0, naked: 2, nakedNotional: 1, withTakeProfit: 0 },
      positions: [
        {
          symbol: "BTCUSDT",
          positionAmt: 0.002,
          markPrice: 98000,
          restingStops: 0,
          restingTps: 0,
          advice: {
            verdict: "missing",
            recommended: { price: 95000, method: "chandelier_exit", distancePct: 3.06 },
            takeProfit: {
              shape: "trailing_only",
              verdict: "trailing",
              rungs: [],
              bandExit: null,
              trailingExit: { method: "chandelier_exit", price: 94000.5 },
            },
          },
        },
      ],
    });
    const offer = parseAuditOffer(out);
    expect(offer?.tps).toHaveLength(1);
    expect(offer?.rows[0].tp).toMatchObject({
      shape: "trailing_only",
      rungs: [],
      bandExit: null,
      trailingExit: { method: "chandelier_exit", price: 94000.5 },
    });
  });

  it("keeps a profit-locked position in the table even with nothing to place", () => {
    // A stop at/beyond entry grades `ok`, so it lands in no side list — no
    // stop to place, nothing to tighten, and advice never rolls it back. The
    // panel would then drop the one row whose remaining decision is real:
    // trail it higher. `profitLocked` is what keeps it visible.
    const out = JSON.stringify({
      summary: { usdmPositions: 1, graded: 1, withStopLoss: 1, naked: 0, nakedNotional: 0, withTakeProfit: 1 },
      positions: [
        {
          symbol: "BTCUSDT",
          positionAmt: 1.5,
          entryPrice: 95000,
          markPrice: 98000,
          unRealizedProfit: 4500,
          restingStops: 1,
          restingTps: 1,
          stopLoss: { present: true, price: 95600, distancePct: 2.45 },
          advice: {
            verdict: "ok",
            profitLocked: true,
            recommended: { price: 95600, method: "breakeven_lock", distancePct: 2.45 },
            alternatives: [{ price: 94000, method: "donchian_20", distancePct: 4.08 }],
          },
        },
      ],
    });
    const offer = parseAuditOffer(out);
    expect(offer?.stops).toHaveLength(0);
    expect(offer?.tightens).toHaveLength(0);
    expect(offer?.rows).toHaveLength(1);
    expect(offer?.rows[0].locked).toBe(true);
    expect(offer?.rows[0].sl).toBeNull();
    expect(offer?.rows[0].tighten).toBeNull();
  });

  it("does not flag a plain aligned stop as locked", () => {
    // `pnl > 0` alone reads as "already tight", so a position that is merely
    // profitable with a structural stop below entry must not be told to trail.
    // Only the engine's flag means a lock — this one is a real `tighten`, so
    // the row exists and must read as not-locked.
    const out = JSON.stringify({
      summary: { usdmPositions: 1, graded: 1, withStopLoss: 1, naked: 0, nakedNotional: 0, withTakeProfit: 1 },
      positions: [
        {
          symbol: "ETHUSDT",
          positionAmt: 5,
          entryPrice: 3000,
          markPrice: 3200,
          unRealizedProfit: 1000,
          restingStops: 1,
          restingTps: 1,
          stopLoss: { present: true, price: 2800, distancePct: 12.5 },
          advice: {
            verdict: "tighten",
            profitLocked: false,
            recommended: { price: 2880, method: "breakeven_lock", distancePct: 10 },
            alternatives: [],
          },
        },
      ],
    });
    const offer = parseAuditOffer(out);
    expect(offer?.tightens).toHaveLength(1);
    expect(offer?.rows[0].locked).toBe(false);
    expect(offer?.rows[0].tighten).toEqual({
      from: 2800,
      to: 2880,
      method: "breakeven_lock",
    });
  });

  it("carries the comparable notional and the engine's R:R on every row", () => {
    // The approval table is read in risk order, and raw coin counts are not
    // comparable across symbols (0.002 BTC vs 5,491 ZORA) — a row must carry
    // |size| × mark so the visible order matches the backend's ranking.
    const out = JSON.stringify({
      summary: { usdmPositions: 2, graded: 2, withStopLoss: 0, naked: 2, nakedNotional: 1, withTakeProfit: 0 },
      positions: [
        {
          symbol: "BTCUSDT",
          positionAmt: 0.002,
          entryPrice: 101000,
          markPrice: 98000,
          restingStops: 0,
          restingTps: 0,
          riskReward: 2.4,
          advice: {
            verdict: "missing",
            recommended: { price: 95000, method: "chandelier_exit", distancePct: 3.06 },
            takeProfit: {
              shape: "ladder",
              verdict: "missing",
              rungs: [{ label: "1R", price: 104000, allocPct: 100, passed: false }],
              bandExit: null,
            },
          },
        },
        {
          symbol: "ZORAUSDT",
          positionAmt: 5491,
          markPrice: 0.007342,
          restingStops: 0,
          restingTps: 0,
          advice: {
            verdict: "missing",
            recommended: { price: 0.007, method: "keltner_10_2", distancePct: 4.27 },
            takeProfit: {
              shape: "ladder",
              verdict: "missing",
              rungs: [{ label: "1R", price: 0.008, allocPct: 100, passed: false }],
              bandExit: null,
            },
          },
        },
      ],
    });
    const offer = parseAuditOffer(out);
    // Smallest coin count, largest exposure — the ordering the table shows.
    expect(offer?.rows[0].notional).toBe(196);
    expect(offer?.rows[1].notional).toBeCloseTo(40.3149, 3);
    // A missing R:R stays null rather than becoming a fabricated 0.
    expect(offer?.rows.map((r) => r.riskReward)).toEqual([2.4, null]);
    // The entry is carried so the R:R column can anchor to it — the mark has
    // already run past a deep loss, so anchoring there invents absurd ratios.
    expect(offer?.rows.map((r) => r.entry)).toEqual([101000, 0]);
  });

  it("carries the exchange's unrealized P&L so the winners-only scope needs no extra fetch", () => {
    // The "Dalam untung" filter reads `pnl`. Two failure modes matter: a
    // row that silently reads 0 when the wire HAD a figure would exclude a
    // profitable position, and a non-finite/absent figure must never pass a
    // >0 test.
    const pos = (symbol: string, pnl: unknown) => ({
      symbol,
      positionAmt: 1,
      entryPrice: 100,
      markPrice: 110,
      ...(pnl === undefined ? {} : { unRealizedProfit: pnl }),
      restingStops: 0,
      restingTps: 0,
      advice: {
        verdict: "missing",
        recommended: { price: 105, method: "chandelier_exit", distancePct: 4.5 },
      },
    });
    const out = JSON.stringify({
      summary: { usdmPositions: 4, graded: 4, withStopLoss: 0, naked: 4, nakedNotional: 1, withTakeProfit: 0 },
      positions: [pos("WINUSDT", 42.5), pos("LOSUSDT", -12.25), pos("FLATUSDT", 0), pos("NOPNLUSDT", undefined)],
    });
    const offer = parseAuditOffer(out);
    expect(offer?.rows.map((r) => [r.symbol, r.pnl])).toEqual([
      ["WINUSDT", 42.5],
      ["LOSUSDT", -12.25],
      ["FLATUSDT", 0],
      ["NOPNLUSDT", 0],
    ]);
    // Exactly what the filter admits: strictly positive. Break-even is not
    // "in profit", and a missing figure must not sneak through as 0 > 0.
    const winners = offer?.rows.filter((r) => r.pnl > 0).map((r) => r.symbol);
    expect(winners).toEqual(["WINUSDT"]);
  });

  it("rejects anything that is not a readable audit matrix", () => {
    expect(parseAuditOffer(null)).toBeNull();
    expect(parseAuditOffer("")).toBeNull();
    expect(parseAuditOffer("not json {")).toBeNull();
    expect(parseAuditOffer(JSON.stringify({ summary: { naked: "many" } }))).toBeNull();
    expect(parseAuditOffer(JSON.stringify({ ok: true }))).toBeNull();
  });

  it("lists a `tighten` verdict as a MOVE, never as a stop to place", () => {
    // The stop-move population: a stop already rests, and the engine grades
    // it `tighten`. The row must carry BOTH levels — an arrow with only the
    // destination leaves the operator unable to judge the move — and must
    // stay out of `stops`, or the protect batch would place a SECOND stop
    // next to the one the move is about to cancel.
    const out = JSON.stringify({
      params: { interval: "4h", risk: "standard", limit: 25 },
      summary: { usdmPositions: 2, graded: 2, withStopLoss: 2, naked: 0, nakedNotional: 0, withTakeProfit: 0 },
      positions: [
        {
          symbol: "BTCUSDT",
          positionAmt: 1,
          entryPrice: 98000,
          markPrice: 110000,
          unRealizedProfit: 12000,
          restingStops: 1,
          restingTps: 0,
          stopLoss: { present: true, price: 95000, distancePct: 13.64 },
          advice: {
            verdict: "tighten",
            recommended: { price: 98098, method: "breakeven_lock", distancePct: 10.82 },
          },
        },
        {
          // Already locked in profit: the policy refuses to roll a locked stop
          // back, so the verdict is `ok` and the panel must not offer a move.
          symbol: "ETHUSDT",
          positionAmt: 10,
          entryPrice: 2900,
          markPrice: 3200,
          unRealizedProfit: 3000,
          restingStops: 1,
          restingTps: 0,
          stopLoss: { present: true, price: 2903, distancePct: 9.28 },
          advice: { verdict: "ok", recommended: { price: 3200, method: "chandelier_exit", distancePct: 0 } },
        },
      ],
    });
    const offer = parseAuditOffer(out);
    expect(offer?.tightens).toEqual([
      {
        symbol: "BTCUSDT",
        long: true,
        size: 1,
        mark: 110000,
        from: 95000,
        to: 98098,
        method: "breakeven_lock",
      },
    ]);
    // Never a placement — the stop it would "place" already exists.
    expect(offer?.stops).toEqual([]);
    const row = offer?.rows.find((r) => r.symbol === "BTCUSDT");
    expect(row?.sl).toBeNull();
    expect(row?.tighten).toEqual({ from: 95000, to: 98098, method: "breakeven_lock" });
    // ETHUSDT is not in `rows` at all: its stop is already `ok` and it has no
    // take-profit, so nothing about it is actionable — the panel must not
    // carry a row whose every action would be a no-op.
    expect(offer?.rows.map((r) => r.symbol)).toEqual(["BTCUSDT"]);
  });

  it("never offers a move to a level that is not tighter than the resting stop", () => {
    // A `tighten` verdict whose recommendation sits on the wrong side of the
    // resting stop would be a LOOSEN — the panel must drop it rather than
    // show an arrow that widens the risk. Long: destination must exceed the
    // resting stop. Short: it must be below.
    const row = (symbol: string, amt: number, from: number, to: number) => ({
      symbol,
      positionAmt: amt,
      entryPrice: 100,
      markPrice: 120,
      restingStops: 1,
      restingTps: 0,
      stopLoss: { present: true, price: from, distancePct: 10 },
      advice: { verdict: "tighten", recommended: { price: to, method: "breakeven_lock" } },
    });
    const out = JSON.stringify({
      summary: { usdmPositions: 3, graded: 3, withStopLoss: 3, naked: 0, nakedNotional: 0, withTakeProfit: 0 },
      positions: [row("LOOSENLONG", 1, 100, 95), row("TIGHTENLONG", 1, 100, 105), row("LOOSENSHORT", -1, 100, 105)],
    });
    const offer = parseAuditOffer(out);
    expect(offer?.tightens.map((t) => t.symbol)).toEqual(["TIGHTENLONG"]);
  });
});

describe("MEXC audit offer", () => {
  /** Producer-shaped fixture: the MEXC audit emits counts under `coverage`
   * (book size `positions`), and its rows carry the same coverage/advice keys
   * the Binance audit does. Hand-written shapes are what made the accounting
   * cards render raw JSON; this is the payload `build_payload` emits. */
  const raw = JSON.stringify({
    kind: "mexc_risk_audit",
    venue: "mexc",
    market: "USDTM",
    params: { interval: "4h", risk: "standard", limit: 25, market: "USDTM" },
    coverage: {
      positions: 2,
      graded: 2,
      withStopLoss: 1,
      naked: 1,
      withTakeProfit: 1,
      nakedNotional: 12000,
      slVerdicts: { missing: 1, tighten: 1 },
    },
    summary: { positions: 2, skippedByCap: 0, totalNotional: 30000, totalUnrealizedPnl: 40 },
    positions: [
      {
        venue: "mexc",
        market: "USDTM",
        symbol: "BTC_USDT",
        positionSide: "LONG",
        positionAmt: 0.2,
        entryPrice: 60000,
        markPrice: 61000,
        unRealizedProfit: 200,
        notionalAbs: 12200,
        riskReward: null,
        restingStops: 0,
        restingTps: 0,
        graded: true,
        advice: {
          symbol: "BTC_USDT",
          verdict: "missing",
          atr: 900,
          profitLocked: false,
          recommended: { price: 59200, method: "chandelier_exit", distancePct: 2.95 },
          alternatives: [],
          notes: [],
          takeProfit: {
            shape: "ladder",
            rungs: [{ label: "1R", price: 62800, allocPct: 50, passed: false }],
            bandExit: null,
            trailingExit: null,
          },
        },
      },
      {
        venue: "mexc",
        market: "USDTM",
        symbol: "ETH_USDT",
        positionSide: "LONG",
        positionAmt: 3,
        entryPrice: 2500,
        markPrice: 2560,
        unRealizedProfit: 180,
        notionalAbs: 7680,
        riskReward: 2.1,
        stopLoss: { present: true, price: 2400, distancePct: 6.25 },
        takeProfit: { present: true, resting: 1, nearestPrice: 2700, distancePct: 5.47 },
        restingStops: 2,
        restingTps: 1,
        graded: true,
        advice: {
          symbol: "ETH_USDT",
          verdict: "tighten",
          atr: 60,
          profitLocked: false,
          recommended: { price: 2480, method: "atr_multiple", distancePct: 3.1 },
          alternatives: [],
          notes: [],
        },
      },
    ],
  });

  it("reads the counts block MEXC actually emits", () => {
    const offer = parseAuditOffer(raw, "mexc");
    expect(offer).not.toBeNull();
    expect(offer?.naked).toBe(1);
    expect(offer?.noTp).toBe(1);
    expect(offer?.params.interval).toBe("4h");
  });

  it("offers only the sides a MEXC placement op can execute", () => {
    const offer = parseAuditOffer(raw, "mexc");
    // The naked position: stop + ladder. The protected one has a resting TP
    // and its loosen-stop verdict has NO MEXC move batch, so it is not listed
    // at all rather than approved into a no-op.
    expect(offer?.stops.map((s) => s.symbol)).toEqual(["BTC_USDT"]);
    expect(offer?.tps.map((t) => t.symbol)).toEqual(["BTC_USDT"]);
    expect(offer?.tightens).toEqual([]);
    expect(offer?.rows.map((r) => r.symbol)).toEqual(["BTC_USDT"]);
  });

  it("stays unreadable as a Binance audit — the two envelopes differ", () => {
    expect(parseAuditOffer(raw)).toBeNull();
  });
});

describe("auditRunStep", () => {
  it("finds the audit step among a run's steps", () => {
    expect(
      auditRunStep([
        { tool: "web_search", stepId: "s1" },
        { tool: "binance_futures_risk_audit", stepId: "audit_positions" },
      ]),
    ).toEqual({ stepId: "audit_positions", venue: "binance" });
  });

  it("reads a MEXC audit as MEXC — the other venue's ops can place nothing", () => {
    expect(
      auditRunStep([
        { tool: "mexc_futures_audit_data", stepId: "s1" },
        { tool: "mexc_futures_risk_audit", stepId: "mexc_audit" },
      ]),
    ).toEqual({ stepId: "mexc_audit", venue: "mexc" });
  });

  it("returns null for any other run", () => {
    expect(auditRunStep([{ tool: "deliverable_writer", stepId: "__deliverable" }])).toBeNull();
    expect(auditRunStep(undefined)).toBeNull();
  });
});

describe("goal templates", () => {
  it("routes the audit template to the audit form only", () => {
    expect(templateOpensAudit("binanceAudit")).toBe(true);
    expect(templateOpensAudit("stock")).toBe(false);
    expect(templateOpensAudit("crypto")).toBe(false);
    expect(templateOpensAudit("youtube")).toBe(false);
    expect(templateOpensAudit(null)).toBe(false);
  });

  it("leaves the desk and youtube panels on their own templates", () => {
    expect(templateOpensDesk("crypto")).toBe(true);
    expect(templateOpensDesk("binanceAudit")).toBe(false);
    expect(templateOpensYoutube("youtube")).toBe(true);
    expect(templateOpensYoutube("binanceAudit")).toBe(false);
  });

  it("allows the audit only under the user's own keys", () => {
    // The built-in pair signs as the PRODUCT account — auditing it grades
    // someone else's exposure, so it must not pass this gate.
    expect(ownsAuditScope("user")).toBe(true);
    expect(ownsAuditScope("baked")).toBe(false);
    expect(ownsAuditScope("none")).toBe(false);
    // Not read yet: the form must not block on an unanswered question — the
    // backend re-checks and fails closed.
    expect(ownsAuditScope(null)).toBe(true);
  });

  it("lists the audit template in the picker", () => {
    const html = renderToStaticMarkup(<GoalTemplates value={null} onChange={() => {}} />);
    expect(html).toContain("Futures Risk Audit");
  });
});

describe("placement result failures", () => {
  // A confirmed approval that placed nothing must say WHY. The tool returns a
  // `failures` row per rejected symbol carrying the guard that refused it;
  // dropping it left the panel reporting "1 failed" with no account at all,
  // and no way for the operator to act.
  const raw = JSON.stringify({
    protected: 0,
    alreadyProtected: 0,
    failed: 1,
    orders: [],
    failures: [
      {
        symbol: "BTCUSDT",
        error:
          "futures trading is not enabled for this key pair — enable it once in Settings → Binance API (Futures trading consent).",
      },
    ],
    note: "reduce-only stops at the audit's recommended levels (4h candles, standard preset)",
  });

  it("surfaces the rejection reason behind a failed placement", () => {
    const summary = placementSummary(raw);
    expect(summary?.failures).toEqual([
      {
        symbol: "BTCUSDT",
        error:
          "futures trading is not enabled for this key pair — enable it once in Settings → Binance API (Futures trading consent).",
      },
    ]);
  });

  it("falls back to the grader's note when no error string is present", () => {
    const noErr = JSON.stringify({
      protected: 0,
      failed: 1,
      failures: [{ symbol: "ETHUSDT", notes: ["no valid stop level could be computed"] }],
    });
    expect(placementSummary(noErr)?.failures.map((f) => f.error)).toEqual(["no valid stop level could be computed"]);
  });

  it("never invents a reason when the tool gave none", () => {
    expect(
      placementSummary(JSON.stringify({ protected: 0, failed: 1, failures: [{ symbol: "X" }] }))?.failures.map(
        (f) => f.error,
      ),
    ).toEqual(["rejected without a reason"]);
  });
});

describe("stop-move result", () => {
  // The move places the new stop and only then cancels the old one, so a
  // cancel that could not be confirmed leaves BOTH resting. That is harmless
  // (both reduce-only) but the operator has to be told, or the next audit
  // shows a stop they never placed.
  const raw = JSON.stringify({
    tightened: 2,
    unchanged: 3,
    noStop: 1,
    failed: 0,
    positions: [
      { symbol: "BTCUSDT", from: [95000], to: "98098.00", stale: [] },
      {
        symbol: "ETHUSDT",
        from: [2900],
        to: "2902.90",
        stale: [{ algoId: 123, from: 2900, error: "the order is STILL RESTING on the exchange" }],
      },
    ],
    failures: [],
    note: "stops moved to the engine's recommended levels",
  });

  it("reports the moves and lifts the unconfirmed old stops out of the moved positions", () => {
    const summary = tightenSummary(raw);
    expect(summary?.tightened).toBe(2);
    expect(summary?.unchanged).toBe(3);
    expect(summary?.noStop).toBe(1);
    expect(summary?.stale).toEqual([{ symbol: "ETHUSDT", error: "the order is STILL RESTING on the exchange" }]);
    expect(summary?.failures).toEqual([]);
  });

  it("keeps a failure row's reason and rejects output it does not recognise", () => {
    const failed = JSON.stringify({
      tightened: 0,
      unchanged: 1,
      noStop: 0,
      failed: 1,
      positions: [],
      failures: [{ symbol: "SOLUSDT", error: "trade budget 120/min exhausted" }],
      note: "",
    });
    expect(tightenSummary(failed)?.failures).toEqual([{ symbol: "SOLUSDT", error: "trade budget 120/min exhausted" }]);
    expect(tightenSummary("not json")).toBeNull();
    // A placement result is NOT a move result — the panel must not read one
    // as the other.
    expect(tightenSummary(JSON.stringify({ protected: 2, failed: 0 }))).toBeNull();
  });
});
