export const KNOWN_MODEL_ROUTING_AGENTS = [
  "writer",
  "planner",
  "composer",
  "auditor",
  "reviser",
  "architect",
  "canon-extractor",
  "claim-validator",
  "volume-auditor",
  "state-validator",
] as const;

/**
 * Agents whose output governs planning, validation, or deterministic state projection.
 * Creative prose agents such as writer and reviser are deliberately excluded.
 */
export const CONTENT_POLICY_FALLBACK_AGENTS = [
  "planner",
  "composer",
  "auditor",
  "canon-extractor",
  "claim-validator",
  "volume-auditor",
  "state-validator",
] as const;

export const PHASE7_MODEL_ROUTING_AGENTS = [
  "canon-extractor",
  "claim-validator",
  "volume-auditor",
  "state-validator",
] as const;

export type KnownModelRoutingAgent = typeof KNOWN_MODEL_ROUTING_AGENTS[number];
export type ContentPolicyFallbackAgent = typeof CONTENT_POLICY_FALLBACK_AGENTS[number];
