import { describe, expect, it } from "vitest";
import {
  KNOWN_MODEL_ROUTING_AGENTS,
  PHASE7_MODEL_ROUTING_AGENTS,
} from "../llm/agent-model-routing.js";

describe("agent model routing catalog", () => {
  it("keeps Phase 7 structured agents in the known routing catalog", () => {
    expect(PHASE7_MODEL_ROUTING_AGENTS).toEqual([
      "canon-extractor",
      "claim-validator",
      "volume-auditor",
      "state-validator",
    ]);
    for (const agent of PHASE7_MODEL_ROUTING_AGENTS) {
      expect(KNOWN_MODEL_ROUTING_AGENTS).toContain(agent);
    }
  });
});
