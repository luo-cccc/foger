import { describe, expect, it } from "vitest";
import { setAppLanguage } from "./app-language";
import {
  classifyLLMCallRootCause,
  labelLLMRootCauseKind,
  localizeKnownRuntimeMessage,
  summarizeLLMCallRootCause,
} from "./error-copy";

describe("localizeKnownRuntimeMessage", () => {
  it("localizes the state-degraded continuation blocker", () => {
    expect(localizeKnownRuntimeMessage(
      "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    )).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes related state repair errors while preserving unknown messages", () => {
    expect(localizeKnownRuntimeMessage("Chapter 3 is not state-degraded.")).toBe(
      "第 3 章并不是状态降级（state-degraded），无需按状态修复。",
    );
    expect(localizeKnownRuntimeMessage(
      "Only the latest state-degraded chapter can be repaired safely (latest is 5).",
    )).toBe("只能安全修复最新的状态降级章节；当前最新章节是第 5 章。");
    expect(localizeKnownRuntimeMessage("Bad request")).toBe("Bad request");
  });

  it("localizes common LLM configuration errors", () => {
    const studioMessage = localizeKnownRuntimeMessage(
      "Studio LLM API key not set. Open Studio services and save an API key for the selected service.",
    );
    expect(studioMessage).toContain("Studio 模型 API Key 尚未设置");
    expect(studioMessage).not.toMatch(/kkaiapi/i);

    const cliMessage = localizeKnownRuntimeMessage(
      "INKOS_LLM_API_KEY not set. Run 'inkos config set-global' or add it to project .env file.",
    );
    expect(cliMessage).toContain("INKOS_LLM_API_KEY 尚未设置");
    expect(cliMessage).not.toMatch(/kkaiapi/i);
  });
});

describe("summarizeLLMCallRootCause", () => {
  it("summarizes common llm telemetry root causes in chinese", () => {
    setAppLanguage("zh");

    expect(summarizeLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "timeout",
      service: "openai",
      model: "gpt-test",
      durationMs: 16000,
      timeoutMs: 15000,
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
    })).toContain("超时");

    expect(summarizeLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "error",
      service: "openai",
      model: "gpt-test",
      durationMs: 2000,
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      errorMessage: "Provider finish_reason: function_call_filter: MALFORMED_FUNCTION_CALL",
    })).toContain("工具调用结构");
  });

  it("summarizes common llm telemetry root causes in english", () => {
    setAppLanguage("en");

    expect(summarizeLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "partial",
      service: "openai",
      model: "gpt-test",
      durationMs: 9000,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      partialContentLength: 1200,
    })).toContain("part of the output");

    expect(summarizeLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "error",
      service: "openai",
      model: "gpt-test",
      durationMs: 2000,
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      errorMessage: "400 The `reasoning_content` in the thinking mode must be passed back to the API.",
    })).toContain("reasoning_content");
  });

  it("classifies context-window and policy failures", () => {
    setAppLanguage("en");

    expect(classifyLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "error",
      service: "openai",
      model: "gpt-test",
      durationMs: 2000,
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      errorMessage: "maximum context length exceeded for this model",
    })).toMatchObject({
      kind: "context_limit",
      label: "Context limits",
    });

    expect(classifyLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "error",
      service: "openai",
      model: "gpt-test",
      durationMs: 2000,
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      errorMessage: "Request blocked by content_policy filter",
    })).toMatchObject({
      kind: "content_policy",
      label: "Content policy",
    });
  });

  it("classifies overloaded upstream errors and localized labels", () => {
    setAppLanguage("zh");

    expect(classifyLLMCallRootCause({
      agent: "writer",
      phase: "compose",
      status: "error",
      service: "openai",
      model: "gpt-test",
      durationMs: 2000,
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
      errorMessage: "503 Service Unavailable via upstream gateway",
    })).toMatchObject({
      kind: "provider_unavailable",
      label: "上游不稳定",
    });

    expect(labelLLMRootCauseKind("rate_limit")).toBe("限流/额度");
  });
});
