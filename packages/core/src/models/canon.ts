/**
 * Phase 1 — Canon governance schema.
 *
 * All long-form setting judgements are normalized into a single `CanonClaim`
 * abstraction (design doc §3.1). Prose foundation produced by the architect
 * remains the source of "灵气"; these structures are the *machine-checkable*
 * authority layer that the writer / auditor / volume gate read from.
 *
 * Files on disk (all under `story/canon/`):
 *   claims.json             — collection of CanonClaim
 *   world_system.json       — what the world allows (见 §3.3 世界体系)
 *   protagonist_system.json — how the protagonist enters/exploits/fights the world (§3.3 主角体系)
 *   system_relations.json   — how the two collide (§3.3 关系层)
 *
 * Nothing here mutates truth files. Chapter-level state deltas (runtime-state.ts)
 * are a separate concern; canon claims are the *static* authority.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Core claim taxonomy
// ---------------------------------------------------------------------------

export const CanonDomainSchema = z.enum([
  "world",
  "protagonist",
  "character",
  "organization",
  "power",
  "relationship",
  "history",
  "style",
]);
export type CanonDomain = z.infer<typeof CanonDomainSchema>;

export const CanonClaimTypeSchema = z.enum([
  "objective_rule",
  "institution_rule",
  "character_exception",
  "belief",
  "rumor",
  "secret_truth",
  "temporary_state",
  "prohibition",
]);
export type CanonClaimType = z.infer<typeof CanonClaimTypeSchema>;

export const ClaimPrioritySchema = z.enum(["hard", "strong", "soft"]);
export type ClaimPriority = z.infer<typeof ClaimPrioritySchema>;

export const SystemRelationModeSchema = z.enum([
  "obey",
  "exploit",
  "resist",
  "excluded",
  "hybrid",
  "rewrite",
]);
export type SystemRelationMode = z.infer<typeof SystemRelationModeSchema>;

// ---------------------------------------------------------------------------
// CanonClaim — the unified setting judgement (§3.1)
// ---------------------------------------------------------------------------

export const CanonClaimSchema = z.object({
  id: z.string().min(1),
  domain: CanonDomainSchema,
  claimType: CanonClaimTypeSchema,
  content: z.string().min(1),
  scope: z
    .object({
      appliesTo: z.array(z.string()).default([]),
      excludes: z.array(z.string()).optional(),
      geography: z.array(z.string()).optional(),
      timeRange: z.string().optional(),
    })
    .default({ appliesTo: [] }),
  authority: z.object({
    source: z.string().min(1),
    priority: ClaimPrioritySchema.default("soft"),
  }),
  visibility: z
    .object({
      readerKnownFrom: z.number().int().min(0).optional(),
      characterKnownBy: z.array(z.string()).default([]),
      hiddenFrom: z.array(z.string()).default([]),
    })
    .default({}),
  relations: z
    .object({
      conflictsWith: z.array(z.string()).optional(),
      resolvesBy: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
    })
    .optional(),
  constraints: z
    .object({
      nonGeneralizable: z.boolean().optional(),
      requiresCost: z.array(z.string()).default([]),
      forbiddenUses: z.array(z.string()).default([]),
    })
    .default({}),
});
export type CanonClaim = z.infer<typeof CanonClaimSchema>;

export const ClaimsFileSchema = z.object({
  claims: z.array(CanonClaimSchema),
});
export type ClaimsFile = z.infer<typeof ClaimsFileSchema>;

// ---------------------------------------------------------------------------
// World system — what the world allows (§3.3)
// ---------------------------------------------------------------------------

export const WorldSystemSchema = z.object({
  objectiveRules: z.array(z.string()).default([]),
  hardCaps: z.array(z.string()).default([]),
  costs: z.array(z.string()).default([]),
  taboos: z.array(z.string()).default([]),
});
export type WorldSystem = z.infer<typeof WorldSystemSchema>;

// ---------------------------------------------------------------------------
// Protagonist system — how the protagonist engages the world (§3.3)
// ---------------------------------------------------------------------------

export const ProtagonistSystemSchema = z.object({
  name: z.string().min(1),
  entryPoint: z.string().default(""),
  exceptionality: z.string().default(""),
  growthPath: z.string().default(""),
  costs: z.array(z.string()).default([]),
  nonGeneralizable: z.array(z.string()).default([]),
});
export type ProtagonistSystem = z.infer<typeof ProtagonistSystemSchema>;

// ---------------------------------------------------------------------------
// System relations — how protagonist system collides with world system (§3.3)
// ---------------------------------------------------------------------------

export const SystemRelationSchema = z.object({
  mode: SystemRelationModeSchema,
  conflictPoints: z.array(z.string()).default([]),
  nonGeneralizable: z.array(z.string()).default([]),
  auditRules: z.array(z.string()).default([]),
});
export type SystemRelation = z.infer<typeof SystemRelationSchema>;

// ---------------------------------------------------------------------------
// Bundle — aggregate of all four canon files for convenient load/save.
// ---------------------------------------------------------------------------

export interface CanonBundle {
  readonly claims: ClaimsFile;
  readonly worldSystem: WorldSystem;
  readonly protagonistSystem: ProtagonistSystem | null;
  readonly systemRelations: SystemRelation | null;
}

export function emptyClaimsFile(): ClaimsFile {
  return { claims: [] };
}

export function emptyWorldSystem(): WorldSystem {
  return WorldSystemSchema.parse({});
}


