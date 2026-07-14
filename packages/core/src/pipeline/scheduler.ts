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
  readonly intervalMs: number;
  timer?: ReturnType<typeof setInterval>;
}

export class Scheduler {
  private readonly pipeline: PipelineRunner;
  private readonly state: StateManager;
  private readonly config: SchedulerConfig;
  private tasks: ScheduledTask[] = [];
  private running = false;
  private writeCycleInFlight: Promise<void> | null = null;

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
    await this.restoreUnattendedState();
    this.running = true;

    // Run write cycle immediately on start, then schedule
    await this.triggerWriteCycle();

    // Schedule recurring write cycle
    const writeCycleMs = this.cronToMs(this.config.writeCron);
    const writeTask: ScheduledTask = {
      name: "write-cycle",
      intervalMs: writeCycleMs,
    };
    writeTask.timer = setInterval(() => {
      this.triggerWriteCycle().catch((e) => {
        this.config.onError?.("scheduler", e as Error);
      });
    }, writeCycleMs);
    this.tasks.push(writeTask);
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

  stop(): void {
    this.running = false;
    for (const task of this.tasks) {
      if (task.timer) clearInterval(task.timer);
    }
    this.tasks = [];
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
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.unattendedBooks.set(bookId, next);
    await this.persistUnattendedState();
    return next;
  }

  private async markActionAttempt(bookId: string, action: UnattendedAction): Promise<void> {
    const current = this.unattendedBooks.get(bookId);
    const attemptsByAction = { ...(current?.attemptsByAction ?? {}) };
    attemptsByAction[action] = (attemptsByAction[action] ?? 0) + 1;
    await this.updateUnattendedBook(bookId, { action, attemptsByAction });
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
    const retryRate = metrics.calls > 0 ? metrics.retries / metrics.calls : 0;
    const timeoutRate = metrics.calls > 0 ? metrics.timeouts / metrics.calls : 0;
    const hardRangeRate = totals.chapters > 0 ? totals.hardRangeChapters / totals.chapters : 0;
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
    if (hardRangeRate < gates.minHardRangeRate) {
      violations.push(`hard-range rate ${hardRangeRate.toFixed(3)} < ${gates.minHardRangeRate}`);
    }

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
    const today = new Date().toISOString().slice(0, 10);
    const count = this.dailyChapterCount.get(today) ?? 0;
    return count >= this.config.maxChaptersPerDay;
  }

