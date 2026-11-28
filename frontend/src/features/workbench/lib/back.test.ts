import { describe, expect, it } from "vitest";

import { nextBackStep } from "./back";

const idle = { mobileRail: false, home: false, runBusy: false };

describe("nextBackStep", () => {
  it("walks the run view back to the landing composer", () => {
    expect(nextBackStep(idle)).toBe("goHome");
  });

  it("closes the progress drawer before anything else", () => {
    expect(nextBackStep({ ...idle, mobileRail: true })).toBe("closeRail");
  });

  it("closes the drawer even when the run view would otherwise be next", () => {
    expect(nextBackStep({ ...idle, mobileRail: true, runBusy: true })).toBe("closeRail");
  });

  it("closes the drawer on the landing too — a stale flag must not swallow the press", () => {
    expect(nextBackStep({ ...idle, mobileRail: true, home: true })).toBe("closeRail");
  });

  it("refuses to leave a run in flight", () => {
    expect(nextBackStep({ ...idle, runBusy: true })).toBe("blocked");
  });

  it("reports nothing left to close on the landing", () => {
    expect(nextBackStep({ ...idle, home: true })).toBe("none");
  });

  it("treats the landing as the root even with a busy flag", () => {
    // A run cannot be busy while the landing shows, but if the two ever
    // disagree the page must not claim a step it does not have.
    expect(nextBackStep({ ...idle, home: true, runBusy: true })).toBe("none");
  });
});
