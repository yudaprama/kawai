import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ECOSYSTEMS,
  TOKENS_PER_BUZZ,
  WORKFLOWS,
  estimateBuzz,
  ecosystemsForWorkflow,
  isSdFamily,
  isWorkflowAvailable,
  resolveCompatibleEcosystem,
  targetWorkflowForEcosystem,
} from "./ecosystems";

/**
 * `estimateBuzz` is a frontend mirror of `logic::civitai::image_buzz_estimate`
 * (src-tauri/src/logic/civitai.rs) — the panel has no free pricing mode to
 * ask, so this formula IS the quote. If the two drift the panel either
 * under-quotes (the submit sails past the client pre-check and dies on the
 * server's fail-closed gate after the user waited) or over-quotes (Generate
 * is disabled for a balance that would actually have covered it).
 *
 * These cases are the branch structure of the Rust original:
 *   generation = workflow == "img2img:upscale" ? 0 : unit
 *   passes     = workflow in {hires-fix, upscale} ? repeats * 4 * unit : 0
 *   total      = generation + passes
 *   debit      = ceil(total * TOKENS_PER_BUZZ)
 */
describe("estimateBuzz", () => {
  /** 8 × (1024×1024 / 1024²) × (30 / 25) × 1 */
  const UNIT_1024_STEPS30 = 8 * (30 / 25);

  it("charges the generation unit for a plain text-to-image run", () => {
    expect(estimateBuzz({ width: 1024, height: 1024, steps: 30, workflow: "txt2img" })).toBeCloseTo(
      UNIT_1024_STEPS30,
      10,
    );
  });

  it("defaults to 30 steps when the form has no valid step count", () => {
    const explicit = estimateBuzz({ width: 1024, height: 1024, steps: 30 });
    expect(estimateBuzz({ width: 1024, height: 1024, steps: undefined })).toBeCloseTo(explicit, 10);
    // A zero/NaN entry (the field is mid-edit) falls back rather than free.
    expect(estimateBuzz({ width: 1024, height: 1024, steps: 0 })).toBeCloseTo(explicit, 10);
  });

  it("defaults to text-to-image pricing for an unknown workflow", () => {
    expect(estimateBuzz({ width: 1024, height: 1024, steps: 30, workflow: "something-else" })).toBeCloseTo(
      estimateBuzz({ width: 1024, height: 1024, steps: 30, workflow: "txt2img" }),
      10,
    );
  });

  it("bills hires-fix as generation PLUS its upscale passes (4× unit each)", () => {
    expect(
      estimateBuzz({
        width: 1024,
        height: 1024,
        steps: 30,
        workflow: "txt2img:hires-fix",
        upscaleRepeats: 1,
      }),
    ).toBeCloseTo(UNIT_1024_STEPS30 * 5, 10);
    expect(
      estimateBuzz({
        width: 1024,
        height: 1024,
        steps: 30,
        workflow: "txt2img:hires-fix",
        upscaleRepeats: 3,
      }),
    ).toBeCloseTo(UNIT_1024_STEPS30 * 13, 10);
  });

  it("bills upscale as passes ONLY — never the generation unit", () => {
    const passesOnly = estimateBuzz({
      width: 1024,
      height: 1024,
      steps: 30,
      workflow: "img2img:upscale",
      upscaleRepeats: 2,
    });
    expect(passesOnly).toBeCloseTo(UNIT_1024_STEPS30 * 8, 10);
    // The regression this file exists for: the panel used to quote 0 here,
    // which is a real token spend the balance check would wave through.
    expect(passesOnly).toBeGreaterThan(0);
  });

  it("scales with pixel area, step count and quantity", () => {
    const base = { width: 1024, height: 1024, steps: 30, quantity: 1, workflow: "txt2img" };
    const reference = estimateBuzz(base);
    // 1344×768 is the panel's 16:9 bucket at base 1024 (~0.98 MP).
    expect(estimateBuzz({ ...base, width: 1344, height: 768 })).toBeCloseTo(reference * 0.984375, 6);
    expect(estimateBuzz({ ...base, steps: 60 })).toBeCloseTo(reference * 2, 10);
    expect(estimateBuzz({ ...base, quantity: 4 })).toBeCloseTo(reference * 4, 10);
  });

  it("keeps upscale passes proportional to the generation unit they follow", () => {
    // A pass is priced at the DOUBLED dims (4× the unit), so widening the
    // image widens the passes by the same factor.
    const narrow = estimateBuzz({
      width: 1024,
      height: 1024,
      steps: 30,
      workflow: "txt2img:hires-fix",
      upscaleRepeats: 1,
    });
    const wide = estimateBuzz({
      width: 1344,
      height: 768,
      steps: 30,
      workflow: "txt2img:hires-fix",
      upscaleRepeats: 1,
    });
    expect(wide / narrow).toBeCloseTo(0.984375, 6);
  });
});

