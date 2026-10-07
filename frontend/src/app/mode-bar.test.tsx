import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModePills } from "./mode-bar";

/**
 * The mode bar is the app's only top-level switcher, so its contract is the
 * one thing worth pinning here: every mode stays reachable and NAMED from any
 * surface (a mode with no accessible name is a mode a screen-reader user
 * cannot find), and exactly one pill can claim to be current. The active pill
 * renders inert, so a click on it can never re-enter the mode it is already in.
 */

const bar = (active: Parameters<typeof ModePills>[0]["active"]) =>
  renderToStaticMarkup(<ModePills active={active} onSelect={() => {}} />);

describe("ModePills", () => {
  it("names all five modes so none can go missing from the switcher", () => {
    const html = bar("text");
    for (const label of ["Text", "Image", "Video", "Audio", "3D Model"]) {
      expect(html).toContain(`>${label}</span>`);
    }
  });

  it("marks exactly the active mode with aria-current and renders it inert", () => {
    const html = bar("audio");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain("pointer-events-none");
  });

  it("gives every inactive mode an actionable, labelled button", () => {
    const html = bar("model3d");
    expect(html).toContain('aria-label="Text"');
    expect(html).toContain('aria-label="Audio"');
    // The active lane is not clickable, so it must not carry a button either.
    expect(html).not.toContain('aria-label="3D Model"');
  });

  it("shows no active mode while an asset page owns the pane", () => {
    // Lighting "Text" here would claim the Workbench is on screen when the
    // Wiki is — an asset is a different axis, not a mode.
    expect(bar(null)).not.toContain("aria-current");
  });

  it("exposes the switcher as a labelled navigation region", () => {
    expect(bar("image")).toContain('aria-label="Modes"');
  });
});
