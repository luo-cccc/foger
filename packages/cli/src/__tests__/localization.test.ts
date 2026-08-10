import { describe, expect, it } from "vitest";
import {
  formatAutoWriteAlreadyComplete,
  formatAutoWriteStart,
  formatBookCreateCreating,
  formatBookCreateCreated,
  formatBookCreateNextStep,
  formatEpisodeRecoveryNotice,
  formatDoctorHintBaseUrl,
  formatDoctorHintInvalidApiKey,
  formatDoctorHintModelName,
  formatDoctorHintOpenAiProbeExhausted,
  formatDoctorHintQuota,
  formatDoctorHintStreamRequirement,
  formatImportCanonComplete,
  formatImportCanonStart,
  formatImportEpisodesComplete,
  formatImportEpisodesDiscovery,
  formatImportEpisodesResume,
  formatListModelsEmpty,
  formatListModelsHeader,
  formatWriteNextComplete,
  formatWriteNextProgress,
  formatWriteNextResultLines,
  resolveCliLanguage,
} from "../localization.js";

const CHINESE_CHARS = /[一-鿿]/;

describe("CLI localization", () => {
  it("formats book-create summaries in both languages", () => {
    expect(formatBookCreateCreating("zh", "山河", "xuanhuan", "tomato"))
      .toBe('创建书籍 "山河"（xuanhuan / tomato）...');
    expect(formatBookCreateCreated("zh", "shan-he")).toBe("已创建书籍：shan-he");
    expect(formatBookCreateNextStep("zh", "shan-he")).toBe("下一步：inkos write next shan-he");

    expect(formatBookCreateCreating("en", "Harbor", "other", "other"))
      .toBe('Creating book "Harbor" (other / other)...');
    expect(formatBookCreateCreated("en", "harbor")).toBe("Book created: harbor");
    expect(formatBookCreateNextStep("en", "harbor")).toBe("Next: inkos write next harbor");
  });

  it("formats write-next progress and result summaries in both languages", () => {
    expect(formatWriteNextProgress("zh", 1, 2, "shan-he"))
      .toBe('[1/2] 为「shan-he」撰写剧集...');
    expect(formatWriteNextComplete("zh")).toBe("完成。");
    expect(formatWriteNextResultLines("zh", {
      episodeNumber: 3,
      title: "风雪夜",
      episodeDurationSeconds: 90,
      status: "ready-for-review",
      revised: true,
      issues: [],
      auditPassed: true,
    })).toEqual([
      "  第3集：风雪夜",
      "  时长：90s",
      "  审计：通过",
      "  自动修正：已执行（已修复关键问题）",
      "  状态：ready-for-review",
    ]);

    expect(formatWriteNextProgress("en", 2, 3, "harbor"))
      .toBe('[2/3] Writing episode for "harbor"...');
    expect(formatWriteNextComplete("en")).toBe("Done.");
    expect(formatWriteNextResultLines("en", {
      episodeNumber: 4,
      title: "Cold Harbor",
      episodeDurationSeconds: 105,
      status: "audit-failed",
      revised: false,
      issues: [{ severity: "critical", category: "continuity", description: "Mismatch" }],
      auditPassed: false,
    })).toEqual([
      "  Episode 4: Cold Harbor",
      "  Duration: 105s",
      "  Audit: NEEDS REVIEW",
      "  Status: audit-failed",
      "  Issues:",
      "    [critical] continuity: Mismatch",
    ]);
  });

  it("explains episode persistence recovery in terminal output", () => {
    expect(formatEpisodeRecoveryNotice("en", {
      kind: "rolled-back",
      episodeNumber: 4,
      rolledBackTo: 3,
    })).toBe("Recovered an incomplete episode 4 write and rolled back to episode 3 before continuing.");
    expect(formatEpisodeRecoveryNotice("en", {
      kind: "committed-cleanup",
      episodeNumber: 5,
    })).toBe("Cleared the recovery marker left by the committed episode 5 write.");
    expect(formatEpisodeRecoveryNotice("zh", {
      kind: "rolled-back",
      episodeNumber: 4,
      rolledBackTo: 3,
    })).toContain("4");
    expect(formatEpisodeRecoveryNotice("en", undefined)).toBeNull();
  });

  it("formats auto-write banners in both languages", () => {
    expect(formatAutoWriteStart("zh", "shan-he", 3, 10))
      .toBe("自动写作「shan-he」：从第3集连续写到第10集...");
    expect(formatAutoWriteAlreadyComplete("zh", "shan-he", 12, 10))
      .toBe("「shan-he」已写到第12集（目标第10集），无需继续。");

    expect(formatAutoWriteStart("en", "harbor", 3, 10))
      .toBe('Auto-writing "harbor": episode 3 through episode 10...');
    expect(formatAutoWriteAlreadyComplete("en", "harbor", 12, 10))
      .toBe('"harbor" already has 12 episode(s) written (target: episode 10). Nothing to do.');
  });

  it("formats import summaries with language-specific units and action hints", () => {
    expect(formatImportEpisodesDiscovery("zh", 12, "shan-he"))
      .toBe('发现 12 集，准备导入到「shan-he」。');
    expect(formatImportEpisodesResume("zh", 5)).toBe("从第 5 集继续导入。");
    expect(formatImportEpisodesComplete("zh", {
      importedCount: 8,
      totalDurationSeconds: 540,
      nextEpisode: 13,
      continueBookId: "shan-he",
    })).toEqual([
      "导入完成：",
      "  已导入剧集：8",
      "  总时长：540s",
      "  下一集编号：13",
      "",
      '运行 "inkos write next shan-he" 继续写作。',
    ]);

    expect(formatImportEpisodesDiscovery("en", 10, "harbor"))
      .toBe('Found 10 episodes to import into "harbor".');
    expect(formatImportEpisodesResume("en", 6)).toBe("Resuming from episode 6.");
    expect(formatImportEpisodesComplete("en", {
      importedCount: 10,
      totalDurationSeconds: 900,
      nextEpisode: 11,
      continueBookId: "harbor",
    })).toEqual([
      "Import complete:",
      "  Episodes imported: 10",
      "  Total duration: 900s",
      "  Next episode number: 11",
      "",
      'Run "inkos write next harbor" to continue writing.',
    ]);
  });

  it("formats import-canon prompts in both languages", () => {
    expect(formatImportCanonStart("zh", "parent-book", "target-book"))
      .toBe('把 "parent-book" 的正典导入到 "target-book"...');
    expect(formatImportCanonComplete("zh")).toEqual([
      "正典已导入：story/parent_canon.md",
      "Writer 和 auditor 会在番外模式下自动识别这个文件。",
    ]);

    expect(formatImportCanonStart("en", "parent-book", "target-book"))
      .toBe('Importing canon from "parent-book" into "target-book"...');
    expect(formatImportCanonComplete("en")).toEqual([
      "Canon imported: story/parent_canon.md",
      "Writer and auditor will auto-detect this file for spinoff mode.",
    ]);
  });
});

