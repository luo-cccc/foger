import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as memoryRetrieval from "../utils/memory-retrieval.js";
import { retrieveMemorySelection } from "../utils/memory-retrieval.js";
import { MemoryDB } from "../state/memory-db.js";

const require = createRequire(import.meta.url);
const hasNodeSqlite = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();
const sqliteIt = hasNodeSqlite ? it : it.skip;

describe("retrieveMemorySelection", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
    vi.resetModules();
    vi.doUnmock("../state/memory-db.js");
  });

  it("indexes current state facts into sqlite-backed memory selection", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "# Current State",
          "",
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 9 |",
          "| Current Location | Ashen ferry crossing |",
          "| Protagonist State | Lin Yue hides the broken oath token and the old wound has reopened. |",
          "| Current Goal | Find the vanished mentor before the guild covers its tracks. |",
          "| Current Conflict | Mentor debt with the vanished teacher blocks every choice. |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 10,
      goal: "Bring the focus back to the vanished mentor conflict.",
      mustKeep: ["Lin Yue hides the broken oath token and the old wound has reopened."],
    });

    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "Current Conflict",
          object: "Mentor debt with the vanished teacher blocks every choice.",
          validFromEpisode: 9,
          sourceEpisode: 9,
        }),
      ]),
    );
    if (hasNodeSqlite) {
      expect(result.dbPath).toContain("memory.db");
    } else {
      expect(result.dbPath).toBeUndefined();
    }
  });

  it("does not treat unpromoted hook seeds as active debt", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-hook-seeds-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | promoted | notes |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          "| H-live | 3 | 主线 | open | 8 | 第12章公开账册 | 近期 | 无 | 第一卷 | 是 | 10 | 是 | 已经被读者看见的账册债务 |",
          "| H-seed | 4 | 小承诺 | open | 0 | 第16章回收 | 中程 | 无 | 第一卷 | 否 | 10 | 否 | 架构阶段预埋、尚未进入读者追踪的种子 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 18,
      goal: "继续处理账册债务。",
      outlineNode: "推进主线账册。",
    });

    expect(result.activeHooks.map((hook) => hook.hookId)).toEqual(["H-live"]);
    expect(result.recyclableHooks.map((hook) => hook.hookId)).toEqual(["H-live"]);
    expect(result.hooks.map((hook) => hook.hookId)).not.toContain("H-seed");
  });

  it("extracts mentor-focused query terms without pulling guild-route negatives into English retrieval", () => {
    const extractQueryTerms = (memoryRetrieval as Record<string, unknown>).extractQueryTerms as
      | ((goal: string, outlineNode: string | undefined, mustKeep: ReadonlyArray<string>) => ReadonlyArray<string>)
      | undefined;

    expect(extractQueryTerms).toBeDefined();
    const terms = extractQueryTerms?.(
      "Pull focus back to the mentor debt and do not open a new frontier in this episode.",
      "Handle guild noise without letting the guild route overtake the mentor-debt mainline.",
      ["Lin Yue does not abandon the mentor debt."],
    ) ?? [];

    expect(terms).toContain("mentor");
    expect(terms).toContain("debt");
    expect(terms).not.toContain("guild");
    expect(terms).not.toContain("route");
  });

  it("extracts 师债-focused query terms without pulling 商会路线 negatives into Chinese retrieval", () => {
    const extractQueryTerms = (memoryRetrieval as Record<string, unknown>).extractQueryTerms as
      | ((goal: string, outlineNode: string | undefined, mustKeep: ReadonlyArray<string>) => ReadonlyArray<string>)
      | undefined;

    expect(extractQueryTerms).toBeDefined();
    const terms = extractQueryTerms?.(
      "第51章把注意力拉回师债，不让商会路线盖过主线。",
      "处理商会噪音，但不允许商会路线盖过师债主线。",
      ["林月不会放弃师债。"],
    ) ?? [];

    expect(terms).toContain("师债");
    expect(terms).not.toContain("商会");
    expect(terms).not.toContain("商会路线");
  });

  it("prefers the mentor-debt recap episode over nearby guild-noise episodes in English retrieval", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-en-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 10 |",
          "| Current Goal | Continue tracing the mentor debt |",
          "| Current Conflict | Mentor debt mainline vs guild safe route |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 10 | 16 | The mentor debt remains unresolved |",
          "| guild-route | 1 | mystery | open | 9 | 12 | The guild keeps offering a safer road |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 6 | Guild Pressure 6 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 7 | Guild Pressure 7 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 8 | Guild Pressure 8 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 9 | Guild Pressure 9 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 10 | Mentor Debt Echo 10 | Lin Yue | Lin Yue returns to the mentor debt trail and checks the oath token again | Commitment to the mentor debt hardens | mentor-debt advanced | tense | mainline |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 11,
      goal: "Pull focus back to the mentor debt and do not let the guild route overtake the mainline.",
      outlineNode: "Handle guild noise without letting the guild route overtake the mentor-debt mainline.",
      mustKeep: ["Lin Yue does not abandon the mentor debt."],
    });

    expect(result.summaries.map((summary) => summary.episode)).toContain(10);
  });

  it("prefers the explicit 师债回响 episode over nearby 商会噪音 episodes in Chinese retrieval", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-zh-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| 字段 | 值 |",
          "| --- | --- |",
          "| 当前章节 | 50 |",
          "| 当前目标 | 继续追查师债 |",
          "| 当前冲突 | 师债主线 vs 商会安全路线 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 50 | 60 | 师债真相与誓令碎片持续绑定 |",
          "| guild-route | 1 | mystery | open | 49 | 55 | 商会安全路线仍在诱导主角偏航 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 46 | 商会余波46 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 47 | 商会余波47 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 48 | 商会余波48 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 49 | 商会余波49 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 50 | 师债回响50 | 林月 | 林月再次追查师债线索，并核对誓令碎片痕迹 | 对师债真相的执念更强 | mentor-debt 推进 | 紧绷 | 主线推进 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 51,
      goal: "第51章把注意力拉回师债，不让商会路线盖过主线。",
      outlineNode: "处理商会噪音，但不允许商会路线盖过师债主线。",
      mustKeep: ["林月不会放弃师债。"],
    });

    expect(result.summaries.map((summary) => summary.episode)).toContain(50);
  });

  it("keeps the mentor-debt recap episode in markdown fallback mode for English books", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-en-fallback-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 10 |",
          "| Current Goal | Continue tracing the mentor debt |",
          "| Current Conflict | Mentor debt mainline vs guild safe route |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 10 | 16 | The mentor debt remains unresolved |",
          "| guild-route | 1 | mystery | open | 9 | 12 | The guild keeps offering a safer road |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 6 | Guild Pressure 6 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 7 | Guild Pressure 7 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 8 | Guild Pressure 8 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 9 | Guild Pressure 9 | Lin Yue | Guild pressure keeps building around the safe route | Guild route remains noisy | guild-route probed | restrained | holding-pattern |",
          "| 10 | Mentor Debt Echo 10 | Lin Yue | Lin Yue returns to the mentor debt trail and checks the oath token again | Commitment to the mentor debt hardens | mentor-debt advanced | tense | mainline |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    vi.resetModules();
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: class {
        constructor() {
          throw new Error("sqlite unavailable");
        }
      },
    }));
    const { retrieveMemorySelection: retrieveFallback } = await import("../utils/memory-retrieval.js");

    const result = await retrieveFallback({
      bookDir,
      episodeNumber: 11,
      goal: "Pull focus back to the mentor debt and do not let the guild route overtake the mainline.",
      outlineNode: "Handle guild noise without letting the guild route overtake the mentor-debt mainline.",
      mustKeep: ["Lin Yue does not abandon the mentor debt."],
    });

    expect(result.dbPath).toBeUndefined();
    expect(result.summaries.map((summary) => summary.episode)).toContain(10);
    expect(result.summaries.at(-1)?.episode).toBe(10);
  });

  it("keeps the 师债回响 episode in markdown fallback mode for Chinese books", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-zh-fallback-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| 字段 | 值 |",
          "| --- | --- |",
          "| 当前章节 | 50 |",
          "| 当前目标 | 继续追查师债 |",
          "| 当前冲突 | 师债主线 vs 商会安全路线 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 50 | 60 | 师债真相与誓令碎片持续绑定 |",
          "| guild-route | 1 | mystery | open | 49 | 55 | 商会安全路线仍在诱导主角偏航 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 46 | 商会余波46 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 47 | 商会余波47 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 48 | 商会余波48 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 49 | 商会余波49 | 林月 | 林月处理商会杂务与路引试探 | 继续压住商会支线 | guild-route 试探 | 克制 | 过渡牵制 |",
          "| 50 | 师债回响50 | 林月 | 林月再次追查师债线索，并核对誓令碎片痕迹 | 对师债真相的执念更强 | mentor-debt 推进 | 紧绷 | 主线推进 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    vi.resetModules();
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: class {
        constructor() {
          throw new Error("sqlite unavailable");
        }
      },
    }));
    const { retrieveMemorySelection: retrieveFallback } = await import("../utils/memory-retrieval.js");

    const result = await retrieveFallback({
      bookDir,
      episodeNumber: 51,
      goal: "第51章把注意力拉回师债，不让商会路线盖过主线。",
      outlineNode: "处理商会噪音，但不允许商会路线盖过师债主线。",
      mustKeep: ["林月不会放弃师债。"],
    });

    expect(result.dbPath).toBeUndefined();
    expect(result.summaries.map((summary) => summary.episode)).toContain(50);
    expect(result.summaries.at(-1)?.episode).toBe(50);
  });

  sqliteIt("uses existing sqlite summaries and hooks without requiring markdown truth files", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-db-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await writeFile(
      join(storyDir, "current_state.md"),
      [
        "| Field | Value |",
        "| --- | --- |",
        "| Current Episode | 9 |",
        "| Current Conflict | Mentor debt mainline vs guild safe route |",
        "",
      ].join("\n"),
      "utf-8",
    );

    const memoryDb = new MemoryDB(bookDir);
    try {
      memoryDb.upsertSummary({
        episode: 9,
        title: "Mentor Debt Echo",
        characters: "Lin Yue",
        events: "Lin Yue returns to the mentor debt trail",
        stateChanges: "Commitment hardens",
        hookActivity: "mentor-debt advanced",
        mood: "tense",
        episodeType: "mainline",
      });
      memoryDb.upsertHook({
        hookId: "mentor-debt",
        startEpisode: 1,
        type: "relationship",
        status: "open",
        lastAdvancedEpisode: 9,
        expectedPayoff: "16",
        notes: "Mentor debt remains unresolved",
      });
    } finally {
      memoryDb.close();
    }

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 10,
      goal: "Pull focus back to the mentor debt.",
      mustKeep: ["Lin Yue does not abandon the mentor debt."],
    });

    expect(result.dbPath).toContain("memory.db");
    expect(result.summaries.map((summary) => summary.episode)).toContain(9);
    expect(result.hooks.map((hook) => hook.hookId)).toContain("mentor-debt");
  });

  sqliteIt("backfills sqlite memory from structured state instead of stale markdown truth files", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-db-structured-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 9 |",
          "| Current Conflict | Old markdown conflict |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| markdown-hook | 1 | mystery | open | 9 | 12 | Old markdown hook |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 9 | Markdown Summary | Lin Yue | Old markdown events | Old markdown state | markdown-hook advanced | tense | fallback |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 12,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "current_state.json"),
        JSON.stringify({
          episode: 12,
          facts: [
            {
              subject: "protagonist",
              predicate: "Current Conflict",
              object: "Structured conflict should win.",
              validFromEpisode: 12,
              validUntilEpisode: null,
              sourceEpisode: 12,
            },
          ],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              hookId: "structured-hook",
              startEpisode: 10,
              type: "relationship",
              status: "progressing",
              lastAdvancedEpisode: 12,
              expectedPayoff: "Structured payoff",
              notes: "Structured hook should win.",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "episode_summaries.json"),
        JSON.stringify({
          rows: [
            {
              episodeNumber: 12,
              title: "Structured Summary",
              characters: "Lin Yue",
              events: "Structured events should win.",
              stateChanges: "Structured state should win.",
              hookActivity: "structured-hook advanced",
              mood: "tight",
              episodeType: "mainline",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 13,
      goal: "Bring the focus back to the structured hook.",
      mustKeep: ["Structured conflict should win."],
    });

    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: "Structured conflict should win.",
          sourceEpisode: 12,
        }),
      ]),
    );
    expect(result.hooks.map((hook) => hook.hookId)).toContain("structured-hook");
    expect(result.hooks.map((hook) => hook.hookId)).not.toContain("markdown-hook");
    expect(result.summaries.map((summary) => summary.episode)).toContain(12);
    expect(result.summaries.map((summary) => summary.title)).toContain("Structured Summary");
  });

  it("bootstraps structured runtime state from legacy markdown truth files during retrieval", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-bootstrap-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 12 |",
          "| Current Conflict | Mentor debt mainline vs guild safe route |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| mentor-debt | 1 | relationship | open | 12 | 16 | The mentor debt remains unresolved |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 12 | Mentor Debt Echo | Lin Yue | Lin Yue returns to the mentor debt trail | Commitment hardens | mentor-debt advanced | tense | mainline |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 13,
      goal: "Pull focus back to the mentor debt.",
      mustKeep: ["Lin Yue does not abandon the mentor debt."],
    });

    const manifest = JSON.parse(await readFile(join(stateDir, "manifest.json"), "utf-8"));
    const currentState = JSON.parse(await readFile(join(stateDir, "current_state.json"), "utf-8"));
    const hooks = JSON.parse(await readFile(join(stateDir, "hooks.json"), "utf-8"));
    const summaries = JSON.parse(await readFile(join(stateDir, "episode_summaries.json"), "utf-8"));

    expect(manifest.schemaVersion).toBe(2);
    expect(currentState.episode).toBe(12);
    expect(hooks.hooks[0]?.hookId).toBe("mentor-debt");
    expect(summaries.rows[0]?.title).toBe("Mentor Debt Echo");
    expect(result.hooks.map((hook) => hook.hookId)).toContain("mentor-debt");
  });

  it("prefers structured state files over legacy markdown truth files when both exist", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-structured-preferred-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        [
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 9 |",
          "| Current Conflict | Old markdown conflict |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| markdown-hook | 1 | mystery | open | 9 | 12 | Old markdown hook |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 9 | Markdown Summary | Lin Yue | Old markdown event | Old markdown state | markdown-hook advanced | tense | fallback |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 12,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 12,
        facts: [
          {
            subject: "protagonist",
            predicate: "Current Conflict",
            object: "Structured conflict should win.",
            validFromEpisode: 12,
            validUntilEpisode: null,
            sourceEpisode: 12,
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "structured-hook",
            startEpisode: 10,
            type: "relationship",
            status: "progressing",
            lastAdvancedEpisode: 12,
            expectedPayoff: "Structured payoff",
            notes: "Structured hook should win.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({
        rows: [
          {
            episodeNumber: 12,
            title: "Structured Summary",
            characters: "Lin Yue",
            events: "Structured events should win.",
            stateChanges: "Structured state should win.",
            hookActivity: "structured-hook advanced",
            mood: "tight",
            episodeType: "mainline",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 13,
      goal: "Bring the focus back to the structured hook.",
      mustKeep: ["Structured conflict should win."],
    });

    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: "Structured conflict should win.",
          sourceEpisode: 12,
        }),
      ]),
    );
    expect(result.hooks.map((hook) => hook.hookId)).toContain("structured-hook");
    expect(result.hooks.map((hook) => hook.hookId)).not.toContain("markdown-hook");
    expect(result.summaries.map((summary) => summary.episode)).toContain(12);
    expect(result.summaries.map((summary) => summary.title)).toContain("Structured Summary");
  });

  it("recalls stale open hooks alongside recent governed memory selections", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-stale-hook-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 25,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "current_state.json"),
        JSON.stringify({
          episode: 25,
          facts: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "episode_summaries.json"),
        JSON.stringify({
          rows: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              hookId: "recent-route",
              startEpisode: 22,
              type: "route",
              status: "open",
              lastAdvancedEpisode: 24,
              expectedPayoff: "Recent route payoff",
              notes: "Recent but not critical.",
            },
            {
              hookId: "stale-debt",
              startEpisode: 3,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: 8,
              expectedPayoff: "Mentor debt payoff",
              notes: "Long-stale but still unresolved.",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 26,
      goal: "Keep the episode on the mainline debt conflict.",
      mustKeep: ["The mentor debt is still unresolved."],
    });

    expect(result.hooks.map((hook) => hook.hookId)).toContain("recent-route");
    expect(result.hooks.map((hook) => hook.hookId)).toContain("stale-debt");
  });

  it("surfaces one stale unresolved hook beyond the primary quota while excluding stale resolved hooks", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-stale-quota-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 40,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "current_state.json"),
        JSON.stringify({
          episode: 40,
          facts: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "episode_summaries.json"),
        JSON.stringify({
          rows: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              hookId: "recent-route",
              startEpisode: 37,
              type: "route",
              status: "open",
              lastAdvancedEpisode: 39,
              expectedPayoff: "Recent route payoff",
              notes: "Recent route remains active.",
            },
            {
              hookId: "recent-guild",
              startEpisode: 36,
              type: "politics",
              status: "progressing",
              lastAdvancedEpisode: 38,
              expectedPayoff: "Guild payoff",
              notes: "Recent guild pressure remains active.",
            },
            {
              hookId: "recent-token",
              startEpisode: 35,
              type: "artifact",
              status: "open",
              lastAdvancedEpisode: 37,
              expectedPayoff: "Token payoff",
              notes: "Recent token route remains active.",
            },
            {
              hookId: "stale-omega",
              startEpisode: 3,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: 8,
              expectedPayoff: "Old relic payoff",
              notes: "Dormant unresolved line.",
            },
            {
              hookId: "stale-resolved",
              startEpisode: 2,
              type: "mystery",
              status: "resolved",
              lastAdvancedEpisode: 7,
              expectedPayoff: "Already closed",
              notes: "Should not be resurfaced.",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 41,
      goal: "Keep the episode on the harbor confrontation.",
      mustKeep: ["The harbor confrontation must stay central."],
    });

    expect(result.hooks.map((hook) => hook.hookId)).toEqual([
      "recent-route",
      "recent-guild",
      "recent-token",
      "stale-omega",
    ]);
    expect(result.hooks.map((hook) => hook.hookId)).not.toContain("stale-resolved");
  });

  it("surfaces multiple stale hook families when debt pressure clusters instead of only one stale extra", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-stale-cluster-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 50,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "current_state.json"),
        JSON.stringify({
          episode: 50,
          facts: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "episode_summaries.json"),
        JSON.stringify({
          rows: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              hookId: "recent-route",
              startEpisode: 47,
              type: "route",
              status: "open",
              lastAdvancedEpisode: 49,
              expectedPayoff: "Recent route payoff",
              notes: "Recent route remains active.",
            },
            {
              hookId: "recent-guild",
              startEpisode: 46,
              type: "politics",
              status: "progressing",
              lastAdvancedEpisode: 48,
              expectedPayoff: "Guild payoff",
              notes: "Recent guild pressure remains active.",
            },
            {
              hookId: "recent-token",
              startEpisode: 45,
              type: "artifact",
              status: "open",
              lastAdvancedEpisode: 47,
              expectedPayoff: "Token payoff",
              notes: "Recent token route remains active.",
            },
            {
              hookId: "stale-omega",
              startEpisode: 6,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: 12,
              expectedPayoff: "Old relic payoff",
              notes: "Dormant unresolved relationship line.",
            },
            {
              hookId: "stale-sable",
              startEpisode: 8,
              type: "mystery",
              status: "open",
              lastAdvancedEpisode: 14,
              expectedPayoff: "Archive payoff",
              notes: "Dormant unresolved mystery line.",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 51,
      goal: "Keep the episode on the debt cluster and route pressure together.",
      mustKeep: ["The old debt cluster must stay legible."],
    });

    expect(result.hooks.map((hook) => hook.hookId)).toEqual(expect.arrayContaining([
      "stale-omega",
      "stale-sable",
    ]));
  });

  it("does not surface far-future unstarted hooks in early episode retrieval", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-future-hook-gate-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "zh",
          lastAppliedEpisode: 0,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "current_state.json"),
        JSON.stringify({
          episode: 0,
          facts: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "episode_summaries.json"),
        JSON.stringify({
          rows: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              hookId: "future-gault",
              startEpisode: 54,
              type: "threat",
              status: "open",
              lastAdvancedEpisode: 0,
              expectedPayoff: "Late assembly loss",
              notes: "Far-future disruption only.",
            },
            {
              hookId: "future-ledger-trial",
              startEpisode: 22,
              type: "institutional",
              status: "open",
              lastAdvancedEpisode: 0,
              expectedPayoff: "Late court hearing",
              notes: "Far-future institutional clash.",
            },
            {
              hookId: "opening-call",
              startEpisode: 1,
              type: "mystery",
              status: "open",
              lastAdvancedEpisode: 0,
              expectedPayoff: "Trace the anonymous caller",
              notes: "Opening anonymous call.",
            },
            {
              hookId: "nearby-ledger",
              startEpisode: 4,
              type: "evidence",
              status: "open",
              lastAdvancedEpisode: 0,
              expectedPayoff: "Find the first ledger fragment",
              notes: "Near-future evidence reveal.",
            },
            {
              hookId: "future-final-choice",
              startEpisode: 71,
              type: "climax",
              status: "open",
              lastAdvancedEpisode: 0,
              expectedPayoff: "Final disclosure choice",
              notes: "Endgame only.",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 1,
      goal: "稳住开篇压力，不提前展开远期线。",
      mustKeep: ["匿名来电必须留在开篇。"],
    });

    expect(result.hooks.map((hook) => hook.hookId).sort()).toEqual([
      "nearby-ledger",
      "opening-call",
    ]);
  });

  it("does not resurface a resolved hook just because mustKeep shares an artifact term", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-memory-retrieval-resolved-artifact-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(stateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 10,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "current_state.json"),
        JSON.stringify({
          episode: 10,
          facts: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "episode_summaries.json"),
        JSON.stringify({
          rows: [],
        }, null, 2),
        "utf-8",
      ),
      writeFile(
        join(stateDir, "hooks.json"),
        JSON.stringify({
          hooks: [
            {
              hookId: "mentor-oath",
              startEpisode: 8,
              type: "relationship",
              status: "open",
              lastAdvancedEpisode: 9,
              expectedPayoff: "Mentor oath payoff",
              notes: "Mentor oath debt with Lin Yue",
            },
            {
              hookId: "old-seal",
              startEpisode: 3,
              type: "artifact",
              status: "resolved",
              lastAdvancedEpisode: 3,
              expectedPayoff: "Seal already recovered",
              notes: "Jade seal already recovered.",
            },
          ],
        }, null, 2),
        "utf-8",
      ),
    ]);

    const result = await retrieveMemorySelection({
      bookDir,
      episodeNumber: 11,
      goal: "Bring the focus back to the mentor oath conflict with Lin Yue.",
      outlineNode: "Track the merchant guild's escape route.",
      mustKeep: ["The jade seal cannot be destroyed."],
    });

    expect(result.hooks.map((hook) => hook.hookId)).toContain("mentor-oath");
    expect(result.hooks.map((hook) => hook.hookId)).not.toContain("old-seal");
  });
});

