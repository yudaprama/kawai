import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChoiceChip, EcoPicker, NumberStepper, ResultsPaneHeader, ToggleRow, choiceClass } from "./generator-shell";

/**
 * Render-level smoke for the shared lane chrome. The refactor replaced four
 * hand-rolled copies of these with one definition, so the properties worth
 * pinning are the ones that had drifted: the ecosystem picker must stay
 * labelled and wired to its lane's own copy, every chip must announce its
 * pressed state, and the toggle must use the app's switch primitive rather
 * than a bare native checkbox.
 *
 * Lane switching is deliberately absent — it moved to the global mode bar
 * (`app/mode-bar.test.tsx`), which owns the switcher now.
 */

describe("EcoPicker", () => {
  const picker = (ecoLabel: string) =>
    renderToStaticMarkup(
      <EcoPicker
        ecoAriaLabel="Ecosystem"
        ecoGroups={[]}
        ecoLabel={ecoLabel}
        ecoOpen={false}
        onEcoOpenChange={() => {}}
      />,
    );

  it("keeps the ecosystem picker labelled and wired to the lane's own copy", () => {
    const html = picker("SDXL");
    expect(html).toContain('aria-label="Ecosystem"');
    expect(html).toContain("SDXL");
  });

  it("carries no lane switcher — no lane name and no current-page claim leaks into the form", () => {
    const html = picker("Kling");
    for (const lane of ["Image", "Video", "Music", "3D"]) {
      expect(html).not.toContain(lane);
    }
    expect(html).not.toContain('aria-current="page"');
  });
});

describe("ChoiceChip", () => {
  it("exposes the pressed state to assistive tech", () => {
    const on = renderToStaticMarkup(
      <ChoiceChip active onClick={() => {}}>
        SDXL
      </ChoiceChip>,
    );
    const off = renderToStaticMarkup(
      <ChoiceChip active={false} onClick={() => {}}>
        SDXL
      </ChoiceChip>,
    );
    expect(on).toContain('aria-pressed="true"');
    expect(off).toContain('aria-pressed="false"');
  });

  it("keeps the four lanes on one chip treatment", () => {
    // All lanes import this one definition, so the active treatment cannot
    // diverge the way the three per-lane `choiceClassShared` copies did.
    expect(choiceClass(true)).toContain("border-primary");
    expect(choiceClass(true)).toContain("text-primary");
    expect(choiceClass(false)).toContain("text-muted-foreground");
  });
});

describe("ToggleRow", () => {
  it("renders a switch control rather than a bare native checkbox", () => {
    const html = renderToStaticMarkup(<ToggleRow checked label="Audio" onCheckedChange={() => {}} />);
    // Radix's Switch renders its own hidden `type="checkbox"` input for form
    // participation — what matters is that the control is themed and
    // keyboard-operable, which `role="switch"` on a button proves. The old
    // markup was a bare, unstyled `<input type="checkbox">` with no role.
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-slot="switch"');
    expect(html).toContain("Audio");
  });

  it("wires the checked state through", () => {
    const on = renderToStaticMarkup(<ToggleRow checked label="Draft" onCheckedChange={() => {}} />);
    const off = renderToStaticMarkup(<ToggleRow checked={false} label="Draft" onCheckedChange={() => {}} />);
    expect(on).toContain('data-state="checked"');
    expect(off).toContain('data-state="unchecked"');
  });
});

describe("ResultsPaneHeader", () => {
  it("renders the title and optional meta line", () => {
    expect(renderToStaticMarkup(<ResultsPaneHeader title="Results" />)).toContain("Results");
    expect(renderToStaticMarkup(<ResultsPaneHeader meta="12 results" title="Results" />)).toContain("12 results");
  });
});

describe("NumberStepper", () => {
  // React renders `disabled=""`, so match the ATTRIBUTE — a regex across the
  // whole tag also hits the `disabled:pointer-events-none` CSS class in the
  // button's class list and would read an enabled button as disabled.
  const isDisabled = (html: string, label: string) =>
    new RegExp(`<button[^>]*aria-label="${label}"[^>]*\\sdisabled=""`).test(html) ||
    new RegExp(`<button[^>]*\\sdisabled=""[^>]*aria-label="${label}"`).test(html);

  const stepper = (value: number) =>
    renderToStaticMarkup(
      <NumberStepper
        decrementLabel="Fewer"
        id="q"
        incrementLabel="More"
        max={12}
        min={1}
        onChange={() => {}}
        value={value}
      />,
    );

  it("disables the button that would exceed a bound", () => {
    // This is what makes the bound visible, not merely enforced on typing.
    expect(isDisabled(stepper(1), "Fewer")).toBe(true);
    expect(isDisabled(stepper(12), "More")).toBe(true);
  });

  it("keeps both buttons live mid-range", () => {
    const mid = stepper(5);
    expect(isDisabled(mid, "Fewer")).toBe(false);
    expect(isDisabled(mid, "More")).toBe(false);
  });

  it("exposes the bounds on the input and shows the current value", () => {
    const html = stepper(7);
    expect(html).toContain('min="1"');
    expect(html).toContain('max="12"');
    expect(html).toContain('value="7"');
  });
});
