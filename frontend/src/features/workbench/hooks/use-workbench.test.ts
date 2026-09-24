import { describe, expect, it } from "vitest";

import { hydrateStep, type PersistedPlanStep } from "./use-workbench";

describe("hydrateStep", () => {
  it("restores per-step artifacts and the failure message from the record", () => {
    const step: PersistedPlanStep = {
      id: "s1",
      tool: "data_query_nl",
      state: "failed",
      output: "partial…",
      task: "Analyzing revenue",
      dependsOn: ["s0"],
      artifacts: [{ kind: "file", handle: "h1", filename: "report.pdf", label: "Report" }],
      error: "timeout after 30s",
    };
    expect(hydrateStep(step)).toEqual({
      stepId: "s1",
      tool: "data_query_nl",
      task: "Analyzing revenue",
      state: "failed",
      dependsOn: ["s0"],
      inputs: [],
      output: "partial…",
      artifacts: [{ kind: "file", handle: "h1", filename: "report.pdf", label: "Report" }],
      error: "timeout after 30s",
    });
  });

  it("falls back to tool/[]/undefined for steps of records written before the fields existed", () => {
    const hydrated = hydrateStep({ id: "s2", tool: "web_search", state: "completed" });
    expect(hydrated.task).toBe("web_search");
    expect(hydrated.artifacts).toEqual([]);
    expect(hydrated.error).toBeUndefined();
    expect(hydrated.inputs).toEqual([]);
    expect(hydrated.dependsOn).toEqual([]);
  });
});
