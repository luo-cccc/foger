import { describe, expect, it, afterEach } from "vitest";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import type { LLMClient } from "../llm/provider.js";

// Base client stub. Identity only — no network is ever made; resolveOverride's
// full-override branch calls createLLMClient which is a pure constructor.
const BASE_CLIENT = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  __tag: "base",
} as unknown as LLMClient;

const buildRunner = (
  modelOverrides?: Record<string, string | Record<string, unknown>>,
): PipelineRunner =>
  new PipelineRunner({
    state: new StateManager(process.cwd()),
    projectRoot: process.cwd(),
    client: BASE_CLIENT,
    model: "base-model",
    defaultLLMConfig: {
      provider: "custom",
      service: "custom",
      configSource: "env",
      baseUrl: "https://base.example/v1",
      apiKey: "base-key",
      model: "base-model",
      temperature: 0.7,
      thinkingBudget: 0,
      apiFormat: "chat",
      stream: false,
    },
    modelOverrides,
  } as unknown as ConstructorParameters<typeof PipelineRunner>[0]);

const savedEnv = { ...process.env };

describe("PipelineRunner model-override routing (resolveOverride via createAgentContext)", () => {
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("falls back to the global model + base client when no override is configured", () => {
    const runner = buildRunner();
    const ctx = runner.createAgentContext("writer");
    expect(ctx.model).toBe("base-model");
    expect(ctx.client).toBe(BASE_CLIENT);
  });

  it("routes each governance agent independently by name", () => {
    const runner = buildRunner({
      "canon-extractor": "extractor-model",
      "volume-auditor": "auditor-model",
    });
    // Configured agents pick up their own model; the base client is reused
    // because no baseUrl differs.
    expect(runner.createAgentContext("canon-extractor").model).toBe("extractor-model");
    expect(runner.createAgentContext("canon-extractor").client).toBe(BASE_CLIENT);
    expect(runner.createAgentContext("volume-auditor").model).toBe("auditor-model");
    // An agent without an override still falls back to global.
    expect(runner.createAgentContext("claim-validator").model).toBe("base-model");
  });

  it("string shorthand override keeps the base client and only swaps the model", () => {
    const runner = buildRunner({ writer: "premium-writer-model" });
    const ctx = runner.createAgentContext("writer");
    expect(ctx.model).toBe("premium-writer-model");
    expect(ctx.client).toBe(BASE_CLIENT);
  });

  it("object override without baseUrl reuses the base client", () => {
    const runner = buildRunner({ auditor: { model: "cheap-auditor-model" } });
    const ctx = runner.createAgentContext("auditor");
    expect(ctx.model).toBe("cheap-auditor-model");
    expect(ctx.client).toBe(BASE_CLIENT);
  });

  it("object override with a distinct baseUrl builds a dedicated client", () => {
    const runner = buildRunner({
      writer: { model: "remote-writer", provider: "custom", baseUrl: "https://other.example/v1" },
    });
    const ctx = runner.createAgentContext("writer");
    expect(ctx.model).toBe("remote-writer");
    // A separate client instance was constructed for the distinct endpoint.
    expect(ctx.client).not.toBe(BASE_CLIENT);
  });

  it("object override can select a concrete service and API format", () => {
    const runner = buildRunner({
      planner: {
        model: "MiniMax-M3",
        provider: "openai",
        service: "minimax",
        baseUrl: "https://api.minimaxi.com/v1",
        apiFormat: "chat",
        stream: false,
      },
    });
    const ctx = runner.createAgentContext("planner");
    expect(ctx.model).toBe("MiniMax-M3");
    expect(ctx.client.service).toBe("minimax");
    expect(ctx.client.apiFormat).toBe("chat");
    expect(ctx.client.stream).toBe(false);
  });

  it("caches the dedicated client so repeated resolves reuse one instance", () => {
    const runner = buildRunner({
      writer: { model: "remote-writer", provider: "custom", baseUrl: "https://other.example/v1" },
      planner: { model: "remote-planner", provider: "custom", baseUrl: "https://other.example/v1" },
    });
    // Same (provider, baseUrl, apiKeySource, stream, format) → same cache key →
    // same client instance shared across agents.
    const writerClient = runner.createAgentContext("writer").client;
    const writerClientAgain = runner.createAgentContext("writer").client;
    const plannerClient = runner.createAgentContext("planner").client;
    expect(writerClientAgain).toBe(writerClient);
    expect(plannerClient).toBe(writerClient);
  });

  it("does not share cached clients across different override services", () => {
    const runner = buildRunner({
      writer: {
        model: "writer-model",
        provider: "openai",
        service: "minimax",
        baseUrl: "https://shared.example/v1",
      },
      planner: {
        model: "planner-model",
        provider: "openai",
        service: "custom:OpenRouterLive",
        baseUrl: "https://shared.example/v1",
      },
    });
    const writerClient = runner.createAgentContext("writer").client;
    const plannerClient = runner.createAgentContext("planner").client;
    expect(plannerClient).not.toBe(writerClient);
  });

  it("distinct baseUrls produce distinct cached clients", () => {
    const runner = buildRunner({
      writer: { model: "w", provider: "custom", baseUrl: "https://one.example/v1" },
      planner: { model: "p", provider: "custom", baseUrl: "https://two.example/v1" },
    });
    const writerClient = runner.createAgentContext("writer").client;
    const plannerClient = runner.createAgentContext("planner").client;
    expect(plannerClient).not.toBe(writerClient);
  });

  it("reads the API key from apiKeyEnv when building a dedicated client", () => {
    process.env.INKOS_TEST_ROUTE_KEY = "sk-routed";
    const runner = buildRunner({
      writer: {
        model: "remote-writer",
        provider: "custom",
        baseUrl: "https://keyed.example/v1",
        apiKeyEnv: "INKOS_TEST_ROUTE_KEY",
      },
    });
    // apiKeyEnv changes the cache key vs a base-key client; the resolve must not
    // throw and must yield a dedicated client for the keyed endpoint.
    const ctx = runner.createAgentContext("writer");
    expect(ctx.model).toBe("remote-writer");
    expect(ctx.client).not.toBe(BASE_CLIENT);
  });
});
