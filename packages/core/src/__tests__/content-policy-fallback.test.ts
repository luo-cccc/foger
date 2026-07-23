import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import {
  __resetLlmStubContentPolicyFaults,
  createLLMClient,
  ProviderContentPolicyError,
  type LLMCallTelemetry,
} from "../llm/provider.js";
import { PipelineRunner } from "../pipeline/runner.js";
import type { PipelineDiagnostic } from "../pipeline/diagnostics.js";
import { ContentPolicyFallbackConfigSchema } from "../models/project.js";

class TestGovernanceAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  run() {
    return this.chat(
      [{ role: "user", content: "Synthetic governance prompt for fallback testing." }],
      { callPhase: "plan", stream: false },
    );
  }
}

const previousEnv = {
  stub: process.env.INKOS_AGENT_LLM_STUB,
  fault: process.env.INKOS_AGENT_LLM_STUB_CONTENT_POLICY_ONCE,
  fallbackKey: process.env.INKOS_TEST_CONTENT_POLICY_FALLBACK_KEY,
};

describe("one-shot provider content-policy fallback", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-content-policy-fallback-"));
    process.env.INKOS_AGENT_LLM_STUB = "1";
    process.env.INKOS_TEST_CONTENT_POLICY_FALLBACK_KEY = "stub-fallback-key";
    __resetLlmStubContentPolicyFaults();
  });

  afterEach(async () => {
    __resetLlmStubContentPolicyFaults();
    restoreEnv("INKOS_AGENT_LLM_STUB", previousEnv.stub);
    restoreEnv("INKOS_AGENT_LLM_STUB_CONTENT_POLICY_ONCE", previousEnv.fault);
    restoreEnv("INKOS_TEST_CONTENT_POLICY_FALLBACK_KEY", previousEnv.fallbackKey);
    await rm(root, { recursive: true, force: true });
  });

  it("falls back once and keeps both calls under the same operation and budget window", async () => {
    process.env.INKOS_AGENT_LLM_STUB_CONTENT_POLICY_ONCE = "planner|primary-service";
    const telemetry: LLMCallTelemetry[] = [];
    const diagnostics: PipelineDiagnostic[] = [];
    const runner = createRunner(root, telemetry, diagnostics);
    const operationId = startOperation(runner, "book-1");

    const response = await new TestGovernanceAgent(
      runner.createAgentContext("planner", "book-1"),
    ).run();

    expect(response.content.length).toBeGreaterThan(0);
    expect(telemetry).toHaveLength(2);
    expect(telemetry[0]).toMatchObject({
      operationId,
      bookId: "book-1",
      agent: "planner",
      service: "primary-service",
      model: "primary-model",
      status: "error",
      attemptCount: 1,
      retryCount: 0,
      failureKind: "provider-content-policy",
      usageEstimated: true,
    });
    expect(telemetry[0]!.usage.promptTokens).toBeGreaterThan(0);
    expect(telemetry[1]).toMatchObject({
      operationId,
      bookId: "book-1",
      agent: "planner",
      service: "fallback-service",
      model: "fallback-model",
      status: "success",
      attemptCount: 1,
      retryCount: 0,
      route: "content-policy-fallback",
      fallbackFrom: {
        service: "primary-service",
        model: "primary-model",
        failureKind: "provider-content-policy",
      },
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: "content-policy-fallback",
        agent: "planner",
        bookId: "book-1",
      }),
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("Synthetic governance prompt");
    await flushTelemetry(runner, "book-1");
  });

  it("does not loop when the configured fallback is also rejected", async () => {
    process.env.INKOS_AGENT_LLM_STUB_CONTENT_POLICY_ONCE = [
      "planner|primary-service",
      "planner|fallback-service",
    ].join(",");
    const telemetry: LLMCallTelemetry[] = [];
    const runner = createRunner(root, telemetry, []);
    startOperation(runner, "book-2");

    await expect(new TestGovernanceAgent(
      runner.createAgentContext("planner", "book-2"),
    ).run()).rejects.toBeInstanceOf(ProviderContentPolicyError);

    expect(telemetry).toHaveLength(2);
    expect(telemetry.map((record) => record.service)).toEqual([
      "primary-service",
      "fallback-service",
    ]);
    expect(telemetry.every((record) => record.attemptCount === 1 && record.retryCount === 0)).toBe(true);
    expect(telemetry[1]).toMatchObject({
      status: "error",
      failureKind: "provider-content-policy",
      route: "content-policy-fallback",
    });
    await flushTelemetry(runner, "book-2");
  });

  it("does not attach the governance fallback to writer", () => {
    const runner = createRunner(root, [], []);
    expect(runner.createAgentContext("writer").contentPolicyFallback).toBeUndefined();
    expect(runner.createAgentContext("settler").contentPolicyFallback?.model).toBe("fallback-model");
  });

  it("rejects raw credentials in the fallback environment-variable field", () => {
    expect(ContentPolicyFallbackConfigSchema.safeParse({
      model: "fallback-model",
      service: "fallback-service",
      baseUrl: "https://fallback.example/v1",
      apiKeyEnv: "sk-raw-key-must-not-be-persisted",
      agents: ["planner"],
    }).success).toBe(false);
  });
});

function createRunner(
  projectRoot: string,
  telemetry: LLMCallTelemetry[],
  diagnostics: PipelineDiagnostic[],
): PipelineRunner {
  const primary = createLLMClient({
    provider: "custom",
    service: "primary-service",
    configSource: "env",
    baseUrl: "https://primary.example/v1",
    apiKey: "stub-primary-key",
    model: "primary-model",
    temperature: 0.7,
    thinkingBudget: 0,
    apiFormat: "chat",
    stream: false,
  });
  return new PipelineRunner({
    client: primary,
    model: "primary-model",
    projectRoot,
    defaultLLMConfig: {
      provider: "custom",
      service: "primary-service",
      configSource: "env",
      baseUrl: "https://primary.example/v1",
      apiKey: "stub-primary-key",
      model: "primary-model",
      temperature: 0.7,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: false,
    },
    contentPolicyFallback: {
      model: "fallback-model",
      provider: "custom",
      service: "fallback-service",
      baseUrl: "https://fallback.example/v1",
      apiKeyEnv: "INKOS_TEST_CONTENT_POLICY_FALLBACK_KEY",
      apiFormat: "chat",
      stream: false,
      agents: [
        "planner",
        "settler",
      ],
    },
    onCallTelemetry: (record) => telemetry.push(record),
    onPipelineDiagnostic: (record) => diagnostics.push(record),
  });
}

function startOperation(runner: PipelineRunner, bookId: string): string {
  return (runner as unknown as {
    startOperation: (targetBookId: string) => string;
  }).startOperation(bookId);
}

async function flushTelemetry(runner: PipelineRunner, bookId: string): Promise<void> {
  const pending = (runner as unknown as {
    telemetryWriteQueues: Map<string, Promise<void>>;
  }).telemetryWriteQueues.get(bookId);
  await pending;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
