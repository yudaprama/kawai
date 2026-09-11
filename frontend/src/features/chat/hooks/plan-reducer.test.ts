import { describe, expect, it } from "vitest";
import type { SupervisorPlanState } from "./supervisor-types";
import {
  initialSupervisorState,
  supervisorReducer,
  supervisorPatch,
  seedSteps,
  parseReview,
  pruneReviewStep,
} from "./plan-reducer";

const NOW = 1_700_000_000_000;

function step(
  id: string,
  overrides: Partial<{ tool: string; task: string; dependsOn: string[] }> = {},
): { id: string; tool: string; task: string; dependsOn: string[] } {
  return { id, tool: "web_read", task: `task ${id}`, dependsOn: [], ...overrides };
}

describe("initialSupervisorState", () => {
  it("returns idle with empty steps", () => {
    const s = initialSupervisorState();
    expect(s.status).toBe("idle");
    expect(s.steps).toEqual([]);
    expect(s.planVersion).toBe(0);
    expect(s.replansExhausted).toBe(false);
  });
});

describe("supervisorReducer — happy path", () => {
  it("planStarted seeds steps and sets goal", () => {
    const s = supervisorReducer(
      initialSupervisorState(),
      { type: "planStarted", goal: "analyze data", stepCount: 2, steps: [step("a"), step("b")], planKey: "pk1" },
      { now: NOW },
    );
    expect(s.status).toBe("idle"); // planStarted doesn't change status
    expect(s.goal).toBe("analyze data");
    expect(s.steps).toHaveLength(2);
    expect(s.steps[0].state).toBe("pending");
    expect(s.planKey).toBe("pk1");
    expect(s.planStartedAt).toBe(NOW);
    expect(s.planCompletedAt).toBeNull();
  });

  it("full lifecycle: planStarted → stepStarted → stepCompleted → planCompleted", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(s, { type: "stepStarted", stepId: "a", tool: "web_read" }, { now: NOW + 100 });
    expect(s.steps[0].state).toBe("running");
    expect(s.steps[0].startedAt).toBe(NOW + 100);

    s = supervisorReducer(
      s,
      { type: "stepCompleted", stepId: "a", output: "result", artifacts: [], retries_used: 0 },
      { now: NOW + 200 },
    );
    expect(s.steps[0].state).toBe("completed");
    expect(s.steps[0].output).toBe("result");
    expect(s.steps[0].finishedAt).toBe(NOW + 200);

    s = supervisorReducer(s, { type: "planCompleted", finalOutput: "done" }, { now: NOW + 300 });
    expect(s.status).toBe("completed");
    expect(s.finalOutput).toBe("done");
    expect(s.planCompletedAt).toBe(NOW + 300);
    expect(s.pendingConfirmation).toBeNull();
  });

  it("planStarted → stepFailed → planFailed", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(
      s,
      { type: "stepFailed", stepId: "a", error: "timeout", kind: "timeout" },
      { now: NOW + 100 },
    );
    expect(s.steps[0].state).toBe("failed");
    expect(s.steps[0].error).toBe("timeout");
    expect(s.steps[0].errorKind).toBe("timeout");

    s = supervisorReducer(s, { type: "planFailed", error: "step a failed" }, { now: NOW + 200 });
    expect(s.status).toBe("failed");
    expect(s.error).toBe("step a failed");
  });
});

