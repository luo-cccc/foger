import { afterEach, describe, expect, it, vi } from "vitest";
import { StateValidatorAgent } from "../agents/state-validator.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("StateValidatorAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid JSON object even when the model appends markdown with extra braces", async () => {
    const agent = new StateValidatorAgent({
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
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "{\"warnings\":[],\"passed\":true}",
          "",
          "## Notes",
          "Trailing markdown can still mention braces like } without changing the verdict.",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await expect(agent.validate(
      "Chapter body.",
      3,
      "old state",
      "new state",
      "old hooks",
      "new hooks",
      "en",
    )).resolves.toEqual({
      warnings: [],
      passed: true,
    });
  });

  it("passes maxTokens large enough for thinking models to chat()", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 8192,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate("Body.", 1, "old", "new state", "old hooks", "new hooks", "zh");

    const options = chatSpy.mock.calls[0]?.[1] as { maxTokens?: number } | undefined;
    // Must not hardcode a small value like 2048 that starves thinking models
    expect(options?.maxTokens).toBeUndefined();
  });

  it("treats missing truth updates as blocking even when the model says PASS", async () => {
    const agent = new StateValidatorAgent({
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
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: "PASS\n[missing_state_change] Chapter 2 changed the goal, but the state card stayed on chapter 1.",
        usage: ZERO_USAGE,
      });

    const result = await agent.validate(
      "Chapter 2 changes the goal.",
      2,
      "old state",
      "new but incomplete state",
      "old hooks",
      "new hooks",
      "en",
    );

    expect(result.passed).toBe(false);
    expect(result.warnings[0]?.category).toBe("missing_state_change");
  });

  it("passes authority truth context into the cross-file validation prompt", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 8192,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate(
      "正文确认：第五条规则才是天黑后不准出宿舍。",
      2,
      "old state",
      "new state: 第一条规则已被批注",
      "old hooks",
      "new hooks",
      "zh",
      {
        storyFrame: "简介里写过：规则一：天黑后不准出宿舍。",
        bookRules: "硬规则：规则编号必须以前文正文确立版本为准。",
        chapterSummaries: "第1章：发现第五条规则的漏洞。",
      },
    );

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("truth files");
    expect(messages[0]?.content).toContain("numbered");
    expect(messages[0]?.content).toContain("Internal hook contradiction");
    expect(messages[1]?.content).toContain("## Authority / Cross-Truth Context");
    expect(messages[1]?.content).toContain("规则一：天黑后不准出宿舍");
    expect(messages[1]?.content).toContain("第1章：发现第五条规则的漏洞");
  });

  it("does not silently truncate chapter or authority context before validation", async () => {
    const agent = new StateValidatorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 8192,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });

    await agent.validate(
      `${"正文".repeat(7000)}\nCHAPTER_TAIL_MARKER`,
      8,
      "old state",
      "new state",
      "old hooks",
      "new hooks",
      "zh",
      {
        storyFrame: `${"世界设定".repeat(4000)}\nSTORY_FRAME_TAIL_MARKER`,
        bookRules: `${"规则".repeat(3000)}\nBOOK_RULES_TAIL_MARKER`,
        chapterSummaries: `${"摘要".repeat(4000)}\nCHAPTER_SUMMARIES_TAIL_MARKER`,
      },
    );

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[1]?.content).toContain("CHAPTER_TAIL_MARKER");
    expect(messages[1]?.content).toContain("STORY_FRAME_TAIL_MARKER");
    expect(messages[1]?.content).toContain("BOOK_RULES_TAIL_MARKER");
    expect(messages[1]?.content).toContain("CHAPTER_SUMMARIES_TAIL_MARKER");
    expect(messages[1]?.content).not.toContain("[...truncated...]");
  });

  it("throws when the validator model returns an empty response", async () => {
    const agent = new StateValidatorAgent({
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
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: "",
        usage: ZERO_USAGE,
      });

    // Empty response throws (fail-closed)
    await expect(agent.validate(
      "Chapter body.",
      3,
      "old state",
      "new state",
      "old hooks",
      "new hooks",
      "en",
    )).rejects.toThrow("empty response");
  });

  it("deterministically rejects a hook advanced this chapter whose note denies movement", async () => {
    const agent = new StateValidatorAgent({
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
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    );
    const oldHooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H008 | 1 | 信息 | open | 1 | 查明旧档案 | 等待证据 |",
    ].join("\n");
    const newHooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H008 | 1 | 信息 | progressing | 2 | 查明旧档案 | 本章没有推进，也未出现相关证据 |",
    ].join("\n");

    const result = await agent.validate("正文没有档案。", 2, "old", "new", oldHooks, newHooks, "zh");

    expect(result.passed).toBe(false);
    expect(result.warnings[0]?.category).toBe("hook-state-contradiction");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("deterministically rejects deferred hooks that refresh lastAdvancedChapter", async () => {
    const agent = new StateValidatorAgent({
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
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    );
    const oldHooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H004 | 1 | 信息 | progressing | 3 | 查明替代名单 | 第3章获得部分明文 |",
    ].join("\n");
    const newHooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H004 | 1 | 信息 | deferred | 4 | 查明替代名单 | 第3章获得部分明文 |",
    ].join("\n");

    const result = await agent.validate("正文没有推进替代名单。", 4, "old", "new", oldHooks, newHooks, "zh");

    expect(result.passed).toBe(false);
    expect(result.warnings[0]?.description).toContain("延后必须保留此前的推进章节");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("allows a progressing hook to note that its final payoff has not happened yet", async () => {
    const agent = new StateValidatorAgent({
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
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: "PASS", usage: ZERO_USAGE });
    const oldHooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H006 | 1 | 情感 | open | 0 | 记忆形成回声 | 等待触发 |",
    ].join("\n");
    const newHooks = [
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H006 | 1 | 情感 | progressing | 1 | 记忆形成回声 | 本章推进前置阶段；最终回声循环尚未形成 |",
    ].join("\n");

    await expect(agent.validate("正文呈现了记忆代价。", 1, "old", "new", oldHooks, newHooks, "zh"))
      .resolves.toEqual({ warnings: [], passed: true });
  });
});
