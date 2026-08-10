import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const writeNextEpisodeMock = vi.fn();
const auditDraftMock = vi.fn();
const reviseDraftMock = vi.fn();
const dispatchNotificationMock = vi.fn();
const buildPipelineConfigMock = vi.fn();
const loadConfigMock = vi.fn();
const loadBookConfigMock = vi.fn();
const getNextEpisodeNumberMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@actalk/inkos-core", () => ({
  ReviseModeSchema: {
    parse: (value: string) => {
      if (["auto", "polish", "rewrite", "rework", "anti-detect", "spot-fix"].includes(value)) return value;
      throw new Error(`Invalid revise mode: ${value}`);
    },
  },
  PipelineRunner: class {
    writeNextEpisode = writeNextEpisodeMock;
    auditDraft = auditDraftMock;
    reviseDraft = reviseDraftMock;
  },
  StateManager: class {
    async loadBookConfig() {
      return loadBookConfigMock();
    }
    async getNextEpisodeNumber() {
      return getNextEpisodeNumberMock();
    }
  },
  executeCoreMutation: async (
    dependencies: { pipeline?: { auditDraft?: (bookId: string, episodeNumber?: number) => Promise<unknown> } },
    command: { kind: string; bookId: string; episodeNumber?: number },
  ) => {
    if (command.kind === "audit-episode" && dependencies.pipeline?.auditDraft) {
      return await dependencies.pipeline.auditDraft(command.bookId, command.episodeNumber);
    }
    throw new Error(`Unexpected core mutation in test: ${command.kind}`);
  },
  dispatchNotification: dispatchNotificationMock,
  resolveEpisodeReviewMode: vi.fn(() => "auto"),
  resolveRevisionGate: vi.fn(() => undefined),
  DEFAULT_REVISE_MODE: "spot-fix",
  // Real localization.ts imports these from core; keep them deterministic.
  formatLengthCount: (count: number) => `${count}s`,
  resolveLengthCountingMode: () => "seconds",
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

const notifyChannels = [
  { type: "telegram", botToken: "123:ABC", chatId: "-100", format: "text" },
];

function episodeResult(episodeNumber: number, status = "ready-for-review") {
  return {
    episodeNumber,
    title: `第${episodeNumber}集`,
    episodeDurationSeconds: 90,
    auditResult: { passed: true, issues: [], summary: "ok" },
    revised: false,
    status,
  };
}

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

