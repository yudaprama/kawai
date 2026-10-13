import { describe, expect, it } from "vitest";

import { parseScreenerOffer, placementSummary, screenerRunStepIds } from "./crypto-screener-offer";

/**
 * The entry offer is the one panel in kawai that OPENS leveraged positions, so
 * the properties pinned here are the ones a user would notice breaking — or
 * would be hurt by:
 *
 * - A **spot** scan must offer nothing: there is no futures trade client for
 *   those symbols, so offering them would promise something the engine refuses.
 * - A **neutral** screen (`squeeze_watch`) must offer nothing: it marks
 *   conditions without voting for a direction, so there is nothing to enter on.
 * - One symbol firing under **two setups** stays **two rows** — the direction
 *   is derived from the screen, so collapsing them would silently pick one.
 * - A filled position that ended up **without a stop** must not hide behind a
 *   success count.
 *
 * The component itself is not rendered: it loads the step's full output in an
 * effect, which `renderToStaticMarkup` never fires — the offer would return
 * null and every render assertion would pass vacuously. The properties are
 * pinned on the exported pure predicates the panel is built from, exactly as
 * the audit offer's own suite does.
 */

const hit = (over: Record<string, unknown> = {}) => ({
  screen: "macd_golden_cross",
  symbol: "BTCUSDT",
  last: 95000,
  change24hPct: 2.5,
  score: 80,
  reasons: ["MACD crossed above signal 2 bars ago"],
  ...over,
});

const output = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "screener",
    universe: "usdm",
    interval: "4h",
    scanned: 700,
    hitsTotal: 1,
    screens: ["macd_golden_cross"],
    hits: [hit()],
    ...over,
  });

