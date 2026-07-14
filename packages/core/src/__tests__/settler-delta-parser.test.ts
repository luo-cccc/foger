import { describe, expect, it } from "vitest";
import { parseSettlerDeltaOutput } from "../agents/settler-delta-parser.js";

describe("parseSettlerDeltaOutput", () => {
  it("normalizes blank optional current-state values to omitted patches", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 1,
        currentStatePatch: {
          currentLocation: "  OCC检修间  ",
          currentGoal: "",
          currentConflict: "   ",
        },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
        notes: [],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.currentStatePatch).toEqual({
      currentLocation: "OCC检修间",
      currentGoal: undefined,
      currentConflict: undefined,
    });
  });

  it("parses a valid runtime-state delta block", () => {
    const result = parseSettlerDeltaOutput([
      "=== POST_SETTLEMENT ===",
      "| 伏笔变动 | mentor-oath 推进 | 同步更新 |",
      "",
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 12,
        currentStatePatch: {
          currentGoal: "追到河埠旧账的尽头",
          currentConflict: "商会噪音仍在干扰师债主线",
        },
        hookOps: {
          upsert: [
            {
              hookId: "mentor-oath",
              startChapter: 8,
              type: "relationship",
              status: "progressing",
              lastAdvancedChapter: 12,
              expectedPayoff: "揭开师债真相",
              notes: "河埠旧账把师债再往前推了一格",
            },
          ],
          resolve: [],
          defer: [],
        },
        chapterSummary: {
          chapter: 12,
          title: "河埠对账",
          characters: "林月",
          events: "林月核对河埠旧账",
          stateChanges: "师债线索进一步收束",
          hookActivity: "mentor-oath advanced",
          mood: "紧绷",
          chapterType: "主线推进",
        },
        notes: ["保留商会噪音，但不盖过主线"],
      }, null, 2),
      "```",
    ].join("\n"));

    expect(result.postSettlement).toContain("mentor-oath");
    expect(result.runtimeStateDelta.chapter).toBe(12);
    expect(result.runtimeStateDelta.hookOps.upsert[0]?.hookId).toBe("mentor-oath");
    expect(result.runtimeStateDelta.chapterSummary?.title).toBe("河埠对账");
  });

  it("rejects invalid runtime-state delta payloads", () => {
    expect(() =>
      parseSettlerDeltaOutput([
        "=== RUNTIME_STATE_DELTA ===",
        "```json",
        JSON.stringify({
          chapter: 12,
          hookOps: {
            upsert: [
              {
                hookId: "mentor-oath",
                startChapter: 8,
                type: "relationship",
                status: "open",
                lastAdvancedChapter: "chapter twelve",
              },
            ],
            resolve: [],
            defer: [],
          },
        }),
        "```",
      ].join("\n")),
    ).toThrow(/runtime state delta/i);
  });

  it("parses hook resolve and defer operations", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 20,
        hookOps: {
          upsert: [],
          mention: ["mentor-oath"],
          resolve: ["old-seal"],
          defer: ["guild-route"],
        },
        notes: [],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.hookOps.mention).toEqual(["mentor-oath"]);
    expect(result.runtimeStateDelta.hookOps.resolve).toEqual(["old-seal"]);
    expect(result.runtimeStateDelta.hookOps.defer).toEqual(["guild-route"]);
  });

  it("parses new hook candidates separately from existing hook ops", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 21,
        hookOps: {
          upsert: [],
          mention: ["mentor-oath"],
          resolve: [],
          defer: [],
        },
        newHookCandidates: [
          {
            type: "source-risk",
            expectedPayoff: "Reveal what the anonymous source already knew about the route and address",
            notes: "This chapter opens a fresh unresolved question about source knowledge.",
          },
        ],
        notes: [],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.hookOps.upsert).toEqual([]);
    expect(result.runtimeStateDelta.newHookCandidates).toEqual([
      expect.objectContaining({
        type: "source-risk",
      }),
    ]);
  });

  it("normalizes hook type and status aliases before schema validation", () => {
    const result = parseSettlerDeltaOutput([
      "=== RUNTIME_STATE_DELTA ===",
      "```json",
      JSON.stringify({
        chapter: 3,
        hookOps: {
          upsert: [{
            hookId: "H004",
            startChapter: 1,
            type: "信息",
            status: "已推进",
            lastAdvancedChapter: 3,
            expectedPayoff: "解密零号协议的完整名单",
            notes: "本章解开一部分身份字段",
          }],
          mention: [],
          resolve: [],
          defer: [],
        },
        newHookCandidates: [{
          type: "物件",
          expectedPayoff: "解释密钥的潮汐响应规则",
          notes: "本章首次出现可验证的物件异常",
        }],
      }),
      "```",
    ].join("\n"));

    expect(result.runtimeStateDelta.hookOps.upsert[0]).toEqual(expect.objectContaining({
      type: "information",
      status: "progressing",
    }));
    expect(result.runtimeStateDelta.newHookCandidates[0]?.type).toBe("artifact");
  });
});
