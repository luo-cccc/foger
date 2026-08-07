import type { GenreProfile } from "../models/genre-profile.js";
import type { LengthCountingMode } from "../models/length-governance.js";
import type { WriteChapterOutput } from "./writer.js";
import { countChapterLength } from "../utils/length-metrics.js";
import {
  parseEpisodeScriptOutput,
  renderEpisodeScriptMarkdown,
  type EpisodeScript,
  measureEpisodeScript,
} from "../models/episode-script.js";

export interface CreativeOutput {
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly preWriteCheck: string;
  readonly episodeScript?: EpisodeScript;
  readonly episodeScriptMetrics?: ReturnType<typeof measureEpisodeScript>;
}

export function parseCreativeOutput(
  chapterNumber: number,
  content: string,
  countingMode: LengthCountingMode = "zh_chars",
  targetDurationSeconds = 90,
): CreativeOutput {
  const structured = tryParseEpisodeScript(content, chapterNumber);
  if (structured) {
    const script = structured.script;
    const metrics = measureEpisodeScript(script, targetDurationSeconds);
    return {
      title: script.title,
      content: renderEpisodeScriptMarkdown(script),
      // Keep the historical field populated for index compatibility, but use
      // spoken/narrated characters as the screenplay content measure rather
      // than counting Markdown formatting and shot metadata as prose words.
      wordCount: metrics.spokenCharacters + metrics.narrationCharacters,
      preWriteCheck: extractTag(content, "PRE_WRITE_CHECK"),
      episodeScript: script,
      episodeScriptMetrics: metrics,
    };
  }

  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  let chapterContent = extract("CHAPTER_CONTENT");

  // Fallback: if === TAG === parsing fails (common with local/small models),
  // try to extract usable content from the raw output
  if (!chapterContent) {
    chapterContent = fallbackExtractContent(content, countingMode);
  }

  let title = extract("CHAPTER_TITLE");
  if (!title) {
    title = fallbackExtractTitle(content, chapterNumber, countingMode);
  }
  title = normalizeChapterTitle(title, chapterNumber, countingMode);

  return {
    title,
    content: chapterContent,
    wordCount: countChapterLength(chapterContent, countingMode),
    preWriteCheck: extract("PRE_WRITE_CHECK"),
  };
}

