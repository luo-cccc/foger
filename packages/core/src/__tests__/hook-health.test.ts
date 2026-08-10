import { describe, expect, it } from "vitest";
import type { HookRecord, EpisodeRuntimeStateDelta } from "../models/runtime-state.js";
import { analyzeHookHealth } from "../utils/hook-health.js";

function createHook(overrides: Partial<HookRecord> = {}): HookRecord {
  return {
    hookId: overrides.hookId ?? "H001",
    startEpisode: overrides.startEpisode ?? 1,
    type: overrides.type ?? "mystery",
    status: overrides.status ?? "open",
    lastAdvancedEpisode: overrides.lastAdvancedEpisode ?? 1,
    expectedPayoff: overrides.expectedPayoff ?? "Reveal the hidden ledger",
    payoffTiming: overrides.payoffTiming,
    notes: overrides.notes ?? "Still unresolved",
  };
}

function createDelta(overrides: Partial<EpisodeRuntimeStateDelta> = {}): EpisodeRuntimeStateDelta {
  return {
    episode: overrides.episode ?? 20,
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

describe("analyzeHookHealth", () => {
  it("warns when active hook count exceeds the recommended cap", () => {
    const issues = analyzeHookHealth({
      language: "en",
      episodeNumber: 20,
      hooks: [
        createHook({ hookId: "H001" }),
        createHook({ hookId: "H002" }),
        createHook({ hookId: "H003" }),
        createHook({ hookId: "H004" }),
        createHook({ hookId: "H005" }),
      ],
      maxActiveHooks: 4,
    });

    expect(issues.some((issue) => issue.category === "Hook Debt" && issue.description.includes("5 active hooks"))).toBe(true);
  });

  it("does not count dormant seed aliases as active hook debt", () => {
    const issues = analyzeHookHealth({
      language: "zh",
      episodeNumber: 1,
      hooks: [
        createHook({ hookId: "H001", status: "未开启" as any, lastAdvancedEpisode: 0 }),
        createHook({ hookId: "H002", status: "待推进" as any, lastAdvancedEpisode: 0 }),
        createHook({ hookId: "H003", status: "dormant" as any, lastAdvancedEpisode: 0 }),
      ],
      maxActiveHooks: 1,
    });

    expect(issues.some((issue) => issue.description.includes("活跃伏笔"))).toBe(false);
  });

  it("warns when a short-payoff hook is already under payoff pressure without real movement", () => {
    const issues = analyzeHookHealth({
      language: "en",
      episodeNumber: 4,
      hooks: [
        createHook({
          hookId: "H001",
          startEpisode: 1,
          lastAdvancedEpisode: 1,
          payoffTiming: "immediate",
          expectedPayoff: "Reveal the hidden ledger immediately after the theft.",
        }),
      ],
    });

    expect(issues.some((issue) => issue.description.includes("payoff pressure"))).toBe(true);
  });

  it("does not warn when only endgame hooks are dormant before the story reaches late phase", () => {
    const issues = analyzeHookHealth({
      language: "en",
      episodeNumber: 20,
      targetEpisodes: 40,
      hooks: [
        createHook({
          hookId: "H001",
          startEpisode: 10,
          lastAdvancedEpisode: 15,
          payoffTiming: "endgame",
          expectedPayoff: "Final reveal in the endgame.",
        }),
      ],
    });

    expect(issues).toHaveLength(0);
  });

  it("warns when stale hooks receive no disposition in the current episode", () => {
    const issues = analyzeHookHealth({
      language: "en",
      episodeNumber: 20,
      hooks: [
        createHook({ hookId: "H001", lastAdvancedEpisode: 5 }),
        createHook({ hookId: "H002", lastAdvancedEpisode: 6 }),
      ],
      delta: createDelta({
        episode: 20,
        hookOps: {
          upsert: [],
          mention: ["H001"],
          resolve: [],
          defer: [],
        },
      }),
      staleAfterEpisodes: 10,
    });

    expect(issues.some((issue) => issue.description.includes("H001") || issue.description.includes("H002"))).toBe(true);
  });

  it("warns when multiple new hooks open without resolving older debt", () => {
    const issues = analyzeHookHealth({
      language: "en",
      episodeNumber: 20,
      hooks: [
        createHook({ hookId: "old-debt", lastAdvancedEpisode: 8 }),
        createHook({ hookId: "new-a", startEpisode: 20, lastAdvancedEpisode: 20 }),
        createHook({ hookId: "new-b", startEpisode: 20, lastAdvancedEpisode: 20 }),
      ],
      delta: createDelta({
        episode: 20,
        hookOps: {
          upsert: [
            createHook({ hookId: "new-a", startEpisode: 20, lastAdvancedEpisode: 20 }),
            createHook({ hookId: "new-b", startEpisode: 20, lastAdvancedEpisode: 20 }),
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
      existingHookIds: ["old-debt"],
      newHookBurstThreshold: 2,
    });

    expect(issues.some((issue) => issue.description.includes("Opened 2 new hooks"))).toBe(true);
  });

  it("does not invent old hook debt for an opening episode", () => {
    const issues = analyzeHookHealth({
      language: "zh",
      episodeNumber: 1,
      hooks: [
        createHook({ hookId: "seed", startEpisode: 0, status: "deferred", lastAdvancedEpisode: 0 }),
        createHook({ hookId: "new-a", startEpisode: 1, lastAdvancedEpisode: 1 }),
        createHook({ hookId: "new-b", startEpisode: 1, lastAdvancedEpisode: 1 }),
      ],
      delta: createDelta({
        episode: 1,
        hookOps: {
          upsert: [
            createHook({ hookId: "new-a", startEpisode: 1, lastAdvancedEpisode: 1 }),
            createHook({ hookId: "new-b", startEpisode: 1, lastAdvancedEpisode: 1 }),
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
      existingHookIds: ["seed"],
      newHookBurstThreshold: 2,
    });

    expect(issues.some((issue) => issue.description.includes("没有回收任何旧债"))).toBe(false);
  });

  it("does not count absorbed duplicate-family upserts as genuinely new hooks", () => {
    const issues = analyzeHookHealth({
      language: "en",
      episodeNumber: 20,
      hooks: [
        createHook({ hookId: "old-debt", lastAdvancedEpisode: 20 }),
      ],
      delta: createDelta({
        episode: 20,
        hookOps: {
          upsert: [
            createHook({ hookId: "duplicate-restated", lastAdvancedEpisode: 20 }),
            createHook({ hookId: "second-duplicate", lastAdvancedEpisode: 20 }),
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
      }),
      existingHookIds: ["old-debt"],
      newHookBurstThreshold: 2,
    });

    expect(issues.some((issue) => issue.description.includes("Opened 2 new hooks"))).toBe(false);
  });
});
