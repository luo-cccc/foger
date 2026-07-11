import { describe, expect, it } from "vitest";
import { validateCanonClaims } from "../agents/canon-validator.js";
import type { CanonClaim } from "../models/canon.js";

function claim(overrides: Partial<CanonClaim> & Pick<CanonClaim, "id">): CanonClaim {
  return {
    domain: "world",
    claimType: "objective_rule",
    content: "一个客观规则。",
    scope: { appliesTo: ["all"] },
    authority: { source: "story_frame", priority: "hard" },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
    ...overrides,
  };
}

describe("validateCanonClaims", () => {
  it("passes a clean objective_rule claim", () => {
    const issues = validateCanonClaims([claim({ id: "w-1" })]);
    expect(issues).toEqual([]);
  });

  it("flags a character_exception without nonGeneralizable", () => {
    const issues = validateCanonClaims([
      claim({
        id: "p-1",
        domain: "protagonist",
        claimType: "character_exception",
        content: "主角能听到器物低语。",
      }),
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "exception_not_non_generalizable", claimId: "p-1" }),
      ]),
    );
  });

  it("passes a character_exception that declares a generalization condition", () => {
    const issues = validateCanonClaims([
      claim({
        id: "p-1",
        domain: "protagonist",
        claimType: "character_exception",
        content: "主角能听到器物低语，但此能力可泛化到同脉弟子。",
        constraints: { nonGeneralizable: false, requiresCost: [], forbiddenUses: [] },
      }),
    ]);
    expect(issues).not.toContainEqual(
      expect.objectContaining({ code: "exception_not_non_generalizable" }),
    );
  });

  it("flags a secret_truth with no visibility boundary", () => {
    const issues = validateCanonClaims([
      claim({
        id: "s-1",
        claimType: "secret_truth",
        content: "宗门高层早已知道真相。",
      }),
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "secret_truth_missing_visibility", claimId: "s-1" }),
      ]),
    );
  });

  it("passes a secret_truth with a reader boundary", () => {
    const issues = validateCanonClaims([
      claim({
        id: "s-1",
        claimType: "secret_truth",
        content: "宗门高层早已知道真相。",
        visibility: { readerKnownFrom: 30, characterKnownBy: ["宗主"], hiddenFrom: ["主角"] },
      }),
    ]);
    expect(issues).toEqual([]);
  });

  it("flags a conflict without a resolvesBy edge", () => {
    const issues = validateCanonClaims([
      claim({ id: "w-1", relations: { conflictsWith: ["w-2"] } }),
      claim({ id: "w-2" }),
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "conflict_without_resolution" })]),
    );
  });

  it("accepts a conflict with a resolvesBy edge", () => {
    const issues = validateCanonClaims([
      claim({ id: "w-1", relations: { conflictsWith: ["w-2"], resolvesBy: "w-2 优先于 w-1" } }),
      claim({ id: "w-2" }),
    ]);
    expect(issues).not.toContainEqual(
      expect.objectContaining({ code: "conflict_without_resolution" }),
    );
  });

  it("flags duplicate claim ids", () => {
    const issues = validateCanonClaims([claim({ id: "dup" }), claim({ id: "dup" })]);
    expect(issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "duplicate_claim_id", claimId: "dup" })]),
    );
  });

  it("warns when a soft claim attempts to override a hard claim", () => {
    const issues = validateCanonClaims([
      claim({ id: "w-1", authority: { source: "story_frame", priority: "hard" } }),
      claim({
        id: "w-2",
        authority: { source: "roles", priority: "soft" },
        content: "主角可以覆盖宗门禁令。",
      }),
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "priority_override_of_hard_claim", claimId: "w-2" }),
      ]),
    );
  });
});
