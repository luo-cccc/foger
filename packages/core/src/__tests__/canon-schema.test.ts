import { describe, expect, it } from "vitest";
import {
  CanonClaimSchema,
  ClaimsFileSchema,
  WorldSystemSchema,
  type CanonClaim,
} from "../models/canon.js";

function baseClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c-1",
    domain: "world",
    claimType: "objective_rule",
    content: "灵气枯竭后，凡人无法自行恢复修为。",
    scope: { appliesTo: ["all"] },
    authority: { source: "story_frame", priority: "hard" },
    ...overrides,
  };
}

describe("CanonClaimSchema", () => {
  it("accepts a complete objective_rule claim", () => {
    const parsed = CanonClaimSchema.parse(baseClaim());
    expect(parsed.scope!.appliesTo).toEqual(["all"]);
    expect(parsed.authority.priority).toBe("hard");
  });

  it("rejects a claim with no id", () => {
    const bad = baseClaim({ id: "" });
    expect(() => CanonClaimSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown domain", () => {
    const bad = baseClaim({ domain: "finance" });
    expect(() => CanonClaimSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown claimType", () => {
    const bad = baseClaim({ claimType: "magic_trick" });
    expect(() => CanonClaimSchema.parse(bad)).toThrow();
  });

  it("applies the soft priority default", () => {
    const parsed = CanonClaimSchema.parse({
      id: "c-2",
      domain: "character",
      claimType: "belief",
      content: "林辞相信师父终会归来。",
      authority: { source: "roles" },
    });
    expect(parsed.authority.priority).toBe("soft");
  });

  it("validates readerKnownFrom as a non-negative integer", () => {
    const bad = baseClaim({ visibility: { readerKnownFrom: -1, characterKnownBy: [], hiddenFrom: [] } });
    expect(() => CanonClaimSchema.parse(bad)).toThrow();
    const good = CanonClaimSchema.parse(
      baseClaim({ visibility: { readerKnownFrom: 12, characterKnownBy: [], hiddenFrom: [] } }),
    ) as CanonClaim;
    expect(good.visibility!.readerKnownFrom).toBe(12);
  });
});

describe("ClaimsFileSchema", () => {
  it("wraps an array of claims", () => {
    const parsed = ClaimsFileSchema.parse({ claims: [baseClaim()] });
    expect(parsed.claims).toHaveLength(1);
  });

  it("rejects a malformed claim inside the file", () => {
    const bad = {
      claims: [{ id: "", domain: "world", claimType: "objective_rule", content: "x", authority: {} }],
    };
    expect(() => ClaimsFileSchema.parse(bad)).toThrow();
  });
});

describe("WorldSystemSchema", () => {
  it("defaults to empty arrays", () => {
    const parsed = WorldSystemSchema.parse({});
    expect(parsed.objectiveRules).toEqual([]);
    expect(parsed.taboos).toEqual([]);
  });

  it("accepts populated systems", () => {
    const parsed = WorldSystemSchema.parse({
      objectiveRules: ["灵气总量恒定"],
      hardCaps: ["单一修士不得突破金丹上限"],
      costs: ["施法消耗寿元"],
      taboos: ["不得窥探天道"],
    });
    expect(parsed.taboos).toHaveLength(1);
  });
});
