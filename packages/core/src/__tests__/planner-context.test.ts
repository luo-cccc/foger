import { describe, expect, it } from "vitest";

import {
  buildCurrentArcSnapshot,
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  extractRelevantThreads,
} from "../agents/planner-context.js";

// Real column layouts match the production truth-file schemas under story/.
// Keeping these literal samples in tests guards against the kind of
// off-by-one column bug that slipped past Phase 3 review.
const EMOTIONAL_ARCS_SAMPLE = `
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|-------------|----------|
| 周谨川 | 36 | 紧绷 | 门前对峙 | 8 | 升级 |
| 周谨川 | 37 | 克制发热 | 逼对方亮身份 | 9 | 升级 |
| 周谨川 | 38 | 骤亮后阴冷 | 看见顾明诚收 | 10 | 顶点 |
`;

const CHARACTER_MATRIX_SAMPLE = `
| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |
|------|----------|----------|----------|----------|------------|----------|----------|
| 周谨川 | 带伤守证者 | 起不来身却硬顶 | 短、硬 | 克制耐痛 | 主角本人 | 不让资料被收走 | 守现场 |
| 草帽男 | 止损执行节点 | 明对手却急坏 | 装熟翻脸 | 控场欲 | 敌对监视者 | 护住七号门 | 顶住门边 |
| 修锁老师傅 | 一线手艺证人 | 不抢话却硬护场 | 平、稳 | 老练 | 临时协力 | 看锁说锁 | 守住现场事实 |
`;

const SUBPLOT_BOARD_SAMPLE = `
| S001 | 三担保排查 | 主角 | ch1 | ch38 | 0 | 推进 | 核心旧账线 | 1章 |
| S007 | 货款线 | 主角 | ch3 | ch4 | 34 | 暂挂 | 冻结 | 4-6章 |
`;

describe("composeCurrentArcProse reads chapter from emotional_arcs column 1", () => {
  it("filters rows by chapter from column index 1 (章节), not column 0 (角色)", () => {
    // Previously the function filtered where row[0] matched /^\d+$/.
    // Since row[0] is "周谨川" here, the old predicate produced zero matches
    // and "近期情感线" fell out of the composed prose entirely.
    const prose = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      39,
    );
    expect(prose).toContain("近期情感线");
    expect(prose).toContain("紧绷");
    expect(prose).toContain("克制发热");
    expect(prose).toContain("骤亮后阴冷");
  });

  it("excludes rows at or beyond the current chapter", () => {
    const prose = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      37,
    );
    expect(prose).toContain("紧绷");
    expect(prose).not.toContain("克制发热");
    expect(prose).not.toContain("骤亮后阴冷");
  });

  it("still composes active subplots when emotional arcs are empty", () => {
    const prose = composeCurrentArcProse(SUBPLOT_BOARD_SAMPLE, "", 39);
    expect(prose).toContain("活跃支线");
    expect(prose).toContain("S001");
    expect(prose).not.toContain("S007");
  });

  it("returns the empty-state sentinel only when nothing is extractable", () => {
    const prose = composeCurrentArcProse("", "", 1);
    expect(prose).toContain("暂无 arc 数据");
  });
});

