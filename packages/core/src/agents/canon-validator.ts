/**
 * Phase 2 — CanonValidator.
 *
 * Deterministic, model-free checks over a set of CanonClaim + the derived
 * world / protagonist / relation systems (design doc section 6.2). These are
 * gate-level invariants; they never call an LLM so they run cheaply and in
 * tests without network.
 *
 * Rules enforced:
 *   - necessary fields / well-formed schema (delegated to Zod on load)
 *   - character_exception claims default to nonGeneralizable unless the author
 *     explicitly explains a generalization condition
 *   - secret_truth claims must declare a reader/character visibility boundary
 *   - conflicting claims must declare a resolvesBy edge
 *   - a hard priority (objective_rule / prohibition) cannot be overridden by a
 *     lower-priority claim without an explicit resolution signal
 */

import type { CanonClaim, SystemRelation } from "../models/canon.js";

export type CanonIssueSeverity = "error" | "warning";

export interface CanonIssue {
  readonly code: string;
  readonly severity: CanonIssueSeverity;
  readonly claimId?: string;
  readonly message: string;
}

const NON_GENERALIZABLE_TYPES = new Set(["character_exception"]);

export function validateCanonClaims(
  claims: ReadonlyArray<CanonClaim>,
  relations?: SystemRelation | null,
): ReadonlyArray<CanonIssue> {
  const issues: CanonIssue[] = [];
  const byId = new Map<string, CanonClaim>();
  const seenIds = new Set<string>();

  for (const claim of claims) {
    if (seenIds.has(claim.id)) {
      issues.push({
        code: "duplicate_claim_id",
        severity: "error",
        claimId: claim.id,
        message: `Duplicate claim id "${claim.id}" — claim ids must be unique.`,
      });
    }
    seenIds.add(claim.id);
    byId.set(claim.id, claim);

    issues.push(...validateSingleClaim(claim, byId));
  }

  issues.push(...validateConflicts(claims, byId));
  issues.push(...validatePriorityDominance(claims));
  if (relations) {
    issues.push(...validateRelationAudit(relations));
  }

  return issues;
}

function validateSingleClaim(claim: CanonClaim, byId: Map<string, CanonClaim>): CanonIssue[] {
  const out: CanonIssue[] = [];

  if (NON_GENERALIZABLE_TYPES.has(claim.claimType)) {
    const explained =
      claim.constraints.nonGeneralizable === true ||
      /可泛化|通用|其他角色也可用|推广到/.test(claim.content) ||
      claim.constraints.forbiddenUses.length > 0;
    if (!explained) {
      out.push({
        code: "exception_not_non_generalizable",
        severity: "error",
        claimId: claim.id,
        message: `Claim "${claim.id}" is a ${claim.claimType} and must set constraints.nonGeneralizable=true (or explicitly describe the generalization condition).`,
      });
    }
  }

  if (claim.claimType === "secret_truth") {
    const hasBoundary =
      claim.visibility.readerKnownFrom !== undefined ||
      claim.visibility.characterKnownBy.length > 0 ||
      claim.visibility.hiddenFrom.length > 0;
    if (!hasBoundary) {
      out.push({
        code: "secret_truth_missing_visibility",
        severity: "error",
        claimId: claim.id,
        message: `Claim "${claim.id}" is a secret_truth and must declare a visibility boundary (readerKnownFrom / characterKnownBy / hiddenFrom).`,
      });
    }
  }

  if (claim.relations?.conflictsWith) {
    for (const other of claim.relations.conflictsWith) {
      if (!byId.has(other)) {
        out.push({
          code: "conflict_target_missing",
          severity: "warning",
          claimId: claim.id,
          message: `Claim "${claim.id}" conflicts with "${other}" but no such claim exists.`,
        });
      }
    }
  }

  return out;
}

function validateConflicts(
  claims: ReadonlyArray<CanonClaim>,
  byId: Map<string, CanonClaim>,
): CanonIssue[] {
  const out: CanonIssue[] = [];
  for (const claim of claims) {
    if (!claim.relations?.conflictsWith?.length) continue;
    for (const otherId of claim.relations.conflictsWith) {
      const other = byId.get(otherId);
      if (!other) continue;
      const bidirectional = other.relations?.conflictsWith?.includes(claim.id);
      if (!bidirectional && !claim.relations?.resolvesBy && !other.relations?.resolvesBy) {
        out.push({
          code: "conflict_without_resolution",
          severity: "warning",
          claimId: claim.id,
          message: `Conflict between "${claim.id}" and "${otherId}" has no resolvesBy edge.`,
        });
      }
    }
  }
  return out;
}

function validatePriorityDominance(claims: ReadonlyArray<CanonClaim>): CanonIssue[] {
  const out: CanonIssue[] = [];
  const hardClaims = new Set(
    claims.filter((c) => c.authority.priority === "hard").map((c) => c.id),
  );
  if (hardClaims.size === 0) return out;

  for (const claim of claims) {
    if (claim.authority.priority === "hard") continue;
    const violates = claim.constraints.forbiddenUses.some((use) => hardClaims.has(use));
    const signalsOverride = /覆盖|推翻|无视|突破.*(规则|禁令)/.test(claim.content);
    if (violates || signalsOverride) {
      out.push({
        code: "priority_override_of_hard_claim",
        severity: "warning",
        claimId: claim.id,
        message: `Claim "${claim.id}" (priority=${claim.authority.priority}) attempts to override a hard-priority claim; this requires an explicit resolution edge.`,
      });
    }
  }
  return out;
}

function validateRelationAudit(relations: SystemRelation): CanonIssue[] {
  const out: CanonIssue[] = [];
  if (relations.auditRules.length === 0) {
    out.push({
      code: "relation_missing_audit_rules",
      severity: "warning",
      message: "system_relations declares no audit_rules for the writer to check against.",
    });
  }
  return out;
}
