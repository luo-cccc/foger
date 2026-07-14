import { describe, expect, it } from "vitest";
import type { SSEMessage } from "../hooks/use-sse";
import { setAppLanguage } from "./app-language";
import { buildLLMTelemetrySnapshot, parseStudioLLMTelemetryEvent } from "./llm-telemetry-display";

function msg(seq: number, data: unknown): SSEMessage {
  return { event: "llm:telemetry", data, timestamp: 1000 + seq, seq };
}

describe("parseStudioLLMTelemetryEvent", () => {
  it("parses a valid telemetry payload", () => {
    expect(parseStudioLLMTelemetryEvent({
      bookId: "demo-book",
      operationId: "operation-123",
      agent: "writer",
      phase: "compose",
      status: "partial",
      service: "openai",
      model: "gpt-test",
      durationMs: 1200,
      timeoutMs: 5000,
      attemptCount: 3,
      retryCount: 2,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      partialContentLength: 800,
      errorMessage: "timed out",
    })).toEqual(expect.objectContaining({
      bookId: "demo-book",
      operationId: "operation-123",
      status: "partial",
      totalTokens: 300,
      attemptCount: 3,
      retryCount: 2,
      partialContentLength: 800,
    }));
  });

  it("rejects malformed telemetry payloads", () => {
    expect(parseStudioLLMTelemetryEvent(null)).toBeNull();
    expect(parseStudioLLMTelemetryEvent({ status: "success" })).toBeNull();
    expect(parseStudioLLMTelemetryEvent({ agent: "writer", phase: "compose", status: "weird" })).toBeNull();
  });
});

describe("buildLLMTelemetrySnapshot", () => {
  it("summarizes recent telemetry calls and top root causes", () => {
    setAppLanguage("en");

    const snapshot = buildLLMTelemetrySnapshot([
      { event: "log", data: { message: "ignore" }, timestamp: 1000, seq: 1 },
      msg(2, {
        bookId: "alpha",
        agent: "writer",
        phase: "plan",
        status: "success",
        service: "openai",
        model: "gpt-a",
        durationMs: 2000,
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }),
      msg(3, {
        bookId: "alpha",
        agent: "writer",
        phase: "compose",
        status: "timeout",
        service: "openai",
        model: "gpt-a",
        durationMs: 18000,
        timeoutMs: 15000,
        promptTokens: 50,
        completionTokens: 0,
        totalTokens: 50,
        errorMessage: "timed out",
      }),
      msg(4, {
        bookId: "beta",
        agent: "auditor",
        phase: "audit",
        status: "partial",
        service: "openai",
        model: "gpt-b",
        durationMs: 9000,
        promptTokens: 30,
        completionTokens: 40,
        totalTokens: 70,
        partialContentLength: 1200,
      }),
      msg(5, {
        bookId: "beta",
        agent: "auditor",
        phase: "retry",
        status: "error",
        service: "openai",
        model: "gpt-b",
        durationMs: 4000,
        promptTokens: 30,
        completionTokens: 0,
        totalTokens: 30,
        errorMessage: "Too many requests: rate limit exceeded",
      }),
      msg(6, {
        bookId: "beta",
        agent: "auditor",
        phase: "retry",
        status: "error",
        service: "openai",
        model: "gpt-b",
        durationMs: 4100,
        promptTokens: 30,
        completionTokens: 0,
        totalTokens: 30,
        errorMessage: "quota exceeded: too many requests",
      }),
    ]);

    expect(snapshot).toMatchObject({
      totalCalls: 5,
      failedCalls: 3,
      partialCalls: 1,
      timeoutCalls: 1,
      slowCalls: 1,
      totalTokens: 210,
      longestCallMs: 18000,
    });
    expect(snapshot.recentCalls.map((record) => record.phase)).toEqual(["retry", "retry", "audit", "compose", "plan"]);
    expect(snapshot.topRootCauses.map((record) => [record.kind, record.count])).toEqual([
      ["rate_limit", 2],
      ["partial", 1],
      ["timeout", 1],
    ]);
    expect(snapshot.primaryRootCause).toMatchObject({
      kind: "rate_limit",
      label: "Rate limits",
      count: 2,
    });
  });

  it("filters by bookId and sessionId", () => {
    const messages: ReadonlyArray<SSEMessage> = [
      msg(1, {
        sessionId: "s1",
        bookId: "alpha",
        operationId: "operation-alpha",
        agent: "writer",
        phase: "plan",
        status: "success",
        service: "openai",
        model: "gpt-a",
        durationMs: 1000,
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      }),
      msg(2, {
        sessionId: "s2",
        bookId: "beta",
        operationId: "operation-beta",
        agent: "writer",
        phase: "plan",
        status: "success",
        service: "openai",
        model: "gpt-b",
        durationMs: 2000,
        promptTokens: 20,
        completionTokens: 20,
        totalTokens: 40,
      }),
    ];

    expect(buildLLMTelemetrySnapshot(messages, { bookId: "alpha" })).toMatchObject({
      totalCalls: 1,
      totalTokens: 20,
    });
    expect(buildLLMTelemetrySnapshot(messages, { sessionId: "s2" })).toMatchObject({
      totalCalls: 1,
      totalTokens: 40,
    });
    expect(buildLLMTelemetrySnapshot(messages, { operationId: "operation-alpha" })).toMatchObject({
      totalCalls: 1,
      totalTokens: 20,
    });
  });
});
