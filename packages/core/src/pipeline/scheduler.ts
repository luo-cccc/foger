import { PipelineRunner } from "./runner.js";
import type { ChapterPipelineResult, PipelineConfig } from "./runner.js";
import { StateManager } from "../state/manager.js";
import type { BookConfig } from "../models/book.js";
import type { QualityGates, DetectionConfig } from "../models/project.js";
import { dispatchWebhookEvent } from "../notify/dispatcher.js";
import { detectChapter, detectAndRewrite } from "./detection-runner.js";
import type { Logger } from "../utils/logger.js";
import type { AuditIssue } from "../agents/continuity.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { LLMCallTelemetry } from "../llm/provider.js";
import type { PipelineDiagnostic } from "./diagnostics.js";
import { Cron } from "croner";
import {
  auditIssuesFromChapterRecovery,
  decideChapterRecovery,
  fingerprintChapterContent,
  type ChapterRecoveryAction,
} from "./chapter-recovery-policy.js";
import {
  classifyUnattendedError,
  createEmptyUnattendedState,
  UnattendedStateStore,
  type UnattendedAction,
  type UnattendedBookState,
  type UnattendedChapterMetrics,
  type UnattendedFailureKind,
  type UnattendedSchedulerState,
  type UnattendedTotals,
} from "./unattended-state.js";

export interface SchedulerConfig extends PipelineConfig {
  readonly writeCron: string;
  readonly maxConcurrentBooks: number;
  readonly chaptersPerCycle: number;
  readonly retryDelayMs: number;
  readonly cooldownAfterChapterMs: number;
  readonly maxChaptersPerDay: number;
  readonly qualityGates?: QualityGates;
  readonly detection?: DetectionConfig;
  readonly onChapterComplete?: (bookId: string, chapter: number, status: string) => void;
  readonly onChapterResult?: (bookId: string, result: ChapterPipelineResult) => void;
  readonly onError?: (bookId: string, error: Error) => void;
  readonly onPause?: (bookId: string, reason: string) => void;
}

interface ScheduledTask {
  readonly name: string;
  readonly job: Cron;
}

export class Scheduler {
  private readonly pipeline: PipelineRunner;
  private readonly state: StateManager;
  private readonly config: SchedulerConfig;
  private tasks: ScheduledTask[] = [];
  private running = false;
  private writeCycleInFlight: Promise<void> | null = null;
  private readonly shutdownController = new AbortController();
  private reservedChapterSlots = 0;

  // Quality gate tracking (per book)
  private consecutiveFailures = new Map<string, number>();
  private pausedBooks = new Set<string>();
  // Failure clustering: bookId → (dimension → count)
  private failureDimensions = new Map<string, Map<string, number>>();
  // Daily chapter counter: "YYYY-MM-DD" → count
  private dailyChapterCount = new Map<string, number>();
  private unattendedBooks = new Map<string, UnattendedBookState>();
  private telemetryByBook = new Map<string, LLMCallTelemetry[]>();
  private diagnosticsByBook = new Map<string, PipelineDiagnostic[]>();
  private readonly unattendedStateStore: UnattendedStateStore;
  private persistStateTail: Promise<void> = Promise.resolve();

  private readonly log?: Logger;

  constructor(config: SchedulerConfig) {
    this.config = config;
    const upstreamTelemetry = config.onCallTelemetry;
    const upstreamDiagnostic = config.onPipelineDiagnostic;
    this.pipeline = new PipelineRunner({
      ...config,
      signal: config.signal
        ? AbortSignal.any([config.signal, this.shutdownController.signal])
        : this.shutdownController.signal,
      maxPromptEstimatedTokensPerCall: config.qualityGates?.maxPromptTokensPerCall ?? 16_000,
      onCallTelemetry: (telemetry) => {
        upstreamTelemetry?.(telemetry);
        if (!telemetry.bookId) return;
        const records = this.telemetryByBook.get(telemetry.bookId) ?? [];
        records.push(telemetry);
        this.telemetryByBook.set(telemetry.bookId, records);
      },
      onPipelineDiagnostic: (diagnostic) => {
        upstreamDiagnostic?.(diagnostic);
        if (!diagnostic.bookId) return;
        const records = this.diagnosticsByBook.get(diagnostic.bookId) ?? [];
        records.push(diagnostic);
        this.diagnosticsByBook.set(diagnostic.bookId, records);
      },
    });
    this.state = new StateManager(config.projectRoot);
    this.unattendedStateStore = new UnattendedStateStore(config.projectRoot);
    this.log = config.logger?.child("scheduler");
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.shutdownController.signal.aborted) {
      throw new Error("A stopped Scheduler cannot be restarted; create a new Scheduler instance.");
    }
    await this.restoreUnattendedState();
    this.running = true;