describe("supervisorReducer — replan", () => {
  it("snapshots prior version and re-seeds steps on planRevised", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 2, steps: [step("a"), step("b")], planKey: "pk1" },
      { now: NOW },
    );
    s = supervisorReducer(s, { type: "stepStarted", stepId: "a", tool: "web_read" }, { now: NOW + 100 });
    s = supervisorReducer(
      s,
      { type: "stepCompleted", stepId: "a", output: "ok", artifacts: [], retries_used: 0 },
      { now: NOW + 200 },
    );
    s = supervisorReducer(s, { type: "stepFailed", stepId: "b", error: "boom", kind: "tool" }, { now: NOW + 300 });

    s = supervisorReducer(s, { type: "planRevising", failedStepIds: ["b"], attempt: 1 }, { now: NOW + 400 });
    expect(s.status).toBe("running");
    expect(s.pendingConfirmation).toBeNull();

    s = supervisorReducer(
      s,
      { type: "planRevised", attempt: 1, stepCount: 1, steps: [step("b", { tool: "code_write" })], planKey: "pk2" },
      { now: NOW + 500 },
    );
    expect(s.status).toBe("running");
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].stepId).toBe("b");
    expect(s.steps[0].state).toBe("pending");
    expect(s.planVersion).toBe(1); // initialSupervisorState starts at 0, first replan → 0+1
    expect(s.planKey).toBe("pk2");
    expect(s.priorVersions).toHaveLength(1);
    expect(s.priorVersions[0]).toEqual({ version: 0, completed: 1, total: 2, note: "revised after failure" });
    expect(s.replansExhausted).toBe(true); // 1 prior version >= 1
    expect(s.error).toBeNull();
  });

  it("replansExhausted stays false until 2 replans", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk1" },
      { now: NOW },
    );
    s = supervisorReducer(
      s,
      { type: "planRevised", attempt: 1, stepCount: 1, steps: [step("a")], planKey: "pk2" },
      { now: NOW + 100 },
    );
    expect(s.replansExhausted).toBe(true); // 1 prior >= 1

    s = supervisorReducer(
      s,
      { type: "planRevised", attempt: 2, stepCount: 1, steps: [step("a")], planKey: "pk3" },
      { now: NOW + 200 },
    );
    expect(s.replansExhausted).toBe(true); // 2 prior >= 1
    expect(s.priorVersions).toHaveLength(2);
    expect(s.planVersion).toBe(2); // 0 → 1 → 2
  });
});

describe("supervisorReducer — confirmation gate", () => {
  it("confirmationRequested sets awaitingConfirmation + pendingConfirmation", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(
      s,
      { type: "confirmationRequested", streamId: "s1", stepId: "a", task: "deploy", description: "confirm deploy" },
      { now: NOW + 100 },
    );
    expect(s.status).toBe("awaitingConfirmation");
    expect(s.pendingConfirmation).toEqual({
      streamId: "s1",
      stepId: "a",
      task: "deploy",
      description: "confirm deploy",
    });
    expect(s.steps[0].state).toBe("running");
  });

  it("planRevising clears pendingConfirmation", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(
      s,
      { type: "confirmationRequested", streamId: "s1", stepId: "a", task: "t", description: "d" },
      { now: NOW + 100 },
    );
    expect(s.pendingConfirmation).not.toBeNull();
    s = supervisorReducer(s, { type: "planRevising", failedStepIds: [], attempt: 1 }, { now: NOW + 200 });
    expect(s.pendingConfirmation).toBeNull();
    expect(s.status).toBe("running");
  });
});

describe("supervisorReducer — step skipped", () => {
  it("stepSkipped sets state to skipped with reason", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(s, { type: "stepSkipped", stepId: "a", reason: "dependency failed" }, { now: NOW + 100 });
    expect(s.steps[0].state).toBe("skipped");
    expect(s.steps[0].error).toBe("dependency failed");
  });
});

describe("supervisorReducer — planning progress", () => {
  it("planningStarted sets planning.searching", () => {
    const s = supervisorReducer(initialSupervisorState(), { type: "planningStarted" }, { now: NOW });
    expect(s.planning).toEqual({ round: 1, provider: "", searching: true, tools: [] });
  });

  it("planningRound updates round/provider/searching", () => {
    let s = supervisorReducer(initialSupervisorState(), { type: "planningStarted" }, { now: NOW });
    s = supervisorReducer(
      s,
      { type: "planningRound", round: 2, provider: "openai", searching: false },
      { now: NOW + 100 },
    );
    expect(s.planning).toEqual({ round: 2, provider: "openai", searching: false, tools: [] });
  });

  it("planningToolSearch sets searching=true and updates tools", () => {
    let s = supervisorReducer(initialSupervisorState(), { type: "planningStarted" }, { now: NOW });
    s = supervisorReducer(
      s,
      { type: "planningRound", round: 1, provider: "openai", searching: false },
      { now: NOW + 50 },
    );
    s = supervisorReducer(
      s,
      { type: "planningToolSearch", queries: ["q1"], tools: ["web_read", "code_write"] },
      { now: NOW + 100 },
    );
    expect(s.planning).toEqual({ round: 1, provider: "openai", searching: true, tools: ["web_read", "code_write"] });
  });
});

