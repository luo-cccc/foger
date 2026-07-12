import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { ContextPackage } from "../models/input-governance.js";
import { WriterAgent } from "../agents/writer.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import {
  PLANNER_MEMO_SYSTEM_PROMPT,
  PLANNER_MEMO_SYSTEM_PROMPT_EN,
} from "../agents/planner-prompts.js";
import { estimateTextTokens } from "../llm/provider.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { getContextSourceTier } from "../utils/context-assembly.js";

const BOOK: BookConfig = {
  id: "prompt-gate-book",
  title: "Prompt Gate Book",
  platform: "tomato",
  genre: "other",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 3000,
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

const ZH_GENRE: GenreProfile = {
  id: "other",
  name: "综合",
  language: "zh",
  chapterTypes: ["setup", "conflict"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

const BEFORE = {
  writerZhOpening: { chars: 8693, estimatedTokens: 6422 },
  writerZhNormal: { chars: 7476, estimatedTokens: 5452 },
  writerEnOpening: { chars: 18104, estimatedTokens: 4584 },
} as const;

function buildSystemPrompt(language: "zh" | "en", chapterNumber: number): string {
  return buildWriterSystemPrompt(
    BOOK,
    language === "en" ? { ...ZH_GENRE, language: "en" } : ZH_GENRE,
    null,
    "# Book Rules",
    "# Genre Body",
    "# Style Guide\n\nKeep the prose restrained.",
    undefined,
    chapterNumber,
    "creative",
    language,
    "governed",
  );
}

function expectCostReduction(
  prompt: string,
  baseline: { readonly chars: number; readonly estimatedTokens: number },
): void {
  expect(prompt.length).toBeLessThan(Math.floor(baseline.chars * 0.85));
  expect(estimateTextTokens(prompt)).toBeLessThan(Math.floor(baseline.estimatedTokens * 0.85));
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

describe("prompt optimization fixed-corpus gate", () => {
  it("keeps Writer system prompts at least 15% below the recorded baseline", () => {
    const zhOpening = buildSystemPrompt("zh", 1);
    const zhNormal = buildSystemPrompt("zh", 4);
    const enOpening = buildSystemPrompt("en", 1);

    expectCostReduction(zhOpening, BEFORE.writerZhOpening);
    expectCostReduction(zhNormal, BEFORE.writerZhNormal);
    expectCostReduction(enOpening, BEFORE.writerEnOpening);

    expect(zhOpening).toContain("黄金三章写作纪律");
    expect(zhOpening).toContain("Planner 负责决定“本章发生什么”");
    expect(zhOpening).toContain("章尾改变");
    expect(zhOpening).toContain("Hook 执行");
    expect(zhOpening).toContain("=== CHAPTER_CONTENT ===");
    expect(zhOpening).not.toContain("黄金3章");
    expect(zhOpening).not.toContain("目标字数：3000");

    expect(enOpening).toContain("The planner owns plot decisions");
    expect(enOpening).toContain("Required end change");
    expect(enOpening).toContain("Hook execution");
    expect(enOpening).toContain("Output only the three blocks above");
    expect(enOpening).not.toContain("Real hook_id");
    expect(enOpening).not.toContain("Target length: 3000 words");
  });

  it("keeps Planner responsible for decisions while Writer owns prose execution", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("你不写正文");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 卷级 KR 绑定");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 不要做");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("You do NOT write prose");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("## Volume KR binding");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("## Do not");
  });

  it("removes duplicated governed context without dropping quality contracts", () => {
    const contextPackage: ContextPackage = {
      chapter: 7,
      selectedContext: [
        {
          source: "runtime/chapter_memo",
          reason: "Planner memo",
          excerpt: "CHAPTER_TASK_REQUIRED",
        },
        {
          source: "story/author_intent.md",
          reason: "Long-term author direction",
          excerpt: "DIRECT_USER_REQUIREMENT",
        },
        {
          source: "story/current_focus.md",
          reason: "Current author focus",
          excerpt: "SHORT_TERM_DIRECTION",
        },
        {
          source: "story/current_state.md#current-conflict",
          reason: "Structured state fact",
          excerpt: "STRUCTURED_STATE_FACT_ONLY_ONCE",
        },
        {
          source: "story/pending_hooks.md#mentor-oath",
          reason: "Selected hook",
          excerpt: "HOOK_EVIDENCE_PROMISE",
        },
        {
          source: "story/chapter_summaries.md#recent_titles",
          reason: "Avoid title repetition",
          excerpt: "TITLE_HISTORY_ONLY_ONCE",
        },
        {
          source: "story/chapter_summaries.md#recent_mood_type_trail",
          reason: "Avoid rhythm repetition",
          excerpt: "MOOD_TRAIL_ONLY_ONCE",
        },
        {
          source: "story/chapter_summaries.md#6",
          reason: "Recent causal event",
          excerpt: "SUMMARY_EVIDENCE_ONLY_ONCE",
        },
        {
          source: "story/parent_canon.md",
          reason: "Canon boundary",
          excerpt: "CANON_ONLY_ONCE",
        },
      ],
    };
    const evidenceBlocks = buildGovernedMemoryEvidenceBlocks(contextPackage, "en");
    const selectedEvidenceBlock = [
      evidenceBlocks.titleHistoryBlock,
      evidenceBlocks.moodTrailBlock,
      evidenceBlocks.canonBlock,
      evidenceBlocks.hookDebtBlock,
      evidenceBlocks.hooksBlock,
      evidenceBlocks.summariesBlock,
      evidenceBlocks.volumeSummariesBlock,
    ].filter((block): block is string => Boolean(block)).join("\n");
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-prompt-optimization-gate",
    });
    const lengthSpec = buildLengthSpec(1200, "en");
    const optimizedPrompt = (agent as unknown as {
      buildGovernedUserPrompt(params: Record<string, unknown>): string;
    }).buildGovernedUserPrompt({
      chapterNumber: 7,
      chapterMemo: {
        chapter: 7,
        goal: "Recover the oath ledger.",
        isGoldenOpening: false,
        body: [
          "## Current task",
          "CHAPTER_TASK_REQUIRED",
          "## Required end-of-chapter change",
          "END_CHANGE_VISIBLE",
          "## Hook ledger for this chapter",
          "advance:",
          "- H007 -> HOOK_EXECUTION_REQUIRED",
          "## Volume KR binding",
          "- KR1 -> VOLUME_KR_MOVEMENT_REQUIRED",
          "## Do not",
          "DO_NOT_REVEAL_CULPRIT",
        ].join("\n"),
        threadRefs: ["H007"],
      },
      contextPackage,
      ruleStack: {
        layers: [],
        sections: {
          hard: ["current_state", "book_rules"],
          soft: ["author_intent", "current_focus"],
          diagnostic: ["continuity_audit"],
        },
        overrideEdges: [],
        activeOverrides: [],
      },
      externalContext: "PER_CHAPTER_USER_INSTRUCTION",
      lengthSpec,
      language: "en",
      selectedEvidenceBlock,
    });

    const requiredOnce = [
      "DIRECT_USER_REQUIREMENT",
      "SHORT_TERM_DIRECTION",
      "CHAPTER_TASK_REQUIRED",
      "DO_NOT_REVEAL_CULPRIT",
      "HOOK_EXECUTION_REQUIRED",
      "END_CHANGE_VISIBLE",
      "VOLUME_KR_MOVEMENT_REQUIRED",
      "STRUCTURED_STATE_FACT_ONLY_ONCE",
      "HOOK_EVIDENCE_PROMISE",
      "TITLE_HISTORY_ONLY_ONCE",
      "MOOD_TRAIL_ONLY_ONCE",
      "SUMMARY_EVIDENCE_ONLY_ONCE",
      "CANON_ONLY_ONCE",
      "PER_CHAPTER_USER_INSTRUCTION",
    ];
    for (const marker of requiredOnce) {
      expect(occurrences(optimizedPrompt, marker), marker).toBe(1);
    }
    expect(optimizedPrompt).not.toContain("FULL_STATE_TABLE_DUPLICATE");
    expect(optimizedPrompt).toContain(`Hard range: ${lengthSpec.hardMin}-${lengthSpec.hardMax} words`);
    expect(optimizedPrompt).toContain("Output only PRE_WRITE_CHECK, CHAPTER_TITLE, and CHAPTER_CONTENT blocks");

    const legacyDuplicatedAssembly = [
      optimizedPrompt,
      contextPackage.selectedContext.map((entry) => entry.excerpt ?? entry.reason).join("\n"),
      "FULL_STATE_TABLE_DUPLICATE\n" + "legacy state row | ".repeat(200),
      "CHAPTER_TASK_REQUIRED\nTITLE_HISTORY_ONLY_ONCE\nMOOD_TRAIL_ONLY_ONCE\nCANON_ONLY_ONCE",
    ].join("\n");
    expect(estimateTextTokens(optimizedPrompt)).toBeLessThan(estimateTextTokens(legacyDuplicatedAssembly));
    expect(occurrences(legacyDuplicatedAssembly, "CHAPTER_TASK_REQUIRED")).toBeGreaterThan(1);
    expect(occurrences(legacyDuplicatedAssembly, "TITLE_HISTORY_ONLY_ONCE")).toBeGreaterThan(1);

    expect(getContextSourceTier("story/author_intent.md")).toBe("verbatim");
    expect(getContextSourceTier("story/current_state.md#current-conflict")).toBe("semantic");
    expect(getContextSourceTier("story/chapter_summaries.md#6")).toBe("compressible");
  });
});
