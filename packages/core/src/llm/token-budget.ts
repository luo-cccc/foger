import type { LLMCallTelemetry } from "./provider.js";

export interface LLMTokenBudgetLimits {
  readonly maxTotalTokens?: number;
  readonly maxPromptEstimatedTokensPerCall?: number;
  readonly maxAgentTokens?: Readonly<Record<string, number>>;
  readonly maxPhaseTokens?: Readonly<Record<string, number>>;
}

export interface LLMTokenBudgetAggregate {
  readonly calls: number;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedPromptTokens: number;
  readonly maxPromptEstimatedTokens: number;
  readonly totalDurationMs: number;
}

export interface LLMTokenBudgetViolation {
  readonly scope: "total" | "agent" | "phase" | "call";
  readonly key?: string;
  readonly metric: "totalTokens" | "estimatedPromptTokens";
  readonly actual: number;
  readonly maximum: number;
}

export interface LLMTokenBudgetReport {
  readonly limits: LLMTokenBudgetLimits;
  readonly total: LLMTokenBudgetAggregate;
  readonly byAgent: Readonly<Record<string, LLMTokenBudgetAggregate>>;
  readonly byPhase: Readonly<Record<string, LLMTokenBudgetAggregate>>;
  readonly violations: ReadonlyArray<LLMTokenBudgetViolation>;
  readonly passed: boolean;
}

interface MutableAggregate {
  calls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedPromptTokens: number;
  maxPromptEstimatedTokens: number;
  totalDurationMs: number;
}

function createAggregate(): MutableAggregate {
  return {
    calls: 0,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedPromptTokens: 0,
    maxPromptEstimatedTokens: 0,
    totalDurationMs: 0,
  };
}

function addTelemetry(aggregate: MutableAggregate, record: LLMCallTelemetry): void {
  aggregate.calls += 1;
  aggregate.totalTokens += record.usage.totalTokens;
  aggregate.promptTokens += record.usage.promptTokens;
  aggregate.completionTokens += record.usage.completionTokens;
  aggregate.estimatedPromptTokens += record.promptAssembly.estimatedTokens;
  aggregate.maxPromptEstimatedTokens = Math.max(
    aggregate.maxPromptEstimatedTokens,
    record.promptAssembly.estimatedTokens,
  );
  aggregate.totalDurationMs += record.durationMs;
}

function freezeAggregate(aggregate: MutableAggregate): LLMTokenBudgetAggregate {
  return { ...aggregate };
}

export function buildLLMTokenBudgetReport(
  records: ReadonlyArray<LLMCallTelemetry>,
  limits: LLMTokenBudgetLimits = {},
): LLMTokenBudgetReport {
  const total = createAggregate();
  const byAgent: Record<string, MutableAggregate> = {};
  const byPhase: Record<string, MutableAggregate> = {};

  for (const record of records) {
    addTelemetry(total, record);
    addTelemetry(byAgent[record.agent] ?? (byAgent[record.agent] = createAggregate()), record);
    addTelemetry(byPhase[record.phase] ?? (byPhase[record.phase] = createAggregate()), record);
  }

  const violations: LLMTokenBudgetViolation[] = [];
  if (limits.maxTotalTokens !== undefined && total.totalTokens > limits.maxTotalTokens) {
    violations.push({
      scope: "total",
      metric: "totalTokens",
      actual: total.totalTokens,
      maximum: limits.maxTotalTokens,
    });
  }
  if (
    limits.maxPromptEstimatedTokensPerCall !== undefined
    && total.maxPromptEstimatedTokens > limits.maxPromptEstimatedTokensPerCall
  ) {
    violations.push({
      scope: "call",
      metric: "estimatedPromptTokens",
      actual: total.maxPromptEstimatedTokens,
      maximum: limits.maxPromptEstimatedTokensPerCall,
    });
  }
  for (const [agent, maximum] of Object.entries(limits.maxAgentTokens ?? {})) {
    const actual = byAgent[agent]?.totalTokens ?? 0;
    if (actual > maximum) {
      violations.push({ scope: "agent", key: agent, metric: "totalTokens", actual, maximum });
    }
  }
  for (const [phase, maximum] of Object.entries(limits.maxPhaseTokens ?? {})) {
    const actual = byPhase[phase]?.totalTokens ?? 0;
    if (actual > maximum) {
      violations.push({ scope: "phase", key: phase, metric: "totalTokens", actual, maximum });
    }
  }

  return {
    limits,
    total: freezeAggregate(total),
    byAgent: Object.fromEntries(
      Object.entries(byAgent).map(([key, aggregate]) => [key, freezeAggregate(aggregate)]),
    ),
    byPhase: Object.fromEntries(
      Object.entries(byPhase).map(([key, aggregate]) => [key, freezeAggregate(aggregate)]),
    ),
    violations,
    passed: violations.length === 0,
  };
}
