import { describe, expect, it } from "vitest";
import type { LLMCallTelemetry } from "../llm/provider.js";
import { buildLLMTokenBudgetReport } from "../llm/token-budget.js";

function telemetry(overrides: Partial<LLMCallTelemetry> & Pick<LLMCallTelemetry, "agent" | "phase">): LLMCallTelemetry {
  const { agent, phase, ...rest } = overrides;
  return {
    agent,
    phase,
    model: "test-model",
    service: "test-service",
    apiFormat: "chat",
    stream: false,
    durationMs: 10,
    attemptCount: 1,
    retryCount: 0,
    promptAssembly: {
      totalChars: 40,
      estimatedTokens: 10,
      messages: [],
      sources: [],
      duplicateSourceGroups: [],
    },
    status: "success",
    usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
    timestamp: "2026-07-12T00:00:00.000Z",
    ...rest,
  };
}

describe("buildLLMTokenBudgetReport", () => {
  it("aggregates total, agent, and phase usage", () => {
    const report = buildLLMTokenBudgetReport([
      telemetry({ agent: "writer", phase: "write" }),
      telemetry({
        agent: "planner",
        phase: "plan",
        promptAssembly: {
          totalChars: 80,
          estimatedTokens: 20,
          messages: [],
          sources: [],
          duplicateSourceGroups: [],
        },
        usage: { promptTokens: 16, completionTokens: 6, totalTokens: 22 },
      }),
    ]);

    expect(report.total).toMatchObject({
      calls: 2,
      totalTokens: 34,
      promptTokens: 24,
      completionTokens: 10,
      estimatedPromptTokens: 30,
      maxPromptEstimatedTokens: 20,
    });
    expect(report.byAgent.writer.totalTokens).toBe(12);
    expect(report.byPhase.plan.estimatedPromptTokens).toBe(20);
    expect(report.passed).toBe(true);
  });

  it("returns stable violations for configured limits", () => {
    const report = buildLLMTokenBudgetReport(
      [telemetry({ agent: "writer", phase: "write" })],
      {
        maxTotalTokens: 10,
        maxPromptEstimatedTokensPerCall: 5,
        maxAgentTokens: { writer: 11 },
        maxPhaseTokens: { write: 11 },
      },
    );

    expect(report.passed).toBe(false);
    expect(report.violations).toEqual([
      { scope: "total", metric: "totalTokens", actual: 12, maximum: 10 },
      { scope: "call", metric: "estimatedPromptTokens", actual: 10, maximum: 5 },
      { scope: "agent", key: "writer", metric: "totalTokens", actual: 12, maximum: 11 },
      { scope: "phase", key: "write", metric: "totalTokens", actual: 12, maximum: 11 },
    ]);
  });
});