  /** Increment daily chapter counter. */
  private async recordChapterWritten(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
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

    const booksToWrite = activeBooks.slice(0, this.config.maxConcurrentBooks);

    // Parallel book processing
    await Promise.all(
      booksToWrite.map((book) => this.processBook(book.id, book.config)),
    );
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

      const success = await this.writeOneChapter(bookId, bookConfig);
      if (!success) {
        const failures = this.consecutiveFailures.get(bookId) ?? 0;
        if (failures <= this.gates.maxAuditRetries && !this.pausedBooks.has(bookId)) {
          const waitMs = Math.max(this.config.retryDelayMs, this.retryWaitMs(bookId));
          this.log?.warn(`${bookId} retrying unattended action in ${waitMs}ms`);
          if (waitMs > 0) await this.sleep(waitMs);
          const retrySuccess = await this.writeOneChapter(bookId, bookConfig);
          if (!retrySuccess) break; // Stop this book's cycle on second failure
        } else {
          break; // Stop this book's cycle
        }
      }
    }
  }

  /** Write one chapter for a book. Returns true if approved. */
  private async writeOneChapter(bookId: string, bookConfig: BookConfig): Promise<boolean> {
    try {
      const pendingChapter = await this.findLatestPendingChapter(bookId);
      if (pendingChapter) {
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

      await this.captureBookMetrics(bookId, (result.lengthWarnings?.length ?? 0) === 0);
      const issueCategories = result.auditResult.issues.map((i) => i.category);
      const classification = result.status === "state-degraded"
        ? { kind: "state-degraded" as const, action: "repair-state" as const }
        : this.classifyAuditIssues(result.auditResult.issues);
      await this.handleAuditFailure(bookId, result.chapterNumber, issueCategories, classification);
      this.config.onChapterComplete?.(bookId, result.chapterNumber, result.status);
      return false;
    } catch (e) {
      this.config.onError?.(bookId, e as Error);
      await this.captureBookMetrics(bookId).catch(() => undefined);
      const kind = classifyUnattendedError(e);
      await this.handleAuditFailure(bookId, 0, [], {
        kind,
        action: kind === "provider-auth" || kind === "budget" ? "pause" : "retry-provider",
        error: e instanceof Error ? e.message : String(e),
      });
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
    if (chapter.status === "state-degraded") {
      await this.markActionAttempt(bookId, "repair-state");
      let repaired = await this.pipeline.repairChapterState(bookId, chapter.number);
      if (repaired.status === "state-degraded") {
        await this.markActionAttempt(bookId, "resync-state");
        repaired = await this.pipeline.resyncChapterArtifacts(bookId, chapter.number);
      }
      if (repaired.status === "ready-for-review") {
        return await this.completeChapter(
          bookId,
          bookConfig,
          chapter.number,
          (repaired.lengthWarnings?.length ?? 0) === 0,
        );
      }

      await this.captureBookMetrics(bookId, (repaired.lengthWarnings?.length ?? 0) === 0);
      const classification = repaired.status === "audit-failed"
        ? this.classifyAuditIssues(repaired.auditResult.issues)
        : { kind: "state-degraded" as const, action: "repair-state" as const };
      await this.handleAuditFailure(
        bookId,
        chapter.number,
        repaired.auditResult.issues.map((issue) => issue.category),
        classification,
      );
      this.config.onChapterComplete?.(bookId, chapter.number, repaired.status);
      return false;
    }

    const persistedAction = this.unattendedBooks.get(bookId)?.action;
    const action: UnattendedAction = persistedAction === "rewrite" ? "rewrite" : "revise";
    await this.markActionAttempt(bookId, action);

    if (action === "rewrite") {
      const rewritten = await this.pipeline.rewriteChapter(
        bookId,
        chapter.number,
        bookConfig.chapterWordCount,
      );
      if (rewritten.status === "ready-for-review") {
        return await this.completeChapter(
          bookId,
          bookConfig,
          chapter.number,
          (rewritten.lengthWarnings?.length ?? 0) === 0,
        );
      }
      await this.captureBookMetrics(bookId, (rewritten.lengthWarnings?.length ?? 0) === 0);
      const classification = rewritten.status === "state-degraded"
        ? { kind: "state-degraded" as const, action: "repair-state" as const }
        : this.classifyAuditIssues(rewritten.auditResult.issues);
      await this.handleAuditFailure(
        bookId,
        chapter.number,
        rewritten.auditResult.issues.map((issue) => issue.category),
        classification,
      );
      this.config.onChapterComplete?.(bookId, chapter.number, rewritten.status);
      return false;
    }

    const revised = await this.pipeline.reviseDraft(bookId, chapter.number, "auto");
    if (revised.status === "ready-for-review") {
      return await this.completeChapter(
        bookId,
        bookConfig,
        chapter.number,
        (revised.lengthWarnings?.length ?? 0) === 0,
      );
    }

    await this.captureBookMetrics(bookId, (revised.lengthWarnings?.length ?? 0) === 0);
    await this.handleAuditFailure(bookId, chapter.number, [], {
      kind: "audit-unknown",
      action: "rewrite",
      error: revised.skippedReason,
    });
    this.config.onChapterComplete?.(bookId, chapter.number, "audit-failed");
    return false;
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
    await this.recordChapterWritten();
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

  private cronToMs(cron: string): number {
    const parts = cron.split(" ");
    if (parts.length < 5) return 24 * 60 * 60 * 1000;

    const minute = parts[0]!;
    const hour = parts[1]!;

    // "*/N * * * *" → every N minutes
    if (minute.startsWith("*/")) {
      const interval = parseInt(minute.slice(2), 10);
      return interval * 60 * 1000;
    }

    // "0 */N * * *" → every N hours
    if (hour.startsWith("*/")) {
      const interval = parseInt(hour.slice(2), 10);
      return interval * 60 * 60 * 1000;
    }

    // Fixed time → treat as daily
    return 24 * 60 * 60 * 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
