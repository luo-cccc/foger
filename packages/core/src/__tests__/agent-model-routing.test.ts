import { describe, expect, it } from "vitest";
import {
  CONTENT_POLICY_FALLBACK_AGENTS,
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

  it("exposes settler routing and excludes creative prose agents from policy fallback", () => {
    expect(KNOWN_MODEL_ROUTING_AGENTS).toContain("settler");
    expect(CONTENT_POLICY_FALLBACK_AGENTS).toContain("settler");
    expect(CONTENT_POLICY_FALLBACK_AGENTS).not.toContain("writer");
    expect(CONTENT_POLICY_FALLBACK_AGENTS).not.toContain("reviser");
  });
});
