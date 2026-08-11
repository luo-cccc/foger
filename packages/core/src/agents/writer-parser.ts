import type { GenreProfile } from "../models/genre-profile.js";
import type { LengthCountingMode } from "../models/length-governance.js";
import type { WriteEpisodeOutput } from "./writer.js";
import {
  EPISODE_DURATION_TARGET_SECONDS,
  parseEpisodeScriptOutput,
  renderEpisodeScriptMarkdown,
  type EpisodeScript,
  measureEpisodeScript,
} from "../models/episode-script.js";

export interface CreativeOutput {
  readonly title: string;
  readonly content: string;
  readonly episodeDurationSeconds: number;
  readonly preWriteCheck: string;
  readonly episodeScript?: EpisodeScript;
  readonly episodeScriptMetrics?: ReturnType<typeof measureEpisodeScript>;
}

/** Stable machine code attached to writer output parse failures. */
export const WRITER_OUTPUT_PARSE_FAILURE_CODE = "WRITER_OUTPUT_PARSE_FAILED";

/**
 * Error shape thrown when the writer's response cannot be parsed into an
 * EpisodeScript. Carries the raw model output so callers can persist it for
 * diagnosis instead of losing the only evidence (observed in paid production
 * runs: transient parse failures were impossible to debug post-hoc).
 */
export interface WriterOutputParseFailure extends Error {
  readonly code: typeof WRITER_OUTPUT_PARSE_FAILURE_CODE;
  readonly rawOutput: string;
}

export function isWriterOutputParseFailure(error: unknown): error is WriterOutputParseFailure {
  return error instanceof Error
    && (error as { readonly code?: string }).code === WRITER_OUTPUT_PARSE_FAILURE_CODE
    && typeof (error as { readonly rawOutput?: unknown }).rawOutput === "string";
}

export function parseCreativeOutput(
  episodeNumber: number,
  content: string,
  countingMode: LengthCountingMode = "zh_chars",
  targetDurationSeconds = EPISODE_DURATION_TARGET_SECONDS,
): CreativeOutput {
  const structured = tryParseEpisodeScript(content, episodeNumber, targetDurationSeconds);
  if (structured) {
    const script = structured.script;
    const metrics = measureEpisodeScript(script, targetDurationSeconds);
    return {
      title: script.title,
      content: renderEpisodeScriptMarkdown(script),
      // Episode v2 has one duration authority: the measured sum of shot
      // durations. Character counts remain telemetry only and must never leak
      // into index/status fields as if they were seconds.
      episodeDurationSeconds: metrics.estimatedDurationSeconds,
      preWriteCheck: extractTag(content, "PRE_WRITE_CHECK"),
      episodeScript: script,
      episodeScriptMetrics: metrics,
    };
  }
  throw new Error(
    "EPISODE_SCRIPT_REQUIRED: writer output must contain a valid EpisodeScript JSON contract; free-form episode text is rejected.",
  );
}

function extractTag(content: string, tag: string): string {
  const regex = new RegExp(
    `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
  );
  return content.match(regex)?.[1]?.trim() ?? "";
}

function tryParseEpisodeScript(
  content: string,
  episodeNumber: number,
  targetDurationSeconds?: number,
): { readonly script: EpisodeScript } | undefined {
  // Fast-path guard: pure free-form prose without any JSON marker is not a
  // parse failure worth a regeneration round-trip — it is a contract violation
  // ("EPISODE_SCRIPT_REQUIRED") and stays a plain error. Anything that *looks*
  // structured (marked blocks, fences, embedded sidecar, leading brace) is
  // attempted so every genuinely malformed script is wrapped with the stable
  // WRITER_OUTPUT_PARSE_FAILED code + rawOutput, which the runner uses to
  // regenerate once and dump the raw output.
  const hasStructuredMarker = /===\s*(?:EPISODE_SCRIPT_JSON|PRE_WRITE_CHECK)\b/i.test(content);
  const hasJsonFence = /```json\s*\{/i.test(content);
  const hasEmbeddedJson = /<!--\s*inkos-episode-script-json/i.test(content);
  const hasRawJson = content.trimStart().startsWith("{");
  if (!hasStructuredMarker && !hasJsonFence && !hasEmbeddedJson && !hasRawJson) {
    return undefined;
  }
  try {
    return { script: parseEpisodeScriptOutput(content, episodeNumber, targetDurationSeconds) };
  } catch (error) {
    const wrapped = new Error(
      `漫剧分镜稿解析失败：${error instanceof Error ? error.message : String(error)}`,
    ) as Error & { code: string; rawOutput: string };
    wrapped.code = WRITER_OUTPUT_PARSE_FAILURE_CODE;
    wrapped.rawOutput = content;
    throw wrapped;
  }
}

export type ParsedWriterOutput = Omit<WriteEpisodeOutput, "postWriteErrors" | "postWriteWarnings">;

/** Parse the only accepted creative artifact: an EpisodeScript JSON contract. */
export function parseWriterOutput(
  episodeNumber: number,
  content: string,
  genreProfile: GenreProfile,
  countingMode: LengthCountingMode = "zh_chars",
): ParsedWriterOutput {
  const creative = parseCreativeOutput(episodeNumber, content, countingMode);

  return {
    episodeNumber,
    title: creative.title,
    content: creative.content,
    episodeDurationSeconds: creative.episodeDurationSeconds,
    ...(creative.episodeScript ? { episodeScript: creative.episodeScript } : {}),
    ...(creative.episodeScriptMetrics ? { episodeScriptMetrics: creative.episodeScriptMetrics } : {}),
    preWriteCheck: creative.preWriteCheck,
    stateProjection: "",
    updatedState: defaultStatePlaceholder(countingMode),
    updatedLedger: genreProfile.numericalSystem ? defaultLedgerPlaceholder(countingMode) : "",
    updatedHooks: defaultHooksPlaceholder(countingMode),
    episodeSummary: "",
    updatedSubplots: "",
    updatedEmotionalArcs: "",
    updatedCharacterMatrix: "",
  };
}

export function normalizeEpisodeTitle(
  title: string,
  episodeNumber: number,
  countingMode: LengthCountingMode = "zh_chars",
): string {
  const trimmed = title.trim().replace(/^#{1,6}\s*/u, "");
  const prefix = countingMode === "en_words"
    ? new RegExp(`^Episode\\s+${episodeNumber}(?:(?::|[\\s\\-–—])+|$)`, "iu")
    : /^第\s*[零〇一二三四五六七八九十百千万两\d]+\s*集(?:(?:[：:\s\-–—])+|$)/u;
  const hadPrefix = prefix.test(trimmed);
  const withoutPrefix = trimmed.replace(prefix, "").trim();
  if (withoutPrefix) return withoutPrefix;
  if (hadPrefix) return defaultEpisodeTitle(episodeNumber, countingMode);
  return trimmed || defaultEpisodeTitle(episodeNumber, countingMode);
}

function defaultEpisodeTitle(
  episodeNumber: number,
  countingMode: LengthCountingMode,
): string {
  return countingMode === "en_words" ? `Episode ${episodeNumber}` : `第${episodeNumber}集`;
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
