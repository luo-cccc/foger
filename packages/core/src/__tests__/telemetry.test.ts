import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletion,
  CallTimeoutError,
  type LLMCallTelemetry,
  type LLMClient,
  type OnCallTelemetry,
} from "../llm/provider.js";

// ── Mock @mariozechner/pi-ai ──────────────────────────────────────────────────

const mockStreamSimple = vi.fn();
const mockCompleteSimple = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return { ...original, streamSimple: (...args: unknown[]) => mockStreamSimple(...args), completeSimple: (...args: unknown[]) => mockCompleteSimple(...args) };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_USAGE = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function makeAssistantMessage(text: string) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions" as const, provider: "openai", model: "test", usage: MOCK_USAGE, stopReason: "stop" as const, timestamp: Date.now() };
}

function makeClient(overrides: Partial<LLMClient> = {}): LLMClient {
  return {
    provider: "openai", service: "openai", configSource: "studio", apiFormat: "chat", stream: true,
    _piModel: { id: "test", name: "test", api: "openai-completions", provider: "openai", baseUrl: "https://api.example.com/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 },
    _apiKey: "test-key",
    defaults: { temperature: 0.7, maxTokens: 8192, thinkingBudget: 0, extra: {} },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CallTimeoutError", () => {
  it("extends PartialResponseError and carries partialContent + timeoutMs", () => {
    const err = new CallTimeoutError("partial text", 5000);
    expect(err.name).toBe("CallTimeoutError");
    expect(err.partialContent).toBe("partial text");
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toContain("5000ms");
  });
});

describe("LLMCallTelemetry", () => {
  it("emits success telemetry when chatCompletion completes", async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("hello world"));
    const client = makeClient({ stream: false });
    const records: LLMCallTelemetry[] = [];
    const onTelemetry: OnCallTelemetry = (t) => records.push(t);

    await chatCompletion(client, "test", [{ role: "user", content: "hi" }], {
      onCallTelemetry: onTelemetry,
      callPhase: "test:suite",
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("success");
    expect(records[0]!.agent).toBe("test:suite");
    expect(records[0]!.phase).toBe("test:suite");
    expect(records[0]!.model).toBe("test");
    expect(records[0]!.service).toBe("openai");
    expect(records[0]!.apiFormat).toBe("chat");
    expect(records[0]!.stream).toBe(false);
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(records[0]!.attemptCount).toBe(1);
    expect(records[0]!.retryCount).toBe(0);
    expect(records[0]!.promptAssembly).toMatchObject({
      totalChars: 2,
      messages: [expect.objectContaining({ role: "user", chars: 2 })],
      sources: [],
      duplicateSourceGroups: [],
    });
    expect(JSON.stringify(records[0]!.promptAssembly)).not.toContain('"content"');
    expect(records[0]!.usage.promptTokens).toBe(11);
    expect(records[0]!.usage.completionTokens).toBe(7);
    expect(records[0]!.timestamp).toBeDefined();
  });

  it("emits error telemetry on failure", async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error("API error"));
    const client = makeClient({ stream: false });
    const records: LLMCallTelemetry[] = [];
    const onTelemetry: OnCallTelemetry = (t) => records.push(t);

    await expect(
      chatCompletion(client, "test", [{ role: "user", content: "hi" }], {
        onCallTelemetry: onTelemetry,
        callPhase: "test:error",
        retry: false,
      }),
    ).rejects.toThrow();

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("error");
    expect(records[0]!.agent).toBe("test:error");
    expect(records[0]!.attemptCount).toBe(1);
    expect(records[0]!.retryCount).toBe(0);
  });

  it("records provider retry attempts on the final telemetry event", async () => {
    mockCompleteSimple
      .mockRejectedValueOnce(new Error("503 service unavailable"))
      .mockResolvedValueOnce(makeAssistantMessage("recovered"));
    const records: LLMCallTelemetry[] = [];

    await chatCompletion(
      makeClient({ stream: false }),
      "test",
      [{ role: "user", content: "hi" }],
      { onCallTelemetry: (telemetry) => records.push(telemetry) },
    );

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("success");
    expect(records[0]!.attemptCount).toBe(2);
    expect(records[0]!.retryCount).toBe(1);
  });

  it("passes timeoutMs to chatCompletion options", async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("ok"));
    const client = makeClient({ stream: false });
    const records: LLMCallTelemetry[] = [];
    const onTelemetry: OnCallTelemetry = (t) => records.push(t);

    await chatCompletion(client, "test", [{ role: "user", content: "hi" }], {
      onCallTelemetry: onTelemetry,
      callPhase: "test:timeout",
      timeoutMs: 5000,
      retry: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("success");
    expect(records[0]!.timeoutMs).toBe(5000);
  });

  it("prefers explicit agentName while keeping phase separate", async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("ok"));
    const client = makeClient({ stream: false });
    const records: LLMCallTelemetry[] = [];

    await chatCompletion(client, "test", [{ role: "user", content: "hi" }], {
      onCallTelemetry: (telemetry) => records.push(telemetry),
      agentName: "writer",
      callPhase: "write",
      retry: false,
    });

    expect(records).toHaveLength(1);
    expect(records[0]!.agent).toBe("writer");
    expect(records[0]!.phase).toBe("write");
  });

  it("does not emit telemetry when onCallTelemetry is not provided", async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("ok"));
    const client = makeClient({ stream: false });
    // No onCallTelemetry — should not throw
    await expect(
      chatCompletion(client, "test", [{ role: "user", content: "hi" }], { retry: false }),
    ).resolves.toBeDefined();
  });

  it("includes errorMessage and partialContentLength for partial responses", async () => {
    // Stream that yields text but no done event — triggers PartialResponseError
    const msg = makeAssistantMessage("partial text");
    const streamNoDone = {
      [Symbol.asyncIterator]() {
        let i = 0;
        const events = [
          { type: "text_delta", contentIndex: 0, delta: "partial text", partial: msg },
        ];
        return {
          async next() {
            return i < events.length
              ? { value: events[i++]!, done: false }
              : { value: undefined as any, done: true };
          },
        };
      },
    };
    mockStreamSimple.mockReturnValueOnce(streamNoDone);
    const client = makeClient({ stream: true });
    const records: LLMCallTelemetry[] = [];

    await expect(
      chatCompletion(client, "test", [{ role: "user", content: "hi" }], {
        onCallTelemetry: (t) => records.push(t),
        callPhase: "test:partial",
        retry: false,
      }),
    ).rejects.toThrow();

    expect(records.length).toBeGreaterThan(0);
    // The error should be marked as "partial" since it's a PartialResponseError
    const last = records[records.length - 1]!;
    expect(last.status).toBe("partial");
    expect(last.partialContentLength).toBeGreaterThan(0);
    expect(last.partialContent).toContain("partial text");
  });
});

describe("chatCompletion timeout", () => {
  it("passes AbortSignal to pi-ai when timeoutMs is set", async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("ok"));
    const client = makeClient({ stream: false });

    await chatCompletion(client, "test", [{ role: "user", content: "hi" }], {
      timeoutMs: 5000,
      retry: false,
    });

    // Verify the signal was passed to pi-ai
    const callArgs = mockCompleteSimple.mock.calls.at(-1);
    expect(callArgs).toBeDefined();
    // The third argument is streamOpts, which should contain signal when timeoutMs is set
    const streamOpts = callArgs?.[2];
    expect(streamOpts).toBeDefined();
    expect(streamOpts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not pass AbortSignal when timeoutMs is not set", async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeAssistantMessage("ok"));
    const client = makeClient({ stream: false });
    await chatCompletion(client, "test", [{ role: "user", content: "hi" }], { retry: false });

    const callArgs = mockCompleteSimple.mock.calls.at(-1);
    const streamOpts = callArgs?.[2];
    expect(streamOpts?.signal).toBeUndefined();
  });
});
