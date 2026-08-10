import { describe, expect, it } from "vitest";
import { buildNarrativeDriveContract } from "../agents/narrative-drive-contract.js";
import { PLANNER_MEMO_SYSTEM_PROMPT, PLANNER_MEMO_SYSTEM_PROMPT_EN } from "../agents/planner-prompts.js";

describe("narrative drive contract", () => {
  it("coordinates the five factors without forcing a mechanical episode checklist", () => {
    const foundation = buildNarrativeDriveContract("foundation", "zh");
    const planner = buildNarrativeDriveContract("planner", "zh");
    const writer = buildNarrativeDriveContract("writer", "zh");
    const auditor = buildNarrativeDriveContract("auditor", "zh");

    expect(foundation).toContain("新颖设定 x 熟悉爽点 x 高压关系 x 因果反转 x 情绪钩子");
    expect(foundation).toContain("不是要求每集机械集齐五项");
    expect(planner).toContain("不是单集打卡");
    expect(planner).toContain("若翻面已在上一集发生，本集就写后果");
    expect(writer).toContain("不擅自增加新反转或新 Hook");
    expect(auditor).toContain("只按 episode memo");
    expect(auditor).toContain("不因没有新反转扣分");
  });

  it("ships the orchestration contract in both planner languages", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 叙事驱动编排");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("巧合、临时新增规则、角色降智");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("## Narrative Drive Orchestration");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("withheld viewpoint knowledge");
  });
});
