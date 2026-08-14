import { describe, expect, it } from "vitest";
import { parseEpisodeScriptOutput } from "../models/episode-script.js";
import { parseCreativeOutput, isWriterOutputParseFailure } from "../agents/writer-parser.js";
import { auditEarlyHookPayoff, auditCrossEpisodeShotRepeat, auditEpisodeScript } from "../pipeline/episode-quality-gate.js";
import { detectDuplicateTitle } from "../agents/post-write-validator.js";
import { evaluateSeriesCompletion } from "../pipeline/series-completion.js";
import type { EpisodeScript } from "../models/episode-script.js";
import type { BookConfig } from "../models/book.js";
import type { EpisodeMeta } from "../models/episode.js";
import type { HookRecord } from "../models/runtime-state.js";
import type { EpisodeRuntimeStateSnapshot } from "../state/episode-state-reducer.js";

// ============================================================
// P0-2: writer output parse fallbacks (production E34 failure)
// ============================================================

function validEpisodeScriptJson(overrides: Record<string, unknown> = {}): string {
  const script: Record<string, unknown> = {
    episode: 1,
    title: "测试集",
    estimatedDurationSeconds: 150,
    openingHook: "开场钩子。",
    reversal: "本集反转。",
    emotionalHook: "她为什么说这句话？",
    endState: "他离开了。",
    contract: {
      incomingState: {
        knowledge: ["他知道一件事"], power: ["他有玉"], relationship: ["他们是青梅竹马"],
        physical: ["他在博物馆"], activeAction: ["他要离开"], emotional: [],
      },
      objective: { character: "顾甲", desiredChange: "找到真相", whyNow: "必须现在行动" },
      opposition: { actorOrConstraint: "阻力", goal: "阻止他", leverage: "筹码" },
      causalEscalation: [
        { becauseOf: "起因", choice: "他选择行动", countermove: "阻力反击", stateChange: "状态改变", nextPressure: "下一压力" },
      ],
      localDramaticResult: { goalOutcome: "成功", stateChange: "他到达终点", costPaid: "代价" },
      outgoingPressure: { startedDecisionDangerOrQuestion: "他要做一个选择？", whyItFollows: "由结果产生" },
      handoffState: {
        knowledge: ["他带走了玉"], power: ["他更强了"], relationship: ["他们分开了"],
        physical: ["他在门外"], activeAction: ["他要继续走"], emotional: [],
      },
      informationPermissions: [{ subject: "顾甲", audience: "观众", known: [], suspected: [], mistaken: [], unknown: [] }],
    },
    scenes: [{
      id: "S1",
      location: "博物馆",
      time: "夜晚",
      purpose: "交代",
      // 10 shots x 15s = 150s, matching the declared duration so the fixture
      // survives the deterministic duration validation inside parseEpisodeScriptOutput.
      shots: Array.from({ length: 10 }, (_, index) => ({
        id: `S1-0${index + 1}`,
        shotSize: "中景",
        camera: "固定",
        durationSeconds: 15,
        visual: index === 0 ? "他站在月光下，握着一枚玉。" : "她抬起头，看着月亮。",
        dialogue: index === 0 ? [{ speaker: "顾甲", text: "我一定要回去。" }] : [],
        narration: index === 1 ? "旁白。" : "",
        sound: "",
        transition: "",
      })),
    }],
  };
  return JSON.stringify({ ...script, ...overrides });
}

describe("P0-2 writer parse fallbacks", () => {
  it("recovers a JSON object that follows prose + a marked block", () => {
    const raw = `这一集要写送别。
=== PRE_WRITE_CHECK ===
开场在月下，结尾走进光门。
=== EPISODE_SCRIPT_JSON ===
${validEpisodeScriptJson()}`;
    const parsed = parseEpisodeScriptOutput(raw, 1);
    expect(parsed.title).toBe("测试集");
  });

  it("recovers a bare JSON object embedded after prose (no marker)", () => {
    const raw = `以下是本集完整剧本：\n${validEpisodeScriptJson()}`;
    const parsed = parseEpisodeScriptOutput(raw, 1);
    expect(parsed.episode).toBe(1);
  });

  it("wraps structured-looking parse failures with the stable code + rawOutput so the runner regenerates", () => {
    // A malformed marked block (looks structured) must carry the stable code.
    let caught: unknown;
    try {
      parseCreativeOutput(1, "=== PRE_WRITE_CHECK ===\n已核对。\n{ \"episode\": 1, broken json");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isWriterOutputParseFailure(caught)).toBe(true);
    if (caught instanceof Error) {
      expect((caught as { code?: string }).code).toBe("WRITER_OUTPUT_PARSE_FAILED");
      expect((caught as { rawOutput?: string }).rawOutput).toContain("PRE_WRITE_CHECK");
    }
  });

  it("keeps pure free-form prose a plain contract error (no regeneration round-trip)", () => {
    expect(() => parseCreativeOutput(1, "这是一段没有 JSON 的自由文本回复。")).toThrow(/EPISODE_SCRIPT_REQUIRED/);
  });
});

