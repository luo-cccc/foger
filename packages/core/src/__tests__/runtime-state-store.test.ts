import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuntimeStateArtifacts,
  loadNarrativeMemorySeed,
  loadEpisodeRuntimeStateSnapshot,
  loadSnapshotCurrentStateFacts,
} from "../state/runtime-state-store.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";

describe("runtime-state-store memory helpers", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("can rebuild a restored snapshot at an explicit episode despite later episode artifacts", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-restored-state-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(storyDir, { recursive: true });
    await mkdir(episodesDir, { recursive: true });
    await Promise.all([
      writeFile(join(episodesDir, "index.json"), JSON.stringify([
        { episodeNumber: 1, title: "Ch1", status: "ready-for-review" },
        { episodeNumber: 2, title: "Ch2", status: "ready-for-review" },
      ]), "utf-8"),
      writeFile(join(episodesDir, "0001_Ch1.md"), "# Episode 1\n\nOne.", "utf-8"),
      writeFile(join(episodesDir, "0002_Ch2.md"), "# Episode 2\n\nTwo.", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), [
        "| Field | Value |",
        "| --- | --- |",
        "| Current Episode | 2 |",
        "| Current Goal | Recover episode one truth. |",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), [
        "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | Ch1 | Lin | One | Goal set | none | tense | mainline |",
      ].join("\n"), "utf-8"),
    ]);

    await rewriteStructuredStateFromMarkdown({
      bookDir,
      fallbackEpisode: 1,
      authoritativeEpisode: 1,
    });
    const manifest = JSON.parse(await readFile(join(storyDir, "state", "manifest.json"), "utf-8"));
    const currentState = JSON.parse(await readFile(join(storyDir, "state", "current_state.json"), "utf-8"));
    const summaries = JSON.parse(await readFile(join(storyDir, "state", "episode_summaries.json"), "utf-8"));

    expect(manifest.lastAppliedEpisode).toBe(1);
    expect(currentState.episode).toBe(1);
    expect(currentState.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ validFromEpisode: 1, sourceEpisode: 1 }),
    ]));
    expect(manifest.migrationWarnings).toContain("current_state episode normalized from 2 to 1");
    expect(summaries.rows.at(-1)?.episodeNumber).toBe(1);
  });

  it("prefers structured runtime state over stale markdown projections for narrative memory", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-state-store-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(stateDir, { recursive: true });
    await mkdir(episodesDir, { recursive: true });
    await writeFile(
      join(episodesDir, "index.json"),
      JSON.stringify([
        { episodeNumber: 1, title: "Ch1", status: "approved" },
        { episodeNumber: 2, title: "Ch2", status: "approved" },
        { episodeNumber: 3, title: "Ch3", status: "approved" },
      ]),
      "utf-8",
    );

    await Promise.all([
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| markdown-hook | 1 | mystery | open | 1 | 4 | Old markdown hook |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 1 | Markdown Summary | Lin Yue | Old markdown event | Old markdown state | markdown-hook advanced | tense | fallback |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 3,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 3,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "structured-hook",
            startEpisode: 2,
            type: "relationship",
            status: "progressing",
            lastAdvancedEpisode: 3,
            expectedPayoff: "Reveal the mentor ledger.",
            notes: "Structured hook should win.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({
        rows: [
          {
            episodeNumber: 3,
            title: "Structured Summary",
            characters: "Lin Yue",
            events: "Structured runtime state event.",
            stateChanges: "Structured runtime state shift.",
            hookActivity: "structured-hook advanced",
            mood: "grim",
            episodeType: "mainline",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    const seed = await loadNarrativeMemorySeed(bookDir);

    expect(seed.hooks).toEqual([
      expect.objectContaining({
        hookId: "structured-hook",
        status: "progressing",
      }),
    ]);
    expect(seed.summaries).toEqual([
      expect.objectContaining({
        episode: 3,
        title: "Structured Summary",
        events: "Structured runtime state event.",
      }),
    ]);
  });

  it("normalizes dormant and confirmed hook lifecycle terms from markdown projections", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-hook-status-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(storyDir, { recursive: true });
    await mkdir(episodesDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(episodesDir, "index.json"),
        JSON.stringify([{ episodeNumber: 1, title: "Ch1", status: "approved" }]),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| dormant-seed | 1 | evidence | 未激活 | 0 | 后续揭开封条日期 | 休眠种子，不应当成正在进行 |",
          "| waiting-seed | 1 | evidence | 待启动 | 0 | 后续揭开压力曲线 | 未来种子，不应当成正在进行 |",
          "| info-seed | 1 | 信息 | 待推进 | 0 | 后续解密身份名单 | 中文类型和状态别名应统一 |",
          "| confirmed-hit | 1 | evidence | confirmed_hit | 1 | 已确认压力曲线异常 | 本章已命中，不应退回 open |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| 1 | Ch1 | 夜班巡检员 | 发现工具箱。 | 种下压力异常。 | confirmed-hit advanced | tense | opening |",
          "",
        ].join("\n"),
        "utf-8",
      ),
    ]);

    const snapshot = await loadEpisodeRuntimeStateSnapshot(bookDir);

    expect(snapshot.hooks.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hookId: "dormant-seed", status: "deferred" }),
        expect.objectContaining({ hookId: "waiting-seed", status: "deferred" }),
        expect.objectContaining({ hookId: "info-seed", type: "information", status: "deferred" }),
        expect.objectContaining({ hookId: "confirmed-hit", status: "progressing" }),
      ]),
    );
  });

  it("prefers structured snapshot state over stale markdown snapshots for fact history rebuild", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-state-snapshot-"));
    const bookDir = join(root, "book");
    const snapshotDir = join(bookDir, "story", "snapshots", "5");
    const snapshotStateDir = join(snapshotDir, "state");
    await mkdir(snapshotStateDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(snapshotDir, "current_state.md"),
        [
          "# Current State",
          "",
          "| Field | Value |",
          "| --- | --- |",
          "| Current Episode | 5 |",
          "| Current Location | Markdown harbor |",
          "| Current Conflict | Old markdown conflict |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(snapshotStateDir, "current_state.json"), JSON.stringify({
        episode: 5,
        facts: [
          {
            subject: "current",
            predicate: "Current Location",
            object: "Structured watchtower",
            validFromEpisode: 5,
            validUntilEpisode: null,
            sourceEpisode: 5,
          },
          {
            subject: "protagonist",
            predicate: "Current Conflict",
            object: "Structured conflict replaces markdown drift.",
            validFromEpisode: 5,
            validUntilEpisode: null,
            sourceEpisode: 5,
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    const facts = await loadSnapshotCurrentStateFacts(bookDir, 5);

    expect(facts).toEqual([
      expect.objectContaining({
        predicate: "Current Location",
        object: "Structured watchtower",
      }),
      expect.objectContaining({
        predicate: "Current Conflict",
        object: "Structured conflict replaces markdown drift.",
      }),
    ]);
  });

  it("rejects persisted duplicate summary episodes in structured runtime state", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-state-invalid-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(stateDir, { recursive: true });
    await mkdir(episodesDir, { recursive: true });
    await writeFile(
      join(episodesDir, "index.json"),
      JSON.stringify(
        Array.from({ length: 12 }, (_, i) => ({ episodeNumber: i + 1, title: `Ch${i + 1}`, status: "approved" })),
      ),
      "utf-8",
    );

    await Promise.all([
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "zh",
        lastAppliedEpisode: 12,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 12,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({
        rows: [
          {
            episodeNumber: 12,
            title: "河埠对账",
            characters: "林月",
            events: "第一次写入。",
            stateChanges: "第一次写入。",
            hookActivity: "mentor-debt 推进",
            mood: "紧绷",
            episodeType: "主线推进",
          },
          {
            episodeNumber: 12,
            title: "重复河埠对账",
            characters: "林月",
            events: "第二次写入。",
            stateChanges: "第二次写入。",
            hookActivity: "mentor-debt 推进",
            mood: "紧绷",
            episodeType: "主线推进",
          },
        ],
      }, null, 2), "utf-8"),
    ]);

    // Duplicates are auto-repaired (deduped, keeping last occurrence), not rejected
    const snapshot = await loadEpisodeRuntimeStateSnapshot(bookDir);
    expect(snapshot.episodeSummaries.rows).toHaveLength(1);
    expect(snapshot.episodeSummaries.rows[0]?.title).toBe("重复河埠对账");
  });

  it("repairs persisted hooks with empty type instead of failing the library load", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-state-hook-repair-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(stateDir, { recursive: true });
    await mkdir(episodesDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(episodesDir, "index.json"),
        JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ episodeNumber: i + 1, title: `Ch${i + 1}`, status: "approved" }))),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "| hook_id | start_episode | type | status | last_advanced | expected_payoff | payoff_timing | notes |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| h001--broken | 3 |  | open | 5 | 后续揭开账本来源。 | near-term | 模型生成了空 type。 |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "zh",
        lastAppliedEpisode: 5,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 5,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "h001--broken",
            startEpisode: 3,
            type: "",
            status: "open",
            lastAdvancedEpisode: 5,
            expectedPayoff: "后续揭开账本来源。",
            notes: "模型生成了空 type，旧版本会导致 books 接口整体报错。",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({
        rows: [],
      }, null, 2), "utf-8"),
    ]);

    const snapshot = await loadEpisodeRuntimeStateSnapshot(bookDir);
    const persistedHooks = JSON.parse(
      await readFile(join(stateDir, "hooks.json"), "utf-8"),
    ) as { hooks: Array<{ hookId: string; type: string }> };

    expect(snapshot.hooks.hooks[0]).toEqual(expect.objectContaining({
      hookId: "h001-broken",
      type: "unspecified",
    }));
    expect(persistedHooks.hooks[0]).toEqual(expect.objectContaining({
      hookId: "h001-broken",
      type: "unspecified",
    }));
    expect(snapshot.manifest.migrationWarnings.join("\n")).toContain("hook id normalized");
    expect(snapshot.manifest.migrationWarnings.join("\n")).toContain("empty hook type");
  });

  it("deduplicates persisted hook ids that collide after normalization", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-state-hook-id-repair-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    const episodesDir = join(bookDir, "episodes");
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(episodesDir, { recursive: true }),
    ]);

    await Promise.all([
      writeFile(join(episodesDir, "index.json"), "[]", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 0,
        projectionVersion: 1,
        migrationWarnings: [],
      }), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({ episode: 0, facts: [] }), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "H027 (Old Li's note)",
            startEpisode: 15,
            type: "clue",
            status: "open",
            lastAdvancedEpisode: 15,
            expectedPayoff: "16",
            notes: "stale labeled record",
          },
          {
            hookId: "H027",
            startEpisode: 15,
            type: "clue",
            status: "progressing",
            lastAdvancedEpisode: 16,
            expectedPayoff: "17",
            notes: "latest canonical record",
          },
        ],
      }), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({ rows: [] }), "utf-8"),
    ]);

    const snapshot = await loadEpisodeRuntimeStateSnapshot(bookDir);

    expect(snapshot.hooks.hooks).toEqual([
      expect.objectContaining({
        hookId: "H027",
        status: "progressing",
        notes: "latest canonical record",
      }),
    ]);
    expect(snapshot.manifest.migrationWarnings.join("\n")).toContain("duplicate hook id normalized");
  });

  it("arbitrates new hook candidates before applying structured state updates", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-runtime-state-arbiter-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    const episodesDir = join(bookDir, "episodes");
    await mkdir(stateDir, { recursive: true });
    await mkdir(episodesDir, { recursive: true });
    await writeFile(
      join(episodesDir, "index.json"),
      JSON.stringify(
        Array.from({ length: 11 }, (_, i) => ({ episodeNumber: i + 1, title: `Ch${i + 1}`, status: "approved" })),
      ),
      "utf-8",
    );

    await Promise.all([
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 11,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 11,
        facts: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify({
        hooks: [
          {
            hookId: "anonymous-source-scope",
            startEpisode: 3,
            type: "source-risk",
            status: "open",
            lastAdvancedEpisode: 8,
            expectedPayoff: "Reveal how much the anonymous source already knew about the route.",
            notes: "The source knowledge question remains unresolved.",
          },
        ],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({
        rows: [],
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "", "utf-8"),
    ]);

    const artifacts = await buildRuntimeStateArtifacts({
      bookDir,
      language: "en",
      delta: {
        episode: 12,
        hookOps: {
          upsert: [],
          mention: [],
          resolve: [],
          defer: [],
        },
        newHookCandidates: [
          {
            type: "source-risk",
            expectedPayoff: "Reveal how much the anonymous source already knew about the route and address.",
            notes: "This episode adds the address angle to the anonymous source question.",
          },
          {
            type: "artifact",
            expectedPayoff: "Reveal why the recovered seal responds only at midnight.",
            notes: "A genuinely new artifact rule appears in this episode.",
          },
        ],
        notes: [],
        subplotOps: [],
        emotionalArcOps: [],
        characterMatrixOps: [],
      },
    });

    expect(artifacts.resolvedDelta.hookOps.upsert).toEqual([
      expect.objectContaining({
        hookId: "anonymous-source-scope",
        lastAdvancedEpisode: 12,
      }),
      expect.objectContaining({
        hookId: "D001",
        type: "artifact",
      }),
    ]);
    expect(artifacts.snapshot.hooks.hooks).toHaveLength(2);
    expect(artifacts.snapshot.hooks.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hookId: "D001", type: "artifact" }),
      expect.objectContaining({
        hookId: "anonymous-source-scope",
        lastAdvancedEpisode: 12,
      }),
    ]));
  });
});
