import { describe, expect, it, vi } from "vitest";
import { CanonExtractor } from "../agents/canon-extractor.js";
import type { LLMClient } from "../llm/provider.js";
import { saveCanonBundle, loadCanonBundle, hasCanon, loadClaimsFile } from "../state/canon-store.js";
import type { CanonBundle } from "../models/canon.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as const;

function makeAgent(
  llmOverride?: (messages: unknown) => string,
  stream = false,
  optionsSeen?: unknown[],
  route: { readonly model?: string; readonly service?: string } = {},
): CanonExtractor {
  const client = {
    provider: "openai",
    service: route.service,
    apiFormat: "chat",
    stream,
    defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  } as unknown as LLMClient;

  const agent = new CanonExtractor({
    client,
    model: route.model ?? "test-model",
    projectRoot: process.cwd(),
  });

  if (llmOverride) {
    vi.spyOn(agent as unknown as { chat: (...a: unknown[]) => Promise<unknown> }, "chat").mockImplementation(
      async (messages, options) => {
        optionsSeen?.push(options);
        const content = llmOverride(messages);
        return { content, usage: ZERO_USAGE };
      },
    );
  } else {
    vi.spyOn(agent as unknown as { chat: (...a: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(
      new Error("no LLM in test"),
    );
  }

  return agent;
}

function writeFoundation(bookDir: string): void {
  const fs = require("node:fs");
  const path = require("node:path");
  const story = path.join(bookDir, "story");
  fs.mkdirSync(path.join(story, "outline"), { recursive: true });
  fs.mkdirSync(path.join(story, "roles", "主要角色"), { recursive: true });
  fs.writeFileSync(
    path.join(story, "outline", "story_frame.md"),
    "# 故事框架\n\n## 世界观铁律\n- 灵气枯竭后无法自行恢复\n- 施法必付寿元\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(story, "book_rules.md"),
    "## 禁止事项\n\n- 不得出现破折号\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(story, "roles", "主要角色", "林辞.md"),
    "## 当前现状\n林辞是杂役。\n\n## 特殊\n他能听到器物低语。\n",
    "utf-8",
  );
}

describe("CanonExtractor", () => {
  it("falls back to heuristic extraction when no LLM is available", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const agent = makeAgent();
      const result = await agent.extract(tmp, "zh");

      expect(result.usedFallback).toBe(true);
      expect(result.claims.length).toBeGreaterThan(0);
      const objectiveRules = result.claims.filter((c) => c.claimType === "objective_rule");
      const prohibitions = result.claims.filter((c) => c.claimType === "prohibition");
      expect(objectiveRules.length).toBeGreaterThan(0);
      expect(prohibitions.length).toBeGreaterThan(0);
      const hardClaims = result.claims.filter(
        (c) => c.claimType === "objective_rule" || c.claimType === "prohibition",
      );
      expect(hardClaims.every((c) => c.authority.priority === "hard")).toBe(true);
      expect(result.protagonistSystem?.name).toBe("林辞");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the LLM path and stores structured canon", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const optionsSeen: unknown[] = [];
      const agent = makeAgent(() =>
        JSON.stringify({
          claims: [
            {
              id: "w-1",
              domain: "world",
              claimType: "objective_rule",
              content: "灵气恒定。",
              scope: { appliesTo: ["all"] },
              authority: { source: "story_frame", priority: "hard" },
              visibility: { characterKnownBy: [], hiddenFrom: [] },
              constraints: { requiresCost: [], forbiddenUses: [] },
            },
          ],
          worldSystem: { objectiveRules: ["灵气恒定"], taboos: [] },
          protagonistSystem: { name: "林辞" },
          systemRelations: { mode: "hybrid", auditRules: ["主角例外不得泛化"] },
        }),
        true,
        optionsSeen,
      );

      const result = await agent.extract(tmp, "zh");
      expect(result.usedFallback).toBe(false);
      expect(result.claims).toHaveLength(1);
      expect(optionsSeen[0]).toMatchObject({
        stream: false,
        callPhase: "extract",
        maxTokens: 8192,
      });

      const bundle: CanonBundle = {
        claims: { claims: [...result.claims] },
        worldSystem: result.worldSystem,
        protagonistSystem: result.protagonistSystem,
        systemRelations: result.systemRelations,
      };
      await saveCanonBundle(tmp, bundle);

      expect(await hasCanon(tmp)).toBe(true);
      const loaded = await loadCanonBundle(tmp);
      expect(loaded.claims.claims[0]?.id).toBe("w-1");
      expect(loaded.protagonistSystem?.name).toBe("林辞");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes nullable optional fields without falling back", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const agent = makeAgent(() => JSON.stringify({
        claims: [{
          id: "w-1",
          domain: "world",
          claimType: "objective_rule",
          content: "鐏垫皵鎭掑畾",
          scope: {
            appliesTo: ["all"],
            excludes: null,
            geography: "旧城",
            timeRange: null,
          },
          authority: { source: "story_frame", priority: "hard" },
          visibility: { characterKnownBy: [], hiddenFrom: [] },
          relations: null,
          constraints: null,
        }],
        worldSystem: { objectiveRules: ["鐏垫皵鎭掑畾"] },
        protagonistSystem: {},
        systemRelations: {},
      }));

      const result = await agent.extract(tmp, "zh");
      expect(result.usedFallback).toBe(false);
      expect(result.claims[0]?.scope.geography).toEqual(["旧城"]);
      expect(result.claims[0]?.relations).toBeUndefined();
      expect(result.claims[0]?.constraints.requiresCost).toEqual([]);
      expect(result.protagonistSystem).toMatchObject({
        name: "林辞",
        exceptionality: "他能听到器物低语。",
      });
      expect(result.systemRelations).toMatchObject({ mode: "hybrid" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes style claims so POV rules cannot become hidden or cost-bound story facts", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const agent = makeAgent(() => JSON.stringify({
        claims: [{
          id: "style-1",
          domain: "world",
          claimType: "objective_rule",
          content: "叙事视角严格锁定在林辞感知范围内，不使用上帝视角。",
          scope: { appliesTo: ["林辞"] },
          authority: { source: "story_frame", priority: "hard" },
          visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林辞"] },
          constraints: { requiresCost: ["失去线索"], forbiddenUses: [] },
        }],
        worldSystem: {},
        protagonistSystem: null,
        systemRelations: null,
      }));

      const result = await agent.extract(tmp, "zh");

      expect(result.claims[0]).toMatchObject({
        domain: "style",
        scope: { appliesTo: ["all"] },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { requiresCost: [] },
      });
      expect(result.claims[0]?.visibility.readerKnownFrom).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("drops speculative consequences from mandatory claim costs", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const agent = makeAgent(() => JSON.stringify({
        claims: [{
          id: "character-1",
          domain: "character",
          claimType: "character_exception",
          content: "老周暗中协助林澈调查磁带。",
          scope: { appliesTo: ["老周"] },
          authority: { source: "roles/老周", priority: "strong" },
          visibility: { characterKnownBy: ["老周"], hiddenFrom: ["林澈"] },
          constraints: {
            requiresCost: ["老周可能被停职或住院", "每次协助都会失去一段记忆"],
            forbiddenUses: [],
          },
        }],
        worldSystem: {},
        protagonistSystem: null,
        systemRelations: null,
      }));

      const result = await agent.extract(tmp, "zh");

      expect(result.claims[0]?.constraints.requiresCost).toEqual(["每次协助都会失去一段记忆"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back when the LLM returns schema-invalid JSON", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const agent = makeAgent(() => "not-json-at-all");
      const result = await agent.extract(tmp, "zh");
      expect(result.usedFallback).toBe(true);
      expect(result.warnings.some((w) => /fallback/i.test(w))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("salvages complete claims from a truncated LLM JSON envelope", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const completeClaim = {
        id: "world-1",
        domain: "world",
        claimType: "objective_rule",
        content: "灵气枯竭后无法自行恢复",
        scope: { appliesTo: ["all"] },
        authority: { source: "story_frame", priority: "hard" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { requiresCost: [], forbiddenUses: [] },
      };
      const truncated = `{"claims":[${JSON.stringify(completeClaim)},{"id":"broken"`;
      const agent = makeAgent(() => truncated);

      const result = await agent.extract(tmp, "zh");

      expect(result.usedFallback).toBe(true);
      expect(result.claims).toEqual(expect.arrayContaining([
        expect.objectContaining({
          claimType: "objective_rule",
          content: "灵气枯竭后无法自行恢复",
        }),
      ]));
      expect(result.claims.some((claim) => claim.claimType === "prohibition")).toBe(true);
      expect(result.worldSystem.objectiveRules).toContain("灵气枯竭后无法自行恢复");
      expect(result.warnings.join(" ")).toContain("recovered 1 complete claim");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries an incomplete canon envelope once with a bounded completion request", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    let call = 0;
    try {
      writeFoundation(tmp);
      const completeClaim = {
        id: "world-1",
        domain: "world",
        claimType: "objective_rule",
        content: "灵气枯竭后无法自行恢复",
        scope: { appliesTo: ["all"] },
        authority: { source: "story_frame", priority: "hard" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { requiresCost: [], forbiddenUses: [] },
      };
      const agent = makeAgent((messages) => {
        call += 1;
        if (call === 1) return `{"claims":[${JSON.stringify(completeClaim)},`;
        const system = (messages as Array<{ content: string }>)[0]?.content ?? "";
        expect(system).toContain("不完整 JSON 后的重试");
        return JSON.stringify({
          claims: [completeClaim],
          worldSystem: { objectiveRules: [completeClaim.content] },
          protagonistSystem: null,
          systemRelations: null,
        });
      });

      const result = await agent.extract(tmp, "zh");

      expect(call).toBe(2);
      expect(result.usedFallback).toBe(false);
      expect(result.claims.map((entry) => entry.id)).toEqual(["world-1"]);
      expect(result.warnings.join(" ")).toContain("bounded retry returned a complete envelope");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retries when malformed canon JSON fails before any claim can be salvaged", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    let call = 0;
    try {
      writeFoundation(tmp);
      const completeClaim = {
        id: "world-1",
        domain: "world",
        claimType: "objective_rule",
        content: "灵气枯竭后无法自行恢复",
        scope: { appliesTo: ["all"] },
        authority: { source: "story_frame", priority: "hard" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { requiresCost: [], forbiddenUses: [] },
      };
      const agent = makeAgent(() => {
        call += 1;
        if (call === 1) return '{"claims":[CanonClaim...';
        return JSON.stringify({
          claims: [completeClaim],
          worldSystem: { objectiveRules: [completeClaim.content] },
          protagonistSystem: null,
          systemRelations: null,
        });
      });

      const result = await agent.extract(tmp, "zh");

      expect(call).toBe(2);
      expect(result.usedFallback).toBe(false);
      expect(result.claims.map((entry) => entry.id)).toEqual(["world-1"]);
      expect(result.warnings.join(" ")).toContain("invalid; bounded retry returned a complete envelope");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("selects the canon envelope when the model prefixes it with another JSON object", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    let call = 0;
    try {
      writeFoundation(tmp);
      const completeClaim = {
        id: "world-1",
        domain: "world",
        claimType: "objective_rule",
        content: "灵气枯竭后无法自行恢复",
        scope: { appliesTo: ["all"] },
        authority: { source: "story_frame", priority: "hard" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { requiresCost: [], forbiddenUses: [] },
      };
      const agent = makeAgent(() => {
        call += 1;
        return [
          "{}",
          "以下为严格 JSON：",
          JSON.stringify({
            claims: [completeClaim],
            worldSystem: { objectiveRules: [completeClaim.content] },
            protagonistSystem: null,
            systemRelations: null,
          }),
        ].join("\n");
      });

      const result = await agent.extract(tmp, "zh");

      expect(call).toBe(1);
      expect(result.usedFallback).toBe(false);
      expect(result.claims.map((entry) => entry.id)).toEqual(["world-1"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("selects a complete canon envelope inside a redundant outer brace", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      writeFoundation(tmp);
      const completeClaim = {
        id: "world-1",
        domain: "world",
        claimType: "objective_rule",
        content: "灵气枯竭后无法自行恢复",
        scope: { appliesTo: ["all"] },
        authority: { source: "story_frame", priority: "hard" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { requiresCost: [], forbiddenUses: [] },
      };
      const envelope = JSON.stringify({
        claims: [completeClaim],
        worldSystem: { objectiveRules: [completeClaim.content] },
        protagonistSystem: null,
        systemRelations: null,
      });
      const agent = makeAgent(() => `{${envelope}}`);

      const result = await agent.extract(tmp, "zh");

      expect(result.usedFallback).toBe(false);
      expect(result.claims.map((entry) => entry.id)).toEqual(["world-1"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requests non-reasoning JSON output for DeepSeek V4 Flash on OpenRouter", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    const optionsSeen: unknown[] = [];
    let systemPrompt = "";
    try {
      writeFoundation(tmp);
      const agent = makeAgent(
        (messages) => {
          systemPrompt = (messages as Array<{ content: string }>)[0]?.content ?? "";
          return JSON.stringify({ claims: [] });
        },
        false,
        optionsSeen,
        { model: "deepseek/deepseek-v4-flash", service: "openrouter" },
      );

      await agent.extract(tmp, "zh");

      expect(optionsSeen[0]).toMatchObject({
        extra: {
          response_format: { type: "json_object" },
          reasoning: { effort: "none" },
          include_reasoning: false,
        },
      });
      expect(systemPrompt).toContain("顶层只允许一个字段");
      expect(systemPrompt).toContain("禁止输出 worldSystem");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails loudly when claims.json is malformed instead of silently returning an empty canon", async () => {
    const os = require("node:os");
    const fs = require("node:fs");
    const path = require("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkos-canon-"));
    try {
      fs.mkdirSync(path.join(tmp, "story", "canon"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "story", "canon", "claims.json"), "{not json", "utf-8");

      await expect(loadClaimsFile(tmp)).rejects.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