describe("buildCurrentArcSnapshot", () => {
  it("groups recent emotional trajectories by character and excludes future rows", () => {
    const arcs = `
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|-------------|----------|
| 周谨川 | 36 | 紧绷 | 门前对峙 | 8 | 升级 |
| 顾明诚 | 37 | 试探 | 递出旧票据 | 6 | 暗涌 |
| 周谨川 | 38 | 骤亮后阴冷 | 看见顾明诚收 | 10 | 顶点 |
| 顾明诚 | 40 | 坦白 | 交出账本 | 9 | 爆发 |
`;
    const snapshot = buildCurrentArcSnapshot(SUBPLOT_BOARD_SAMPLE, arcs, 39);

    expect(snapshot.emotionalTrajectories).toHaveLength(2);
    expect(snapshot.emotionalTrajectories[0]?.character).toBe("周谨川");
    expect(snapshot.emotionalTrajectories[0]?.entries.map((entry) => entry.state)).toEqual([
      "紧绷",
      "骤亮后阴冷",
    ]);
    expect(snapshot.emotionalTrajectories[1]?.character).toBe("顾明诚");
    expect(snapshot.emotionalTrajectories[1]?.entries.map((entry) => entry.state)).toEqual(["试探"]);
    expect(JSON.stringify(snapshot)).not.toContain("坦白");
  });

  it("derives stale subplot and high-intensity emotion as next planning focus", () => {
    const subplots = `
| subplot_id | 名称 | 负责人 | 起始 | 最近触达 | 沉默章数 | 状态 | 压力 |
|------------|------|--------|------|----------|----------|------|------|
| S001 | 三担保排查 | 主角 | ch1 | ch34 | 4 | 推进 | 核心旧账线 |
| S002 | 门卫证词 | 主角 | ch33 | ch38 | 0 | 推进 | 现场证据线 |
`;
    const snapshot = buildCurrentArcSnapshot(subplots, EMOTIONAL_ARCS_SAMPLE, 39);

    expect(snapshot.activeSubplots[0]).toMatchObject({
      id: "S001",
      name: "三担保排查",
      lastTouchChapter: 34,
      silenceChapters: 4,
    });
    expect(snapshot.pressureSummary.join("\n")).toContain("情绪压力最高点");
    expect(snapshot.pressureSummary.join("\n")).toContain("强度 10");
    expect(snapshot.nextPlanningFocus.join("\n")).toContain("S001");
    expect(snapshot.nextPlanningFocus.join("\n")).toContain("已沉默 4 章");
    expect(snapshot.nextPlanningFocus.join("\n")).toContain("周谨川");
  });

  it("uses the status column, not any cell, to decide subplot activity", () => {
    // Standard subplot_board.md layout: status is column index 6, 进度概述 is
    // index 7. S900's status column is a non-active state (已完结), but its
    // 进度概述 column contains an activity keyword (推进). It must NOT be
    // treated as active just because "推进" appears in a non-status cell.
    const subplots = `
| subplot_id | 名称 | 负责人 | 起始 | 最近触达 | 沉默章数 | 状态 | 进度概述 | 回收ETA |
|------------|------|--------|------|----------|----------|------|----------|---------|
| S100 | 活跃线 | 主角 | ch1 | ch34 | 4 | 推进 | 稳步推进中 | ch40 |
| S900 | 已收线 | 配角 | ch1 | ch20 | 18 | 已完结 | 曾经推进到高压后收束 | - |
`;
    const snapshot = buildCurrentArcSnapshot(subplots, EMOTIONAL_ARCS_SAMPLE, 39);
    const ids = snapshot.activeSubplots.map((s) => s.id);
    expect(ids).toContain("S100");
    expect(ids).not.toContain("S900");
  });

  it("renders a structured current arc prose block while preserving legacy section names", () => {
    const prose = composeCurrentArcProse(SUBPLOT_BOARD_SAMPLE, EMOTIONAL_ARCS_SAMPLE, 39);

    expect(prose).toContain("当前叙事压力");
    expect(prose).toContain("活跃支线");
    expect(prose).toContain("近期情感线");
    expect(prose).toContain("下一章规划焦点");
    expect(prose).toContain("S001");
    expect(prose).toContain("周谨川：ch36 紧绷");
  });
});

describe("extractProtagonistRow", () => {
  it("matches the real convention '主角本人', not only the exact token '主角'", () => {
    const row = extractProtagonistRow(CHARACTER_MATRIX_SAMPLE);
    expect(row).toContain("周谨川");
    expect(row).toContain("主角本人");
  });

  it("falls back to the first data row when no protagonist marker is found", () => {
    const noMarker = `
| 角色 | 核心标签 | 与主角关系 |
|------|----------|------------|
| 李沉 | 重生者 | — |
| 王一 | 对手 | 敌对 |
`;
    const row = extractProtagonistRow(noMarker);
    expect(row).toContain("李沉");
  });

  it("returns the sentinel only when the matrix has zero data rows", () => {
    const empty = `
| 角色 | 核心标签 |
|------|----------|
`;
    const row = extractProtagonistRow(empty);
    expect(row).toContain("未找到主角行");
  });
});

describe("extractOpponentRows / extractCollaboratorRows", () => {
  it("picks opponents by 与主角关系 semantic keywords", () => {
    const rows = extractOpponentRows(CHARACTER_MATRIX_SAMPLE, 3);
    expect(rows).toContain("草帽男");
    expect(rows).not.toContain("周谨川");
  });

  it("picks collaborators by 与主角关系 semantic keywords", () => {
    const rows = extractCollaboratorRows(CHARACTER_MATRIX_SAMPLE, 3);
    expect(rows).toContain("修锁老师傅");
    expect(rows).not.toContain("草帽男");
  });
});

describe("extractRelevantThreads", () => {
  it("selects active hooks and subplots, filtering dormant/stale", () => {
    const hooks = `
| hook_id | 状态 | 最近推进 |
|---------|------|----------|
| H001 | activating | ch38 |
| H002 | dormant | ch20 |
| H003 | partial_payoff | ch37 |
`;
    const subplots = `
| S001 | 主线追查 | 推进 |
| S007 | 旁线 | 暂挂 |
`;
    const threads = extractRelevantThreads(hooks, subplots);
    expect(threads).toContain("H001");
    expect(threads).toContain("H003");
    expect(threads).not.toContain("H002");
    expect(threads).toContain("S001");
    expect(threads).not.toContain("S007");
  });
});