describe("parseScreenerOffer", () => {
  it("reads a usdm run's hits with their direction and score", () => {
    const offer = parseScreenerOffer([output()]);
    expect(offer?.universe).toBe("usdm");
    expect(offer?.interval).toBe("4h");
    expect(offer?.hits).toHaveLength(1);
    expect(offer?.hits[0]).toMatchObject({ symbol: "BTCUSDT", direction: "long", score: 80 });
  });

  /**
   * THE REGRESSION. The pipeline emits one `crypto_screener` step PER SCREEN,
   * and the offer originally read only the first — so a 743-symbol run holding
   * 401 hits across 7 steps showed the 1 hit that happened to sit in step one.
   * Every screen's slice must be merged.
   */
  it("merges EVERY screen's step, not just the first", () => {
    const steps = [
      output({
        screens: ["oversold_rebound"],
        hitsTotal: 1,
        scanned: 724,
        hits: [hit({ screen: "oversold_rebound", symbol: "ZHONGJIUSDT", score: 52 })],
      }),
      output({
        screens: ["macd_golden_cross"],
        hitsTotal: 2,
        scanned: 724,
        hits: [hit({ symbol: "ETHUSDT", score: 71 }), hit({ symbol: "SOLUSDT", score: 64 })],
      }),
      output({
        screens: ["rsi_overbought_uptrend"],
        hitsTotal: 20,
        scanned: 743,
        hits: [hit({ screen: "rsi_overbought_uptrend", symbol: "XRPUSDT", score: 83 })],
      }),
    ];
    const o = parseScreenerOffer(steps);
    // 1 + 2 + 1 = 4 actionable rows, NOT the first step's 1.
    expect(o?.hits).toHaveLength(4);
    expect(new Set(o?.hits.map((h) => h.symbol))).toEqual(new Set(["ZHONGJIUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]));
    // The run's own totals sum across steps.
    expect(o?.hitsTotal).toBe(23);
    expect(o?.scanned).toBe(2191);
    // Strongest first, across all steps.
    expect(o?.hits[0].symbol).toBe("XRPUSDT");
  });

  it("reports directionless hits instead of silently dropping them", () => {
    const o = parseScreenerOffer([
      output({ hitsTotal: 299, hits: [hit({ screen: "squeeze_watch", symbol: "BTCUSDT" })] }),
    ]);
    // The envelope parsed (so the panel can explain itself) and the count is
    // carried — a squeeze is a real finding, just not an enterable one.
    expect(o?.hits).toHaveLength(0);
    expect(o?.neutralHits).toBe(1);
  });

  it("refuses a spot scan — there is no futures trade client for it", () => {
    expect(parseScreenerOffer([output({ universe: "spot" })])).toBeNull();
  });

  it("skips a step from another market family instead of mixing families", () => {
    const o = parseScreenerOffer([output(), output({ universe: "spot", hits: [hit({ symbol: "BTCUSDT" })] })]);
    // The spot step contributes nothing.
    expect(o?.hits).toHaveLength(1);
    expect(o?.universe).toBe("usdm");
  });

  it("keeps one row per setup when a symbol fires under two", () => {
    const o = parseScreenerOffer([
      output({
        hits: [hit({ screen: "macd_golden_cross", score: 80 }), hit({ screen: "rsi_overbought_uptrend", score: 65 })],
      }),
    ]);
    expect(o?.hits).toHaveLength(2);
    if (o == null) throw new Error("the offer must parse");
    // Same symbol, genuinely two directions — the side comes from the screen.
    expect(o.hits.map((h) => h.direction).sort()).toEqual(["long", "short"]);
    expect(new Set(o.hits.map((h) => h.symbol))).toEqual(new Set(["BTCUSDT"]));
  });

  it("orders the strongest hit first", () => {
    const o = parseScreenerOffer([
      output({
        hits: [
          hit({ symbol: "AAAUSDT", score: 40 }),
          hit({ symbol: "BBBUSDT", score: 90 }),
          hit({ symbol: "CCCUSDT", score: 65 }),
        ],
      }),
    ]);
    expect(o?.hits.map((h) => h.symbol)).toEqual(["BBBUSDT", "CCCUSDT", "AAAUSDT"]);
  });

  it("de-duplicates a repeated (symbol, screen) pair across steps", () => {
    const o = parseScreenerOffer([output({ hits: [hit()] }), output({ hits: [hit()] })]);
    expect(o?.hits).toHaveLength(1);
  });

  it("returns null only when EVERY step is unreadable", () => {
    // All broken → the run view is broken, which must not read as "no hits".
    expect(parseScreenerOffer(["not json", null, JSON.stringify({ nope: true })])).toBeNull();
    expect(parseScreenerOffer([])).toBeNull();
    // One good step among failures still renders — a partial read degrades to
    // fewer rows, not an empty panel.
    const o = parseScreenerOffer(["not json", output()]);
    expect(o?.hits).toHaveLength(1);
  });

  it("keeps a genuinely empty hit list — the panel explains it", () => {
    const o = parseScreenerOffer([output({ hits: [], hitsTotal: 0 })]);
    expect(o?.hits).toEqual([]);
    expect(o?.neutralHits).toBe(0);
  });
});

describe("screenerRunStepIds", () => {
  it("returns EVERY screener step in plan order, ignoring other tools", () => {
    expect(
      screenerRunStepIds([
        { tool: "crypto_screener_data", stepId: "screener_data" },
        { tool: "crypto_screener", stepId: "screener_a" },
        { tool: "crypto_screener", stepId: "screener_b" },
      ]),
    ).toEqual(["screener_a", "screener_b"]);
    expect(screenerRunStepIds([{ tool: "binance_futures_risk_audit", stepId: "audit" }])).toEqual([]);
    expect(screenerRunStepIds(undefined)).toEqual([]);
  });
});

describe("placementSummary", () => {
  const summary = (over: Record<string, unknown> = {}) =>
    placementSummary(
      JSON.stringify({
        opened: 2,
        failed: 1,
        unprotected: 1,
        positions: [],
        failures: [{ symbol: "XRPUSDT", error: "below minimum order value" }],
        unprotectedPositions: [{ symbol: "BTCUSDT", error: "stop rejected — wrong side of the mark" }],
        note: "market entries with the engine's recommended stop attached",
        ...over,
      }),
    );

  it("counts opens and surfaces a naked position alongside the success", () => {
    const s = summary();
    expect(s?.opened).toBe(2);
    expect(s?.failed).toBe(1);
    // The one outcome that must never hide behind the success count.
    expect(s?.unprotected).toBe(1);
    expect(s?.naked[0].symbol).toBe("BTCUSDT");
    expect(s?.failures[0].symbol).toBe("XRPUSDT");
  });

  it("reads a clean all-protected run without inventing a naked position", () => {
    const s = summary({ unprotected: 0, unprotectedPositions: [] });
    expect(s?.unprotected).toBe(0);
    expect(s?.naked).toEqual([]);
  });

  it("returns null on output it does not recognise", () => {
    expect(placementSummary("not json")).toBeNull();
    expect(placementSummary(JSON.stringify([1, 2]))).toBeNull();
    expect(placementSummary(JSON.stringify({ nope: true }))).toBeNull();
  });
});
