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

  it("renders nothing for a payload that is not an audit matrix", () => {
    expect(html(null)).toBe("");
    expect(html("not json {")).toBe("");
    expect(html(JSON.stringify({ ok: true }))).toBe("");
    expect(html(JSON.stringify({ summary: null }))).toBe("");
  });
});