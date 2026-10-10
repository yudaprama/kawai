import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BinanceAuditForm, ownsAuditScope } from "./binance-audit-form";
import { GoalTemplates, templateOpensAudit, templateOpensDesk, templateOpensYoutube } from "./goal-templates";

/**
 * Render-level smoke for the Futures Risk Audit landing entry. The properties
 * worth pinning are the ones a user would notice breaking: the form must offer
 * exactly the presets the backend accepts (an unknown interval silently falls
 * back to `4h`, so a drifted chip is a silent lie), every chip must announce
 * its pressed state, and the read-only guarantee must stay on screen — this
 * panel asks about real money.
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

  it("caps the graded positions at the tool's maximum", () => {
    const html = render();
    expect(html).toContain(">50</button>");
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
