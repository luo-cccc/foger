import { afterEach, describe, expect, it } from "vitest";
import { isLlmStubEnabled, stubChatCompletion } from "../agent/llm-stub.js";

describe("llm-stub", () => {
  const previousStubEnv = process.env.INKOS_AGENT_LLM_STUB;

  afterEach(() => {
    if (previousStubEnv === undefined) {
      delete process.env.INKOS_AGENT_LLM_STUB;
    } else {
      process.env.INKOS_AGENT_LLM_STUB = previousStubEnv;
    }
  });

  it("isLlmStubEnabled reflects the env var", () => {
    process.env.INKOS_AGENT_LLM_STUB = "1";
    expect(isLlmStubEnabled()).toBe(true);

    delete process.env.INKOS_AGENT_LLM_STUB;
    expect(isLlmStubEnabled()).toBe(false);
  });

  it("returns a valid structure JSON for a structure prompt", () => {
    const response = stubChatCompletion(
      [
        { role: "system", content: "Generate branching structure JSON with nodes." },
        { role: "user", content: "Three-act outline." },
      ],
      "stub-model",
    );

    const parsed = JSON.parse(response.content) as { nodes: unknown[] };
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("returns a complete architect foundation contract for foundation prompts", () => {
    const response = stubChatCompletion(
      [
        {
          role: "system",
          content: [
            "You are the architect of this book.",
            "=== SECTION: story_frame ===",
            "=== SECTION: volume_map ===",
            "=== SECTION: roles ===",
            "=== SECTION: book_rules ===",
            "=== SECTION: pending_hooks ===",
          ].join("\n"),
        },
        { role: "user", content: "Generate the complete foundation." },
      ],
      "stub-model",
    );

    expect(response.content).toContain("=== SECTION: story_frame ===");
    expect(response.content).toContain("=== SECTION: volume_map ===");
    expect(response.content).toContain("=== SECTION: roles ===");
    expect(response.content).toContain("=== SECTION: book_rules ===");
    expect(response.content).toContain("=== SECTION: pending_hooks ===");
    expect(response.content).toContain("---ROLE---");
    expect(response.content).toContain("tier: major");
    expect(response.content).toContain("| hook_id |");
  });

  it("returns a passing reviewer contract for foundation review prompts", () => {
    const response = stubChatCompletion(
      [
        {
          role: "system",
          content: [
            "You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).",
            "=== DIMENSION: 1 ===",
            "Score: {0-100}",
            "=== OVERALL ===",
          ].join("\n"),
        },
        { role: "user", content: "Review this foundation." },
      ],
      "stub-model",
    );

    expect(response.content).toContain("=== DIMENSION: 1 ===");
    expect(response.content).toContain("=== DIMENSION: 5 ===");
    expect(response.content).toContain("=== OVERALL ===");
    expect(response.content).toContain("Passed: yes");
  });
});