// ============================================================
// P1-1: early-hook-payoff deterministic guard
// ============================================================

function scriptFor(episode: number, visualTexts: ReadonlyArray<string>): EpisodeScript {
  const script = JSON.parse(validEpisodeScriptJson()) as EpisodeScript;
  return {
    ...script,
    episode,
    seriesResolution: {
      mainConflict: "主线冲突已解决。",
      protagonistDesire: "主角达成终局。",
      characterArcs: [{ character: "顾甲", outcome: "他选择留下。" }],
      relationships: [{ parties: "顾甲与苏晚", outcome: "重新认识。" }],
    },
    scenes: [{
      id: "S1",
      location: "渊底",
      time: "夜",
      purpose: "探查",
      shots: visualTexts.map((visual, index) => ({
        id: `S1-0${index + 1}`,
        shotSize: "中景",
        camera: "固定",
        durationSeconds: 15,
        visual,
        dialogue: [],
        narration: "",
        sound: "",
        transition: "",
      })),
    }],
  };
}

describe("P1-1 auditEarlyHookPayoff", () => {
  const tombHook = {
    hookId: "H005",
    targetPayoffEpisode: 29,
    payoffEvidence: ["衣冠冢", "空棺", "遗书"],
    expectedPayoff: "第29集",
    notes: "初始状态：衣冠冢空棺+遗书「若你读到——莫要再让她等」+雌玉「归」",
    audienceQuestion: "她到底在等谁？",
  };

  it("flags a hook whose payoff facts appear before the scheduled episode", () => {
    const issues = auditEarlyHookPayoff(scriptFor(6, ["顾甲在渊底发现衣冠冢，打开空棺，取出遗书「若你读到——莫要再让她等」"]), [tombHook]);
    expect(issues.some((issue) => issue.category === "early-hook-payoff")).toBe(true);
  });

  it("stays silent when the current episode is at or after the payoff episode", () => {
    const issues = auditEarlyHookPayoff(scriptFor(29, ["顾甲在渊底发现衣冠冢，打开空棺"]), [tombHook]);
    expect(issues.filter((issue) => issue.category === "early-hook-payoff")).toHaveLength(0);
  });

  it("stays silent when no hook keywords appear on screen", () => {
    const issues = auditEarlyHookPayoff(scriptFor(6, ["顾甲在渊底行走，四周黑暗"]), [tombHook]);
    expect(issues.filter((issue) => issue.category === "early-hook-payoff")).toHaveLength(0);
  });

  it("does not mistake a quoted character name for a payoff fact", () => {
    const issues = auditEarlyHookPayoff(scriptFor(1, ["顾甲站在渊底，抬头看向裂口"]), [{
      hookId: "H009",
      expectedPayoff: "第21集",
      notes: "初始线索：闻烬叫出\"顾甲\"，但没有交代他的真实身份",
      audienceQuestion: "顾甲究竟是谁？",
    }]);
    expect(issues).toHaveLength(0);
  });
});

// ============================================================
// P1-2: contract↔scenes — handoff facts need a visible carrier
// ============================================================

describe("P1-2 handoff surface evidence", () => {
  it("warns when a handoff fact has no on-screen carrier", () => {
    const script = JSON.parse(validEpisodeScriptJson()) as EpisodeScript;
    script.contract.handoffState.knowledge.push("苏甲在千年长明灯前等了他一千年");
    const issues = auditEpisodeScript(script);
    expect(issues.some((issue) => issue.category === "contract-without-screen-evidence"
      && issue.description.includes("Handoff"))).toBe(true);
  });
});

// ============================================================
// P1-3: title dedup — bare title vs suffixed variant
// ============================================================

