import type { LLMCallTelemetry } from "./provider.js";

export interface LLMCallTelemetryAggregate {
  readonly calls: number;
  readonly attempts: number;
  readonly retries: number;
  readonly totalDurationMs: number;
  readonly statuses: {
    readonly success: number;
    readonly timeout: number;
    readonly error: number;
    readonly partial: number;
  };
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly prompt: {
    readonly chars: number;
    readonly estimatedTokens: number;
    readonly maxChars: number;
    readonly maxEstimatedTokens: number;
  };
}

export interface LLMCallTelemetrySummary extends LLMCallTelemetryAggregate {
  readonly byAgent: Readonly<Record<string, LLMCallTelemetryAggregate>>;
  readonly byPhase: Readonly<Record<string, LLMCallTelemetryAggregate>>;
  readonly byAgentPhase: Readonly<Record<string, LLMCallTelemetryAggregate>>;
  readonly byServiceModel: Readonly<Record<string, LLMCallTelemetryAggregate>>;
  readonly byAgentServiceModel: Readonly<Record<string, LLMCallTelemetryAggregate>>;
  readonly byPromptSource: Readonly<Record<string, {
    readonly occurrences: number;
    readonly chars: number;
    readonly estimatedTokens: number;
    readonly compressedOccurrences: number;
    readonly tiers: ReadonlyArray<string>;
  }>>;
}

interface MutableAggregate {
  calls: number;
  attempts: number;
  retries: number;
  totalDurationMs: number;
  statuses: {
    success: number;
    timeout: number;
    error: number;
    partial: number;
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  prompt: {
    chars: number;
    estimatedTokens: number;
    maxChars: number;
    maxEstimatedTokens: number;
  };
}

function createAggregate(): MutableAggregate {
  return {
    calls: 0,
    attempts: 0,
    retries: 0,
    totalDurationMs: 0,
    statuses: { success: 0, timeout: 0, error: 0, partial: 0 },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    prompt: { chars: 0, estimatedTokens: 0, maxChars: 0, maxEstimatedTokens: 0 },
  };
}

function addTelemetry(aggregate: MutableAggregate, telemetry: LLMCallTelemetry): void {
  const attemptCount = Math.max(1, telemetry.attemptCount ?? 1);
  const retryCount = Math.max(0, telemetry.retryCount ?? attemptCount - 1);
  aggregate.calls += 1;
  aggregate.attempts += attemptCount;
  aggregate.retries += retryCount;
  aggregate.totalDurationMs += telemetry.durationMs;
  aggregate.statuses[telemetry.status] += 1;
  aggregate.usage.promptTokens += telemetry.usage.promptTokens;
  aggregate.usage.completionTokens += telemetry.usage.completionTokens;
  aggregate.usage.totalTokens += telemetry.usage.totalTokens;
  aggregate.prompt.chars += telemetry.promptAssembly.totalChars;
  aggregate.prompt.estimatedTokens += telemetry.promptAssembly.estimatedTokens;
  aggregate.prompt.maxChars = Math.max(aggregate.prompt.maxChars, telemetry.promptAssembly.totalChars);
  aggregate.prompt.maxEstimatedTokens = Math.max(
    aggregate.prompt.maxEstimatedTokens,
    telemetry.promptAssembly.estimatedTokens,
  );
}

function addToGroup(
  groups: Record<string, MutableAggregate>,
  key: string,
  telemetry: LLMCallTelemetry,
): void {
  const aggregate = groups[key] ?? (groups[key] = createAggregate());
  addTelemetry(aggregate, telemetry);
}

export function summarizeLLMCallTelemetry(
  records: ReadonlyArray<LLMCallTelemetry>,
): LLMCallTelemetrySummary {
  const total = createAggregate();
  const byAgent: Record<string, MutableAggregate> = {};
  const byPhase: Record<string, MutableAggregate> = {};
  const byAgentPhase: Record<string, MutableAggregate> = {};
  const byServiceModel: Record<string, MutableAggregate> = {};
  const byAgentServiceModel: Record<string, MutableAggregate> = {};
  const mutableByPromptSource: Record<string, {
    occurrences: number;
    chars: number;
    estimatedTokens: number;
    compressedOccurrences: number;
    tiers: Set<string>;
  }> = {};

  for (const telemetry of records) {
    addTelemetry(total, telemetry);
    addToGroup(byAgent, telemetry.agent, telemetry);
    addToGroup(byPhase, telemetry.phase, telemetry);
    addToGroup(byAgentPhase, `${telemetry.agent}:${telemetry.phase}`, telemetry);
    addToGroup(byServiceModel, `${telemetry.service}:${telemetry.model}`, telemetry);
    addToGroup(
      byAgentServiceModel,
      `${telemetry.agent}:${telemetry.service}:${telemetry.model}`,
      telemetry,
    );
    for (const source of telemetry.promptAssembly.sources) {
      const aggregate = mutableByPromptSource[source.source] ?? (mutableByPromptSource[source.source] = {
        occurrences: 0,
        chars: 0,
        estimatedTokens: 0,
        compressedOccurrences: 0,
        tiers: new Set<string>(),
      });
      aggregate.occurrences += 1;
      aggregate.chars += source.chars;
      aggregate.estimatedTokens += source.estimatedTokens;
      aggregate.compressedOccurrences += source.compressed ? 1 : 0;
      aggregate.tiers.add(source.tier);
    }
  }

  const byPromptSource = Object.fromEntries(
    Object.entries(mutableByPromptSource).map(([source, aggregate]) => [source, {
      occurrences: aggregate.occurrences,
      chars: aggregate.chars,
      estimatedTokens: aggregate.estimatedTokens,
      compressedOccurrences: aggregate.compressedOccurrences,
      tiers: [...aggregate.tiers].sort(),
    }]),
  );

  return {
    ...total,
    byAgent,
    byPhase,
    byAgentPhase,
    byServiceModel,
    byAgentServiceModel,
    byPromptSource,
  };
}
