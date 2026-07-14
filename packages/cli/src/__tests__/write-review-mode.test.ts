import { beforeEach, describe, expect, it, vi } from "vitest";

const writeNextChapterMock = vi.fn();
const buildPipelineConfigMock = vi.fn();
const loadConfigMock = vi.fn();
const loadBookConfigMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class {
    writeNextChapter = writeNextChapterMock;
  },
  StateManager: class {
    async loadBookConfig() {
      return loadBookConfigMock();
    }
  },
  // Mirrors the real core implementation: book-level overrides project-level,
  // both unset falls back to "auto". The real function is unit-tested in
  // packages/core/src/__tests__/chapter-review-mode.test.ts.
  resolveChapterReviewMode: (
    book: { writing?: { reviewMode?: "auto" | "manual" } },
    projectWriting?: { reviewMode?: "auto" | "manual" },
  ) => book.writing?.reviewMode ?? projectWriting?.reviewMode ?? "auto",
}));

vi.mock("../utils.js", () => ({
  loadConfig: loadConfigMock,
  buildPipelineConfig: buildPipelineConfigMock,
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "auto-book"),
  getLegacyMigrationHint: vi.fn(async () => null),
  resolveContext: vi.fn(async () => undefined),
  log: logMock,
  logError: logErrorMock,
}));

vi.mock("../localization.js", () => ({
  formatChapterRecoveryNotice: vi.fn(() => null),
  formatWriteNextProgress: vi.fn(() => "progress"),
  formatWriteNextResultLines: vi.fn(() => ["ok"]),
  formatWriteNextComplete: vi.fn(() => "done"),
  resolveCliLanguage: vi.fn(() => "zh"),
}));

describe("inkos write next review mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeNextChapterMock.mockResolvedValue({
      chapterNumber: 4,
      title: "第四章",
      wordCount: 3000,
      auditResult: { passed: true, issues: [], summary: "ok" },
      revised: false,
      status: "ready-for-review",
    });
    buildPipelineConfigMock.mockReturnValue({});
  });

  it("passes book-level reviewMode into the pipeline config", async () => {
    loadBookConfigMock.mockResolvedValue({
      language: "zh",
      writing: { reviewMode: "manual" },
    });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, reviewMode: "auto" },
    });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ chapterReviewMode: "manual" }),
    );
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the project-level reviewMode when the book does not set one", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, reviewMode: "manual" },
    });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ chapterReviewMode: "manual" }),
    );
  });

  it("defaults to auto when neither book nor project sets a reviewMode", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({ llm: {}, writing: { reviewRetries: 1 } });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ chapterReviewMode: "auto" }),
    );
  });

  it("adds a stable checkpoint to JSON write results", async () => {
    writeNextChapterMock.mockResolvedValue({
      chapterNumber: 4,
      title: "Chapter Four",
      wordCount: 3000,
      auditResult: { passed: true, issues: [], summary: "ok" },
      revised: false,
      status: "ready-for-review",
      operationId: "af846b1f-3be4-4a87-aad1-8e3f67d45f63",
      recovery: { kind: "rolled-back", chapterNumber: 4, rolledBackTo: 3, operationId: "interrupted-operation" },
    });
    loadBookConfigMock.mockResolvedValue({ language: "en" });
    loadConfigMock.mockResolvedValue({ llm: {}, writing: { reviewRetries: 1 } });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book", "--json"], { from: "node" });

    const output = logMock.mock.calls.map(([message]) => String(message)).find((message) => message.startsWith("[\n"));
    expect(output).toBeDefined();
    expect(JSON.parse(output!)).toMatchObject([{
      checkpoint: {
        operationId: "af846b1f-3be4-4a87-aad1-8e3f67d45f63",
        chapterNumber: 4,
        status: "ready-for-review",
        recovery: {
          kind: "rolled-back",
          chapterNumber: 4,
          rolledBackTo: 3,
          operationId: "interrupted-operation",
        },
      },
    }]);
  });

  it("stops a multi-chapter batch after audit-failed without starting another chapter", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({ llm: {}, writing: { reviewRetries: 1 } });
    writeNextChapterMock.mockResolvedValueOnce({
      chapterNumber: 4,
      title: "第四章",
      wordCount: 3000,
      auditResult: { passed: false, issues: [], summary: "needs review" },
      revised: false,
      status: "audit-failed",
    });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(
      ["node", "write", "next", "demo-book", "--count", "3"],
      { from: "node" },
    );

    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith("需要先处理审计问题，已停止后续连写。");
  });
});
