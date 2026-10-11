import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderDataTa } from "./data";

/**
 * Render-level pins for the `data_ta` card.
 *
 * The output contract grew a second block: whole-series performance
 * statistics (`metrics`) sit beside the streaming indicator values. Two
 * failure modes this guards, both of which a user would see as a wrong or
 * empty card:
 *
 *  - a metrics-only call used to render nothing at all, because the renderer
 *    required `indicators` to be a non-empty object;
 *  - an indicator-only call must render exactly as before — the new block is
 *    additive, not a replacement.
 */
const html = (doc: unknown) => renderToStaticMarkup(<>{renderDataTa(JSON.stringify(doc))}</>);

describe("renderDataTa", () => {
  it("renders indicators and performance statistics together", () => {
    const out = html({
      kind: "ta",
      indicators: { rsi14: 62.31, ema9: 101.5 },
      metrics: { sharpe: 1.82, sortino: 0.914, max_drawdown: 0.243 },
      _meta: { rowsUsed: 120, sortedBy: "timestamp", annualized: 365, riskFreeRate: 0.04 },
    });
    // Indicators keep their alias-shaped labels.
    expect(out).toContain("rsi14");
    expect(out).toContain("62.31");
    // Metrics carry human labels, not raw kind keys.
    expect(out).toContain("Sharpe Ratio");
    expect(out).toContain("Max Drawdown");
    expect(out).toContain("1.82");
    // The annualization context is stated so the number can be reproduced.
    expect(out).toContain("365");
    expect(out).toContain("120 rows folded");
  });

  it("renders a metrics-only call", () => {
    const out = html({
      kind: "ta",
      indicators: {},
      metrics: { sharpe: -0.72, calmar: -0.65 },
      _meta: { rowsUsed: 365 },
    });
    expect(out).toContain("Sharpe Ratio");
    expect(out).toContain("Calmar Ratio");
  });

  it("falls back to the raw kind for a metric it does not know", () => {
    // A newly added backend metric must still reach the user rather than
    // disappear behind a stale label map.
    const out = html({
      kind: "ta",
      indicators: {},
      metrics: { some_new_ratio: 1.5 },
      _meta: { rowsUsed: 10 },
    });
    expect(out).toContain("some_new_ratio");
    expect(out).toContain("1.5");
  });

  it("renders an indicator-only call exactly as before", () => {
    const out = html({
      kind: "ta",
      indicators: { rsi14: 62.31 },
      _meta: { rowsUsed: 120, sortedBy: "timestamp" },
    });
    expect(out).toContain("rsi14");
    expect(out).toContain("62.31");
    expect(out).not.toContain("Sharpe");
    expect(out).not.toContain("bars/year");
  });

  it("renders nothing when there is nothing to show", () => {
    expect(html({ kind: "ta", indicators: {}, _meta: { rowsUsed: 0 } })).toBe("");
    expect(html("not json")).toBe("");
  });

  it("lists skipped indicators with their reason", () => {
    const out = html({
      kind: "ta",
      indicators: { ema9: 101.5 },
      _meta: { rowsUsed: 10, skipped: [{ alias: "macd12_26_9", need: 36, have: 10 }] },
    });
    expect(out).toContain("macd12_26_9");
    expect(out).toContain("insufficient history");
  });
});