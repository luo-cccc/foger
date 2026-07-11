import { describe, expect, it } from "vitest";
import {
  buildDetectionConfig,
  buildNotifyChannel,
  detectionDraftFromConfig,
  MODEL_ROUTING_AGENTS,
  notifyDraftFromChannel,
  PHASE7_MODEL_ROUTING_AGENTS,
} from "./project-settings-model";

describe("project settings form model", () => {
  it("preserves webhook event filters when round-tripping notification channels", () => {
    const draft = notifyDraftFromChannel({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });

    expect(buildNotifyChannel(draft)).toEqual({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });
  });

  it("honors detection.enabled=false instead of re-enabling the detector", () => {
    const draft = detectionDraftFromConfig({
      enabled: false,
      provider: "custom",
      apiUrl: "https://detector.example.com/api",
      apiKeyEnv: "DETECT_KEY",
      threshold: 0.7,
      autoRewrite: true,
      maxRetries: 4,
    });

    expect(draft.enabled).toBe(false);
    expect(buildDetectionConfig(draft)).toBeNull();
  });

  it("exposes Phase 7 structured agents in the model routing catalog", () => {
    expect(PHASE7_MODEL_ROUTING_AGENTS).toEqual([
      "canon-extractor",
      "claim-validator",
      "volume-auditor",
      "state-validator",
    ]);
    for (const agent of PHASE7_MODEL_ROUTING_AGENTS) {
      expect(MODEL_ROUTING_AGENTS).toContain(agent);
    }
  });
});
