import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../state/manager.js";
import { evaluateBookQuality } from "../utils/book-eval.js";

describe("evaluateBookQuality", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("computes a reusable quality report from a persisted book", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-book-eval-"));
    const state = new StateManager(root);
    const now = new Date().toISOString();
    const book = {
      id: "demo-book",
      title: "Demo Book",
      platform: "other" as const,
      genre: "other" as const,
      status: "active" as const,
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 10,
      episodeDurationSeconds: 90,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(book.id, book);
    await state.ensureControlDocuments(book.id);
    await state.saveEpisodeIndex(book.id, [
      { episodeNumber: 1, title: "第一章", status: "approved", episodeDurationSeconds: 1200, auditIssues: [], lengthWarnings: [], createdAt: now, updatedAt: now },
      { episodeNumber: 2, title: "第一章", status: "audit-failed", episodeDurationSeconds: 900, auditIssues: ["pov drift"], lengthWarnings: [], createdAt: now, updatedAt: now },
    ]);
    const bookDir = state.bookDir(book.id);
    await mkdir(join(bookDir, "episodes"), { recursive: true });
    await writeFile(join(bookDir, "episodes", "0001_第一章.md"), "# 第一章\n\n他推开门，发现灯还亮着。", "utf-8");
    await writeFile(join(bookDir, "episodes", "0002_第一章.md"), "# 第一章\n\n她沉默。\n\n然后转身。", "utf-8");
    await writeFile(join(bookDir, "story", "pending_hooks.md"), "| 伏笔 | 状态 |\n| --- | --- |\n| 旧信 | 已回收 |\n", "utf-8");

    const report = await evaluateBookQuality({ state, bookId: book.id });

    expect(report).toMatchObject({
      bookId: "demo-book",
      totalEpisodes: 2,
      duplicateTitles: 1,
      hookResolveRate: 100,
    });
    expect(report.qualityScore).toBeGreaterThanOrEqual(0);
    expect(report.qualityTrend).toHaveLength(2);
    expect(report.episodes[1]).toMatchObject({
      episodeNumber: 2,
      auditIssueCount: 1,
      status: "audit-failed",
    });
  });
});
