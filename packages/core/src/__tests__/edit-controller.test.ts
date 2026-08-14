import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EpisodeMeta } from "../models/episode.js";
import {
  classifyTruthAuthority,
  normalizeTruthFileName,
} from "../interaction/truth-authority.js";
import {
  executeEditTransaction,
  MANUAL_EPISODE_EDIT_ISSUE,
  planEditTransaction,
  type EditRequest,
} from "../interaction/edit-controller.js";
import { createEpisodeScriptJson, createEpisodeScriptMarkdown } from "./episode-test-fixtures.js";

let projectRoot: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "inkos-edit-controller-"));
  await mkdir(join(projectRoot, "books", "harbor", "story", "runtime"), { recursive: true });
  await mkdir(join(projectRoot, "books", "harbor", "episodes"), { recursive: true });
});

describe("truth authority", () => {
  it("normalizes supported truth files", () => {
    expect(normalizeTruthFileName("story_bible")).toBe("story_bible.md");
    expect(normalizeTruthFileName("current_state.md")).toBe("current_state.md");
  });

  it("rejects absolute and traversing truth-file names", () => {
    expect(() => normalizeTruthFileName("../book_rules.md")).toThrow(/Invalid truth file name/);
    expect(() => normalizeTruthFileName("story\\book_rules.md")).toThrow(/Invalid truth file name/);
    expect(() => normalizeTruthFileName("/tmp/book_rules.md")).toThrow(/Invalid truth file name/);
  });

  it("classifies control and truth authority tiers", () => {
    expect(classifyTruthAuthority("author_intent.md")).toBe("direction");
    expect(classifyTruthAuthority("current_focus.md")).toBe("direction");
    expect(classifyTruthAuthority("story_bible.md")).toBe("foundation");
    expect(classifyTruthAuthority("book_rules.md")).toBe("rules");
    expect(classifyTruthAuthority("current_state.md")).toBe("runtime-truth");
  });
});

