import { describe, expect, it } from "vitest";
import { buildEpisodePerformanceReport } from "../pipeline/episode-performance.js";
import type { LLMCallTelemetry } from "../llm/provider.js";

function telemetry(agent: string, phase: string, hash = `${agent}-${phase}`): LLMCallTelemetry {
  return {
    agent,
    phase,
    model: "stub",
    service: "stub",
    apiFormat: "chat",
    stream: false,
    durationMs: 10,
    attemptCount: 1,
    retryCount: 0,
    status: "success",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    promptAssembly: {
      totalChars: 100,
      estimatedTokens: 25,
      messages: [],
      sources: [{
        source: `${agent}/${phase}`,
        chars: 100,
        estimatedTokens: 25,
        contentHash: hash,
        tier: "semantic",
        stable: false,
        selected: true,
        compressed: false,
      }],
      duplicateSourceGroups: [],
    },
    timestamp: "2026-08-07T00:00:00.000Z",
  };
}

describe("episode performance report", () => {
  it("aggregates call and token budgets", () => {
    const report = buildEpisodePerformanceReport({
      episode: 7,
      operationId: "op-7",
      startedAtMs: Date.now(),
      records: [telemetry("planner", "plan"), telemetry("writer", "write"), telemetry("auditor", "audit")],
      cache: { hits: 2, misses: 1 },
    });
    expect(report.calls).toEqual({ planner: 1, writer: 1, auditor: 1, reviser: 0, recovery: 0 });
    expect(report.totalTokens).toBe(45);
    expect(report.contextEstimatedTokens).toBe(25);
    expect(report.status).toBe("ok");
  });

  it("marks operations over the normal three-call budget", () => {
    const report = buildEpisodePerformanceReport({
      episode: 8,
      operationId: "op-8",
      startedAtMs: Date.now(),
      records: [
        telemetry("planner", "plan"),
        telemetry("writer", "write"),
        telemetry("auditor", "audit"),
        telemetry("reviser", "revise"),
      ],
    });
    expect(report.status).toBe("budget-exceeded");
  });
});
