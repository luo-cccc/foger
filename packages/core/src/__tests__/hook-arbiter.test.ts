import { describe, expect, it } from "vitest";
import type { HookRecord, RuntimeStateDelta } from "../models/runtime-state.js";
import { arbitrateRuntimeStateDeltaHooks } from "../utils/hook-arbiter.js";

function createHook(overrides: Partial<HookRecord> = {}): HookRecord {
  return {
    hookId: overrides.hookId ?? "H001",
    startChapter: overrides.startChapter ?? 1,
    type: overrides.type ?? "mystery",
    status: overrides.status ?? "open",
    lastAdvancedChapter: overrides.lastAdvancedChapter ?? 1,
    expectedPayoff: overrides.expectedPayoff ?? "Reveal the hidden ledger",
    notes: overrides.notes ?? "Still unresolved",
  };
}

function createDelta(overrides: Partial<RuntimeStateDelta> = {}): RuntimeStateDelta {
  return {
    chapter: overrides.chapter ?? 12,
    hookOps: {
      upsert: overrides.hookOps?.upsert ?? [],
      mention: overrides.hookOps?.mention ?? [],
      resolve: overrides.hookOps?.resolve ?? [],
      defer: overrides.hookOps?.defer ?? [],
    },
    newHookCandidates: overrides.newHookCandidates ?? [],
    subplotOps: [],
    emotionalArcOps: [],
    characterMatrixOps: [],
    notes: [],
  };
}

describe("arbitrateRuntimeStateDeltaHooks", () => {
  it("maps a duplicate-family candidate back onto the matched existing hook", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "anonymous-source-scope",
          type: "source-risk",
          startChapter: 3,
          lastAdvancedChapter: 8,
          expectedPayoff: "Reveal how much the anonymous source already knew about the route.",
          notes: "The source knowledge question remains unresolved.",
        }),
      ],
      delta: createDelta({
        newHookCandidates: [
          {
            type: "source-risk",
            expectedPayoff: "Reveal how much the anonymous source already knew about the route and address.",
            notes: "This chapter adds the address angle to the anonymous source question.",
          },
        ],
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({
        hookId: "anonymous-source-scope",
        lastAdvancedChapter: 12,
      }),
    ]);
    expect(result.resolvedDelta.newHookCandidates).toEqual([]);
  });

  it("downgrades a pure restatement candidate into a mention instead of opening a new hook", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "mentor-debt",
          type: "relationship",
          expectedPayoff: "Reveal the real mentor debt.",
          notes: "The mentor debt is still unresolved.",
        }),
      ],
      delta: createDelta({
        newHookCandidates: [
          {
            type: "relationship",
            expectedPayoff: "Reveal the real mentor debt.",
            notes: "The mentor debt is still unresolved.",
          },
        ],
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([]);
    expect(result.resolvedDelta.hookOps.mention).toContain("mentor-debt");
    expect(result.resolvedDelta.newHookCandidates).toEqual([]);
  });

  it("creates a canonical hook when the candidate is genuinely new", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "mentor-debt",
          type: "relationship",
          expectedPayoff: "Reveal the real mentor debt.",
        }),
      ],
      delta: createDelta({
        chapter: 15,
        newHookCandidates: [
          {
            type: "artifact",
            expectedPayoff: "Reveal why the seal answers only at midnight.",
            notes: "A fresh unresolved rule around the seal appears in this chapter.",
          },
        ],
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toHaveLength(1);
    expect(result.resolvedDelta.hookOps.upsert[0]).toEqual(expect.objectContaining({
      startChapter: 15,
      lastAdvancedChapter: 15,
      type: "artifact",
      status: "open",
    }));
    expect(result.resolvedDelta.hookOps.upsert[0]?.hookId).not.toBe("mentor-debt");
    expect(result.resolvedDelta.newHookCandidates).toEqual([]);
  });

  it("does not overwrite an existing hook when a planner reuses its id for another family", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "H008",
          type: "relationship",
          expectedPayoff: "Reveal why Lu Yuan reopened Shen Yao's archived case.",
          notes: "The archive contains a blacked-out paragraph.",
        }),
      ],
      delta: createDelta({
        chapter: 2,
        hookOps: {
          upsert: [createHook({
            hookId: "H008",
            type: "institution",
            startChapter: 2,
            lastAdvancedChapter: 2,
            expectedPayoff: "Reveal how the citywide pursuit tracker works.",
            notes: "A new pursuit order activates this chapter.",
          })],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toHaveLength(1);
    expect(result.resolvedDelta.hookOps.upsert[0]?.hookId).not.toBe("H008");
    expect(result.decisions).toContainEqual(expect.objectContaining({
      action: "rejected",
      reason: "existing_id_identity_conflict",
      hookId: "H008",
    }));
  });

  it("allows an existing hook to advance with richer payoff text when its family is unchanged", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "mentor-debt",
          type: "relationship",
          lastAdvancedChapter: 2,
          expectedPayoff: "Reveal why the mentor vanished.",
          notes: "The debt remains unresolved.",
        }),
      ],
      delta: createDelta({
        chapter: 3,
        hookOps: {
          upsert: [createHook({
            hookId: "mentor-debt",
            type: "relationship",
            status: "progressing",
            lastAdvancedChapter: 3,
            expectedPayoff: "Reveal how the river ledger explains the mentor's debt.",
            notes: "The ledger clue sharpens the same relationship line.",
          })],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({
        hookId: "mentor-debt",
        status: "progressing",
        lastAdvancedChapter: 3,
      }),
    ]);
    expect(result.decisions).not.toContainEqual(expect.objectContaining({
      reason: "existing_id_identity_conflict",
    }));
  });
});
