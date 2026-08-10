import {
  formatImportEpisodesComplete,
  formatImportEpisodesDiscovery,
  formatImportEpisodesResume,
  formatWriteNextComplete,
  formatWriteNextProgress,
  formatWriteNextResultLines,
  type CliLanguage,
} from "./localization.js";

export { type CliLanguage };

export function formatWriteStartLine(
  language: CliLanguage,
  current: number,
  total: number,
  bookId: string,
): string {
  return formatWriteNextProgress(language, current, total, bookId);
}

export function formatWriteCompletionLines(
  language: CliLanguage,
  result: {
    readonly episodeNumber: number;
    readonly title: string;
    readonly episodeDurationSeconds: number;
    readonly passedAudit: boolean;
    readonly revised: boolean;
    readonly status: string;
    readonly issues: ReadonlyArray<{
      readonly severity: string;
      readonly category: string;
      readonly description: string;
    }>;
  },
): string[] {
  return [...formatWriteNextResultLines(language, result), ""];
}

export function formatWriteDoneLine(language: CliLanguage): string {
  return formatWriteNextComplete(language);
}

export function formatImportDiscoveryLine(
  language: CliLanguage,
  episodeCount: number,
  bookId: string,
): string {
  return formatImportEpisodesDiscovery(language, episodeCount, bookId);
}

export function formatImportResumeLine(
  language: CliLanguage,
  resumeFrom: number,
): string {
  return formatImportEpisodesResume(language, resumeFrom);
}

export function formatImportCompletionLines(
  language: CliLanguage,
  result: {
    readonly importedCount: number;
    readonly totalCountLabel: string;
    readonly nextEpisode: number;
    readonly bookId: string;
  },
): string[] {
  return [
    language === "en" ? "Import complete:" : "导入完成：",
    language === "en"
      ? `  Episodes imported: ${result.importedCount}`
      : `  已导入剧集：${result.importedCount}`,
    language === "en"
      ? `  Total length: ${result.totalCountLabel}`
      : `  总时长：${result.totalCountLabel}`,
    language === "en"
      ? `  Next episode number: ${result.nextEpisode}`
      : `  下一集编号：${result.nextEpisode}`,
    "",
    language === "en"
      ? `Run "inkos write next ${result.bookId}" to continue writing.`
      : `运行 "inkos write next ${result.bookId}" 继续写作。`,
  ];
}
