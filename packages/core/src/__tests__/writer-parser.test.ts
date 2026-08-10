import { describe, expect, it } from "vitest";
import { parseCreativeOutput, parseWriterOutput, isWriterOutputParseFailure } from "../agents/writer-parser.js";
import { EpisodeScriptSchema, renderEpisodeScriptMarkdown } from "../models/episode-script.js";
import type { GenreProfile } from "../models/genre-profile.js";

const genreProfile: GenreProfile = {
  name: "测试",
  id: "test",
  language: "zh",
  episodeTypes: [],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

function script(episode = 1) {
  return EpisodeScriptSchema.parse({
    episode,
    title: `证词${episode}`,
    estimatedDurationSeconds: 90,
    openingHook: "停电后，证人突然开口。",
    reversal: "旧录音证明证人此前撒谎，盟友因此夺走主动权。",
    emotionalHook: "主角还敢把最后一份证据交给盟友吗？",
    endState: "盟友掌握证据，双方从合作变为互相制衡。",
    contract: {
      incomingState: { knowledge: [], power: [], relationship: [], physical: [], activeAction: [] },
      objective: { character: "主角", desiredChange: "取得证词", whyNow: "警报即将恢复" },
      opposition: { actorOrConstraint: "盟友", goal: "独占证据", leverage: "控制出口" },
      causalEscalation: [{
        becauseOf: "停电暴露隐藏录音",
        choice: "主角播放录音",
        countermove: "盟友夺走录音器",
        stateChange: "证人谎言被确认",
        nextPressure: "主角必须决定是否继续信任盟友",
      }],
      localDramaticResult: { goalOutcome: "取得证词", stateChange: "证词被证实但控制权转移", costPaid: "主角失去证据控制权" },
      outgoingPressure: { startedDecisionDangerOrQuestion: "盟友开始单独行动", whyItFollows: "盟友已经拿到唯一录音" },
      handoffState: { knowledge: ["证人撒谎"], power: ["盟友控制证据"], relationship: ["合作转为制衡"], physical: [], activeAction: ["盟友开始单独行动"] },
      informationPermissions: [{ subject: "录音", audience: "观众", known: ["主角", "盟友"], suspected: [], mistaken: [], unknown: ["幕后指使者"] }],
    },
    scenes: [{
      id: "S1",
      location: "审讯室",
      time: "夜/内景",
      purpose: "完成证词兑现并转移主动权",
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `S1-${index + 1}`,
        shotSize: "近景",
        camera: "固定机位",
        durationSeconds: 15,
        visual: `第 ${index + 1} 个可见取证动作。`,
        dialogue: [],
      })),
    }],
  });
}

describe("EpisodeScript writer parser", () => {
  it("parses the strict marker contract and renders the Markdown projection", () => {
    const value = script();
    const output = parseCreativeOutput(1, [
      "=== PRE_WRITE_CHECK ===",
      "目标与交接已核对。",
      "=== EPISODE_SCRIPT_JSON ===",
      JSON.stringify(value),
    ].join("\n"));

    expect(output.title).toBe("证词1");
    expect(output.preWriteCheck).toContain("目标与交接");
    expect(output.content).toBe(renderEpisodeScriptMarkdown(value));
    expect(output.episodeScriptMetrics).toMatchObject({ shotCount: 6, estimatedDurationSeconds: 90 });
  });

  it("accepts fenced, embedded, and raw JSON artifacts", () => {
    const value = script();
    expect(parseCreativeOutput(1, `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``).title).toBe("证词1");
    expect(parseCreativeOutput(1, renderEpisodeScriptMarkdown(value)).title).toBe("证词1");
    expect(parseCreativeOutput(1, JSON.stringify(value)).title).toBe("证词1");
  });

  it("extracts JSON after a marker variant with trailing prose", () => {
    const value = script();
    const raw = [
      "=== PRE_WRITE_CHECK ===",
      "已核对。",
      "=== EPISODE_SCRIPT_JSON (strict) ===",
      JSON.stringify(value),
      "=== END ===",
    ].join("\n");
    expect(parseCreativeOutput(1, raw).title).toBe("证词1");
  });

  it("repairs bare quotation marks inside Chinese JSON strings", () => {
    const value = JSON.stringify(script()).replace("证词1", "电话里的\"姐姐\"声");
    expect(parseCreativeOutput(1, `=== EPISODE_SCRIPT_JSON ===\n${value}`).title).toBe("电话里的\"姐姐\"声");
  });

  it("recovers an outer JSON object after a pre-write marker and brace-like prose", () => {
    const value = script();
    const rawJson = JSON.stringify(value).replace("固定机位", "固定机位，画面出现{校验}标记");
    expect(parseCreativeOutput(1, `=== PRE_WRITE_CHECK ===\n已核对。\n${rawJson}`).title).toBe("证词1");
  });

  it("rejects free-form prose instead of silently saving it", () => {
    expect(() => parseCreativeOutput(1, "# 第1集\n\n这是一段小说正文。"))
      .toThrow(/EPISODE_SCRIPT_REQUIRED/);
  });

  it("rejects an EpisodeScript for the wrong episode", () => {
    expect(() => parseCreativeOutput(2, JSON.stringify(script(1))))
      .toThrow(/expected episode 2/);
  });

  it("tags malformed structured output with a stable failure code and the raw output", () => {
    // Paid-run regression: transient unparseable writer output evaporated with
    // the process, leaving nothing to diagnose. The error must carry the raw
    // response so the runner can persist it.
    const malformed = `=== PRE_WRITE_CHECK ===\n已核对。\n{ "episode": 1, broken json`;
    let caught: unknown;
    try {
      parseCreativeOutput(1, malformed);
    } catch (error) {
      caught = error;
    }
    expect(isWriterOutputParseFailure(caught)).toBe(true);
    expect((caught as Error).message).toContain("漫剧分镜稿解析失败");
    expect((caught as { rawOutput: string }).rawOutput).toBe(malformed);
  });

  it("keeps parseWriterOutput on the same strict authority", () => {
    const output = parseWriterOutput(1, JSON.stringify(script()), genreProfile);
    expect(output.episodeScript?.episode).toBe(1);
    expect(output.updatedState).toBe("(状态卡未更新)");
  });
});
