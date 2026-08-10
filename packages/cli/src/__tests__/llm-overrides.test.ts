import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineConfig, parseLLMOverridesFromArgv } from "../utils.js";

const previousTimeout = process.env.INKOS_LLM_TIMEOUT_MS;

afterEach(() => {
  if (previousTimeout === undefined) delete process.env.INKOS_LLM_TIMEOUT_MS;
  else process.env.INKOS_LLM_TIMEOUT_MS = previousTimeout;
});

describe("parseLLMOverridesFromArgv", () => {
  it("parses service/model/api key env and transport overrides from CLI argv", () => {
    expect(parseLLMOverridesFromArgv([
      "write",
      "next",
      "--service",
      "google",
      "--model=gemini-2.5-flash",
      "--api-key-env",
      "GOOGLE_API_KEY",
      "--api-format",
      "chat",
      "--no-stream",
    ])).toEqual({
      service: "google",
      model: "gemini-2.5-flash",
      apiKeyEnv: "GOOGLE_API_KEY",
      apiFormat: "chat",
      stream: false,
    });
  });

  it("wires INKOS_LLM_TIMEOUT_MS into pipeline config", () => {
    process.env.INKOS_LLM_TIMEOUT_MS = "4321";

    const config = buildPipelineConfig({
      llm: {
        provider: "openai",
        service: "openai",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "gpt-5.4-mini",
      },
      foundation: { reviewRetries: 2 },
      writing: { reviewRetries: 1 },
      notify: [],
      modelOverrides: {},
      inputGovernanceMode: "v2",
    } as never, process.cwd(), { quiet: true });

    expect(config.defaultTimeoutMs).toBe(4321);
  });
});
