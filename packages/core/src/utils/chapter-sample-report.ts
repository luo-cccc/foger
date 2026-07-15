import type { ChapterMeta, ChapterReviewTelemetry } from "../models/chapter.js";
import type { LLMCallTelemetry } from "../llm/provider.js";
import {
  summarizeLLMCallTelemetry,
  type LLMCallTelemetryAggregate,
  type LLMCallTelemetrySummary,
} from "../llm/telemetry-summary.js";
import {
  buildLLMTokenBudgetReport,
  type LLMTokenBudgetReport,
} from "../llm/token-budget.js";

export interface ChapterSampleReportLimits {
  readonly maxTotalTokens?: number;
  readonly maxChapterTokens?: number;
  readonly maxPromptEstimatedTokensPerCall?: number;
  readonly maxRetryRate?: number;
  readonly maxAuditCallsPerChapter?: number;
  readonly maxRevisionCallsPerChapter?: number;
  readonly maxLengthNormalizationCallsPerChapter?: number;
  readonly maxSettlementCallsPerChapter?: number;
}

export interface ChapterSampleReportIssue {
  readonly code: string;
  readonly message: string;
  readonly chapter?: number;
  readonly actual?: number;
  readonly maximum?: number;
}

export interface ChapterSampleTelemetryParseResult {
  readonly records: ReadonlyArray<LLMCallTelemetry>;
  readonly invalidLines: number;
}

export interface ChapterSampleReportChapter {
  readonly number: number;
  readonly title: string;
  readonly status: ChapterMeta["status"];
  readonly wordCount: number;
  readonly auditIssueCount: number;
  readonly operationId?: string;
  readonly indexedTokens: number;
  readonly reviewTelemetry?: ChapterReviewTelemetry;
  readonly governanceCalls: ChapterSampleGovernanceCalls;
  readonly telemetry: LLMCallTelemetryAggregate;
}

export interface ChapterSampleGovernanceCalls {
  readonly audit: number;
  readonly revision: number;
  readonly lengthNormalization: number;
  readonly settlement: number;
  readonly settlementObservation: number;
  readonly stateValidation: number;
  readonly chapterAnalysis: number;
}

export interface ChapterSampleReport {
  readonly schemaVersion: 1;
  readonly bookId: string;
  readonly expectedChapterCount?: number;
  readonly chapters: ReadonlyArray<ChapterSampleReportChapter>;
  readonly totals: {
    readonly chapters: number;
    readonly words: number;
    readonly indexedTokens: number;
    readonly telemetryTokens: number;
    readonly telemetryMinusIndexedTokens: number;
    readonly indexedTelemetryCoverageRate: number;
    readonly telemetryCalls: number;
    readonly retryRate: number;
    readonly reviewTelemetryChapters: number;
    readonly governanceCalls: ChapterSampleGovernanceCalls;
    readonly reviewTerminationReasons: Readonly<Record<string, number>>;
  };
  readonly telemetryWindow: {
    readonly start?: string;
    readonly end?: string;
    readonly matchedChapterOperations: number;
    readonly missingChapterOperations: ReadonlyArray<number>;
    readonly additionalOperationIds: ReadonlyArray<string>;
    readonly unattributedCalls: number;
  };
  readonly telemetry: LLMCallTelemetrySummary;
  readonly tokenBudget: LLMTokenBudgetReport;
  readonly gate: {
    readonly passed: boolean;
    readonly issues: ReadonlyArray<ChapterSampleReportIssue>;
  };
  readonly limitations: ReadonlyArray<string>;
}

export function parseLLMCallTelemetryJsonl(content: string): ChapterSampleTelemetryParseResult {
  const records: LLMCallTelemetry[] = [];
  let invalidLines = 0;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const telemetry = normalizeLLMCallTelemetry(parsed);
      if (!telemetry) {
        invalidLines += 1;
        continue;
      }
      records.push(telemetry);
    } catch {
      invalidLines += 1;
    }
  }

  return { records, invalidLines };
}