describe("resolveCliLanguage environment fallback", () => {
  it("prefers the explicit language over any environment variable", () => {
    expect(resolveCliLanguage("en", { INKOS_LOCALE: "zh_CN" })).toBe("en");
    expect(resolveCliLanguage("zh", { INKOS_LOCALE: "en", LANG: "en_US.UTF-8" })).toBe("zh");
  });

  it("reads INKOS_LOCALE before the system locale variables", () => {
    expect(resolveCliLanguage(undefined, { INKOS_LOCALE: "en", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(resolveCliLanguage(undefined, { INKOS_LOCALE: "zh-CN", LC_ALL: "en_US.UTF-8" })).toBe("zh");
  });

  it("falls back to LC_ALL, then LC_MESSAGES, then LANG", () => {
    expect(resolveCliLanguage(undefined, { LC_ALL: "en_US.UTF-8" })).toBe("en");
    expect(resolveCliLanguage(undefined, { LC_MESSAGES: "en_GB.UTF-8" })).toBe("en");
    expect(resolveCliLanguage(undefined, { LANG: "en_US.UTF-8" })).toBe("en");
    expect(resolveCliLanguage(undefined, { LANG: "zh_CN.UTF-8" })).toBe("zh");
  });

  it("lets an unrecognized explicit language fall through to the environment", () => {
    expect(resolveCliLanguage("fr", { LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("defaults to zh when nothing is set or the locale is unrecognized", () => {
    expect(resolveCliLanguage(undefined, {})).toBe("zh");
    expect(resolveCliLanguage(undefined, { LANG: "C" })).toBe("zh");
    expect(resolveCliLanguage("fr", {})).toBe("zh");
  });
});

describe("config list-models localization", () => {
  it("formats the empty-result error in both languages", () => {
    expect(formatListModelsEmpty("zh", "deepseek"))
      .toBe("deepseek 没有可用模型（可能需要 --api-key 和 --base-url）");
    expect(formatListModelsEmpty("en", "deepseek"))
      .toBe("No models available for deepseek (you may need --api-key and --base-url)");
  });

  it("formats the model-count header in both languages", () => {
    expect(formatListModelsHeader("zh", "deepseek", 3)).toBe("deepseek：3 个模型");
    expect(formatListModelsHeader("en", "deepseek", 3)).toBe("deepseek: 3 model(s)");
  });
});

describe("doctor hint localization", () => {
  it("keeps the original Chinese hints for zh", () => {
    expect(formatDoctorHintQuota("zh"))
      .toBe("检查 API Key 是否正确、模型是否可用，以及账号余额或配额是否足够。");
    expect(formatDoctorHintBaseUrl("zh")).toContain("INKOS_LLM_BASE_URL");
    expect(formatDoctorHintStreamRequirement("zh")).toContain("stream");
    expect(formatDoctorHintModelName("zh")).toContain("INKOS_LLM_MODEL");
    expect(formatDoctorHintInvalidApiKey("zh")).toContain("INKOS_LLM_API_KEY");
    expect(formatDoctorHintOpenAiProbeExhausted("zh")).toContain("chat/responses");
  });

  it("emits pure English hints for en", () => {
    const hints = [
      formatDoctorHintQuota("en"),
      formatDoctorHintOpenAiProbeExhausted("en"),
      formatDoctorHintBaseUrl("en"),
      formatDoctorHintStreamRequirement("en"),
      formatDoctorHintModelName("en"),
      formatDoctorHintInvalidApiKey("en"),
    ];
    for (const hint of hints) {
      expect(hint).not.toMatch(CHINESE_CHARS);
    }
    expect(formatDoctorHintBaseUrl("en")).toContain("INKOS_LLM_BASE_URL");
    expect(formatDoctorHintModelName("en")).toContain("INKOS_LLM_MODEL");
    expect(formatDoctorHintInvalidApiKey("en")).toContain("INKOS_LLM_API_KEY");
    expect(formatDoctorHintStreamRequirement("en")).toContain("stream=true");
  });
});
