import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderBinanceFuturesRiskAudit } from "./finance";

/**
 * Render-level pins for the futures risk audit card. Every assertion here is
 * something a user would notice breaking, and each one guards a defect this
 * card actually shipped with:
 *
 *  - the row list was silently sliced to 8 with NO disclosure, so a 183-position
 *    book rendered 8 rows and looked complete;
 *  - exposure at risk wore the same neutral tile as the "graded" count, so
 *    "183 unprotected" read as calm;
 *  - round8 floats printed raw (`2,097.430683`, `-159.017054`);
 *  - the verdict, the engine's recommended level and its notes were dropped.
 */

const position = (over: Record<string, unknown> = {}) => ({
  symbol: "BTCUSDT",
  positionSide: "LONG",
  positionAmt: 1.5,
  entryPrice: 98000,
  markPrice: 97500,
  unRealizedProfit: -750.5,
  notionalAbs: 146250,
  marginAsset: "USDT",
  stopLoss: { present: false, price: null, distancePct: null },
  takeProfit: { present: false, resting: 0, nearestPrice: null, distancePct: null },
  riskReward: null,
  restingStops: 0,
  restingTps: 0,
  graded: true,
  ...over,
});

const audit = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    params: { interval: "4h", risk: "standard", limit: 25 },
    summary: {
      usdmPositions: 4,
      graded: 4,
      skippedByCap: 0,
      withStopLoss: 1,
      naked: 3,
      nakedNotional: 2097.430683,
      withTakeProfit: 1,
      slVerdicts: { missing: 3, ok: 1 },
      coinmPositions: 0,
    },
    coinmUnrealizedPnlByAsset: {},
    positions: [position()],
    note: "all USDⓈ-M positions graded",
    ...over,
  });

const html = (output: unknown) => renderToStaticMarkup(<>{renderBinanceFuturesRiskAudit(output)}</>);

