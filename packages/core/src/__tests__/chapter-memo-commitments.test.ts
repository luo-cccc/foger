import { describe, expect, it } from "vitest";
import { validateChapterMemoCommitments } from "../utils/chapter-memo-commitments.js";

describe("validateChapterMemoCommitments", () => {
  it("raises a critical issue when the required end change is missing", () => {
    const issues = validateChapterMemoCommitments(
      [
        "## Required end-of-chapter change",
        "Mara holds the red ledger and Dax loses access to the archive.",
      ].join("\n"),
      "Mara waits outside and watches the lights.",
      "en",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "critical",
      category: "memo-end-change",
      repairScope: "structural",
    });
  });

  it("passes when the prose contains enough distinctive anchors", () => {
    const issues = validateChapterMemoCommitments(
      [
        "## Required end-of-chapter change",
        "Mara and Dax sign the pact.",
      ].join("\n"),
      "At the final checkpoint, Mara and Dax sign the pact before the gates close.",
      "en",
    );

    expect(issues).toEqual([]);
  });

  it("accepts action-level evidence for a paraphrased monitored relationship change", () => {
    const issues = validateChapterMemoCommitments(
      [
        "## 章尾必须发生的改变",
        "关系改变：林渡与保安之间建立‘被监视’的隐形关系（林渡察觉到保安在看他，但不确定）。",
      ].join("\n"),
      "电梯门合上前，林渡看见保安抬眼盯住他，又拨通电话低声说‘知道了’。他没有证据，只把背包抱得更紧。",
      "zh",
    );

    expect(issues).toEqual([]);
  });

  it("does not flag placeholders or generic dimension labels", () => {
    const issues = validateChapterMemoCommitments(
      [
        "## Required end-of-chapter change",
        "none",
        "Information change / relationship change / physical change / power change",
        "N/A",
      ].join("\n"),
      "The chapter ends with the protagonist leaving the station.",
      "en",
    );

    expect(issues).toEqual([]);
  });

  it("flags current-task and payoff commitments that never land", () => {
    const issues = validateChapterMemoCommitments(
      [
        "## Current task",
        "Mara steals the archive key from Dax.",
        "## To pay off / to keep buried",
        "Pay off: Mara opens the sealed red ledger.",
      ].join("\n"),
      "Mara watches the archive lights from across the river.",
      "en",
    );

    expect(issues.map((issue) => issue.category)).toEqual([
      "memo-current-task",
      "memo-payoff",
    ]);
    expect(issues.every((issue) => issue.severity === "critical")).toBe(true);
  });

  it("flags a forbidden action when the draft performs it", () => {
    const issues = validateChapterMemoCommitments(
      [
        "## 不要做",
        "- 不要让林澈在塔内遇到任何正面敌人或追兵——本章是探索取证，不是对抗。",
      ].join("\n"),
      "林澈进入塔内后，两名正面敌人带着追兵堵住楼梯，他被迫开枪还击。",
      "zh",
    );

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        category: "memo-禁止事项违规",
        repairScope: "structural",
      }),
    ]);
  });

  it("catches the real chapter-3 deferred H002 reveal regression", () => {
    const memo = [
      "## 该兑现的 / 暂不掀的",
      "- 暂不掀：H002（老莫是否为回声体）→ 本章只允许时间线间接印证，留到第4章与老莫对质。",
      "## 本章 hook 账",
      "defer:",
      "- H002 “老莫是否为回声体” → 本章不动，等到第4章与老莫对质时再推进",
    ].join("\n");
    const leakedDraft = "现在他手里有一份部分可读的回声体替代名单，十二个编号中一个直指老莫。";

    const issues = validateChapterMemoCommitments(memo, leakedDraft, "zh");

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        category: "memo-延后揭示越界",
        repairScope: "structural",
      }),
    ]);
    expect(issues[0]?.description).toContain("H002");
  });

  it("allows indirect suspicion for a deferred reveal", () => {
    const memo = [
      "## 本章 hook 账",
      "defer:",
      "- H002 “老莫是否为回声体” → 本章不动",
    ].join("\n");
    const draft = "老莫的出勤记录与替代时间线重合，但林澈仍无法确认他是否是回声体，只把疑点记下待验证。";

    expect(validateChapterMemoCommitments(memo, draft, "zh")).toEqual([]);
  });
});
