import { describe, expect, it } from "vitest";
import {
  carryForwardEpisodeIncomingState,
  EpisodeScriptSchema,
  measureEpisodeScript,
  normalizeEpisodeShotDurations,
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
  it("carries forward authoritative handoff facts into the next incoming state", () => {
    // Paid 10-episode test exposed EP-004-handoff-state-mismatch: the model
    // omitted a carried activeAction fact, so episode 4 incoming state no
    // longer matched episode 3 handoff. The merge must keep both the model's
    // own facts and the previous handoff boundary.
    const script = sampleScript();
    const previousHandoff = {
      knowledge: ["上一集确认的旧事实"],
      power: ["上一集移交的权力"],
      relationship: ["上一集落定的关系"],
      physical: ["上一集遗留的伤情"],
      activeAction: ["上一集未完成的动作"],
      emotional: ["上一集作出的情绪决定"],
    };
    const carried = carryForwardEpisodeIncomingState(script, previousHandoff);

    expect(carried.contract.incomingState.knowledge).toContain("主角知道车站有人纵火");
    expect(carried.contract.incomingState.knowledge).toContain("上一集确认的旧事实");
    expect(carried.contract.incomingState.activeAction).toContain("主角正在寻找失踪证人");
    expect(carried.contract.incomingState.activeAction).toContain("上一集未完成的动作");
    expect(carried.contract.incomingState.emotional).toContain("上一集作出的情绪决定");
    // The visible episode text stays untouched; only the persisted contract
    // boundary carries the authoritative continuity facts.
    expect(carried.title).toBe(script.title);
    expect(carried.scenes).toEqual(script.scenes);
    expect(carried.scenes[0]?.shots[0]?.visual).toBe(script.scenes[0]?.shots[0]?.visual);
  });

  it("keeps the incoming state unchanged when there is no previous handoff", () => {
    const script = sampleScript();
    expect(carryForwardEpisodeIncomingState(script, undefined)).toBe(script);
  });

  it("flags deliveries that name an emotion instead of an executable strategy", () => {
    const script = sampleScript();
    script.scenes[0]!.shots[0]!.dialogue[0] = {
      speaker: "林夏",
      text: "你终于想起来了。",
      delivery: "平静",
    };
    const issues = auditEpisodeScript(script);
    expect(issues.map((issue) => issue.category)).toContain("delivery-emotion-word");
    const executable = sampleScript();
    executable.scenes[0]!.shots[0]!.dialogue[0] = {
      speaker: "林夏",
      text: "你终于想起来了。",
      delivery: "试探",
    };
    expect(auditEpisodeScript(executable).map((issue) => issue.category))
      .not.toContain("delivery-emotion-word");
  });

  it("reports unknown speakers and an unbound objective character against the settings index", () => {
    const script = sampleScript();
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["林岚"]),
    });
    const reference = issues.filter((issue) => issue.category === "unknown-character-reference");
    expect(reference.some((issue) => issue.severity === "warning")).toBe(true);
    expect(reference.some((issue) => issue.severity === "critical")).toBe(true);
  });

  it("skips reference integrity when no settings index is provided", () => {
    const script = sampleScript();
    expect(auditEpisodeScript(script).map((issue) => issue.category))
      .not.toContain("unknown-character-reference");
  });

  it("accepts known speakers and narration placeholders", () => {
    const script = sampleScript();
    script.scenes[0]!.shots[0]!.dialogue.push({ speaker: "旁白", text: "雨在落下。" });
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["林夏", "主角"]),
    });
    expect(issues.map((issue) => issue.category)).not.toContain("unknown-character-reference");
  });

  it("warns when a long speech has no action beat (SCR-09 approximation)", () => {
    const longText = "你".repeat(85); // two lines → 170 chars total for one speaker
    const base = sampleScript();

    // Long and uninterrupted (no action in the shot) → warning
    const uninterrupted = sampleScript();
    uninterrupted.scenes[0]!.shots[0]!.action = undefined;
    uninterrupted.scenes[0]!.shots[0]!.dialogue = [
      { speaker: "林夏", text: longText },
      { speaker: "林夏", text: longText },
    ];
    const flagged = auditEpisodeScript(uninterrupted).filter(
      (issue) => issue.category === "long-speech-without-action",
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.severity).toBe("warning");
    expect(flagged[0]!.ruleClass).toBe("craft_default");
    expect(flagged[0]!.description).toContain("林夏");

    // Long but broken by an action beat → no warning
    const withAction = sampleScript();
    withAction.scenes[0]!.shots[0]!.action = "她把磁带推过桌面";
    withAction.scenes[0]!.shots[0]!.dialogue = [
      { speaker: "林夏", text: longText },
      { speaker: "林夏", text: longText },
    ];
    expect(auditEpisodeScript(withAction).map((issue) => issue.category))
      .not.toContain("long-speech-without-action");

    // Short speech without action → no warning
    expect(auditEpisodeScript(base).map((issue) => issue.category))
      .not.toContain("long-speech-without-action");
  });

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
    expect(() => parseEpisodeScriptOutput(JSON.stringify(short), 1)).toThrow(/outside 90-210/iu);
  });

  it("rescues an under-length draft by deterministic duration normalization", () => {
    const script = sampleScript();
    const short = {
      ...script,
      scenes: [{ ...script.scenes[0]!, shots: script.scenes[0]!.shots.map((shot) => ({ ...shot, durationSeconds: 5 })) }],
    };
    const rescued = parseEpisodeScriptOutput(JSON.stringify(short), 1, 90);
    const measured = measureEpisodeScript(rescued).estimatedDurationSeconds;
    expect(measured).toBeGreaterThanOrEqual(60);
    expect(measured).toBeLessThanOrEqual(120);
  });

  it("extracts a JSON object that follows a PRE_WRITE_CHECK block without a marker", () => {
    const script = sampleScript();
    const json = JSON.stringify(script);
    const raw = [
      "=== PRE_WRITE_CHECK ===",
      "checked: incoming state aligned, shot count 6, duration 90s",
      "",
      json,
    ].join("\n");
    const parsed = parseEpisodeScriptOutput(raw, 1);
    expect(parsed.title).toBe("雨夜来客");
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

  it("reports the measured shot count in the shot-count validation message", () => {
    const script = sampleScript();
    script.scenes[0]!.shots = script.scenes[0]!.shots.slice(0, 3);
    const issues = validateEpisodeScript(script, 1);
    const shotCount = issues.find((issue) => issue.code === "shot-count");
    expect(shotCount?.message).toMatch(/got \d+/);
  });

  it("does not flag timeline drift when incoming carries the previous physical facts", () => {
    const previous = sampleScript();
    previous.contract.handoffState.physical = ["雨夜码头"];
    const current = sampleScript();
    current.episode = 2;
    current.contract.incomingState.physical = ["雨夜码头", "店内", "怀表在抽屉"];
    const issues = auditEpisodeScript(current, previous);
    expect(issues.map((issue) => issue.category)).not.toContain("timeline-drift");
  });

  it("flags timeline drift when a previous physical fact is missing from incoming", () => {
    const previous = sampleScript();
    previous.contract.handoffState.physical = ["雨夜码头", "带伤的右手"];
    const current = sampleScript();
    current.episode = 2;
    current.contract.incomingState.physical = ["店内"];
    const issues = auditEpisodeScript(current, previous);
    expect(issues.map((issue) => issue.category)).toContain("timeline-drift");
  });

  it("exempts functional role speakers from the character reference audit", () => {
    const script = sampleScript();
    script.contract.objective.character = "林夏";
    script.scenes[0]!.shots[0]!.dialogue.push({ speaker: "陌生女人", text: "你终于想起来了。" });
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["林夏"]),
    });
    expect(issues.map((issue) => issue.category)).not.toContain("unknown-character-reference");
  });

  it("exempts military/role-token speakers of any length", () => {
    const script = sampleScript();
    script.contract.objective.character = "沈砚";
    script.scenes[0]!.shots[0]!.dialogue.push(
      { speaker: "暗哨队长", text: "跟上。" },
      { speaker: "火种营亲兵", text: "是。" },
      { speaker: "元军什长", text: "搜。" },
      { speaker: "老民夫", text: "往这边。" },
    );
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["沈砚", "林夏", "主角"]),
    });
    expect(issues.map((issue) => issue.category)).not.toContain("unknown-character-reference");
  });

  it("accepts speakers introduced by earlier persisted episodes without re-warning", () => {
    const script = sampleScript();
    script.contract.objective.character = "林夏";
    script.scenes[0]!.shots[0]!.dialogue.push(
      { speaker: "王贵", text: "跟上。" },
      { speaker: "赵承", text: "是。" },
    );
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["林夏"]),
      episodeSeenSpeakers: new Set(["王贵"]),
    });
    const references = issues.filter((issue) => issue.category === "unknown-character-reference");
    expect(references.some((issue) => issue.description.includes("王贵"))).toBe(false);
    expect(references.some((issue) => issue.description.includes("赵承"))).toBe(true);
  });

  it("classifies the emotional-hook finding as a locally patchable field", () => {
    const script = sampleScript();
    const invalid = { ...script, emotionalHook: "观众继续等待" };
    const issues = auditEpisodeScript(invalid);
    const emotionalHookIssue = issues.find((issue) => issue.category === "emotional-hook");
    expect(emotionalHookIssue?.severity).toBe("critical");
    expect(emotionalHookIssue?.repairScope).toBe("local");
  });

  it("still flags name-like unknown speakers", () => {
    const script = sampleScript();
    script.contract.objective.character = "林夏";
    script.scenes[0]!.shots[0]!.dialogue.push({ speaker: "顾维远", text: "你终于想起来了。" });
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["林夏"]),
    });
    expect(issues.map((issue) => issue.category)).toContain("unknown-character-reference");
  });

  it("matches speakers with parenthetical stage qualifiers against the settings index", () => {
    const script = sampleScript();
    script.contract.objective.character = "林夏";
    script.scenes[0]!.shots[0]!.dialogue.push({ speaker: "顾维远（画外）", text: "你终于想起来了。" });
    script.scenes[0]!.shots[0]!.dialogue.push({ speaker: "旁白（母亲的信）", text: "雨在落下。" });
    const issues = auditEpisodeScript(script, undefined, 90, {
      characterNames: new Set(["林夏", "顾维远"]),
    });
    expect(issues.map((issue) => issue.category)).not.toContain("unknown-character-reference");
  });

  it("normalizes shot durations toward the target within the hard range", () => {
    const script = sampleScript();
    script.scenes[0]!.shots = script.scenes[0]!.shots.map((shot, index) => ({
      ...shot,
      durationSeconds: 20,
    }));
    const { script: normalized, adjusted } = normalizeEpisodeShotDurations(script, 90);
    expect(adjusted).toBe(true);
    expect(measureEpisodeScript(normalized, 90).estimatedDurationSeconds).toBeGreaterThanOrEqual(85);
    expect(measureEpisodeScript(normalized, 90).estimatedDurationSeconds).toBeLessThanOrEqual(95);
    expect(normalized.scenes.flatMap((scene) => scene.shots)).toHaveLength(script.scenes.flatMap((scene) => scene.shots).length);
  });

  it("leaves durations untouched when already within 5 seconds of the target", () => {
    const script = sampleScript();
    const result = normalizeEpisodeShotDurations(script, 90);
    expect(result.adjusted).toBe(false);
    expect(result.script).toBe(script);
  });

  it("uses the configured duration target for soft warnings", () => {
    const script = sampleScript();
    expect(measureEpisodeScript(script, 105).durationWarnings).toEqual([]);
    const issues = auditEpisodeScript(script, undefined, 150);
    expect(issues.find((issue) => issue.category === "screenplay-duration")?.description)
      .toContain("120-180s");
  });

  it("warns softly when shot count exceeds the soft budget without rejecting the episode", () => {
    // Shot-count upper bound is a soft cap: 21 shots at a 150s target (budget
    // softMax = 20) must surface a craft warning, never a critical rejection.
    const script = sampleScript();
    const manyShots = Array.from({ length: 21 }, (_, index) => ({
      id: `S1-${index + 1}`,
      shotSize: index === 0 ? "远景" : "近景",
      camera: "固定后缓慢推进",
      durationSeconds: 7,
      visual: `雨水冲过第 ${index + 1} 根站柱。`,
      dialogue: index === 20 ? [{ speaker: "林夏", text: "你终于想起来了。" }] : [],
      sound: "雨声",
    }));
    const crowded = EpisodeScriptSchema.parse({
      ...script,
      estimatedDurationSeconds: 147,
      scenes: [{ ...script.scenes[0]!, shots: manyShots }],
    });

    const issues = auditEpisodeScript(crowded, undefined, 150);

    const shotIssue = issues.find((issue) => issue.category === "screenplay-shot-count");
    expect(shotIssue?.severity).toBe("warning");
    expect(shotIssue?.description).toContain("21");
    expect(issues.some(
      (issue) => issue.category === "screenplay-shot-count" && issue.severity === "critical",
    )).toBe(false);

    // At the soft budget boundary (20 shots) no warning fires.
    const atBudget = EpisodeScriptSchema.parse({
      ...script,
      estimatedDurationSeconds: 140,
      scenes: [{ ...script.scenes[0]!, shots: manyShots.slice(0, 20) }],
    });
    expect(auditEpisodeScript(atBudget, undefined, 150)
      .some((issue) => issue.category === "screenplay-shot-count")).toBe(false);
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