describe("risk audit card", () => {
  it("leads with the money at risk, not a bare position count", () => {
    const markup = html(audit());
    // 2097.430683 must read as money, not as a raw engine float.
    expect(markup).toContain("2,097.43");
    expect(markup).not.toContain("2,097.430683");
    // The count of unprotected positions travels WITH the exposure, so the
    // headline is actionable rather than a bare integer.
    expect(markup).toContain("3 of 4 positions have no stop");
  });

  it("marks a fully uncovered book as dangerous and a covered one as safe", () => {
    expect(html(audit())).toContain("text-destructive");
    const covered = audit({
      summary: {
        usdmPositions: 4,
        graded: 4,
        skippedByCap: 0,
        withStopLoss: 4,
        naked: 0,
        nakedNotional: 0,
        withTakeProfit: 4,
        slVerdicts: { ok: 4 },
        coinmPositions: 0,
      },
    });
    const markup = html(covered);
    expect(markup).toContain("every graded position carries a stop");
    // The exposure tile still states the ratio, and reads zero when covered.
    expect(markup).toContain("0 of 4 positions have no stop");
  });

  it("never truncates the book without saying so", () => {
    const rows = Array.from({ length: 40 }, (_, i) => position({ symbol: `SYM${i}USDT` }));
    const markup = html(audit({ positions: rows }));
    // Capped at AUDIT_ROW_CAP=12 … and the affordance names the FULL count, so
    // a 40-position book can never look like a 12-position one.
    expect(markup).toContain("Show all 40 positions");
    expect(markup).not.toContain("SYM12USDT");
    // A book that fits is NOT offered a pointless expander.
    expect(html(audit({ positions: rows.slice(0, 5) }))).not.toContain("Show all");
  });

  it("surfaces the engine's verdict, recommended level and notes per row", () => {
    const markup = html(
      audit({
        positions: [
          position({
            advice: {
              symbol: "BTCUSDT",
              verdict: "missing",
              recommended: { price: 95000.12345678, method: "chandelier_exit", distancePct: 2.56 },
              notes: ["no resting stop; 3×ATR from the 4h fold"],
              takeProfit: { shape: "ladder_runner", verdict: "too_close", rungs: [], bandExit: null },
            },
          }),
        ],
      }),
    );
    expect(markup).toContain("missing");
    expect(markup).toContain("too close");
    // The recommendation is what makes the row actionable.
    expect(markup).toContain("95,000.12");
    expect(markup).toContain("chandelier exit");
    // The engine's own reasoning rides the row it grades.
    expect(markup).toContain("no resting stop");
  });

  it("shows the recommended take-profit ladder, not an empty coverage flag", () => {
    // The regression this pins: the take-profit cell read the RESTING coverage
    // (`takeProfit.nearestPrice`), so a book with no resting TPs rendered a
    // bare "missing" chip on every row while the engine's 1R/2R ladder and
    // trailing exit in `advice.takeProfit` went unrendered.
    const markup = html(
      audit({
        positions: [
          position({
            takeProfit: { present: false, resting: 0, nearestPrice: null, distancePct: null },
            advice: {
              verdict: "missing",
              recommended: { price: 82468.946, method: "chandelier_exit", distancePct: 0.64 },
              notes: [],
              takeProfit: {
                shape: "ladder_runner",
                verdict: "missing",
                rungs: [
                  { label: "1R", price: 84403.85001548, allocPct: 40, passed: false },
                  { label: "2R", price: 85207.90003096, allocPct: 30, passed: false },
                ],
                bandExit: null,
                trailingExit: { method: "chandelier_exit", price: 81878.06635339 },
              },
            },
          }),
        ],
      }),
    );
    // Each line reads as the instruction it is: what share closes, at what
    // price. The engine's "1R"/"2R" labels are gone — they name a multiple of
    // the risk unit and mean nothing to someone who is not trading.
    expect(markup).not.toContain(">1R<");
    expect(markup).not.toContain(">2R<");
    expect(markup).toContain("40%");
    expect(markup).toContain("30%");
    expect(markup).toContain("84,403.85");
    // fmtPrice keeps 8 SIGNIFICANT digits, so the runner reads 81,878.066.
    expect(markup).toContain("81,878.066");
    expect(markup).toContain("trails from");
  });

  it("derives R:R from the levels it would place, not the resting pair", () => {
    // `riskReward` is the audit's grade of the RESTING stop against the
    // RESTING take-profit, so on a naked book it is null and the column read
    // "—" on every row — blank exactly where the number matters most.
    const markup = html(
      audit({
        positions: [
          position({
            markPrice: 100,
            entryPrice: 100,
            riskReward: null,
            takeProfit: { present: false, resting: 0, nearestPrice: null, distancePct: null },
            advice: {
              verdict: "missing",
              // Stop 5 below the mark, first target 10 above it → 2.00R.
              recommended: { price: 95, method: "chandelier_exit", distancePct: 5 },
              notes: [],
              takeProfit: {
                shape: "ladder_runner",
                verdict: "missing",
                rungs: [{ label: "1R", price: 110, allocPct: 40, passed: false }],
                bandExit: null,
                trailingExit: { method: "chandelier_exit", price: 112 },
              },
            },
          }),
        ],
      }),
    );
    // Plain ratio: "for every 1 at risk, the target pays 2.00".
    expect(markup).toContain("1 : 2.00");
  });

  it("drops a passed rung — its exit window is gone and it is never placed", () => {
    const markup = html(
      audit({
        positions: [
          position({
            takeProfit: { present: false, resting: 0, nearestPrice: null, distancePct: null },
            advice: {
              verdict: "missing",
              recommended: null,
              notes: [],
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
          }),
        ],
      }),
    );
    expect(markup).toContain("101,000");
    // The 2R rung traded through and is never placed, so its price must not
    // appear — asserting on a label that no longer exists would pass anyway.
    expect(markup).not.toContain("104,000");
  });

  it("prefers the resting take-profit when one already covers the position", () => {
    const markup = html(
      audit({
        positions: [
          position({
            takeProfit: { present: true, resting: 2, nearestPrice: 2800, distancePct: 6.67 },
            advice: {
              verdict: "ok",
              recommended: { price: 3140, method: "atr_3x", distancePct: 4.67 },
              notes: [],
              takeProfit: {
                shape: "ladder",
                verdict: "ok",
                rungs: [{ label: "1R", price: 2900, allocPct: 100, passed: false }],
                bandExit: null,
              },
            },
          }),
        ],
      }),
    );
    // The resting level is what is actually on the book — it wins the cell,
    // and the engine's `ok` verdict on it replaces the bare "covered" word.
    expect(markup).toContain("2,800");
    expect(markup).not.toContain("2,900");
  });

  it("colours each verdict by severity rather than flattening them to one word", () => {
    const markup = html(
      audit({
        positions: [
          position({ advice: { verdict: "ok", recommended: null, notes: [] } }),
          position({ symbol: "ETHUSDT", advice: { verdict: "tighten", recommended: null, notes: [] } }),
          position({ symbol: "SOLUSDT", advice: { verdict: "missing", recommended: null, notes: [] } }),
        ],
      }),
    );
    expect(markup).toContain("text-success"); // ok
    expect(markup).toContain("text-warning"); // tighten — exists, needs review
    expect(markup).toContain("text-destructive"); // missing — unprotected
  });

  it("formats PnL with an explicit direction so losses are scannable", () => {
    const markup = html(
      audit({
        positions: [
          position({ unRealizedProfit: -159.017054 }),
          position({ symbol: "ETHUSDT", unRealizedProfit: 42.5 }),
        ],
      }),
    );
    expect(markup).toContain("-159.02");
    expect(markup).toContain("+42.50");
    expect(markup).not.toContain("-159.017054");
  });

  it("collapses COIN-M into a disclosure with per-asset signed PnL", () => {
    const markup = html(
      audit({
        summary: { usdmPositions: 1, graded: 1, skippedByCap: 0, withStopLoss: 0, naked: 1, nakedNotional: 10, withTakeProfit: 0, coinmPositions: 2 },
        coinmUnrealizedPnlByAsset: { COIN: -125.310482, USDT: 11.39917 },
      }),
    );
    expect(markup).toContain("2 COIN-M positions");
    // Settled coins are NOT summed (they are different currencies), so each is
    // listed with its own sign and colour.
    expect(markup).toContain("COIN");
    expect(markup).toContain("-125.31");
    expect(markup).toContain("+11.40");
  });

  it("grades BOTH markets — the denominator is the whole book, never USDⓈ-M alone", () => {
    // The card once divided the all-market totals by `usdmPositions` and
    // rendered "200/184 graded" / "199 of 184 positions have no stop".
    const markup = html(
      audit({
        summary: {
          usdmPositions: 184, graded: 200, skippedByCap: 0, withStopLoss: 1,
          naked: 199, nakedNotional: 6639.18, withTakeProfit: 2,
          slVerdicts: { missing: 199, tighten: 1 }, coinmPositions: 16,
        },
      }),
    );
    expect(markup).toContain("200/200");
    expect(markup).toContain("199 of 200 positions have no stop");
    expect(markup).not.toContain("/184");
  });

  it("splits the matrix by market and labels COIN-M units per row", () => {
    // COIN-M rows carry contract sizes and coin-denominated PnL; mixed into
    // one undivided table, "-0.0001188" read as ~zero USD beside USDT pairs,
    // and the stale "not klines-audited" disclosure contradicted the graded
    // COIN-M rows sitting right above it.
    const coinmRow = position({
      symbol: "BTCUSD_PERP",
      margin: "COINM",
      marginAsset: "BTC",
      unRealizedProfit: -0.0001188,
      notionalAbs: 2300,
    });
    const markup = html(audit({ positions: [position(), coinmRow] }));
    expect(markup).toContain("USDⓈ-M — USDT margin");
    expect(markup).toContain("COIN-M — coin-settled");
    expect(markup).toContain("BTCUSD_PERP");
    expect(markup).toContain("-0.0001188 BTC");
    expect(markup).not.toContain("not klines-audited");
  });

  it("renders TWO market cards under one whole-book banner", () => {
    // One undivided card read USDⓈ-M and COIN-M as one book; the split gives
    // each family its own tiles (2,603.50 vs 4,060.43 — different currencies,
    // never summed) under a banner that keeps the combined answer.
    const markup = html(
      audit({
        summary: {
          usdmPositions: 188, graded: 205, skippedByCap: 0, withStopLoss: 1,
          naked: 204, nakedNotional: 6663.93, withTakeProfit: 2,
          slVerdicts: { missing: 204, tighten: 1 }, coinmPositions: 17,
          usdm: { positions: 188, graded: 188, naked: 187, withStopLoss: 1, withTakeProfit: 2, nakedNotional: 2603.5 },
          coinm: { positions: 17, graded: 17, naked: 17, withStopLoss: 0, withTakeProfit: 0, nakedNotional: 4060.43 },
        },
        coinmUnrealizedPnlByAsset: { DOGE: -74.39 },
        positions: [
          position(),
          position({ symbol: "BTCUSD_PERP", margin: "COINM", marginAsset: "BTC", unRealizedProfit: -0.0001188, notionalAbs: 2300 }),
        ],
      }),
    );
    expect(markup).toContain("6,663.93");
    expect(markup).toContain("204 of 205 positions have no stop");
    // Per-family tiles, in order: USDⓈ-M card first, COIN-M card second.
    expect(markup.indexOf("USDⓈ-M — USDT margin")).toBeGreaterThan(-1);
    expect(markup.indexOf("COIN-M — coin-settled")).toBeGreaterThan(markup.indexOf("USDⓈ-M — USDT margin"));
    expect(markup).toContain("187 of 188 positions have no stop");
    expect(markup).toContain("17 of 17 positions have no stop");
    expect(markup).toContain("2,603.50");
    expect(markup).toContain("4,060.43");
  });

  it("renders a coinm-scoped audit without USDⓈ-M noise", () => {
    // `market: "coinm"` scopes every number to the COIN-M family: the
    // denominator is the scoped book and the empty USDⓈ-M side stays
    // silent (an empty-by-request section is not a finding).
    const markup = html(
      audit({
        params: { interval: "4h", risk: "standard", limit: 25, market: "coinm" },
        summary: {
          usdmPositions: 0, graded: 16, skippedByCap: 0, withStopLoss: 0,
          naked: 16, nakedNotional: 6639, withTakeProfit: 0,
          slVerdicts: { missing: 16 }, coinmPositions: 16,
        },
        positions: [
          position({ symbol: "BTCUSD_PERP", margin: "COINM", marginAsset: "BTC", notionalAbs: 2300 }),
        ],
      }),
    );
    expect(markup).toContain("16/16");
    expect(markup).toContain("16 of 16 positions have no stop");
    expect(markup).toContain("COIN-M — coin-settled");
    expect(markup).not.toContain("No open USDⓈ-M positions");
    expect(markup).not.toContain("USDT pairs");
  });

  it("states the grading cap when positions were skipped", () => {
    const markup = html(
      audit({
        summary: { usdmPositions: 30, graded: 25, skippedByCap: 5, withStopLoss: 1, naked: 29, nakedNotional: 10, withTakeProfit: 0, coinmPositions: 0 },
        note: "graded the top 25 USDⓈ-M positions by notional; 5 smaller ones are counted in the summary but not klines-audited (raise `limit`, max 500)",
      }),
    );
    expect(markup).toContain("5 over the cap");
    // The backend's note is verbatim-authoritative; we must not paraphrase it.
    expect(markup).toContain("raise `limit`, max 500");
  });

  it("states what the report could NOT cover, in the card itself", () => {
    // The follow-up composer lets a user ask about COIN-M; the audit cannot
    // grade it. A PnL table with no warning reads as a completed analysis.
    const markup = html(
      audit({
        limitations: [
          "17 COIN-M position(s) are counted and their unrealized PnL is reported, but they are NOT risk-graded.",
        ],
      }),
    );
    expect(markup).toContain("COIN-M position(s) are counted");
    expect(markup).toContain("NOT risk-graded");
    expect(markup).toContain("border-warning/30");
  });

  it("renders no limitation banner when the tool declares none", () => {
    // `text-warning` alone is not a marker — the "with a take-profit" tile uses
    // it too. The banner's own border is.
    expect(html(audit())).not.toContain("border-warning/30");
  });

  it("renders nothing for a payload that is not an audit matrix", () => {
    expect(html(null)).toBe("");
    expect(html("not json {")).toBe("");
    expect(html(JSON.stringify({ ok: true }))).toBe("");
    expect(html(JSON.stringify({ summary: null }))).toBe("");
  });
});