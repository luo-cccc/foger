import { describe, expect, it } from "vitest";
import type { LLMCallTelemetry } from "../llm/provider.js";
import { summarizeLLMCallTelemetry } from "../llm/telemetry-summary.js";

function telemetry(
  overrides: Partial<LLMCallTelemetry> & Pick<LLMCallTelemetry, "agent" | "phase" | "service" | "model">,
): LLMCallTelemetry {
  return {
    apiFormat: "chat",
    stream: false,
    durationMs: 100,
    attemptCount: 1,
    retryCount: 0,
    promptAssembly: {
      totalChars: 60,
      estimatedTokens: 15,
      messages: [],
      sources: [{
        source: "story/current_state.md",
        chars: 40,
        estimatedTokens: 10,
        contentHash: "abcd1234",
        tier: "verbatim",
        stable: false,
        selected: true,
        compressed: false,
      }],
      duplicateSourceGroups: [],
    },
    status: "success",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    timestamp: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeLLMCallTelemetry", () => {
  it("aggregates statuses, usage, attempts, and all report dimensions", () => {
    const summary = summarizeLLMCallTelemetry([
      telemetry({ agent: "writer", phase: "write", service: "openrouter", model: "deepseek/v4" }),
      telemetry({
        agent: "writer",
        phase: "write",
        service: "openrouter",
        model: "deepseek/v4",
        durationMs: 250,
        attemptCount: 3,
        retryCount: 2,
        status: "timeout",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      telemetry({ agent: "auditor", phase: "audit", service: "minimax", model: "m3" }),
    ]);

    expect(summary).toMatchObject({
      calls: 3,
      attempts: 5,
      retries: 2,
      totalDurationMs: 450,
      statuses: { success: 2, timeout: 1, error: 0, partial: 0 },
      usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      prompt: { chars: 180, estimatedTokens: 45 },
    });
    expect(summary.byAgentPhase["writer:write"]).toMatchObject({ calls: 2, retries: 2 });
    expect(summary.byServiceModel["openrouter:deepseek/v4"]).toMatchObject({ calls: 2, retries: 2 });
    expect(summary.byAgentServiceModel["auditor:minimax:m3"]).toMatchObject({ calls: 1, retries: 0 });
    expect(summary.byPromptSource["story/current_state.md"]).toEqual({
      occurrences: 3,
      chars: 120,
      estimatedTokens: 30,
      compressedOccurrences: 0,
      tiers: ["verbatim"],
    });
  });

  it("returns zero totals for an empty report", () => {
    expect(summarizeLLMCallTelemetry([])).toEqual({
      calls: 0,
      attempts: 0,
      retries: 0,
      totalDurationMs: 0,
      statuses: { success: 0, timeout: 0, error: 0, partial: 0 },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      prompt: { chars: 0, estimatedTokens: 0 },
      byAgentPhase: {},
      byServiceModel: {},
      byAgentServiceModel: {},
      byPromptSource: {},
    });
  });
});
