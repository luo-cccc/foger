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
  "chapter-analyzer",
] as const;

export const PHASE7_MODEL_ROUTING_AGENTS = [
  "canon-extractor",
  "claim-validator",
  "volume-auditor",
  "state-validator",
] as const;

export type KnownModelRoutingAgent = typeof KNOWN_MODEL_ROUTING_AGENTS[number];
