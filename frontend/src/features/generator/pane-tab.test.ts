import { describe, expect, it } from "vitest";

import { laneSurface, paneTab } from "./generator-shell";

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

/**
 * The narrow layout's Create ↔ Gallery surface: a submit or a landing result
 * pulls the user to the gallery once; a run that ends with nothing new leaves
 * them wherever they are (a failed job card must not yank anyone mid-form).
 */
describe("laneSurface", () => {
  it("opens on the form", () => {
    expect(laneSurface({ fresh: false, started: false, surface: "create" })).toBe("create");
  });

  it("pulls to the gallery when a run starts", () => {
    expect(laneSurface({ fresh: false, started: true, surface: "create" })).toBe("gallery");
  });

  it("follows a fresh result even from the form", () => {
    expect(laneSurface({ fresh: true, started: false, surface: "create" })).toBe("gallery");
  });

  it("never moves the user off the surface they picked on its own", () => {
    expect(laneSurface({ fresh: false, started: false, surface: "gallery" })).toBe("gallery");
  });
});