describe("parsePendingHooksMarkdown", () => {
  it("strips markdown emphasis from hook ids in pending hooks tables", () => {
    const hooks = memoryRetrieval.parsePendingHooksMarkdown([
      "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| **H009** | 3 | mystery | open | 3 | 9 | Bold markdown leaked into hook id |",
      "| **H010** | 3 | threat | open | 3 | 6 | Another emphasized hook id |",
      "",
    ].join("\n"));

    expect(hooks.map((hook) => hook.hookId)).toEqual(["H009", "H010"]);
  });

  it("parses semantic payoff timing from extended pending hooks tables", () => {
    const hooks = memoryRetrieval.parsePendingHooksMarkdown([
      "| hook_id | start_episode | type | status | last_advanced | expected_payoff | payoff_timing | notes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| oath-debt | 8 | relationship | open | 12 | Reveal why the mentor broke the oath | slow-burn | Long-buried debt stays unresolved |",
      "| kiln-key | 15 | mystery | open | 15 | Find out what the kiln key opens next episode | immediate | Fresh key with a fast local payoff |",
      "",
    ].join("\n"));

    expect(hooks).toEqual([
      expect.objectContaining({
        hookId: "oath-debt",
        payoffTiming: "slow-burn",
        notes: "Long-buried debt stays unresolved",
      }),
      expect.objectContaining({
        hookId: "kiln-key",
        payoffTiming: "immediate",
        notes: "Fresh key with a fast local payoff",
      }),
    ]);
  });

  it("drops prose rows whose hook id is not id-shaped", () => {
    // The paid 10-episode test run produced a pending_hooks row whose
    // hook_id column contained the prose "这条线索". The parser must not
    // turn that into a durable hook identity.
    const hooks = memoryRetrieval.parsePendingHooksMarkdown([
      "| hook_id | start_episode | type | status | last_advanced | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | promoted | notes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| H008 | 6 | 支线 | progressing | 7 | 第7集 | 近期 | [H003] | 第1篇第7集 | 否 | 10 | 是 | 周沉看到生命体征记录 |",
      "| 这条线索 | 6 | 支线 | deferred (受阻于 这条线索 (已阻 4 集)) | 0 | 第7集 | 近期 | [这条线索] | 第1篇第7集 | 否 | 10 | 是 | 周沉在装置内部看到生命体征监测记录 |",
      "| D001 | 2 | plot | progressing | 6 | 中程 | 中程 | 无 |  | 否 |  |  | 孙志强交日记后失联 |",
      "",
    ].join("\n"));

    expect(hooks.map((hook) => hook.hookId)).toEqual(["H008", "D001"]);
    expect(hooks.map((hook) => hook.hookId)).not.toContain("这条线索");
  });
});

