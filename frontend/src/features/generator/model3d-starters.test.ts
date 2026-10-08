import { describe, expect, it } from "vitest";

import { MODEL3D_ECOSYSTEMS } from "./model3d-ecosystems";
import { MODEL3D_NO_PROMPT, MODEL3D_STARTERS } from "./model3d-starters";

/**
 * A starter whose text is longer than the engine's `promptMax` leaves the
 * 3D form invalid (`hasPrompt` requires `length <= promptMax`), so the click
 * appears to do nothing. An engine listed as prompt-less must not get a card
 * either — its form has no field to fill.
 */

const engines = new Map<string, (typeof MODEL3D_ECOSYSTEMS)[number]>(MODEL3D_ECOSYSTEMS.map((e) => [e.id, e]));

describe("3D starters", () => {
  it("only names engines that exist", () => {
    for (const id of [...Object.keys(MODEL3D_STARTERS), ...MODEL3D_NO_PROMPT]) {
      expect(engines.has(id), `unknown engine "${id}"`).toBe(true);
    }
  });

  it("fits every prompt inside the engine's own ceiling", () => {
    for (const [id, starters] of Object.entries(MODEL3D_STARTERS)) {
      const eco = engines.get(id);
      expect(eco, id).toBeDefined();
      for (const starter of starters) {
        // Either field is bounded by the same engine-level ceiling.
        if (starter.prompt) {
          expect(starter.prompt.length, `${starter.id} prompt`).toBeLessThanOrEqual(eco?.promptMax ?? 0);
        }
        if (starter.texturePrompt) {
          expect(starter.texturePrompt.length, `${starter.id} texture`).toBeLessThanOrEqual(eco?.promptMax ?? 0);
        }
      }
    }
  });

  it("gives a prompt-less engine no starter, and only to a prompt-less engine", () => {
    // The two groups must partition: an engine in one cannot be in the other,
    // and every engine has to be in exactly one of them.
    for (const id of MODEL3D_NO_PROMPT) {
      expect(engines.get(id)?.promptMax, `${id} promptMax`).toBe(0);
      expect(MODEL3D_STARTERS[id], `${id} must have no starters`).toBeUndefined();
    }
    for (const [id, starters] of Object.entries(MODEL3D_STARTERS)) {
      expect(MODEL3D_NO_PROMPT.includes(id), `${id} listed as prompt-less`).toBe(false);
      expect(starters.length, id).toBeGreaterThan(0);
    }
    const covered = new Set([...MODEL3D_NO_PROMPT, ...Object.keys(MODEL3D_STARTERS)]);
    for (const eco of MODEL3D_ECOSYSTEMS) {
      expect(covered.has(eco.id), `engine "${eco.id}" is in neither group`).toBe(true);
    }
  });

  it("carries exactly one of prompt / texturePrompt", () => {
    for (const starters of Object.values(MODEL3D_STARTERS)) {
      for (const starter of starters) {
        expect(Boolean(starter.prompt) !== Boolean(starter.texturePrompt), starter.id).toBe(true);
      }
    }
  });

  it("has unique ids and non-empty copy", () => {
    const ids = new Set<string>();
    for (const starters of Object.values(MODEL3D_STARTERS)) {
      for (const starter of starters) {
        expect(ids.has(starter.id), `duplicate starter id ${starter.id}`).toBe(false);
        ids.add(starter.id);
        expect(starter.label.trim().length, starter.id).toBeGreaterThan(0);
        expect(starter.note.trim().length, starter.id).toBeGreaterThan(0);
      }
    }
  });
});