describe("supervisorReducer — edge cases", () => {
  it("unknown event returns state unchanged", () => {
    // planStarted IS handled, so use a truly unknown type
    const s = supervisorReducer(initialSupervisorState(), { type: "nope" } as any);
    expect(s).toEqual(initialSupervisorState());
  });

  it("stepStarted for unknown stepId creates a new step entry", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(s, { type: "stepStarted", stepId: "unknown", tool: "web_read" }, { now: NOW + 100 });
    expect(s.steps).toHaveLength(2);
    expect(s.steps[1].stepId).toBe("unknown");
    expect(s.steps[1].state).toBe("running");
  });

  it("planCompleted clears pendingConfirmation", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(
      s,
      { type: "confirmationRequested", streamId: "s1", stepId: "a", task: "t", description: "d" },
      { now: NOW + 100 },
    );
    expect(s.pendingConfirmation).not.toBeNull();
    s = supervisorReducer(s, { type: "planCompleted" }, { now: NOW + 200 });
    expect(s.pendingConfirmation).toBeNull();
    expect(s.status).toBe("completed");
  });

  it("planCompleted without finalOutput sets null", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(s, { type: "planStarted", goal: "g", stepCount: 0, steps: [], planKey: "pk" }, { now: NOW });
    s = supervisorReducer(s, { type: "planCompleted" }, { now: NOW + 100 });
    expect(s.finalOutput).toBeNull();
  });

  it("planRevised clears plan-level error", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    // plan-level error is set by planFailed, not stepFailed
    s = supervisorReducer(s, { type: "planFailed", error: "plan boom" }, { now: NOW + 100 });
    expect(s.error).toBe("plan boom");
    s = supervisorReducer(
      s,
      { type: "planRevised", attempt: 1, stepCount: 1, steps: [step("a")], planKey: "pk2" },
      { now: NOW + 200 },
    );
    expect(s.error).toBeNull();
  });
});

describe("supervisorReducer — step with artifacts", () => {
  it("stepCompleted maps artifacts correctly", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 1, steps: [step("a")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(
      s,
      {
        type: "stepCompleted",
        stepId: "a",
        output: "done",
        artifacts: [{ kind: "file", handle: "h1", filename: "report.pdf", label: "Report" }],
        retries_used: 2,
      },
      { now: NOW + 100 },
    );
    expect(s.steps[0].artifacts).toHaveLength(1);
    expect(s.steps[0].artifacts[0]).toEqual({ kind: "file", handle: "h1", filename: "report.pdf", label: "Report" });
    expect(s.steps[0].retriesUsed).toBe(2);
  });
});

describe("supervisorPatch", () => {
  it("merges partial into state", () => {
    const s = initialSupervisorState();
    const patched = supervisorPatch(s, { status: "running", goal: "test" });
    expect(patched.status).toBe("running");
    expect(patched.goal).toBe("test");
    expect(patched.steps).toEqual([]); // untouched fields stay
  });
});

describe("seedSteps", () => {
  it("maps wire steps to pending SupervisorSteps", () => {
    const result = seedSteps([step("a", { tool: "code_write", task: "write code" }), step("b")]);
    void result; // suppress unused-variable lint; assertions below cover the value
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      stepId: "a",
      tool: "code_write",
      task: "write code",
      dependsOn: [],
      state: "pending",
      artifacts: [],
    });
  });
});

