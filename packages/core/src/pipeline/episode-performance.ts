import { z } from "zod";
import type { LLMCallTelemetry } from "../llm/provider.js";

export const EpisodePerformanceReportSchema = z.object({
  episode: z.number().int().min(1),
  operationId: z.string().min(1),
  elapsedMs: z.number().int().min(0),
  calls: z.object({
    planner: z.number().int().min(0),
    writer: z.number().int().min(0),
    auditor: z.number().int().min(0),
    reviser: z.number().int().min(0),
    recovery: z.number().int().min(0),
  }),
  retries: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  contextEstimatedTokens: z.number().int().min(0),
  contextDuplicateChars: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  cacheMisses: z.number().int().min(0),
  status: z.enum(["ok", "budget-exceeded", "recovery"]),
});

export type EpisodePerformanceReport = z.infer<typeof EpisodePerformanceReportSchema>;

export interface EpisodePerformanceCacheStats {
  readonly hits: number;
  readonly misses: number;
}

function agentBucket(record: LLMCallTelemetry): keyof EpisodePerformanceReport["calls"] {
  const name = `${record.agent}:${record.phase}`.toLowerCase();
  if (name.includes("planner") || name.includes("plan")) return "planner";
  if (name.includes("writer") || name.includes("write")) return "writer";
  if (name.includes("auditor") || name.includes("audit")) return "auditor";
  if (name.includes("reviser") || name.includes("revise")) return "reviser";
  return "recovery";
}

function duplicateChars(records: ReadonlyArray<LLMCallTelemetry>): number {
  let total = 0;
  for (const record of records) {
    const byHash = new Map<string, number>();
    for (const source of record.promptAssembly.sources) {
      byHash.set(source.contentHash, (byHash.get(source.contentHash) ?? 0) + source.chars);
    }
    for (const [hash, chars] of byHash.entries()) {
      const occurrences = record.promptAssembly.sources.filter((source) => source.contentHash === hash).length;
      if (occurrences > 1) total += chars - Math.ceil(chars / occurrences);
    }
  }
  return total;
}

export function buildEpisodePerformanceReport(params: {
  readonly episode: number;
  readonly operationId: string;
  readonly startedAtMs: number;
  readonly records: ReadonlyArray<LLMCallTelemetry>;
  readonly cache?: EpisodePerformanceCacheStats;
  readonly recovery?: boolean;
  readonly budget?: number;
}): EpisodePerformanceReport {
  const calls = { planner: 0, writer: 0, auditor: 0, reviser: 0, recovery: 0 };
  let retries = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let contextEstimatedTokens = 0;
  for (const record of params.records) {
    calls[agentBucket(record)] += 1;
    retries += Math.max(0, record.retryCount ?? 0);
    promptTokens += record.usage.promptTokens;
    completionTokens += record.usage.completionTokens;
    totalTokens += record.usage.totalTokens;
    contextEstimatedTokens = Math.max(contextEstimatedTokens, record.promptAssembly.estimatedTokens);
  }
  const totalCalls = Object.values(calls).reduce((sum, value) => sum + value, 0);
  const budget = params.budget ?? 3;
  return EpisodePerformanceReportSchema.parse({
    episode: params.episode,
    operationId: params.operationId,
    elapsedMs: Math.max(0, Date.now() - params.startedAtMs),
    calls,
    retries,
    promptTokens,
    completionTokens,
    totalTokens,
    contextEstimatedTokens,
    contextDuplicateChars: duplicateChars(params.records),
    cacheHits: params.cache?.hits ?? 0,
    cacheMisses: params.cache?.misses ?? 0,
    status: totalCalls > budget ? "budget-exceeded" : params.recovery ? "recovery" : "ok",
  });
}
