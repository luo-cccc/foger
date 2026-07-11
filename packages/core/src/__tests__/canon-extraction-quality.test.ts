import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonExtractor } from "../agents/canon-extractor.js";
import type { LLMClient } from "../llm/provider.js";
import type { CanonClaim } from "../models/canon.js";

/**
 * Extraction-quality baseline for the heuristic CanonExtractor fallback.
 *
 * The existing canon-extractor.test.ts proves schema validity and degradation.
 * This suite instead measures *coverage*: given a realistic prose foundation,
 * does the heuristic pull out the key world rules, prohibitions, and the
 * protagonist exception it is supposed to? It asserts recall against a golden
 * keyword set (not verbatim strings), so tuning the heuristic stays possible
 * while a genuine coverage regression is caught.
 *
 * To extend: add a case to GOLDEN_CORPUS with its foundation files and the
 * canon it must recover, then set a recall floor that reflects what the
 * deterministic heuristic can realistically reach today.
 */

interface GoldenFoundation {
  storyFrame: string;
  bookRules: string;
  majorRole: { name: string; content: string };
}

interface GoldenExpectation {
  /** Keywords that should each surface in at least one objective_rule claim. */
  worldRuleKeywords: string[];
  /** Keywords that should each surface in at least one prohibition claim. */
  prohibitionKeywords: string[];
  /** Keyword the protagonist character_exception content should contain. */
  protagonistExceptionKeyword: string;
  /** Minimum fraction of worldRuleKeywords that must be covered. */
  worldRuleRecallFloor: number;
  /** Minimum fraction of prohibitionKeywords that must be covered. */
  prohibitionRecallFloor: number;
}

interface GoldenCase {
  name: string;
  foundation: GoldenFoundation;
  expect: GoldenExpectation;
}

const GOLDEN_CORPUS: GoldenCase[] = [
  {
    name: "xuanhuan world with multiple iron laws and prohibitions",
    foundation: {
      storyFrame: [
        "# 故事框架",
        "",
        "## 主题与基调",
        "一个灵气枯竭的末法时代，凡人挣扎求存。",
        "",
        "## 世界观铁律",
        "- 灵气一旦枯竭便无法自行恢复，只能靠外部灵矿补充",
        "- 任何施法都必须以寿元为代价，法术越强寿元损耗越大",
        "- 器魂只认第一个唤醒它的人，终生不可转让",
        "- 跨越境界必须渡劫，渡劫失败者形神俱灭",
        "",
        "## 终局方向",
        "主角最终要重新点燃天地灵脉。",
      ].join("\n"),
      bookRules: [
        "## 禁止事项",
        "",
        "- 不得出现现代科技词汇",
        "- 不得让配角掌握主角的器魂感知能力",
        "- 不得在渡劫场景使用破折号",
      ].join("\n"),
      majorRole: {
        name: "林辞",
        content: [
          "## 当前现状",
          "林辞是青云宗最底层的杂役弟子，灵根几近于无。",
          "",
          "## 特殊",
          "他天生能听到器物的低语，无需唤醒仪式便能与器魂沟通——这是全世界独一份的异能。",
          "",
          "## 成长路径",
          "从杂役一步步走向器道宗师。",
        ].join("\n"),
      },
    },
    expect: {
      worldRuleKeywords: ["灵气", "寿元", "器魂", "渡劫"],
      prohibitionKeywords: ["现代科技", "器魂感知", "破折号"],
      protagonistExceptionKeyword: "器物",
      worldRuleRecallFloor: 0.75,
      prohibitionRecallFloor: 0.75,
    },
  },
  {
    name: "English foundation with Iron Laws / Prohibitions / Special headings",
    foundation: {
      storyFrame: [
        "# Story Frame",
        "",
        "## Theme",
        "A late age of magic where mana is running dry.",
        "",
        "## Iron Laws",
        "- Mana never regenerates once a ley line is severed",
        "- Every spell burns lifespan proportional to its power",
        "- A bound relic answers only its first wielder for life",
        "- Crossing a realm boundary requires surviving a tribulation",
      ].join("\n"),
      bookRules: [
        "## Prohibitions",
        "",
        "- No modern technology terms",
        "- No side character may gain the protagonist's relic-sense",
        "- No em dashes in tribulation scenes",
      ].join("\n"),
      majorRole: {
        name: "Lin",
        content: [
          "## Current Situation",
          "Lin is a lowly outer disciple with almost no spirit root.",
          "",
          "## Special",
          "Lin can hear the whispers of relics and bond with a relic-soul without any awakening ritual — the only one alive who can.",
        ].join("\n"),
      },
    },
    expect: {
      worldRuleKeywords: ["Mana", "lifespan", "relic", "tribulation"],
      prohibitionKeywords: ["modern technology", "relic-sense", "em dashes"],
      protagonistExceptionKeyword: "relic",
      worldRuleRecallFloor: 0.75,
      prohibitionRecallFloor: 0.75,
    },
  },
  {
    name: "Chinese time-loop world with alternate 客观规则 / 本书禁忌 headings",
    foundation: {
      storyFrame: [
        "# 故事框架",
        "",
        "## 主题与基调",
        "一个能有限回溯时间的现代都市。",
        "",
        "## 客观规则",
        "- 时间回溯每次最多七日，超过则记忆崩解",
        "- 同一时间线不能存在两个自己",
        "- 改变过去必然在现在产生等价代偿",
      ].join("\n"),
      bookRules: [
        "## 本书禁忌",
        "",
        "- 不得让主角随意无限回溯",
        "- 不得出现祖父悖论式硬伤",
      ].join("\n"),
      majorRole: {
        name: "沈时",
        content: [
          "## 起点",
          "沈时是普通高中生。",
          "",
          "## 异常",
          "他回溯时能保留全部记忆，不受记忆崩解影响，这是独一无二的体质。",
        ].join("\n"),
      },
    },
    expect: {
      worldRuleKeywords: ["回溯", "时间线", "代偿"],
      prohibitionKeywords: ["无限回溯", "祖父悖论"],
      protagonistExceptionKeyword: "记忆",
      worldRuleRecallFloor: 0.75,
      prohibitionRecallFloor: 0.75,
    },
  },
];

