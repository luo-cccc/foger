import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, type SchedulerConfig } from "../pipeline/scheduler.js";
import type { BookConfig } from "../models/book.js";
import { StateManager } from "../state/manager.js";
import {
  UnattendedStateStore,
  type UnattendedBookState,
} from "../pipeline/unattended-state.js";
import { ProviderContentPolicyError, type LLMCallTelemetry } from "../llm/provider.js";
import type { PipelineDiagnostic } from "../pipeline/diagnostics.js";
import {
  buildChapterRecoveryState,
  fingerprintChapterContent,
} from "../pipeline/chapter-recovery-policy.js";

function createConfig(): SchedulerConfig {
  return {
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 1024,
        thinkingBudget: 0,
      },
    } as SchedulerConfig["client"],
    model: "test-model",
    projectRoot: process.cwd(),
    writeCron: "*/1 * * * *",
    maxConcurrentBooks: 1,
    chaptersPerCycle: 1,
    retryDelayMs: 0,
    cooldownAfterChapterMs: 0,
    maxChaptersPerDay: 10,
  };
}

describe("Scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not start a second write cycle while one is still running", async () => {
    const scheduler = new Scheduler(createConfig());
    let releaseCycle: (() => void) | undefined;
    const blockedCycle = new Promise<void>((resolve) => {
      releaseCycle = resolve;
    });

    const runWriteCycle = vi
      .spyOn(scheduler as unknown as { runWriteCycle: () => Promise<void> }, "runWriteCycle")
      .mockImplementation(async () => {
        if (runWriteCycle.mock.calls.length === 1) {
          return;
        }
        await blockedCycle;
      });
    await scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWriteCycle).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWriteCycle).toHaveBeenCalledTimes(2);

    releaseCycle?.();
    await blockedCycle;
    scheduler.stop();
  });

  it("runs one restored write cycle without installing a recurring timer", async () => {
    const scheduler = new Scheduler(createConfig());
    const restore = vi.spyOn(
      scheduler as unknown as { restoreUnattendedState: () => Promise<void> },
      "restoreUnattendedState",
    ).mockResolvedValue(undefined);
    const cycle = vi.spyOn(
      scheduler as unknown as { triggerWriteCycle: () => Promise<void> },
      "triggerWriteCycle",
    ).mockResolvedValue(undefined);

    await scheduler.runOnce();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(scheduler.isRunning).toBe(false);
  });

  it("treats state-degraded chapter results as handled failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-degraded-result-"));
    const onChapterComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onChapterComplete,
    });
    const bookConfig: BookConfig = {
      id: "book-1",
      title: "Book 1",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 2200,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };

    vi.spyOn(
      (scheduler as unknown as { pipeline: { writeNextChapter: (bookId: string, words?: number, temp?: number) => Promise<unknown> } }).pipeline,
      "writeNextChapter",
    ).mockResolvedValue({
        chapterNumber: 3,
        title: "Broken State",
        wordCount: 2100,
        revised: false,
        status: "state-degraded",
        auditResult: {
          passed: true,
          issues: [{
            severity: "warning",
            category: "state-validation",
            description: "state validation still failed after retry",
            suggestion: "repair state before continuing",
          }],
          summary: "clean",
        },
    });
    const handleAuditFailure = vi.spyOn(
      scheduler as unknown as { handleAuditFailure: (bookId: string, chapterNumber: number, issueCategories?: string[]) => Promise<void> },
      "handleAuditFailure",
    ).mockResolvedValue(undefined);

    try {
      const success = await (
        scheduler as unknown as {
          writeOneChapter: (bookId: string, bookConfig: BookConfig) => Promise<boolean>;
        }
      ).writeOneChapter("book-1", bookConfig);

      expect(success).toBe(false);
      expect(handleAuditFailure).toHaveBeenCalledWith(
        "book-1",
        3,
        ["state-validation"],
        { kind: "state-degraded", action: "repair-state" },
      );
      expect(onChapterComplete).toHaveBeenCalledWith("book-1", 3, "state-degraded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses a degraded chapter before recovery when its current metrics exceed hard gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-degraded-budget-"));
    const onChapterComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onChapterComplete,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0.1,
        maxChapterTokens: 100,
        maxPromptTokensPerCall: 100,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerChapter: 0,
        minHardRangeRate: 0.8,
      },
    });
    const book = createBook("book-1");
    (scheduler as unknown as { telemetryByBook: Map<string, LLMCallTelemetry[]> }).telemetryByBook.set(
      book.id,
      [createTelemetry()],
    );
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { writeNextChapter: () => Promise<unknown> };
      }).pipeline,
      "writeNextChapter",
    ).mockResolvedValue(createPipelineResult("state-degraded"));

    try {
      const success = await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(success).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      expect(onChapterComplete).toHaveBeenCalledWith(book.id, 1, "state-degraded");
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastChapterNumber: 1,
        lastFailureKind: "budget",
      });
      expect(persisted.books[book.id]?.lastError).toContain("chapter tokens 150 > 100");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the full primary chapter result to unattended observers", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-result-callback-"));
    const onChapterResult = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onChapterResult,
    });
    const book = createBook("book-1");
    const result = createPipelineResult("ready-for-review");
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { writeNextChapter: () => Promise<unknown> };
      }).pipeline,
      "writeNextChapter",
    ).mockResolvedValue(result);
    vi.spyOn(
      scheduler as unknown as {
        completeChapter: () => Promise<boolean>;
      },
      "completeChapter",
    ).mockResolvedValue(true);

    try {
      await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(onChapterResult).toHaveBeenCalledWith(book.id, result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses instead of scheduling the same provider sample after a content-policy rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-content-policy-"));
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const book = createBook("policy-book");
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { writeNextChapter: () => Promise<unknown> };
      }).pipeline,
      "writeNextChapter",
    ).mockRejectedValue(new ProviderContentPolicyError({ service: "ark", model: "model-a" }));

    try {
      const success = await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(success).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastFailureKind: "provider-content-policy",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists transient provider overloads and restores retry state", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-overload-"));
    const config = { ...createConfig(), projectRoot: root, retryDelayMs: 30_000 };
    const scheduler = new Scheduler(config);

    try {
      await (
        scheduler as unknown as {
          handleAuditFailure: (
            bookId: string,
            chapterNumber: number,
            categories: string[],
            details: { kind: "provider-transient"; action: "retry-provider"; error: string },
          ) => Promise<void>;
        }
      ).handleAuditFailure("book-1", 0, [], {
        kind: "provider-transient",
        action: "retry-provider",
        error: "529 当前服务集群负载较高，请稍后重试",
      });

      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books["book-1"]).toMatchObject({
        status: "retry-wait",
        action: "retry-provider",
        consecutiveFailures: 1,
        lastFailureKind: "provider-transient",
      });
      expect(Date.parse(persisted.books["book-1"]?.nextAttemptAt ?? "")).toBeGreaterThan(Date.now());

      const restarted = new Scheduler(config);
      await (
        restarted as unknown as { restoreUnattendedState: () => Promise<void> }
      ).restoreUnattendedState();
      expect(restarted.isBookPaused("book-1")).toBe(false);
      expect((restarted as unknown as { retryWaitMs: (bookId: string) => number }).retryWaitMs("book-1")).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes an audit-failed chapter through revision instead of writing a new chapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-revise-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "audit-failed");
    const onChapterComplete = vi.fn();
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root, onChapterComplete });
    const pipeline = (scheduler as unknown as {
      pipeline: {
        writeNextChapter: (...args: unknown[]) => Promise<unknown>;
        reviseDraft: (...args: unknown[]) => Promise<unknown>;
      };
    }).pipeline;
    const writeNext = vi.spyOn(pipeline, "writeNextChapter");
    const revise = vi.spyOn(pipeline, "reviseDraft").mockResolvedValue({
      chapterNumber: 1,
      wordCount: 1000,
      fixedIssues: ["fixed"],
      applied: true,
      status: "ready-for-review",
    });

    try {
      const success = await (
        scheduler as unknown as { writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean> }
      ).writeOneChapter(book.id, book);

      expect(success).toBe(true);
      expect(revise).toHaveBeenCalledWith(book.id, 1, "auto");
      expect(writeNext).not.toHaveBeenCalled();
      expect(onChapterComplete).toHaveBeenCalledWith(book.id, 1, "ready-for-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs and then resyncs a state-degraded chapter before continuing", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-resync-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "state-degraded");
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const pipeline = (scheduler as unknown as {
      pipeline: {
        writeNextChapter: (...args: unknown[]) => Promise<unknown>;
        repairChapterState: (...args: unknown[]) => Promise<unknown>;
        resyncChapterArtifacts: (...args: unknown[]) => Promise<unknown>;
      };
    }).pipeline;
    const writeNext = vi.spyOn(pipeline, "writeNextChapter");
    const repair = vi.spyOn(pipeline, "repairChapterState").mockResolvedValue(
      createPipelineResult("state-degraded"),
    );
    const resync = vi.spyOn(pipeline, "resyncChapterArtifacts").mockResolvedValue(
      createPipelineResult("ready-for-review"),
    );

    try {
      const success = await (
        scheduler as unknown as { writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean> }
      ).writeOneChapter(book.id, book);

      expect(success).toBe(true);
      expect(repair).toHaveBeenCalledWith(book.id, 1);
      expect(resync).toHaveBeenCalledWith(book.id, 1);
      expect(writeNext).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes persisted structural evidence directly to one rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-structural-rewrite-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "audit-failed");
    const content = "Persisted chapter body.";
    const index = await state.loadChapterIndex(book.id);
    await state.saveChapterIndex(book.id, index.map((chapter) => ({
      ...chapter,
      recoveryState: buildChapterRecoveryState({
        content,
        issues: [{
          severity: "critical",
          category: "causal-structure",
          description: "The conflict resolves without its required cause.",
          suggestion: "Rebuild the causal sequence.",
          repairScope: "structural",
        }],
      }),
    })));
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const pipeline = (scheduler as unknown as {
      pipeline: {
        reviseDraft: (...args: unknown[]) => Promise<unknown>;
        rewriteChapter: (...args: unknown[]) => Promise<unknown>;
      };
    }).pipeline;
    const revise = vi.spyOn(pipeline, "reviseDraft");
    const rewrite = vi.spyOn(pipeline, "rewriteChapter").mockResolvedValue(
      createPipelineResult("ready-for-review"),
    );

    try {
      const success = await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(success).toBe(true);
      expect(rewrite).toHaveBeenCalledWith(book.id, 1, book.chapterWordCount);
      expect(revise).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists rewrite as the next action when a bounded revision is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-revision-escalation-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "audit-failed");
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const pipeline = (scheduler as unknown as {
      pipeline: { reviseDraft: (...args: unknown[]) => Promise<unknown> };
    }).pipeline;
    vi.spyOn(pipeline, "reviseDraft").mockResolvedValue({
      chapterNumber: 1,
      wordCount: 1000,
      fixedIssues: [],
      applied: false,
      status: "unchanged",
      skippedReason: "revision did not improve the chapter",
    });

    try {
      const success = await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(success).toBe(false);
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "retry-wait",
        action: "rewrite",
        attemptsByAction: { revise: 1 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses without another provider call after repair and resync were attempted for the same body", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-state-convergence-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "state-degraded");
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const fingerprint = fingerprintChapterContent("Persisted chapter body.");
    const internal = scheduler as unknown as {
      unattendedBooks: Map<string, UnattendedBookState>;
      pipeline: {
        repairChapterState: (...args: unknown[]) => Promise<unknown>;
        resyncChapterArtifacts: (...args: unknown[]) => Promise<unknown>;
      };
      writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
    };
    internal.unattendedBooks.set(book.id, {
      status: "retry-wait",
      action: "resync-state",
      consecutiveFailures: 1,
      failureDimensions: {},
      attemptsByAction: { "repair-state": 1, "resync-state": 1 },
      recoveryContentFingerprint: fingerprint,
      attemptsForContent: { "repair-state": 1, "resync-state": 1 },
      lastChapterNumber: 1,
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    const repair = vi.spyOn(internal.pipeline, "repairChapterState");
    const resync = vi.spyOn(internal.pipeline, "resyncChapterArtifacts");

    try {
      expect(await internal.writeOneChapter(book.id, book)).toBe(false);
      expect(repair).not.toHaveBeenCalled();
      expect(resync).not.toHaveBeenCalled();
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastFailureKind: "state-degraded",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses before state recovery when the persisted settlement budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-settlement-budget-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "state-degraded");
    const onChapterComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onChapterComplete,
      governanceCallLimits: { maxSettlementCallsPerChapter: 1 },
    });
    const internal = scheduler as unknown as {
      unattendedBooks: Map<string, UnattendedBookState>;
      pipeline: { repairChapterState: (...args: unknown[]) => Promise<unknown> };
    };
    internal.unattendedBooks.set(book.id, {
      status: "retry-wait",
      action: "repair-state",
      consecutiveFailures: 1,
      failureDimensions: { "state-validation": 1 },
      attemptsByAction: {},
      attemptsForContent: {},
      lastChapterNumber: 1,
      currentMetrics: {
        calls: 8,
        retries: 0,
        timeouts: 0,
        errors: 0,
        totalTokens: 80_000,
        maxPromptEstimatedTokens: 12_000,
        fallbacks: 0,
        revisionCalls: 1,
        settlementCalls: 1,
        withinHardRange: true,
      },
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    const repair = vi.spyOn(internal.pipeline, "repairChapterState");

    try {
      const success = await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(success).toBe(false);
      expect(repair).not.toHaveBeenCalled();
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      expect(onChapterComplete).toHaveBeenCalledWith(book.id, 1, "state-degraded");
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastChapterNumber: 1,
        lastFailureKind: "budget",
      });
      expect(persisted.books[book.id]?.lastError).toContain(
        "settlement calls 1 reached 1 before state recovery",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attributes recovery errors to the pending chapter and applies its accumulated budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-recovery-budget-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingChapter(state, book, "state-degraded");
    const onChapterComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onChapterComplete,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0.1,
        maxChapterTokens: 100,
        maxPromptTokensPerCall: 100,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerChapter: 0,
        minHardRangeRate: 0.8,
      },
    });
    (scheduler as unknown as { telemetryByBook: Map<string, LLMCallTelemetry[]> }).telemetryByBook.set(
      book.id,
      [createTelemetry()],
    );
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { repairChapterState: () => Promise<unknown> };
      }).pipeline,
      "repairChapterState",
    ).mockRejectedValue(new Error("state repair failed"));

    try {
      const success = await (scheduler as unknown as {
        writeOneChapter: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneChapter(book.id, book);

      expect(success).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      expect(onChapterComplete).toHaveBeenCalledWith(book.id, 1, "state-degraded");
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastChapterNumber: 1,
        lastFailureKind: "budget",
      });
      expect(persisted.books[book.id]?.lastError).toContain("chapter tokens 150 > 100");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses durably when chapter runtime metrics exceed unattended gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-budget-"));
    const book = createBook("book-1");
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0.1,
        maxChapterTokens: 100,
        maxPromptTokensPerCall: 20,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerChapter: 0,
        minHardRangeRate: 0.8,
      },
    });
    (scheduler as unknown as { telemetryByBook: Map<string, LLMCallTelemetry[]> }).telemetryByBook.set(
      book.id,
      [createTelemetry()],
    );
    (scheduler as unknown as { diagnosticsByBook: Map<string, PipelineDiagnostic[]> }).diagnosticsByBook.set(
      book.id,
      [{
        kind: "canon-fallback",
        severity: "warning",
        agent: "canon-extractor",
        phase: "extract",
        message: "fallback",
        timestamp: "2026-04-01T00:00:00.000Z",
        bookId: book.id,
        chapterNumber: 1,
      }],
    );

    try {
      const passed = await (
        scheduler as unknown as {
          completeChapter: (
            bookId: string,
            config: BookConfig,
            chapterNumber: number,
            withinHardRange: boolean,
          ) => Promise<boolean>;
        }
      ).completeChapter(book.id, book, 1, false);

      expect(passed).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      const persisted = await new UnattendedStateStore(root).load();
      const state = persisted.books[book.id];
      expect(state?.lastFailureKind).toBe("budget");
      expect(state?.lastError).toContain("chapter tokens 150 > 100");
      expect(state?.lastError).toContain("max prompt 25 > 20");
      expect(state?.lastError).toContain("retry rate 2.000 > 0.2");
      expect(state?.lastError).toContain("timeout rate 1.000 > 0");
      expect(state?.lastError).toContain("fallbacks 1 > 0");
      expect(state?.lastError).toContain("hard-range rate 0.000 < 0.8");
      expect(state?.totals).toMatchObject({ chapters: 1, totalTokens: 150, fallbacks: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("classifyUnattendedError", () => {
  it("classifies the localized connection wrapper as provider-transient", async () => {
    const { classifyUnattendedError } = await import("../pipeline/unattended-state.js");
    expect(classifyUnattendedError(
      new Error("无法连接到 API 服务。网络不通或被防火墙拦截"),
    )).toBe("provider-transient");
  });

  it("classifies provider content-policy rejection separately from auth and transient errors", async () => {
    const { classifyUnattendedError } = await import("../pipeline/unattended-state.js");
    expect(classifyUnattendedError(
      new Error("400 The request failed because the input may contain sensitive information."),
    )).toBe("provider-content-policy");
  });
});

function createBook(id: string): BookConfig {
  return {
    id,
    title: "Book 1",
    platform: "other",
    genre: "other",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 1000,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

function createChapterMeta(status: "audit-failed" | "state-degraded") {
  return {
    number: 1,
    title: "Chapter 1",
    status,
    wordCount: 1000,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
  };
}

async function seedPendingChapter(
  state: StateManager,
  book: BookConfig,
  status: "audit-failed" | "state-degraded",
): Promise<void> {
  const chaptersDir = join(state.bookDir(book.id), "chapters");
  await mkdir(chaptersDir, { recursive: true });
  await Promise.all([
    state.saveBookConfig(book.id, book),
    state.saveChapterIndex(book.id, [createChapterMeta(status)]),
    writeFile(
      join(chaptersDir, "0001_Chapter_1.md"),
      "# Chapter 1\n\nPersisted chapter body.",
      "utf-8",
    ),
  ]);
}

function createPipelineResult(status: "ready-for-review" | "state-degraded") {
  return {
    chapterNumber: 1,
    title: "Chapter 1",
    wordCount: 1000,
    revised: false,
    status,
    auditResult: {
      passed: status === "ready-for-review",
      issues: [],
      summary: status,
    },
  };
}

function createTelemetry(): LLMCallTelemetry {
  return {
    bookId: "book-1",
    operationId: "00000000-0000-4000-8000-000000000001",
    agent: "writer",
    model: "test-model",
    service: "test-service",
    apiFormat: "chat",
    stream: false,
    phase: "write",
    durationMs: 100,
    attemptCount: 3,
    retryCount: 2,
    promptAssembly: {
      totalChars: 100,
      estimatedTokens: 25,
      messages: [],
      sources: [],
      duplicateSourceGroups: [],
    },
    status: "timeout",
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    timestamp: "2026-04-01T00:00:00.000Z",
  };
}
