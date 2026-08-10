import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../state/manager.js";
import type { BookConfig } from "../models/book.js";
import type { EpisodeMeta } from "../models/episode.js";

describe("StateManager", () => {
  let tempDir: string;
  let manager: StateManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-test-"));
    manager = new StateManager(tempDir);
    const originalLoadEpisodeBookConfig = manager.loadEpisodeBookConfig.bind(manager);
    vi.spyOn(manager, "loadEpisodeBookConfig").mockImplementation(async (bookId) => {
      try {
        return await originalLoadEpisodeBookConfig(bookId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
        return {
          id: bookId,
          title: bookId,
          platform: "other",
          genre: "other",
          status: "active",
          schemaVersion: "inkos-episode-v2",
          format: "screenplay",
          targetEpisodes: 100,
          episodeDurationSeconds: 90,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      }
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // BookConfig persistence
  // -------------------------------------------------------------------------

  describe("saveBookConfig / loadBookConfig", () => {
    const bookConfig: BookConfig = {
      id: "test-book",
      title: "Test Novel",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 100,
      episodeDurationSeconds: 90,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    it("round-trips a BookConfig through save and load", async () => {
      await manager.saveBookConfig("test-book", bookConfig);
      const loaded = await manager.loadBookConfig("test-book");
      expect(loaded).toEqual(bookConfig);
    });

    it("creates the book directory on save", async () => {
      await manager.saveBookConfig("new-book", {
        ...bookConfig,
        id: "new-book",
      });
      const dirStat = await stat(manager.bookDir("new-book"));
      expect(dirStat.isDirectory()).toBe(true);
    });

    it("throws when loading a non-existent book", async () => {
      // This test targets the strict production loader, not the temporary
      // Episode v2 fixture fallback used by the mutation-focused cases.
      await expect(new StateManager(tempDir).loadBookConfig("nope")).rejects.toThrow();
    });

    it("rejects invalid persisted book configuration", async () => {
      const bookDir = manager.bookDir("invalid-book");
      await mkdir(bookDir, { recursive: true });
      await writeFile(join(bookDir, "book.json"), JSON.stringify({
        ...bookConfig,
        id: "invalid-book",
        episodeDurationSeconds: null,
      }), "utf-8");

      await expect(manager.loadBookConfig("invalid-book")).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // EpisodeIndex persistence
  // -------------------------------------------------------------------------

  describe("saveEpisodeIndex / loadEpisodeIndex", () => {
    const episodes: ReadonlyArray<EpisodeMeta> = [
      {
        episodeNumber: 1,
        title: "Ch1",
        status: "drafted",
        episodeDurationSeconds: 3000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        auditIssues: [],
        lengthWarnings: [],
      },
      {
        episodeNumber: 2,
        title: "Ch2",
        status: "drafting",
        episodeDurationSeconds: 0,
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        auditIssues: ["pacing issue"],
        lengthWarnings: [],
      },
    ];

    it("round-trips episode index through save and load", async () => {
      await manager.saveEpisodeIndex("book-a", episodes);
      const loaded = await manager.loadEpisodeIndex("book-a");
      expect(loaded).toEqual(episodes);
    });

    it("deduplicates duplicate episode rows, keeping the first entry", async () => {
      const duplicates: ReadonlyArray<EpisodeMeta> = [
        {
          ...episodes[0]!,
          operationId: "op-1",
        },
        {
          episodeNumber: 1,
          title: "duplicate",
          status: "ready-for-review",
          episodeDurationSeconds: 90,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        },
        episodes[1]!,
      ];
      await manager.saveEpisodeIndex("book-dedupe", duplicates);
      const loaded = await manager.loadEpisodeIndex("book-dedupe");
      expect(loaded.map((entry) => entry.episodeNumber)).toEqual([1, 2]);
      expect(loaded.find((entry) => entry.episodeNumber === 1)?.operationId).toBe("op-1");
    });

    it("returns empty array when no index exists", async () => {
      const loaded = await manager.loadEpisodeIndex("nonexistent");
      expect(loaded).toEqual([]);
    });

    it("rebuilds the episode index from episode files when index.json is empty", async () => {
      const bookDir = manager.bookDir("rebuild-book");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8");
      await writeFile(join(bookDir, "episodes", "0001_雨棚.md"), "# 第1章 雨棚\n\n正文。", "utf-8");
      await writeFile(join(bookDir, "episodes", "0002_账页.md"), "# 第2章 账页\n\n正文。", "utf-8");

      const loaded = await manager.loadEpisodeIndex("rebuild-book");

      expect(loaded.map((episode) => episode.episodeNumber)).toEqual([1, 2]);
      expect(loaded[0]).toMatchObject({
        title: "雨棚",
        status: "ready-for-review",
      });
    });

    it("does not save an empty episode index over existing episode files", async () => {
      const bookDir = manager.bookDir("protect-empty-index");
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      await writeFile(join(bookDir, "episodes", "0001_雨棚.md"), "# 第1章 雨棚\n\n正文。", "utf-8");

      await manager.saveEpisodeIndex("protect-empty-index", []);

      const raw = await readFile(join(bookDir, "episodes", "index.json"), "utf-8");
      const parsed = JSON.parse(raw) as Array<{ episodeNumber: number; title: string }>;
      expect(parsed.map((episode) => episode.episodeNumber)).toEqual([1]);
      expect(parsed[0]?.title).toBe("雨棚");
    });

    it("creates the episodes directory on save", async () => {
      await manager.saveEpisodeIndex("book-b", []);
      const dirStat = await stat(
        join(manager.bookDir("book-b"), "episodes"),
      );
      expect(dirStat.isDirectory()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getNextEpisodeNumber
  // -------------------------------------------------------------------------

  describe("getNextEpisodeNumber", () => {
    it("returns 1 for an empty book (no episodes)", async () => {
      const next = await manager.getNextEpisodeNumber("empty-book");
      expect(next).toBe(1);
    });

    it("returns the first missing episode when the episode index has gaps", async () => {
      const episodes: ReadonlyArray<EpisodeMeta> = [
        {
          episodeNumber: 1,
          title: "Ch1",
          status: "published",
          episodeDurationSeconds: 3000,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        },
        {
          episodeNumber: 5,
          title: "Ch5",
          status: "drafted",
          episodeDurationSeconds: 2800,
          createdAt: "2026-01-05T00:00:00Z",
          updatedAt: "2026-01-05T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        },
        {
          episodeNumber: 3,
          title: "Ch3",
          status: "approved",
          episodeDurationSeconds: 3100,
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        },
      ];
      await manager.saveEpisodeIndex("book-x", episodes);
      const next = await manager.getNextEpisodeNumber("book-x");
      expect(next).toBe(2);
    });

    it("returns 2 when only episode 1 exists", async () => {
      const episodes: ReadonlyArray<EpisodeMeta> = [
        {
          episodeNumber: 1,
          title: "Ch1",
          status: "drafted",
          episodeDurationSeconds: 3000,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        },
      ];
      await manager.saveEpisodeIndex("book-y", episodes);
      const next = await manager.getNextEpisodeNumber("book-y");
      expect(next).toBe(2);
    });

    it("does not advance durable progress past an audit-failed episode", async () => {
      const bookId = "audit-failed-progress-book";
      const bookDir = manager.bookDir(bookId);
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await manager.saveEpisodeIndex(bookId, [{
        episodeNumber: 1,
        title: "Failed Episode",
        status: "audit-failed",
        episodeDurationSeconds: 3000,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        auditIssues: ["[critical] blocking issue"],
        lengthWarnings: [],
      }]);
      await writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: bookId,
        title: bookId,
        platform: "other",
        genre: "other",
        status: "active",
        schemaVersion: "inkos-episode-v2",
        format: "screenplay",
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }), "utf-8");
      await writeFile(
        join(episodesDir, "0001_Failed_Episode.md"),
        "# Episode 1: Failed Episode\n\nPersisted review draft.",
        "utf-8",
      );

      const next = await manager.getNextEpisodeNumber(bookId);
      const manifest = JSON.parse(await readFile(
        join(bookDir, "story", "state", "manifest.json"),
        "utf-8",
      )) as { lastAppliedEpisode: number };

      expect(next).toBe(1);
      expect(manifest.lastAppliedEpisode).toBe(0);
    });

    it("uses durable story progress when episode index lags behind persisted episode files", async () => {
      const bookId = "stale-index-book";
      const bookDir = manager.bookDir(bookId);
      const episodesDir = join(bookDir, "episodes");
      const storyDir = join(bookDir, "story");
      await mkdir(episodesDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        manager.saveEpisodeIndex(bookId, [
          {
            episodeNumber: 1,
            title: "Ch1",
            status: "ready-for-review",
            episodeDurationSeconds: 3000,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            auditIssues: [],
            lengthWarnings: [],
          },
          {
            episodeNumber: 2,
            title: "Ch2",
            status: "ready-for-review",
            episodeDurationSeconds: 3000,
            createdAt: "2026-01-02T00:00:00Z",
            updatedAt: "2026-01-02T00:00:00Z",
            auditIssues: [],
            lengthWarnings: [],
          },
        ]),
        writeFile(
          join(episodesDir, "0003_Lantern_Vault.md"),
          "# Episode 3: Lantern Vault\n\nPersisted body.",
          "utf-8",
        ),
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 3 |",
            "| Current Goal | Enter the vault without alerting the wardens |",
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);

      const next = await manager.getNextEpisodeNumber(bookId);

      expect(next).toBe(4);
    });

    it("ignores non-contiguous poisoned episode numbers when calculating the next episode", async () => {
      const bookId = "poisoned-next-episode-book";
      const bookDir = manager.bookDir(bookId);
      const episodesDir = join(bookDir, "episodes");
      const storyDir = join(bookDir, "story");
      const stateDir = join(storyDir, "state");
      await mkdir(episodesDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });

      const indexedEpisodes: ReadonlyArray<EpisodeMeta> = [
        ...Array.from({ length: 12 }, (_, index) => ({
          episodeNumber: index + 1,
          title: `Ch${index + 1}`,
          status: "ready-for-review" as const,
          episodeDurationSeconds: 3000,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        })),
        {
          episodeNumber: 142,
          title: "Poisoned Ch142",
          status: "audit-failed",
          episodeDurationSeconds: 3200,
          createdAt: "2026-01-13T00:00:00Z",
          updatedAt: "2026-01-13T00:00:00Z",
          auditIssues: [],
          lengthWarnings: [],
        },
      ];

      await manager.saveEpisodeIndex(bookId, indexedEpisodes);
      await Promise.all([
        ...Array.from({ length: 12 }, (_, index) => writeFile(
          join(episodesDir, `${String(index + 1).padStart(4, "0")}_Ch${index + 1}.md`),
          `# Episode ${index + 1}\n\nStable body.`,
          "utf-8",
        )),
        writeFile(
          join(episodesDir, "0142_Poisoned.md"),
          "# Episode 142\n\nPoisoned body.",
          "utf-8",
        ),
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 12 |",
            "| Current Goal | Enter the next true episode cleanly |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| H001 | 1 | mystery | progressing | 《三体》游戏内第141号文明继续展开 | Reveal the true enemy | Narrative text must not drive episode progress |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            ...Array.from({ length: 12 }, (_, index) =>
              `| ${index + 1} | Ch${index + 1} | Lin Yue | Event ${index + 1} | Shift ${index + 1} | Hook ${index + 1} | tense | mainline |`),
            "| 142 | Poisoned Ch142 | Lin Yue | Poisoned event | Poisoned shift | Poisoned hook | tense | mainline |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(join(stateDir, "manifest.json"), JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 141,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2), "utf-8"),
      ]);

      const next = await manager.getNextEpisodeNumber(bookId);

      expect(next).toBe(13);
    });
  });

  // -------------------------------------------------------------------------
  // listBooks
  // -------------------------------------------------------------------------

  describe("listBooks", () => {
    it("returns empty array when no books directory exists", async () => {
      const books = await manager.listBooks();
      expect(books).toEqual([]);
    });

    it("returns book IDs for directories with book.json", async () => {
      const bookConfig: BookConfig = {
        id: "alpha",
        title: "Alpha",
        platform: "tomato",
        genre: "urban",
        status: "active",
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      await manager.saveBookConfig("alpha", bookConfig);
      await manager.saveBookConfig("beta", { ...bookConfig, id: "beta", title: "Beta" });

      // Create a decoy directory without book.json
      await mkdir(join(manager.booksDir, "not-a-book"), { recursive: true });

      const books = await manager.listBooks();
      expect(books).toContain("alpha");
      expect(books).toContain("beta");
      expect(books).not.toContain("not-a-book");
      expect(books).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // snapshotState / restoreState
  // -------------------------------------------------------------------------

  describe("snapshotState / restoreState", () => {
    const bookId = "snap-book";

    beforeEach(async () => {
      const storyDir = join(manager.bookDir(bookId), "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(storyDir, "current_state.md"),
        "# State at ch1",
        "utf-8",
      );
      await writeFile(
        join(storyDir, "particle_ledger.md"),
        "# Ledger at ch1",
        "utf-8",
      );
      await writeFile(
        join(storyDir, "pending_hooks.md"),
        "# Hooks at ch1",
        "utf-8",
      );
    });

    it("snapshots current state files to a numbered directory", async () => {
      await manager.snapshotState(bookId, 1);

      const snapshotDir = join(
        manager.bookDir(bookId),
        "story",
        "snapshots",
        "1",
      );
      const state = await readFile(
        join(snapshotDir, "current_state.md"),
        "utf-8",
      );
      expect(state).toBe("# State at ch1");

      const ledger = await readFile(
        join(snapshotDir, "particle_ledger.md"),
        "utf-8",
      );
      expect(ledger).toBe("# Ledger at ch1");

      const hooks = await readFile(
        join(snapshotDir, "pending_hooks.md"),
        "utf-8",
      );
      expect(hooks).toBe("# Hooks at ch1");
    });

    it("copies structured runtime state into snapshot/state when present", async () => {
      const stateDir = manager.stateDir(bookId);
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 1,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      );

      await manager.snapshotState(bookId, 1);

      const snapshotManifest = await readFile(
        join(manager.bookDir(bookId), "story", "snapshots", "1", "state", "manifest.json"),
        "utf-8",
      );
      expect(snapshotManifest).toContain("\"schemaVersion\": 2");
    });

    it("restores state from a previous snapshot", async () => {
      await manager.snapshotState(bookId, 1);

      // Modify the current state files
      const storyDir = join(manager.bookDir(bookId), "story");
      await writeFile(
        join(storyDir, "current_state.md"),
        "# State at ch2 (modified)",
        "utf-8",
      );
      await writeFile(
        join(storyDir, "particle_ledger.md"),
        "# Ledger at ch2 (modified)",
        "utf-8",
      );
      await writeFile(
        join(storyDir, "pending_hooks.md"),
        "# Hooks at ch2 (modified)",
        "utf-8",
      );

      const restored = await manager.restoreState(bookId, 1);
      expect(restored).toBe(true);

      // Verify restored content
      const state = await readFile(
        join(storyDir, "current_state.md"),
        "utf-8",
      );
      expect(state).toBe("# State at ch1");

      const ledger = await readFile(
        join(storyDir, "particle_ledger.md"),
        "utf-8",
      );
      expect(ledger).toBe("# Ledger at ch1");
    });

    it("removes live optional truth files that are absent from the snapshot", async () => {
      const storyDir = join(manager.bookDir(bookId), "story");
      await rm(join(storyDir, "particle_ledger.md"));
      await manager.snapshotState(bookId, 1);

      await writeFile(
        join(storyDir, "particle_ledger.md"),
        "# Ledger added after snapshot",
        "utf-8",
      );

      const restored = await manager.restoreState(bookId, 1);
      expect(restored).toBe(true);
      await expect(stat(join(storyDir, "particle_ledger.md"))).rejects.toThrow();
    });

    it("restores structured runtime state files from snapshot/state", async () => {
      const stateDir = manager.stateDir(bookId);
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 1,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      );

      await manager.snapshotState(bookId, 1);
      await writeFile(
        join(stateDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 2,
          language: "en",
          lastAppliedEpisode: 9,
          projectionVersion: 1,
          migrationWarnings: [],
        }, null, 2),
        "utf-8",
      );

      const restored = await manager.restoreState(bookId, 1);
      expect(restored).toBe(true);

      const manifest = await readFile(join(stateDir, "manifest.json"), "utf-8");
      expect(manifest).toContain("\"lastAppliedEpisode\": 1");
    });

    it("returns false when restoring from non-existent snapshot", async () => {
      const restored = await manager.restoreState(bookId, 999);
      expect(restored).toBe(false);
    });

    it("rewrite episode 2 then getNextEpisodeNumber returns 2", async () => {
      const rwBookId = "rewrite-book";
      const chapDir = join(manager.bookDir(rwBookId), "episodes");
      const storyDir = join(manager.bookDir(rwBookId), "story");
      await mkdir(chapDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });

      // Simulate 3 episodes written
      await writeFile(join(chapDir, "0001_ch1.md"), "# Episode 1\nContent 1", "utf-8");
      await writeFile(join(chapDir, "0002_ch2.md"), "# Episode 2\nContent 2", "utf-8");
      await writeFile(join(chapDir, "0003_ch3.md"), "# Episode 3\nContent 3", "utf-8");
      const mkEntry = (n: number) => ({
        episodeNumber: n, title: `Ch${n}`, status: "approved" as const, episodeDurationSeconds: 100,
        createdAt: "", updatedAt: "", auditIssues: [] as string[], lengthWarnings: [] as string[],
      });
      const fullIndex = [mkEntry(1), mkEntry(2), mkEntry(3)];
      await manager.saveEpisodeIndex(rwBookId, fullIndex);

      // Snapshot state at episode 1 (before episode 2)
      await writeFile(join(storyDir, "current_state.md"), "State at ch1", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "Hooks at ch1", "utf-8");
      await manager.snapshotState(rwBookId, 1);

      // Simulate rewrite of episode 2: trim index, delete ch2+ch3, restore state
      const trimmed = fullIndex.filter((ch) => ch.episodeNumber < 2);
      await manager.saveEpisodeIndex(rwBookId, trimmed);
      const { rm } = await import("node:fs/promises");
      await rm(join(chapDir, "0002_ch2.md"));
      await rm(join(chapDir, "0003_ch3.md"));
      await manager.restoreState(rwBookId, 1);

      // Next episode should be 2, not 4
      const next = await manager.getNextEpisodeNumber(rwBookId);
      expect(next).toBe(2);
    });

    it("rewrite restore drops poisoned live structured state when the snapshot only has markdown truth files", async () => {
      const rwBookId = "rewrite-book-markdown-only";
      const chapDir = join(manager.bookDir(rwBookId), "episodes");
      const storyDir = join(manager.bookDir(rwBookId), "story");
      const stateDir = join(storyDir, "state");
      await mkdir(chapDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });

      await writeFile(join(chapDir, "0001_ch1.md"), "# Episode 1\nContent 1", "utf-8");
      await writeFile(join(chapDir, "0002_ch2.md"), "# Episode 2\nContent 2", "utf-8");
      await writeFile(join(chapDir, "0003_ch3.md"), "# Episode 3\nContent 3", "utf-8");
      const mkEntry = (n: number) => ({
        episodeNumber: n, title: `Ch${n}`, status: "approved" as const, episodeDurationSeconds: 100,
        createdAt: "", updatedAt: "", auditIssues: [] as string[], lengthWarnings: [] as string[],
      });
      const fullIndex = [mkEntry(1), mkEntry(2), mkEntry(3)];
      await manager.saveEpisodeIndex(rwBookId, fullIndex);

      await writeFile(join(storyDir, "current_state.md"), "State at ch1", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "Hooks at ch1", "utf-8");
      await manager.snapshotState(rwBookId, 1);

      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 4,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8");
      await writeFile(join(stateDir, "current_state.json"), JSON.stringify({
        episode: 3,
        facts: [],
      }, null, 2), "utf-8");

      const trimmed = fullIndex.filter((ch) => ch.episodeNumber < 2);
      await manager.saveEpisodeIndex(rwBookId, trimmed);
      const { rm } = await import("node:fs/promises");
      await rm(join(chapDir, "0002_ch2.md"));
      await rm(join(chapDir, "0003_ch3.md"));
      await manager.restoreState(rwBookId, 1);

      const next = await manager.getNextEpisodeNumber(rwBookId);
      expect(next).toBe(2);
    });
  });

  describe("episode persistence transaction recovery", () => {
    it("rolls back partial episode, index, and truth writes from a preparing transaction", async () => {
      const bookId = "transaction-book";
      const bookDir = manager.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "current_state.md"), "state-0", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "hooks-0", "utf-8");
      await manager.saveEpisodeIndex(bookId, []);
      await manager.snapshotState(bookId, 0);

      await manager.beginEpisodePersistence(bookId, 1, "operation-transaction");
      await writeFile(join(episodesDir, "0001_partial.md"), "partial", "utf-8");
      await writeFile(join(storyDir, "current_state.md"), "state-1-partial", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "hooks-1-partial", "utf-8");
      await manager.saveEpisodeIndex(bookId, [{
        episodeNumber: 1,
        title: "Partial",
        status: "ready-for-review",
        episodeDurationSeconds: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      }]);

      await expect(manager.recoverIncompleteEpisodePersistence(bookId)).resolves.toEqual({
        kind: "rolled-back",
        episodeNumber: 1,
        rolledBackTo: 0,
        operationId: "operation-transaction",
      });

      await expect(stat(join(episodesDir, "0001_partial.md"))).rejects.toThrow();
      await expect(manager.loadEpisodeIndex(bookId)).resolves.toEqual([]);
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("state-0");
      await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe("hooks-0");
      await expect(stat(join(bookDir, ".episode-persistence.json"))).rejects.toThrow();
      const recoveryDiagnostic = JSON.parse(await readFile(join(storyDir, "runtime", "recovery.json"), "utf-8"));
      expect(recoveryDiagnostic).toMatchObject({
        kind: "rolled-back",
        episodeNumber: 1,
        rolledBackTo: 0,
        operationId: "operation-transaction",
      });
      expect(recoveryDiagnostic.occurredAt).toEqual(expect.any(String));
    });

    it("cleans up a committed marker without removing committed artifacts", async () => {
      const bookId = "committed-marker-book";
      const bookDir = manager.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(episodesDir, "0001_committed.md"), "committed episode", "utf-8");
      await writeFile(join(storyDir, "current_state.md"), "committed truth", "utf-8");
      await manager.saveEpisodeIndex(bookId, [{
        episodeNumber: 1,
        title: "Committed",
        status: "ready-for-review",
        episodeDurationSeconds: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      }]);
      await writeFile(join(bookDir, ".episode-persistence.json"), JSON.stringify({
        episodeNumber: 1,
        previousEpisode: 0,
        status: "committed",
        operationId: "operation-committed",
      }), "utf-8");

      await expect(manager.recoverIncompleteEpisodePersistence(bookId)).resolves.toEqual({
        kind: "committed-cleanup",
        episodeNumber: 1,
        operationId: "operation-committed",
      });

      await expect(stat(join(bookDir, ".episode-persistence.json"))).rejects.toThrow();
      await expect(readFile(join(episodesDir, "0001_committed.md"), "utf-8")).resolves.toBe("committed episode");
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("committed truth");
      await expect(manager.loadEpisodeIndex(bookId)).resolves.toHaveLength(1);
      const recoveryDiagnostic = JSON.parse(await readFile(join(storyDir, "runtime", "recovery.json"), "utf-8"));
      expect(recoveryDiagnostic).toMatchObject({
        kind: "committed-cleanup",
        episodeNumber: 1,
        operationId: "operation-committed",
      });
    });

    it("recovers a preparing transaction through a new manager after process restart", async () => {
      const bookId = "restart-recovery-book";
      const bookDir = manager.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "current_state.md"), "state-before-restart", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "hooks-before-restart", "utf-8");
      await manager.saveEpisodeIndex(bookId, []);
      await manager.snapshotState(bookId, 0);
      await manager.beginEpisodePersistence(bookId, 1, "operation-restart");
      await writeFile(join(episodesDir, "0001_interrupted.md"), "interrupted", "utf-8");
      await writeFile(join(storyDir, "current_state.md"), "state-after-partial-write", "utf-8");
      await manager.saveEpisodeIndex(bookId, [{
        episodeNumber: 1,
        title: "Interrupted",
        status: "drafting",
        episodeDurationSeconds: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        auditIssues: [],
        lengthWarnings: [],
      }]);
      await writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: bookId,
        title: bookId,
        platform: "other",
        genre: "other",
        status: "active",
        schemaVersion: "inkos-episode-v2",
        format: "screenplay",
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }), "utf-8");

      const restartedManager = new StateManager(tempDir);
      await expect(restartedManager.recoverIncompleteEpisodePersistence(bookId)).resolves.toEqual({
        kind: "rolled-back",
        episodeNumber: 1,
        rolledBackTo: 0,
        operationId: "operation-restart",
      });

      await expect(stat(join(episodesDir, "0001_interrupted.md"))).rejects.toThrow();
      await expect(restartedManager.loadEpisodeIndex(bookId)).resolves.toEqual([]);
      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe("state-before-restart");
      const recoveryDiagnostic = JSON.parse(await readFile(join(storyDir, "runtime", "recovery.json"), "utf-8"));
      expect(recoveryDiagnostic).toMatchObject({ operationId: "operation-restart", kind: "rolled-back" });
    });

    it("reports when no persistence transaction needs recovery", async () => {
      await expect(manager.recoverIncompleteEpisodePersistence("no-transaction-book")).resolves.toEqual({ kind: "none" });
    });
  });

  // -------------------------------------------------------------------------
  // acquireBookLock
  // -------------------------------------------------------------------------

  describe("acquireBookLock", () => {
    it("acquires a lock and returns a release function", async () => {
      // Ensure book directory exists
      await mkdir(manager.bookDir("lock-book"), { recursive: true });

      const release = await manager.acquireBookLock("lock-book");
      expect(typeof release).toBe("function");

      // Lock file should exist
      const lockPath = join(manager.bookDir("lock-book"), ".write.lock");
      const lockStat = await stat(lockPath);
      expect(lockStat.isFile()).toBe(true);

      // Release the lock
      await release();

      // Lock file should be gone
      await expect(stat(lockPath)).rejects.toThrow();
    });

    it("throws when lock is already held", async () => {
      await mkdir(manager.bookDir("lock-book-2"), { recursive: true });

      const release = await manager.acquireBookLock("lock-book-2");

      await expect(
        manager.acquireBookLock("lock-book-2"),
      ).rejects.toThrow(/is locked/);

      await release();
    });

    it("allows re-acquiring lock after release", async () => {
      await mkdir(manager.bookDir("lock-book-3"), { recursive: true });

      const release1 = await manager.acquireBookLock("lock-book-3");
      await release1();

      const release2 = await manager.acquireBookLock("lock-book-3");
      expect(typeof release2).toBe("function");
      await release2();
    });

    it("allows only one concurrent lock claimant", async () => {
      await mkdir(manager.bookDir("lock-book-4"), { recursive: true });

      const results = await Promise.allSettled([
        manager.acquireBookLock("lock-book-4"),
        manager.acquireBookLock("lock-book-4"),
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");

      for (const result of fulfilled) {
        await result.value();
      }

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toMatch(/is locked/);
    });

    it("reclaims same-process stale lock when no active write is in progress", async () => {
      await mkdir(manager.bookDir("lock-book-self"), { recursive: true });
      const lockPath = join(manager.bookDir("lock-book-self"), ".write.lock");
      // Simulate a stale lock left by our own process (e.g. after a failed pipeline)
      await writeFile(lockPath, `pid:${process.pid} ts:${Date.now() - 60000}`, "utf-8");

      // Should auto-reclaim since our process knows it's not actively writing this book
      const release = await manager.acquireBookLock("lock-book-self");
      expect(typeof release).toBe("function");

      const lockData = await readFile(lockPath, "utf-8");
      expect(lockData).toContain(`pid:${process.pid}`);

      await release();
    });

    it("reclaims a stale lock when the recorded pid is no longer alive", async () => {
      await mkdir(manager.bookDir("lock-book-5"), { recursive: true });
      const lockPath = join(manager.bookDir("lock-book-5"), ".write.lock");
      await writeFile(lockPath, "pid:424242 ts:123", "utf-8");

      const killSpy = vi.spyOn(process, "kill").mockImplementation((((pid: number) => {
        if (pid === 424242) {
          const error = new Error("no such process") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }) as unknown) as typeof process.kill);

      try {
        const release = await manager.acquireBookLock("lock-book-5");
        const lockData = await readFile(lockPath, "utf-8");

        expect(typeof release).toBe("function");
        expect(lockData).toContain(`pid:${process.pid}`);

        await release();
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  describe("path helpers", () => {
    it("booksDir points to <projectRoot>/books", () => {
      expect(manager.booksDir).toBe(join(tempDir, "books"));
    });

    it("bookDir returns <booksDir>/<bookId>", () => {
      expect(manager.bookDir("my-book")).toBe(
        join(tempDir, "books", "my-book"),
      );
    });

    it("stateDir returns <bookDir>/story/state", () => {
      expect(manager.stateDir("my-book")).toBe(
        join(tempDir, "books", "my-book", "story", "state"),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Input governance control docs
  // -------------------------------------------------------------------------

  describe("ensureControlDocuments", () => {
    it("creates author intent, current focus, and runtime directory", async () => {
      await manager.ensureControlDocuments(
        "control-book",
        "# Initial Brief\n\nKeep the focus on mentor conflict.\n",
      );

      const storyDir = join(manager.bookDir("control-book"), "story");
      const authorIntent = await readFile(
        join(storyDir, "author_intent.md"),
        "utf-8",
      );
      const currentFocus = await readFile(
        join(storyDir, "current_focus.md"),
        "utf-8",
      );
      const runtimeStat = await stat(join(storyDir, "runtime"));

      expect(authorIntent).toContain("mentor conflict");
      expect(currentFocus).toContain("当前聚焦");
      expect(runtimeStat.isDirectory()).toBe(true);
    });

    it("creates Phase 5 outline/ and roles/ directories", async () => {
      await manager.ensureControlDocuments("phase5-book");

      const storyDir = join(manager.bookDir("phase5-book"), "story");
      const outlineStat = await stat(join(storyDir, "outline"));
      const rolesMajorStat = await stat(join(storyDir, "roles", "主要角色"));
      const rolesMinorStat = await stat(join(storyDir, "roles", "次要角色"));

      expect(outlineStat.isDirectory()).toBe(true);
      expect(rolesMajorStat.isDirectory()).toBe(true);
      expect(rolesMinorStat.isDirectory()).toBe(true);
    });

    it("bootstraps and returns Chinese defaults for legacy books without language metadata", async () => {
      const storyDir = join(manager.bookDir("legacy-book"), "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(
        join(storyDir, "story_bible.md"),
        "# Story Bible\n\nLegacy books may not have control docs yet.\n",
        "utf-8",
      );

      const controlDocs = await manager.loadControlDocuments("legacy-book");

      expect(controlDocs.authorIntent).toContain("# 作者意图");
      expect(controlDocs.currentFocus).toContain("# 当前聚焦");
      expect(controlDocs.runtimeDir).toBe(join(storyDir, "runtime"));
    });

    it("creates localized Chinese defaults for Chinese books", async () => {
      await manager.saveBookConfig("zh-book", {
        id: "zh-book",
        title: "中文书",
        platform: "tomato",
        genre: "other",
        status: "outlining",
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        language: "zh",
        createdAt: "2026-03-24T00:00:00Z",
        updatedAt: "2026-03-24T00:00:00Z",
      });

      await manager.ensureControlDocuments("zh-book");

      const storyDir = join(manager.bookDir("zh-book"), "story");
      const authorIntent = await readFile(
        join(storyDir, "author_intent.md"),
        "utf-8",
      );
      const currentFocus = await readFile(
        join(storyDir, "current_focus.md"),
        "utf-8",
      );

      expect(authorIntent).toContain("# 作者意图");
      expect(currentFocus).toContain("# 当前聚焦");
      expect(currentFocus).not.toContain("# Current Focus");
    });

    it("bootstraps structured runtime state from legacy markdown truth files", async () => {
      const bookId = "runtime-state-book";
      const storyDir = join(manager.bookDir(bookId), "story");
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 3 |",
            "| Current Goal | Trace the mentor debt |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| mentor-debt | 1 | relationship | open | 3 | 10 | Still unresolved |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 3 | River Ledger | Lin Yue | He checks the old ledger | Debt sharpens | mentor-debt advanced | tense | mainline |",
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);

      await manager.ensureRuntimeState(bookId, 3);

      const manifest = await readFile(join(manager.stateDir(bookId), "manifest.json"), "utf-8");
      const currentState = await readFile(join(manager.stateDir(bookId), "current_state.json"), "utf-8");

      expect(manifest).toContain("\"schemaVersion\": 2");
      expect(currentState).toContain("\"episode\": 3");
    });

    it("does not treat future hook start episodes as lastAppliedEpisode during bootstrap", async () => {
      const bookId = "runtime-state-future-hooks-book";
      const storyDir = join(manager.bookDir(bookId), "story");
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 1 |",
            "| Current Goal | Survive the harbor fallout |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| long-payoff-1 | 108 | mystery | open | 1 | 108 | Future payoff anchor |",
            "| long-payoff-2 | 181 | relationship | open | 1 | 181 | Even later payoff anchor |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 1 | Harbor Ash | Lin Yue | He survives the harbor fallout | The debt line opens | long-payoff-1 seeded | tense | opening |",
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);

      await manager.ensureRuntimeState(bookId, 1);

      const manifest = JSON.parse(
        await readFile(join(manager.stateDir(bookId), "manifest.json"), "utf-8"),
      ) as { lastAppliedEpisode: number };

      expect(manifest.lastAppliedEpisode).toBe(1);
    });

    it("does not treat narrative digits inside hook markdown as runtime episode progress during bootstrap", async () => {
      const bookId = "runtime-state-narrative-digit-book";
      const storyDir = join(manager.bookDir(bookId), "story");
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 12 |",
            "| Current Goal | Continue after the imported twelfth episode |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| H001 | 1 | mystery | progressing | 《三体》游戏内第141号文明展开到墨子时代 | Reveal the threat | Narrative prose, not episode metadata |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            ...Array.from({ length: 12 }, (_, index) =>
              `| ${index + 1} | Ch${index + 1} | Lin Yue | Event ${index + 1} | Shift ${index + 1} | Hook ${index + 1} | tense | mainline |`),
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);

      await manager.ensureRuntimeState(bookId, 12);

      const manifest = JSON.parse(
        await readFile(join(manager.stateDir(bookId), "manifest.json"), "utf-8"),
      ) as { lastAppliedEpisode: number };
      const hooks = JSON.parse(
        await readFile(join(manager.stateDir(bookId), "hooks.json"), "utf-8"),
      ) as { hooks: Array<{ hookId: string; lastAdvancedEpisode: number }> };

      expect(manifest.lastAppliedEpisode).toBe(12);
      expect(hooks.hooks[0]?.hookId).toBe("H001");
      expect(hooks.hooks[0]?.lastAdvancedEpisode).toBe(0);
    });

    it("repairs poisoned manifest episode when it runs ahead of persisted runtime state", async () => {
      const bookId = "runtime-state-poisoned-book";
      const storyDir = join(manager.bookDir(bookId), "story");
      const stateDir = join(storyDir, "state");
      await mkdir(stateDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 2 |",
            "| Current Goal | Reach the ledger vault |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| vault-ledger | 1 | mystery | progressing | 2 | 4 | Ledger trail remains open |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 1 | Harbor Ash | Lin Yue | Survives the harbor fallout | Debt line opens | vault-ledger seeded | tense | opening |",
            "| 2 | Lantern Wharf | Lin Yue | Tracks the ledger to the wharf | Goal narrows to the vault | vault-ledger advanced | wary | investigation |",
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
          episode: 2,
          facts: [
            {
              subject: "protagonist",
              predicate: "Current Goal",
              object: "Reach the ledger vault",
              validFromEpisode: 2,
              validUntilEpisode: null,
              sourceEpisode: 2,
            },
          ],
        }, null, 2), "utf-8"),
        writeFile(join(stateDir, "hooks.json"), JSON.stringify({
          hooks: [
            {
              hookId: "vault-ledger",
              startEpisode: 1,
              type: "mystery",
              status: "progressing",
              lastAdvancedEpisode: 2,
              expectedPayoff: "4",
              notes: "Persisted structured hook state",
            },
          ],
        }, null, 2), "utf-8"),
        writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({
          rows: [
            {
              episode: 1,
              title: "Harbor Ash",
              characters: "Lin Yue",
              events: "Survives the harbor fallout",
              stateChanges: "Debt line opens",
              hookActivity: "vault-ledger seeded",
              mood: "tense",
              episodeType: "opening",
            },
            {
              episode: 2,
              title: "Lantern Wharf",
              characters: "Lin Yue",
              events: "Tracks the ledger to the wharf",
              stateChanges: "Goal narrows to the vault",
              hookActivity: "vault-ledger advanced",
              mood: "wary",
              episodeType: "investigation",
            },
          ],
        }, null, 2), "utf-8"),
      ]);

      await manager.ensureRuntimeState(bookId, 2);

      const manifest = JSON.parse(
        await readFile(join(stateDir, "manifest.json"), "utf-8"),
      ) as { lastAppliedEpisode: number };
      const currentState = JSON.parse(
        await readFile(join(stateDir, "current_state.json"), "utf-8"),
      ) as { episode: number; facts: Array<{ object: string }> };
      const hooks = JSON.parse(
        await readFile(join(stateDir, "hooks.json"), "utf-8"),
      ) as { hooks: Array<{ lastAdvancedEpisode: number }> };
      const summaries = JSON.parse(
        await readFile(join(stateDir, "episode_summaries.json"), "utf-8"),
      ) as { rows: Array<{ episodeNumber: number; title: string }> };

      expect(manifest.lastAppliedEpisode).toBe(2);
      expect(currentState.episode).toBe(2);
      expect(currentState.facts[0]?.object).toBe("Reach the ledger vault");
      expect(hooks.hooks[0]?.lastAdvancedEpisode).toBe(2);
      expect(summaries.rows.map((row) => row.episodeNumber)).toEqual([1, 2]);
      expect(summaries.rows.at(-1)?.title).toBe("Lantern Wharf");
    });

    it("normalizes emphasized hook ids when bootstrapping structured runtime state from markdown", async () => {
      const bookId = "runtime-state-emphasized-hook-book";
      const storyDir = join(manager.bookDir(bookId), "story");
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(storyDir, "current_state.md"),
          [
            "# Current State",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Current Episode | 3 |",
            "| Current Goal | Follow the ledger trail |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| **H009** | 3 | mystery | open | 3 | 9 | Bold markdown leaked into hook id |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(storyDir, "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 3 | Lantern Wharf | Lin Yue | Follows the ledger trail | Goal narrows to the ledger trail | H009 advanced | wary | investigation |",
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);

      await manager.ensureRuntimeState(bookId, 3);

      const hooks = JSON.parse(
        await readFile(join(manager.stateDir(bookId), "hooks.json"), "utf-8"),
      ) as { hooks: Array<{ hookId: string }> };

      expect(hooks.hooks.map((hook) => hook.hookId)).toEqual(["H009"]);
    });
  });

  // -------------------------------------------------------------------------
  // rollbackToEpisode — reject a episode and discard downstream state
  // -------------------------------------------------------------------------

  describe("rollbackToEpisode", () => {
    const bookId = "rollback-book";

    async function setupRollbackBook(): Promise<void> {
      await manager.saveBookConfig(bookId, {
        id: bookId,
        title: "Rollback Test",
        platform: "tomato",
        genre: "xuanhuan",
        status: "active",
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 10,
        episodeDurationSeconds: 90,
        createdAt: "2026-03-31T00:00:00Z",
        updatedAt: "2026-03-31T00:00:00Z",
      });

      const bookDir = manager.bookDir(bookId);
      const storyDir = join(bookDir, "story");
      const episodesDir = join(bookDir, "episodes");
      const runtimeDir = join(storyDir, "runtime");
      await mkdir(runtimeDir, { recursive: true });
      await mkdir(episodesDir, { recursive: true });

      // Write initial state (episode 0 baseline)
      await writeFile(join(storyDir, "current_state.md"), "# State\n\n- Initial state.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\n- hook-1\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Summaries\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8");
      await manager.snapshotState(bookId, 0);

      // Write episode 1 state + file
      await writeFile(join(storyDir, "current_state.md"), "# State\n\n- After episode 1.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\n- hook-1\n- hook-2\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Summaries\n\n| 1 | Title 1 |\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n\n| 1 | Title 1 |\n", "utf-8");
      await writeFile(join(episodesDir, "0001_Title_One.md"), "# Episode 1\n\nContent 1.", "utf-8");
      await writeFile(join(episodesDir, "0001_Title_One.md"), "# Episode 1\n\nContent 1.", "utf-8");
      await writeFile(join(episodesDir, "0001_Title_One.json"), "{}", "utf-8");
      await manager.snapshotState(bookId, 1);

      // Write episode 2 state + file
      await writeFile(join(storyDir, "current_state.md"), "# State\n\n- After episode 2.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\n- hook-1\n- hook-2\n- hook-3\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Summaries\n\n| 1 | Title 1 |\n| 2 | Title 2 |\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n\n| 1 | Title 1 |\n| 2 | Title 2 |\n", "utf-8");
      await writeFile(join(episodesDir, "0002_Title_Two.md"), "# Episode 2\n\nContent 2.", "utf-8");
      await writeFile(join(episodesDir, "0002_Title_Two.md"), "# Episode 2\n\nContent 2.", "utf-8");
      await writeFile(join(episodesDir, "0002_Title_Two.json"), "{}", "utf-8");
      await writeFile(join(runtimeDir, "episode-002.intent.md"), "intent 2", "utf-8");
      await writeFile(join(runtimeDir, "episode-0002.intent.md"), "intent 2", "utf-8");
      await manager.snapshotState(bookId, 2);

      // Write episode 3 state + file
      await writeFile(join(storyDir, "current_state.md"), "# State\n\n- After episode 3.\n", "utf-8");
      await writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n\n- hook-1\n- hook-2\n- hook-3\n- hook-4\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Summaries\n\n| 1 | Title 1 |\n| 2 | Title 2 |\n| 3 | Title 3 |\n", "utf-8");
      await writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n\n| 1 | Title 1 |\n| 2 | Title 2 |\n| 3 | Title 3 |\n", "utf-8");
      await writeFile(join(episodesDir, "0003_Title_Three.md"), "# Episode 3\n\nContent 3.", "utf-8");
      await writeFile(join(episodesDir, "0003_Title_Three.md"), "# Episode 3\n\nContent 3.", "utf-8");
      await writeFile(join(episodesDir, "0003_Title_Three.json"), "{}", "utf-8");
      await writeFile(join(runtimeDir, "episode-003.intent.md"), "intent 3", "utf-8");
      await writeFile(join(runtimeDir, "episode-0003.intent.md"), "intent 3", "utf-8");
      await writeFile(join(runtimeDir, "tier2_current_arc.md"), "stale current arc", "utf-8");
      await manager.snapshotState(bookId, 3);

      // Save index with all 3 episodes
      const now = "2026-03-31T00:00:00Z";
      await manager.saveEpisodeIndex(bookId, [
        { episodeNumber: 1, title: "Title One", status: "approved", episodeDurationSeconds: 100, createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] },
        { episodeNumber: 2, title: "Title Two", status: "ready-for-review", episodeDurationSeconds: 100, createdAt: now, updatedAt: now, auditIssues: [], lengthWarnings: [] },
        { episodeNumber: 3, title: "Title Three", status: "audit-failed", episodeDurationSeconds: 100, createdAt: now, updatedAt: now, auditIssues: ["pacing"], lengthWarnings: [] },
      ]);
    }

    it("restores state to the target episode and removes subsequent episodes", async () => {
      await setupRollbackBook();

      const discarded = await manager.rollbackToEpisode(bookId, 1);

      expect(discarded).toEqual([2, 3]);

      // State should be restored to episode 1 snapshot
      const bookDir = manager.bookDir(bookId);
      const state = await readFile(join(bookDir, "story", "current_state.md"), "utf-8");
      expect(state).toContain("After episode 1");
      expect(state).not.toContain("After episode 3");

      const hooks = await readFile(join(bookDir, "story", "pending_hooks.md"), "utf-8");
      expect(hooks).toContain("hook-2");
      expect(hooks).not.toContain("hook-4");

      // Episode index should only have episode 1
      const index = await manager.loadEpisodeIndex(bookId);
      expect(index).toHaveLength(1);
      expect(index[0]!.episodeNumber).toBe(1);
      expect(index[0]!.status).toBe("approved");

      // Episode files for 2 and 3 should be deleted
      const episodesDir = join(bookDir, "episodes");
      const { readdir: rd } = await import("node:fs/promises");
      const remaining = (await rd(episodesDir)).filter((f) => f.endsWith(".md"));
      expect(remaining).toEqual(["0001_Title_One.md"]);

      const remainingEpisodes = (await rd(join(bookDir, "episodes")))
        .filter((file) => file.endsWith(".md") || file.endsWith(".json"))
        .filter((file) => file !== "index.json")
        .sort();
      expect(remainingEpisodes).toEqual(["0001_Title_One.json", "0001_Title_One.md"]);

      const episodeSummaries = await readFile(join(bookDir, "story", "episode_summaries.md"), "utf-8");
      expect(episodeSummaries).toContain("| 1 | Title 1 |");
      expect(episodeSummaries).not.toContain("| 2 | Title 2 |");

      await expect(stat(join(bookDir, "story", "runtime", "episode-0002.intent.md"))).rejects.toThrow();

      // Snapshots for 2 and 3 should be deleted
      const snapshotsDir = join(bookDir, "story", "snapshots");
      const snapshots = await rd(snapshotsDir);
      expect(snapshots.sort()).toEqual(["0", "1"]);

      // Aggregate runtime diagnostics should be regenerated after rollback.
      await expect(stat(join(bookDir, "story", "runtime", "tier2_current_arc.md"))).rejects.toThrow();
    });

    it("rolls back to episode 0 (initial state) when rejecting episode 1", async () => {
      await setupRollbackBook();

      const discarded = await manager.rollbackToEpisode(bookId, 0);

      expect(discarded).toEqual([1, 2, 3]);

      const bookDir = manager.bookDir(bookId);
      const state = await readFile(join(bookDir, "story", "current_state.md"), "utf-8");
      expect(state).toContain("Initial state");

      const index = await manager.loadEpisodeIndex(bookId);
      expect(index).toHaveLength(0);
    });

    it("throws when the target snapshot does not exist", async () => {
      await setupRollbackBook();

      await expect(manager.rollbackToEpisode(bookId, 99)).rejects.toThrow("Cannot restore snapshot");
    });

    it("removes sqlite memory files when rolling back", async () => {
      await setupRollbackBook();

      const storyDir = join(manager.bookDir(bookId), "story");
      await Promise.all([
        writeFile(join(storyDir, "memory.db"), "stale db", "utf-8"),
        writeFile(join(storyDir, "memory.db-shm"), "stale shm", "utf-8"),
        writeFile(join(storyDir, "memory.db-wal"), "stale wal", "utf-8"),
      ]);

      await manager.rollbackToEpisode(bookId, 1);

      await expect(stat(join(storyDir, "memory.db"))).rejects.toThrow();
      await expect(stat(join(storyDir, "memory.db-shm"))).rejects.toThrow();
      await expect(stat(join(storyDir, "memory.db-wal"))).rejects.toThrow();
    });
  });
});
