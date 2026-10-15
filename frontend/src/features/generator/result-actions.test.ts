import { describe, expect, it } from "vitest";

import { mediaExcerpt } from "./result-actions";

/**
 * `mediaExcerpt` trims the caption under a result tile. The caption has one
 * line; a generated prompt has hundreds of characters (booru tag soup, quality
 * spam), so the cut has to stay readable — an ellipsis always, and a word
 * boundary rather than a tag sliced in half.
 */

const LONG = "masterpiece, best quality, extremely detailed CG unity 8k wallpaper, vibrant nebula sky";

describe("mediaExcerpt", () => {
  it("passes a short prompt through untouched", () => {
    expect(mediaExcerpt("a serene lakeside at dawn")).toBe("a serene lakeside at dawn");
  });

  it("collapses newlines and runs of whitespace", () => {
    // Multi-line prompts are pasted from prompt boxes; a raw newline inside the
    // caption would collapse to a blank line and eat the visible height.
    expect(mediaExcerpt("neon\n\n  alley,   rain")).toBe("neon alley, rain");
  });

  it("cuts a long prompt at a word boundary and marks the cut", () => {
    // Exact output, so a regression that slices mid-tag ("wallpap…") or drops
    // the ellipsis — leaving a caption that reads like the whole prompt — fails
    // here rather than in a screenshot.
    expect(mediaExcerpt(LONG)).toBe("masterpiece, best quality, extremely detailed CG unity 8k wallpaper,…");
  });

  it("still marks the cut when the prompt has no usable word boundary", () => {
    // A single 500-character token (a base64-ish seed or a URL) must not
    // return an unmarked prefix that reads like the whole prompt.
    const out = mediaExcerpt("x".repeat(500));
    expect(out).toBe(`${"x".repeat(72)}…`);
  });

  it("honours an explicit limit", () => {
    expect(mediaExcerpt(LONG, 20)).toBe("masterpiece, best…");
  });
});
