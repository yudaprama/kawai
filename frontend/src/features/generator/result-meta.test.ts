import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detailLine, resultMeta } from "./generator-shell";

/**
 * `resultMeta` renders the secondary line under a result card: a relative
 * timestamp plus whatever the lane knows about the run. Both halves matter:
 * the timestamp was stored on every result since v1 and never rendered, and
 * the unit ladder has off-by-one boundaries (59s must not say "1 minute",
 * 364 days must not say "1 year") that a naive implementation gets wrong.
 */

const NOW = 1_700_000_000_000;
const at = (secondsAgo: number) => NOW - secondsAgo * 1000;

// `resultMeta` reads Date.now(), so the clock is frozen rather than raced.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
describe("resultMeta", () => {
  it("reports the most recent runs in seconds", () => {
    // Exercises the real Intl formatter rather than a hand-rolled string, so
    // the assertion matches what the user actually reads.
    const expected = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-5, "second");
    expect(resultMeta(at(5))).toBe(expected);
  });

  it("steps up a unit only past the boundary", () => {
    const rtf = () => new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    expect(resultMeta(at(59))).toBe(rtf().format(-59, "second"));
    expect(resultMeta(at(61))).toBe(rtf().format(-1, "minute"));
    expect(resultMeta(at(3600))).toBe(rtf().format(-1, "hour"));
    expect(resultMeta(at(86400))).toBe(rtf().format(-1, "day"));
  });

  it("never falls off the end of the unit ladder", () => {
    // 400 days: past month and year spans, must still return a string.
    expect(resultMeta(at(400 * 86400))).not.toBe("");
    expect(resultMeta(at(400 * 86400))).toBeTypeOf("string");
  });

  it("appends the lane's detail after the timestamp", () => {
    const stamp = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-5, "second");
    expect(resultMeta(at(5), "1024×1024")).toBe(`${stamp} · 1024×1024`);
  });

  it("omits the separator when the lane knows nothing", () => {
    const stamp = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-5, "second");
    expect(resultMeta(at(5), undefined)).toBe(stamp);
    expect(resultMeta(at(5), "")).toBe(stamp);
  });
});

describe("detailLine", () => {
  it("joins the fields a run actually carried", () => {
    expect(detailLine("8s", "720p", undefined, "kling-v3")).toBe("8s · 720p · kling-v3");
  });

  it("drops absent fields instead of leaving holes", () => {
    expect(detailLine(undefined, "720p", null)).toBe("720p");
    expect(detailLine(false, "", undefined)).toBeUndefined();
  });

  it("returns undefined when nothing is known, so the caller omits the line", () => {
    expect(detailLine()).toBeUndefined();
  });
});
