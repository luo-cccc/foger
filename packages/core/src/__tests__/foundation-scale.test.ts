import { describe, expect, it } from "vitest";
import {
  buildFoundationScalePlan,
  normalizeFoundationVolumeContracts,
  renderFoundationScaleGuidance,
  validateFoundationVolumeScale,
} from "../utils/foundation-scale.js";

function compactBeats(chapters = 5): string[] {
  return [
    "### 紧凑篇逐章节拍合同",
    ...Array.from({ length: chapters }, (_, index) => (
      `第${index + 1}章：目标=推进动作${index + 1} | 阻碍=遭遇阻力${index + 1} | 转折=获得新信息${index + 1} | 交付=完成结果${index + 1} | 章末钩子=${index + 1 === chapters ? "终局后效闭环" : `因果启动第${index + 2}章`}`
    )),
  ];
}

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
    expect(renderFoundationScaleGuidance(5, "zh")).toContain("### 紧凑篇逐章节拍合同");
    expect(renderFoundationScaleGuidance(5, "zh")).toContain("第5章：目标=");
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
      ...compactBeats(),
    ].join("\n"), 5);

    expect(issues).toEqual([]);
  });

  it("accepts complete compact beat lines when only the section heading drifts", () => {
    const beats = compactBeats();
    beats[0] = "### 逐章节奏表";
    const issues = validateFoundationVolumeScale([
      "## 第1卷《磁带回声》（第1-5章）",
      "Objective: 林澈公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第5章公开证据并解决核心冲突。",
      "Irreversible Event: 林澈实名作证，永久失去匿名身份。",
      "第1章：林澈开始调查，但这行不是节拍合同。",
      ...beats,
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
      ...compactBeats(),
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
      ...compactBeats(),
    ].join("\n"), 5, "zh");

    expect(normalized).toContain("## 第1卷《磁带回声》（第1-5章）");
    expect(normalized).toContain("Irreversible Event: 林澈实名作证");
    expect(validateFoundationVolumeScale(normalized, 5)).toEqual([]);
  });

  it("normalizes bold Chinese single-volume prose contracts outside the compact range", () => {
    const normalized = normalizeFoundationVolumeContracts([
      "## 段 1：各卷主题与情绪曲线",
      "第1卷《玻璃档案》覆盖第1-20章，主角在追查中逐步失去安全位置。",
      "## 段 3：各卷 OKR",
      "**本卷目标：** 林澈公开完整档案链并终止清除行动。",
      "1. **关键成果1：** 找到未被篡改的原始档案。",
      "2. **关键成果2：** 让关键证人公开指认证词。",
      "3. **关键成果3：** 在第20章公开证据并解决核心冲突。",
      "## 段 4：卷尾必须发生的改变",
      "**卷尾改变：** 林澈实名作证，永久失去匿名身份。",
    ].join("\n"), 20, "zh");

    expect(normalized).toContain("## 第1卷《玻璃档案》（第1-20章）");
    expect(normalized).toContain("KR1: 找到未被篡改的原始档案。");
    expect(normalized).toContain("Irreversible Event: 林澈实名作证");
    expect(validateFoundationVolumeScale(normalized, 20)).toEqual([]);
  });

  it("rejects a compact volume contract without ordered chapter beats", () => {
    const issues = validateFoundationVolumeScale([
      "## 第1卷《磁带回声》（第1-5章）",
      "Objective: 林澈公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第5章公开证据并解决核心冲突。",
      "Irreversible Event: 林澈实名作证，永久失去匿名身份。",
    ].join("\n"), 5);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compact-beat-count-mismatch" }),
    ]));
  });

  it("rejects compact beat lines that retain a missing field placeholder", () => {
    const beats = compactBeats();
    beats[3] = "第3章：目标=推进动作3 | 阻碍=<具体阻力> | 转折=获得新信息3 | 交付=完成结果3 | 章末钩子=因果启动第4章";
    const issues = validateFoundationVolumeScale([
      "## 第1卷《磁带回声》（第1-5章）",
      "Objective: 林澈公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第5章公开证据并解决核心冲突。",
      "Irreversible Event: 林澈实名作证，永久失去匿名身份。",
      ...beats,
    ].join("\n"), 5);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compact-beat-fields-missing" }),
    ]));
  });
});
