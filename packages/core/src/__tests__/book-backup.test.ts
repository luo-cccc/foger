import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bookBackupsDir,
  executeBookBackupCommand,
  listBookBackups,
} from "../state/book-backup.js";
import { StateManager } from "../state/manager.js";

const fixedClock = (iso: string) => () => new Date(iso);

describe("book backup and restore", () => {
  let projectRoot: string;
  let state: StateManager;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-book-backup-"));
    state = new StateManager(projectRoot);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("publishes validated backups atomically and omits transient lock files", async () => {
    const bookDir = await setupBook(projectRoot, "harbor");
    await writeFile(join(bookDir, ".chapter-persistence.json"), "transient", "utf-8");

    const result = await executeBookBackupCommand(state, {
      kind: "backup-book",
      bookId: "harbor",
      now: fixedClock("2026-07-15T08:12:33Z"),
    });

    expect(result).toMatchObject({ bookId: "harbor", backupId: "20260715-081233" });
    const backupDir = join(bookBackupsDir(state, "harbor"), "20260715-081233");
    await expect(readFile(join(backupDir, "chapters", "0001_起风.md"), "utf-8"))
      .resolves.toBe("第一章原文。");
    await expect(access(join(backupDir, ".write.lock"))).rejects.toThrow();
    await expect(access(join(backupDir, ".chapter-persistence.json"))).rejects.toThrow();
    expect((await listBookBackups(state, "harbor")).map((backup) => backup.id))
      .toEqual(["20260715-081233"]);
  });

  it("restores the whole book and preserves the replaced state in a pre-restore backup", async () => {
    const bookDir = await setupBook(projectRoot, "harbor");
    const original = await executeBookBackupCommand(state, {
      kind: "backup-book",
      bookId: "harbor",
      now: fixedClock("2026-07-15T08:00:00Z"),
    });
    if (!("backupId" in original)) throw new Error("Expected backup result");
    await writeFile(join(bookDir, "chapters", "0001_起风.md"), "改坏了的第一章。", "utf-8");
    await writeFile(join(bookDir, "chapters", "0002_多余.md"), "多写的一章。", "utf-8");

    const restored = await executeBookBackupCommand(state, {
      kind: "restore-book",
      bookId: "harbor",
      backupId: original.backupId,
      now: fixedClock("2026-07-15T09:00:00Z"),
    });

    expect(restored).toEqual({
      bookId: "harbor",
      restoredFrom: "20260715-080000",
      preRestoreBackupId: "20260715-090000-pre-restore",
    });
    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8"))
      .resolves.toBe("第一章原文。");
    await expect(access(join(bookDir, "chapters", "0002_多余.md"))).rejects.toThrow();
    const preRestoreDir = join(bookBackupsDir(state, "harbor"), "20260715-090000-pre-restore");
    await expect(readFile(join(preRestoreDir, "chapters", "0001_起风.md"), "utf-8"))
      .resolves.toBe("改坏了的第一章。");
  });

  it("rolls an interrupted restore back automatically when the next book lock is acquired", async () => {
    const bookDir = await setupBook(projectRoot, "harbor");
    await writeFile(join(bookDir, "chapters", "0001_起风.md"), "恢复前内容。", "utf-8");
    const preRestore = await executeBookBackupCommand(state, {
      kind: "backup-book",
      bookId: "harbor",
      now: fixedClock("2026-07-15T10:00:00Z"),
    });
    if (!("backupId" in preRestore)) throw new Error("Expected backup result");

    await writeFile(join(bookDir, "chapters", "0001_起风.md"), "只恢复了一半。", "utf-8");
    const restoreDir = join(projectRoot, ".inkos", "book-restore", "harbor");
    await mkdir(restoreDir, { recursive: true });
    await writeFile(join(restoreDir, "transaction.json"), JSON.stringify({
      version: 1,
      bookId: "harbor",
      status: "preparing",
      restoredFrom: "20260715-080000",
      preRestoreBackupId: preRestore.backupId,
    }), "utf-8");

    const nextProcessState = new StateManager(projectRoot);
    const release = await nextProcessState.acquireBookLock("harbor");
    await release();

    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8"))
      .resolves.toBe("恢复前内容。");
    await expect(access(restoreDir)).rejects.toThrow();
  });

  it("keeps a committed restore and only removes its leftover transaction", async () => {
    const bookDir = await setupBook(projectRoot, "harbor");
    await writeFile(join(bookDir, "chapters", "0001_起风.md"), "已经恢复的新内容。", "utf-8");
    const restoreDir = join(projectRoot, ".inkos", "book-restore", "harbor");
    await mkdir(restoreDir, { recursive: true });
    await writeFile(join(restoreDir, "transaction.json"), JSON.stringify({
      version: 1,
      bookId: "harbor",
      status: "committed",
      restoredFrom: "20260715-080000",
      preRestoreBackupId: "20260715-090000-pre-restore",
    }), "utf-8");

    const nextProcessState = new StateManager(projectRoot);
    const release = await nextProcessState.acquireBookLock("harbor");
    await release();

    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8"))
      .resolves.toBe("已经恢复的新内容。");
    await expect(access(restoreDir)).rejects.toThrow();
  });

  it("rejects a missing backup without creating an empty book directory", async () => {
    await expect(executeBookBackupCommand(state, {
      kind: "restore-book",
      bookId: "missing-book",
      backupId: "20990101-000000",
    })).rejects.toThrow(/not found/i);

    await expect(access(state.bookDir("missing-book"))).rejects.toThrow();
  });

  it("rejects unsafe or invalid backups before replacing the current book", async () => {
    const bookDir = await setupBook(projectRoot, "harbor");
    await expect(executeBookBackupCommand(state, {
      kind: "restore-book",
      bookId: "harbor",
      backupId: "../../harbor",
    })).rejects.toThrow(/backup id/i);

    const invalidDir = join(bookBackupsDir(state, "harbor"), "invalid-backup");
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(invalidDir, "book.json"), "{}", "utf-8");
    await expect(executeBookBackupCommand(state, {
      kind: "restore-book",
      bookId: "harbor",
      backupId: "invalid-backup",
    })).rejects.toThrow();
    await expect(readFile(join(bookDir, "chapters", "0001_起风.md"), "utf-8"))
      .resolves.toBe("第一章原文。");
  });
});

async function setupBook(projectRoot: string, bookId: string): Promise<string> {
  const bookDir = join(projectRoot, "books", bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story"), { recursive: true });
  const now = "2026-07-15T00:00:00.000Z";
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "港湾",
    platform: "qidian",
    genre: "urban",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 3000,
    language: "zh",
    createdAt: now,
    updatedAt: now,
  }), "utf-8");
  await writeFile(join(bookDir, "chapters", "index.json"), "[]", "utf-8");
  await writeFile(join(bookDir, "chapters", "0001_起风.md"), "第一章原文。", "utf-8");
  await writeFile(join(bookDir, "story", "current_state.md"), "原始状态", "utf-8");
  return bookDir;
}
