import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderDataFetch } from "./data";

/**
 * Render-level pins for the `data_fetch` card.
 *
 * The payload shape is verbatim from `DataFetchTool::call`
 * (crates/toolsets/analytics-tools/src/lib.rs). Two traps this guards:
 *
 *  - the name field is lowercase `filename` (data_import emits camelCase
 *    `fileName`) — a sibling copy-paste silently loses the name;
 *  - the payload carries `kind: "data"`, which the renderer must require so a
 *    foreign payload with a coincidental `fileId` never half-renders.
 */
const FETCH = {
  kind: "data",
  fileId: "doc3",
  filename: "btcusdt-1d-1735689600.csv",
  symbol: "BTCUSDT",
  interval: "1d",
  periodsPerYear: 365,
  rows: 200,
  bytes: 21504,
  columns: ["timestamp", "open", "high", "low", "close", "volume"],
  nextStep: 'run data_ta on fileId (timestamp="timestamp", close="close"); pass periodsPerYear=<the value above>',
};

const html = (doc: unknown) => renderToStaticMarkup(<>{renderDataFetch(JSON.stringify(doc))}</>);

describe("renderDataFetch", () => {
  it("renders the stored-candles card", () => {
    const out = html(FETCH);
    expect(out).toContain("BTCUSDT");
    expect(out).toContain("200 candles");
    expect(out).toContain("1d");
    expect(out).toContain("365 bars/yr");
    expect(out).toContain("Preview csv");
    expect(out).toContain("data_ta");
  });

  it("reads the lowercase filename field, not data_import's fileName", () => {
    const out = html(FETCH);
    expect(out).toContain("btcusdt-1d-1735689600.csv");
  });

  it("renders without the optional interval/annualization fields", () => {
    const out = html({ ...FETCH, interval: undefined, periodsPerYear: undefined });
    expect(out).toContain("BTCUSDT");
    expect(out).not.toContain("bars/yr");
  });

  it("refuses a foreign kind instead of half-rendering it", () => {
    expect(html({ ...FETCH, kind: "ta" })).toBe("");
    expect(html({ kind: "data" })).toBe("");
    expect(html("not json")).toBe("");
  });
});
