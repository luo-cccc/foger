import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const writeNextEpisodeMock = vi.fn();
const buildPipelineConfigMock = vi.fn();
const loadConfigMock = vi.fn();
const loadBookConfigMock = vi.fn();
const getNextEpisodeNumberMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class {
    writeNextEpisode = writeNextEpisodeMock;
  },
  StateManager: class {
    async loadBookConfig() {
      return loadBookConfigMock();
    }
    async getNextEpisodeNumber() {
      return getNextEpisodeNumberMock();
    }
  },
}));

vi.mock("../utils.js", () => ({
  loadConfig: loadConfigMock,
  buildPipelineConfig: buildPipelineConfigMock,
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "auto-book"),
  getLegacyMigrationHint: vi.fn(async () => null),
  log: logMock,
  logError: logErrorMock,
}));

vi.mock("../localization.js", () => ({
  formatWriteNextProgress: vi.fn(() => "progress"),
  formatWriteNextResultLines: vi.fn(() => ["ok"]),
  formatWriteNextComplete: vi.fn(() => "done"),
  formatAutoWriteStart: vi.fn(() => "auto-start"),
  formatAutoWriteAlreadyComplete: vi.fn(() => "nothing-to-do"),
  resolveCliLanguage: vi.fn(() => "zh"),
}));

function episodeResult(episodeNumber: number, status = "ready-for-review") {
  return {
    episodeNumber,
    title: `第${episodeNumber}章`,
    episodeDurationSeconds: 3000,
    auditResult: { passed: true, issues: [], summary: "ok" },
    revised: false,
    status,
  };
}

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

describe("inkos auto command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadBookConfigMock.mockResolvedValue({
      language: "zh",
      writing: { reviewMode: "manual" },
    });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, reviewMode: "manual" },
    });
    buildPipelineConfigMock.mockReturnValue({});
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  it("writes from the current episode up to the target episode with forced auto review", async () => {
    getNextEpisodeNumberMock.mockResolvedValue(3);
    let episode = 2;
    writeNextEpisodeMock.mockImplementation(async () => episodeResult(++episode));

    const { autoCommand } = await import("../commands/auto.js");
    await autoCommand.parseAsync(["node", "auto", "demo-book", "5"], { from: "node" });

    expect(writeNextEpisodeMock).toHaveBeenCalledTimes(3);
    // reviewMode is "manual" on both book and project, but auto-write must
    // force the inline audit→revise loop.
    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ episodeReviewMode: "auto" }),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does nothing when the book already reached the target episode", async () => {
    getNextEpisodeNumberMock.mockResolvedValue(6);

    const { autoCommand } = await import("../commands/auto.js");
    await autoCommand.parseAsync(["node", "auto", "demo-book", "5"], { from: "node" });

    expect(writeNextEpisodeMock).not.toHaveBeenCalled();
    expect(buildPipelineConfigMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith("nothing-to-do");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("stops immediately when a episode write fails", async () => {
    getNextEpisodeNumberMock.mockResolvedValue(1);
    writeNextEpisodeMock
      .mockResolvedValueOnce(episodeResult(1))
      .mockRejectedValueOnce(new Error("LLM exploded"));

    const { autoCommand } = await import("../commands/auto.js");
    await autoCommand.parseAsync(["node", "auto", "demo-book", "3"], { from: "node" });

    expect(writeNextEpisodeMock).toHaveBeenCalledTimes(2);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Episode 2 failed"),
    );
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("LLM exploded"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stops when a episode ends in state-degraded status", async () => {
    getNextEpisodeNumberMock.mockResolvedValue(1);
    writeNextEpisodeMock
      .mockResolvedValueOnce(episodeResult(1))
      .mockResolvedValueOnce(episodeResult(2, "state-degraded"));

    const { autoCommand } = await import("../commands/auto.js");
    await autoCommand.parseAsync(["node", "auto", "demo-book", "3"], { from: "node" });

    expect(writeNextEpisodeMock).toHaveBeenCalledTimes(2);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("state-degraded"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stops immediately when a episode ends in audit-failed status", async () => {
    getNextEpisodeNumberMock.mockResolvedValue(1);
    writeNextEpisodeMock.mockResolvedValueOnce(episodeResult(1, "audit-failed"));

    const { autoCommand } = await import("../commands/auto.js");
    await autoCommand.parseAsync(["node", "auto", "demo-book", "3"], { from: "node" });

    expect(writeNextEpisodeMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("audit-failed"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
