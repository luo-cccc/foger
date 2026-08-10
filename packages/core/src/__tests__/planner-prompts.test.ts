import { describe, it, expect } from "vitest";
import {
  PLANNER_MEMO_SYSTEM_PROMPT_EN,
  PLANNER_MEMO_SYSTEM_PROMPT,
  PLANNER_MEMO_USER_TEMPLATE,
  buildPlannerUserMessage,
  buildGoldenOpeningGuidance,
  buildUpstreamRevisionFeedbackBlock,
} from "../agents/planner-prompts.js";

describe("PLANNER_MEMO_SYSTEM_PROMPT", () => {
  it("contains the episode contract and removes novel-only hard rules", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("不要 YAML frontmatter");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 本集目标");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 关联线索");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("不超过 50 字");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 当前任务");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 进入状态");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 因果升级");
    // P2-2 (STY-03): escalation must change a citable state dimension, not just wording
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("升级判据");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("筹码、知识、关系边界、退路、不可撤回的决定、威胁变现实");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("Escalation criterion");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("leverage, knowledge, relationship boundary, retreat options");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 当集兑现");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 出去压力");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 结尾交接状态");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 信息权限");
    // Episode v2 keeps the volume KR binding section: without it the planner
    // never binds episodes to volume key results and volume progress stays
    // permanently empty (observed in the paid 10-episode test run).
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 卷级 KR 绑定");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("## Volume KR binding");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("巧合只能把人物推进麻烦");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("按本集运动选择钩子类型");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("情绪只记录会改变下一步行为的情绪选择");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("Coincidence may push the protagonist INTO trouble");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("Pick the hook type from this episode's movement");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("emotional choice that changes the next behavior");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 不要做");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("open 只能记录真正独立的新问题");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("open contains only genuinely independent new questions");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("3～5 章");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("揭 1 埋 2");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("独立内心反应");
  });

  it("explains attempted volume KR movement without treating it as volume-end completion", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("局部结果");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("local dramatic result");
  });

  it("is not accidentally empty", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });
});

describe("PLANNER_MEMO_USER_TEMPLATE", () => {
  it("contains all placeholders", () => {
    const placeholders = [
      "{{episodeNumber}}",
      "{{previous_episode_ending_excerpt}}",
      "{{recent_summaries}}",
      "{{current_arc_prose}}",
      "{{protagonist_matrix_row}}",
      "{{opponent_rows}}",
      "{{collaborator_rows}}",
      "{{relevant_threads}}",
      "{{recyclable_hooks}}",
      "{{volume_contract_block}}",
      "{{isGoldenOpening}}",
      "{{book_rules_relevant}}",
    ];
    for (const ph of placeholders) {
      expect(PLANNER_MEMO_USER_TEMPLATE).toContain(ph);
    }
  });
});

