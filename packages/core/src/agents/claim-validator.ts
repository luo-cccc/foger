import { BaseAgent } from "./base.js";
import type { CanonClaim, SystemRelation } from "../models/canon.js";
import {
  validateCanonClaims as validateCanonClaimsDeterministic,
  type CanonIssue,
} from "./canon-validator.js";
import {
  runPostWriteClaimGate,
  runPreWriteClaimGate,
  type ClaimGateIssue,
  type ClaimGateTextInput,
} from "../utils/claim-gate.js";

export interface CanonValidationInput {
  readonly claims: ReadonlyArray<CanonClaim>;
  readonly relations?: SystemRelation | null;
}

export class ClaimValidatorAgent extends BaseAgent {
  get name(): string {
    return "claim-validator";
  }

  validateCanonClaims(input: CanonValidationInput): ReadonlyArray<CanonIssue> {
    const issues = validateCanonClaimsDeterministic(input.claims, input.relations);
    this.log?.debug("deterministic canon validation completed", {
      claimCount: input.claims.length,
      relationMode: input.relations?.mode ?? null,
      issueCount: issues.length,
      model: this.ctx.model,
    });
    return issues;
  }

  runPreWriteClaimGate(input: ClaimGateTextInput): ReadonlyArray<ClaimGateIssue> {
    const issues = runPreWriteClaimGate(input);
    this.log?.debug("deterministic pre-write claim gate completed", {
      phase: input.phase,
      issueCount: issues.length,
      model: this.ctx.model,
    });
    return issues;
  }

  runPostWriteClaimGate(input: ClaimGateTextInput): ReadonlyArray<ClaimGateIssue> {
    const issues = runPostWriteClaimGate(input);
    this.log?.debug("deterministic post-write claim gate completed", {
      phase: input.phase,
      issueCount: issues.length,
      model: this.ctx.model,
    });
    return issues;
  }
}