/**
 * The picker menus derive their dimmed/retargeting entries from these — the
 * ecosystem selector and the workflow card must always agree on which
 * combinations exist, whichever one the user touched last.
 */
describe("workflow/ecosystem coherence", () => {
  it("gives every image ecosystem the plain text-to-image workflow", () => {
    expect(ecosystemsForWorkflow("txt2img")).toEqual(ECOSYSTEMS.map((e) => e.id));
  });

  it("restricts the SD-only workflows to the SD-family ecosystems", () => {
    for (const id of ["txt2img:hires-fix", "img2img"]) {
      expect(ecosystemsForWorkflow(id)).toEqual(["sd1", "sdxl"]);
    }
    expect(isSdFamily("sd1")).toBe(true);
    expect(isSdFamily("flux1")).toBe(false);
  });

  it("retargets to a workflow that can actually serve the ecosystem", () => {
    // An SD-only workflow cannot serve a Flux ecosystem, so picking one has to
    // move the workflow somewhere that works. `txt2img` serves every
    // ecosystem and heads WORKFLOWS, so it is always a valid landing pad —
    // the contract is "can serve it", not one specific workflow.
    expect(isWorkflowAvailable("img2img", "flux1")).toBe(false);
    for (const eco of ECOSYSTEMS) {
      const target = targetWorkflowForEcosystem(eco.id);
      expect(WORKFLOWS.some((w) => w.id === target)).toBe(true);
      expect(isWorkflowAvailable(target, eco.id)).toBe(true);
    }
  });

  it("leaves a compatible pair untouched", () => {
    expect(resolveCompatibleEcosystem("txt2img", "anima")).toBe("anima");
    expect(resolveCompatibleEcosystem("img2img", "sd1")).toBe("sd1");
    // Incompatible → the workflow's own default ecosystem.
    expect(resolveCompatibleEcosystem("img2img", "anima")).toBe("sd1");
  });

  it("describes every workflow and points each at known ecosystems", () => {
    for (const w of WORKFLOWS) {
      expect(ecosystemsForWorkflow(w.id).length).toBeGreaterThan(0);
      expect(w.description.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The backend constant is authoritative (the fail-closed debit at submit
 * ceils over it in `logic::civitai.rs`); the panel's ≈ pill only displays.
 * If the twins drift, the pill quotes a debit the backend disagrees with —
 * either blocking a Generate the balance would have covered or sailing past
 * it into the 409. This reads the Rust source so a rename or value change
 * on either side fails here instead of lying to users.
 */
describe("TOKENS_PER_BUZZ parity with the Rust debit", () => {
  it("matches logic::civitai::TOKENS_PER_BUZZ", () => {
    const rust = readFileSync(new URL("../../../../src-tauri/src/logic/civitai.rs", import.meta.url), "utf8");
    const match = rust.match(/pub const TOKENS_PER_BUZZ: u64 = ([\d_]+);/);
    if (!match) {
      throw new Error("TOKENS_PER_BUZZ declaration not found in civitai.rs — rename or move?");
    }
    expect(TOKENS_PER_BUZZ).toBe(Number(match[1].replaceAll("_", "")));
  });
});
