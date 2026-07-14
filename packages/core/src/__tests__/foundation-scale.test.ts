import { describe, expect, it } from "vitest";
import {
  buildFoundationScalePlan,
  normalizeFoundationVolumeContracts,
  renderFoundationScaleGuidance,
  validateFoundationVolumeScale,
} from "../utils/foundation-scale.js";

describe("foundation scale contract", () => {
  it("treats a five-chapter book as one complete volume", () => {
    const plan = buildFoundationScalePlan(5);

    expect(plan.volumeCount).toBe(1);
    expect(plan.ranges).toEqual([
      { volume: 1, startChapter: 1, endChapter: 5 },
    ]);
    expect(renderFoundationScaleGuidance(5, "zh")).toContain("第5章就是全书终章");
    expect(renderFoundationScaleGuidance(5, "zh")).toContain("5段主体");
    expect(renderFoundationScaleGuidance(5, "zh")).toContain("## 第1卷《卷名》（第1-5章）");
    expect(renderFoundationScaleGuidance(5, "zh")).toContain("留待后续作品");
  });

  it("distributes longer books into explicit contiguous volume ranges", () => {
    const plan = buildFoundationScalePlan(85);

    expect(plan.volumeCount).toBe(3);
    expect(plan.ranges).toEqual([
      { volume: 1, startChapter: 1, endChapter: 29 },
      { volume: 2, startChapter: 30, endChapter: 57 },
      { volume: 3, startChapter: 58, endChapter: 85 },
    ]);
  });

  it("rejects a five-volume outline for a five-chapter complete work", () => {
    const issues = validateFoundationVolumeScale([
      "全书共5卷。",
      "第1卷建立录音谜团。",
      "第5卷才解决事故。",
    ].join("\n"), 5);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "volume-count-exceeds-plan" }),
    ]));
  });

  it("rejects chapter ranges beyond the configured book target", () => {
    const issues = validateFoundationVolumeScale("第1卷（第1-20章）", 5);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "chapter-range-exceeds-target" }),
    ]));
  });

  it("accepts an exact parseable compact-book volume contract", () => {
    const issues = validateFoundationVolumeScale([
      "## 第1卷《磁带回声》（第1-5章）",
      "Objective: 林澈公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第5章公开证据并解决核心冲突。",
      "Irreversible Event: 林澈实名作证，永久失去匿名身份。",
    ].join("\n"), 5);

    expect(issues).toEqual([]);
  });

  it("rejects prose that names the right volume count but cannot drive volume governance", () => {
    const issues = validateFoundationVolumeScale([
      "本书共1卷。",
      "第1卷围绕磁带展开，第1-5章完成。",
      "最后取得第一块线索。",
    ].join("\n"), 5);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "volume-contract-count-mismatch" }),
    ]));
  });

  it("rejects compact-book contracts that explicitly defer core resolution", () => {
    const issues = validateFoundationVolumeScale([
      "## 第1卷《磁带回声》（第1-5章）",
      "Objective: 林澈取得第一块核心线索。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 看见清除行动的冰山一角，完整真相留待后续作品揭示。",
      "Irreversible Event: 林澈被列入观察名单。",
    ].join("\n"), 5);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compact-book-defers-resolution" }),
    ]));
  });

  it("normalizes a compact global OKR section into a runtime volume contract", () => {
    const normalized = normalizeFoundationVolumeContracts([
      "## 段 1：各卷主题与情绪曲线",
      "第1卷《磁带回声》覆盖全书。",
      "## 段 3：各卷 OKR",
      "Objective（O1）：林澈公开证据并终止清除行动。",
      "- **KR1（第2章前）：** 找到原始磁带。",
      "- **KR2（第4章前）：** 取得证人证词。",
      "- **KR3（第5章）：** 公开证据并解决核心冲突。",
      "## 段 4：卷尾必须发生的改变",
      "第5章结束时必须发生以下改变：",
      "1. 林澈实名作证，永久失去匿名身份。",
    ].join("\n"), 5, "zh");

    expect(normalized).toContain("## 第1卷《磁带回声》（第1-5章）");
    expect(normalized).toContain("Irreversible Event: 林澈实名作证");
    expect(validateFoundationVolumeScale(normalized, 5)).toEqual([]);
  });
});
