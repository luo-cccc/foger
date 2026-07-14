import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAgent } from "../agents/base.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { countChapterLength } from "../utils/length-metrics.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const AGENT_CONTEXT = {
  client: {
    provider: "openai",
    apiFormat: "chat",
    stream: false,
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
      thinkingBudget: 0,
      extra: {},
    },
  } as const,
  model: "test-model",
  projectRoot: "/tmp/inkos-length-normalizer-test",
};

function createAgent(): LengthNormalizerAgent {
  return new LengthNormalizerAgent(AGENT_CONTEXT as never);
}

describe("LengthNormalizerAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compresses a long draft while preserving required markers", async () => {
    const agent = createAgent();
    const compressed = `${"压缩后的正文。".repeat(30)}[[KEEP_ME]]`;
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: compressed,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = `开头。${"多余句子。".repeat(80)}[[KEEP_ME]]`;

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]] and remove redundancy.",
      reducedControlBlock: "Avoid [[FORBIDDEN]] and keep the scene on target.",
    });

    expect(chatSpy).toHaveBeenCalled();
    expect(result.applied).toBe(true);
    expect(result.mode).toBe("compress");
    expect(result.normalizedContent).toContain("[[KEEP_ME]]");
    expect(result.normalizedContent).not.toContain("[[FORBIDDEN]]");
    expect(result.finalCount).toBe(countChapterLength(result.normalizedContent, "zh_chars"));
    expect(result.finalCount).toBeLessThan(countChapterLength(draft, "zh_chars"));
  });

  it("retries once with a stricter prompt when the first pass still misses the hard range", async () => {
    const agent = createAgent();
    const firstPass = "仍然过长。".repeat(60);
    const secondPass = "二次压缩后的正文。".repeat(18);
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat")
      .mockResolvedValueOnce({
        content: firstPass,
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: secondPass,
        usage: ZERO_USAGE,
      });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "开头。".repeat(120);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Keep the same scene.",
      reducedControlBlock: "No new subplot.",
    });

    expect(chatSpy).toHaveBeenCalledTimes(2);
    const secondCall = chatSpy.mock.calls[1] as unknown as [ReadonlyArray<{ content: string }>, unknown?] | undefined;
    expect(secondCall?.[0]?.[0]?.content).toContain("final correction pass");
    expect(result.normalizedContent).toBe(secondPass);
    expect(result.warning).toContain("outside the soft range");
  });

  it("retries when the first pass enters the hard range but still misses the soft target", async () => {
    const agent = createAgent();
    const firstPass = "首次压缩。".repeat(52);
    const secondPass = "严格压缩。".repeat(42);
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat")
      .mockResolvedValueOnce({ content: firstPass, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: secondPass, usage: ZERO_USAGE });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    const result = await agent.normalizeChapter({
      chapterContent: "原始正文。".repeat(120),
      lengthSpec,
    });

    expect(countChapterLength(firstPass, "zh_chars")).toBeGreaterThan(lengthSpec.softMax);
    expect(countChapterLength(firstPass, "zh_chars")).toBeLessThanOrEqual(lengthSpec.hardMax);
    expect(chatSpy).toHaveBeenCalledTimes(2);
    const secondCall = chatSpy.mock.calls[1] as unknown as [ReadonlyArray<{ content: string }>, unknown?] | undefined;
    expect(secondCall?.[0]?.map((message) => message.content).join("\n")).toContain("Strict Length Requirement");
    expect(secondCall?.[0]?.map((message) => message.content).join("\n")).toContain("Delete at least");
    expect(secondCall?.[0]?.map((message) => message.content).join("\n")).toContain("preserving every paragraph is forbidden");
    expect(result.normalizedContent).toBe(secondPass);
    expect(result.warning).toBeUndefined();
  });

  it("deterministically bounds an overlong result after both LLM passes miss hard max", async () => {
    const agent = createAgent();
    const stillOverlong = "这是完整句子。".repeat(80);
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat")
      .mockResolvedValueOnce({ content: stillOverlong, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: stillOverlong, usage: ZERO_USAGE });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    const result = await agent.normalizeChapter({
      chapterContent: "原始超长章节。".repeat(100),
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(result.finalCount).toBeLessThanOrEqual(lengthSpec.hardMax);
    expect(result.finalCount).toBeGreaterThanOrEqual(lengthSpec.hardMin);
    expect(result.normalizedContent.endsWith("。"))
      .toBe(true);
  });

  it("preserves required markers when deterministic hard-max bounding trims the tail", async () => {
    const agent = createAgent();
    const stillOverlong = `${"这是完整句子。".repeat(80)}[[KEEP_ME]]`;
    vi.spyOn(BaseAgent.prototype as never, "chat")
      .mockResolvedValueOnce({ content: stillOverlong, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: stillOverlong, usage: ZERO_USAGE });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    const result = await agent.normalizeChapter({
      chapterContent: "原始超长章节。".repeat(100) + "[[KEEP_ME]]",
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]].",
    });

    expect(result.normalizedContent).toContain("[[KEEP_ME]]");
    expect(result.finalCount).toBeLessThanOrEqual(lengthSpec.hardMax);
    expect(result.finalCount).toBeGreaterThanOrEqual(lengthSpec.hardMin);
  });

  it("keeps both opening causality and the final commitment when hard-max bounding", async () => {
    const agent = createAgent();
    const stillOverlong = [
      "开场因果：林澈发现磁带编号被改过。",
      ...Array.from({ length: 80 }, () => "中段重复调查没有新增证据。"),
      "章尾承诺落地：林澈把证据交给阿泽并锁定下一处档案。",
    ].join("\n");
    vi.spyOn(BaseAgent.prototype as never, "chat")
      .mockResolvedValueOnce({ content: stillOverlong, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: stillOverlong, usage: ZERO_USAGE });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    const result = await agent.normalizeChapter({
      chapterContent: "原始超长章节。".repeat(100),
      lengthSpec,
    });

    expect(result.normalizedContent).toContain("开场因果：林澈发现磁带编号被改过");
    expect(result.normalizedContent).toContain("章尾承诺落地：林澈把证据交给阿泽并锁定下一处档案");
    expect(result.finalCount).toBeGreaterThanOrEqual(lengthSpec.hardMin);
    expect(result.finalCount).toBeLessThanOrEqual(lengthSpec.hardMax);
  });

  it("does not override provider output budget for large compression outputs", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "压缩后的完整正文。".repeat(200),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 3500,
      softMin: 3023,
      softMax: 3977,
      hardMin: 2800,
      hardMax: 4200,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    await agent.normalizeChapter({
      chapterContent: "原始正文。".repeat(1200),
      lengthSpec,
    });

    const options = chatSpy.mock.calls[0]?.[1] as { maxTokens?: number } | undefined;
    expect(options?.maxTokens).toBeUndefined();
  });

  it("falls back to the original chapter when normalized output is truncated mid-sentence", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "李队把传真和登记表叠在一起，收进文件夹，眼神已经不是半",
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 3500,
      softMin: 3023,
      softMax: 3977,
      hardMin: 2800,
      hardMax: 4200,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "原始正文有完整句号。".repeat(400);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalled();
    expect(result.normalizedContent).toBe(draft);
    expect(result.warning).toContain("truncated");
  });

  it("keeps the original chapter when compression crosses below the hard minimum", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "压缩过头。".repeat(70),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 1000,
      softMin: 864,
      softMax: 1136,
      hardMin: 728,
      hardMax: 1272,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "完整场景。".repeat(300);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalled();
    expect(result.normalizedContent).toBe(draft);
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("crossed the hard range");
  });

  it("strips explanatory wrappers from malformed normalizer output", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: [
        "我先压缩一下正文。",
        "",
        "```markdown",
        "压缩后的正文。[[KEEP_ME]]",
        "```",
      ].join("\n"),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = `开头。${"冗余句子。".repeat(50)}[[KEEP_ME]]`;

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]] only.",
      reducedControlBlock: "No extra commentary.",
    });

    expect(chatSpy).toHaveBeenCalled();
    expect(result.normalizedContent).toBe("压缩后的正文。[[KEEP_ME]]");
    expect(result.normalizedContent).not.toContain("我先压缩一下正文");
    expect(result.normalizedContent).not.toContain("```");
  });

  it("falls back to the original chapter when the response contains only wrappers", async () => {
    const agent = createAgent();
    vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "我先压缩一下正文。",
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = `开头。${"冗余句子。".repeat(40)}[[KEEP_ME]]`;

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]] only.",
      reducedControlBlock: "No extra commentary.",
    });

    expect(result.normalizedContent).toBe(draft);
    expect(result.finalCount).toBe(countChapterLength(draft, "zh_chars"));
  });

  it("preserves legitimate English prose that starts with 'I will'", async () => {
    const agent = createAgent();
    const prose = "I will wait here until dawn.\nThe shutters rattled in the wind.";
    vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: prose,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "en_words",
      normalizeMode: "compress",
    });
    const draft = "Original text. ".repeat(80);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(result.normalizedContent).toBe(prose);
  });
});
