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
    chapterSummary: overrides.chapterSummary,
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

  it("maps English information candidates onto existing Chinese information hooks", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "H004",
          type: "信息",
          expectedPayoff: "解密完整的零号协议内容和回声体替代名单",
          notes: "已获得12个加密身份标识，仍需解密具体身份和替代时间。",
        }),
      ],
      delta: createDelta({
        chapter: 3,
        newHookCandidates: [
          {
            type: "information",
            expectedPayoff: "解密完整的零号协议内容和回声体替代名单",
            notes: "名单已解开部分身份字段和替代时间，剩余编号仍需解密。",
          },
        ],
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({ hookId: "H004", lastAdvancedChapter: 3 }),
    ]);
    expect(result.decisions).toContainEqual(expect.objectContaining({
      action: "mapped",
      hookId: "H004",
    }));
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
      hookId: "D001",
      startChapter: 15,
      lastAdvancedChapter: 15,
      type: "artifact",
      status: "open",
    }));
    expect(result.resolvedDelta.hookOps.upsert[0]?.hookId).not.toBe("mentor-debt");
    expect(result.resolvedDelta.newHookCandidates).toEqual([]);
  });

  it("allocates monotonic D ids without reusing legacy or model-provided ids", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({ hookId: "H001" }),
        createHook({ hookId: "legacy-long-hook-id" }),
        createHook({ hookId: "D001" }),
        createHook({ hookId: "D009" }),
      ],
      delta: createDelta({
        chapter: 22,
        newHookCandidates: [
          {
            type: "物件",
            expectedPayoff: "揭示这枚密钥为何只在潮汐最低点回应。",
            notes: "这是一个很长的中文描述，但它不应再参与 hook ID 生成。",
          },
          {
            type: "威胁",
            expectedPayoff: "揭示追踪信标会在何时锁定主角的位置。",
            notes: "新的风险家族，与密钥物件线无关。",
          },
        ],
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({ hookId: "D010", type: "artifact" }),
      expect.objectContaining({ hookId: "D011", type: "threat" }),
    ]);
  });

  it("ignores a fabricated long id on a new upsert and assigns a derived id", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [createHook({ hookId: "H001", type: "relationship" })],
      delta: createDelta({
        chapter: 4,
        hookOps: {
          upsert: [createHook({
            hookId: "the-seal-that-only-answers-at-midnight-and-should-never-be-an-id",
            type: "artifact",
            startChapter: 4,
            lastAdvancedChapter: 4,
            expectedPayoff: "Reveal why the seal answers only at midnight.",
          })],
          mention: [],
          resolve: [],
          defer: [],
        },
        chapterSummary: {
          chapter: 4,
          title: "Midnight Seal",
          characters: "Lin Yue",
          events: "The seal responds at midnight.",
          stateChanges: "A new artifact rule appears.",
          hookActivity: "the-seal-that-only-answers-at-midnight-and-should-never-be-an-id opened",
          mood: "tense",
          chapterType: "investigation",
        },
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({ hookId: "D001", type: "artifact" }),
    ]);
    expect(result.resolvedDelta.chapterSummary?.hookActivity).toBe("D001 opened");
  });

  it("maps a separator-drifted legacy id back to the unique existing hook", () => {
    const result = arbitrateRuntimeStateDeltaHooks({
      hooks: [
        createHook({
          hookId: "anonymous-source-scope",
          type: "source-risk",
          expectedPayoff: "Reveal what the anonymous source knew.",
        }),
      ],
      delta: createDelta({
        chapter: 6,
        hookOps: {
          upsert: [createHook({
            hookId: "anonymoussourcescope",
            type: "source-risk",
            startChapter: 3,
            lastAdvancedChapter: 6,
            expectedPayoff: "Reveal what the anonymous source knew about the route.",
          })],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
    });

    expect(result.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({ hookId: "anonymous-source-scope", lastAdvancedChapter: 6 }),
    ]);
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
    expect(result.resolvedDelta.hookOps.upsert[0]?.hookId).toBe("D001");
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
