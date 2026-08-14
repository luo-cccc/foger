import { describe, expect, it } from "vitest";
import { applyEpisodeRuntimeStateDelta } from "../state/episode-state-reducer.js";
import { EpisodeRuntimeStateDeltaSchema } from "../models/runtime-state.js";

describe("applyEpisodeRuntimeStateDelta", () => {
  it("supports the Episode-native reducer contract", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: { schemaVersion: 2, language: "zh", lastAppliedEpisode: 0, projectionVersion: 1, migrationWarnings: [] },
        currentState: { episode: 0, facts: [] },
        hooks: { hooks: [] },
        episodeSummaries: { rows: [] },
      },
      delta: {
        episode: 1,
        currentStatePatch: { currentLocation: "屋顶" },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        newHookCandidates: [], episodeSummary: undefined,
        subplotOps: [], emotionalArcOps: [], characterMatrixOps: [], notes: [],
      },
    });
    expect(result.manifest.lastAppliedEpisode).toBe(1);
    expect(result.currentState.facts[0]?.validFromEpisode).toBe(1);
  });
  it("ignores empty optional state-patch values instead of creating invalid facts", () => {
    const delta = EpisodeRuntimeStateDeltaSchema.parse({
      episode: 1,
      currentStatePatch: {
        currentLocation: "  OCC检修间  ",
        currentGoal: "",
        currentConflict: "   ",
      },
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      notes: [],
    });

    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "zh",
          lastAppliedEpisode: 0,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: { episode: 0, facts: [] },
        hooks: { hooks: [] },
        episodeSummaries: { rows: [] },
      },
      delta,
    });

    expect(delta.currentStatePatch?.currentGoal).toBeUndefined();
    expect(delta.currentStatePatch?.currentConflict).toBeUndefined();
    expect(result.currentState.facts).toEqual([
      expect.objectContaining({
        predicate: "当前位置",
        object: "OCC检修间",
      }),
    ]);
  });

  it("applies a episode-local delta into structured state", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 11,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 11,
          facts: [],
        },
        hooks: {
          hooks: [
            {
              hookId: "mentor-debt",
              startEpisode: 1,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: 11,
              expectedPayoff: "Reveal the debt.",
              notes: "Still unresolved.",
            },
          ],
        },
        episodeSummaries: {
          rows: [
            {
              episodeNumber: 11,
              title: "Old Ledger",
              characters: "Lin Yue",
              events: "Lin Yue finds the old ledger.",
              stateChanges: "The debt trail tightens.",
              hookActivity: "mentor-debt advanced",
              mood: "tense",
              episodeType: "mainline",
            },
          ],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 12,
        currentStatePatch: {
          currentGoal: "Trace the debt through the river-port ledger.",
        },
        hookOps: {
          upsert: [
            {
              hookId: "mentor-debt",
              startEpisode: 1,
              type: "relationship",
              status: "progressing",
              lastAdvancedEpisode: 12,
              expectedPayoff: "Reveal the debt.",
              notes: "The river-port ledger sharpens the clue.",
            },
          ],
          resolve: [],
          defer: [],
        },
        episodeSummary: {
          episodeNumber: 12,
          title: "River-Port Ledger",
          characters: "Lin Yue",
          events: "Lin Yue cross-checks the river-port ledger.",
          stateChanges: "The debt trail narrows.",
          hookActivity: "mentor-debt advanced",
          mood: "tight",
          episodeType: "investigation",
        },
        notes: [],
      }),
    });

    expect(result.manifest.lastAppliedEpisode).toBe(12);
    expect(result.currentState.episode).toBe(12);
    expect(result.currentState.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "Current Goal",
          object: "Trace the debt through the river-port ledger.",
          sourceEpisode: 12,
        }),
      ]),
    );
    expect(result.hooks.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookId: "mentor-debt",
          status: "progressing",
          lastAdvancedEpisode: 12,
        }),
      ]),
    );
    expect(result.episodeSummaries.rows.map((row) => row.episodeNumber)).toEqual([11, 12]);
  });

  it("rejects duplicate summary rows for the same episode", () => {
    expect(() =>
      applyEpisodeRuntimeStateDelta({
        snapshot: {
          manifest: {
            schemaVersion: 2,
            language: "zh",
            lastAppliedEpisode: 11,
            projectionVersion: 1,
            migrationWarnings: [],
          },
          currentState: {
            episode: 11,
            facts: [],
          },
          hooks: {
            hooks: [],
          },
          episodeSummaries: {
            rows: [
              {
                episodeNumber: 12,
                title: "河埠对账",
                characters: "林己",
                events: "林己核对货单。",
                stateChanges: "师债线索收束。",
                hookActivity: "mentor-debt 推进",
                mood: "紧绷",
                episodeType: "主线推进",
              },
            ],
          },
        },
        delta: EpisodeRuntimeStateDeltaSchema.parse({
          episode: 12,
          hookOps: {
            upsert: [],
            resolve: [],
            defer: [],
          },
          episodeSummary: {
            episodeNumber: 12,
            title: "再写一版河埠对账",
            characters: "林己",
            events: "重复写入。",
            stateChanges: "重复写入。",
            hookActivity: "mentor-debt 推进",
            mood: "紧绷",
            episodeType: "主线推进",
          },
          notes: [],
        }),
      }),
    ).toThrow(/duplicate summary/i);
  });

  it("allows reapplying the same episode when explicitly enabled", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "zh",
          lastAppliedEpisode: 12,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 12,
          facts: [],
        },
        hooks: {
          hooks: [],
        },
        episodeSummaries: {
          rows: [
            {
              episodeNumber: 12,
              title: "旧版河埠对账",
              characters: "林己",
              events: "旧摘要。",
              stateChanges: "旧变化。",
              hookActivity: "旧钩子",
              mood: "紧绷",
              episodeType: "主线推进",
            },
          ],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 12,
        hookOps: {
          upsert: [],
          resolve: [],
          defer: [],
        },
        episodeSummary: {
          episodeNumber: 12,
          title: "新版河埠对账",
          characters: "林己",
          events: "新摘要。",
          stateChanges: "新变化。",
          hookActivity: "新钩子",
          mood: "压抑",
          episodeType: "修订",
        },
        notes: [],
      }),
      allowReapply: true,
    });

    expect(result.manifest.lastAppliedEpisode).toBe(12);
    expect(result.episodeSummaries.rows).toEqual([
      expect.objectContaining({
        episodeNumber: 12,
        title: "新版河埠对账",
        events: "新摘要。",
      }),
    ]);
  });

  it("ignores resolve and defer operations for unknown hooks", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 11,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 11,
          facts: [],
        },
        hooks: {
          hooks: [],
        },
        episodeSummaries: {
          rows: [],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 12,
        hookOps: {
          upsert: [],
          resolve: ["mentor-debt"],
          defer: ["mentor-debt-later"],
        },
        notes: [],
      }),
    });

    expect(result.manifest.lastAppliedEpisode).toBe(12);
    expect(result.hooks.hooks).toEqual([]);
  });

  it("rejects an empty delta before it can advance and blank structured state", () => {
    expect(() =>
      applyEpisodeRuntimeStateDelta({
        snapshot: {
          manifest: {
            schemaVersion: 2,
            language: "zh",
            lastAppliedEpisode: 4,
            projectionVersion: 1,
            migrationWarnings: [],
          },
          currentState: {
            episode: 4,
            facts: [
              {
                subject: "protagonist",
                predicate: "当前目标",
                object: "调查监听系统设备清单。",
                validFromEpisode: 4,
                validUntilEpisode: null,
                sourceEpisode: 4,
              },
            ],
          },
          hooks: {
            hooks: [
              {
                hookId: "morse-controller",
                startEpisode: 4,
                type: "mystery",
                status: "open",
                lastAdvancedEpisode: 4,
                expectedPayoff: "揭示摩斯码暗号操控者。",
                notes: "暗号来自 S-043 通道。",
              },
            ],
          },
          episodeSummaries: {
            rows: [
              {
                episodeNumber: 4,
                title: "雨夜的暗号",
                characters: "林丙",
                events: "林丙发现暗号来自监听系统。",
                stateChanges: "目标转向设备清单。",
                hookActivity: "morse-controller seeded",
                mood: "警觉",
                episodeType: "线索推进",
              },
            ],
          },
        },
        delta: EpisodeRuntimeStateDeltaSchema.parse({
          episode: 5,
          hookOps: {
            upsert: [],
            mention: [],
            resolve: [],
            defer: [],
          },
          notes: ["状态卡未更新", "伏笔池未更新"],
        }),
      }),
    ).toThrow(/empty/i);
  });

  it("keeps mention-only hooks from mutating lastAdvancedEpisode", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 11,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 11,
          facts: [],
        },
        hooks: {
          hooks: [
            {
              hookId: "mentor-debt",
              startEpisode: 1,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: 8,
              expectedPayoff: "Reveal the debt.",
              notes: "Still unresolved.",
            },
          ],
        },
        episodeSummaries: {
          rows: [],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 12,
        hookOps: {
          upsert: [],
          mention: ["mentor-debt"],
          resolve: [],
          defer: [],
        },
        notes: [],
      }),
    });

    expect(result.hooks.hooks).toEqual([
      expect.objectContaining({
        hookId: "mentor-debt",
        lastAdvancedEpisode: 8,
        status: "open",
      }),
    ]);
  });

  it("defers hooks without refreshing their last advancement episode", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "zh",
          lastAppliedEpisode: 3,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: { episode: 3, facts: [] },
        hooks: {
          hooks: [{
            hookId: "H004",
            startEpisode: 1,
            type: "information",
            status: "progressing",
            lastAdvancedEpisode: 3,
            expectedPayoff: "解开替代名单。",
            notes: "第3章取得部分明文。",
          }],
        },
        episodeSummaries: { rows: [] },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 4,
        hookOps: {
          upsert: [{
            hookId: "H004",
            startEpisode: 1,
            type: "information",
            status: "deferred",
            lastAdvancedEpisode: 4,
            expectedPayoff: "解开替代名单。",
            notes: "第3章取得部分明文。",
          }],
          mention: [],
          resolve: [],
          defer: ["H004"],
        },
        notes: [],
      }),
    });

    expect(result.hooks.hooks).toEqual([
      expect.objectContaining({
        hookId: "H004",
        status: "deferred",
        lastAdvancedEpisode: 3,
      }),
    ]);
  });

  it("does not downgrade an existing progressed hook when the next delta restates it as open", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "zh",
          lastAppliedEpisode: 2,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 2,
          facts: [],
        },
        hooks: {
          hooks: [
            {
              hookId: "pressure-record",
              startEpisode: 1,
              type: "evidence",
              status: "progressing",
              lastAdvancedEpisode: 2,
              expectedPayoff: "公开一号泵房压力异常的签字漏洞。",
              notes: "第2章已让主角拿到压力曲线。",
            },
          ],
        },
        episodeSummaries: {
          rows: [],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 3,
        hookOps: {
          upsert: [
            {
              hookId: "pressure-record",
              startEpisode: 1,
              type: "evidence",
              status: "open",
              lastAdvancedEpisode: 2,
              expectedPayoff: "公开一号泵房压力异常的签字漏洞。",
              notes: "第3章再次提到压力曲线，但没有新推进。",
            },
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
        notes: [],
      }),
    });

    expect(result.hooks.hooks).toEqual([
      expect.objectContaining({
        hookId: "pressure-record",
        status: "progressing",
        lastAdvancedEpisode: 2,
      }),
    ]);
  });

  it("does not resurrect a resolved hook when the next delta restates it as open", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "zh",
          lastAppliedEpisode: 8,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 8,
          facts: [],
        },
        hooks: {
          hooks: [
            {
              hookId: "sealed-toolbox",
              startEpisode: 1,
              type: "evidence",
              status: "resolved",
              lastAdvancedEpisode: 8,
              expectedPayoff: "揭开红色封条是谁重新贴上的。",
              notes: "第8章已兑现封条来源。",
            },
          ],
        },
        episodeSummaries: {
          rows: [],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 9,
        hookOps: {
          upsert: [
            {
              hookId: "sealed-toolbox",
              startEpisode: 1,
              type: "evidence",
              status: "open",
              lastAdvancedEpisode: 8,
              expectedPayoff: "揭开红色封条是谁重新贴上的。",
              notes: "第9章回看封条，不应重开已兑现钩子。",
            },
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
        notes: [],
      }),
    });

    expect(result.hooks.hooks).toEqual([
      expect.objectContaining({
        hookId: "sealed-toolbox",
        status: "resolved",
        lastAdvancedEpisode: 8,
      }),
    ]);
  });

  it("merges duplicate restated hook families into the matched active hook", () => {
    const result = applyEpisodeRuntimeStateDelta({
      snapshot: {
        manifest: {
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 11,
          projectionVersion: 1,
          migrationWarnings: [],
        },
        currentState: {
          episode: 11,
          facts: [],
        },
        hooks: {
          hooks: [
            {
              hookId: "anonymous-source-scope",
              startEpisode: 3,
              type: "source-risk",
              status: "open",
              lastAdvancedEpisode: 8,
              expectedPayoff: "Reveal how much the anonymous source already knew about the route and address.",
              notes: "Still unresolved anonymous source knowledge question.",
            },
          ],
        },
        episodeSummaries: {
          rows: [],
        },
      },
      delta: EpisodeRuntimeStateDeltaSchema.parse({
        episode: 12,
        hookOps: {
          upsert: [
            {
              hookId: "anonymous-source-restated",
              startEpisode: 12,
              type: "source-risk",
              status: "open",
              lastAdvancedEpisode: 12,
              expectedPayoff: "Reveal how much the anonymous source already knew about the route.",
              notes: "Anonymous source knowledge question restated with slightly different wording.",
            },
          ],
          mention: [],
          resolve: [],
          defer: [],
        },
        notes: [],
      }),
    });

    expect(result.hooks.hooks).toHaveLength(1);
    expect(result.hooks.hooks[0]).toEqual(expect.objectContaining({
      hookId: "anonymous-source-scope",
      lastAdvancedEpisode: 12,
    }));
  });
});
