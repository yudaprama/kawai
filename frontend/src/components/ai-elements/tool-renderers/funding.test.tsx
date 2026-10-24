import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderCryptoScreener, renderBinanceFuturesRiskAudit, renderFundingArb } from "./finance";
import { renderStepReport } from "@/features/workbench/components/tool-views";
import { renderToolOutput } from "./index";

/**
 * Render-level pins for the funding surfaces. The funding_arb fixture is a
 * REAL `crypto_funding_arb` payload captured live from Binance
 * (`premiumIndex`, TREEUSDT at −1.35%/8h led the board); the audit/screener
 * rows are the blocks `risk_audit.rs` / `screener.rs` attach — not
 * hand-written shapes.
 *
 * Facts these assertions protect:
 *  - the arb table renders rows ranked by |rate| with BOTH APY columns and
 *    the overheated flag (TREEUSDT is far past the 0.05%/8h threshold);
 *  - a payload WITHOUT the `funding` block renders exactly as before — the
 *    audit/screener columns are optional, never empty;
 *  - a position that PAYS funding shows the signed cost (positive =
 *    holder pays), and the hover carries the 3-day projection;
 *  - both registries claim `crypto_funding_arb` (chat inspector + Workbench
 *    step view) — a dropped registration falls back to raw JSON, the
 *    failure that shipped three times before.
 */

const ARB_ROW = {
  apy: 14.79109575,
  apyNetOfFees: 14.79029575,
  markPrice: 0.04649,
  overheated: true,
  rate: -0.01350785,
  side_who_pays: "short_paying",
  symbol: "TREEUSDT",
};

const ARB_PAYLOAD = JSON.stringify({
  kind: "funding_arb",
  rows: [ARB_ROW],
  assumptions: {
    intervalsPerDay: 3,
    takerFeePerSide: 0.0004,
    note: "apyNetOfFees deducts the estimated one-time round-trip taker fee once",
  },
});

const AUDIT_POSITION = (funding: unknown) => ({
  symbol: "BTCUSDT",
  positionSide: "LONG",
  margin: "USDM",
  marginAsset: "USDT",
  notionalAbs: 49123.45,
  unRealizedProfit: 123.45,
  stopLoss: { present: true, price: 95000, distancePct: -3.2 },
  takeProfit: { present: false, nearestPrice: null, distancePct: null },
  riskReward: null,
  advice: { verdict: "ok", recommended: { method: "structure", price: 95000 }, notes: [] },
  funding,
});

const AUDIT_PAYLOAD = (funding: unknown) =>
  JSON.stringify({
    kind: "audit_data",
    params: { market: "usdm", interval: "4h", risk: "standard" },
    summary: {
      usdmPositions: 1,
      coinmPositions: 0,
      graded: 1,
      naked: 0,
      nakedNotional: 0,
      skippedByCap: 0,
    },
    positions: [AUDIT_POSITION(funding)],
    note: "",
    limitations: [],
  });

const SCREENER_HIT = (funding: unknown) => ({
  symbol: "QUSDT",
  screen: "squeeze_watch",
  last: 0.116552,
  change24hPct: -6.5,
  score: 98,
  reasons: ["Bollinger bands compressed inside the Keltner channel"],
  myPerformance: null,
  structure: null,
  funding,
});

const SCREENER_PAYLOAD = (funding: unknown) =>
  JSON.stringify({
    kind: "screener",
    screen: "squeeze_watch",
    direction: "neutral",
    universe: "usdm",
    interval: "4h",
    scanned: 40,
    skipped: 0,
    hitsTotal: 1,
    partial: false,
    errors: [],
    errorsTotal: 0,
    rankBy: "score",
    rankByAutomatic: false,
    structureFiltered: 0,
    structureFilter: null,
    perScreen: [{ hits: 1, screen: "squeeze_watch" }],
    hits: [SCREENER_HIT(funding)],
  });

describe("crypto_funding_arb card", () => {
  it("renders the ranked rows with both APY columns and the overheated flag", () => {
    const html = renderToStaticMarkup(renderFundingArb(ARB_PAYLOAD) as React.ReactElement);
    expect(html).toContain("TREEUSDT");
    expect(html).toContain("-1.3508%"); // rate per 8h, signed
    expect(html).toContain("14.79%"); // gross APY
    expect(html).toContain("14.79%"); // net APY (fees are tiny at this rate)
    expect(html).toContain("⚠");
    expect(html).toContain("longs (they pay)"); // short_paying → you collect from longs
  });

  it("is claimed by BOTH registries (chat inspector + Workbench step view)", () => {
    expect(renderToolOutput("crypto_funding_arb", ARB_PAYLOAD)).not.toBeNull();
    expect(renderStepReport("crypto_funding_arb", ARB_PAYLOAD)).not.toBeNull();
  });
});

describe("funding columns on existing cards", () => {
  it("audit: shows the signed per-8h cost when the funding block is present", () => {
    const html = renderToStaticMarkup(
      renderBinanceFuturesRiskAudit(
        AUDIT_PAYLOAD({
          rate: 0.0001,
          sentiment: "long_paying",
          costPer8h: 4.912345,
          projection: { holdingDays: 3, intervals: 9, cost: 44.211105 },
        })
      ) as React.ReactElement
    );
    expect(html).toContain("Funding /8h");
    expect(html).toContain("+4.91");
    expect(html).toContain("+44.21"); // 3-day projection in the hover title
  });

  it("audit: payload without funding keeps rendering — no empty column", () => {
    const html = renderToStaticMarkup(
      renderBinanceFuturesRiskAudit(AUDIT_PAYLOAD(null)) as React.ReactElement
    );
    expect(html).not.toContain("Funding /8h");
  });

  it("screener: prints the rate with the overheated marker when present", () => {
    const html = renderToStaticMarkup(
      renderCryptoScreener(
        SCREENER_PAYLOAD({ rate: -0.0006, sentiment: "short_paying", overheated: true })
      ) as React.ReactElement
    );
    expect(html).toContain("Funding");
    expect(html).toContain("-0.0600%");
    expect(html).toContain("⚠");
  });

  it("screener: payload without funding keeps rendering — no empty column", () => {
    const html = renderToStaticMarkup(
      renderCryptoScreener(SCREENER_PAYLOAD(null)) as React.ReactElement
    );
    expect(html).not.toContain("Funding");
  });
});
