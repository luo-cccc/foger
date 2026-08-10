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
  buildEpisodeRecoveryState,
  fingerprintEpisodeContent,
} from "../pipeline/episode-recovery-policy.js";
import { createEpisodeScriptMarkdown } from "./episode-test-fixtures.js";

function skipPendingEpisodeLookup(scheduler: Scheduler): void {
  vi.spyOn(
    scheduler as unknown as { findLatestPendingEpisode: () => Promise<undefined> },
    "findLatestPendingEpisode",
  ).mockResolvedValue(undefined);
}

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
    episodesPerCycle: 1,
    retryDelayMs: 0,
    cooldownAfterEpisodeMs: 0,
    maxEpisodesPerDay: 10,
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
        await blockedCycle;
      });
    await scheduler.start();
    expect(runWriteCycle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWriteCycle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runWriteCycle).toHaveBeenCalledTimes(1);

    releaseCycle?.();
    await blockedCycle;
    await scheduler.stop();
  });

  it("honors a fixed wall-clock cron time", async () => {
    vi.setSystemTime(new Date(2026, 6, 24, 10, 29, 30));
    const scheduler = new Scheduler({ ...createConfig(), writeCron: "30 10 * * *" });
    const cycle = vi.spyOn(
      scheduler as unknown as { runWriteCycle: () => Promise<void> },
      "runWriteCycle",
    ).mockResolvedValue(undefined);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(cycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cycle).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("aborts and waits for an in-flight cycle when stopped", async () => {
    const scheduler = new Scheduler(createConfig());
    const internal = scheduler as unknown as {
      shutdownController: AbortController;
      runWriteCycle: () => Promise<void>;
    };
    let cycleFinished = false;
    vi.spyOn(internal, "runWriteCycle").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        internal.shutdownController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      cycleFinished = true;
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.stop();

    expect(internal.shutdownController.signal.aborted).toBe(true);
    expect(cycleFinished).toBe(true);
    expect(scheduler.isRunning).toBe(false);
  });

  it("does not persist an unattended failure when shutdown aborts a episode", async () => {
    const scheduler = new Scheduler(createConfig());
    skipPendingEpisodeLookup(scheduler);
    const internal = scheduler as unknown as {
      pipeline: { writeNextEpisode: () => Promise<unknown> };
      shutdownController: AbortController;
      handleAuditFailure: (...args: unknown[]) => Promise<void>;
      writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
    };
    vi.spyOn(internal.pipeline, "writeNextEpisode").mockImplementation(async () => {
      internal.shutdownController.abort(new DOMException("stopped", "AbortError"));
      throw new DOMException("stopped", "AbortError");
    });
    const failure = vi.spyOn(internal, "handleAuditFailure");

    await expect(internal.writeOneEpisode("book-1", createBook("book-1"))).resolves.toBe(false);
    expect(failure).not.toHaveBeenCalled();
  });

  it("processes every active book with a bounded worker pool", async () => {
    const scheduler = new Scheduler({ ...createConfig(), maxConcurrentBooks: 2 });
    const internal = scheduler as unknown as {
      running: boolean;
      state: {
        listBooks: () => Promise<string[]>;
        loadBookConfig: (id: string) => Promise<BookConfig>;
      };
      processBook: (id: string, config: BookConfig) => Promise<void>;
      runWriteCycle: () => Promise<void>;
    };
    const ids = ["book-1", "book-2", "book-3", "book-4", "book-5"];
    vi.spyOn(internal.state, "listBooks").mockResolvedValue(ids);
    vi.spyOn(internal.state, "loadBookConfig").mockImplementation(async (id) => createBook(id));
    const processed = vi.spyOn(internal, "processBook").mockResolvedValue(undefined);
    internal.running = true;

    await internal.runWriteCycle();

    expect(processed.mock.calls.map(([id]) => id)).toEqual(ids);
  });

  it("reserves daily capacity before concurrent episode writes", async () => {
    const scheduler = new Scheduler({ ...createConfig(), maxEpisodesPerDay: 2 });
    const internal = scheduler as unknown as {
      writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      writeOneEpisodeWithinDailyCap: (bookId: string, config: BookConfig) => Promise<boolean>;
      dailyEpisodeCount: Map<string, number>;
      localDateKey: () => string;
      persistUnattendedState: () => Promise<void>;
    };
    let releaseWrites: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const write = vi.spyOn(internal, "writeOneEpisode").mockImplementation(async () => {
      await blocked;
      return true;
    });
    vi.spyOn(internal, "persistUnattendedState").mockResolvedValue(undefined);

    const attempts = ["book-1", "book-2", "book-3"].map((id) =>
      internal.writeOneEpisodeWithinDailyCap(id, createBook(id))
    );
    expect(write).toHaveBeenCalledTimes(2);
    releaseWrites?.();
    await expect(Promise.all(attempts)).resolves.toEqual([true, true, false]);
    expect(internal.dailyEpisodeCount.get(internal.localDateKey())).toBe(2);
  });

  it("uses the host local calendar date for daily quotas", () => {
    const scheduler = new Scheduler(createConfig());
    const localDateKey = (scheduler as unknown as { localDateKey: (now: Date) => string }).localDateKey;

    expect(localDateKey.call(scheduler, new Date(2026, 0, 2, 0, 30))).toBe("2026-01-02");
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

  it("treats state-degraded episode results as handled failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-degraded-result-"));
    const onEpisodeComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onEpisodeComplete,
    });
    skipPendingEpisodeLookup(scheduler);
    const bookConfig: BookConfig = {
      id: "book-1",
      title: "Book 1",
      platform: "other",
      genre: "other",
      status: "active",
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 10,
      episodeDurationSeconds: 90,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };

    vi.spyOn(
      (scheduler as unknown as { pipeline: { writeNextEpisode: (bookId: string, words?: number, temp?: number) => Promise<unknown> } }).pipeline,
      "writeNextEpisode",
    ).mockResolvedValue({
        episodeNumber: 3,
        title: "Broken State",
        episodeDurationSeconds: 2100,
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
      scheduler as unknown as { handleAuditFailure: (bookId: string, episodeNumber: number, issueCategories?: string[]) => Promise<void> },
      "handleAuditFailure",
    ).mockResolvedValue(undefined);

    try {
      const success = await (
        scheduler as unknown as {
          writeOneEpisode: (bookId: string, bookConfig: BookConfig) => Promise<boolean>;
        }
      ).writeOneEpisode("book-1", bookConfig);

      expect(success).toBe(false);
      expect(handleAuditFailure).toHaveBeenCalledWith(
        "book-1",
        3,
        ["state-validation"],
        { kind: "state-degraded", action: "repair-state" },
      );
      expect(onEpisodeComplete).toHaveBeenCalledWith("book-1", 3, "state-degraded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses a degraded episode before recovery when its current metrics exceed hard gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-degraded-budget-"));
    const onEpisodeComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onEpisodeComplete,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0.1,
        maxEpisodeTokens: 100,
        maxPromptTokensPerCall: 100,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerEpisode: 0,
        minHardRangeRate: 0.8,
      },
    });
    skipPendingEpisodeLookup(scheduler);
    const book = createBook("book-1");
    (scheduler as unknown as { telemetryByBook: Map<string, LLMCallTelemetry[]> }).telemetryByBook.set(
      book.id,
      [createTelemetry()],
    );
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { writeNextEpisode: () => Promise<unknown> };
      }).pipeline,
      "writeNextEpisode",
    ).mockResolvedValue(createPipelineResult("state-degraded"));

    try {
      const success = await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

      expect(success).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      expect(onEpisodeComplete).toHaveBeenCalledWith(book.id, 1, "state-degraded");
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastEpisodeNumber: 1,
        lastFailureKind: "budget",
      });
      expect(persisted.books[book.id]?.lastError).toContain("episode tokens 150 > 100");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the full primary episode result to unattended observers", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-result-callback-"));
    const onEpisodeResult = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onEpisodeResult,
    });
    skipPendingEpisodeLookup(scheduler);
    const book = createBook("book-1");
    const result = createPipelineResult("ready-for-review");
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { writeNextEpisode: () => Promise<unknown> };
      }).pipeline,
      "writeNextEpisode",
    ).mockResolvedValue(result);
    vi.spyOn(
      scheduler as unknown as {
        completeEpisode: () => Promise<boolean>;
      },
      "completeEpisode",
    ).mockResolvedValue(true);

    try {
      await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

      expect(onEpisodeResult).toHaveBeenCalledWith(book.id, result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses instead of scheduling the same provider sample after a content-policy rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-content-policy-"));
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    skipPendingEpisodeLookup(scheduler);
    const book = createBook("policy-book");
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { writeNextEpisode: () => Promise<unknown> };
      }).pipeline,
      "writeNextEpisode",
    ).mockRejectedValue(new ProviderContentPolicyError({ service: "ark", model: "model-a" }));

    try {
      const success = await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

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
            episodeNumber: number,
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

  it("resumes an audit-failed episode through revision instead of writing a new episode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-revise-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingEpisode(state, book, "audit-failed");
    const onEpisodeComplete = vi.fn();
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root, onEpisodeComplete });
    const pipeline = (scheduler as unknown as {
      pipeline: {
        writeNextEpisode: (...args: unknown[]) => Promise<unknown>;
        reviseDraft: (...args: unknown[]) => Promise<unknown>;
      };
    }).pipeline;
    const writeNext = vi.spyOn(pipeline, "writeNextEpisode");
    const revise = vi.spyOn(pipeline, "reviseDraft").mockResolvedValue({
      episodeNumber: 1,
      episodeDurationSeconds: 1000,
      fixedIssues: ["fixed"],
      applied: true,
      status: "ready-for-review",
    });

    try {
      const success = await (
        scheduler as unknown as { writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean> }
      ).writeOneEpisode(book.id, book);

      expect(success).toBe(true);
      expect(revise).toHaveBeenCalledWith(book.id, 1, "auto");
      expect(writeNext).not.toHaveBeenCalled();
      expect(onEpisodeComplete).toHaveBeenCalledWith(book.id, 1, "ready-for-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs and then resyncs a state-degraded episode before continuing", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-resync-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingEpisode(state, book, "state-degraded");
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    vi.spyOn(
      scheduler as unknown as { enforceEpisodeRuntimeGates: () => Promise<boolean> },
      "enforceEpisodeRuntimeGates",
    ).mockResolvedValue(true);
    const pipeline = (scheduler as unknown as {
      pipeline: {
        writeNextEpisode: (...args: unknown[]) => Promise<unknown>;
        repairEpisodeState: (...args: unknown[]) => Promise<unknown>;
        resyncEpisodeArtifacts: (...args: unknown[]) => Promise<unknown>;
      };
    }).pipeline;
    const writeNext = vi.spyOn(pipeline, "writeNextEpisode");
    const repair = vi.spyOn(pipeline, "repairEpisodeState").mockResolvedValue(
      createPipelineResult("state-degraded"),
    );
    const resync = vi.spyOn(pipeline, "resyncEpisodeArtifacts").mockResolvedValue(
      createPipelineResult("ready-for-review"),
    );

    try {
      const success = await (
        scheduler as unknown as { writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean> }
      ).writeOneEpisode(book.id, book);

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
    await seedPendingEpisode(state, book, "audit-failed");
    const content = createEpisodeScriptMarkdown(1);
    const index = await state.loadEpisodeIndex(book.id);
    await state.saveEpisodeIndex(book.id, index.map((episode) => ({
      ...episode,
      recoveryState: buildEpisodeRecoveryState({
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
    vi.spyOn(
      scheduler as unknown as { enforceEpisodeRuntimeGates: () => Promise<boolean> },
      "enforceEpisodeRuntimeGates",
    ).mockResolvedValue(true);
    const pipeline = (scheduler as unknown as {
      pipeline: {
        reviseDraft: (...args: unknown[]) => Promise<unknown>;
        rewriteEpisode: (...args: unknown[]) => Promise<unknown>;
      };
    }).pipeline;
    const revise = vi.spyOn(pipeline, "reviseDraft");
    const rewrite = vi.spyOn(pipeline, "rewriteEpisode").mockResolvedValue({
      ...createPipelineResult("ready-for-review"),
      episodeDurationSeconds: 90,
    });

    try {
      const success = await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

      expect(success).toBe(true);
      expect(rewrite).toHaveBeenCalledWith(book.id, 1, book.episodeDurationSeconds);
      expect(revise).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists rewrite as the next action when a bounded revision is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-revision-escalation-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingEpisode(state, book, "audit-failed");
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const pipeline = (scheduler as unknown as {
      pipeline: { reviseDraft: (...args: unknown[]) => Promise<unknown> };
    }).pipeline;
    vi.spyOn(pipeline, "reviseDraft").mockResolvedValue({
      episodeNumber: 1,
      episodeDurationSeconds: 1000,
      fixedIssues: [],
      applied: false,
      status: "unchanged",
      skippedReason: "revision did not improve the episode",
    });

    try {
      const success = await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

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
    await seedPendingEpisode(state, book, "state-degraded");
    const scheduler = new Scheduler({ ...createConfig(), projectRoot: root });
    const fingerprint = fingerprintEpisodeContent(createEpisodeScriptMarkdown(1));
    const internal = scheduler as unknown as {
      unattendedBooks: Map<string, UnattendedBookState>;
      pipeline: {
        repairEpisodeState: (...args: unknown[]) => Promise<unknown>;
        resyncEpisodeArtifacts: (...args: unknown[]) => Promise<unknown>;
      };
      writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
    };
    internal.unattendedBooks.set(book.id, {
      status: "retry-wait",
      action: "resync-state",
      consecutiveFailures: 1,
      failureDimensions: {},
      attemptsByAction: { "repair-state": 1, "resync-state": 1 },
      recoveryContentFingerprint: fingerprint,
      attemptsForContent: { "repair-state": 1, "resync-state": 1 },
      lastEpisodeNumber: 1,
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    const repair = vi.spyOn(internal.pipeline, "repairEpisodeState");
    const resync = vi.spyOn(internal.pipeline, "resyncEpisodeArtifacts");

    try {
      expect(await internal.writeOneEpisode(book.id, book)).toBe(false);
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
    await seedPendingEpisode(state, book, "state-degraded");
    const onEpisodeComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onEpisodeComplete,
      governanceCallLimits: { maxSettlementCallsPerEpisode: 1 },
    });
    const internal = scheduler as unknown as {
      unattendedBooks: Map<string, UnattendedBookState>;
      pipeline: { repairEpisodeState: (...args: unknown[]) => Promise<unknown> };
    };
    internal.unattendedBooks.set(book.id, {
      status: "retry-wait",
      action: "repair-state",
      consecutiveFailures: 1,
      failureDimensions: { "state-validation": 1 },
      attemptsByAction: {},
      attemptsForContent: {},
      lastEpisodeNumber: 1,
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
    const repair = vi.spyOn(internal.pipeline, "repairEpisodeState");

    try {
      const success = await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

      expect(success).toBe(false);
      expect(repair).not.toHaveBeenCalled();
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      expect(onEpisodeComplete).toHaveBeenCalledWith(book.id, 1, "state-degraded");
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastEpisodeNumber: 1,
        lastFailureKind: "budget",
      });
      expect(persisted.books[book.id]?.lastError).toContain(
        "settlement calls 1 reached 1 before state recovery",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attributes recovery errors to the pending episode and applies its accumulated budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-recovery-budget-"));
    const state = new StateManager(root);
    const book = createBook("book-1");
    await seedPendingEpisode(state, book, "state-degraded");
    const onEpisodeComplete = vi.fn();
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      onEpisodeComplete,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0.1,
        maxEpisodeTokens: 100,
        maxPromptTokensPerCall: 100,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerEpisode: 0,
        minHardRangeRate: 0.8,
      },
    });
    (scheduler as unknown as { telemetryByBook: Map<string, LLMCallTelemetry[]> }).telemetryByBook.set(
      book.id,
      [createTelemetry()],
    );
    vi.spyOn(
      (scheduler as unknown as {
        pipeline: { repairEpisodeState: () => Promise<unknown> };
      }).pipeline,
      "repairEpisodeState",
    ).mockRejectedValue(new Error("state repair failed"));

    try {
      const success = await (scheduler as unknown as {
        writeOneEpisode: (bookId: string, config: BookConfig) => Promise<boolean>;
      }).writeOneEpisode(book.id, book);

      expect(success).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      expect(onEpisodeComplete).toHaveBeenCalledWith(book.id, 1, "state-degraded");
      const persisted = await new UnattendedStateStore(root).load();
      expect(persisted.books[book.id]).toMatchObject({
        status: "paused",
        action: "pause",
        lastEpisodeNumber: 1,
        lastFailureKind: "budget",
      });
      expect(persisted.books[book.id]?.lastError).toContain("episode tokens 150 > 100");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses durably when episode runtime metrics exceed unattended gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-unattended-budget-"));
    const book = createBook("book-1");
    const scheduler = new Scheduler({
      ...createConfig(),
      projectRoot: root,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0.1,
        maxEpisodeTokens: 100,
        maxPromptTokensPerCall: 20,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerEpisode: 0,
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
        episodeNumber: 1,
      }],
    );

    try {
      const passed = await (
        scheduler as unknown as {
          completeEpisode: (
            bookId: string,
            config: BookConfig,
            episodeNumber: number,
            withinHardRange: boolean,
          ) => Promise<boolean>;
        }
      ).completeEpisode(book.id, book, 1, false);

      expect(passed).toBe(false);
      expect(scheduler.isBookPaused(book.id)).toBe(true);
      const persisted = await new UnattendedStateStore(root).load();
      const state = persisted.books[book.id];
      expect(state?.lastFailureKind).toBe("budget");
      expect(state?.lastError).toContain("episode tokens 150 > 100");
      expect(state?.lastError).toContain("max prompt 25 > 20");
      expect(state?.lastError).toContain("retry rate 2.000 > 0.2");
      expect(state?.lastError).toContain("timeout rate 1.000 > 0");
      expect(state?.lastError).toContain("fallbacks 1 > 0");
      expect(state?.lastError).toContain("hard-range rate 0.000 < 0.8");
      expect(state?.totals).toMatchObject({ episodes: 1, totalTokens: 150, fallbacks: 1 });
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
    schemaVersion: "inkos-episode-v2" as const,
    format: "screenplay" as const,
    targetEpisodes: 10,
    episodeDurationSeconds: 90,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

function createEpisodeMeta(status: "audit-failed" | "state-degraded") {
  return {
    episodeNumber: 1,
    title: "Episode 1",
    status,
    episodeDurationSeconds: 1000,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
  };
}

async function seedPendingEpisode(
  state: StateManager,
  book: BookConfig,
  status: "audit-failed" | "state-degraded",
): Promise<void> {
  const episodesDir = join(state.bookDir(book.id), "episodes");
  await mkdir(episodesDir, { recursive: true });
  await state.saveBookConfig(book.id, book);
  await Promise.all([
    state.saveEpisodeIndex(book.id, [createEpisodeMeta(status)]),
    writeFile(
      join(episodesDir, "0001_Episode_1.md"),
      createEpisodeScriptMarkdown(1),
      "utf-8",
    ),
  ]);
}

function createPipelineResult(status: "ready-for-review" | "state-degraded") {
  return {
    episodeNumber: 1,
    title: "Episode 1",
    episodeDurationSeconds: 1000,
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
