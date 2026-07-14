import { describe, expect, it } from "vitest";
import {
  compileChapterExecutionContract,
  renderChapterExecutionContract,
} from "../utils/chapter-execution-contract.js";

describe("chapter execution contract", () => {
  it("compiles the raw memo into a compact, stable downstream contract", () => {
    const memo = {
      chapter: 3,
      goal: "锁定十三号塔的短期调查目标",
      isGoldenOpening: false,
      body: [
        "## 当前任务",
        "林澈进入十三号塔寻找物理证据。",
        "## 该兑现的 / 暂不掀的",
        "- 该兑现：H001（广播来源）→ 确认广播由十三号塔发出",
        "- 暂不掀：H002（老莫是否为回声体）→ 留到第4章",
        "## 章尾必须发生的改变",
        "- 林澈拿到发射记录并锁定下一步目标。",
        "## 本章 hook 账",
        "advance:",
        "- H001 “广播来源” → 确认塔内发射痕迹",
        "defer:",
        "- H002 “老莫是否为回声体” → 本章不动",
        "## 卷级 KR 绑定",
        "- V1-KR1 → 从信号溯源推进到名单破解",
        "## 不要做",
        "- 不要揭示完整名单。",
      ].join("\n"),
      threadRefs: ["H001", "H002"],
      volumeKrRefs: ["V1-KR1"],
      volumeKrRationale: "推进名单破解",
    };

    const first = compileChapterExecutionContract(memo);
    const second = compileChapterExecutionContract(memo);
    const rendered = renderChapterExecutionContract(first, "zh");

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.mustLand.map((item) => item.kind)).toEqual([
      "current-task",
      "payoff",
      "end-change",
    ]);
    expect(first.mustAvoid.map((item) => item.kind)).toEqual([
      "keep-buried",
      "do-not",
    ]);
    expect(first.hookActions).toEqual([
      expect.objectContaining({ hookId: "H001", action: "advance" }),
    ]);
    expect(first.deferredHooks).toEqual([
      expect.objectContaining({ hookId: "H002" }),
    ]);
    expect(rendered).toContain(first.fingerprint);
    expect(rendered).toContain("V1-KR1 → 从信号溯源推进到名单破解");
    expect(rendered).not.toContain("## 读者此刻在等什么");
  });
});
