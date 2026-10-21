import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderCryptoScreener } from "./finance";

/**
 * Render-level pins for the screener's structural column. The fixture is a
 * REAL `crypto_screener` payload captured from a live 40-symbol USDM 4h scan
 * (screens macd_golden_cross, squeeze_watch, uptrend_pullback) — not a
 * hand-written shape, which is what let the earlier renderer tests stay green
 * while the app rendered raw JSON.
 *
 * Facts these assertions protect:
 *  - the nearest level is printed with its SIGNED distance: CLUSDT's nearest
 *    level is a pivot-high cluster BELOW price (-1.62%), i.e. already broken —
 *    printing the absolute distance would call it overhead supply;
 *  - the touch count rides the level (5× on CLUSDT), because a one-touch level
 *    and a five-touch level are not the same evidence;
 *  - a hit list WITHOUT structure (older payload / series too short) renders
 *    exactly as before — no empty column;
 *  - `structureFiltered` is disclosed, so a narrowed pass never reads as an
 *    unfiltered market with no signals.
 */

const HIT_Q = {
  change24hPct: -6.5,
  last: 0.116552,
  myPerformance: null,
  reasons: [
    "Bollinger bands compressed inside the Keltner channel",
    "efficiency ratio 0.02 — directionless drift",
  ],
  score: 98,
  screen: "squeeze_watch",
  structure: {
    lastBreak: { barsAgo: 24, direction: "up", level: 0.057408 },
    nearestLevel: {
      distancePct: -6.31,
      lastTouchAge: 5,
      price: 0.109186,
      side: "support",
      touches: 3,
    },
    trend: "range",
  },
  symbol: "QUSDT",
};

const HIT_CL = {
  change24hPct: 0.51,
  last: 99.34,
  myPerformance: null,
  reasons: ["Bollinger bands compressed inside the Keltner channel"],
  score: 97,
  screen: "squeeze_watch",
  structure: {
    lastBreak: { barsAgo: 3, direction: "down", level: 98.11 },
    nearestLevel: {
      distancePct: -1.62,
      lastTouchAge: 182,
      price: 97.742,
      side: "resistance",
      touches: 5,
    },
    trend: "range",
  },
  symbol: "CLUSDT",
};

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "screener",
    screens: ["macd_golden_cross", "squeeze_watch", "uptrend_pullback"],
    direction: "mixed",
    universe: "usdm",
    interval: "4h",
    scanned: 40,
    skipped: 0,
    hitsTotal: 5,
    topN: 3,
    universeTotal: 793,
    partial: false,
    errors: [],
    errorsTotal: 0,
    rankBy: "score",
    rankByAutomatic: false,
    myPerformanceSymbols: null,
    structureFiltered: 0,
    structureFilter: null,
    perScreen: [
      { hits: 0, screen: "macd_golden_cross" },
      { hits: 5, screen: "squeeze_watch" },
      { hits: 0, screen: "uptrend_pullback" },
    ],
    hits: [HIT_Q, HIT_CL],
    ...over,
  });

describe("crypto_screener structure column", () => {
  it("prints the nearest level with its side, touches and signed distance", () => {
    const html = renderToStaticMarkup(
      renderCryptoScreener(payload()) as React.ReactElement
    );
    expect(html).toContain("Structure");
    // CLUSDT: resistance BELOW price — the minus sign is the fact a reader acts on.
    expect(html).toContain("97.742");
    expect(html).toContain("-1.62%");
    expect(html).toContain("5×");
    expect(html).toContain("R");
    // QUSDT: a support below price with three touches.
    expect(html).toContain("0.109186");
    expect(html).toContain("-6.31%");
    expect(html).toContain("3×");
    expect(html).toContain("S");
    // The trend/break ride the cell's tooltip, not the row text.
    expect(html).toContain("trend range");
    expect(html).toContain("last break down 98.11 (3 bars ago)");
  });

  it("discloses the hits a structural filter removed", () => {
    const html = renderToStaticMarkup(
      renderCryptoScreener(
        payload({
          structureFiltered: 5,
          structureFilter: { side: "resistance", maxDistancePct: 2, minTouches: 2 },
        })
      ) as React.ReactElement
    );
    expect(html).toContain("-5 structure");
    expect(html).toContain("side resistance");
    expect(html).toContain("within 2.00% of price");
    expect(html).toContain("2x touches");
  });

  it("renders a hit list without structure exactly as before", () => {
    const legacy = [HIT_Q, HIT_CL].map(({ structure: _structure, ...rest }) => rest);
    const html = renderToStaticMarkup(
      renderCryptoScreener(payload({ hits: legacy })) as React.ReactElement
    );
    expect(html).not.toContain("Structure");
    expect(html).toContain("QUSDT");
    expect(html).toContain("98");
  });

  it("hides the column when no row produced a level, rather than printing dashes", () => {
    const html = renderToStaticMarkup(
      renderCryptoScreener(
        payload({
          hits: [
            { ...HIT_Q, structure: { trend: "range", nearestLevel: null, lastBreak: null } },
          ],
        })
      ) as React.ReactElement
    );
    // The block exists but carries no level: no column, no invented price.
    expect(html).not.toContain("Structure");
    expect(html).not.toContain("0.109186");
    expect(html).toContain("QUSDT");
  });
});