function extractTag(content: string, tag: string): string {
  const regex = new RegExp(
    `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
  );
  return content.match(regex)?.[1]?.trim() ?? "";
}

function tryParseEpisodeScript(
  content: string,
  chapterNumber: number,
): { readonly script: EpisodeScript } | undefined {
  const hasStructuredMarker = /===\s*EPISODE_SCRIPT_JSON\s*===/i.test(content);
  const hasJsonFence = /```json\s*\{/i.test(content);
  const hasEmbeddedJson = /<!--\s*inkos-episode-script-json/i.test(content);
  if (!hasStructuredMarker && !hasJsonFence && !hasEmbeddedJson) return undefined;
  try {
    return { script: parseEpisodeScriptOutput(content, chapterNumber) };
  } catch (error) {
    throw new Error(`漫剧分镜稿解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fallback content extraction when === CHAPTER_CONTENT === tag is missing.
 * Tries common patterns from local/small models, then falls back to
 * stripping metadata and returning the longest prose block.
 */
function fallbackExtractContent(raw: string, countingMode: LengthCountingMode): string {
  // Try markdown heading: # 第N章 / # 第五章 ... followed by content
  const headingMatch = raw.match(/^#\s*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*章[^\n]*\n+([\s\S]+)/m);
  if (headingMatch) {
    return headingMatch[1]!.trim();
  }

  if (countingMode === "en_words") {
    const englishHeadingMatch = raw.match(/^#\s*Chapter\s+\d+(?::|\s+)([^\n]*)\n+([\s\S]+)/im);
    if (englishHeadingMatch) {
      return englishHeadingMatch[2]!.trim();
    }
  }

  // Try "正文" or "内容" labeled section
  const labelMatch = raw.match(/(?:正文|内容|章节内容)[：:]\s*\n+([\s\S]+)/);
  if (labelMatch) {
    return labelMatch[1]!.trim();
  }

  if (countingMode === "en_words") {
    const englishLabelMatch = raw.match(/(?:content|chapter content)[：:]\s*\n+([\s\S]+)/i);
    if (englishLabelMatch) {
      return englishLabelMatch[1]!.trim();
    }
  }

  // Last resort: strip lines that look like metadata/tags, keep the rest
  const lines = raw.split("\n");
  const proseLines = lines.filter((line) => {
    const trimmed = line.trim();
    // Skip tag-like lines, empty lines at boundaries, and short key-value lines
    if (/^===\s*[A-Z_]+\s*===/.test(trimmed)) return false;
    if (/^(PRE_WRITE_CHECK|CHAPTER_TITLE|章节标题|写作自检)[：:]/.test(trimmed)) return false;
    return true;
  });
  const result = proseLines.join("\n").trim();
  // Only use fallback if we got meaningful content (>100 chars)
  return result.length > 100 ? result : "";
}

/**
 * Fallback title extraction when === CHAPTER_TITLE === tag is missing.
 */
function fallbackExtractTitle(
  raw: string,
  chapterNumber: number,
  countingMode: LengthCountingMode,
): string {
  // Try: # 第N章 Title / # 第五章 Title
  const headingMatch = raw.match(/^#\s*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*章\s*(.+)/m);
  if (headingMatch) {
    return headingMatch[1]!.trim();
  }
  if (countingMode === "en_words") {
    const englishHeadingMatch = raw.match(/^#\s*Chapter\s+\d+(?::|\s+)\s*(.+)/im);
    if (englishHeadingMatch) {
      return englishHeadingMatch[1]!.trim();
    }
  }
  // Try: 章节标题：Title or CHAPTER_TITLE: Title (without === delimiters)
  const labelMatch = raw.match(/(?:章节标题|CHAPTER_TITLE)[：:]\s*(.+)/);
  if (labelMatch) {
    return labelMatch[1]!.trim();
  }
  return defaultChapterTitle(chapterNumber, countingMode);
}

export type ParsedWriterOutput = Omit<WriteChapterOutput, "postWriteErrors" | "postWriteWarnings">;

/**
 * Parse LLM output that uses === TAG === delimiters into structured chapter data.
 * Shared by WriterAgent (writing new chapters) and ChapterAnalyzerAgent (analyzing existing chapters).
 */
export function parseWriterOutput(
  chapterNumber: number,
  content: string,
  genreProfile: GenreProfile,
  countingMode: LengthCountingMode = "zh_chars",
): ParsedWriterOutput {
  const extract = (tag: string): string => {
    const regex = new RegExp(
      `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
    );
    const match = content.match(regex);
    return match?.[1]?.trim() ?? "";
  };

  const chapterContent = extract("CHAPTER_CONTENT");
  const title = normalizeChapterTitle(
    extract("CHAPTER_TITLE") || defaultChapterTitle(chapterNumber, countingMode),
    chapterNumber,
    countingMode,
  );

  return {
    chapterNumber,
    title,
    content: chapterContent,
    wordCount: countChapterLength(chapterContent, countingMode),
    preWriteCheck: extract("PRE_WRITE_CHECK"),
    postSettlement: extract("POST_SETTLEMENT"),
    updatedState: extract("UPDATED_STATE") || defaultStatePlaceholder(countingMode),
    updatedLedger: genreProfile.numericalSystem
      ? (extract("UPDATED_LEDGER") || defaultLedgerPlaceholder(countingMode))
      : "",
    updatedHooks: extract("UPDATED_HOOKS") || defaultHooksPlaceholder(countingMode),
    chapterSummary: extract("CHAPTER_SUMMARY"),
    updatedSubplots: extract("UPDATED_SUBPLOTS"),
    updatedEmotionalArcs: extract("UPDATED_EMOTIONAL_ARCS"),
    updatedCharacterMatrix: extract("UPDATED_CHARACTER_MATRIX"),
  };
}

export function normalizeChapterTitle(
  title: string,
  chapterNumber: number,
  countingMode: LengthCountingMode = "zh_chars",
): string {
  const trimmed = title.trim().replace(/^#{1,6}\s*/u, "");
  const prefix = countingMode === "en_words"
    ? new RegExp(`^Chapter\\s+${chapterNumber}(?:(?::|[\\s\\-–—])+|$)`, "iu")
    : /^第\s*[零〇一二三四五六七八九十百千万两\d]+\s*章(?:(?:[：:\s\-–—])+|$)/u;
  const hadPrefix = prefix.test(trimmed);
  const withoutPrefix = trimmed.replace(prefix, "").trim();
  if (withoutPrefix) return withoutPrefix;
  if (hadPrefix) return defaultChapterTitle(chapterNumber, countingMode);
  return trimmed || defaultChapterTitle(chapterNumber, countingMode);
}

function defaultChapterTitle(
  chapterNumber: number,
  countingMode: LengthCountingMode,
): string {
  return countingMode === "en_words" ? `Chapter ${chapterNumber}` : `第${chapterNumber}章`;
}

function defaultStatePlaceholder(countingMode: LengthCountingMode): string {
  return countingMode === "en_words" ? "(state card not updated)" : "(状态卡未更新)";
}

function defaultLedgerPlaceholder(countingMode: LengthCountingMode): string {
  return countingMode === "en_words" ? "(ledger not updated)" : "(账本未更新)";
}

function defaultHooksPlaceholder(countingMode: LengthCountingMode): string {
  return countingMode === "en_words" ? "(hooks pool not updated)" : "(伏笔池未更新)";
}
