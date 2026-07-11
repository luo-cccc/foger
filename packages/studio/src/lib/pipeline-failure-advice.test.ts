import { describe, expect, it } from "vitest";
import { getPipelineFailureAction } from "./pipeline-failure-advice";

describe("getPipelineFailureAction", () => {
  it("prioritizes repair when the latest persisted chapter is state-degraded", () => {
    expect(getPipelineFailureAction({
      stage: "write",
      error: "Latest chapter 4 is state-degraded. Repair state before continuing.",
      canRepairLatestState: true,
    })).toBe("repair-state");
  });

  it("sends credential failures to model services", () => {
    expect(getPipelineFailureAction({
      stage: "draft",
      error: "401 unauthorized: API key is invalid",
      canRepairLatestState: false,
    })).toBe("open-services");
  });

  it("only offers a direct retry for idempotently recovered write flows", () => {
    expect(getPipelineFailureAction({
      stage: "write",
      error: "gateway timeout",
      canRepairLatestState: false,
    })).toBe("retry");
    expect(getPipelineFailureAction({
      stage: "rewrite",
      error: "gateway timeout",
      canRepairLatestState: false,
    })).toBe("open-doctor");
  });
});
