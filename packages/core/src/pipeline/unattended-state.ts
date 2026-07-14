import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../utils/atomic-write.js";

export const UnattendedActionSchema = z.enum([
  "write",
  "retry-provider",
  "revise",
  "rewrite",
  "repair-state",
  "resync-state",
  "pause",
]);

export type UnattendedAction = z.infer<typeof UnattendedActionSchema>;

export const UnattendedFailureKindSchema = z.enum([
  "provider-transient",
  "provider-auth",
  "timeout",
  "budget",
  "audit-local",
  "audit-structural",
  "audit-unknown",
  "state-degraded",
  "unknown",
]);

export type UnattendedFailureKind = z.infer<typeof UnattendedFailureKindSchema>;

export const UnattendedChapterMetricsSchema = z.object({
  calls: z.number().int().min(0),
  retries: z.number().int().min(0),
  timeouts: z.number().int().min(0),
  errors: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  maxPromptEstimatedTokens: z.number().int().min(0),
  fallbacks: z.number().int().min(0),
  withinHardRange: z.boolean().optional(),
});

export type UnattendedChapterMetrics = z.infer<typeof UnattendedChapterMetricsSchema>;

export const UnattendedTotalsSchema = z.object({
  chapters: z.number().int().min(0),
  hardRangeChapters: z.number().int().min(0),
  calls: z.number().int().min(0),
  retries: z.number().int().min(0),
  timeouts: z.number().int().min(0),
  errors: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  fallbacks: z.number().int().min(0),
});

export type UnattendedTotals = z.infer<typeof UnattendedTotalsSchema>;

export const UnattendedBookStateSchema = z.object({
  status: z.enum(["active", "retry-wait", "paused"]),
  action: UnattendedActionSchema,
  consecutiveFailures: z.number().int().min(0),
  failureDimensions: z.record(z.number().int().min(0)).default({}),
  attemptsByAction: z.record(z.number().int().min(0)).default({}),
  lastChapterNumber: z.number().int().min(0).optional(),
  lastFailureKind: UnattendedFailureKindSchema.optional(),
  lastError: z.string().optional(),
  nextAttemptAt: z.string().datetime().optional(),
  lastSuccessAt: z.string().datetime().optional(),
  currentMetrics: UnattendedChapterMetricsSchema.optional(),
  lastMetrics: UnattendedChapterMetricsSchema.optional(),
  totals: UnattendedTotalsSchema.optional(),
  updatedAt: z.string().datetime(),
});

export type UnattendedBookState = z.infer<typeof UnattendedBookStateSchema>;

export const UnattendedSchedulerStateSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string().datetime(),
  books: z.record(UnattendedBookStateSchema),
  dailyChapterCount: z.record(z.number().int().min(0)),
});

export type UnattendedSchedulerState = z.infer<typeof UnattendedSchedulerStateSchema>;

export function createEmptyUnattendedState(now: Date = new Date()): UnattendedSchedulerState {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    books: {},
    dailyChapterCount: {},
  };
}

export function classifyUnattendedError(error: unknown): UnattendedFailureKind {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String(error.cause ?? "")}`
    : String(error);
  const normalized = text.toLowerCase();

  if (/\b(401|403)\b/.test(normalized) || /unauthori[sz]ed|api[ _-]?key|鉴权|未授权/.test(normalized)) {
    return "provider-auth";
  }
  if (/token budget|prompt budget|exceed(?:ed|ing).*tokens?|预算.*(?:超|耗尽)/.test(normalized)) {
    return "budget";
  }
  if (/timeout|timed out|etimedout|超时/.test(normalized)) {
    return "timeout";
  }
  if (
    /\b(408|425|429|502|503|504|529)\b/.test(normalized)
    || /overload|temporarily unavailable|service unavailable|rate limit|too many requests/.test(normalized)
    || /try again later|please retry|负载较高|稍后重试|服务繁忙/.test(normalized)
    || /无法连接|连接失败|网络不通|网络错误|连接(?:被)?(?:中断|重置)/.test(normalized)
    || /econnreset|econnrefused|enotfound|socket hang up|fetch failed|connection error/.test(normalized)
  ) {
    return "provider-transient";
  }
  return "unknown";
}

export class UnattendedStateStore {
  readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, ".inkos", "unattended-state.json");
  }

  async load(): Promise<UnattendedSchedulerState> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyUnattendedState();
      }
      throw error;
    }

    try {
      return UnattendedSchedulerStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(`Invalid unattended scheduler state at ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(state: UnattendedSchedulerState): Promise<void> {
    const parsed = UnattendedSchedulerStateSchema.parse({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    await atomicWriteJson(this.path, parsed);
  }
}