// ---------------------------------------------------------------------------
// Phase 9-2 — computeRecyclableHooks unit tests
// ---------------------------------------------------------------------------

import { computeRecyclableHooks } from "../utils/memory-retrieval.js";
import type { StoredHook } from "../state/memory-db.js";

function makeHook(overrides: Partial<StoredHook> & Pick<StoredHook, "hookId">): StoredHook {
  return {
    startEpisode: 1,
    type: "foreshadow",
    status: "open",
    lastAdvancedEpisode: 0,
    expectedPayoff: "",
    notes: "",
    ...overrides,
  };
}

describe("computeRecyclableHooks", () => {
  it("returns empty array when no hooks are stale", () => {
    const hooks = [
      makeHook({ hookId: "H1", startEpisode: 8, lastAdvancedEpisode: 9, status: "pressured" }),
      makeHook({ hookId: "H2", startEpisode: 9, lastAdvancedEpisode: 0, status: "open" }),
    ];
    expect(computeRecyclableHooks(hooks, 10)).toEqual([]);
  });

  it("flags pressured hooks silent ≥ 5 episodes", () => {
    const hooks = [
      makeHook({ hookId: "H1", startEpisode: 3, lastAdvancedEpisode: 4, status: "pressured" }),
      makeHook({ hookId: "H2", startEpisode: 9, lastAdvancedEpisode: 9, status: "pressured" }),
    ];
    const result = computeRecyclableHooks(hooks, 10);
    expect(result.map((h) => h.hookId)).toEqual(["H1"]);
  });

  it("flags near_payoff hooks silent ≥ 5 episodes", () => {
    const hooks = [
      makeHook({ hookId: "H1", startEpisode: 3, lastAdvancedEpisode: 4, status: "near_payoff" }),
    ];
    const result = computeRecyclableHooks(hooks, 10);
    expect(result.map((h) => h.hookId)).toEqual(["H1"]);
  });

  it("flags core hooks silent ≥ 8 episodes (not 10)", () => {
    const hooks = [
      makeHook({ hookId: "H-core", startEpisode: 2, lastAdvancedEpisode: 2, status: "open", coreHook: true }),
      makeHook({ hookId: "H-regular", startEpisode: 2, lastAdvancedEpisode: 2, status: "open" }),
    ];
    // silence = 10 - 2 = 8. core: qualifies (>=8). regular: does not (<10).
    const result = computeRecyclableHooks(hooks, 10);
    expect(result.map((h) => h.hookId)).toEqual(["H-core"]);
  });

  it("flags plain open hooks only when silent ≥ 10 episodes", () => {
    const hooks = [
      makeHook({ hookId: "H1", startEpisode: 1, lastAdvancedEpisode: 0, status: "open" }),
    ];
    expect(computeRecyclableHooks(hooks, 10).map((h) => h.hookId)).toEqual([]);
    expect(computeRecyclableHooks(hooks, 11).map((h) => h.hookId)).toEqual(["H1"]);
  });

  it("excludes resolved / deferred hooks regardless of silence", () => {
    const hooks = [
      makeHook({ hookId: "H1", startEpisode: 1, lastAdvancedEpisode: 1, status: "resolved" }),
      makeHook({ hookId: "H2", startEpisode: 1, lastAdvancedEpisode: 1, status: "deferred" }),
    ];
    expect(computeRecyclableHooks(hooks, 20)).toEqual([]);
  });

  it("excludes future-planted hooks that have not yet landed", () => {
    const hooks = [
      makeHook({ hookId: "H1", startEpisode: 30, lastAdvancedEpisode: 0, status: "open" }),
    ];
    expect(computeRecyclableHooks(hooks, 10)).toEqual([]);
  });

  it("sorts by silence DESC — most overdue hook first", () => {
    const hooks = [
      makeHook({ hookId: "H-mid", startEpisode: 2, lastAdvancedEpisode: 4, status: "pressured" }),
      makeHook({ hookId: "H-worst", startEpisode: 1, lastAdvancedEpisode: 1, status: "pressured" }),
      makeHook({ hookId: "H-mild", startEpisode: 3, lastAdvancedEpisode: 5, status: "pressured" }),
    ];
    const result = computeRecyclableHooks(hooks, 10);
    expect(result.map((h) => h.hookId)).toEqual(["H-worst", "H-mid", "H-mild"]);
  });
});
