import { describe, expect, it } from "vitest";
import {
  buildFoundationScalePlan,
  normalizeFoundationVolumeContracts,
  renderFoundationScaleGuidance,
  validateFoundationVolumeScale,
} from "../utils/foundation-scale.js";

function episodeBeats(episodes: number): string[] {
  return [
    "### 紧凑篇逐集节拍合同",
    ...Array.from({ length: episodes }, (_, index) => (
      "第" + (index + 1) + "集：目标=推进动作" + (index + 1)
      + " | 阻碍=遭遇阻力" + (index + 1)
      + " | 转折=获得新信息" + (index + 1)
      + " | 交付=完成结果" + (index + 1)
      + " | 集末钩子=" + (index + 1 === episodes ? "终局后效闭环" : "因果启动第" + (index + 2) + "集")
    )),
  ];
}

describe("Episode foundation scale contract", () => {
  it("uses one complete story arc for a five-episode series", () => {
    const plan = buildFoundationScalePlan(5);
    expect(plan.volumeCount).toBe(1);
    expect(plan.ranges).toEqual([{ volume: 1, startEpisode: 1, endEpisode: 5 }]);

    const guidance = renderFoundationScaleGuidance(5, "zh");
    expect(guidance).toContain("第5集就是全剧终局");
    expect(guidance).toContain("## 第1篇《篇章名》（第1-5集）");
    expect(guidance).toContain("逐集节拍合同");
  });

  it("distributes a long series into contiguous ten-episode arcs", () => {
    const plan = buildFoundationScalePlan(85);
    expect(plan.volumeCount).toBe(9);
    expect(plan.ranges[0]).toEqual({ volume: 1, startEpisode: 1, endEpisode: 10 });
    expect(plan.ranges.at(-1)).toEqual({ volume: 9, startEpisode: 77, endEpisode: 85 });
  });

  it("renders a 100-episode series as ten story arcs", () => {
    const plan = buildFoundationScalePlan(100);
    expect(plan.volumeCount).toBe(10);
    const guidance = renderFoundationScaleGuidance(100, "zh");
    expect(guidance).toContain("第1篇：第1-10集");
    expect(guidance).toContain("第100集就是全剧终局");
    expect(guidance).not.toContain("第100章");
  });

  it("accepts an executable compact Episode contract", () => {
    const source = [
      "## 第1篇《磁带回声》（第1-5集）",
      "Objective: 林丙公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第5集公开证据并解决核心冲突。",
      "Irreversible Event: 林丙实名作证，永久失去匿名身份。",
      ...episodeBeats(5),
    ].join("\n");

    expect(validateFoundationVolumeScale(source, 5)).toEqual([]);
  });

  it("accepts model-formatted bullet lines in the compact Episode contract", () => {
    const source = [
      "## 第1篇《磁带回声》（第1-3集）",
      "Objective: 林丙公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第3集公开证据并解决核心冲突。",
      "Irreversible Event: 林丙实名作证，永久失去匿名身份。",
      "### 紧凑篇逐集节拍合同（共3集）",
      "- 第1集：目标=找到磁带 | 阻碍=封锁升级 | 转折=发现备份 | 交付=取得磁带 | 集末钩子=证人来电",
      "- 第2集：目标=保护证人 | 阻碍=追兵逼近 | 转折=证人改口 | 交付=保住证词 | 集末钩子=直播启动",
      "- 第3集：目标=公开证据 | 阻碍=信号切断 | 转折=启用备份 | 交付=完成公开 | 集末钩子=公开后的关系后效",
    ].join("\n");

    expect(validateFoundationVolumeScale(source, 3)).toEqual([]);
  });

  it("accepts a Markdown table for the compact Episode contract", () => {
    const source = [
      "## 第1篇《磁带回声》（第1-2集）",
      "Objective: 林丙公开完整证据链并终止清除行动。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 在第2集公开证据并解决核心冲突。",
      "Irreversible Event: 林丙实名作证，永久失去匿名身份。",
      "### 逐集节拍合同",
      "| 集数 | 目标 | 阻碍 | 转折 | 交付 | 集末钩子 |",
      "|---|---|---|---|---|---|",
      "| 1 | 找到磁带 | 封锁升级 | 发现备份 | 取得磁带 | 证人来电 |",
      "| 2 | 公开证据 | 信号切断 | 启用备份 | 完成公开 | 关系后效 |",
    ].join("\n");

    expect(validateFoundationVolumeScale(source, 2)).toEqual([]);
  });

  it("rejects an Episode contract that defers its core resolution", () => {
    const source = [
      "## 第1篇《磁带回声》（第1-5集）",
      "Objective: 林丙取得第一块核心线索。",
      "KR1: 找到原始磁带。",
      "KR2: 取得证人证词。",
      "KR3: 完整真相留待后续作品揭示。",
      "Irreversible Event: 林丙被列入观察名单。",
      ...episodeBeats(5),
    ].join("\n");

    expect(validateFoundationVolumeScale(source, 5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "compact-book-defers-resolution" }),
    ]));
  });

  it("normalizes single-arc prose into an Episode contract", () => {
    const normalized = normalizeFoundationVolumeContracts([
      "## 篇章主题",
      "第1篇《玻璃档案》覆盖第1-10集。",
      "## 篇章 OKR",
      "**本篇目标：** 林丙公开完整档案链并终止清除行动。",
      "1. **关键成果1：** 找到未被篡改的原始档案。",
      "2. **关键成果2：** 让关键证人公开指认证词。",
      "3. **关键成果3：** 在第10集公开证据并解决核心冲突。",
      "## 篇章终点",
      "**不可逆改变：** 林丙实名作证，永久失去匿名身份。",
      "### 紧凑篇逐集节拍合同",
      ...Array.from({ length: 10 }, (_, index) => (
        `第${index + 1}集：目标=推进档案公开 | 阻碍=清除行动升级 | 转折=证据链改变选择 | 交付=取得可见进展 | 集末钩子=${index === 9 ? "公开后的关系后效" : "下一步行动被启动"}`
      )),
    ].join("\n"), 10, "zh");

    expect(normalized).toContain("第1篇《玻璃档案》覆盖第1-10集");
    expect(normalized).toContain("找到未被篡改的原始档案");
    expect(normalized).toContain("林丙实名作证");
    expect(validateFoundationVolumeScale(normalized, 10)).toEqual([]);
  });
});
