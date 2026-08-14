import { PipelineRunner } from "./runner.js";
import type { EpisodePipelineResult, PipelineConfig } from "./runner.js";
import { StateManager } from "../state/manager.js";
import type { BookConfig } from "../models/book.js";
import type { QualityGates, DetectionConfig } from "../models/project.js";
import { dispatchWebhookEvent } from "../notify/dispatcher.js";
import { detectEpisode, detectAndRewrite } from "./detection-runner.js";
import type { Logger } from "../utils/logger.js";
import type { AuditIssue } from "../agents/continuity.js";
import type { EpisodeMeta } from "../models/episode.js";
import type { LLMCallTelemetry } from "../llm/provider.js";
import type { PipelineDiagnostic } from "./diagnostics.js";
import { Cron } from "croner";
import {
  auditIssuesFromEpisodeRecovery,
  decideEpisodeRecovery,
  fingerprintEpisodeContent,
  type EpisodeRecoveryAction,
} from "./episode-recovery-policy.js";
import {
  classifyUnattendedError,
  createEmptyUnattendedState,
  UnattendedStateStore,
  type UnattendedAction,
  type UnattendedBookState,
  type UnattendedEpisodeMetrics,
  type UnattendedFailureKind,
  type UnattendedSchedulerState,
  type UnattendedTotals,
} from "./unattended-state.js";

export interface SchedulerConfig extends PipelineConfig {
  readonly writeCron: string;
  readonly maxConcurrentBooks: number;
  readonly episodesPerCycle: number;
  readonly retryDelayMs: number;
  readonly cooldownAfterEpisodeMs: number;
  readonly maxEpisodesPerDay: number;
  readonly qualityGates?: QualityGates;
  readonly detection?: DetectionConfig;
  readonly onEpisodeComplete?: (bookId: string, episode: number, status: string) => void;
  readonly onEpisodeResult?: (bookId: string, result: EpisodePipelineResult) => void;
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
  private reservedEpisodeSlots = 0;

