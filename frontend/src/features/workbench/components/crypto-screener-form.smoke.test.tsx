import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CryptoScreenerForm } from "./crypto-screener-form";

/**
 * Render-level smoke for the Crypto Screener landing entry. The properties
 * worth pinning are the ones a user would notice breaking: the Structure row
 * must offer exactly the values the backend resolves (`structure_side` is
 * "support" | "resistance", the distance/touch presets are the ones the scan
 * accepts — a stray value is rejected before a plan exists, i.e. a dead run),
 * every chip must announce its pressed state, and the default run must sit on
 * "Any" everywhere: a form that ships with a narrowing pre-selected silently
 * hides most of the market.
 */
const render = () => renderToStaticMarkup(<CryptoScreenerForm onSubmit={() => {}} />);

describe("CryptoScreenerForm", () => {
  it("offers exactly the backend's structure side presets", () => {
    const html = render();
    for (const side of ["Any", "Support", "Resistance"]) {
      expect(html).toContain(`>${side}</button>`);
    }
    // Not a value the resolver accepts.
    expect(html).not.toContain(">Supply</button>");
  });

  it("offers the distance and touch presets the scan accepts", () => {
    const html = render();
    for (const pct of ["2%", "5%", "10%"]) {
      expect(html).toContain(`>${pct}</button>`);
    }
    for (const touches of ["2×", "3×"]) {
      expect(html).toContain(`>${touches}</button>`);
    }
    // "Any" is a chip in all three structure groups (level/within/touches).
    expect(html.match(/>Any<\/button>/g)).toHaveLength(3);
  });

  it("defaults every group to one pressed chip — no narrowing pre-selected", () => {
    const html = render();
    // setups, exchange, market, candles, hits, scan size, and the three
    // structure groups: one pressed chip each.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(9);
  });

  it("tells the user each hit carries structure and that the chips narrow the book", () => {
    const html = render();
    expect(html).toContain("market structure");
    expect(html).toContain("narrow the book");
  });
});
