import { describe, expect, it } from "vitest";
import type { ChapterMeta } from "../models/chapter.js";
import type { LLMCallTelemetry } from "../llm/provider.js";
import {
  buildChapterSampleReport,
  parseLLMCallTelemetryJsonl,
} from "../utils/chapter-sample-report.js";

function chapter(number: number, operationId: string): ChapterMeta {
  return {
    number,
    title: `Chapter ${number}`,
    status: "ready-for-review",
    wordCount: 1000,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:01:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
    operationId,
    tokenUsage: { promptTokens: 6, completionTokens: 4, totalTokens: 10 },
  };
}

function telemetry(params: {
  readonly timestamp: string;
  readonly operationId?: string;
  readonly agent?: string;
  readonly phase?: string;
  readonly totalTokens?: number;
  readonly promptEstimate?: number;
}): LLMCallTelemetry {
  const totalTokens = params.totalTokens ?? 12;
  return {
    bookId: "sample-book",
    operationId: params.operationId,
    agent: params.agent ?? "writer",
    phase: params.phase ?? "write",
    model: "deepseek-v4-flash",
    service: "deepseek",
    apiFormat: "chat",
    stream: false,
    durationMs: 100,
    attemptCount: 1,
    retryCount: 0,
    promptAssembly: {
      totalChars: 100,
      estimatedTokens: params.promptEstimate ?? 10,
      messages: [],
      sources: [],
      duplicateSourceGroups: [],
    },
    status: "success",
    usage: {
      promptTokens: totalTokens - 4,
      completionTokens: 4,
      totalTokens,
    },
    timestamp: params.timestamp,
  };
}

describe("chapter sample report", () => {
  it("counts unattributed recovery calls inside the operation window", () => {
    const report = buildChapterSampleReport({
      bookId: "sample-book",
      chapters: [chapter(4, "op-4"), chapter(5, "op-5")],
      telemetry: [
        telemetry({ timestamp: "2026-07-15T00:00:00.000Z", operationId: "op-4" }),
        telemetry({ timestamp: "2026-07-15T00:00:30.000Z", agent: "settler", phase: "repair" }),
        telemetry({ timestamp: "2026-07-15T00:01:00.000Z", operationId: "op-5" }),
      ],
      expectedChapterCount: 2,
      telemetryInvalidLines: 1,
      limits: {
        maxTotalTokens: 30,
        maxChapterTokens: 11,
        maxPromptEstimatedTokensPerCall: 9,
      },
    });

    expect(report.totals).toMatchObject({
      chapters: 2,
      indexedTokens: 20,
      telemetryTokens: 36,
      telemetryMinusIndexedTokens: 16,
      indexedTelemetryCoverageRate: 20 / 36,
      telemetryCalls: 3,
    });
    expect(report.telemetryWindow).toMatchObject({
      matchedChapterOperations: 2,
      unattributedCalls: 1,
    });
    expect(report.gate.passed).toBe(false);
    expect(report.gate.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "chapter-token-budget",
      "unattributed-telemetry",
      "invalid-telemetry-lines",
      "total-token-budget",
      "prompt-token-budget",
    ]));
  });

  it("parses valid telemetry JSONL while reporting malformed lines", () => {
    const valid = telemetry({
      timestamp: "2026-07-15T00:00:00.000Z",
      operationId: "op-4",
    });
    const parsed = parseLLMCallTelemetryJsonl([
      JSON.stringify(valid),
      "{not-json}",
      JSON.stringify({ status: "success" }),
      "",
    ].join("\n"));

    expect(parsed.records).toEqual([valid]);
    expect(parsed.invalidLines).toBe(2);
  });
});