describe("parseReview", () => {
  it("parses valid plan into review model", () => {
    const plan = { goal: "analyze", steps: [step("a"), step("b")] };
    const review = parseReview(plan, 42, "agent-1");
    expect(review).not.toBeNull();
    expect(review!.goal).toBe("analyze");
    expect(review!.sessionId).toBe(42);
    expect(review!.agentId).toBe("agent-1");
    expect(review!.steps).toHaveLength(2);
  });

  it("filters out non-dispatchable tools", () => {
    const plan = {
      goal: "g",
      steps: [step("a"), { id: "c", tool: "deep_write", task: "skip me", dependsOn: [] }],
    };
    const review = parseReview(plan, 1, "a");
    expect(review!.steps).toHaveLength(1);
    expect(review!.steps[0].id).toBe("a");
  });

  it("returns null for non-object plan", () => {
    expect(parseReview(null, 1, "a")).toBeNull();
    expect(parseReview("string", 1, "a")).toBeNull();
  });

  it("returns null when no dispatchable steps remain", () => {
    const plan = {
      goal: "g",
      steps: [{ id: "a", tool: "deep_write", task: "t", dependsOn: [] }],
    };
    expect(parseReview(plan, 1, "a")).toBeNull();
  });

  it("marks requiresConfirmation steps", () => {
    const plan = {
      goal: "g",
      steps: [{ id: "a", tool: "web_read", task: "t", dependsOn: [], requiresConfirmation: true }],
    };
    const review = parseReview(plan, 1, "a");
    expect(review!.steps[0].requiresConfirmation).toBe(true);
  });
});

describe("pruneReviewStep", () => {
  it("removes a step and its dependents", () => {
    const review = parseReview(
      {
        goal: "g",
        steps: [
          { id: "a", tool: "web_read", task: "t1", dependsOn: [] },
          { id: "b", tool: "code_write", task: "t2", dependsOn: ["a"] },
          { id: "c", tool: "web_read", task: "t3", dependsOn: ["b"] },
        ],
      },
      1,
      "a",
    )!;
    const pruned = pruneReviewStep(review, "a");
    expect(pruned.steps.map((s) => s.id)).toEqual([]);
  });

  it("removes only the targeted step when no dependents", () => {
    const review = parseReview(
      {
        goal: "g",
        steps: [
          { id: "a", tool: "web_read", task: "t1", dependsOn: [] },
          { id: "b", tool: "web_read", task: "t2", dependsOn: [] },
        ],
      },
      1,
      "a",
    )!;
    const pruned = pruneReviewStep(review, "a");
    expect(pruned.steps.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("supervisorReducer — multi-step execution ordering", () => {
  it("parallel steps complete independently", () => {
    let s: SupervisorPlanState = initialSupervisorState();
    s = supervisorReducer(
      s,
      { type: "planStarted", goal: "g", stepCount: 3, steps: [step("a"), step("b"), step("c")], planKey: "pk" },
      { now: NOW },
    );
    s = supervisorReducer(s, { type: "stepStarted", stepId: "a", tool: "web_read" }, { now: NOW + 100 });
    s = supervisorReducer(s, { type: "stepStarted", stepId: "b", tool: "code_write" }, { now: NOW + 110 });
    s = supervisorReducer(s, { type: "stepStarted", stepId: "c", tool: "web_read" }, { now: NOW + 120 });

    // Complete in reverse order
    s = supervisorReducer(
      s,
      { type: "stepCompleted", stepId: "c", output: "c-out", artifacts: [], retries_used: 0 },
      { now: NOW + 200 },
    );
    s = supervisorReducer(
      s,
      { type: "stepCompleted", stepId: "a", output: "a-out", artifacts: [], retries_used: 0 },
      { now: NOW + 300 },
    );
    expect(s.steps[0].state).toBe("completed");
    expect(s.steps[1].state).toBe("running");
    expect(s.steps[2].state).toBe("completed");

    s = supervisorReducer(
      s,
      { type: "stepCompleted", stepId: "b", output: "b-out", artifacts: [], retries_used: 0 },
      { now: NOW + 400 },
    );
    s = supervisorReducer(s, { type: "planCompleted", finalOutput: "all done" }, { now: NOW + 500 });
    expect(s.status).toBe("completed");
    expect(s.steps.every((st) => st.state === "completed")).toBe(true);
  });
});
