import { describe, expect, it } from "vitest";
import {
  formatImportCompletionLines,
  formatImportDiscoveryLine,
  formatImportResumeLine,
  formatWriteCompletionLines,
  formatWriteDoneLine,
  formatWriteStartLine,
} from "../progress-text.js";

describe("CLI progress text", () => {
  it("formats Chinese write progress lines", () => {
    expect(formatWriteStartLine("zh", 1, 3, "demo-book")).toBe('[1/3] 为「demo-book」撰写剧集...');
    expect(formatWriteCompletionLines("zh", {
      episodeNumber: 7,
      title: "潮声夜渡",
      episodeDurationSeconds: 95,
      passedAudit: false,
      revised: true,
      status: "audit-failed",
      issues: [
        { severity: "warning", category: "continuity", description: "时间线略有跳变" },
      ],
    })).toEqual([
      "  第7集：潮声夜渡",
      "  时长：95s",
      "  审计：需复核",
      "  自动修正：已执行（已修复关键问题）",
      "  状态：audit-failed",
      "  问题：",
      "    [warning] continuity: 时间线略有跳变",
      "",
    ]);
    expect(formatWriteDoneLine("zh")).toBe("完成。");
  });

  it("formats English write progress lines", () => {
    expect(formatWriteStartLine("en", 2, 5, "demo-book")).toBe('[2/5] Writing episode for "demo-book"...');
    expect(formatWriteCompletionLines("en", {
      episodeNumber: 7,
      title: "Harbor Wake",
      episodeDurationSeconds: 90,
      passedAudit: true,
      revised: false,
      status: "ready-for-review",
      issues: [],
    })).toEqual([
      "  Episode 7: Harbor Wake",
      "  Duration: 90s",
      "  Audit: PASSED",
      "  Status: ready-for-review",
      "",
    ]);
    expect(formatWriteDoneLine("en")).toBe("Done.");
  });

  it("formats Chinese import progress lines", () => {
    expect(formatImportDiscoveryLine("zh", 12, "demo-book")).toBe('发现 12 集，准备导入到「demo-book」。');
    expect(formatImportResumeLine("zh", 8)).toBe("从第 8 集继续导入。");
    expect(formatImportCompletionLines("zh", {
      importedCount: 12,
      totalCountLabel: "1080s",
      nextEpisode: 13,
      bookId: "demo-book",
    })).toEqual([
      "导入完成：",
      "  已导入剧集：12",
      "  总时长：1080s",
      "  下一集编号：13",
      '',
      '运行 "inkos write next demo-book" 继续写作。',
    ]);
  });

  it("formats English import progress lines", () => {
    expect(formatImportDiscoveryLine("en", 12, "demo-book")).toBe('Found 12 episodes to import into "demo-book".');
    expect(formatImportResumeLine("en", 8)).toBe("Resuming from episode 8.");
    expect(formatImportCompletionLines("en", {
      importedCount: 12,
      totalCountLabel: "1080s",
      nextEpisode: 13,
      bookId: "demo-book",
    })).toEqual([
      "Import complete:",
      "  Episodes imported: 12",
      "  Total length: 1080s",
      "  Next episode number: 13",
      '',
      'Run "inkos write next demo-book" to continue writing.',
    ]);
  });
});
