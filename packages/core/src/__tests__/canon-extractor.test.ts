import { describe, expect, it, vi } from "vitest";
import { CanonExtractor } from "../agents/canon-extractor.js";
import type { LLMClient } from "../llm/provider.js";
import { saveCanonBundle, loadCanonBundle, hasCanon, loadClaimsFile } from "../state/canon-store.js";
import type { CanonBundle } from "../models/canon.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as const;

function makeAgent(llmOverride?: (messages: unknown) => string): CanonExtractor {
  const client = {
    provider: "openai",
    apiFormat: "chat",
    stream: false,
    defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  } as unknown as LLMClient;

  const agent = new CanonExtractor({ client, model: "test-model", projectRoot: process.cwd() });

  if (llmOverride) {
    vi.spyOn(agent as unknown as { chat: (...a: unknown[]) => Promise<unknown> }, "chat").mockImplementation(
      async (messages) => {
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
      );

      const result = await agent.extract(tmp, "zh");
      expect(result.usedFallback).toBe(false);
      expect(result.claims).toHaveLength(1);

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
