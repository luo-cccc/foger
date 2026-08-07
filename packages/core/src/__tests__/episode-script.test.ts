import { describe, expect, it } from "vitest";
import {
  EpisodeScriptSchema,
  measureEpisodeScript,
  parseEpisodeScriptOutput,
  renderEpisodeScriptMarkdown,
  validateEpisodeScript,
} from "../models/episode-script.js";
import { auditEpisodeScript } from "../pipeline/episode-quality-gate.js";

function sampleScript() {
  return EpisodeScriptSchema.parse({
    episode: 1,
    title: "雨夜来客",
    estimatedDurationSeconds: 90,
    openingHook: "尸体在雨幕中突然睁眼。",
    reversal: "观众以为主角是受害者，但证据揭示他才是放火者，代价是盟友转身拔枪。",
    emotionalHook: "她会在知道真相后继续救他吗？",
    endState: "盟友知道了主角的秘密，关系从保护变成敌对。",
    contract: {
      incomingState: {
        knowledge: ["主角知道车站有人纵火"],
        power: ["盟友掌握唯一出口"],
        relationship: ["两人仍保持脆弱同盟"],
        physical: ["主角手臂受伤"],
        activeAction: ["主角正在寻找失踪证人"],
      },
      objective: {
        character: "主角",
        desiredChange: "拿到纵火证据并保住盟友",
        whyNow: "警方即将封锁车站",
      },
      opposition: {
        actorOrConstraint: "盟友与封锁的车站",
        goal: "阻止主角继续追查",
        leverage: "盟友持有出口钥匙",
      },
      causalEscalation: [{
        becauseOf: "尸体突然睁眼暴露仍有目击者",
        choice: "主角掀开尸体外套寻找证据",
        countermove: "盟友拔枪逼他停手",
        stateChange: "主角确认火灾并非意外",
        nextPressure: "主角必须在封锁前说服盟友放行",
      }],
      localDramaticResult: {
        goalOutcome: "拿到证据但未能脱身",
        stateChange: "纵火证据落入主角手中，盟友立场翻转",
        costPaid: "主角失去盟友信任并暴露身份",
      },
      outgoingPressure: {
        startedDecisionDangerOrQuestion: "盟友会不会在警察到场前交出主角",
        whyItFollows: "盟友已经看见主角留下的纵火证据",
      },
      handoffState: {
        knowledge: ["主角确认车站火灾是人为"],
        power: ["盟友掌握是否放行的主动权"],
        relationship: ["同盟转为互相提防"],
        physical: ["主角带伤困在车站内"],
        activeAction: ["主角必须在封锁前说服盟友"],
      },
      informationPermissions: [{
        subject: "纵火真相",
        audience: "观众和主角看见证据，盟友只看见主角持证",
        known: ["主角", "观众"],
        suspected: ["盟友"],
        mistaken: ["警方以为是意外"],
        unknown: ["真正纵火者"],
      }],
    },
    scenes: [
      {
        id: "S1",
        location: "废弃车站",
        time: "夜/外景",
        purpose: "建立威胁并逼出选择",
        shots: Array.from({ length: 6 }, (_, index) => ({
          id: `S1-${index + 1}`,
          shotSize: index === 0 ? "远景" : "近景",
          camera: "固定后缓慢推进",
          durationSeconds: 15,
          visual: `雨水冲过第 ${index + 1} 根站柱。`,
          dialogue: index === 5 ? [{ speaker: "林夏", text: "你终于想起来了。" }] : [],
          sound: "雨声",
        })),
      },
    ],
  });
}

describe("episode screenplay contract", () => {
  it("measures and renders a structured 90-second episode", () => {
    const script = sampleScript();
    const metrics = measureEpisodeScript(script);
    expect(metrics).toMatchObject({ shotCount: 6, sceneCount: 1, estimatedDurationSeconds: 90 });
    const markdown = renderEpisodeScriptMarkdown(script);
    expect(markdown).toContain("# 第1集 雨夜来客");
    expect(markdown).toContain("<!-- inkos-episode-script-json");
    expect(parseEpisodeScriptOutput(markdown, 1).title).toBe("雨夜来客");
  });

  it("flags missing causal reversal and emotional question", () => {
    const script = sampleScript();
    const invalid = { ...script, reversal: "发生了一个反转", emotionalHook: "观众继续等待" };
    const issues = auditEpisodeScript(invalid);
    expect(issues.map((issue) => issue.category)).toEqual(expect.arrayContaining([
      "unprepared-reversal",
      "emotional-hook",
    ]));
  });

  it("rejects an episode number mismatch", () => {
    expect(() => parseEpisodeScriptOutput(JSON.stringify(sampleScript()), 2)).toThrow(/does not match/);
  });

  it("reports hard duration drift", () => {
    const script = sampleScript();
    const short = {
      ...script,
      scenes: [{ ...script.scenes[0]!, shots: script.scenes[0]!.shots.map((shot) => ({ ...shot, durationSeconds: 5 })) }],
    };
    expect(auditEpisodeScript(short).some((issue) => issue.category === "screenplay-duration" && issue.severity === "critical")).toBe(true);
    expect(() => parseEpisodeScriptOutput(JSON.stringify(short), 1)).toThrow(/outside 60-120/iu);
  });

  it("rejects duplicate scene and shot IDs", () => {
    const base = sampleScript();
    const duplicateScene = {
      ...base,
      scenes: [base.scenes[0]!, { ...base.scenes[0]!, shots: [] }],
    };
    expect(validateEpisodeScript(duplicateScene).map((issue) => issue.code)).toContain("duplicate-scene-id");

    const duplicateShot = {
      ...base,
      scenes: [{
        ...base.scenes[0]!,
        shots: base.scenes[0]!.shots.map((shot, index) => (
          index === 1 ? { ...shot, id: base.scenes[0]!.shots[0]!.id } : shot
        )),
      }],
    };
    expect(validateEpisodeScript(duplicateShot).map((issue) => issue.code)).toContain("duplicate-shot-id");
  });

  it("uses the configured duration target for soft warnings", () => {
    const script = sampleScript();
    expect(measureEpisodeScript(script, 105).durationWarnings).toEqual([]);
    const issues = auditEpisodeScript(script, undefined, 120);
    expect(issues.find((issue) => issue.category === "screenplay-duration")?.description)
      .toContain("105-120s");
  });

  it("blocks contract claims that have no shot-level evidence", () => {
    const script = sampleScript();
    const issues = auditEpisodeScript({
      ...script,
      contract: {
        ...script.contract,
        localDramaticResult: {
          ...script.contract.localDramaticResult,
          stateChange: "主角夺取蓝色钥匙并击倒守卫",
        },
        outgoingPressure: {
          ...script.contract.outgoingPressure,
          startedDecisionDangerOrQuestion: "地下爆破倒计时已经启动",
        },
      },
    });
    expect(issues.filter((issue) => issue.category === "contract-without-screen-evidence").length).toBeGreaterThan(0);
  });
});