    const job = new Cron(this.config.writeCron, {
      protect: true,
      catch: (error) => {
        if (!this.isShutdownError(error)) {
          this.config.onError?.("scheduler", error as Error);
        }
      },
    }, async () => {
      if (!this.running) return;
      try {
        await this.triggerWriteCycle();
      } catch (error) {
        if (!this.isShutdownError(error)) throw error;
      }
    });
    this.tasks.push({ name: "write-cycle", job });
  }

  /** Run exactly one write cycle without installing a recurring timer. */
  async runOnce(): Promise<void> {
    if (this.running) {
      throw new Error("Scheduler is already running");
    }
    await this.restoreUnattendedState();
    this.running = true;
    try {
      await this.triggerWriteCycle();
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const task of this.tasks) {
      task.job.stop();
    }
    this.tasks = [];
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new DOMException("Scheduler stopped", "AbortError"));
    }
    await this.writeCycleInFlight?.catch(() => undefined);
    await this.persistStateTail.catch(() => undefined);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async triggerWriteCycle(): Promise<void> {
    if (this.writeCycleInFlight) {
      this.log?.warn("Write cycle still running, skipping overlapping tick");
      return;
    }

    const cycle = this.runWriteCycle().finally(() => {
      if (this.writeCycleInFlight === cycle) {
        this.writeCycleInFlight = null;
      }
    });
    this.writeCycleInFlight = cycle;
    await cycle;
  }

  /** Resume a paused book. */
  resumeBook(bookId: string): void {
    this.pausedBooks.delete(bookId);
    this.consecutiveFailures.delete(bookId);
    this.failureDimensions.delete(bookId);
    const now = new Date().toISOString();
    this.unattendedBooks.set(bookId, {
      status: "active",
      action: "write",
      consecutiveFailures: 0,
      failureDimensions: {},
      attemptsByAction: {},
      attemptsForContent: {},
      updatedAt: now,
    });
    void this.persistUnattendedState().catch((error) => {
      this.log?.error(`Failed to persist resume state for ${bookId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Check if a book is paused. */
  isBookPaused(bookId: string): boolean {
    return this.pausedBooks.has(bookId);
  }

  private async restoreUnattendedState(): Promise<void> {
    const persisted = await this.unattendedStateStore.load();
    this.unattendedBooks = new Map(Object.entries(persisted.books));
    this.consecutiveFailures = new Map(
      Object.entries(persisted.books).map(([bookId, state]) => [bookId, state.consecutiveFailures]),
    );
    this.failureDimensions = new Map(
      Object.entries(persisted.books).map(([bookId, state]) => [
        bookId,
        new Map(Object.entries(state.failureDimensions)),
      ]),
    );
    this.pausedBooks = new Set(
      Object.entries(persisted.books)
        .filter(([, state]) => state.status === "paused")
        .map(([bookId]) => bookId),
    );
    this.dailyChapterCount = new Map(Object.entries(persisted.dailyChapterCount));
  }

  private persistUnattendedState(): Promise<void> {
    const state: UnattendedSchedulerState = {
      ...createEmptyUnattendedState(),
      books: Object.fromEntries(this.unattendedBooks),
      dailyChapterCount: Object.fromEntries(this.dailyChapterCount),
    };
    const write = this.persistStateTail
      .catch(() => undefined)
      .then(() => this.unattendedStateStore.save(state));
    this.persistStateTail = write;
    return write;
  }

  private async updateUnattendedBook(
    bookId: string,
    patch: Partial<UnattendedBookState>,
  ): Promise<UnattendedBookState> {
    const current = this.unattendedBooks.get(bookId);
    const next: UnattendedBookState = {
      status: "active",
      action: "write",
      consecutiveFailures: 0,
      failureDimensions: {},
      attemptsByAction: {},
      attemptsForContent: {},
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.unattendedBooks.set(bookId, next);
    await this.persistUnattendedState();
    return next;
  }

  private async markActionAttempt(
    bookId: string,
    action: UnattendedAction,
    contentFingerprint?: string,
  ): Promise<void> {
    const current = this.unattendedBooks.get(bookId);
    const attemptsByAction = { ...(current?.attemptsByAction ?? {}) };
    attemptsByAction[action] = (attemptsByAction[action] ?? 0) + 1;
    const sameContent = contentFingerprint !== undefined
      && current?.recoveryContentFingerprint === contentFingerprint;
    const attemptsForContent = sameContent
      ? { ...(current?.attemptsForContent ?? {}) }
      : {};
    if (contentFingerprint) {
      attemptsForContent[action] = (attemptsForContent[action] ?? 0) + 1;
    }
    await this.updateUnattendedBook(bookId, {
      action,
      attemptsByAction,
      ...(contentFingerprint
        ? { recoveryContentFingerprint: contentFingerprint, attemptsForContent }
        : {}),
    });
  }

  private recoveryDecision(
    bookId: string,
    status: "state-degraded" | "audit-failed",
    issues: ReadonlyArray<AuditIssue>,
    contentFingerprint?: string,
  ) {
    const current = this.unattendedBooks.get(bookId);
    const currentContent = contentFingerprint !== undefined
      && current?.recoveryContentFingerprint === contentFingerprint
      ? current.attemptsForContent
      : {};
    return decideChapterRecovery({
      status,
      issues,
      attempts: {
        global: current?.attemptsByAction,
        currentContent,
      },
    });
  }

  private retryWaitMs(bookId: string): number {
    const nextAttemptAt = this.unattendedBooks.get(bookId)?.nextAttemptAt;
    if (!nextAttemptAt) return 0;
    return Math.max(0, Date.parse(nextAttemptAt) - Date.now());
  }

  private emptyChapterMetrics(): UnattendedChapterMetrics {
    return {
      calls: 0,
      retries: 0,
      timeouts: 0,
      errors: 0,
      totalTokens: 0,
      maxPromptEstimatedTokens: 0,
      fallbacks: 0,
      revisionCalls: 0,
      settlementCalls: 0,
    };
  }

  private emptyTotals(): UnattendedTotals {
    return {
      chapters: 0,
      hardRangeChapters: 0,
      calls: 0,
      retries: 0,
      timeouts: 0,
      errors: 0,
      totalTokens: 0,
      fallbacks: 0,
    };
  }

  private async captureBookMetrics(
    bookId: string,
    withinHardRange?: boolean,
  ): Promise<UnattendedChapterMetrics> {
    const telemetry = this.telemetryByBook.get(bookId) ?? [];
    const diagnostics = this.diagnosticsByBook.get(bookId) ?? [];
    this.telemetryByBook.delete(bookId);
    this.diagnosticsByBook.delete(bookId);

    const current = this.unattendedBooks.get(bookId)?.currentMetrics ?? this.emptyChapterMetrics();
    const metrics: UnattendedChapterMetrics = {
      calls: current.calls + telemetry.length,
      retries: current.retries + telemetry.reduce((sum, record) => sum + record.retryCount, 0),
      timeouts: current.timeouts + telemetry.filter((record) => record.status === "timeout").length,
      errors: current.errors + telemetry.filter((record) => record.status === "error" || record.status === "partial").length,
      totalTokens: current.totalTokens + telemetry.reduce((sum, record) => sum + record.usage.totalTokens, 0),
      maxPromptEstimatedTokens: Math.max(
        current.maxPromptEstimatedTokens,
        ...telemetry.map((record) => record.promptAssembly.estimatedTokens),
      ),
      fallbacks: current.fallbacks + diagnostics.filter((diagnostic) => diagnostic.kind.endsWith("fallback")).length,
      revisionCalls: current.revisionCalls
        + telemetry.filter((record) => record.phase === "revise").length,
      settlementCalls: current.settlementCalls
        + telemetry.filter((record) => record.phase === "settle").length,
      withinHardRange: withinHardRange ?? current.withinHardRange,
    };
    await this.updateUnattendedBook(bookId, { currentMetrics: metrics });
    return metrics;
  }

  private async enforceChapterRuntimeGates(
    bookId: string,
    chapterNumber: number,
    withinHardRange: boolean,
  ): Promise<boolean> {
    const metrics = await this.captureBookMetrics(bookId, withinHardRange);
    const previousTotals = this.unattendedBooks.get(bookId)?.totals ?? this.emptyTotals();
    const totals: UnattendedTotals = {
      chapters: previousTotals.chapters + 1,
      hardRangeChapters: previousTotals.hardRangeChapters + (withinHardRange ? 1 : 0),
      calls: previousTotals.calls + metrics.calls,
      retries: previousTotals.retries + metrics.retries,
      timeouts: previousTotals.timeouts + metrics.timeouts,
      errors: previousTotals.errors + metrics.errors,
      totalTokens: previousTotals.totalTokens + metrics.totalTokens,
      fallbacks: previousTotals.fallbacks + metrics.fallbacks,
    };
    const hardRangeRate = totals.chapters > 0 ? totals.hardRangeChapters / totals.chapters : 0;
    const violations = this.chapterRuntimeViolations(metrics, hardRangeRate);

    await this.updateUnattendedBook(bookId, {
      currentMetrics: undefined,
      lastMetrics: metrics,
      totals,
      lastChapterNumber: chapterNumber,
    });
    if (violations.length === 0) return true;

    await this.handleAuditFailure(bookId, chapterNumber, ["unattended-runtime-budget"], {
      kind: "budget",
      action: "pause",
      error: `Unattended runtime gate failed: ${violations.join("; ")}`,
    });
    return false;
  }

  private chapterRuntimeViolations(
    metrics: UnattendedChapterMetrics,
    hardRangeRate?: number,
  ): string[] {
    const retryRate = metrics.calls > 0 ? metrics.retries / metrics.calls : 0;
    const timeoutRate = metrics.calls > 0 ? metrics.timeouts / metrics.calls : 0;
    const gates = this.gates;
    const violations: string[] = [];
    if (metrics.totalTokens > gates.maxChapterTokens) {
      violations.push(`chapter tokens ${metrics.totalTokens} > ${gates.maxChapterTokens}`);
    }
    if (metrics.maxPromptEstimatedTokens > gates.maxPromptTokensPerCall) {
      violations.push(`max prompt ${metrics.maxPromptEstimatedTokens} > ${gates.maxPromptTokensPerCall}`);
    }
    if (retryRate > gates.maxRetryRate) {
      violations.push(`retry rate ${retryRate.toFixed(3)} > ${gates.maxRetryRate}`);
    }
    if (timeoutRate > gates.maxTimeoutRate) {
      violations.push(`timeout rate ${timeoutRate.toFixed(3)} > ${gates.maxTimeoutRate}`);
    }
    if (metrics.fallbacks > gates.maxFallbacksPerChapter) {
      violations.push(`fallbacks ${metrics.fallbacks} > ${gates.maxFallbacksPerChapter}`);
    }
    const governanceLimits = this.config.governanceCallLimits;
    if (
      governanceLimits?.maxRevisionCallsPerChapter !== undefined
      && metrics.revisionCalls > governanceLimits.maxRevisionCallsPerChapter
    ) {
      violations.push(
        `revision calls ${metrics.revisionCalls} > ${governanceLimits.maxRevisionCallsPerChapter}`,
      );
    }
    if (
      governanceLimits?.maxSettlementCallsPerChapter !== undefined
      && metrics.settlementCalls > governanceLimits.maxSettlementCallsPerChapter
    ) {
      violations.push(
        `settlement calls ${metrics.settlementCalls} > ${governanceLimits.maxSettlementCallsPerChapter}`,
      );
    }
    if (hardRangeRate !== undefined && hardRangeRate < gates.minHardRangeRate) {
      violations.push(`hard-range rate ${hardRangeRate.toFixed(3)} < ${gates.minHardRangeRate}`);
    }
    return violations;
  }

  private async pauseForCurrentRuntimeViolations(
    bookId: string,
    chapterNumber: number,
    metrics: UnattendedChapterMetrics,
    issueCategories: ReadonlyArray<string> = [],
  ): Promise<boolean> {
    const violations = this.chapterRuntimeViolations(metrics);
    if (violations.length === 0) return false;
    await this.handleAuditFailure(bookId, chapterNumber, [
      ...issueCategories,
      "unattended-runtime-budget",
    ], {
      kind: "budget",
      action: "pause",
      error: `Unattended runtime gate failed: ${violations.join("; ")}`,
    });
    return true;
  }

  private async pauseBeforePendingGovernanceCall(
    bookId: string,
    chapter: ChapterMeta,
  ): Promise<boolean> {
    const metrics = this.unattendedBooks.get(bookId)?.currentMetrics;
    const limits = this.config.governanceCallLimits;
    if (!metrics || !limits) return false;

    const persistedAction = this.unattendedBooks.get(bookId)?.action;
    const violations: string[] = [];
    if (
      chapter.status === "state-degraded"
      && limits.maxSettlementCallsPerChapter !== undefined
      && metrics.settlementCalls >= limits.maxSettlementCallsPerChapter
    ) {
      violations.push(
        `settlement calls ${metrics.settlementCalls} reached ${limits.maxSettlementCallsPerChapter} before state recovery`,
      );
    }
    if (
      chapter.status === "audit-failed"
      && persistedAction !== "rewrite"
      && limits.maxRevisionCallsPerChapter !== undefined
      && metrics.revisionCalls >= limits.maxRevisionCallsPerChapter
    ) {
      violations.push(
        `revision calls ${metrics.revisionCalls} reached ${limits.maxRevisionCallsPerChapter} before revision recovery`,
      );
    }
    if (
      chapter.status === "audit-failed"
      && persistedAction === "rewrite"
      && limits.maxSettlementCallsPerChapter !== undefined
      && metrics.settlementCalls >= limits.maxSettlementCallsPerChapter
    ) {
      violations.push(
        `settlement calls ${metrics.settlementCalls} reached ${limits.maxSettlementCallsPerChapter} before rewrite recovery`,
      );
    }
    if (violations.length === 0) return false;

    await this.handleAuditFailure(bookId, chapter.number, ["unattended-governance-budget"], {
      kind: "budget",
      action: "pause",
      error: `Unattended governance call gate failed: ${violations.join("; ")}`,
    });
    return true;
  }

  private get gates(): QualityGates {
    return this.config.qualityGates ?? {
      maxAuditRetries: 2,
      pauseAfterConsecutiveFailures: 3,
      retryTemperatureStep: 0.1,
      maxChapterTokens: 100_000,
      maxPromptTokensPerCall: 16_000,
      maxRetryRate: 0.2,
      maxTimeoutRate: 0,
      maxFallbacksPerChapter: 0,
      minHardRangeRate: 0.8,
    };
  }

  /** Check if daily cap is reached across all books. */
  private isDailyCapReached(): boolean {
    const today = this.localDateKey();
    const count = this.dailyChapterCount.get(today) ?? 0;
    return count + this.reservedChapterSlots >= this.config.maxChaptersPerDay;
  }

  /** Increment daily chapter counter. */
  private async recordChapterWritten(): Promise<void> {
    const today = this.localDateKey();
    const count = this.dailyChapterCount.get(today) ?? 0;
    this.dailyChapterCount.set(today, count + 1);

    // Clean up old dates (keep only today)
    for (const key of this.dailyChapterCount.keys()) {
      if (key !== today) this.dailyChapterCount.delete(key);
    }
    await this.persistUnattendedState();
  }

  private async runWriteCycle(): Promise<void> {
    if (this.isDailyCapReached()) {
      this.log?.info(`Daily cap reached (${this.config.maxChaptersPerDay}), skipping cycle`);
      return;
    }

    const bookIds = await this.state.listBooks();

    const activeBooks: Array<{ readonly id: string; readonly config: BookConfig }> = [];
    for (const id of bookIds) {
      if (this.pausedBooks.has(id)) continue;
      const unattended = this.unattendedBooks.get(id);
      if (
        unattended?.status === "retry-wait"
        && unattended.nextAttemptAt
        && Date.parse(unattended.nextAttemptAt) > Date.now()
      ) {
        continue;
      }
      const config = await this.state.loadBookConfig(id);
      if (config.status === "active" || config.status === "outlining") {
        activeBooks.push({ id, config });
      }
    }

    let nextBookIndex = 0;
    const workerCount = Math.min(this.config.maxConcurrentBooks, activeBooks.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (this.running) {
        const book = activeBooks[nextBookIndex];
        nextBookIndex += 1;
        if (!book) return;
        await this.processBook(book.id, book.config);
      }
    }));
  }

  /** Process a single book: write chaptersPerCycle chapters with retry + cooldown. */
  private async processBook(bookId: string, bookConfig: BookConfig): Promise<void> {
    for (let i = 0; i < this.config.chaptersPerCycle; i++) {
      if (!this.running) return;
      if (this.isDailyCapReached()) return;
      if (this.pausedBooks.has(bookId)) return;

      // Cooldown between chapters (skip for the first one)
      if (i > 0 && this.config.cooldownAfterChapterMs > 0) {
        await this.sleep(this.config.cooldownAfterChapterMs);
      }

      const success = await this.writeOneChapterWithinDailyCap(bookId, bookConfig);
      if (!success) {
        if (this.isDailyCapReached()) return;
        const failures = this.consecutiveFailures.get(bookId) ?? 0;
        if (failures <= this.gates.maxAuditRetries && !this.pausedBooks.has(bookId)) {
          const waitMs = Math.max(this.config.retryDelayMs, this.retryWaitMs(bookId));
          this.log?.warn(`${bookId} retrying unattended action in ${waitMs}ms`);
          if (waitMs > 0) await this.sleep(waitMs);
          const retrySuccess = await this.writeOneChapterWithinDailyCap(bookId, bookConfig);
          if (!retrySuccess) break; // Stop this book's cycle on second failure
        } else {
          break; // Stop this book's cycle
        }
      }
    }
  }

  /** Write one chapter for a book. Returns true if approved. */
  private async writeOneChapter(bookId: string, bookConfig: BookConfig): Promise<boolean> {
    let attemptedChapter: ChapterMeta | undefined;
    try {
      const pendingChapter = await this.findLatestPendingChapter(bookId);
      if (pendingChapter) {
        attemptedChapter = pendingChapter;
        if (await this.pauseBeforePendingGovernanceCall(bookId, pendingChapter)) {
          this.config.onChapterComplete?.(bookId, pendingChapter.number, pendingChapter.status);
          return false;
        }
        return await this.recoverPendingChapter(bookId, bookConfig, pendingChapter);
      }

      // Compute temperature override: base 0.7 + failures * step
      const failures = this.consecutiveFailures.get(bookId) ?? 0;
      const tempOverride = failures > 0
        ? Math.min(1.2, 0.7 + failures * this.gates.retryTemperatureStep)
        : undefined;

      const result = await this.pipeline.writeNextChapter(bookId, undefined, tempOverride);
      this.config.onChapterResult?.(bookId, result);

      if (result.status === "ready-for-review") {
        return await this.completeChapter(
          bookId,
          bookConfig,
          result.chapterNumber,
          (result.lengthWarnings?.length ?? 0) === 0,
        );
      }

      const issueCategories = result.auditResult.issues.map((i) => i.category);
      const metrics = await this.captureBookMetrics(bookId, (result.lengthWarnings?.length ?? 0) === 0);
      if (await this.pauseForCurrentRuntimeViolations(
        bookId,
        result.chapterNumber,
        metrics,
        issueCategories,
      )) {
        this.config.onChapterComplete?.(bookId, result.chapterNumber, result.status);
        return false;
      }
      const classification = result.status === "state-degraded"
        ? { kind: "state-degraded" as const, action: "repair-state" as const }
        : this.classifyAuditIssues(result.auditResult.issues);
      await this.handleAuditFailure(bookId, result.chapterNumber, issueCategories, classification);
      this.config.onChapterComplete?.(bookId, result.chapterNumber, result.status);
      return false;
    } catch (e) {
      if (this.isShutdownError(e)) return false;
      this.config.onError?.(bookId, e as Error);
      const chapterNumber = attemptedChapter?.number ?? 0;
      const metrics = await this.captureBookMetrics(bookId).catch(() => undefined);
      const pausedForRuntime = metrics
        ? await this.pauseForCurrentRuntimeViolations(bookId, chapterNumber, metrics)
        : false;
      if (!pausedForRuntime) {
        const kind = classifyUnattendedError(e);
        await this.handleAuditFailure(bookId, chapterNumber, [], {
          kind,
          action: kind === "provider-auth" || kind === "provider-content-policy" || kind === "budget"
            ? "pause"
            : "retry-provider",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (attemptedChapter) {
        this.config.onChapterComplete?.(bookId, attemptedChapter.number, attemptedChapter.status);
      }
      return false;
    }
  }

  private async findLatestPendingChapter(bookId: string): Promise<ChapterMeta | undefined> {
    const chapters = await this.state.loadChapterIndex(bookId);
    const latest = [...chapters].sort((left, right) => right.number - left.number)[0];
    return latest?.status === "audit-failed" || latest?.status === "state-degraded"
      ? latest
      : undefined;
  }

  private classifyAuditIssues(issues: ReadonlyArray<AuditIssue>): {
    readonly kind: UnattendedFailureKind;
    readonly action: UnattendedAction;
  } {
    const blocking = issues.filter((issue) => issue.severity !== "info");
    if (blocking.some((issue) => issue.repairScope === "structural")) {
      return { kind: "audit-structural", action: "rewrite" };
    }
    if (blocking.length > 0 && blocking.every((issue) => issue.repairScope === "local")) {
      return { kind: "audit-local", action: "revise" };
    }
    return { kind: "audit-unknown", action: "revise" };
  }

  private async recoverPendingChapter(
    bookId: string,
    bookConfig: BookConfig,
    chapter: ChapterMeta,
  ): Promise<boolean> {
    let current = chapter;
    let content = await this.readChapterContent(this.state.bookDir(bookId), chapter.number);
    let fingerprint = fingerprintChapterContent(content);
    let issues: ReadonlyArray<AuditIssue> = auditIssuesFromChapterRecovery(current, content);

    if (current.status === "state-degraded") {
      for (;;) {
        const decision = this.recoveryDecision(
          bookId,
          "state-degraded",
          issues,
          fingerprint,
        );
        if (decision.action === "pause") {
          await this.pauseForRecoveryDecision(bookId, current, issues, decision);
          return false;
        }

        const action: UnattendedAction = decision.action;
        await this.markActionAttempt(bookId, action, fingerprint);
        const repaired = action === "repair-state"
          ? await this.pipeline.repairChapterState(bookId, current.number)
          : await this.pipeline.resyncChapterArtifacts(bookId, current.number);
        if (repaired.status === "ready-for-review") {
          return await this.completeChapter(
            bookId,
            bookConfig,
            current.number,
            (repaired.lengthWarnings?.length ?? 0) === 0,
          );
        }

        const refreshed = await this.loadChapterForRecovery(bookId, current.number);
        current = refreshed.chapter;
        content = refreshed.content;
        fingerprint = refreshed.fingerprint;
        issues = repaired.status === "audit-failed"
          ? repaired.auditResult.issues
          : auditIssuesFromChapterRecovery(current, content);

        if (repaired.status === "audit-failed") {
          await this.captureBookMetrics(bookId, (repaired.lengthWarnings?.length ?? 0) === 0);
          const next = this.recoveryDecision(bookId, "audit-failed", issues, fingerprint);
          await this.recordPendingRecoveryDecision(bookId, current, issues, next);
          return false;
        }
      }
    }

    const decision = this.recoveryDecision(bookId, "audit-failed", issues, fingerprint);
    if (decision.action === "pause") {
      await this.pauseForRecoveryDecision(bookId, current, issues, decision);
      return false;
    }

    const action: UnattendedAction = decision.action;
    await this.markActionAttempt(bookId, action, fingerprint);
    if (action === "rewrite") {
      const rewritten = await this.pipeline.rewriteChapter(
        bookId,
        current.number,
        bookConfig.chapterWordCount,
      );
      if (rewritten.status === "ready-for-review") {
        return await this.completeChapter(
          bookId,
          bookConfig,
          current.number,
          (rewritten.lengthWarnings?.length ?? 0) === 0,
        );
      }
      await this.captureBookMetrics(bookId, (rewritten.lengthWarnings?.length ?? 0) === 0);
      const refreshed = await this.loadChapterForRecovery(bookId, current.number);
      const rewrittenIssues = rewritten.status === "audit-failed"
        ? rewritten.auditResult.issues
        : auditIssuesFromChapterRecovery(refreshed.chapter, refreshed.content);
      const next = this.recoveryDecision(
        bookId,
        rewritten.status,
        rewrittenIssues,
        refreshed.fingerprint,
      );
      await this.recordPendingRecoveryDecision(bookId, refreshed.chapter, rewrittenIssues, next);
      return false;
    }

    const revised = await this.pipeline.reviseDraft(bookId, current.number, "auto");
    if (revised.status === "ready-for-review") {
      return await this.completeChapter(
        bookId,
        bookConfig,
        current.number,
        (revised.lengthWarnings?.length ?? 0) === 0,
      );
    }

    await this.captureBookMetrics(bookId, (revised.lengthWarnings?.length ?? 0) === 0);
    const refreshed = await this.loadChapterForRecovery(bookId, current.number);
    const nextStatus = refreshed.chapter.status === "state-degraded"
      ? "state-degraded"
      : "audit-failed";
    const revisedIssues = auditIssuesFromChapterRecovery(refreshed.chapter, refreshed.content);
    const next = this.recoveryDecision(
      bookId,
      nextStatus,
      revisedIssues,
      refreshed.fingerprint,
    );
    await this.recordPendingRecoveryDecision(
      bookId,
      refreshed.chapter,
      revisedIssues,
      revised.skippedReason ? { ...next, reason: `${next.reason} ${revised.skippedReason}` } : next,
    );
    return false;
  }

  private async loadChapterForRecovery(bookId: string, chapterNumber: number): Promise<{
    readonly chapter: ChapterMeta;
    readonly content: string;
    readonly fingerprint: string;
  }> {
    const chapter = (await this.state.loadChapterIndex(bookId))
      .find((entry) => entry.number === chapterNumber);
    if (!chapter) throw new Error(`Chapter ${chapterNumber} disappeared during recovery.`);
    const content = await this.readChapterContent(this.state.bookDir(bookId), chapterNumber);
    return { chapter, content, fingerprint: fingerprintChapterContent(content) };
  }

  private async recordPendingRecoveryDecision(
    bookId: string,
    chapter: ChapterMeta,
    issues: ReadonlyArray<AuditIssue>,
    decision: { readonly action: ChapterRecoveryAction; readonly reason: string },
  ): Promise<void> {
    if (decision.action === "pause") {
      await this.pauseForRecoveryDecision(bookId, chapter, issues, decision);
      return;
    }
    const classified = chapter.status === "state-degraded"
      ? { kind: "state-degraded" as const }
      : this.classifyAuditIssues(issues);
    await this.handleAuditFailure(
      bookId,
      chapter.number,
      issues.map((issue) => issue.category),
      {
        kind: classified.kind,
        action: decision.action,
        error: decision.reason,
      },
    );
    this.config.onChapterComplete?.(bookId, chapter.number, chapter.status);
  }

  private async pauseForRecoveryDecision(
    bookId: string,
    chapter: ChapterMeta,
    issues: ReadonlyArray<AuditIssue>,
    decision: { readonly reason: string },
  ): Promise<void> {
    await this.captureBookMetrics(bookId).catch(() => undefined);
    const kind = chapter.status === "state-degraded"
      ? "state-degraded" as const
      : this.classifyAuditIssues(issues).kind;
    await this.handleAuditFailure(
      bookId,
      chapter.number,
      issues.map((issue) => issue.category),
      { kind, action: "pause", error: decision.reason },
    );
    this.config.onChapterComplete?.(bookId, chapter.number, chapter.status);
  }

  private async completeChapter(
    bookId: string,
    bookConfig: BookConfig,
    chapterNumber: number,
    withinHardRange: boolean,
  ): Promise<boolean> {
    const runtimeGatesPassed = await this.enforceChapterRuntimeGates(
      bookId,
      chapterNumber,
      withinHardRange,
    );
    if (!runtimeGatesPassed) {
      this.config.onChapterComplete?.(bookId, chapterNumber, "ready-for-review");
      return false;
    }

    this.consecutiveFailures.delete(bookId);
    this.failureDimensions.delete(bookId);
    this.pausedBooks.delete(bookId);
    await this.updateUnattendedBook(bookId, {
      status: "active",
      action: "write",
      consecutiveFailures: 0,
      failureDimensions: {},
      attemptsByAction: {},
      recoveryContentFingerprint: undefined,
      attemptsForContent: {},
      lastChapterNumber: chapterNumber,
      lastFailureKind: undefined,
      lastError: undefined,
      nextAttemptAt: undefined,
      lastSuccessAt: new Date().toISOString(),
    });

    if (this.config.detection?.enabled) {
      await this.runDetection(bookId, bookConfig, chapterNumber);
    }
    this.config.onChapterComplete?.(bookId, chapterNumber, "ready-for-review");
    return true;
  }

  private async runDetection(
    bookId: string,
    bookConfig: BookConfig,
    chapterNumber: number,
  ): Promise<void> {
    if (!this.config.detection) return;
    try {
      const bookDir = this.state.bookDir(bookId);
      const chapterContent = await this.readChapterContent(bookDir, chapterNumber);
      const detResult = await detectChapter(
        this.config.detection,
        chapterContent,
        chapterNumber,
      );
      if (!detResult.passed && this.config.detection.autoRewrite) {
        await detectAndRewrite(
          this.config.detection,
          { client: this.config.client, model: this.config.model, projectRoot: this.config.projectRoot },
          bookDir,
          chapterContent,
          chapterNumber,
          bookConfig.genre,
        );
      }
    } catch (e) {
      this.config.onError?.(bookId, e as Error);
    }
  }

  private async handleAuditFailure(
    bookId: string,
    chapterNumber: number,
    issueCategories: ReadonlyArray<string> = [],
    details: {
      readonly kind: UnattendedFailureKind;
      readonly action: UnattendedAction;
      readonly error?: string;
    } = { kind: "audit-unknown", action: "revise" },
  ): Promise<void> {
    const failures = (this.consecutiveFailures.get(bookId) ?? 0) + 1;
    this.consecutiveFailures.set(bookId, failures);

    // Track failure dimensions for clustering
    if (issueCategories.length > 0) {
      const existing = this.failureDimensions.get(bookId);
      const dimMap = existing ? new Map(existing) : new Map<string, number>();
      for (const cat of issueCategories) {
        dimMap.set(cat, (dimMap.get(cat) ?? 0) + 1);
      }
      this.failureDimensions.set(bookId, dimMap);

      // Check for dimension clustering (any dimension with >=3 failures)
      for (const [dimension, count] of dimMap) {
        if (count >= 3) {
          await this.emitDiagnosticAlert(bookId, chapterNumber, dimension, count);
        }
      }
    }

    const gates = this.gates;
    const shouldPauseImmediately = details.kind === "provider-auth"
      || details.kind === "budget"
      || details.action === "pause";
    const shouldPause = shouldPauseImmediately || failures >= gates.pauseAfterConsecutiveFailures;
    const failureDimensions = Object.fromEntries(this.failureDimensions.get(bookId) ?? []);

    if (!shouldPause) {
      const multiplier = Math.min(8, 2 ** Math.max(0, failures - 1));
      const retryDelayMs = Math.max(0, this.config.retryDelayMs * multiplier);
      const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();
      await this.updateUnattendedBook(bookId, {
        status: "retry-wait",
        action: details.action,
        consecutiveFailures: failures,
        failureDimensions,
        lastChapterNumber: chapterNumber > 0 ? chapterNumber : undefined,
        lastFailureKind: details.kind,
        lastError: details.error,
        nextAttemptAt,
      });
    }

    if (!shouldPause && failures <= gates.maxAuditRetries) {
      this.log?.warn(`${bookId} ${details.kind} failure (${failures}/${gates.maxAuditRetries}), next action=${details.action}`);
      return;
    }

    if (shouldPause) {
      this.pausedBooks.add(bookId);
      const reason = details.error
        ?? `${failures} consecutive ${details.kind} failures (threshold: ${gates.pauseAfterConsecutiveFailures})`;
      await this.updateUnattendedBook(bookId, {
        status: "paused",
        action: "pause",
        consecutiveFailures: failures,
        failureDimensions,
        lastChapterNumber: chapterNumber > 0 ? chapterNumber : undefined,
        lastFailureKind: details.kind,
        lastError: reason,
        nextAttemptAt: undefined,
      });
      this.log?.error(`${bookId} PAUSED: ${reason}`);
      this.config.onPause?.(bookId, reason);

      if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
        await dispatchWebhookEvent(this.config.notifyChannels, {
          event: "pipeline-error",
          bookId,
          chapterNumber: chapterNumber > 0 ? chapterNumber : undefined,
          timestamp: new Date().toISOString(),
          data: { reason, consecutiveFailures: failures, kind: details.kind },
        });
      }
    }
  }

  private async emitDiagnosticAlert(
    bookId: string,
    chapterNumber: number,
    dimension: string,
    count: number,
  ): Promise<void> {
    this.log?.warn(`DIAGNOSTIC: ${bookId} has ${count} failures in dimension "${dimension}"`);

    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      await dispatchWebhookEvent(this.config.notifyChannels, {
        event: "diagnostic-alert",
        bookId,
        chapterNumber: chapterNumber > 0 ? chapterNumber : undefined,
        timestamp: new Date().toISOString(),
        data: { dimension, failureCount: count },
      });
    }
  }

  private async readChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const chaptersDir = join(bookDir, "chapters");
    const files = await readdir(chaptersDir);
    const paddedNum = String(chapterNumber).padStart(4, "0");
    const chapterFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!chapterFile) {
      throw new Error(`Chapter ${chapterNumber} file not found in ${chaptersDir}`);
    }
    const raw = await readFile(join(chaptersDir, chapterFile), "utf-8");
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }

  private async writeOneChapterWithinDailyCap(bookId: string, bookConfig: BookConfig): Promise<boolean> {
    if (!this.tryReserveChapterSlot()) return false;
    let success = false;
    try {
      success = await this.writeOneChapter(bookId, bookConfig);
      return success;
    } finally {
      this.reservedChapterSlots = Math.max(0, this.reservedChapterSlots - 1);
      if (success) await this.recordChapterWritten();
    }
  }

  private tryReserveChapterSlot(): boolean {
    const today = this.localDateKey();
    const written = this.dailyChapterCount.get(today) ?? 0;
    if (written + this.reservedChapterSlots >= this.config.maxChaptersPerDay) return false;
    this.reservedChapterSlots += 1;
    return true;
  }

  private localDateKey(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private isShutdownError(error: unknown): boolean {
    return this.shutdownController.signal.aborted
      || this.config.signal?.aborted === true
      || (error instanceof Error && error.name === "AbortError");
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const signal = this.shutdownController.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