export function buildChapterSampleReport(params: {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly telemetry: ReadonlyArray<LLMCallTelemetry>;
  readonly expectedChapterCount?: number;
  readonly limits?: ChapterSampleReportLimits;
  readonly telemetryInvalidLines?: number;
}): ChapterSampleReport {
  const chapterOperationIds = new Set(
    params.chapters
      .map((chapter) => chapter.operationId)
      .filter((operationId): operationId is string => Boolean(operationId)),
  );
  const operationTelemetry = params.telemetry.filter((record) => (
    (!record.bookId || record.bookId === params.bookId)
    && record.operationId !== undefined
    && chapterOperationIds.has(record.operationId)
  ));
  const operationTimes = operationTelemetry
    .map((record) => Date.parse(record.timestamp))
    .filter(Number.isFinite);
  const startMs = operationTimes.length > 0 ? Math.min(...operationTimes) : undefined;
  const chapterUpdatedTimes = params.chapters
    .map((chapter) => Date.parse(chapter.updatedAt))
    .filter(Number.isFinite);
  const endCandidates = [...operationTimes, ...chapterUpdatedTimes];
  const endMs = endCandidates.length > 0 ? Math.max(...endCandidates) : undefined;
  const windowTelemetry = startMs === undefined || endMs === undefined
    ? operationTelemetry
    : params.telemetry.filter((record) => {
      if (record.bookId && record.bookId !== params.bookId) return false;
      const timestamp = Date.parse(record.timestamp);
      return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs;
    });
  const telemetry = summarizeLLMCallTelemetry(windowTelemetry);
  const limits = params.limits ?? {};
  const tokenBudget = buildLLMTokenBudgetReport(windowTelemetry, {
    maxTotalTokens: limits.maxTotalTokens,
    maxPromptEstimatedTokensPerCall: limits.maxPromptEstimatedTokensPerCall,
  });
  const issues: ChapterSampleReportIssue[] = [];
  const acceptedStatuses = new Set<ChapterMeta["status"]>([
    "ready-for-review",
    "approved",
    "published",
  ]);

  if (
    params.expectedChapterCount !== undefined
    && params.chapters.length !== params.expectedChapterCount
  ) {
    issues.push({
      code: "chapter-count",
      message: `Expected ${params.expectedChapterCount} chapters, found ${params.chapters.length}.`,
      actual: params.chapters.length,
      maximum: params.expectedChapterCount,
    });
  }

  const chapterReports = params.chapters.map((chapter): ChapterSampleReportChapter => {
    const records = chapter.operationId
      ? operationTelemetry.filter((record) => record.operationId === chapter.operationId)
      : [];
    const summary = summarizeLLMCallTelemetry(records);
    const governanceCalls = countGovernanceCalls(records);

    if (!acceptedStatuses.has(chapter.status)) {
      issues.push({
        code: "chapter-status",
        chapter: chapter.number,
        message: `Chapter ${chapter.number} ended as ${chapter.status}.`,
      });
    }
    if (!chapter.operationId || records.length === 0) {
      issues.push({
        code: "missing-operation-telemetry",
        chapter: chapter.number,
        message: `Chapter ${chapter.number} has no correlated operation telemetry.`,
      });
    }
    if (
      limits.maxChapterTokens !== undefined
      && summary.usage.totalTokens > limits.maxChapterTokens
    ) {
      issues.push({
        code: "chapter-token-budget",
        chapter: chapter.number,
        message: `Chapter ${chapter.number} used ${summary.usage.totalTokens} telemetry tokens, above ${limits.maxChapterTokens}.`,
        actual: summary.usage.totalTokens,
        maximum: limits.maxChapterTokens,
      });
    }
    addGovernanceCallLimitIssue({
      issues,
      chapter: chapter.number,
      code: "chapter-audit-call-budget",
      label: "audit",
      actual: governanceCalls.audit,
      maximum: limits.maxAuditCallsPerChapter,
    });
    addGovernanceCallLimitIssue({
      issues,
      chapter: chapter.number,
      code: "chapter-revision-call-budget",
      label: "revision",
      actual: governanceCalls.revision,
      maximum: limits.maxRevisionCallsPerChapter,
    });
    addGovernanceCallLimitIssue({
      issues,
      chapter: chapter.number,
      code: "chapter-normalization-call-budget",
      label: "length-normalization",
      actual: governanceCalls.lengthNormalization,
      maximum: limits.maxLengthNormalizationCallsPerChapter,
    });
    addGovernanceCallLimitIssue({
      issues,
      chapter: chapter.number,
      code: "chapter-settlement-call-budget",
      label: "settlement",
      actual: governanceCalls.settlement,
      maximum: limits.maxSettlementCallsPerChapter,
    });

    return {
      number: chapter.number,
      title: chapter.title,
      status: chapter.status,
      wordCount: chapter.wordCount,
      auditIssueCount: chapter.auditIssues.length,
      operationId: chapter.operationId,
      indexedTokens: chapter.tokenUsage?.totalTokens ?? 0,
      reviewTelemetry: chapter.reviewTelemetry,
      governanceCalls,
      telemetry: pickAggregate(summary),
    };
  });

  const additionalOperationIds = [...new Set(
    windowTelemetry
      .map((record) => record.operationId)
      .filter((operationId): operationId is string => (
        typeof operationId === "string" && !chapterOperationIds.has(operationId)
      )),
  )].sort();
  const unattributedCalls = windowTelemetry.filter((record) => !record.operationId).length;
  if (unattributedCalls > 0) {
    issues.push({
      code: "unattributed-telemetry",
      message: `${unattributedCalls} call(s) inside the sample window have no operationId.`,
      actual: unattributedCalls,
    });
  }
  if ((params.telemetryInvalidLines ?? 0) > 0) {
    issues.push({
      code: "invalid-telemetry-lines",
      message: `${params.telemetryInvalidLines} telemetry line(s) could not be parsed.`,
      actual: params.telemetryInvalidLines,
    });
  }
  if (telemetry.statuses.error + telemetry.statuses.timeout + telemetry.statuses.partial > 0) {
    issues.push({
      code: "telemetry-status",
      message: "The sample contains error, timeout, or partial LLM calls.",
      actual: telemetry.statuses.error + telemetry.statuses.timeout + telemetry.statuses.partial,
      maximum: 0,
    });
  }
  for (const violation of tokenBudget.violations) {
    issues.push({
      code: violation.scope === "call" ? "prompt-token-budget" : "total-token-budget",
      message: `${violation.scope} ${violation.metric} is ${violation.actual}, above ${violation.maximum}.`,
      actual: violation.actual,
      maximum: violation.maximum,
    });
  }

  const retryRate = telemetry.attempts > 0 ? telemetry.retries / telemetry.attempts : 0;
  if (limits.maxRetryRate !== undefined && retryRate > limits.maxRetryRate) {
    issues.push({
      code: "retry-rate",
      message: `Retry rate ${retryRate.toFixed(4)} is above ${limits.maxRetryRate}.`,
      actual: retryRate,
      maximum: limits.maxRetryRate,
    });
  }

  const indexedTokens = params.chapters.reduce(
    (sum, chapter) => sum + (chapter.tokenUsage?.totalTokens ?? 0),
    0,
  );
  const governanceCalls = chapterReports.reduce(
    (total, chapter) => addGovernanceCalls(total, chapter.governanceCalls),
    emptyGovernanceCalls(),
  );
  const reviewTerminationReasons = chapterReports.reduce<Record<string, number>>(
    (counts, chapter) => {
      const reason = chapter.reviewTelemetry?.terminationReason;
      if (reason) counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    },
    {},
  );

  return {
    schemaVersion: 1,
    bookId: params.bookId,
    expectedChapterCount: params.expectedChapterCount,
    chapters: chapterReports,
    totals: {
      chapters: params.chapters.length,
      words: params.chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      indexedTokens,
      telemetryTokens: telemetry.usage.totalTokens,
      telemetryMinusIndexedTokens: telemetry.usage.totalTokens - indexedTokens,
      indexedTelemetryCoverageRate: telemetry.usage.totalTokens > 0
        ? indexedTokens / telemetry.usage.totalTokens
        : 1,
      telemetryCalls: telemetry.calls,
      retryRate,
      reviewTelemetryChapters: chapterReports.filter((chapter) => chapter.reviewTelemetry).length,
      governanceCalls,
      reviewTerminationReasons,
    },
    telemetryWindow: {
      start: startMs === undefined ? undefined : new Date(startMs).toISOString(),
      end: endMs === undefined ? undefined : new Date(endMs).toISOString(),
      matchedChapterOperations: chapterReports.filter((chapter) => chapter.telemetry.calls > 0).length,
      missingChapterOperations: chapterReports
        .filter((chapter) => chapter.telemetry.calls === 0)
        .map((chapter) => chapter.number),
      additionalOperationIds,
      unattributedCalls,
    },
    telemetry,
    tokenBudget,
    gate: { passed: issues.length === 0, issues },
    limitations: [
      "Fallback diagnostics are not persisted in llm-calls JSONL and must be joined from pipeline diagnostics when available.",
      "Per-chapter telemetry excludes additional or unattributed recovery operations; totals include every call inside the sample window.",
      "Review termination telemetry is available only for chapters written after that field was introduced; governance phase counts remain available from operation telemetry.",
    ],
  };
}

