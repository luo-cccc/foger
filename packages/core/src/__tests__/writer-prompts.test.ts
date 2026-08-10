import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { buildWriterSystemPrompt, buildGoldenOpeningDiscipline } from "../agents/writer-prompts.js";
import { BookRulesSchema } from "../models/book-rules.js";
import { buildWritingMethodologySection } from "../utils/writing-methodology.js";

const BOOK: BookConfig = {
  id: "prompt-book",
  title: "Prompt Book",
  platform: "tomato",
  genre: "other",
  status: "active",
  schemaVersion: "inkos-episode-v2" as const,
  format: "screenplay" as const,
  targetEpisodes: 20,
  episodeDurationSeconds: 90,
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "other",
  name: "综合",
  language: "zh",
  episodeTypes: ["setup", "conflict"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("buildWriterSystemPrompt", () => {
  it("includes screenplay governance blocks in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 输入治理契约");
    expect(prompt).toContain("本集剧情决策来自已编译的 episode memo");
    expect(prompt).toContain("已选上下文只提供事实证据");
    expect(prompt).toContain("漫剧核心规则");
    expect(prompt).toContain("漫剧执行合同");
    expect(prompt).toContain("EPISODE_SCRIPT_JSON");
    expect(prompt).toContain("## 叙事驱动执行");
    expect(prompt).toContain("不擅自增加新反转或新 Hook");
  });

  it("injects the structured comic-drama execution contract (zh)", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK, GENRE, null, "", "", "", undefined, 5, "creative", "zh", "governed",
    );
    expect(prompt).toContain("漫剧执行合同");
    expect(prompt).toContain("EPISODE_SCRIPT_JSON");
    expect(prompt).toContain("并严格写入 EpisodeScript JSON");
    expect(prompt).toContain("不得输出小说散文");
  });

  it("uses the configured episode duration in screenplay constraints", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK, format: "screenplay" as const, episodeDurationSeconds: 105 },
      GENRE,
      null,
      "",
      "",
      "",
      undefined,
      5,
      "creative",
      "zh",
      "governed",
    );
    expect(prompt).toContain("目标 105 秒");
    expect(prompt).toContain("90-135 秒");
  });

  it("requires explicit series resolution evidence in the final episode", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK, format: "screenplay" as const, targetEpisodes: 20, episodeDurationSeconds: 90 },
      GENRE,
      null,
      "",
      "",
      "",
      undefined,
      20,
      "creative",
      "zh",
      "governed",
    );
    expect(prompt).toContain('"seriesResolution"');
    expect(prompt).toContain("主线冲突、主角核心欲望、主要角色弧线和核心关系");
  });

  it("injects the structured comic-drama execution contract in English", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK }, { ...GENRE, language: "en" }, null, "", "", "", undefined, 5, "creative", "en", "governed",
    );
    expect(prompt).toContain("Screenplay execution contract");
    expect(prompt).toContain("EPISODE_SCRIPT_JSON");
    expect(prompt).toContain("## Narrative Drive Execution");
  });

  it("enforces narrative person only when the user explicitly set one (#290)", () => {
    const firstPerson = BookRulesSchema.parse({ narrativePerson: "first" });
    const promptFirst = buildWriterSystemPrompt(
      BOOK, GENRE, firstPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", "zh", "governed",
    );
    expect(promptFirst).toContain("叙事人称（硬约束）");
    expect(promptFirst).toContain("第一人称");

    // Unset → no narrative-person section is imposed (the genre default applies).
    const noPerson = BookRulesSchema.parse({});
    const promptNone = buildWriterSystemPrompt(
      BOOK, GENRE, noPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", "zh", "governed",
    );
    expect(promptNone).not.toContain("叙事人称（硬约束）");
  });

  it("tolerates a stray narrativePerson value (degrades to no constraint, fail-open)", () => {
    const rules = BookRulesSchema.parse({ narrativePerson: "(仅当用户指定)" });
    expect(rules.narrativePerson).toBeUndefined();
  });

  it("keeps length rules out of the system prompt so the user prompt is authoritative", () => {
    const lengthSpec = LengthSpecSchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
      normalizeMode: "none",
    });

    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      "zh",
      "governed",
      lengthSpec,
    );

    expect(prompt).not.toContain("目标字数：2200");
    expect(prompt).not.toContain("允许区间：1900-2500");
    expect(prompt).not.toContain("正文不少于2200字");
  });

  it("keeps hard guardrails and book/style constraints in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules\n\n- Do not reveal the mastermind.",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 漫剧核心规则");
    expect(prompt).toContain("## 漫剧执行合同");
    expect(prompt).toContain("Do not reveal the mastermind");
    expect(prompt).toContain("Keep the prose restrained");
  });

  it("omits the duplicated built-in methodology but keeps custom style guidance", () => {
    const methodology = buildWritingMethodologySection("zh");
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      `# 本书文风\n\n- 冷静克制。\n\n${methodology}`,
      undefined,
      3,
      "creative",
      "zh",
      "governed",
    );

    expect(prompt).toContain("冷静克制");
    expect(prompt).not.toContain("写作方法论参考（完整版）");
    expect(prompt).not.toContain("六步走人物心理分析");
  });

  it("keeps the full methodology for legacy prompts", () => {
    const methodology = buildWritingMethodologySection("zh");
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      methodology,
      undefined,
      3,
      "creative",
      "zh",
      "legacy",
    );

    expect(prompt).toContain("写作方法论参考（完整版）");
  });

  it("keeps screenplay prompts focused on executable visual beats (zh)", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      3,
      "creative",
      "zh",
      "governed",
    );

    expect(prompt).toContain("每个镜头都必须可制作");
    expect(prompt).toContain("心理活动必须外化");
    expect(prompt).not.toContain("## 创作宪法");
  });

  it("keeps screenplay prompts focused on executable visual beats (en)", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK, language: "en" },
      { ...GENRE, language: "en", name: "General" },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      3,
      "creative",
      "en",
      "governed",
    );

    expect(prompt).toContain("Make every shot producible");
    expect(prompt).toContain("Convert inner thought into behavior");
    expect(prompt).not.toContain("## Creative Constitution");
  });

  it("keeps the opening hook contract available to every episode", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        GENRE,
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        "zh",
        "governed",
      );
      expect(prompt).toContain("openingHook");
      expect(prompt).toContain("前 3-5 秒");
    }
  });

  it("keeps the opening hook contract available in English", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        { ...GENRE, language: "en", name: "General" },
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        "en",
        "governed",
      );
      expect(prompt).toContain("openingHook");
      expect(prompt).toContain("first 3-5 seconds");
    }
  });

  it("does not reintroduce novel golden-episode prose for later episodes", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", "zh", "governed",
    );
    expect(zh).not.toContain("黄金三章写作纪律");

    const en = buildWriterSystemPrompt(
      BOOK, { ...GENRE, language: "en", name: "General" }, null,
      "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", "en", "governed",
    );
    expect(en).not.toContain("Golden Opening Discipline");
  });

  it("renders golden opening discipline as cohesive prose, not a checklist", () => {
    const out = buildGoldenOpeningDiscipline(1, "zh");
    // Header line is allowed; body must not contain enumerated/bulleted lines.
    expect(out).not.toMatch(/^\s*1\.\s/m);
    expect(out).not.toMatch(/^\s*-\s/m);
    expect(out).not.toMatch(/^\s*\*\s/m);
    // Carries the load-bearing slot constraints.
    expect(out).toContain("手机第一页");
    expect(out).toContain("最多两个聚焦场景");
    expect(out).toContain("通过动作带出");
    expect(out).toContain("memo 指定的 hook");
  });

  it("buildGoldenOpeningDiscipline returns empty string for ch>=4 / undefined", () => {
    expect(buildGoldenOpeningDiscipline(4, "zh")).toBe("");
    expect(buildGoldenOpeningDiscipline(99, "en")).toBe("");
    expect(buildGoldenOpeningDiscipline(undefined, "zh")).toBe("");
  });

  it("tells governed English prompts to obey variance briefs and include resistance-bearing exchanges", () => {
    const prompt = buildWriterSystemPrompt(
      {
        ...BOOK,
        language: "en",
      },
      {
        ...GENRE,
        language: "en",
        name: "General",
      },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      "en",
      "governed",
    );

    expect(prompt).toContain("English Variance Brief");
    expect(prompt).toContain("resistance-bearing exchange");
  });

  it("uses the configured Episode v2 duration", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK, episodeDurationSeconds: 90 },
      GENRE,
      null,
      "",
      "",
      "",
      undefined,
      5,
      "creative",
      "en",
      "governed",
    );

    expect(prompt).toContain("about 90 seconds");
    expect(prompt).not.toContain("undefined seconds");
    expect(prompt).not.toContain("NaN");
  });

  it("localizes genre, protagonist, book-rule, and style-fingerprint blocks for English books", () => {
    const rules = BookRulesSchema.parse({
      protagonist: {
        name: "Mara",
        personalityLock: ["loyal"],
        behavioralConstraints: ["never lies"],
      },
      prohibitions: ["no deus ex machina"],
    });
    const prompt = buildWriterSystemPrompt(
      { ...BOOK },
      { ...GENRE, language: "en", name: "General" },
      rules,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      "fingerprint-text",
      5,
      "creative",
      "en",
      "governed",
    );

    expect(prompt).toContain("## Genre rules (General)");
    expect(prompt).toContain("## Protagonist Lock (Mara)");
    expect(prompt).toContain("## Book-Specific Rules");
    expect(prompt).toContain("## Style Fingerprint (imitation target)");
    expect(prompt).not.toContain("题材规范");
    expect(prompt).not.toContain("主角铁律");
    expect(prompt).not.toContain("本书专属规则");
    expect(prompt).not.toContain("文风指纹");
  });

  it("includes dialogue technique failure conditions and the long-speech rule (zh + en)", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "", "", "", undefined, 5, "creative", "zh", "governed",
    );
    // P1-1 (dialogue-craft reverse condition table, craft_default tone)
    expect(zh).toContain("## 对白手法的失效条件");
    expect(zh).toContain("没有隐瞒理由时就直说");
    expect(zh).toContain("沉默必须有可见对象");
    expect(zh).toContain("临时发明的挡箭牌");
    // P1-2a (SCR-09: break long speeches only at agenda turns)
    expect(zh).toContain("长发言只在议程转折处用动作行断开");
    expect(zh).toContain("动作写进 action 字段");

    const en = buildWriterSystemPrompt(
      { ...BOOK }, { ...GENRE, language: "en", name: "General" }, null,
      "", "", "", undefined, 5, "creative", "en", "governed",
    );
    expect(en).toContain("## Dialogue technique failure conditions");
    expect(en).toContain("no reason to conceal");
    expect(en).toContain("Silence: silence must have a visible object");
    expect(en).toContain("freshly invented excuse");
    expect(en).toContain("broken by an action beat only at an agenda turn");
    expect(en).toContain("physical action belongs in the action field");
  });

  it("uses episode wording in the zh scaffold and adds English full-cast tracking", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "", "", "", undefined, 5, "creative", "zh", "governed",
    );
    expect(zh).toContain("本集记录");
    expect(zh).not.toContain("本章记录");

    const rules = BookRulesSchema.parse({ enableFullCastTracking: true });
    const en = buildWriterSystemPrompt(
      { ...BOOK }, { ...GENRE, language: "en" }, rules, "", "", "", undefined, 5, "creative", "en", "governed",
    );
    expect(en).toContain("## Full Cast Tracking");
  });
});
