import { describe, expect, it } from "vitest";
import type { StoredHook } from "../state/memory-db.js";
import {
  defaultHalfLifeEpisodes,
  resolveHalfLifeEpisodes,
  shouldPromoteHook,
  type PromotionContext,
  type VolumeBoundary,
} from "../utils/hook-promotion.js";

function makeHook(overrides: Partial<StoredHook>): StoredHook {
  return {
    hookId: "H01",
    startEpisode: 1,
    type: "主线",
    status: "open",
    lastAdvancedEpisode: 0,
    expectedPayoff: "回收",
    notes: "",
    ...overrides,
  };
}

function makeContext(overrides: Partial<PromotionContext>): PromotionContext {
  return {
    volumeBoundaries: [],
    currentEpisode: 10,
    advancedCounts: new Map(),
    allSeedStartEpisodes: new Map(),
    ...overrides,
  };
}

const VOL_MAP: ReadonlyArray<VolumeBoundary> = [
  { name: "第一卷", startCh: 1, endCh: 20 },
  { name: "第二卷", startCh: 21, endCh: 40 },
  { name: "第三卷", startCh: 41, endCh: 60 },
];

describe("shouldPromoteHook — Phase 7 four-rule promotion", () => {
  it("promotes a core_hook even when nothing else fires", () => {
    const hook = makeHook({ coreHook: true, startEpisode: 5 });
    const decision = shouldPromoteHook(hook, makeContext({ volumeBoundaries: VOL_MAP }));
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("core_hook");
  });

  it("promotes a hook with any depends_on entries", () => {
    const hook = makeHook({ dependsOn: ["H02"], startEpisode: 5 });
    const decision = shouldPromoteHook(hook, makeContext({ volumeBoundaries: VOL_MAP }));
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("depends_on");
  });

  it("promotes a hook that has been advanced in two or more episodes", () => {
    const hook = makeHook({ hookId: "H07", startEpisode: 3, advancedCount: 2 });
    const decision = shouldPromoteHook(hook, makeContext({ volumeBoundaries: VOL_MAP }));
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("advanced_count");
  });

  it("reads advancedCount from context when hook itself has none", () => {
    const hook = makeHook({ hookId: "H07", startEpisode: 3 });
    const decision = shouldPromoteHook(
      hook,
      makeContext({
        volumeBoundaries: VOL_MAP,
        advancedCounts: new Map([["H07", 3]]),
      }),
    );
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("advanced_count");
  });

  it("promotes when depends_on upstream lives in a later volume (cross_volume)", () => {
    // Planted in vol 1 (ch 5), depends on H_future which is planted in vol 2 (ch 25).
    const hook = makeHook({
      startEpisode: 5,
      dependsOn: ["H_FUTURE"],
    });
    const decision = shouldPromoteHook(
      hook,
      makeContext({
        volumeBoundaries: VOL_MAP,
        allSeedStartEpisodes: new Map([["H_FUTURE", 25]]),
      }),
    );
    expect(decision.promote).toBe(true);
    // Both depends_on and cross_volume should fire.
    expect(decision.reasons).toContain("depends_on");
    expect(decision.reasons).toContain("cross_volume");
  });

  it("promotes a slow-burn hook planted in volume 1 as cross_volume", () => {
    const hook = makeHook({
      startEpisode: 3,
      payoffTiming: "slow-burn",
    });
    const decision = shouldPromoteHook(
      hook,
      makeContext({ volumeBoundaries: VOL_MAP }),
    );
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("cross_volume");
  });

  it("promotes when pays_off_in_arc mentions a different volume in Chinese", () => {
    const hook = makeHook({
      startEpisode: 5,
      paysOffInArc: "第二卷中段揭晓",
    });
    const decision = shouldPromoteHook(
      hook,
      makeContext({ volumeBoundaries: VOL_MAP }),
    );
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("cross_volume");
  });

  it("promotes when pays_off_in_arc mentions a different volume in English", () => {
    const hook = makeHook({
      startEpisode: 5,
      paysOffInArc: "mid of volume 3",
    });
    const decision = shouldPromoteHook(
      hook,
      makeContext({ volumeBoundaries: VOL_MAP }),
    );
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toContain("cross_volume");
  });

  it("does NOT promote a plain local seed with no rules firing", () => {
    const hook = makeHook({
      hookId: "H99",
      startEpisode: 5,
      payoffTiming: "near-term",
      coreHook: false,
      dependsOn: [],
    });
    const decision = shouldPromoteHook(
      hook,
      makeContext({ volumeBoundaries: VOL_MAP }),
    );
    expect(decision.promote).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("does NOT promote when advancedCount is 1 (below threshold)", () => {
    const hook = makeHook({ hookId: "H1", startEpisode: 5, advancedCount: 1 });
    const decision = shouldPromoteHook(
      hook,
      makeContext({ volumeBoundaries: VOL_MAP }),
    );
    expect(decision.promote).toBe(false);
  });

  it("combines multiple reasons when several conditions hold", () => {
    const hook = makeHook({
      startEpisode: 3,
      coreHook: true,
      dependsOn: ["H03"],
      advancedCount: 4,
      payoffTiming: "endgame",
    });
    const decision = shouldPromoteHook(
      hook,
      makeContext({ volumeBoundaries: VOL_MAP }),
    );
    expect(decision.promote).toBe(true);
    expect(new Set(decision.reasons)).toEqual(
      new Set(["core_hook", "depends_on", "advanced_count", "cross_volume"]),
    );
  });

  it("defaultHalfLifeEpisodes maps timing to the prompt defaults", () => {
    expect(defaultHalfLifeEpisodes("immediate")).toBe(10);
    expect(defaultHalfLifeEpisodes("near-term")).toBe(10);
    expect(defaultHalfLifeEpisodes("mid-arc")).toBe(30);
    expect(defaultHalfLifeEpisodes("slow-burn")).toBe(80);
    expect(defaultHalfLifeEpisodes("endgame")).toBe(80);
    expect(defaultHalfLifeEpisodes(undefined)).toBe(30);
  });

  it("resolveHalfLifeEpisodes prefers explicit halfLifeEpisodes over derived default", () => {
    const explicit = makeHook({ payoffTiming: "mid-arc", halfLifeEpisodes: 50 });
    expect(resolveHalfLifeEpisodes(explicit)).toBe(50);

    const derived = makeHook({ payoffTiming: "mid-arc" });
    expect(resolveHalfLifeEpisodes(derived)).toBe(30);
  });
});
