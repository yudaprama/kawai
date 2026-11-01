import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LogoMark } from "./logo";

/**
 * Render-level smoke for the brand mark. What this pins: the logo must be an
 * INLINE svg carrying the traced path — an `<img>` (the other way to ship it)
 * would freeze `currentColor` to black and the mark would vanish on the dark
 * theme, so any regression back to an img element or an empty path fails here.
 */
describe("LogoMark", () => {
  it("renders an inline currentColor svg, not an img", () => {
    const html = renderToStaticMarkup(<LogoMark className="text-brand size-5" />);
    expect(html).toContain("<svg");
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain("text-brand");
    expect(html).not.toContain("<img");
  });

  it("embeds the traced silhouette path", () => {
    const html = renderToStaticMarkup(<LogoMark className="size-4" />);
    const d = / d="([^"]+)"/.exec(html)?.[1] ?? "";
    // The potrace trace of the cat-girl silhouette is ~21k chars; a stubbed or
    // truncated path collapses the mark to a speck or nothing at all.
    expect(d.length).toBeGreaterThan(10_000);
  });
});
