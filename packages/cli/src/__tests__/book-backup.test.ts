import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.fn();
const logErrorMock = vi.fn();
let projectRoot = "";

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  findProjectRoot: () => projectRoot,
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

describe("inkos book backup and restore commands", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-book-backup-cli-"));
    await setupBook(projectRoot, "harbor");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("creates, lists, and restores a whole-book backup", async () => {
    const { bookCommand } = await import("../commands/book.js");
    const bookDir = join(projectRoot, "books", "harbor");

    await bookCommand.parseAsync(["node", "book", "backup", "harbor", "--json"], { from: "node" });
    const created = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as { backupId: string };
    expect(created.backupId).toMatch(/^\d{8}-\d{6}/);

    await bookCommand.parseAsync(["node", "book", "backup", "harbor", "--list", "--json"], { from: "node" });
    const listed = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as {
      backups: ReadonlyArray<{ id: string }>;
    };
    expect(listed.backups.map((backup) => backup.id)).toContain(created.backupId);

    await writeFile(join(bookDir, "episodes", "0001_起风.md"), "改坏了。", "utf-8");
    await bookCommand.parseAsync(
      ["node", "book", "restore", "harbor", created.backupId, "--json"],
      { from: "node" },
    );
    const restored = JSON.parse(logMock.mock.calls.at(-1)?.[0] as string) as {
      restoredFrom: string;
      preRestoreBackupId: string | null;
    };
    expect(restored.restoredFrom).toBe(created.backupId);
    expect(restored.preRestoreBackupId).not.toBeNull();
    await expect(readFile(join(bookDir, "episodes", "0001_起风.md"), "utf-8"))
      .resolves.toBe("第一章原文。");
    await expect(access(join(bookDir, ".write.lock"))).rejects.toThrow();
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("reports a missing backup without changing the current book", async () => {
    const { bookCommand } = await import("../commands/book.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await bookCommand.parseAsync(
        ["node", "book", "restore", "harbor", "20990101-000000"],
        { from: "node" },
      );
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("not found"));
      expect(exitSpy).toHaveBeenCalledWith(1);
      await expect(readFile(join(projectRoot, "books", "harbor", "episodes", "0001_起风.md"), "utf-8"))
        .resolves.toBe("第一章原文。");
    } finally {
      exitSpy.mockRestore();
    }
  });
});

async function setupBook(root: string, bookId: string): Promise<void> {
  const bookDir = join(root, "books", bookId);
  await mkdir(join(bookDir, "episodes"), { recursive: true });
  const now = "2026-07-15T00:00:00.000Z";
  await writeFile(join(bookDir, "book.json"), JSON.stringify({
    id: bookId,
    title: "港湾",
    platform: "qidian",
    genre: "urban",
    status: "active",
    schemaVersion: "inkos-episode-v2",
    format: "screenplay",
    targetEpisodes: 100,
    episodeDurationSeconds: 90,
    language: "zh",
    createdAt: now,
    updatedAt: now,
  }), "utf-8");
  await writeFile(join(bookDir, "episodes", "index.json"), "[]", "utf-8");
  await writeFile(join(bookDir, "episodes", "0001_起风.md"), "第一章原文。", "utf-8");
}