describe("--notify command option", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loadBookConfigMock.mockResolvedValue({
      title: "示例书",
      language: "zh",
      writing: {},
    });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1 },
      notify: notifyChannels,
    });
    buildPipelineConfigMock.mockReturnValue({});
    dispatchNotificationMock.mockResolvedValue(undefined);
  });

  afterAll(() => {
    exitSpy.mockRestore();
  });

  describe("write next", () => {
    it("skips the success notification for a single-episode run (pipeline already notified per episode)", async () => {
      writeNextEpisodeMock.mockResolvedValueOnce(episodeResult(4));

      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(["node", "write", "next", "demo-book", "--notify"], { from: "node" });

      expect(writeNextEpisodeMock).toHaveBeenCalledTimes(1);
      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("sends one batch summary for a multi-episode run", async () => {
      let episode = 3;
      writeNextEpisodeMock.mockImplementation(async () => episodeResult(++episode));

      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(
        ["node", "write", "next", "demo-book", "--count", "2", "--notify"],
        { from: "node" },
      );

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [channels, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(channels).toBe(notifyChannels);
      expect(message.title).toBe("✅ 写作完成《示例书》");
      expect(message.body).toContain("本次完成 2 集（第4集到第5集）");
      expect(message.body).toContain("第4集 第4集 | 90s | 审计通过");
    });

    it("does not send a batch summary without --notify", async () => {
      let episode = 3;
      writeNextEpisodeMock.mockImplementation(async () => episodeResult(++episode));

      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(
        ["node", "write", "next", "demo-book", "--count", "2"],
        { from: "node" },
      );

      expect(dispatchNotificationMock).not.toHaveBeenCalled();
    });

    it("sends a failure notification with the error message before exiting", async () => {
      writeNextEpisodeMock.mockRejectedValueOnce(new Error("LLM exploded"));

      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(["node", "write", "next", "demo-book", "--notify"], { from: "node" });

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("❌ 写作失败《示例书》");
      expect(message.body).toContain("LLM exploded");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("sends no failure notification without --notify", async () => {
      writeNextEpisodeMock.mockRejectedValueOnce(new Error("LLM exploded"));

      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("write rewrite", () => {
    it("sends a failure notification when the command fails", async () => {
      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(
        ["node", "write", "rewrite", "a", "b", "c", "--notify"],
        { from: "node" },
      );

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [channels, message] = dispatchNotificationMock.mock.calls[0]!;
      // Failure happened before the book config was loaded: helper loads the
      // project config itself and falls back to zh with no book name.
      expect(channels).toBe(notifyChannels);
      expect(message.title).toBe("❌ 重写失败");
      expect(message.body).toContain("Usage: inkos write rewrite");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("audit", () => {
    it("sends a completion notification with the audit verdict", async () => {
      auditDraftMock.mockResolvedValueOnce({
        episodeNumber: 4,
        passed: true,
        issues: [],
        summary: "整体一致",
      });

      const { auditCommand } = await import("../commands/audit.js");
      await auditCommand.parseAsync(["node", "audit", "demo-book", "--notify"], { from: "node" });

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [channels, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(channels).toBe(notifyChannels);
      expect(message.title).toBe("✅ 审计完成《示例书》");
      expect(message.body).toBe("第4集审计通过（0 个问题）\n整体一致");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("uses English copy when the book language is en", async () => {
      loadBookConfigMock.mockResolvedValue({ title: "My Book", language: "en", writing: {} });
      auditDraftMock.mockResolvedValueOnce({
        episodeNumber: 2,
        passed: false,
        issues: [{ severity: "major", category: "timeline", description: "conflict" }],
        summary: "timeline conflict",
      });

      const { auditCommand } = await import("../commands/audit.js");
      await auditCommand.parseAsync(["node", "audit", "demo-book", "--notify"], { from: "node" });

      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("✅ Audit complete: My Book");
      expect(message.body).toBe("Episode 2 audit failed (1 issue(s))\ntimeline conflict");
    });

    it("warns and skips when --notify is set but no channels are configured", async () => {
      loadConfigMock.mockResolvedValue({ llm: {}, writing: { reviewRetries: 1 }, notify: [] });
      auditDraftMock.mockResolvedValueOnce({
        episodeNumber: 4,
        passed: true,
        issues: [],
        summary: "ok",
      });

      const { auditCommand } = await import("../commands/audit.js");
      await auditCommand.parseAsync(["node", "audit", "demo-book", "--notify"], { from: "node" });

      expect(dispatchNotificationMock).not.toHaveBeenCalled();
      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("--notify"));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not let a notification failure change the command exit code", async () => {
      dispatchNotificationMock.mockRejectedValueOnce(new Error("network down"));
      auditDraftMock.mockResolvedValueOnce({
        episodeNumber: 4,
        passed: true,
        issues: [],
        summary: "ok",
      });

      const { auditCommand } = await import("../commands/audit.js");
      await auditCommand.parseAsync(["node", "audit", "demo-book", "--notify"], { from: "node" });

      expect(logErrorMock).toHaveBeenCalledWith(expect.stringContaining("network down"));
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("sends a failure notification when the audit fails", async () => {
      auditDraftMock.mockRejectedValueOnce(new Error("no episodes"));

      const { auditCommand } = await import("../commands/audit.js");
      await auditCommand.parseAsync(["node", "audit", "demo-book", "--notify"], { from: "node" });

      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("❌ 审计失败《示例书》");
      expect(message.body).toContain("no episodes");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("revise", () => {
    it("sends a completion notification when the revision is applied", async () => {
      reviseDraftMock.mockResolvedValueOnce({
        episodeNumber: 3,
        episodeDurationSeconds: 90,
        fixedIssues: ["fix a", "fix b"],
        applied: true,
        status: "ready-for-review",
      });

      const { reviseCommand } = await import("../commands/revise.js");
      await reviseCommand.parseAsync(["node", "revise", "demo-book", "3", "--notify"], { from: "node" });

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("✅ 修订完成《示例书》");
      expect(message.body).toBe("第3集已修订 | 90s | 修复 2 个问题");
    });

    it("reports a kept original draft with the skip reason", async () => {
      reviseDraftMock.mockResolvedValueOnce({
        episodeNumber: 3,
        episodeDurationSeconds: 90,
        fixedIssues: [],
        applied: false,
        status: "unchanged",
        skippedReason: "无阻断问题",
      });

      const { reviseCommand } = await import("../commands/revise.js");
      await reviseCommand.parseAsync(["node", "revise", "demo-book", "3", "--notify"], { from: "node" });

      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("✅ 修订完成《示例书》");
      expect(message.body).toBe("第3集保留原稿：无阻断问题");
    });

    it("sends a failure notification when the revision fails", async () => {
      reviseDraftMock.mockRejectedValueOnce(new Error("revision blew up"));

      const { reviseCommand } = await import("../commands/revise.js");
      await reviseCommand.parseAsync(["node", "revise", "demo-book", "3", "--notify"], { from: "node" });

      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("❌ 修订失败《示例书》");
      expect(message.body).toContain("revision blew up");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("auto", () => {
    it("sends one batch summary for a multi-episode run", async () => {
      getNextEpisodeNumberMock.mockResolvedValue(1);
      let episode = 0;
      writeNextEpisodeMock.mockImplementation(async () => episodeResult(++episode));

      const { autoCommand } = await import("../commands/auto.js");
      await autoCommand.parseAsync(["node", "auto", "demo-book", "3", "--notify"], { from: "node" });

      expect(writeNextEpisodeMock).toHaveBeenCalledTimes(3);
      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("✅ 自动连写完成《示例书》");
      expect(message.body).toContain("本次完成 3 集（第1集到第3集）");
    });

    it("skips the success notification for a single-episode run (pipeline already notified per episode)", async () => {
      getNextEpisodeNumberMock.mockResolvedValue(3);
      writeNextEpisodeMock.mockResolvedValueOnce(episodeResult(3));

      const { autoCommand } = await import("../commands/auto.js");
      await autoCommand.parseAsync(["node", "auto", "demo-book", "3", "--notify"], { from: "node" });

      expect(dispatchNotificationMock).not.toHaveBeenCalled();
    });

    it("sends a failure notification when a episode write fails mid-run", async () => {
      getNextEpisodeNumberMock.mockResolvedValue(1);
      writeNextEpisodeMock
        .mockResolvedValueOnce(episodeResult(1))
        .mockRejectedValueOnce(new Error("LLM exploded"));

      const { autoCommand } = await import("../commands/auto.js");
      await autoCommand.parseAsync(["node", "auto", "demo-book", "3", "--notify"], { from: "node" });

      expect(dispatchNotificationMock).toHaveBeenCalledTimes(1);
      const [, message] = dispatchNotificationMock.mock.calls[0]!;
      expect(message.title).toBe("❌ 自动连写失败《示例书》");
      expect(message.body).toContain("Episode 2 failed");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