describe("P1-3 title dedup suffix variants", () => {
  it("treats a bare title as a duplicate of a previously suffixed variant", () => {
    const issues = detectDuplicateTitle("我在", ["我在：开场"]);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("still accepts a genuinely different title", () => {
    expect(detectDuplicateTitle("归途", ["我在：开场", "阿辞"])).toHaveLength(0);
  });
});

// ============================================================
// P1-4: series completion — paid-off open hook downgrades to warning
// ============================================================

const book: BookConfig = {
  id: "series",
  title: "Series",
  platform: "other",
  genre: "other",
  status: "active",
  schemaVersion: "inkos-episode-v2",
  format: "screenplay" as const,
  targetEpisodes: 2,
  episodeDurationSeconds: 90,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function meta(episodeNumber: number): EpisodeMeta {
  return {
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    status: "approved",
    episodeDurationSeconds: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
  };
}

describe("P1-4 series completion open-hook leniency", () => {
  function runtimeStateWithHook(hook: HookRecord): EpisodeRuntimeStateSnapshot {
    return {
      manifest: { lastAppliedEpisode: 2, format: "inkos-episode-v2", schemaVersion: 1 },
      currentState: { episode: 2, facts: [] },
      hooks: { hooks: [hook] },
      episodeSummaries: {
        rows: [{
          episodeNumber: 2,
          title: "终局",
          characters: "顾甲、苏甲",
          events: "他走进光门又回来，两人并肩离开。",
          stateChanges: "归途完成，抹除落定。",
          payoff: "那句问话有了落点。",
          relationshipChange: "他选择留下。",
          episodeType: "episode",
        }],
      },
    } as unknown as EpisodeRuntimeStateSnapshot;
  }

  const openTombHook: HookRecord = {
    hookId: "H005",
    startEpisode: 0,
    type: "角色伏笔",
    status: "progressing",
    lastAdvancedEpisode: 0,
    expectedPayoff: "第29集",
    notes: "初始状态：衣冠冢空棺+遗书「若你读到——莫要再让她等」+雌玉「归」",
    coreHook: true,
  };

  it("downgrades a core hook that is visibly paid off in the final episode", () => {
    const finalScript = scriptFor(2, ["顾甲在渊底打开空棺，取出遗书「若你读到——莫要再让她等」"]);
    const report = evaluateSeriesCompletion({
      book,
      episodes: [meta(1), meta(2)],
      runtimeState: runtimeStateWithHook(openTombHook),
      finalEpisodeScript: finalScript,
    });
    const hookIssue = report.issues.find((issue) => issue.code === "open-core-hook");
    expect(hookIssue).toBeDefined();
    expect(hookIssue?.severity).toBe("warning");
    expect(report.completed).toBe(true);
  });

  it("still blocks when the final episode does not surface the hook", () => {
    const finalScript = scriptFor(2, ["两人并肩走进馆门"]);
    const report = evaluateSeriesCompletion({
      book,
      episodes: [meta(1), meta(2)],
      runtimeState: runtimeStateWithHook(openTombHook),
      finalEpisodeScript: finalScript,
    });
    const hookIssue = report.issues.find((issue) => issue.code === "open-core-hook");
    expect(hookIssue?.severity).toBe("critical");
    expect(report.completed).toBe(false);
  });
});

// ============================================================
// Cross-episode shot-repeat guard (screenplay fill detection)
// ============================================================

describe("auditCrossEpisodeShotRepeat", () => {
  it("flags shot-surface phrases reused from a recent episode", () => {
    const previous = scriptFor(1, [
      "他站在月光下，握着一枚玉。他慢慢转身，看向远处的门。",
      "她抬起头，看着月亮，久久没有开口。",
      "门外传来脚步声，他停下动作。",
    ]);
    const current = scriptFor(2, [
      "他站在月光下，握着一枚玉。他慢慢转身，看向远处的门。",
      "她抬起头，看着月亮，久久没有开口。",
      "门外传来脚步声，他停下动作。",
    ]);
    const issues = auditCrossEpisodeShotRepeat(current, [previous], "zh");
    expect(issues.some((issue) => issue.category === "跨集镜头重复")).toBe(true);
  });

  it("flags behavior-signature overlap when stage business repeats", () => {
    const previous = scriptFor(1, [
      "他进入房间，打开抽屉，检查里面。",
      "他转身，抬头看，然后低头。",
      "他抓住门，后退一步。",
    ]);
    const current = scriptFor(2, [
      "他进入房间，打开箱子，检查里面。",
      "他转身，抬头看，然后低头。",
      "他抓住把手，后退一步。",
    ]);
    const issues = auditCrossEpisodeShotRepeat(current, [previous], "zh");
    expect(issues.some((issue) => issue.category === "行为同构")).toBe(true);
  });

  it("does not flag distinct episodes", () => {
    const previous = scriptFor(1, [
      "他进入房间，打开抽屉。", "他检查纸张。", "他转身离开。",
    ]);
    const current = scriptFor(2, [
      "她冲向码头，跳进水里。", "她抓住绳索。", "她喊出名字。",
    ]);
    const issues = auditCrossEpisodeShotRepeat(current, [previous], "zh");
    expect(issues).toEqual([]);
  });

  it("is reachable through auditEpisodeScript when recentScripts are supplied", () => {
    const previous = scriptFor(1, ["他进入房间，打开抽屉。", "他检查纸张。", "他转身离开。"]);
    const current = scriptFor(2, ["他进入房间，打开抽屉。", "他检查纸张。", "他转身离开。"]);
    const issues = auditEpisodeScript(current, previous, 150, undefined, [previous], "zh");
    expect(issues.some((issue) => issue.category === "跨集镜头重复" || issue.category === "行为同构")).toBe(true);
  });
});
