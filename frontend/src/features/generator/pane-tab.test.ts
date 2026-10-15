import { describe, expect, it } from "vitest";

import { paneTab } from "./generator-shell";

/**
 * The results pane is a SECTION switcher, not an empty state. Before this,
 * every lane rendered the community template gallery ONLY while it had zero
 * results, so one saved result made the templates unreachable — the user had
 * to delete their media to get back to them. These pin the follow rules that
 * keep both reachable.
 */
describe("paneTab", () => {
  it("follows the templates while the lane is empty", () => {
    expect(paneTab({ busy: false, count: 0, override: null })).toBe("templates");
  });

  it("follows the results as soon as one exists", () => {
    // The regression: this used to keep rendering the gallery out of scope.
    expect(paneTab({ busy: false, count: 1, override: null })).toBe("results");
  });

  it("follows the results while a run is in flight, even before one lands", () => {
    // Generating from the templates tab must not leave the user staring at the
    // gallery they generated from while the job card sits above it.
    expect(paneTab({ busy: true, count: 0, override: null })).toBe("results");
  });

  it("keeps an explicit choice over the followed section", () => {
    expect(paneTab({ busy: false, count: 7, override: "templates" })).toBe("templates");
    expect(paneTab({ busy: false, count: 0, override: "results" })).toBe("results");
  });
});