  // Quality gate tracking (per book)
  private consecutiveFailures = new Map<string, number>();
  private pausedBooks = new Set<string>();
  // Failure clustering: bookId → (dimension → count)
  private failureDimensions = new Map<string, Map<string, number>>();
  // Daily episode counter: "YYYY-MM-DD" → count
  private dailyEpisodeCount = new Map<string, number>();
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
    this.dailyEpisodeCount = new Map(Object.entries(persisted.dailyEpisodeCount));
  }

  private persistUnattendedState(): Promise<void> {
    const state: UnattendedSchedulerState = {
      ...createEmptyUnattendedState(),
      books: Object.fromEntries(this.unattendedBooks),
      dailyEpisodeCount: Object.fromEntries(this.dailyEpisodeCount),
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
    return decideEpisodeRecovery({
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

  private emptyEpisodeMetrics(): UnattendedEpisodeMetrics {
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
      episodes: 0,
      hardRangeEpisodes: 0,
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
  ): Promise<UnattendedEpisodeMetrics> {
    const telemetry = this.telemetryByBook.get(bookId) ?? [];
    const diagnostics = this.diagnosticsByBook.get(bookId) ?? [];
    this.telemetryByBook.delete(bookId);
    this.diagnosticsByBook.delete(bookId);

    const current = this.unattendedBooks.get(bookId)?.currentMetrics ?? this.emptyEpisodeMetrics();
    const metrics: UnattendedEpisodeMetrics = {
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

  private async enforceEpisodeRuntimeGates(
    bookId: string,
    episodeNumber: number,
    withinHardRange: boolean,
  ): Promise<boolean> {
    const metrics = await this.captureBookMetrics(bookId, withinHardRange);
    const previousTotals = this.unattendedBooks.get(bookId)?.totals ?? this.emptyTotals();
    const totals: UnattendedTotals = {
      episodes: previousTotals.episodes + 1,
      hardRangeEpisodes: previousTotals.hardRangeEpisodes + (withinHardRange ? 1 : 0),
      calls: previousTotals.calls + metrics.calls,
      retries: previousTotals.retries + metrics.retries,
      timeouts: previousTotals.timeouts + metrics.timeouts,
      errors: previousTotals.errors + metrics.errors,
      totalTokens: previousTotals.totalTokens + metrics.totalTokens,
      fallbacks: previousTotals.fallbacks + metrics.fallbacks,
    };
    const hardRangeRate = totals.episodes > 0 ? totals.hardRangeEpisodes / totals.episodes : 0;
    const violations = this.episodeRuntimeViolations(metrics, hardRangeRate);

    await this.updateUnattendedBook(bookId, {
      currentMetrics: undefined,
      lastMetrics: metrics,
      totals,
      lastEpisodeNumber: episodeNumber,
    });
    if (violations.length === 0) return true;

    await this.handleAuditFailure(bookId, episodeNumber, ["unattended-runtime-budget"], {
      kind: "budget",
      action: "pause",
      error: `Unattended runtime gate failed: ${violations.join("; ")}`,
    });
    return false;
  }

  private episodeRuntimeViolations(
    metrics: UnattendedEpisodeMetrics,
    hardRangeRate?: number,
  ): string[] {
    const retryRate = metrics.calls > 0 ? metrics.retries / metrics.calls : 0;
    const timeoutRate = metrics.calls > 0 ? metrics.timeouts / metrics.calls : 0;
    const gates = this.gates;
    const violations: string[] = [];
    if (metrics.totalTokens > gates.maxEpisodeTokens) {
      violations.push(`episode tokens ${metrics.totalTokens} > ${gates.maxEpisodeTokens}`);
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
    if (metrics.fallbacks > gates.maxFallbacksPerEpisode) {
      violations.push(`fallbacks ${metrics.fallbacks} > ${gates.maxFallbacksPerEpisode}`);
    }
    const governanceLimits = this.config.governanceCallLimits;
    if (
      governanceLimits?.maxRevisionCallsPerEpisode !== undefined
      && metrics.revisionCalls > governanceLimits.maxRevisionCallsPerEpisode
    ) {
      violations.push(
        `revision calls ${metrics.revisionCalls} > ${governanceLimits.maxRevisionCallsPerEpisode}`,
      );
    }
    if (
      governanceLimits?.maxSettlementCallsPerEpisode !== undefined
      && metrics.settlementCalls > governanceLimits.maxSettlementCallsPerEpisode
    ) {
      violations.push(
        `settlement calls ${metrics.settlementCalls} > ${governanceLimits.maxSettlementCallsPerEpisode}`,
      );
    }
    if (hardRangeRate !== undefined && hardRangeRate < gates.minHardRangeRate) {
      violations.push(`hard-range rate ${hardRangeRate.toFixed(3)} < ${gates.minHardRangeRate}`);
    }
    return violations;
  }

  private async pauseForCurrentRuntimeViolations(
    bookId: string,
    episodeNumber: number,
    metrics: UnattendedEpisodeMetrics,
    issueCategories: ReadonlyArray<string> = [],
  ): Promise<boolean> {
    const violations = this.episodeRuntimeViolations(metrics);
    if (violations.length === 0) return false;
    await this.handleAuditFailure(bookId, episodeNumber, [
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
    episode: EpisodeMeta,
  ): Promise<boolean> {
    const metrics = this.unattendedBooks.get(bookId)?.currentMetrics;
    const limits = this.config.governanceCallLimits;
    if (!metrics || !limits) return false;

    const persistedAction = this.unattendedBooks.get(bookId)?.action;
    const violations: string[] = [];
    if (
      episode.status === "state-degraded"
      && limits.maxSettlementCallsPerEpisode !== undefined
      && metrics.settlementCalls >= limits.maxSettlementCallsPerEpisode
    ) {
      violations.push(
        `settlement calls ${metrics.settlementCalls} reached ${limits.maxSettlementCallsPerEpisode} before state recovery`,
      );
    }
    if (
      episode.status === "audit-failed"
      && persistedAction !== "rewrite"
      && limits.maxRevisionCallsPerEpisode !== undefined
      && metrics.revisionCalls >= limits.maxRevisionCallsPerEpisode
    ) {
      violations.push(
        `revision calls ${metrics.revisionCalls} reached ${limits.maxRevisionCallsPerEpisode} before revision recovery`,
      );
    }
    if (
      episode.status === "audit-failed"
      && persistedAction === "rewrite"
      && limits.maxSettlementCallsPerEpisode !== undefined
      && metrics.settlementCalls >= limits.maxSettlementCallsPerEpisode
    ) {
      violations.push(
        `settlement calls ${metrics.settlementCalls} reached ${limits.maxSettlementCallsPerEpisode} before rewrite recovery`,
      );
    }
    if (violations.length === 0) return false;

    await this.handleAuditFailure(bookId, episode.episodeNumber, ["unattended-governance-budget"], {
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
      maxEpisodeTokens: 100_000,
      maxPromptTokensPerCall: 16_000,
      maxRetryRate: 0.2,
      maxTimeoutRate: 0,
      maxFallbacksPerEpisode: 0,
      minHardRangeRate: 0.8,
    };
  }

  /** Check if daily cap is reached across all books. */
  private isDailyCapReached(): boolean {
    const today = this.localDateKey();
    const count = this.dailyEpisodeCount.get(today) ?? 0;
    return count + this.reservedEpisodeSlots >= this.config.maxEpisodesPerDay;
  }

  /** Increment daily episode counter. */
  private async recordEpisodeWritten(): Promise<void> {
    const today = this.localDateKey();
    const count = this.dailyEpisodeCount.get(today) ?? 0;
    this.dailyEpisodeCount.set(today, count + 1);

    // Clean up old dates (keep only today)
    for (const key of this.dailyEpisodeCount.keys()) {
      if (key !== today) this.dailyEpisodeCount.delete(key);
    }
    await this.persistUnattendedState();
  }

  private async runWriteCycle(): Promise<void> {
    if (this.isDailyCapReached()) {
      this.log?.info(`Daily cap reached (${this.config.maxEpisodesPerDay}), skipping cycle`);
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

  /** Process a single book: write episodesPerCycle episodes with retry + cooldown. */
  private async processBook(bookId: string, bookConfig: BookConfig): Promise<void> {
    for (let i = 0; i < this.config.episodesPerCycle; i++) {
      if (!this.running) return;
      if (this.isDailyCapReached()) return;
      if (this.pausedBooks.has(bookId)) return;

      // Cooldown between episodes (skip for the first one)
      if (i > 0 && this.config.cooldownAfterEpisodeMs > 0) {
        await this.sleep(this.config.cooldownAfterEpisodeMs);
      }

      const success = await this.writeOneEpisodeWithinDailyCap(bookId, bookConfig);
      if (!success) {
        if (this.isDailyCapReached()) return;
        const failures = this.consecutiveFailures.get(bookId) ?? 0;
        if (failures <= this.gates.maxAuditRetries && !this.pausedBooks.has(bookId)) {
          const waitMs = Math.max(this.config.retryDelayMs, this.retryWaitMs(bookId));
          this.log?.warn(`${bookId} retrying unattended action in ${waitMs}ms`);
          if (waitMs > 0) await this.sleep(waitMs);
          const retrySuccess = await this.writeOneEpisodeWithinDailyCap(bookId, bookConfig);
          if (!retrySuccess) break; // Stop this book's cycle on second failure
        } else {
          break; // Stop this book's cycle
        }
      }
    }
  }

  /** Write one episode for a book. Returns true if approved. */
  private async writeOneEpisode(bookId: string, bookConfig: BookConfig): Promise<boolean> {
    let attemptedEpisode: EpisodeMeta | undefined;
    try {
      const pendingEpisode = await this.findLatestPendingEpisode(bookId);
      if (pendingEpisode) {
        attemptedEpisode = pendingEpisode;
        if (await this.pauseBeforePendingGovernanceCall(bookId, pendingEpisode)) {
          this.config.onEpisodeComplete?.(bookId, pendingEpisode.episodeNumber, pendingEpisode.status);
          return false;
        }
        return await this.recoverPendingEpisode(bookId, bookConfig, pendingEpisode);
      }

      // Compute temperature override: base 0.7 + failures * step
      const failures = this.consecutiveFailures.get(bookId) ?? 0;
      const tempOverride = failures > 0
        ? Math.min(1.2, 0.7 + failures * this.gates.retryTemperatureStep)
        : undefined;

      const result = await this.pipeline.writeNextEpisode(bookId, undefined, tempOverride);
      this.config.onEpisodeResult?.(bookId, result);

      if (result.status === "ready-for-review") {
        return await this.completeEpisode(
          bookId,
          bookConfig,
          result.episodeNumber,
          (result.lengthWarnings?.length ?? 0) === 0,
        );
      }

      const issueCategories = result.auditResult.issues.map((i) => i.category);
      const metrics = await this.captureBookMetrics(bookId, (result.lengthWarnings?.length ?? 0) === 0);
      if (await this.pauseForCurrentRuntimeViolations(
        bookId,
        result.episodeNumber,
        metrics,
        issueCategories,
      )) {
        this.config.onEpisodeComplete?.(bookId, result.episodeNumber, result.status);
        return false;
      }
      const classification = result.status === "state-degraded"
        ? { kind: "state-degraded" as const, action: "repair-state" as const }
        : this.classifyAuditIssues(result.auditResult.issues);
      await this.handleAuditFailure(bookId, result.episodeNumber, issueCategories, classification);
      this.config.onEpisodeComplete?.(bookId, result.episodeNumber, result.status);
      return false;
    } catch (e) {
      if (this.isShutdownError(e)) return false;
      this.config.onError?.(bookId, e as Error);
      const episodeNumber = attemptedEpisode?.episodeNumber ?? 0;
      const metrics = await this.captureBookMetrics(bookId).catch(() => undefined);
      const pausedForRuntime = metrics
        ? await this.pauseForCurrentRuntimeViolations(bookId, episodeNumber, metrics)
        : false;
      if (!pausedForRuntime) {
        const kind = classifyUnattendedError(e);
        await this.handleAuditFailure(bookId, episodeNumber, [], {
          kind,
          action: kind === "provider-auth" || kind === "provider-content-policy" || kind === "budget"
            ? "pause"
            : "retry-provider",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (attemptedEpisode) {
        this.config.onEpisodeComplete?.(bookId, attemptedEpisode.episodeNumber, attemptedEpisode.status);
      }
      return false;
    }
  }

  private async findLatestPendingEpisode(bookId: string): Promise<EpisodeMeta | undefined> {
    const episodes = await this.state.loadEpisodeIndex(bookId);
    const latest = [...episodes].sort((left, right) => right.episodeNumber - left.episodeNumber)[0];
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

  private async recoverPendingEpisode(
    bookId: string,
    bookConfig: BookConfig,
    episode: EpisodeMeta,
  ): Promise<boolean> {
    let current = episode;
    let content = await this.readEpisodeContent(this.state.bookDir(bookId), episode.episodeNumber);
    let fingerprint = fingerprintEpisodeContent(content);
    let issues: ReadonlyArray<AuditIssue> = auditIssuesFromEpisodeRecovery(current, content);

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
          ? await this.pipeline.repairEpisodeState(bookId, current.episodeNumber)
          : await this.pipeline.resyncEpisodeArtifacts(bookId, current.episodeNumber);
        if (repaired.status === "ready-for-review") {
          return await this.completeEpisode(
            bookId,
            bookConfig,
            current.episodeNumber,
            (repaired.lengthWarnings?.length ?? 0) === 0,
          );
        }

        const refreshed = await this.loadEpisodeForRecovery(bookId, current.episodeNumber);
        current = refreshed.episode;
        content = refreshed.content;
        fingerprint = refreshed.fingerprint;
        issues = repaired.status === "audit-failed"
          ? repaired.auditResult.issues
          : auditIssuesFromEpisodeRecovery(current, content);

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
      const rewritten = await this.pipeline.rewriteEpisode(
        bookId,
        current.episodeNumber,
        bookConfig.episodeDurationSeconds,
      );
      if (rewritten.status === "ready-for-review") {
        return await this.completeEpisode(
          bookId,
          bookConfig,
          current.episodeNumber,
          (rewritten.lengthWarnings?.length ?? 0) === 0,
        );
      }
      if (rewritten.status === "drafted") {
        throw new Error("Unattended scheduler received a manual-mode drafted episode.");
      }
      await this.captureBookMetrics(bookId, (rewritten.lengthWarnings?.length ?? 0) === 0);
      const refreshed = await this.loadEpisodeForRecovery(bookId, current.episodeNumber);
      const rewrittenIssues = rewritten.status === "audit-failed"
        ? rewritten.auditResult.issues
        : auditIssuesFromEpisodeRecovery(refreshed.episode, refreshed.content);
      const next = this.recoveryDecision(
        bookId,
        rewritten.status,
        rewrittenIssues,
        refreshed.fingerprint,
      );
      await this.recordPendingRecoveryDecision(bookId, refreshed.episode, rewrittenIssues, next);
      return false;
    }

    const revised = await this.pipeline.reviseDraft(bookId, current.episodeNumber, "auto");
    if (revised.status === "ready-for-review") {
      return await this.completeEpisode(
        bookId,
        bookConfig,
        current.episodeNumber,
        (revised.lengthWarnings?.length ?? 0) === 0,
      );
    }

    await this.captureBookMetrics(bookId, (revised.lengthWarnings?.length ?? 0) === 0);
    const refreshed = await this.loadEpisodeForRecovery(bookId, current.episodeNumber);
    const nextStatus = refreshed.episode.status === "state-degraded"
      ? "state-degraded"
      : "audit-failed";
    const revisedIssues = auditIssuesFromEpisodeRecovery(refreshed.episode, refreshed.content);
    const next = this.recoveryDecision(
      bookId,
      nextStatus,
      revisedIssues,
      refreshed.fingerprint,
    );
    await this.recordPendingRecoveryDecision(
      bookId,
      refreshed.episode,
      revisedIssues,
      revised.skippedReason ? { ...next, reason: `${next.reason} ${revised.skippedReason}` } : next,
    );
    return false;
  }

  private async loadEpisodeForRecovery(bookId: string, episodeNumber: number): Promise<{
    readonly episode: EpisodeMeta;
    readonly content: string;
    readonly fingerprint: string;
  }> {
    const episode = (await this.state.loadEpisodeIndex(bookId))
      .find((entry) => entry.episodeNumber === episodeNumber);
    if (!episode) throw new Error(`Episode ${episodeNumber} disappeared during recovery.`);
    const content = await this.readEpisodeContent(this.state.bookDir(bookId), episodeNumber);
    return { episode, content, fingerprint: fingerprintEpisodeContent(content) };
  }

  private async recordPendingRecoveryDecision(
    bookId: string,
    episode: EpisodeMeta,
    issues: ReadonlyArray<AuditIssue>,
    decision: { readonly action: EpisodeRecoveryAction; readonly reason: string },
  ): Promise<void> {
    if (decision.action === "pause") {
      await this.pauseForRecoveryDecision(bookId, episode, issues, decision);
      return;
    }
    const classified = episode.status === "state-degraded"
      ? { kind: "state-degraded" as const }
      : this.classifyAuditIssues(issues);
    await this.handleAuditFailure(
      bookId,
      episode.episodeNumber,
      issues.map((issue) => issue.category),
      {
        kind: classified.kind,
        action: decision.action,
        error: decision.reason,
      },
    );
    this.config.onEpisodeComplete?.(bookId, episode.episodeNumber, episode.status);
  }

  private async pauseForRecoveryDecision(
    bookId: string,
    episode: EpisodeMeta,
    issues: ReadonlyArray<AuditIssue>,
    decision: { readonly reason: string },
  ): Promise<void> {
    await this.captureBookMetrics(bookId).catch(() => undefined);
    const kind = episode.status === "state-degraded"
      ? "state-degraded" as const
      : this.classifyAuditIssues(issues).kind;
    await this.handleAuditFailure(
      bookId,
      episode.episodeNumber,
      issues.map((issue) => issue.category),
      { kind, action: "pause", error: decision.reason },
    );
    this.config.onEpisodeComplete?.(bookId, episode.episodeNumber, episode.status);
  }

  private async completeEpisode(
    bookId: string,
    bookConfig: BookConfig,
    episodeNumber: number,
    withinHardRange: boolean,
  ): Promise<boolean> {
    const runtimeGatesPassed = await this.enforceEpisodeRuntimeGates(
      bookId,
      episodeNumber,
      withinHardRange,
    );
    if (!runtimeGatesPassed) {
      this.config.onEpisodeComplete?.(bookId, episodeNumber, "ready-for-review");
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
      lastEpisodeNumber: episodeNumber,
      lastFailureKind: undefined,
      lastError: undefined,
      nextAttemptAt: undefined,
      lastSuccessAt: new Date().toISOString(),
    });

    if (this.config.detection?.enabled) {
      await this.runDetection(bookId, bookConfig, episodeNumber);
    }
    this.config.onEpisodeComplete?.(bookId, episodeNumber, "ready-for-review");
    return true;
  }

  private async runDetection(
    bookId: string,
    bookConfig: BookConfig,
    episodeNumber: number,
  ): Promise<void> {
    if (!this.config.detection) return;
    try {
      const bookDir = this.state.bookDir(bookId);
      const episodeContent = await this.readEpisodeContent(bookDir, episodeNumber);
      const detResult = await detectEpisode(
        this.config.detection,
        episodeContent,
        episodeNumber,
      );
      if (!detResult.passed && this.config.detection.autoRewrite) {
        await detectAndRewrite(
          this.config.detection,
          { client: this.config.client, model: this.config.model, projectRoot: this.config.projectRoot },
          bookDir,
          episodeContent,
          episodeNumber,
          bookConfig.genre,
        );
      }
    } catch (e) {
      this.config.onError?.(bookId, e as Error);
    }
  }

  private async handleAuditFailure(
    bookId: string,
    episodeNumber: number,
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
          await this.emitDiagnosticAlert(bookId, episodeNumber, dimension, count);
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
        lastEpisodeNumber: episodeNumber > 0 ? episodeNumber : undefined,
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
        lastEpisodeNumber: episodeNumber > 0 ? episodeNumber : undefined,
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
          episodeNumber: episodeNumber > 0 ? episodeNumber : undefined,
          timestamp: new Date().toISOString(),
          data: { reason, consecutiveFailures: failures, kind: details.kind },
        });
      }
    }
  }

  private async emitDiagnosticAlert(
    bookId: string,
    episodeNumber: number,
    dimension: string,
    count: number,
  ): Promise<void> {
    this.log?.warn(`DIAGNOSTIC: ${bookId} has ${count} failures in dimension "${dimension}"`);

    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      await dispatchWebhookEvent(this.config.notifyChannels, {
        event: "diagnostic-alert",
        bookId,
        episodeNumber: episodeNumber > 0 ? episodeNumber : undefined,
        timestamp: new Date().toISOString(),
        data: { dimension, failureCount: count },
      });
    }
  }

  private async readEpisodeContent(bookDir: string, episodeNumber: number): Promise<string> {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const episodesDir = join(bookDir, "episodes");
    const files = await readdir(episodesDir);
    const paddedNum = String(episodeNumber).padStart(4, "0");
    const episodeFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!episodeFile) {
      throw new Error(`Episode ${episodeNumber} file not found in ${episodesDir}`);
    }
    const raw = await readFile(join(episodesDir, episodeFile), "utf-8");
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }

  private async writeOneEpisodeWithinDailyCap(bookId: string, bookConfig: BookConfig): Promise<boolean> {
    if (!this.tryReserveEpisodeSlot()) return false;
    let success = false;
    try {
      success = await this.writeOneEpisode(bookId, bookConfig);
      return success;
    } finally {
      this.reservedEpisodeSlots = Math.max(0, this.reservedEpisodeSlots - 1);
      if (success) await this.recordEpisodeWritten();
    }
  }

  private tryReserveEpisodeSlot(): boolean {
    const today = this.localDateKey();
    const written = this.dailyEpisodeCount.get(today) ?? 0;
    if (written + this.reservedEpisodeSlots >= this.config.maxEpisodesPerDay) return false;
    this.reservedEpisodeSlots += 1;
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
