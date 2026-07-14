import type { SSEMessage } from "../hooks/use-sse";
import {
  classifyLLMCallRootCause,
  type LLMRootCauseKind,
} from "./error-copy";

export type LLMCallStatus = "success" | "timeout" | "error" | "partial";

export interface StudioLLMTelemetryEvent {
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly bookId?: string;
  readonly agent: string;
  readonly phase: string;
  readonly status: LLMCallStatus;
  readonly service: string;
  readonly model: string;
  readonly durationMs: number;
  readonly timeoutMs?: number;
  readonly attemptCount?: number;
  readonly retryCount?: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly partialContentLength?: number;
  readonly errorMessage?: string;
}

export interface StudioLLMTelemetryRecord extends StudioLLMTelemetryEvent {
  readonly timestamp: number;
}

export interface LLMTelemetryRootCauseSummary {
  readonly kind: LLMRootCauseKind;
  readonly label: string;
  readonly summary: string;
  readonly count: number;
  readonly latestTimestamp: number;
}

export interface LLMTelemetrySnapshot {
  readonly totalCalls: number;
  readonly failedCalls: number;
  readonly partialCalls: number;
  readonly timeoutCalls: number;
  readonly slowCalls: number;
  readonly totalTokens: number;
  readonly longestCallMs: number;
  readonly recentCalls: ReadonlyArray<StudioLLMTelemetryRecord>;
  readonly topRootCauses: ReadonlyArray<LLMTelemetryRootCauseSummary>;
  readonly primaryRootCause: LLMTelemetryRootCauseSummary | null;
}

const SLOW_CALL_THRESHOLD_MS = 15_000;

export function parseStudioLLMTelemetryEvent(data: unknown): StudioLLMTelemetryEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (!isStatus(record.status)) return null;
  if (typeof record.agent !== "string" || typeof record.phase !== "string") return null;
  if (typeof record.service !== "string" || typeof record.model !== "string") return null;
  if (typeof record.durationMs !== "number") return null;
  if (typeof record.promptTokens !== "number") return null;
  if (typeof record.completionTokens !== "number") return null;
  if (typeof record.totalTokens !== "number") return null;

  return {
    ...(typeof record.operationId === "string" ? { operationId: record.operationId } : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.bookId === "string" ? { bookId: record.bookId } : {}),
    agent: record.agent,
    phase: record.phase,
    status: record.status,
    service: record.service,
    model: record.model,
    durationMs: record.durationMs,
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    ...(typeof record.attemptCount === "number" ? { attemptCount: record.attemptCount } : {}),
    ...(typeof record.retryCount === "number" ? { retryCount: record.retryCount } : {}),
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens: record.totalTokens,
    ...(typeof record.partialContentLength === "number"
      ? { partialContentLength: record.partialContentLength }
      : {}),
    ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
  };
}

export function buildLLMTelemetrySnapshot(
  messages: ReadonlyArray<SSEMessage>,
  options?: {
    readonly bookId?: string;
    readonly sessionId?: string;
    readonly operationId?: string;
    readonly limit?: number;
  },
): LLMTelemetrySnapshot {
  const limit = Math.max(1, options?.limit ?? 8);
  const records = messages
    .filter((message) => message.event === "llm:telemetry")
    .map((message) => {
      const telemetry = parseStudioLLMTelemetryEvent(message.data);
      return telemetry ? { ...telemetry, timestamp: message.timestamp } satisfies StudioLLMTelemetryRecord : null;
    })
    .filter((record): record is StudioLLMTelemetryRecord => record !== null)
    .filter((record) => !options?.bookId || record.bookId === options.bookId)
    .filter((record) => !options?.sessionId || record.sessionId === options.sessionId)
    .filter((record) => !options?.operationId || record.operationId === options.operationId);

  const rootCauseMap = new Map<LLMRootCauseKind, LLMTelemetryRootCauseSummary>();
  for (const record of records) {
    const cause = classifyLLMCallRootCause(record);
    if (!cause) continue;
    const existing = rootCauseMap.get(cause.kind);
    if (existing) {
      rootCauseMap.set(cause.kind, {
        ...existing,
        count: existing.count + 1,
        latestTimestamp: Math.max(existing.latestTimestamp, record.timestamp),
      });
      continue;
    }
    rootCauseMap.set(cause.kind, {
      kind: cause.kind,
      label: cause.label,
      summary: cause.summary,
      count: 1,
      latestTimestamp: record.timestamp,
    });
  }

  const topRootCauses = [...rootCauseMap.values()]
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return right.latestTimestamp - left.latestTimestamp;
    })
    .slice(0, 3);

  return {
    totalCalls: records.length,
    failedCalls: records.filter((record) => record.status === "error" || record.status === "timeout").length,
    partialCalls: records.filter((record) => record.status === "partial").length,
    timeoutCalls: records.filter((record) => record.status === "timeout").length,
    slowCalls: records.filter((record) => record.durationMs >= SLOW_CALL_THRESHOLD_MS).length,
    totalTokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
    longestCallMs: records.reduce((max, record) => Math.max(max, record.durationMs), 0),
    recentCalls: [...records].reverse().slice(0, limit),
    topRootCauses,
    primaryRootCause: topRootCauses[0] ?? null,
  };
}

function isStatus(value: unknown): value is LLMCallStatus {
  return value === "success" || value === "timeout" || value === "error" || value === "partial";
}