function makeHeuristicAgent(): CanonExtractor {
  const client = {
    provider: "openai",
    apiFormat: "chat",
    stream: false,
    defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  } as unknown as LLMClient;
  const agent = new CanonExtractor({ client, model: "test-model", projectRoot: process.cwd() });
  // Force the deterministic heuristic path — this baseline measures the
  // fallback, which is what runs whenever the LLM is unavailable or junk.
  vi.spyOn(agent as unknown as { chat: (...a: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(
    new Error("no LLM in baseline"),
  );
  return agent;
}

function writeFoundation(bookDir: string, foundation: GoldenFoundation): void {
  const story = join(bookDir, "story");
  mkdirSync(join(story, "outline"), { recursive: true });
  mkdirSync(join(story, "roles", "主要角色"), { recursive: true });
  writeFileSync(join(story, "outline", "story_frame.md"), foundation.storyFrame, "utf-8");
  writeFileSync(join(story, "book_rules.md"), foundation.bookRules, "utf-8");
  writeFileSync(
    join(story, "roles", "主要角色", `${foundation.majorRole.name}.md`),
    foundation.majorRole.content,
    "utf-8",
  );
}

function recall(keywords: string[], claims: readonly CanonClaim[]): number {
  if (keywords.length === 0) return 1;
  const blob = claims.map((c) => c.content).join("\n");
  const hit = keywords.filter((kw) => blob.includes(kw)).length;
  return hit / keywords.length;
}

describe("CanonExtractor heuristic extraction quality baseline", () => {
  for (const testCase of GOLDEN_CORPUS) {
    describe(testCase.name, () => {
      it("recovers world rules, prohibitions, and the protagonist exception above the recall floor", async () => {
        const tmp = mkdtempSync(join(tmpdir(), "inkos-canon-quality-"));
        try {
          writeFoundation(tmp, testCase.foundation);
          const result = await makeHeuristicAgent().extract(tmp, "zh");
          expect(result.usedFallback).toBe(true);

          const worldRules = result.claims.filter((c) => c.claimType === "objective_rule");
          const prohibitions = result.claims.filter((c) => c.claimType === "prohibition");
          const exceptions = result.claims.filter((c) => c.claimType === "character_exception");

          // Coverage floors — recall, not verbatim match.
          expect(recall(testCase.expect.worldRuleKeywords, worldRules))
            .toBeGreaterThanOrEqual(testCase.expect.worldRuleRecallFloor);
          expect(recall(testCase.expect.prohibitionKeywords, prohibitions))
            .toBeGreaterThanOrEqual(testCase.expect.prohibitionRecallFloor);

          // The protagonist exception must be extracted and carry its keyword.
          expect(exceptions.length).toBeGreaterThan(0);
          expect(exceptions.some((c) => c.content.includes(testCase.expect.protagonistExceptionKeyword)))
            .toBe(true);

          // Hard invariants from the design doc that quality must never trade away:
          // world rules + prohibitions are hard-priority; the protagonist
          // exception is non-generalizable and scoped to the protagonist.
          for (const claim of [...worldRules, ...prohibitions]) {
            expect(claim.authority.priority).toBe("hard");
          }
          for (const exception of exceptions) {
            expect(exception.constraints.nonGeneralizable).toBe(true);
            expect(exception.scope.appliesTo).toContain(testCase.foundation.majorRole.name);
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    });
  }
});
