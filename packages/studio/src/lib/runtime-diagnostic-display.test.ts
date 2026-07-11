import { describe, expect, it } from "vitest";
import { setAppLanguage } from "./app-language";
import { buildRuntimeDiagnosticViewModel } from "./runtime-diagnostic-display";

describe("buildRuntimeDiagnosticViewModel", () => {
  it("summarizes chapter claim working sets", () => {
    setAppLanguage("zh");

    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.claims.json",
      JSON.stringify({
        chapterNumber: 7,
        usable: [{ id: "C1", content: "灵脉需要代价" }],
        revealNow: [{ id: "C2", content: "师父真实身份暴露" }],
        mustHide: [{ id: "C3", content: "王城正在内斗" }],
        noGeneralize: [{
          id: "C4",
          content: "主角可越阶读取阵纹",
          constraints: { forbiddenUses: ["配角复制", "组织量产"] },
        }],
        costRequired: [{
          id: "C5",
          content: "强开灵脉",
          constraints: { requiresCost: ["寿元折损"] },
        }],
        conflictResolve: [{
          claim: {
            id: "C6",
            content: "禁术与祖训冲突",
            relations: { conflictsWith: ["C7"] },
          },
          resolvesBy: "先保命后补偿",
        }],
      }),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "章节", value: "7" }),
      expect.objectContaining({ label: "本章揭示", value: "1" }),
      expect.objectContaining({ label: "必须隐藏", value: "1" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "本章计划揭示", items: ["[C2] 师父真实身份暴露"] }),
      expect.objectContaining({ title: "使用需付代价", items: ["[C5] 强开灵脉 · 代价: 寿元折损"] }),
    ]));
  });

  it("summarizes chapter claim brief markdown", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.claim-brief.md",
      [
        "# 本章设定工作集 — 第 7 章",
        "",
        "视角：林澈",
        "",
        "## 本章可用设定（writer 可渲染）",
        "- [C1] 灵脉需要代价",
        "",
        "## 本章计划揭示（允许转为前台信息）",
        "- [C2] 师父真实身份暴露",
        "",
        "## 本章必须隐藏（不得泄露）",
        "- [C3] 王城正在内斗",
        "",
        "## 不可泛化（主角例外不得给配角/组织/反派）",
        "- [C4] 主角可越阶读取阵纹 禁止：配角复制、组织量产",
        "",
        "## 使用需付出代价",
        "- [C5] 强开灵脉 代价：寿元折损",
        "",
        "## 冲突解析",
        "- [C6] 与 C7 冲突 → 解析：先保命后补偿",
      ].join("\n"),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "章节", value: "7" }),
      expect.objectContaining({ label: "视角", value: "林澈" }),
      expect.objectContaining({ label: "计划揭示", value: "1" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "本章计划揭示", items: ["[C2] 师父真实身份暴露"] }),
      expect.objectContaining({ title: "冲突解析", items: ["[C6] 与 C7 冲突 → 解析：先保命后补偿"] }),
    ]));
  });

  it("summarizes chapter intent markdown", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.intent.md",
      [
        "# Chapter Intent",
        "",
        "## Goal",
        "让师徒债务公开上桌",
        "",
        "## Outline Node",
        "师父逼主角在城门前做选择",
        "",
        "## Arc Context",
        "卷中段，债务线进入不可回避阶段",
        "",
        "## Must Keep",
        "- 债务压力不能消失",
        "",
        "## Must Avoid",
        "- 不要把主角写成轻易原谅",
        "",
        "## Style Emphasis",
        "- 选择必须落成动作",
        "",
        "## Chapter Memo",
        "- isGoldenOpening: false",
        "",
        "### Thread Refs",
        "- H001",
        "- S002",
        "",
        "### Volume KR Binding",
        "- V1-KR2",
        "",
        "### Body",
        "本章必须让债务从暗线进入明面。",
      ].join("\n"),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "目标", value: "让师徒债务公开上桌" }),
      expect.objectContaining({ label: "关联线索", value: "2" }),
      expect.objectContaining({ label: "卷级绑定", value: "1" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "章节目标", items: ["让师徒债务公开上桌"] }),
      expect.objectContaining({ title: "卷级 KR 绑定", items: ["V1-KR2"] }),
    ]));
  });

  it("summarizes persisted plan markdown", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.plan.md",
      [
        "# Chapter 7 Plan",
        "",
        "## Metadata",
        "Chapter: 7",
        "Golden Opening: no",
        "",
        "<!-- INKOS_PLAN_MEMO_START -->",
        "# 第 7 章 memo",
        "",
        "## 本章目标",
        "让债务进入明面",
        "",
        "## 关联线索",
        "- H001",
        "",
        "<!-- INKOS_PLAN_MEMO_END -->",
        "",
        "## Intent",
        "Intent Goal: 让债务进入明面",
        "Outline Node: 城门前摊牌",
        "Arc Context: 中段升级",
        "",
        "### Must Keep",
        "- 债务压力",
        "",
        "### Must Avoid",
        "- 轻易和解",
        "",
        "### Style Emphasis",
        "- 动作推进",
        "",
        "## Planner Inputs",
        "- story/runtime/chapter-0007.intent.md",
        "- story/runtime/volume-progress.json",
      ].join("\n"),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "章节", value: "7" }),
      expect.objectContaining({ label: "规划输入", value: "2" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "章节目标", items: ["让债务进入明面"] }),
      expect.objectContaining({ title: "规划输入", items: ["runtime/chapter-0007.intent.md", "runtime/volume-progress.json"] }),
    ]));
  });

  it("summarizes volume contract bundles", () => {
    setAppLanguage("en");

    const model = buildRuntimeDiagnosticViewModel(
      "runtime/volume-contracts.json",
      JSON.stringify({
        contracts: [{
          volumeId: "volume-001",
          volumeNumber: 1,
          title: "Mentor Debt",
          objective: "Make the mentor's bargain unavoidable",
          irreversibleEvent: "The seal is broken",
          keyResults: [
            { id: "V1-KR1", text: "Expose the debt" },
            { id: "V1-KR2", text: "Force the apprentice to choose" },
          ],
          worldRuleReleases: ["Soul marks cannot be hidden"],
        }],
      }),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Contracts", value: "1" }),
      expect.objectContaining({ label: "Key Results", value: "2" }),
    ]));
    expect(model?.sections[0]).toEqual(expect.objectContaining({
      title: "Volume 1 · Mentor Debt",
      items: expect.arrayContaining([
        "Objective: Make the mentor's bargain unavoidable",
        "Irreversible Event: The seal is broken",
        "V1-KR1 Expose the debt",
      ]),
    }));

    setAppLanguage("zh");
  });

  it("summarizes volume progress logs", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/volume-progress.json",
      JSON.stringify({
        entries: [
          {
            chapter: 4,
            volumeId: "volume-001",
            volumeNumber: 1,
            krRefs: ["V1-KR1"],
            visibleKrRefs: ["V1-KR1"],
            memoGoal: "让交易上桌",
          },
          {
            chapter: 5,
            volumeId: "volume-001",
            volumeNumber: 1,
            krRefs: ["V1-KR2"],
            attemptedKrRefs: ["V1-KR2"],
            rationale: "先试探，再摊牌",
          },
        ],
      }),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "进度记录", value: "2" }),
      expect.objectContaining({ label: "最新章节", value: "5" }),
    ]));
    expect(model?.sections[0]).toEqual(expect.objectContaining({
      title: "最近进度",
      items: expect.arrayContaining([
        expect.stringContaining("第5章"),
        expect.stringContaining("第4章"),
      ]),
    }));
  });

  it("summarizes volume dashboard markdown", () => {
    setAppLanguage("en");

    const model = buildRuntimeDiagnosticViewModel(
      "runtime/volume-dashboard.md",
      [
        "# Volume Dashboard",
        "",
        "- source: story/outline/volume_map.md",
        "- generatedAt: 2026-07-08T10:00:00.000Z",
        "",
        "## volume-001 Mentor Debt",
        "",
        "- chapters: 1-20",
        "- objective: Make the mentor's bargain unavoidable",
        "- irreversibleEvent: The seal is broken",
        "- protagonistStageGoal: The apprentice accepts the cost",
        "- progressEntries: 3",
        "",
        "### Volume supply",
        "- worldRuleReleases: Soul marks cannot be hidden",
        "- relationshipTensions: Trust turns conditional",
        "",
        "| KR | status | plannedChapters | visibleChapters | attemptedChapters | text |",
        "| --- | --- | --- | --- | --- | --- |",
        "| V1-KR1 | advanced | ch4 | ch4 | - | Expose the debt |",
        "| V1-KR2 | pending | ch5 | - | - | Force the apprentice to choose |",
        "",
        "### Recent entries",
        "- ch5: planned=V1-KR2 visible=- attempted=- | put the bargain on the table",
        "- ch4: planned=V1-KR1 visible=V1-KR1 attempted=- | expose the debt",
      ].join("\n"),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Volume Panels", value: "1" }),
      expect.objectContaining({ label: "Key Results", value: "2" }),
      expect.objectContaining({ label: "Advanced KR", value: "1" }),
    ]));
    expect(model?.sections[0]).toEqual(expect.objectContaining({
      title: "volume-001 Mentor Debt",
      items: expect.arrayContaining([
        "Objective: Make the mentor's bargain unavoidable",
        "KR Status: done 0 / advanced 1 / attempted 0 / pending 1",
        "V1-KR1 [advanced] Expose the debt",
      ]),
    }));

    setAppLanguage("zh");
  });

  it("summarizes governed context package json", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.context.json",
      JSON.stringify({
        chapter: 7,
        selectedContext: [
          {
            source: "runtime/chapter_memo",
            reason: "Bind the memo",
            excerpt: "goal: let the debt surface",
          },
          {
            source: "story/outline/story_frame.md#conflict",
            reason: "Keep the core conflict visible",
            excerpt: "Debt is the moral center",
          },
          {
            source: "story/pending_hooks.md#H001",
            reason: "Carry the live hook",
            excerpt: "Mentor debt remains unpaid",
          },
        ],
      }),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "上下文条目", value: "3" }),
      expect.objectContaining({ label: "运行时来源", value: "1" }),
      expect.objectContaining({ label: "故事来源", value: "2" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "运行时上下文", items: expect.arrayContaining([expect.stringContaining("runtime/chapter_memo")]) }),
    ]));
  });

  it("summarizes chapter rule stack yaml", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.rule-stack.yaml",
      [
        "layers:",
        "  - id: L1",
        "    name: hard_facts",
        "    precedence: 100",
        "    scope: global",
        "  - id: L4",
        "    name: current_task",
        "    precedence: 70",
        "    scope: local",
        "sections:",
        "  hard:",
        "    - story_frame",
        "    - current_state",
        "  soft:",
        "    - author_intent",
        "    - current_focus",
        "  diagnostic:",
        "    - anti_ai_checks",
        "overrideEdges:",
        "  - from: L4",
        "    to: L3",
        "    allowed: true",
        "    scope: current_chapter",
        "activeOverrides:",
        "  - from: L4",
        "    to: L3",
        "    target: chapter:7/mustAvoid",
        "    reason: 不要让主角轻易原谅",
      ].join("\n"),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "规则层", value: "2" }),
      expect.objectContaining({ label: "硬规则", value: "2" }),
      expect.objectContaining({ label: "激活覆盖", value: "1" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "规则层级", items: expect.arrayContaining(["L1 · hard_facts · p100 · global"]) }),
      expect.objectContaining({ title: "当前激活覆盖", items: expect.arrayContaining([expect.stringContaining("chapter:7/mustAvoid")]) }),
    ]));
  });

  it("summarizes chapter trace json", () => {
    setAppLanguage("en");

    const model = buildRuntimeDiagnosticViewModel(
      "runtime/chapter-0007.trace.json",
      JSON.stringify({
        chapter: 7,
        plannerInputs: ["story/runtime/chapter-0007.intent.md"],
        composerInputs: ["story/runtime/volume-progress.json", "story/runtime/chapter-0007.claim-brief.md"],
        selectedSources: ["runtime/chapter_memo", "runtime/volume_contract", "story/current_focus.md"],
        contextTiers: {
          protectedSources: ["runtime/chapter_memo", "runtime/volume_contract"],
          compressibleSources: ["story/current_focus.md"],
        },
        tokenBudget: {
          protectedTokens: 300,
          compressibleTokens: 120,
          totalSelectedTokens: 420,
        },
        compression: {
          compiledSource: "runtime/compiled-compressible-context",
          protectedSources: ["runtime/chapter_memo"],
          compressedSources: ["story/current_focus.md"],
          budgetTokens: 128,
        },
        notes: ["claim-validator:warning:late-secret"],
      }),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Chapter", value: "7" }),
      expect.objectContaining({ label: "Selected Tokens", value: "420" }),
      expect.objectContaining({ label: "Protected Sources", value: "2" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Composer Inputs", items: ["runtime/volume-progress.json", "runtime/chapter-0007.claim-brief.md"] }),
      expect.objectContaining({ title: "Compression", items: expect.arrayContaining([expect.stringContaining("Compiled Source")]) }),
    ]));

    setAppLanguage("zh");
  });

  it("parses current arc markdown into sections", () => {
    const model = buildRuntimeDiagnosticViewModel(
      "runtime/tier2_current_arc.md",
      [
        "# Tier2 Current Arc",
        "",
        "- updated_for_chapter: 9",
        "- source: subplot_board.md + emotional_arcs.md",
        "",
        "当前叙事压力：",
        "- 支线压力集中在 S1「债务」",
        "",
        "活跃支线：",
        "- S1「债务」：状态=高压；最近触达=ch8",
        "",
        "近期情感线：",
        "- 林澈：ch8 愧疚",
        "",
        "下一章规划焦点：",
        "- 让债务变成公开选择",
      ].join("\n"),
    );

    expect(model?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "更新到章节", value: "9" }),
      expect.objectContaining({ label: "活跃支线", value: "1" }),
      expect.objectContaining({ label: "下章焦点", value: "1" }),
    ]));
    expect(model?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "当前叙事压力", items: ["支线压力集中在 S1「债务」"] }),
      expect.objectContaining({ title: "下一章规划焦点", items: ["让债务变成公开选择"] }),
    ]));
  });

  it("returns null for malformed runtime json", () => {
    const model = buildRuntimeDiagnosticViewModel("runtime/volume-progress.json", "{oops");
    expect(model).toBeNull();
  });
});