function addGovernanceCallLimitIssue(params: {
  readonly issues: ChapterSampleReportIssue[];
  readonly chapter: number;
  readonly code: string;
  readonly label: string;
  readonly actual: number;
  readonly maximum?: number;
}): void {
  if (params.maximum === undefined || params.actual <= params.maximum) return;
  params.issues.push({
    code: params.code,
    chapter: params.chapter,
    message: `Chapter ${params.chapter} used ${params.actual} ${params.label} call(s), above ${params.maximum}.`,
    actual: params.actual,
    maximum: params.maximum,
  });
}

function countGovernanceCalls(records: ReadonlyArray<LLMCallTelemetry>): ChapterSampleGovernanceCalls {
  const countPhase = (phase: string): number => records.filter((record) => record.phase === phase).length;
  return {
    audit: countPhase("audit"),
    revision: countPhase("revise"),
    lengthNormalization: countPhase("normalize-length"),
    settlement: countPhase("settle"),
    settlementObservation: countPhase("settle-observe"),
    stateValidation: countPhase("validate-state"),
    chapterAnalysis: countPhase("analyze"),
  };
}

function emptyGovernanceCalls(): ChapterSampleGovernanceCalls {
  return {
    audit: 0,
    revision: 0,
    lengthNormalization: 0,
    settlement: 0,
    settlementObservation: 0,
    stateValidation: 0,
    chapterAnalysis: 0,
  };
}

