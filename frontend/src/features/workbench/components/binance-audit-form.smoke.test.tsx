import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BinanceAuditForm, ownsAuditScope } from "./binance-audit-form";
import { auditRunStepId, parseAuditOffer } from "./binance-audit-offer";
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
 * The credential read (`binance_credentials_status`) runs in an effect, which
 * `renderToStaticMarkup` never fires, so `source` stays null here and the
 * no-keys branch is covered by its own assertion on the pure predicate below.
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
    // Defaults are 4h / Standard / 25 — each must render pressed exactly once.
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
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
      },
      {
        symbol: "SOLUSDT",
        long: false,
        size: 10,
        mark: 150,
        shape: "band_exit",
        rungs: [],
        bandExit: { method: "donchian_20", price: 140 },
      },
    ]);
    // The approval table merges both sides per symbol: BTCUSDT (stop + TP in
    // one row), SOLUSDT (TP only), while the resting-covered and error rows
    // stay out.
    expect(offer?.rows).toEqual([
      {
        symbol: "BTCUSDT",
        long: true,
        size: 1.5,
        mark: 98000,
        sl: { price: 95000, method: "chandelier_exit", distancePct: 3.06 },
        tp: {
          symbol: "BTCUSDT",
          long: true,
          size: 1.5,
          mark: 98000,
          shape: "ladder_runner",
          rungs: [{ label: "1R", price: 101000, allocPct: 40 }],
          bandExit: null,
        },
      },
      {
        symbol: "SOLUSDT",
        long: false,
        size: 10,
        mark: 150,
        sl: null,
        tp: {
          symbol: "SOLUSDT",
          long: false,
          size: 10,
          mark: 150,
          shape: "band_exit",
          rungs: [],
          bandExit: { method: "donchian_20", price: 140 },
        },
      },
    ]);
  });

  it("rejects anything that is not a readable audit matrix", () => {
    expect(parseAuditOffer(null)).toBeNull();
    expect(parseAuditOffer("")).toBeNull();
    expect(parseAuditOffer("not json {")).toBeNull();
    expect(parseAuditOffer(JSON.stringify({ summary: { naked: "many" } }))).toBeNull();
    expect(parseAuditOffer(JSON.stringify({ ok: true }))).toBeNull();
  });
});

describe("auditRunStepId", () => {
  it("finds the audit step among a run's steps", () => {
    expect(
      auditRunStepId([
        { tool: "web_search", stepId: "s1" },
        { tool: "binance_futures_risk_audit", stepId: "audit_positions" },
      ]),
    ).toBe("audit_positions");
  });

  it("returns null for any other run", () => {
    expect(auditRunStepId([{ tool: "deliverable_writer", stepId: "__deliverable" }])).toBeNull();
    expect(auditRunStepId(undefined)).toBeNull();
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