describe("buildPlannerUserMessage", () => {
  it("fills placeholders in order", () => {
    const out = buildPlannerUserMessage({
      episodeNumber: 12,
      previousEpisodeEndingExcerpt: "上一屏结尾原文",
      recentSummaries: "| ch9 | ... |",
      currentArcProse: "主线推进七号门",
      protagonistMatrixRow: "| 阿泽 | 主角 | ... |",
      opponentRows: "| 老李 | 对手 | ... |",
      collaboratorRows: "| 小白 | 盟友 | ... |",
      relevantThreads: "- H03: 未解码信\n- S004: 七号门异常",
      recyclableHooks: "（暂无陈旧 hook——账本干净）",
      volumeContract: "# Volume Contract\n- objective: 锁定七号门\n- KR1: 拿到实证",
      isGoldenOpening: false,
      bookRulesRelevant: "- 禁止主角降智",
    });

    expect(out).toContain("# 第 12 集 memo 请求");
    expect(out).toContain("上一屏结尾原文");
    expect(out).toContain("| ch9 | ... |");
    expect(out).toContain("主线推进七号门");
    expect(out).toContain("| 阿泽 | 主角 | ... |");
    expect(out).toContain("| 老李 | 对手 | ... |");
    expect(out).toContain("| 小白 | 盟友 | ... |");
    expect(out).toContain("- H03: 未解码信");
    expect(out).toContain("是否开场前三集：否");
    expect(out).toContain("当前篇章合同");
    expect(out).toContain("KR1: 拿到实证");
    expect(out).toContain("- 禁止主角降智");
    expect(out).not.toContain("{{");
  });

  it("translates isGoldenOpening true to 是", () => {
    const out = buildPlannerUserMessage({
      episodeNumber: 1,
      previousEpisodeEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: true,
      bookRulesRelevant: "",
    });
    expect(out).toContain("是否开场前三集：是");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.5 — Golden Opening Guidance prose
// ---------------------------------------------------------------------------

describe("buildGoldenOpeningGuidance", () => {
  it("emits zh slot prose for episode 1 (confront core conflict)", () => {
    const out = buildGoldenOpeningGuidance(1, "zh");
    expect(out).toContain("开篇三集规划指引");
    expect(out).toContain("第 1 集");
    // Ch1 slot: throw protagonist into core conflict
    expect(out).toContain("核心冲突");
    expect(out).toContain("前 3-5 秒的可见异常");
    // Opening economy
    expect(out).toContain("场景 ≤ 3");
    expect(out).toContain("人物 ≤ 3");
    // Information layering
    expect(out).toContain("信息分层");
  });

  it("emits zh slot prose for episode 2 (demonstrate the edge)", () => {
    const out = buildGoldenOpeningGuidance(2, "zh");
    expect(out).toContain("第 2 集");
    expect(out).toContain("信息差");
    // Must demand a concrete event, not narration
    expect(out).toContain("具体行动");
  });

  it("emits zh slot prose for episode 3 (lock the short-term goal)", () => {
    const out = buildGoldenOpeningGuidance(3, "zh");
    expect(out).toContain("第 3 集");
    expect(out).toContain("短期目标");
    expect(out).toContain("可验证的短期目标");
  });

  it("emits en slot prose for episode 1 with all three slot descriptions", () => {
    const out = buildGoldenOpeningGuidance(1, "en");
    expect(out).toContain("Golden Opening Guidance");
    expect(out).toContain("Episode 1");
    expect(out).toContain("core conflict");
    expect(out).toContain("concrete event");
    expect(out).toContain("short-term goal");
  });

  it("returns empty string for ch>=4 in both languages", () => {
    expect(buildGoldenOpeningGuidance(4, "zh")).toBe("");
    expect(buildGoldenOpeningGuidance(5, "zh")).toBe("");
    expect(buildGoldenOpeningGuidance(4, "en")).toBe("");
    expect(buildGoldenOpeningGuidance(99, "en")).toBe("");
  });

  it("renders as cohesive prose, not a numbered or bulleted checklist", () => {
    const zh = buildGoldenOpeningGuidance(1, "zh");
    // Heading is allowed; body must not contain enumerated lines.
    expect(zh).not.toMatch(/^\s*1\.\s/m);
    expect(zh).not.toMatch(/^\s*-\s/m);
    expect(zh).not.toMatch(/^\s*\*\s/m);
  });

  it("buildPlannerUserMessage appends guidance for ch<=3 and omits it for ch>=4", () => {
    const base = {
      previousEpisodeEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: false,
      bookRulesRelevant: "",
    };

    const ch2 = buildPlannerUserMessage({ ...base, episodeNumber: 2 });
    expect(ch2).toContain("开篇三集规划指引");
    expect(ch2).toContain("第 2 集");

    const ch4 = buildPlannerUserMessage({ ...base, episodeNumber: 4 });
    expect(ch4).not.toContain("开篇三集规划指引");
  });
});

// ---------------------------------------------------------------------------
// P0-2 — upstream revision feedback block
// ---------------------------------------------------------------------------

describe("buildUpstreamRevisionFeedbackBlock", () => {
  const findings = [{
    category: "hook-state-contradiction",
    owner: "planner" as const,
    severity: "critical" as const,
    description: "Hook H003 已回收但账本仍标 deferred。",
    suggestion: "在 memo 中修正 Hook 账。",
  }];

  it("renders a zh block naming the owner, severity and required direction", () => {
    const out = buildUpstreamRevisionFeedbackBlock(findings, "zh");
    expect(out).toContain("上游修订要求");
    expect(out).toContain("待上游修订");
    expect(out).toContain("[critical]（planner）hook-state-contradiction");
    expect(out).toContain("修复方向：在 memo 中修正 Hook 账。");
    expect(out).toContain("不要把问题留给 Writer");
  });

  it("renders an en block with the same routing discipline", () => {
    const out = buildUpstreamRevisionFeedbackBlock(findings, "en");
    expect(out).toContain("Upstream revision requests");
    expect(out).toContain("requires-upstream-revision");
    expect(out).toContain("[critical] (planner) hook-state-contradiction");
    expect(out).toContain("required direction:");
    expect(out).not.toContain("上游修订要求");
  });

  it("returns empty for no findings and is injected into the planner user message", () => {
    expect(buildUpstreamRevisionFeedbackBlock([], "zh")).toBe("");

    const withFeedback = buildPlannerUserMessage({
      episodeNumber: 7,
      previousEpisodeEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: false,
      bookRulesRelevant: "",
      upstreamRevisionFeedback: buildUpstreamRevisionFeedbackBlock(findings, "zh"),
    });
    expect(withFeedback).toContain("上次审查的上游修订要求");
    expect(withFeedback).toContain("hook-state-contradiction");

    const without = buildPlannerUserMessage({
      episodeNumber: 7,
      previousEpisodeEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: false,
      bookRulesRelevant: "",
    });
    expect(without).not.toContain("上游修订要求");
  });
});