function addGovernanceCalls(
  left: ChapterSampleGovernanceCalls,
  right: ChapterSampleGovernanceCalls,
): ChapterSampleGovernanceCalls {
  return {
    audit: left.audit + right.audit,
    revision: left.revision + right.revision,
    lengthNormalization: left.lengthNormalization + right.lengthNormalization,
    settlement: left.settlement + right.settlement,
    settlementObservation: left.settlementObservation + right.settlementObservation,
    stateValidation: left.stateValidation + right.stateValidation,
    chapterAnalysis: left.chapterAnalysis + right.chapterAnalysis,
  };
}

function pickAggregate(summary: LLMCallTelemetrySummary): LLMCallTelemetryAggregate {
  return {
    calls: summary.calls,
    attempts: summary.attempts,
    retries: summary.retries,
    totalDurationMs: summary.totalDurationMs,
    statuses: summary.statuses,
    usage: summary.usage,
    prompt: summary.prompt,
  };
}

function normalizeLLMCallTelemetry(value: unknown): LLMCallTelemetry | null {
  if (!isRecord(value) || !isRecord(value.usage) || !isRecord(value.promptAssembly)) {
    if (!isLegacyLLMCallTelemetry(value)) return null;
    return {
      bookId: typeof value.bookId === "string" ? value.bookId : undefined,
      operationId: typeof value.operationId === "string" ? value.operationId : undefined,
      agent: value.agent,
      model: value.model,
      service: value.service,
      apiFormat: value.apiFormat === "responses" ? "responses" : "chat",
      stream: typeof value.stream === "boolean" ? value.stream : false,
      phase: value.phase,
      durationMs: value.durationMs,
      attemptCount: 1,
      retryCount: 0,
      promptAssembly: {
        totalChars: 0,
        estimatedTokens: 0,
        messages: [],
        sources: [],
        duplicateSourceGroups: [],
      },
      status: value.status,
      usage: {
        promptTokens: value.usage.promptTokens as number,
        completionTokens: value.usage.completionTokens as number,
        totalTokens: value.usage.totalTokens as number,
      },
      timestamp: value.timestamp,
    };
  }
  if (!(typeof value.agent === "string"
    && typeof value.model === "string"
    && typeof value.service === "string"
    && typeof value.phase === "string"
    && typeof value.durationMs === "number"
    && typeof value.attemptCount === "number"
    && typeof value.retryCount === "number"
    && typeof value.timestamp === "string"
    && typeof value.usage.promptTokens === "number"
    && typeof value.usage.completionTokens === "number"
    && typeof value.usage.totalTokens === "number"
    && typeof value.promptAssembly.totalChars === "number"
    && typeof value.promptAssembly.estimatedTokens === "number"
    && Array.isArray(value.promptAssembly.messages)
    && Array.isArray(value.promptAssembly.sources)
    && Array.isArray(value.promptAssembly.duplicateSourceGroups)
    && (value.status === "success"
      || value.status === "timeout"
      || value.status === "error"
      || value.status === "partial"))) {
    return null;
  }
  return value as unknown as LLMCallTelemetry;
}

function isLegacyLLMCallTelemetry(value: unknown): value is Record<string, unknown> & {
  agent: string;
  model: string;
  service: string;
  phase: string;
  durationMs: number;
  status: LLMCallTelemetry["status"];
  timestamp: string;
  usage: Record<string, unknown>;
} {
  if (!isRecord(value) || !isRecord(value.usage)) return false;
  return typeof value.agent === "string"
    && typeof value.model === "string"
    && typeof value.service === "string"
    && typeof value.phase === "string"
    && typeof value.durationMs === "number"
    && typeof value.timestamp === "string"
    && typeof value.usage.promptTokens === "number"
    && typeof value.usage.completionTokens === "number"
    && typeof value.usage.totalTokens === "number"
    && (value.status === "success"
      || value.status === "timeout"
      || value.status === "error"
      || value.status === "partial");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