describe("edit controller", () => {
  it("plans entity rename transactions", () => {
    const result = planEditTransaction({
      kind: "entity-rename",
      bookId: "harbor",
      entityType: "protagonist",
      oldValue: "陆尘",
      newValue: "林戊",
    });

    expect(result.transactionType).toBe("entity-rename");
    expect(result.affectedScope).toBe("book");
    expect(result.requiresTruthRebuild).toBe(true);
  });

  it("plans episode rewrite transactions", () => {
    const result = planEditTransaction({
      kind: "episode-rewrite",
      bookId: "harbor",
      episodeNumber: 3,
      instruction: "Keep the ending reveal.",
    });

    expect(result.transactionType).toBe("episode-rewrite");
    expect(result.affectedScope).toBe("downstream");
    expect(result.requiresTruthRebuild).toBe(true);
  });

  it("plans whole-episode replacement transactions as episode-scoped edits", () => {
    const result = planEditTransaction({
      kind: "episode-replace",
      bookId: "harbor",
      episodeNumber: 3,
      fullText: "# 第3章 新稿\n\n完整替换正文。",
    });

    expect(result.transactionType).toBe("episode-replace");
    expect(result.affectedScope).toBe("episode");
    expect(result.requiresTruthRebuild).toBe(true);
  });

  it("plans local text edits without forcing full-book rebuild", () => {
    const result = planEditTransaction({
      kind: "episode-local-edit",
      bookId: "harbor",
      episodeNumber: 5,
      instruction: "Only rewrite the final paragraph.",
    });

    expect(result.transactionType).toBe("episode-local-edit");
    expect(result.affectedScope).toBe("episode");
    expect(result.requiresTruthRebuild).toBe(true);
  });

  it("plans focus edits as direction-level transactions", () => {
    const result = planEditTransaction({
      kind: "focus-edit",
      bookId: "harbor",
      instruction: "Bring the story back to the old case.",
    });

    expect(result.transactionType).toBe("focus-edit");
    expect(result.truthAuthority).toBe("direction");
    expect(result.affectedScope).toBe("future");
    expect(result.requiresTruthRebuild).toBe(false);
  });

  it("executes entity rename across truth files and episodes", async () => {
    const bookDir = join(projectRoot, "books", "harbor");
    await writeFile(join(bookDir, "story", "story_bible.md"), "主角陆尘住在港口。", "utf-8");
    await writeFile(join(bookDir, "episodes", "0001_旧名字.md"), "# 第1章 旧名字\n\n陆尘走进港口。", "utf-8");

    const result = await executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => [],
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "entity-rename",
        bookId: "harbor",
        entityType: "protagonist",
        oldValue: "陆尘",
        newValue: "林戊",
      },
    );

    await expect(readFile(join(bookDir, "story", "story_bible.md"), "utf-8")).resolves.toContain("林戊");
    await expect(readFile(join(bookDir, "episodes", "0001_旧名字.md"), "utf-8")).resolves.toContain("林戊");
    expect(result.touchedFiles.length).toBeGreaterThan(0);
  });

  it("does not rewrite story snapshots during entity rename", async () => {
    const bookDir = join(projectRoot, "books", "harbor");
    await writeFile(join(bookDir, "story", "story_bible.md"), "主角陆尘住在港口。", "utf-8");
    await mkdir(join(bookDir, "story", "snapshots", "1"), { recursive: true });
    await writeFile(join(bookDir, "story", "snapshots", "1", "current_state.md"), "陆尘在旧快照里。", "utf-8");

    await executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => [],
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "entity-rename",
        bookId: "harbor",
        entityType: "protagonist",
        oldValue: "陆尘",
        newValue: "林戊",
      },
    );

    await expect(readFile(join(bookDir, "story", "story_bible.md"), "utf-8")).resolves.toContain("林戊");
    await expect(readFile(join(bookDir, "story", "snapshots", "1", "current_state.md"), "utf-8")).resolves.toContain("陆尘");
  });

  it("renames entity files whose filename embeds the old name so path references don't dangle", async () => {
    const bookDir = join(projectRoot, "books", "rolebook");
    await mkdir(join(bookDir, "roles", "主要角色"), { recursive: true });
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "roles", "主要角色", "陈default.md"), "# 陈default\n\n陈default是主角。", "utf-8");
    // A manifest that references the role file by path — the path must follow the rename.
    await writeFile(join(bookDir, "story", "story_bible.md"), "主角档案见 roles/主要角色/陈default.md。", "utf-8");

    const result = await executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => [],
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "entity-rename",
        bookId: "rolebook",
        entityType: "protagonist",
        oldValue: "陈default",
        newValue: "陈烬",
      },
    );

    // The file is renamed on disk and its content updated.
    await expect(readFile(join(bookDir, "roles", "主要角色", "陈烬.md"), "utf-8")).resolves.toContain("陈烬");
    // The old filename is gone — no dangling reference.
    await expect(access(join(bookDir, "roles", "主要角色", "陈default.md")).then(() => true).catch(() => false))
      .resolves.toBe(false);
    // The manifest's path reference now points at the renamed file.
    await expect(readFile(join(bookDir, "story", "story_bible.md"), "utf-8"))
      .resolves.toContain("roles/主要角色/陈烬.md");
    expect(result.touchedFiles).toContain(join("roles", "主要角色", "陈烬.md"));
    expect(result.summary).toContain("renamed on disk");
  });

  it("aborts an entity rename when the target filename already exists, without rewriting content", async () => {
    const bookDir = join(projectRoot, "books", "collisionbook");
    await mkdir(join(bookDir, "roles", "主要角色"), { recursive: true });
    await writeFile(join(bookDir, "roles", "主要角色", "甲.md"), "甲的档案。", "utf-8");
    await writeFile(join(bookDir, "roles", "主要角色", "乙.md"), "乙的档案,提到甲。", "utf-8");

    await expect(executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => [],
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "entity-rename",
        bookId: "collisionbook",
        entityType: "character",
        oldValue: "甲",
        newValue: "乙",
      },
    )).rejects.toThrow(/already exists/);

    // The collision is detected before any write — content stays untouched (no partial application).
    await expect(readFile(join(bookDir, "roles", "主要角色", "乙.md"), "utf-8")).resolves.toBe("乙的档案,提到甲。");
  });

  it("rejects a rename target that contains a path separator", async () => {
    await expect(executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => [],
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "entity-rename",
        bookId: "harbor",
        entityType: "character",
        oldValue: "陆尘",
        newValue: "../evil",
      },
    )).rejects.toThrow(/path separators/);
  });

  it("rejects local edits against legacy prose episodes", async () => {
    const bookDir = join(projectRoot, "books", "harbor");
    await writeFile(join(bookDir, "episodes", "0003_灰墙榜下.md"), "# 第3章 灰墙榜下\n\n旧名字在这里。", "utf-8");
    await writeFile(join(bookDir, "story", "runtime", "episode-0003.intent.md"), "stale", "utf-8");
    const episodeIndex = [{
      episodeNumber: 3,
      title: "灰墙榜下",
      status: "ready-for-review" as const,
      episodeDurationSeconds: 12,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
      lengthWarnings: [],
    }];

    await expect(executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => episodeIndex,
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "episode-local-edit",
        bookId: "harbor",
        episodeNumber: 3,
        instruction: "Replace old text",
        targetText: "旧名字",
        replacementText: "新名字",
      },
    )).rejects.toThrow(/EPISODE_JSON_AUTHORITY/);
    await expect(readFile(join(bookDir, "episodes", "0003_灰墙榜下.md"), "utf-8")).resolves.toContain("旧名字");
  });

  it("rejects whitespace patches against legacy prose episodes", async () => {
    const bookDir = join(projectRoot, "books", "harbor");
    await writeFile(
      join(bookDir, "episodes", "0004_雨巷.md"),
      "# 第4章 雨巷\n\n她把账本\n塞进外套里，继续往前走。",
      "utf-8",
    );
    const episodeIndex = [{
      episodeNumber: 4,
      title: "雨巷",
      status: "ready-for-review" as const,
      episodeDurationSeconds: 18,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
      lengthWarnings: [],
    }];

    await expect(executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => episodeIndex,
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "episode-local-edit",
        bookId: "harbor",
        episodeNumber: 4,
        instruction: "Patch wrapped text",
        targetText: "她把账本 塞进外套里",
        replacementText: "她把账本贴着胸口藏好",
      },
    )).rejects.toThrow(/EPISODE_JSON_AUTHORITY/);
  });

  it("rejects whole-episode replacement with legacy prose", async () => {
    const bookDir = join(projectRoot, "books", "replacebook");
    await mkdir(join(bookDir, "episodes"), { recursive: true });
    await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
    await writeFile(join(bookDir, "episodes", "0002_旧章.md"), "# 第2章 旧章\n\n旧正文。", "utf-8");
    await writeFile(join(bookDir, "story", "runtime", "episode-0002.plan.md"), "stale plan", "utf-8");
    const episodeIndex = [{
      episodeNumber: 2,
      title: "旧章",
      status: "ready-for-review" as const,
      episodeDurationSeconds: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
      lengthWarnings: [],
    }];

    await expect(executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => episodeIndex,
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "episode-replace",
        bookId: "replacebook",
        episodeNumber: 2,
        fullText: "# 第2章 新章\n\n新正文完整替换。",
      },
    )).rejects.toThrow(/EPISODE_JSON_AUTHORITY/);
    await expect(readFile(join(bookDir, "episodes", "0002_旧章.md"), "utf-8")).resolves.toContain("旧正文");
  });

  it("invalidates runtime and review sidecars after a valid episode replacement", async () => {
    const bookDir = join(projectRoot, "books", "replace-valid");
    await mkdir(join(bookDir, "episodes"), { recursive: true });
    await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
    const episodePath = join(bookDir, "episodes", "0002_Original.md");
    const episodeJsonPath = join(bookDir, "episodes", "0002_Original.json");
    const runtimePath = join(bookDir, "story", "runtime", "episode-0002.plan.md");
    const reviewPath = join(bookDir, "episodes", "0002_review.json");
    await writeFile(episodePath, createEpisodeScriptMarkdown(2, "Original"), "utf-8");
    await writeFile(episodeJsonPath, createEpisodeScriptJson(2, "Original"), "utf-8");
    await writeFile(runtimePath, "stale plan", "utf-8");
    await writeFile(reviewPath, "{}", "utf-8");
    const episodeIndex: EpisodeMeta[] = [{
      episodeNumber: 2,
      title: "Original",
      status: "ready-for-review",
      episodeDurationSeconds: 90,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
      lengthWarnings: [],
    }];
    let savedIndex: ReadonlyArray<EpisodeMeta> = [];

    const result = await executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => episodeIndex,
        saveEpisodeIndex: async (_bookId, index) => { savedIndex = index; },
      },
      {
        kind: "episode-replace",
        bookId: "replace-valid",
        episodeNumber: 2,
        fullText: createEpisodeScriptMarkdown(2, "Revised"),
      },
    );

    expect(await access(runtimePath).then(() => true).catch(() => false)).toBe(false);
    expect(await access(reviewPath).then(() => true).catch(() => false)).toBe(false);
    await expect(readFile(episodeJsonPath, "utf-8")).resolves.toContain('"title": "Revised"');
    await expect(readFile(episodePath, "utf-8")).resolves.toContain("Revised");
    expect(savedIndex[0]).toMatchObject({ status: "audit-failed" });
    expect(savedIndex[0]?.recoveryState?.blockingIssues[0]?.severity).toBe("critical");
    expect(result.touchedFiles).toEqual(expect.arrayContaining([
      join("story", "runtime", "episode-0002.plan.md"),
      join("episodes", "0002_review.json"),
    ]));
  });

  it("rolls back episode and derived files when index persistence fails", async () => {
    const bookDir = join(projectRoot, "books", "replace-rollback");
    await mkdir(join(bookDir, "episodes"), { recursive: true });
    await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
    const episodePath = join(bookDir, "episodes", "0002_Original.md");
    const episodeJsonPath = join(bookDir, "episodes", "0002_Original.json");
    const runtimePath = join(bookDir, "story", "runtime", "episode-0002.plan.md");
    const reviewPath = join(bookDir, "episodes", "0002_review.json");
    const original = createEpisodeScriptMarkdown(2, "Original");
    const originalJson = createEpisodeScriptJson(2, "Original");
    await writeFile(episodePath, original, "utf-8");
    await writeFile(episodeJsonPath, originalJson, "utf-8");
    await writeFile(runtimePath, "stale plan", "utf-8");
    await writeFile(reviewPath, "{\"status\":\"stale\"}", "utf-8");
    const episodeIndex: EpisodeMeta[] = [{
      episodeNumber: 2,
      title: "Original",
      status: "ready-for-review",
      episodeDurationSeconds: 90,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditIssues: [],
      lengthWarnings: [],
    }];
    const saveEpisodeIndex = vi.fn()
      .mockRejectedValueOnce(new Error("index write failed"))
      .mockResolvedValueOnce(undefined);

    await expect(executeEditTransaction(
      {
        bookDir: (bookId) => join(projectRoot, "books", bookId),
        loadEpisodeIndex: async () => episodeIndex,
        saveEpisodeIndex,
      },
      {
        kind: "episode-replace",
        bookId: "replace-rollback",
        episodeNumber: 2,
        fullText: createEpisodeScriptMarkdown(2, "Revised"),
      },
    )).rejects.toThrow("index write failed");

    await expect(readFile(episodePath, "utf-8")).resolves.toBe(original);
    await expect(readFile(episodeJsonPath, "utf-8")).resolves.toBe(originalJson);
    await expect(readFile(runtimePath, "utf-8")).resolves.toBe("stale plan");
    await expect(readFile(reviewPath, "utf-8")).resolves.toBe("{\"status\":\"stale\"}");
    expect(saveEpisodeIndex).toHaveBeenCalledTimes(2);
  });

  it("does not swallow unexpected filesystem errors while collecting editable files", async () => {
    const invalidRoot = join(projectRoot, "invalid-root.txt");
    await writeFile(invalidRoot, "not a directory", "utf-8");

    await expect(executeEditTransaction(
      {
        bookDir: () => invalidRoot,
        loadEpisodeIndex: async () => [],
        saveEpisodeIndex: async () => undefined,
      },
      {
        kind: "entity-rename",
        bookId: "harbor",
        entityType: "protagonist",
        oldValue: "陆尘",
        newValue: "林戊",
      },
    )).rejects.toThrow(/not a directory|ENOTDIR/i);
  });
});
