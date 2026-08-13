import type { LLMClient, LLMCallTelemetry, OnCallTelemetry, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion, createLLMClient } from "../llm/provider.js";
import type { Logger } from "../utils/logger.js";
import type { BookConfig, RevisionGate } from "../models/book.js";
import type { EpisodeMeta, EpisodeReviewTelemetry } from "../models/episode.js";
import type {
  NotifyChannel,
  LLMConfig,
  AgentLLMOverride,
  ContentPolicyFallbackConfig,
} from "../models/project.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { ArchitectAgent, type ArchitectOutput } from "../agents/architect.js";
import { CanonExtractor } from "../agents/canon-extractor.js";
import { ClaimValidatorAgent } from "../agents/claim-validator.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { PlannerAgent, type PlanEpisodeOutput } from "../agents/planner.js";
import { buildUpstreamRevisionFeedbackBlock } from "../agents/planner-prompts.js";
import { ComposerAgent, composeGovernedEpisode, contextBudgetFromClient, type ComposeEpisodeOutput } from "../agents/composer.js";
import { WriterAgent, type WriteEpisodeInput, type WriteEpisodeOutput } from "../agents/writer.js";
import { isWriterOutputParseFailure } from "../agents/writer-parser.js";
import { applyEpisodeCanonUpdates } from "../state/canon-evolution.js";
import { buildSettingsEntityIndex } from "../state/settings-index.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, DEFAULT_REVISE_MODE, ReviseModeSchema, type ReviseMode } from "../agents/reviser.js";
import { StateValidatorAgent, type ValidationResult, type ValidationWarning } from "../agents/state-validator.js";
import { VolumeAuditorAgent } from "../agents/volume-auditor.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { StateManager, type EpisodePersistenceRecovery } from "../state/manager.js";
import { MemoryDB, type Fact } from "../state/memory-db.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { EpisodeMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { buildLengthSpec, countEpisodeLength, formatLengthCount, isOutsideHardRange, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import { analyzeLongSpanFatigue } from "../utils/long-span-fatigue.js";
import { checkPremiseDeviceContract } from "../utils/foundation-scale.js";
import {
  isNewLayoutBook,
  readCharacterContext,
  readStoryFrame,
  readVolumeMap,
} from "../utils/outline-paths.js";
import { loadNarrativeMemorySeed, loadSnapshotCurrentStateFacts } from "../state/runtime-state-store.js";
import { renderEpisodeSummariesProjection } from "../state/state-projections.js";
import { recordReaderClaimReveals } from "../state/claim-visibility.js";
import {
  DEFAULT_UNCLAIMED_FACTS_BACKLOG_THRESHOLD,
  hasUnclaimedFactsBacklog,
  loadUnclaimedFacts,
  saveCanonBundle,
} from "../state/canon-store.js";
import type { CompiledEpisodeClaims } from "../utils/episode-claim-compiler.js";
import { detectVisibleRevealClaimIds } from "../utils/claim-gate.js";
import { validateEpisodeMemoCommitments, validateMemoInternalConsistency } from "../utils/episode-memo-commitments.js";
import {
  detectAttemptedKrRefs,
  detectVisibleKrRefs,
  loadVolumeProgress,
  readSavedVolumeContract,
  recordVisibleVolumeProgress,
} from "../utils/volume-contract.js";
import type { VolumeContract, VolumeProgressFile } from "../models/volume-contract.js";
import {
  EPISODE_DURATION_HARD_MAX_SECONDS,
  EPISODE_DURATION_HARD_MIN_SECONDS,
  EPISODE_DURATION_TARGET_SECONDS,
  EpisodeScriptSchema,
  measureEpisodeScript,
  normalizeEpisodeShotDurations,
  parseEpisodeScriptOutput,
  renderEpisodeScriptMarkdown,
  carryForwardEpisodeIncomingState,
  type EpisodeScript,
} from "../models/episode-script.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { appendFile, cp, readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  buildStateDegradedIssues,
  buildStateDegradedReviewNote,
  parseStateDegradedReviewNote,
  resolveStateDegradedBaseStatus,
  replayEpisodeStateAfterValidationFailure,
} from "./episode-state-recovery.js";
import { persistEpisodeArtifacts } from "./episode-persistence.js";
import {
  auditIssuesFromEpisodeRecovery,
  buildEpisodeRecoveryState,
} from "./episode-recovery-policy.js";
import { runEpisodeReviewCycle, type EpisodeReviewAttempt } from "./episode-review-cycle.js";
import {
  deriveAuditPassed,
  resolveEpisodeReviewStatus,
  type EpisodeQualityStatus,
} from "./episode-review-quality-gate.js";
import { validateEpisodeTruthPersistence } from "./episode-truth-validation.js";
import { buildEpisodeHandoffCapsule, recoverEpisodeHandoffCapsule } from "./episode-handoff.js";
import {
  buildEpisodeReviewEvidence,
  ensureEpisodeReviewSidecar,
  loadEpisodeReviewEvidence,
  resolveAuditIssueOwner,
} from "./episode-review-evidence.js";
import {
  clearUpstreamRevisionFeedback,
  loadUpstreamRevisionFeedback,
  recordUpstreamRevisionFeedback,
} from "./upstream-revision-feedback.js";
import { buildEpisodePerformanceReport, type EpisodePerformanceReport } from "./episode-performance.js";
import { auditEpisodeScript } from "./episode-quality-gate.js";
import {
  buildEpisodeCapacityBaseline,
  estimateEpisodeCapacityFromPlan,
  summarizeMemoCapacityCommitments,
} from "./episode-capacity-estimate.js";
import {
  loadPersistedGovernedEpisodeInput,
  loadPersistedPlan,
  relativeToBookDir,
  savePersistedPlan,
} from "./persisted-governed-plan.js";
import type { OnPipelineDiagnostic, PipelineDiagnostic } from "./diagnostics.js";
import {
  createContextCompilationCache,
  type ContextCompilationCache,
  type ContextCompilationCacheStats,
} from "../utils/context-compilation-cache.js";
import {
  attachEpisodePlanningMemory,
  attachEpisodeContextArtifacts,
  getEpisodeContextContent,
  loadEpisodeContextSnapshot,
  type EpisodeContextSnapshot,
} from "./episode-context.js";
import { gatherPlanningMaterials } from "../utils/planning-materials.js";
import { renamePathWithRetry } from "../utils/fs-retry.js";
import {
  normalizePendingHookIdsMarkdown,
  parseEpisodeSummariesMarkdown,
} from "../utils/story-markdown.js";

function bindEpisodeMemoIncomingState(
  memo: EpisodeMemo,
  incomingState: EpisodeScript["contract"]["handoffState"],
): EpisodeMemo {
  const serialized = JSON.stringify(incomingState);
  const heading = memo.body.includes("## Incoming state") ? "## Incoming state" : "## 进入状态";
  const start = memo.body.indexOf(heading);
  const payloadStart = start >= 0 ? start + heading.length : -1;
  const nextHeading = payloadStart >= 0 ? memo.body.slice(payloadStart).search(/\n##\s/u) : -1;
  const body = start >= 0
    ? `${memo.body.slice(0, payloadStart)}\n${serialized}${nextHeading >= 0 ? memo.body.slice(payloadStart + nextHeading) : ""}`
    : `${memo.body.trimEnd()}\n\n${heading}\n${serialized}`;
  return {
    ...memo,
    incomingState: serialized,
    body,
  };
}

const SEQUENCE_LEVEL_CATEGORIES = new Set([
  "Pacing Monotony", "节奏单调",
  "Mood Monotony", "情绪单调",
  "Title Collapse", "标题重复",
  "Title Clustering", "标题聚集",
  "Opening Pattern Repetition", "开头同构",
  "Ending Pattern Repetition", "结尾同构",
]);

function isSequenceLevelCategory(category: string): boolean {
  return SEQUENCE_LEVEL_CATEGORIES.has(category);
}

function toAuditRepairScope(value: string | undefined): AuditIssue["repairScope"] {
  return value === "local" || value === "structural" || value === "unknown"
    ? value
    : undefined;
}

function deduplicateAuditIssues(issues: ReadonlyArray<AuditIssue>): AuditIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const normalizedDescription = String(issue.description ?? "")
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
    const key = JSON.stringify([issue.severity, normalizedDescription]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface ImportFoundationSourceOptions {
  readonly maxFullTextChars?: number;
  readonly episodeExcerptChars?: number;
  readonly titleCatalogChars?: number;
  readonly edgeEpisodeCount?: number;
  readonly middleAnchorCount?: number;
}

const DEFAULT_IMPORT_FOUNDATION_MAX_FULL_TEXT_CHARS = 80_000;
const DEFAULT_IMPORT_EPISODE_EXCERPT_CHARS = 6_000;
const DEFAULT_IMPORT_TITLE_CATALOG_CHARS = 24_000;
const DEFAULT_IMPORT_EDGE_EPISODE_COUNT = 4;
const DEFAULT_IMPORT_MIDDLE_ANCHOR_COUNT = 8;

function formatImportedEpisode(
  episode: { readonly title: string; readonly content: string },
  index: number,
  language: LengthLanguage,
  content = episode.content,
): string {
  return language === "en"
    ? `Episode ${index + 1}: ${episode.title}\n\n${content}`
      : `第${index + 1}集 ${episode.title}\n\n${content}`;
}

function estimateImportFullTextLength(
  episodes: ReadonlyArray<{ readonly title: string; readonly content: string }>,
): number {
  return episodes.reduce((total, episode) => total + episode.title.length + episode.content.length + 24, 0);
}

function excerptHeadTail(text: string, maxChars: number, language: LengthLanguage): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const headChars = Math.max(200, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(200, maxChars - headChars);
  const omitted = clean.length - headChars - tailChars;
  const marker = language === "en"
    ? `\n\n[... ${omitted} chars omitted for import-context budget ...]\n\n`
    : `\n\n【中间省略 ${omitted} 字，用于控制导入上下文预算】\n\n`;
  return `${clean.slice(0, headChars).trimEnd()}${marker}${clean.slice(-tailChars).trimStart()}`;
}

function pickImportAnchorIndexes(
  episodeCount: number,
  edgeEpisodeCount: number,
  middleAnchorCount: number,
): ReadonlyArray<number> {
  const selected = new Set<number>();
  for (let i = 0; i < Math.min(edgeEpisodeCount, episodeCount); i++) selected.add(i);
  for (let i = Math.max(0, episodeCount - edgeEpisodeCount); i < episodeCount; i++) selected.add(i);

  const middleStart = Math.min(edgeEpisodeCount, episodeCount);
  const middleEnd = Math.max(middleStart, episodeCount - edgeEpisodeCount);
  const middleSize = middleEnd - middleStart;
  const anchors = Math.min(middleAnchorCount, middleSize);
  for (let i = 0; i < anchors; i++) {
    const offset = Math.floor(((i + 1) * middleSize) / (anchors + 1));
    selected.add(Math.min(episodeCount - 1, middleStart + offset));
  }

  return [...selected].sort((a, b) => a - b);
}

function buildTitleCatalog(
  episodes: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
  maxChars: number,
): string {
  const lines = episodes.map((episode, index) =>
    language === "en"
      ? `- Episode ${index + 1}: ${episode.title} (${episode.content.length} chars)`
      : `- 第${index + 1}集：${episode.title}（${episode.content.length}字符）`,
  );
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;

  const headBudget = Math.floor(maxChars * 0.55);
  const tailBudget = maxChars - headBudget;
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  for (const line of lines) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (tailChars + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    tailChars += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  const marker = language === "en"
    ? `- ... ${omitted} episode titles omitted ...`
    : `- ……中间 ${omitted} 个剧集标题省略……`;
  return [...head, marker, ...tail].join("\n");
}

/**
 * Build the architect external-context for a side-story (番外) foundation: frame
 * it as a companion work that reuses the parent canon's cast/world but tells an
 * independent side plot, and attach the parent canon as reference material.
 */
export function buildSpinoffFoundationContext(
  parentCanon: string,
  direction: string | undefined,
  language: "zh" | "en",
): string {
  const dir = direction?.trim();
  if (language === "en") {
    return [
      "## This is a SIDE-STORY (番外)",
      "Reuse the established characters, world, and rules from the parent canon below. Tell an INDEPENDENT side plot — a bonus arc, a character backstory, or a what-if — that does NOT advance or contradict the parent work's main storyline.",
      dir ? `\n## Side-story direction\n${dir}` : "",
      `\n## Parent canon (reuse these characters and settings)\n${parentCanon}`,
    ].filter(Boolean).join("\n");
  }
  return [
    "## 这是一部番外",
    "复用下方正传正典里已确立的角色、世界观与规则。讲一个独立的侧篇故事——支线、角色前传或 what-if——不要推进或违背正传的主线剧情。",
    dir ? `\n## 番外方向\n${dir}` : "",
    `\n## 正传正典（复用以下角色与设定）\n${parentCanon}`,
  ].filter(Boolean).join("\n");
}

export function buildImportFoundationSource(
  episodes: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
  options: ImportFoundationSourceOptions = {},
): string {
  const maxFullTextChars = options.maxFullTextChars ?? DEFAULT_IMPORT_FOUNDATION_MAX_FULL_TEXT_CHARS;
  const episodeExcerptChars = options.episodeExcerptChars ?? DEFAULT_IMPORT_EPISODE_EXCERPT_CHARS;
  const titleCatalogChars = options.titleCatalogChars ?? DEFAULT_IMPORT_TITLE_CATALOG_CHARS;
  const edgeEpisodeCount = options.edgeEpisodeCount ?? DEFAULT_IMPORT_EDGE_EPISODE_COUNT;
  const middleAnchorCount = options.middleAnchorCount ?? DEFAULT_IMPORT_MIDDLE_ANCHOR_COUNT;

  if (estimateImportFullTextLength(episodes) <= maxFullTextChars) {
    return episodes.map((episode, index) => formatImportedEpisode(episode, index, language)).join("\n\n---\n\n");
  }

  const anchorIndexes = pickImportAnchorIndexes(episodes.length, edgeEpisodeCount, middleAnchorCount);
  const header = language === "en"
    ? [
        "## Import foundation source package",
        "",
        `The imported book has ${episodes.length} episodes. To avoid overflowing the LLM context, this package keeps the opening episodes, ending/continuation point, selected middle anchors, and a capped title catalog. Full episodes will still be replayed sequentially after foundation generation to rebuild truth files.`,
      ].join("\n")
    : [
        "## 导入基础设定压缩资料包",
        "",
        `本次导入共 ${episodes.length} 集。为避免超出 LLM 上下文，这里保留开篇、结尾续写点、少量中段锚点和标题目录；完整剧集将在后续顺序回放中逐集分析并沉淀 truth files。`,
      ].join("\n");
  const catalogTitle = language === "en" ? "## Capped episode title catalog" : "## 剧集标题目录（截断）";
  const anchorsTitle = language === "en" ? "## Source excerpts for architecture" : "## 用于反推基础设定的正文摘录";
  const anchorText = anchorIndexes
    .map((index) => {
      const episode = episodes[index]!;
      return formatImportedEpisode(
        episode,
        index,
        language,
        excerptHeadTail(episode.content, episodeExcerptChars, language),
      );
    })
    .join("\n\n---\n\n");

  return [
    header,
    "",
    catalogTitle,
    buildTitleCatalog(episodes, language, titleCatalogChars),
    "",
    anchorsTitle,
    anchorText,
  ].join("\n");
}

/** Human-readable description of each manual-revision gate, surfaced in revisionDiagnostics. */
const REVISION_GATE_STANDARDS: Record<RevisionGate, string> = {
  strict: "A revision is applied only when blocking, critical, and AI-tell counts do not worsen, and at least blocking or AI-tell issues improve.",
  lenient: "A revision is applied whenever blocking, critical, and AI-tell counts do not worsen; no improvement is required (lenient gate).",
  always: "Manual revisions are always applied; audit counts are recorded for reference only (always gate).",
};

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly defaultLLMConfig?: LLMConfig;
  readonly foundationReviewRetries?: number;
  readonly writingReviewRetries?: number;
  readonly governanceCallLimits?: {
    readonly maxRevisionCallsPerEpisode?: number;
    readonly maxSettlementCallsPerEpisode?: number;
  };
  /** Block new planning when the explicit Canon-refresh queue becomes unsafe. */
  readonly unclaimedFactsBacklogThreshold?: number;
  /**
   * "auto" (default): writeNextEpisode runs the audit→revise loop inline.
   * "manual": stop right after the draft (no auto audit/revise) so review/revise
   * become explicit, user-driven checkpoint actions — episode write stays fast.
   */
  readonly episodeReviewMode?: "auto" | "manual";
  /**
   * Gate for applying manual revisions (default "strict"):
   * - "strict": apply only when blocking/critical/AI-tell counts do not worsen
   *   AND at least one of blocking or AI-tell improves.
   * - "lenient": apply whenever the counts do not worsen (no improvement required).
   * - "always": always apply; audit counts are recorded but never block.
   */
  readonly revisionGate?: RevisionGate;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly contentPolicyFallback?: ContentPolicyFallbackConfig;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly onContextCompression?: ContextCompressionCallback;
  /** P0: telemetry callback for all LLM calls made by the pipeline. */
  readonly onCallTelemetry?: import("../llm/provider.js").OnCallTelemetry;
  /** Structured non-transport retries and fallback paths. */
  readonly onPipelineDiagnostic?: OnPipelineDiagnostic;
  /** P0: per-call LLM timeout in milliseconds (default: undefined = no timeout). */
  readonly defaultTimeoutMs?: number;
  /** Reject individual assembled prompts before transport when they exceed this estimate. */
  readonly maxPromptEstimatedTokensPerCall?: number;
  /** Cooperative cancellation for the active pipeline operation. */
  readonly signal?: AbortSignal;
}

export interface TokenUsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface EpisodePipelineResult {
  readonly operationId?: string;
  readonly episodeNumber: number;
  readonly title: string;
  readonly episodeDurationSeconds: number;
  readonly auditResult: AuditResult;
  readonly revised: boolean;
  readonly status: "ready-for-review" | "audit-failed" | "state-degraded";
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
  readonly reviewAttempts?: ReadonlyArray<EpisodeReviewAttempt>;
  readonly reviewTelemetry?: EpisodeReviewTelemetry;
  readonly recovery?: Exclude<EpisodePersistenceRecovery, { readonly kind: "none" }>;
  readonly performanceReport?: EpisodePerformanceReport;
}

export interface RewriteEpisodeResult extends EpisodePipelineResult {
  readonly rolledBackTo: number;
  readonly discarded: ReadonlyArray<number>;
}

// Atomic operation results
export interface DraftResult {
  readonly operationId?: string;
  readonly episodeNumber: number;
  readonly title: string;
  readonly episodeDurationSeconds: number;
  readonly filePath: string;
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly tokenUsage?: TokenUsageSummary;
  readonly recovery?: Exclude<EpisodePersistenceRecovery, { readonly kind: "none" }>;
}

export interface PlanEpisodeCapacity {
  readonly estimatedShots?: number;
  readonly estimatedDurationSeconds?: number;
  readonly promisedBeats: number;
  /** Non-blocking craft hint (STY-16), localized to the book language. */
  readonly note?: string;
}

export interface PlanEpisodeResult {
  readonly bookId: string;
  readonly episodeNumber: number;
  readonly intentPath: string;
  readonly goal: string;
  readonly conflicts: ReadonlyArray<string>;
  readonly capacity?: PlanEpisodeCapacity;
}

export interface ComposeEpisodeResult extends PlanEpisodeResult {
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
}

export interface ReviseResult {
  readonly episodeNumber: number;
  readonly episodeDurationSeconds: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly applied: boolean;
  readonly status: "unchanged" | "ready-for-review" | "audit-failed" | "state-degraded";
  readonly skippedReason?: string;
  readonly revisionDiagnostics?: {
    readonly standard: string;
    readonly before: {
      readonly blockingCount: number;
      readonly criticalCount: number;
      readonly aiTellCount: number;
    };
    readonly after: {
      readonly blockingCount: number;
      readonly criticalCount: number;
      readonly aiTellCount: number;
    };
    readonly remainingIssues: ReadonlyArray<{
      readonly severity: AuditIssue["severity"];
      readonly category: string;
      readonly description: string;
      readonly suggestion?: string;
    }>;
  };
  readonly lengthWarnings?: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly recovery?: Exclude<EpisodePersistenceRecovery, { readonly kind: "none" }>;
}

export interface TruthFiles {
  readonly currentState: string;
  readonly particleLedger: string;
  readonly pendingHooks: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly episodesWritten: number;
  readonly totalDurationSeconds: number;
  readonly nextEpisode: number;
  readonly episodes: ReadonlyArray<EpisodeMeta>;
  readonly episodePerformance?: {
    readonly totalCalls: number;
    readonly totalTokens: number;
    readonly averageContextEstimatedTokens: number;
    readonly cacheHits: number;
    readonly cacheMisses: number;
  };
}

interface MergedAuditEvaluation {
  readonly auditResult: AuditResult;
  readonly aiTellCount: number;
  readonly blockingCount: number;
  readonly criticalCount: number;
  readonly revisionBlockingIssues: ReadonlyArray<AuditIssue>;
}

interface PreparedEpisodeAuditGates {
  readonly runPostWriteChecks: (content: string) => ReadonlyArray<AuditIssue>;
  readonly compiledClaims: CompiledEpisodeClaims | null;
  readonly volumeContract: VolumeContract | null;
  readonly volumeProgress: VolumeProgressFile | null;
}

export interface ImportEpisodesInput {
  readonly bookId: string;
  readonly episodes: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportEpisodesResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalDurationSeconds: number;
  readonly nextEpisode: number;
  readonly recovery?: Exclude<EpisodePersistenceRecovery, { readonly kind: "none" }>;
}

export interface InitBookOptions {
  readonly externalContext?: string;
  readonly authorIntent?: string;
  readonly currentFocus?: string;
}

/**
 * Normalize LLM-reported screenplay audit issues before they feed the
 * revision gate. Only generic reviewer overreach is handled: an em-dash
 * category whose evidence says the draft is already compliant is a review
 * failure, not a script failure, and is demoted to a warning.
 *
 * Book-specific plot overrides that were previously encoded here (named
 * characters, props, and locations lifted from a single paid production run)
 * have been removed — a generic gate must never embed one series' plot
 * details, which silently degraded audit severities for any book that
 * happened to reuse the same names or props.
 */
function normalizeScreenplayReviewedIssue(
  issue: AuditIssue,
  screenplaySurface = "",
): AuditIssue {
  if (issue.severity !== "critical") return issue;
  const evidence = issue.description;
  if (/(?:破折号|em dash|long dash)/iu.test(issue.category)
    && /(?:全文未发现|全文合规|未发现.*(?:破折号|长横线)|no\s+(?:em|long)\s+dash)/iu.test(issue.description.slice(-180))) {
    return { ...issue, severity: "warning", ruleClass: issue.ruleClass ?? "reviewed_invariant" };
  }
  return issue;
}

async function loadPersistedEpisodeScript(bookDir: string, episode: number): Promise<EpisodeScript | undefined> {
  if (episode < 1) return undefined;
  const episodesDir = join(bookDir, "episodes");
  const prefix = `${String(episode).padStart(4, "0")}_`;
  const files = await readdir(episodesDir).catch(() => []);
  const filename = files.find((file) =>
    file.startsWith(prefix) && file.endsWith(".json") && !file.endsWith("_review.json"),
  );
  if (!filename) return undefined;
  try {
    const sourceContent = await readFile(join(episodesDir, filename), "utf8");
    const script = EpisodeScriptSchema.parse(JSON.parse(sourceContent));
    // Handoff and review files are derived sidecars. A sidecar recovery failure
    // must not make the authoritative episode JSON disappear from continuity.
    await Promise.allSettled([
      recoverEpisodeHandoffCapsule({ bookDir, script, sourceContent }),
      loadEpisodeReviewEvidence({ bookDir, episode, currentContent: sourceContent }),
    ]);
    return script;
  } catch {
    return undefined;
  }
}

/** Load the last `window` persisted episode scripts before `beforeEpisode` (newest first). */
async function loadRecentEpisodeScripts(
  bookDir: string,
  beforeEpisode: number,
  window = 3,
): Promise<EpisodeScript[]> {
  const scripts: EpisodeScript[] = [];
  for (let episode = beforeEpisode - 1; episode >= Math.max(1, beforeEpisode - window); episode -= 1) {
    const script = await loadPersistedEpisodeScript(bookDir, episode);
    if (script) scripts.push(script);
  }
  return scripts;
}

export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;
  private readonly agentClients = new Map<string, LLMClient>();
  private readonly contextCompilationCache: ContextCompilationCache;
  private readonly telemetryWriteQueues = new Map<string, Promise<void>>();
  private readonly activeOperationIds = new Map<string, string>();
  private readonly operationStartedAt = new Map<string, number>();
  private readonly operationEpisodes = new Map<string, number>();
  private readonly operationTelemetry = new Map<string, LLMCallTelemetry[]>();
  private memoryIndexFallbackWarned = false;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
    this.contextCompilationCache = createContextCompilationCache(
      32,
      // Keep compilation cache process-local during production operations. A
      // caller may still opt into persistence when constructing the utility
      // directly, but pipelines should not serialize the full cache per set().
    );
  }

  private localize(language: LengthLanguage, messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private async resolveBookLanguage(
    book: Pick<BookConfig, "genre" | "language">,
  ): Promise<LengthLanguage> {
    if (book.language) {
      return book.language;
    }

    try {
      const { profile } = await this.loadGenreProfile(book.genre);
      return profile.language;
    } catch {
      return "zh";
    }
  }

  private async resolveBookLanguageById(bookId: string): Promise<LengthLanguage> {
    try {
      const book = await this.state.loadBookConfig(bookId);
      return await this.resolveBookLanguage(book);
    } catch {
      return "zh";
    }
  }

  private languageFromLengthSpec(lengthSpec: Pick<LengthSpec, "countingMode">): LengthLanguage {
    return lengthSpec.countingMode === "en_words" ? "en" : "zh";
  }

  private logStage(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(
      `${this.localize(language, { zh: "阶段：", en: "Stage: " })}${this.localize(language, message)}`,
    );
  }

  private logInfo(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.info(this.localize(language, message));
  }

  private logWarn(language: LengthLanguage, message: { zh: string; en: string }): void {
    this.config.logger?.warn(this.localize(language, message));
  }

  private emitDiagnostic(
    diagnostic: Omit<PipelineDiagnostic, "timestamp">,
  ): void {
    this.config.onPipelineDiagnostic?.({
      ...diagnostic,
      timestamp: new Date().toISOString(),
    });
  }

  private async generateAndReviewFoundation(params: {
    readonly generate: (reviewFeedback?: string) => Promise<ArchitectOutput>;
    readonly reviewer: FoundationReviewerAgent;
    readonly mode: "original" | "series";
    readonly sourceCanon?: string;
    readonly language: "zh" | "en";
    readonly stageLanguage: LengthLanguage;
    readonly bookId?: string;
    readonly targetEpisodes?: number;
    readonly maxRetries?: number;
  }): Promise<ArchitectOutput> {
    const maxRetries = params.maxRetries ?? this.config.foundationReviewRetries ?? 2;
    let foundation = await params.generate();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.logStage(params.stageLanguage, {
        zh: `审核基础设定（第${attempt + 1}轮）`,
        en: `reviewing foundation (round ${attempt + 1})`,
      });

      const review = await params.reviewer.review({
        foundation,
        mode: params.mode,
        sourceCanon: params.sourceCanon,
        language: params.language,
        targetEpisodes: params.targetEpisodes,
      });

      this.config.logger?.info(
        `Foundation review: ${review.totalScore}/100 ${review.passed ? "PASSED" : "REJECTED"}`,
      );
      for (const dim of review.dimensions) {
        this.config.logger?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
      }

      if (review.passed) {
        return foundation;
      }

      this.logWarn(params.stageLanguage, {
        zh: `基础设定未通过审核（${review.totalScore}分），正在重新生成...`,
        en: `Foundation rejected (${review.totalScore}/100), regenerating...`,
      });

      foundation = await params.generate(this.buildFoundationReviewFeedback(review, params.language));
    }

    // Final review
    const finalReview = await params.reviewer.review({
      foundation,
      mode: params.mode,
      sourceCanon: params.sourceCanon,
      language: params.language,
      targetEpisodes: params.targetEpisodes,
    });
    this.config.logger?.info(
      `Foundation final review: ${finalReview.totalScore}/100 ${finalReview.passed ? "PASSED" : "ACCEPTED (max retries)"}`,
    );
    for (const dim of finalReview.dimensions) {
      this.config.logger?.info(`  [${dim.score}] ${dim.name.slice(0, 40)}`);
    }
    if (!finalReview.passed) {
      this.emitDiagnostic({
        kind: "foundation-fallback",
        severity: "error",
        agent: "foundation-reviewer",
        phase: "foundation-review",
        bookId: params.bookId,
        attempt: maxRetries + 1,
        maxAttempts: maxRetries + 1,
        message: `Foundation review exhausted with score ${finalReview.totalScore}/100.`,
        details: {
          totalScore: finalReview.totalScore,
          maxRetries,
          mode: params.mode,
          blockingIssues: finalReview.blockingIssues?.join(" | ") ?? "",
        },
      });
      if (finalReview.blockingIssues && finalReview.blockingIssues.length > 0) {
        throw new Error(
          `Foundation scale validation failed after ${maxRetries + 1} review attempt(s): ${finalReview.blockingIssues.join("; ")}`,
        );
      }
    }

    return foundation;
  }

  private buildFoundationReviewFeedback(
    review: {
      readonly dimensions: ReadonlyArray<{
        readonly name: string;
        readonly score: number;
        readonly feedback: string;
      }>;
      readonly overallFeedback: string;
      readonly blockingIssues?: ReadonlyArray<string>;
    },
    language: "zh" | "en",
  ): string {
    const dimensionLines = review.dimensions
      .map((dimension) => (
        language === "en"
          ? `- ${dimension.name} [${dimension.score}]: ${dimension.feedback}`
          : `- ${dimension.name}（${dimension.score}分）：${dimension.feedback}`
      ))
      .join("\n");
    const blockingLines = review.blockingIssues?.map((issue) => `- ${issue}`).join("\n");

    return language === "en"
      ? [
          "## Overall Feedback",
          review.overallFeedback,
          "",
          "## Hard Blocking Issues",
          blockingLines || "- none",
          "",
          "## Dimension Notes",
          dimensionLines || "- none",
        ].join("\n")
      : [
          "## 总评",
          review.overallFeedback,
          "",
          "## 硬性阻断项",
          blockingLines || "- 无",
          "",
          "## 分项问题",
          dimensionLines || "- 无",
        ].join("\n");
  }

  private agentCtx(bookId?: string): AgentContext {
    return {
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger,
      onStreamProgress: this.config.onStreamProgress,
    };
  }

  private resolveOverride(agentName: string): { model: string; client: LLMClient } {
    const override = this.config.modelOverrides?.[agentName];
    if (!override) {
      return { model: this.config.model, client: this.config.client };
    }
    if (typeof override === "string") {
      return { model: override, client: this.config.client };
    }
    // Full override — needs its own client if baseUrl differs
    if (!override.baseUrl) {
      return { model: override.model, client: this.config.client };
    }
    const base = this.config.defaultLLMConfig;
    const provider = override.provider ?? base?.provider ?? "custom";
    const service = override.service ?? base?.service ?? "custom";
    const apiKey = override.apiKeyEnv
      ? process.env[override.apiKeyEnv] ?? ""
      : base?.apiKey ?? "";
    const apiKeyFingerprint = createHash("sha256")
      .update(apiKey)
      .digest("hex")
      .slice(0, 12);
    const stream = override.stream ?? base?.stream ?? true;
    const apiFormat = override.apiFormat ?? base?.apiFormat ?? "chat";
    const cacheKey = [
      provider,
      service,
      override.baseUrl,
      `key:${apiKeyFingerprint}`,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      client = createLLMClient({
        provider,
        service,
        configSource: base?.configSource ?? "env",
        baseUrl: override.baseUrl,
        apiKey,
        model: override.model,
        temperature: base?.temperature ?? 0.7,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: override.model, client };
  }

  private resolveContentPolicyFallback(
    agentName: string,
    primary: { readonly model: string; readonly client: LLMClient },
  ): { readonly model: string; readonly client: LLMClient } | undefined {
    const fallback = this.config.contentPolicyFallback;
    if (!fallback || !(fallback.agents as readonly string[]).includes(agentName)) return undefined;

    const primaryService = primary.client.service ?? "custom";
    const primaryBaseUrl = primary.client._piModel?.baseUrl?.replace(/\/+$/, "") ?? "";
    const fallbackBaseUrl = fallback.baseUrl.replace(/\/+$/, "");
    if (fallback.service === primaryService || fallbackBaseUrl === primaryBaseUrl) {
      throw new Error(
        `contentPolicyFallback for agent "${agentName}" must use a different service and endpoint from `
        + `${primaryService}/${primary.model}.`,
      );
    }

    const apiKey = process.env[fallback.apiKeyEnv] ?? "";
    const apiKeyFingerprint = createHash("sha256")
      .update(apiKey)
      .digest("hex")
      .slice(0, 12);
    const provider = fallback.provider ?? "custom";
    const stream = fallback.stream ?? true;
    const apiFormat = fallback.apiFormat ?? "chat";
    const cacheKey = [
      "content-policy-fallback",
      provider,
      fallback.service,
      fallback.baseUrl,
      `key:${apiKeyFingerprint}`,
      `stream:${stream}`,
      `format:${apiFormat}`,
    ].join("|");
    let client = this.agentClients.get(cacheKey);
    if (!client) {
      const base = this.config.defaultLLMConfig;
      client = createLLMClient({
        provider,
        service: fallback.service,
        configSource: base?.configSource ?? "env",
        baseUrl: fallback.baseUrl,
        apiKey,
        model: fallback.model,
        temperature: base?.temperature ?? 0.7,
        thinkingBudget: base?.thinkingBudget ?? 0,
        apiFormat,
        stream,
      });
      this.agentClients.set(cacheKey, client);
    }
    return { model: fallback.model, client };
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    const { model, client } = this.resolveOverride(agent);
    const contentPolicyFallback = this.resolveContentPolicyFallback(agent, { model, client });
    return {
      client,
      model,
      projectRoot: this.config.projectRoot,
      bookId,
      logger: this.config.logger?.child(agent),
      onStreamProgress: this.config.onStreamProgress,
      onCallTelemetry: this.createTelemetrySink(bookId),
      onPipelineDiagnostic: this.config.onPipelineDiagnostic,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      maxPromptEstimatedTokens: this.config.maxPromptEstimatedTokensPerCall,
      signal: this.config.signal,
      ...(contentPolicyFallback ? { contentPolicyFallback } : {}),
    };
  }

  private throwIfAborted(): void {
    const signal = this.config.signal;
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException("Operation cancelled", "AbortError");
  }

  public createAgentContext(agent: string, bookId?: string): AgentContext {
    return this.agentCtxFor(agent, bookId);
  }

  public getContextCompilationCacheStats(): ContextCompilationCacheStats {
    return this.contextCompilationCache.stats();
  }

  private createTelemetrySink(bookId?: string): OnCallTelemetry | undefined {
    if (!bookId && !this.config.onCallTelemetry) {
      return undefined;
    }

    return (telemetry) => {
      const operationId = bookId ? this.activeOperationIds.get(bookId) : undefined;
      const correlatedTelemetry = bookId
        ? { ...telemetry, bookId, ...(operationId ? { operationId } : {}) }
        : telemetry;
      this.config.onCallTelemetry?.(correlatedTelemetry);

      if (operationId) {
        const records = this.operationTelemetry.get(operationId) ?? [];
        records.push(correlatedTelemetry);
        this.operationTelemetry.set(operationId, records);
      }

      if (!bookId) {
        return;
      }

      this.persistTelemetryArtifacts(bookId, correlatedTelemetry);

      if (correlatedTelemetry.status !== "success") {
        this.config.logger?.warn(
          `LLM ${correlatedTelemetry.status}: ${correlatedTelemetry.agent}/${correlatedTelemetry.phase} via ${correlatedTelemetry.service}/${correlatedTelemetry.model}`,
          {
            bookId,
            operationId,
            durationMs: correlatedTelemetry.durationMs,
            timeoutMs: correlatedTelemetry.timeoutMs,
            partialContentLength: correlatedTelemetry.partialContentLength,
            errorMessage: correlatedTelemetry.errorMessage,
          },
        );
      }
    };
  }

  private startOperation(bookId: string): string {
    const operationId = randomUUID();
    this.activeOperationIds.set(bookId, operationId);
    this.operationStartedAt.set(operationId, Date.now());
    this.operationTelemetry.set(operationId, []);
    return operationId;
  }

  private setOperationEpisode(bookId: string, episode: number): void {
    const operationId = this.activeOperationIds.get(bookId);
    if (operationId) this.operationEpisodes.set(operationId, episode);
  }

  private async persistEpisodePerformanceReport(
    bookId: string,
    operationId: string,
    episode: number,
    recovery = false,
    budget = 3,
  ): Promise<EpisodePerformanceReport> {
    const report = this.buildOperationPerformanceReport(
      bookId,
      operationId,
      episode,
      recovery,
      budget,
    );
    const runtimeDir = join(this.state.bookDir(bookId), "story", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      join(runtimeDir, `episode-${String(episode).padStart(4, "0")}.performance.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    return report;
  }

  private buildOperationPerformanceReport(
    bookId: string,
    operationId: string,
    episode: number,
    recovery = false,
    budget = 3,
  ): EpisodePerformanceReport {
    const report = buildEpisodePerformanceReport({
      episode,
      operationId,
      startedAtMs: this.operationStartedAt.get(operationId) ?? Date.now(),
      records: this.operationTelemetry.get(operationId) ?? [],
      cache: this.contextCompilationCache.stats(),
      recovery,
      budget,
    });
    return report;
  }

  private finishOperation(bookId: string, operationId: string): void {
    if (this.activeOperationIds.get(bookId) === operationId) {
      this.activeOperationIds.delete(bookId);
    }
    this.operationStartedAt.delete(operationId);
    this.operationEpisodes.delete(operationId);
    this.operationTelemetry.delete(operationId);
  }

  private persistTelemetryArtifacts(bookId: string, telemetry: LLMCallTelemetry): void {
    const previous = this.telemetryWriteQueues.get(bookId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const telemetryDir = join(this.config.projectRoot, ".inkos", "runtime", "llm-calls");
        await mkdir(telemetryDir, { recursive: true });

        const { partialContent, ...record } = telemetry;
        await appendFile(
          join(telemetryDir, `${bookId}.jsonl`),
          `${JSON.stringify(record)}\n`,
          "utf-8",
        );

        if (!partialContent) {
          return;
        }

        const partialDir = join(this.config.projectRoot, ".inkos", "runtime", "llm-partials", bookId);
        await mkdir(partialDir, { recursive: true });

        const fileName = [
          telemetry.timestamp.replace(/[:.]/g, "-"),
          this.sanitizeTelemetryPathSegment(telemetry.agent),
          this.sanitizeTelemetryPathSegment(telemetry.phase),
          telemetry.status,
        ].join("-") + ".md";

        const lines = [
          "# LLM Partial Report",
          "",
          `- Agent: ${telemetry.agent}`,
          `- Phase: ${telemetry.phase}`,
          `- Status: ${telemetry.status}`,
          `- Service: ${telemetry.service}`,
          `- Model: ${telemetry.model}`,
          `- API Format: ${telemetry.apiFormat}`,
          `- Stream: ${telemetry.stream}`,
          `- DurationMs: ${telemetry.durationMs}`,
          `- PartialContentLength: ${telemetry.partialContentLength ?? partialContent.length}`,
          ...(telemetry.timeoutMs !== undefined ? [`- TimeoutMs: ${telemetry.timeoutMs}`] : []),
          ...(telemetry.errorMessage ? [`- Error: ${telemetry.errorMessage}`] : []),
          "",
          "## Partial Content",
          "",
          partialContent,
          "",
        ];

        await writeFile(join(partialDir, fileName), lines.join("\n"), "utf-8");
      })
      .catch((error) => {
        this.config.logger?.warn(
          `Failed to persist LLM telemetry for book "${bookId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    this.telemetryWriteQueues.set(bookId, next);
  }

  private sanitizeTelemetryPathSegment(value: string): string {
    const sanitized = value
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return sanitized || "unknown";
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.config.projectRoot, genre);
    return { profile: parsed.profile };
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by external agents or agent mode)
  // ---------------------------------------------------------------------------

  async initBook(book: BookConfig, options: InitBookOptions = {}): Promise<void> {
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);
    const stagingBookDir = join(
      this.state.booksDir,
      `.tmp-book-create-${book.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const stageLanguage = await this.resolveBookLanguage(book);
    const effectiveExternalContext = options.externalContext ?? this.config.externalContext;

    this.logStage(stageLanguage, { zh: "生成基础设定", en: "generating foundation" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFoundation(
        book,
        effectiveExternalContext,
        reviewFeedback,
      ),
      reviewer,
      mode: "original",
      language: resolvedLanguage,
      stageLanguage,
      bookId: book.id,
        targetEpisodes: book.targetEpisodes,
    });
    try {
      this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
      await this.state.saveBookConfigAt(stagingBookDir, book);

      this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        gp.numericalSystem,
        book.language ?? gp.language,
      );

      await this.extractInitialCanon(stagingBookDir, book.id, resolvedLanguage, stageLanguage);

      if (effectiveExternalContext && effectiveExternalContext.trim().length > 0) {
        const storyDir = join(stagingBookDir, "story");
        await mkdir(storyDir, { recursive: true });
        await writeFile(join(storyDir, "brief.md"), effectiveExternalContext, "utf-8");
      }

      this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
      await this.state.ensureControlDocumentsAt(
        stagingBookDir,
        book.language ?? gp.language,
        // author_intent.md is a verbatim long-horizon direction card loaded into
        // every episode context. Falling back to the full creative brief here
        // duplicated a multi-token document into the protected context tier and
        // blew the per-episode input budget. Without an explicit authorIntent,
        // leave the placeholder so the brief stays only in story/brief.md.
        options.authorIntent,
      );
      if (options.currentFocus?.trim()) {
        await writeFile(
          join(stagingBookDir, "story", "current_focus.md"),
          options.currentFocus.trimEnd() + "\n",
          "utf-8",
        );
      }

      await this.state.saveEpisodeIndexAt(stagingBookDir, []);

      // New screenplay projects must have structured runtime state immediately;
      // the CLI uses this directory to distinguish them from legacy novels.
      await rewriteStructuredStateFromMarkdown({
        bookDir: stagingBookDir,
        fallbackEpisode: 0,
      });

      this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
      await this.state.snapshotStateAt(stagingBookDir, 0);

      if (await this.pathExists(bookDir)) {
        if (await this.state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${book.id}" already exists at books/${book.id}/. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      }

      await renamePathWithRetry(stagingBookDir, bookDir);
    } catch (error) {
      await rm(stagingBookDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async extractInitialCanon(
    bookDir: string,
    bookId: string,
    language: "zh" | "en",
    stageLanguage: "zh" | "en",
    strict = false,
  ): Promise<void> {
    this.logStage(stageLanguage, { zh: "抽取结构化设定", en: "extracting structured canon" });
    try {
      const extractor = new CanonExtractor(this.agentCtxFor("canon-extractor", bookId));
      const extracted = await extractor.extract(bookDir, language);
      if (extracted.usedFallback) {
        this.emitDiagnostic({
          kind: "canon-fallback",
          severity: "warning",
          agent: "canon-extractor",
          phase: "extract",
          bookId,
          message: extracted.warnings.join("; ") || "Canon extraction used the heuristic fallback.",
        });
      }
      const claimValidator = new ClaimValidatorAgent(this.agentCtxFor("claim-validator", bookId));
      const canonIssues = claimValidator.validateCanonClaims({
        claims: extracted.claims,
        relations: extracted.systemRelations,
      });
      for (const issue of canonIssues) {
        this.config.logger?.warn?.(
          `[claim-validator] ${issue.severity}:${issue.code}` +
          `${issue.claimId ? `:${issue.claimId}` : ""} ${issue.message}`,
        );
      }
      await saveCanonBundle(bookDir, {
        claims: { claims: [...extracted.claims] },
        worldSystem: extracted.worldSystem,
        protagonistSystem: extracted.protagonistSystem,
        systemRelations: extracted.systemRelations,
      });
      for (const warning of extracted.warnings) {
        this.config.logger?.warn?.(`[canon-extractor] ${warning}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (strict) throw error;
      this.config.logger?.warn?.(`[canon-extractor] skipped: ${message}`);
    }
  }

  /**
   * Revise an existing book foundation without touching runtime episode state.
   *
   * Legacy books read the flat foundation files as source. Phase 5+ books read
   * the authoritative outline/ and roles/ files instead of the compatibility
   * shims, otherwise large role/story details can be lost during rewrite.
   */
  async reviseFoundation(bookId: string, feedback: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const isPhase5 = await isNewLayoutBook(bookDir);
    const transactionId = randomUUID();
    const stagingBookDir = join(bookDir, `.foundation-revise-${transactionId}`);
    const stagingStoryDir = join(stagingBookDir, "story");
    await mkdir(stagingBookDir, { recursive: true });
    try {
      await cp(storyDir, stagingStoryDir, { recursive: true });
      await cp(join(bookDir, "book.json"), join(stagingBookDir, "book.json"));

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupTag = isPhase5 ? "phase5" : "phase4";
      const backupDir = join(stagingStoryDir, `.backup-${backupTag}-${timestamp}`);
      await mkdir(backupDir, { recursive: true });

      const flatFiles = ["story_bible.md", "volume_outline.md", "book_rules.md", "character_matrix.md"];
      for (const fileName of flatFiles) {
        try {
          const content = await readFile(join(storyDir, fileName), "utf-8");
          await writeFile(join(backupDir, fileName), content, "utf-8");
        } catch {
          // Missing legacy shim files are fine for partially migrated books.
        }
      }

      if (isPhase5) {
        await this.copyDirShallow(join(storyDir, "outline"), join(backupDir, "outline"));
        await this.copyDirRecursive(join(storyDir, "roles"), join(backupDir, "roles"));
      }

      const book = await this.state.loadBookConfig(bookId);
      let oldStoryBible: string;
      let oldVolumeOutline: string;
      let oldBookRules: string;
      let oldCharacterMatrix: string;

      if (isPhase5) {
        [oldStoryBible, oldVolumeOutline, oldCharacterMatrix] = await Promise.all([
          readStoryFrame(bookDir),
          readVolumeMap(bookDir),
          readCharacterContext(bookDir),
        ]);
        oldBookRules = await readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => "");
      } else {
        [oldStoryBible, oldVolumeOutline, oldBookRules, oldCharacterMatrix] = await Promise.all([
          readFile(join(storyDir, "story_bible.md"), "utf-8").catch(() => ""),
          readFile(join(storyDir, "volume_outline.md"), "utf-8").catch(() => ""),
          readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => ""),
          readFile(join(storyDir, "character_matrix.md"), "utf-8").catch(() => ""),
        ]);
      }

      const architect = new ArchitectAgent(this.agentCtxFor("architect", bookId));
      const foundation = await architect.generateFoundation(book, undefined, undefined, {
        reviseFrom: {
          storyBible: oldStoryBible,
          volumeOutline: oldVolumeOutline,
          bookRules: oldBookRules,
          characterMatrix: oldCharacterMatrix,
          userFeedback: feedback,
        },
      });

      const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", bookId));
      const resolvedLanguage = (book.language ?? "zh") === "en" ? "en" as const : "zh" as const;
      try {
        const review = await reviewer.review({
          foundation,
          mode: "original",
          language: resolvedLanguage,
          targetEpisodes: book.targetEpisodes,
        } as Parameters<FoundationReviewerAgent["review"]>[0]);
        if (!review.passed) {
          this.config.logger?.warn?.(
            `[reviseFoundation] Foundation review did not pass; accepting rewrite. Feedback: ${review.overallFeedback ?? ""}`,
          );
        }
      } catch (error) {
        this.config.logger?.warn?.(
          `[reviseFoundation] Foundation review failed and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const outlineDir = join(stagingStoryDir, "outline");
      await mkdir(outlineDir, { recursive: true });
      await mkdir(join(stagingStoryDir, "roles", "主要角色"), { recursive: true });
      await mkdir(join(stagingStoryDir, "roles", "次要角色"), { recursive: true });

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      await architect.writeFoundationFiles(
        stagingBookDir,
        foundation,
        gp.numericalSystem,
        book.language ?? gp.language,
        "revise",
      );

      // Canon is part of the same transaction: a revised foundation must never
      // become visible while story/canon still describes the previous version.
      await this.extractInitialCanon(
        stagingBookDir,
        bookId,
        resolvedLanguage,
        resolvedLanguage,
        true,
      );

      const rollbackStoryDir = join(bookDir, `.foundation-revise-rollback-${transactionId}`);
      await renamePathWithRetry(storyDir, rollbackStoryDir);
      try {
        await renamePathWithRetry(stagingStoryDir, storyDir);
      } catch (error) {
        await renamePathWithRetry(rollbackStoryDir, storyDir).catch(() => undefined);
        throw error;
      }
      await rm(rollbackStoryDir, { recursive: true, force: true }).catch((error) => {
        this.config.logger?.warn?.(
          `[reviseFoundation] Could not remove rollback directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } finally {
      await rm(stagingBookDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async copyDirShallow(src: string, dest: string): Promise<void> {
    try {
      await mkdir(dest, { recursive: true });
      const entries = await readdir(src);
      await Promise.all(entries.map(async (entry) => {
        try {
          const content = await readFile(join(src, entry), "utf-8");
          await writeFile(join(dest, entry), content, "utf-8");
        } catch {
          // Skip unreadable files.
        }
      }));
    } catch {
      // Source directory does not exist.
    }
  }

  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    try {
      await mkdir(dest, { recursive: true });
      const entries = await readdir(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          await this.copyDirRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          try {
            const content = await readFile(srcPath, "utf-8");
            await writeFile(destPath, content, "utf-8");
          } catch {
            // Skip unreadable files.
          }
        }
      }
    } catch {
      // Source directory does not exist.
    }
  }

  /**
   * Create a side-story (番外) book: a standalone companion that inherits a
   * parent book's world/characters via parent_canon.md, but tells an INDEPENDENT
   * side plot that does not advance or contradict the parent's main-line state.
   * Reuses importCanon (which already builds the parent-canon reference for
   * side-story writing) + the standard original-foundation architect path.
   */
  async initSpinoffBook(book: BookConfig, parentBookId: string, direction?: string): Promise<void> {
    const bookDir = this.state.bookDir(book.id);
    const stageLanguage = await this.resolveBookLanguage(book);

    this.logStage(stageLanguage, { zh: "保存书籍配置", en: "saving book config" });
    await this.state.saveBookConfig(book.id, book);

    this.logStage(stageLanguage, { zh: "导入正传正典参照", en: "importing parent canon" });
    const parentCanon = await this.importCanon(book.id, parentBookId);

    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const reviewer = new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", book.id));
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const resolvedLanguage = (book.language ?? gp.language) === "en" ? "en" as const : "zh" as const;
    const spinoffContext = buildSpinoffFoundationContext(parentCanon, direction, resolvedLanguage);

    this.logStage(stageLanguage, { zh: "生成番外基础设定", en: "generating side-story foundation" });
    const foundation = await this.generateAndReviewFoundation({
      generate: (reviewFeedback) => architect.generateFoundation(book, spinoffContext, reviewFeedback),
      reviewer,
      mode: "original",
      language: resolvedLanguage,
      stageLanguage,
      bookId: book.id,
      targetEpisodes: book.targetEpisodes,
    });

    this.logStage(stageLanguage, { zh: "写入基础设定文件", en: "writing foundation files" });
    await architect.writeFoundationFiles(bookDir, foundation, gp.numericalSystem, book.language ?? gp.language);

    // Extract structured canon for the side-story so its claim gates have canon
    // to work against. Extraction failure is non-fatal (logged as warning).
    await this.extractInitialCanon(bookDir, book.id, resolvedLanguage, stageLanguage);

    this.logStage(stageLanguage, { zh: "初始化控制文档", en: "initializing control documents" });
    await this.state.ensureControlDocuments(book.id, direction?.trim() || this.config.externalContext);

    this.logStage(stageLanguage, { zh: "创建初始快照", en: "creating initial snapshot" });
    await mkdir(join(bookDir, "episodes"), { recursive: true });
    await this.state.saveEpisodeIndex(book.id, []);
    await this.state.snapshotState(book.id, 0);
  }

  /** Write a single draft episode. Saves episode file + truth files + index + snapshot. */
  async writeDraft(bookId: string, context?: string, episodeDurationSeconds?: number): Promise<DraftResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    const operationId = this.startOperation(bookId);
    let persistenceEpisode: number | null = null;
    try {
      this.throwIfAborted();
      const recovery = await this.state.recoverIncompleteEpisodePersistence(bookId);
      await this.state.ensureControlDocuments(bookId);
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const episodeNumber = await this.state.getNextEpisodeNumber(bookId);
      const stageLanguage = await this.resolveBookLanguage(book);
      this.logStage(stageLanguage, { zh: "准备剧集输入", en: "preparing episode inputs" });
      const previousEpisodeScript = book.format === "screenplay"
        ? await loadPersistedEpisodeScript(bookDir, episodeNumber - 1)
        : undefined;
      const writeInput = await this.prepareWriteInput(
        book,
        bookDir,
        episodeNumber,
        context ?? this.config.externalContext,
        previousEpisodeScript?.contract.handoffState,
      );

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const lengthSpec = buildLengthSpec(
        episodeDurationSeconds ?? book.episodeDurationSeconds,
        book.language ?? gp.language,
      );

      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      this.logStage(stageLanguage, { zh: "撰写剧集草稿", en: "writing episode draft" });
      const { output, writerFailedUsage } = await this.writeEpisodeWithRetry({
        writer,
        book,
        bookDir,
        episodeNumber,
        writeInput,
        lengthSpec,
        episodeDurationSeconds,
      });
      const screenplayBook = book.format === "screenplay" || book.schemaVersion === "inkos-episode-v2";
      this.throwIfAborted();
      const writerCount = output.episodeScriptMetrics
        ? output.episodeScriptMetrics.estimatedDurationSeconds
        : countEpisodeLength(output.content, lengthSpec.countingMode);
      let totalUsage: TokenUsageSummary = output.tokenUsage ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      if (writerFailedUsage) {
        totalUsage = {
          promptTokens: totalUsage.promptTokens + writerFailedUsage.promptTokens,
          completionTokens: totalUsage.completionTokens + writerFailedUsage.completionTokens,
          totalTokens: totalUsage.totalTokens + writerFailedUsage.totalTokens,
        };
      }
      const normalizedDraft = this.normalizeEpisodeScriptProjection({
        episodeNumber,
        episodeContent: output.content,
        targetDurationSeconds: book.episodeDurationSeconds,
      });
      const draftOutput: WriteEpisodeOutput = {
        ...output,
        content: normalizedDraft.content,
        episodeDurationSeconds: normalizedDraft.episodeDurationSeconds,
        tokenUsage: totalUsage,
      };
      const lengthWarnings = draftOutput.episodeScriptMetrics
        ? this.buildEpisodeDurationWarnings(episodeNumber, draftOutput.episodeScriptMetrics)
        : this.buildLengthWarnings(episodeNumber, draftOutput.episodeDurationSeconds, lengthSpec);
      const lengthTelemetry = draftOutput.episodeScriptMetrics
        ? undefined
        : this.buildLengthTelemetry({
            lengthSpec,
            writerCount,
            postWriterNormalizeCount: normalizedDraft.episodeDurationSeconds,
            postReviseCount: 0,
            finalCount: draftOutput.episodeDurationSeconds,
            normalizeApplied: normalizedDraft.applied,
            lengthWarning: lengthWarnings.length > 0,
          });
      this.logLengthWarnings(lengthWarnings);
      this.throwIfAborted();

      // Save episode file
      const episodesDir = join(bookDir, "episodes");
      const paddedNum = String(episodeNumber).padStart(4, "0");
      const sanitized = draftOutput.title.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").slice(0, 50);
      const filename = `${paddedNum}_${sanitized}.md`;
      const filePath = join(episodesDir, filename);

      const resolvedLang = book.language ?? gp.language;
      const heading = resolvedLang === "en"
        ? `# Episode ${episodeNumber}: ${draftOutput.title}`
        : `# 第${episodeNumber}集 ${draftOutput.title}`;
      await this.state.beginEpisodePersistence(bookId, episodeNumber, operationId);
      persistenceEpisode = episodeNumber;
      this.throwIfAborted();
      await writeFile(filePath, `${heading}\n\n${draftOutput.content}`, "utf-8");

      // Save truth files
      this.logStage(stageLanguage, { zh: "落盘草稿与真相文件", en: "persisting draft and truth files" });
      this.throwIfAborted();
      await writer.saveEpisode(bookDir, draftOutput, gp.numericalSystem, resolvedLang);
      this.throwIfAborted();
      await writer.saveNewTruthFiles(bookDir, draftOutput, resolvedLang);
      this.throwIfAborted();
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, episodeNumber, draftOutput);
      this.throwIfAborted();
      await this.syncNarrativeMemoryIndex(bookId);

      // Update index
      const existingIndex = await this.state.loadEpisodeIndex(bookId);
      const now = new Date().toISOString();
      const newEntry: EpisodeMeta = {
        episodeNumber: episodeNumber,
        title: draftOutput.title,
        status: "drafted",
        episodeDurationSeconds: draftOutput.episodeDurationSeconds,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        lengthWarnings,
        lengthTelemetry,
        ...(draftOutput.tokenUsage ? { tokenUsage: draftOutput.tokenUsage } : {}),
        operationId,
      };
      const existingIdx = existingIndex.findIndex((e) => e.episodeNumber === episodeNumber);
      const updatedIndex = existingIdx >= 0
        ? existingIndex.map((e, i) => i === existingIdx ? newEntry : e)
        : [...existingIndex, newEntry];
      this.throwIfAborted();
      await this.state.saveEpisodeIndex(bookId, updatedIndex);
      this.throwIfAborted();
      await this.markBookActiveIfNeeded(bookId);

      // Snapshot
      this.logStage(stageLanguage, { zh: "更新剧集索引与快照", en: "updating episode index and snapshots" });
      this.throwIfAborted();
      await this.state.snapshotState(bookId, episodeNumber);
      this.throwIfAborted();
      await this.syncCurrentStateFactHistory(bookId, episodeNumber);
      this.throwIfAborted();
      await this.state.commitEpisodePersistence(bookId, episodeNumber, operationId);
      persistenceEpisode = null;

      await this.emitWebhook("episode-complete", bookId, episodeNumber, {
        title: draftOutput.title,
        episodeDurationSeconds: draftOutput.episodeDurationSeconds,
      });

      return {
        operationId,
        episodeNumber,
        title: draftOutput.title,
        episodeDurationSeconds: draftOutput.episodeDurationSeconds,
        filePath,
        lengthWarnings,
        lengthTelemetry,
        tokenUsage: draftOutput.tokenUsage,
        ...(recovery.kind === "none" ? {} : { recovery }),
      };
    } catch (error) {
      if (persistenceEpisode !== null) {
        try {
          await this.state.abortEpisodePersistence(bookId, persistenceEpisode);
        } catch (rollbackError) {
          throw new Error(
            `Episode ${persistenceEpisode} persistence failed and rollback also failed: ${String(rollbackError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      this.finishOperation(bookId, operationId);
      await releaseLock();
    }
  }

  async planEpisode(bookId: string, context?: string): Promise<PlanEpisodeResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    await this.assertCanonRefreshBacklog(bookId, bookDir);
    const episodeNumber = await this.state.getNextEpisodeNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "规划下一集意图", en: "planning next episode intent" });
    const { plan } = await this.createGovernedArtifacts(
      book,
      bookDir,
      episodeNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: false },
    );

    // STY-16 capacity feasibility hint (non-blocking): scale the memo's text
    // volume by accepted-episode ratios and count promised beats. Skipped
    // silently when the book has fewer than 3 accepted episodes.
    const capacity = await this.estimatePlanEpisodeCapacity(book, bookId, plan.memo, stageLanguage);

    return {
      bookId,
      episodeNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: [],
      ...(capacity ? { capacity } : {}),
    };
  }

  private async estimatePlanEpisodeCapacity(
    book: { readonly episodeDurationSeconds?: number },
    bookId: string,
    memo: EpisodeMemo | undefined,
    language: "zh" | "en",
  ): Promise<PlanEpisodeCapacity | undefined> {
    if (!memo) return undefined;
    const commitments = summarizeMemoCapacityCommitments(memo);
    const acceptedStatuses = new Set(["ready-for-review", "approved", "published"]);
    const index = await this.state.loadEpisodeIndex(bookId).catch(() => [] as const);
    const samples = index
      .filter((entry) => acceptedStatuses.has(entry.status) && entry.episodeScriptMetrics)
      .map((entry) => entry.episodeScriptMetrics!);
    const baseline = buildEpisodeCapacityBaseline(samples);
    const estimate = baseline
      ? estimateEpisodeCapacityFromPlan(memo.body, baseline, {
          targetDurationSeconds: book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
        })
      : undefined;
    const notes = [estimate?.note, commitments.note]
      .filter((note): note is { readonly zh: string; readonly en: string } => Boolean(note))
      .map((note) => language === "en" ? note.en : note.zh);
    if (!estimate && notes.length === 0) return undefined;
    return {
      ...(estimate ? {
        estimatedShots: estimate.estimatedShots,
        estimatedDurationSeconds: estimate.estimatedDurationSeconds,
      } : {}),
      promisedBeats: commitments.promisedBeats,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }

  async composeEpisode(bookId: string, context?: string): Promise<ComposeEpisodeResult> {
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const episodeNumber = await this.state.getNextEpisodeNumber(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "组装剧集运行时上下文", en: "composing episode runtime context" });
    const { plan, composed } = await this.createGovernedArtifacts(
      book,
      bookDir,
      episodeNumber,
      context ?? this.config.externalContext,
      { reuseExistingIntentWhenContextMissing: true },
    );

    return {
      bookId,
      episodeNumber,
      intentPath: relativeToBookDir(bookDir, plan.runtimePath),
      goal: plan.intent.goal,
      conflicts: [],
      contextPath: relativeToBookDir(bookDir, composed.contextPath),
      ruleStackPath: relativeToBookDir(bookDir, composed.ruleStackPath),
      tracePath: relativeToBookDir(bookDir, composed.tracePath),
    };
  }

  /** Audit the latest (or specified) episode. Callers that expose mutations must own the book lock. */
  async auditDraft(bookId: string, episodeNumber?: number): Promise<AuditResult & { readonly episodeNumber: number }> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetEpisode = episodeNumber ?? (await this.state.getNextEpisodeNumber(bookId)) - 1;
    if (targetEpisode < 1) {
      throw new Error(`No episodes to audit for "${bookId}"`);
    }

    const content = await this.readEpisodeContent(bookDir, targetEpisode);
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const language = book.language ?? gp.language;
    const governedInput = await loadPersistedGovernedEpisodeInput(bookDir, targetEpisode);
    if (!governedInput?.contextPackage || !governedInput.ruleStack) {
      throw new Error(
        `EPISODE_CONTEXT_INCOMPLETE: persisted governed artifacts are missing for episode ${targetEpisode}.`,
      );
    }
    const auditorCtx = this.agentCtxFor("auditor", bookId);
    const episodeContextSnapshot = await loadEpisodeContextSnapshot({
      bookDir,
      episode: targetEpisode,
      model: auditorCtx.model,
      service: auditorCtx.client.service ?? "unknown",
    });
    attachEpisodeContextArtifacts(
      episodeContextSnapshot,
      governedInput.contextPackage,
      governedInput.ruleStack,
    );
    const auditOptions = {
      episodeContextSnapshot,
      episodeIntent: governedInput.plan?.intentMarkdown,
      episodeMemo: governedInput.plan?.memo,
      contextPackage: governedInput.contextPackage,
      ruleStack: governedInput.ruleStack,
    };
    const auditGates = await this.prepareEpisodeAuditGates({
      bookId,
      bookDir,
      episodeNumber: targetEpisode,
      language,
      genreProfile: gp,
      episodeMemo: governedInput?.plan?.memo,
      contextPackage: governedInput?.contextPackage,
    });
    this.logStage(language, {
      zh: `审计第${targetEpisode}集`,
      en: `auditing episode ${targetEpisode}`,
    });
    const evaluation = await this.evaluateMergedAudit({
      auditor,
      book,
      bookDir,
      episodeContent: content,
      episodeNumber: targetEpisode,
      language,
      auditOptions,
      runPostWriteChecks: auditGates.runPostWriteChecks,
    });
    const episodeScript = await loadPersistedEpisodeScript(bookDir, targetEpisode);
    const previousEpisodeScript = episodeScript
      ? await loadPersistedEpisodeScript(bookDir, targetEpisode - 1)
      : undefined;
    const recentScripts = await loadRecentEpisodeScripts(bookDir, targetEpisode);
    const settingsIndex = await buildSettingsEntityIndex(bookDir, targetEpisode);
    const episodeIssues = episodeScript
      ? (await import("./episode-quality-gate.js")).auditEpisodeScript(
          episodeScript,
          previousEpisodeScript,
          book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
          settingsIndex,
          recentScripts,
          language,
        )
      : [];
    // Deterministic early-payoff guard on the standalone audit path (the write
    // path already applies it): re-auditing a persisted episode should surface
    // the same premature-reveal warning the writer gate would have emitted.
    if (episodeScript) {
      const hooksMarkdown = await readFile(join(bookDir, "story", "pending_hooks.md"), "utf-8").catch(() => "");
      if (hooksMarkdown) {
        const { auditEarlyHookPayoff } = await import("./episode-quality-gate.js");
        const { parsePendingHooksMarkdown } = await import("../utils/story-markdown.js");
        episodeIssues.push(...auditEarlyHookPayoff(episodeScript, parsePendingHooksMarkdown(hooksMarkdown)));
      }
    }
    const result: AuditResult = {
      ...evaluation.auditResult,
      issues: deduplicateAuditIssues([...evaluation.auditResult.issues, ...episodeIssues]),
    };

    if (episodeScript) {
      const episodesDir = join(bookDir, "episodes");
      const paddedNum = String(targetEpisode).padStart(4, "0");
      const episodeFiles = await readdir(episodesDir).catch(() => []);
      const jsonFilename = episodeFiles.find((file) =>
        file.startsWith(`${paddedNum}_`) && file.endsWith(".json") && !file.endsWith("_review.json"),
      );
      if (jsonFilename) {
        const jsonContent = await readFile(join(episodesDir, jsonFilename), "utf8");
        const evidence = buildEpisodeReviewEvidence({
          artifact: `episodes/${jsonFilename}`,
          content: jsonContent,
          issues: result.issues,
        });
        await writeFile(
          join(episodesDir, `${paddedNum}_review.json`),
          `${JSON.stringify(evidence, null, 2)}\n`,
          "utf8",
        );
      }
      // Self-heal: the write path above already records richer evidence when
      // present; this deterministic rebuild only fills gaps (e.g. a lost or
      // never-written sidecar) and never overwrites an existing file.
      await ensureEpisodeReviewSidecar({
        bookDir,
        episode: targetEpisode,
        targetDurationSeconds: book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
      });
      // Canon evolves with the story: an audited episode that establishes a
      // claim fact settles it and records character knowledge. Idempotent.
      await applyEpisodeCanonUpdates({ bookDir, script: episodeScript });
    }

    // Update index with audit result
    const index = await this.state.loadEpisodeIndex(bookId);
    const targetMeta = index.find((episode) => episode.episodeNumber === targetEpisode);
    const hasDurableSnapshot = await stat(
      join(bookDir, "story", "snapshots", String(targetEpisode)),
    ).then((entry) => entry.isDirectory()).catch(() => false);
    const stateRepairIssue: AuditIssue | undefined = deriveAuditPassed(result) && !hasDurableSnapshot
      ? {
          severity: "warning",
          category: "state-sync-required",
          description: language === "en"
            ? `Episode ${targetEpisode} passed audit, but its durable truth snapshot is missing.`
            : `第${targetEpisode}集审计已通过，但缺少对应的持久化真相快照。`,
          suggestion: language === "en"
            ? "Repair or resync episode state before continuing to the next episode."
            : "继续写下一集前，请先修复或重新同步本集状态。",
          repairScope: "structural",
        }
      : undefined;
    const effectiveResult: AuditResult = stateRepairIssue
      ? { ...result, issues: [...result.issues, stateRepairIssue] }
      : result;
    const quality = resolveEpisodeReviewStatus({
      auditResult: effectiveResult,
      stateDegraded: stateRepairIssue !== undefined,
    });
    const updated = index.map((ch) =>
      ch.episodeNumber === targetEpisode
        ? {
            ...ch,
            status: quality.status as EpisodeMeta["status"],
            updatedAt: new Date().toISOString(),
            auditIssues: effectiveResult.issues.map((i) => `[${i.severity}] ${i.description}`),
            reviewNote: stateRepairIssue
              ? buildStateDegradedReviewNote("ready-for-review", [stateRepairIssue])
              : targetMeta?.status === "state-degraded" ? undefined : ch.reviewNote,
            recoveryState: buildEpisodeRecoveryState({
              content,
              issues: result.issues,
              operationId: ch.operationId,
            }),
          }
        : ch,
    );
    await this.state.saveEpisodeIndex(bookId, updated);
    const latestEpisode = index.length > 0 ? Math.max(...index.map((episode) => episode.episodeNumber)) : targetEpisode;
    if (targetEpisode === latestEpisode) {
      await this.persistAuditDriftGuidance({
        bookDir,
        episodeNumber: targetEpisode,
        issues: effectiveResult.issues.filter((issue) => issue.severity === "critical" || issue.severity === "warning"),
        language,
      }).catch(() => undefined);
    }

    await this.emitWebhook(
      quality.status === "ready-for-review" ? "audit-passed" : "audit-failed",
      bookId,
      targetEpisode,
      { summary: effectiveResult.summary, issueCount: effectiveResult.issues.length },
    );

    return {
      ...effectiveResult,
      passed: deriveAuditPassed(effectiveResult),
      episodeNumber: targetEpisode,
    };
  }

  /** Revise the latest (or specified) episode based on audit issues. */
  async auditEpisode(bookId: string, episodeNumber?: number): Promise<AuditResult & { readonly episodeNumber: number }> {
    await this.state.loadEpisodeBookConfig(bookId);
    const result = await this.auditDraft(bookId, episodeNumber);
    const { episodeNumber: auditedEpisodeNumber, ...rest } = result;
    return { ...rest, episodeNumber: auditedEpisodeNumber };
  }

  async reviseDraft(bookId: string, episodeNumber?: number, mode: ReviseMode = DEFAULT_REVISE_MODE, externalContext?: string): Promise<ReviseResult> {
    mode = ReviseModeSchema.parse(mode);
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      const recovery = await this.state.recoverIncompleteEpisodePersistence(bookId);
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetEpisode = episodeNumber ?? (await this.state.getNextEpisodeNumber(bookId)) - 1;
      if (targetEpisode < 1) {
        throw new Error(`No episodes to revise for "${bookId}"`);
      }

      const stageLanguage = await this.resolveBookLanguage(book);
      // Read the current audit issues from index
      this.logStage(stageLanguage, {
        zh: `加载第${targetEpisode}集修订上下文`,
        en: `loading revision context for episode ${targetEpisode}`,
      });
      const index = await this.state.loadEpisodeIndex(bookId);
      const episodeMeta = index.find((ch) => ch.episodeNumber === targetEpisode);
      if (!episodeMeta) {
        throw new Error(`Episode ${targetEpisode} not found in index`);
      }

      // Re-audit to get structured issues (index only stores strings)
      const content = await this.readEpisodeContent(bookDir, targetEpisode);
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const screenplayBook = book.format === "screenplay" || book.schemaVersion === "inkos-episode-v2";
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const language = book.language ?? gp.language;
      const countingMode = resolveLengthCountingMode(language);
      const effectiveExternalContext = externalContext ?? this.config.externalContext;
      const reviseControlInput = await this.createGovernedArtifacts(
        book,
        bookDir,
        targetEpisode,
        effectiveExternalContext,
        { reuseExistingIntentWhenContextMissing: true },
      );
      let preRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        episodeContent: content,
        episodeNumber: targetEpisode,
        language,
        auditOptions: {
          episodeIntent: reviseControlInput.plan.intentMarkdown,
          episodeMemo: reviseControlInput.plan.memo,
          contextPackage: reviseControlInput.composed.contextPackage,
          ruleStack: reviseControlInput.composed.ruleStack,
          episodeContextSnapshot: reviseControlInput.episodeContextSnapshot,
        },
      });

      // The deterministic screenplay gate is authoritative for structural
      // findings (emotional hook, character references, duration). A fresh
      // LLM-only re-audit can miss them, which previously made revise refuse
      // to act ("no executable blocking evidence"). Merge them so known
      // blocking findings always reach the reviser.
      if (screenplayBook) {
        try {
          const script = parseEpisodeScriptOutput(content, targetEpisode);
          const previousScript = await loadPersistedEpisodeScript(bookDir, targetEpisode - 1);
          const recentScripts = await loadRecentEpisodeScripts(bookDir, targetEpisode);
          const deterministicIssues = auditEpisodeScript(
            script,
            previousScript,
            book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
            await buildSettingsEntityIndex(bookDir, targetEpisode),
            recentScripts,
            language,
          );
          const mergedBlocking = deduplicateAuditIssues([
            ...preRevision.revisionBlockingIssues,
            ...deterministicIssues.filter((issue) => issue.severity !== "info"),
          ]);
          preRevision = {
            ...preRevision,
            auditResult: {
              ...preRevision.auditResult,
              issues: deduplicateAuditIssues([
                ...preRevision.auditResult.issues,
                ...deterministicIssues,
              ]),
            },
            revisionBlockingIssues: mergedBlocking,
            blockingCount: mergedBlocking.filter(
              (issue) => issue.severity === "warning" || issue.severity === "critical",
            ).length,
            criticalCount: mergedBlocking.filter(
              (issue) => issue.severity === "critical",
            ).length,
          };
        } catch {
          // Keep the LLM-only evaluation when local parsing is unavailable.
        }
      }

      const persistCurrentRecoveryState = async (params: {
        readonly issues: ReadonlyArray<AuditIssue>;
        readonly status?: EpisodeMeta["status"];
        readonly auditIssues?: ReadonlyArray<string>;
        readonly reviewNote?: string;
        readonly terminationReason?: string;
      }): Promise<void> => {
        const now = new Date().toISOString();
        await this.state.saveEpisodeIndex(bookId, index.map((episode) =>
          episode.episodeNumber === targetEpisode
            ? {
                ...episode,
                status: params.status ?? episode.status,
                updatedAt: now,
                auditIssues: params.auditIssues
                  ? [...params.auditIssues]
                  : params.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
                reviewNote: params.reviewNote,
                recoveryState: buildEpisodeRecoveryState({
                  content,
                  issues: params.issues,
                  operationId: episode.operationId,
                  terminationReason: params.terminationReason,
                  now: () => now,
                }),
              }
            : episode,
        ));
      };

      if (preRevision.blockingCount === 0 && preRevision.aiTellCount === 0) {
        if (deriveAuditPassed(preRevision.auditResult)) {
          const hasDurableSnapshot = await stat(
            join(bookDir, "story", "snapshots", String(targetEpisode)),
          ).then((entry) => entry.isDirectory()).catch(() => false);
          const stateRepairIssue: AuditIssue | undefined = hasDurableSnapshot
            ? undefined
            : {
                severity: "warning",
                category: "state-sync-required",
                description: language === "en"
                  ? `Episode ${targetEpisode} passed re-audit, but its durable truth snapshot is missing.`
                  : `第${targetEpisode}集重新审计已通过，但缺少对应的持久化真相快照。`,
                suggestion: language === "en"
                  ? "Repair or resync episode state before continuing."
                  : "继续写作前，请修复或重新同步本集状态。",
                repairScope: "structural",
              };
          await persistCurrentRecoveryState({
            issues: [],
            status: stateRepairIssue ? "state-degraded" : "ready-for-review",
            auditIssues: stateRepairIssue
              ? [`[warning] ${stateRepairIssue.description}`]
              : [],
            reviewNote: stateRepairIssue
              ? buildStateDegradedReviewNote("ready-for-review", [stateRepairIssue])
              : undefined,
            terminationReason: "re-audit-passed-without-revision",
          });
          return {
            episodeNumber: targetEpisode,
            episodeDurationSeconds: countEpisodeLength(content, countingMode),
            fixedIssues: [],
            applied: false,
            status: stateRepairIssue ? "state-degraded" : "ready-for-review",
            skippedReason: stateRepairIssue
              ? "Episode re-audit passed, but state resync is required before continuing."
              : "Episode re-audit passed without requiring revision.",
            ...(recovery.kind === "none" ? {} : { recovery }),
          };
        }

        const unverifiableIssue: AuditIssue = {
          severity: "critical",
          category: "audit-unverifiable",
          description: language === "en"
            ? "The episode audit did not pass and exposed no actionable evidence."
            : "剧集审计未通过，但没有提供可执行的阻断证据。",
          suggestion: language === "en"
            ? "Re-audit the current episode before attempting another content mutation."
            : "再次修改剧本前，请先重新审计当前剧集。",
          repairScope: "unknown",
        };
        await persistCurrentRecoveryState({
          issues: [unverifiableIssue],
          status: "audit-failed",
          terminationReason: "audit-unverifiable",
        });
        return {
          episodeNumber: targetEpisode,
          episodeDurationSeconds: countEpisodeLength(content, countingMode),
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: unverifiableIssue.description,
          ...(recovery.kind === "none" ? {} : { recovery }),
        };
      }

      const episodeLengthTarget = episodeMeta.lengthTelemetry?.target ?? 3000;
      const lengthLanguage = episodeMeta.lengthTelemetry?.countingMode === "en_words"
        ? "en"
        : language;
      const lengthSpec = buildLengthSpec(
        episodeLengthTarget,
        lengthLanguage,
      );

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.logStage(stageLanguage, {
        zh: `修订第${targetEpisode}集`,
        en: `revising episode ${targetEpisode}`,
      });
      const reviseOutput = await reviser.reviseEpisode(
        bookDir,
        content,
        targetEpisode,
        preRevision.auditResult.issues,
        mode,
        book.genre,
        {
          episodeIntent: reviseControlInput.plan.intentMarkdown,
          episodeMemo: reviseControlInput.plan.memo,
          episodeIntentData: reviseControlInput.plan.intent,
          contextPackage: reviseControlInput.composed.contextPackage,
          ruleStack: reviseControlInput.composed.ruleStack,
          episodeContextSnapshot: reviseControlInput.episodeContextSnapshot,
          lengthSpec,
          targetDurationSeconds: book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
        },
      );

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }
      const normalizedRevision = this.normalizeEpisodeScriptProjection({
        episodeNumber: targetEpisode,
        episodeContent: reviseOutput.revisedContent,
        targetDurationSeconds: book.episodeDurationSeconds,
      });
      const postRevision = await this.evaluateMergedAudit({
        auditor,
        book,
        bookDir,
        episodeContent: normalizedRevision.content,
        episodeNumber: targetEpisode,
        language,
        auditOptions: {
          temperature: 0,
          episodeIntent: reviseControlInput.plan.intentMarkdown,
          episodeMemo: reviseControlInput.plan.memo,
          contextPackage: reviseControlInput.composed.contextPackage,
          ruleStack: reviseControlInput.composed.ruleStack,
          episodeContextSnapshot: reviseControlInput.episodeContextSnapshot,
          truthFileOverrides: {
            currentState: reviseOutput.updatedState !== "(状态卡未更新)" ? reviseOutput.updatedState : undefined,
            ledger: reviseOutput.updatedLedger !== "(账本未更新)" ? reviseOutput.updatedLedger : undefined,
            hooks: reviseOutput.updatedHooks !== "(伏笔池未更新)" ? reviseOutput.updatedHooks : undefined,
          },
        },
      });
      const effectivePostRevision = this.restoreActionableAuditIfLost(
        preRevision,
        postRevision,
      );
      const revisionBaseCount = countEpisodeLength(content, lengthSpec.countingMode);
      const lengthWarnings = this.buildLengthWarnings(
        targetEpisode,
        normalizedRevision.episodeDurationSeconds,
        lengthSpec,
      );
      const lengthTelemetry = this.buildLengthTelemetry({
        lengthSpec,
        writerCount: revisionBaseCount,
        postWriterNormalizeCount: 0,
        postReviseCount: normalizedRevision.episodeDurationSeconds,
        finalCount: normalizedRevision.episodeDurationSeconds,
        normalizeApplied: normalizedRevision.applied,
        lengthWarning: lengthWarnings.length > 0,
      });

      // Severity-weighted comparison: a removed critical is worth more than a
      // few added warnings. Pure blocking-count ordering used to reject
      // candidates that fixed a critical but introduced new warnings, making
      // manual revision unable to converge (observed in production testing).
      const warningsOf = (counts: { readonly blockingCount: number; readonly criticalCount: number }): number =>
        Math.max(0, counts.blockingCount - counts.criticalCount);
      const severityScore = (counts: { readonly blockingCount: number; readonly criticalCount: number }): number =>
        counts.criticalCount * 10 + warningsOf(counts);
      const improvedSeverity = severityScore(effectivePostRevision) < severityScore(preRevision);
      const severityDidNotWorsen = severityScore(effectivePostRevision) <= severityScore(preRevision);
      const criticalDidNotWorsen = effectivePostRevision.criticalCount <= preRevision.criticalCount;
      const improvedAITells = effectivePostRevision.aiTellCount < preRevision.aiTellCount;
      const aiDidNotWorsen = effectivePostRevision.aiTellCount <= preRevision.aiTellCount;
      const didNotWorsen = severityDidNotWorsen && criticalDidNotWorsen && aiDidNotWorsen;
      const revisionGate = this.config.revisionGate ?? "strict";
      const shouldApplyRevision = revisionGate === "always"
        ? true
        : revisionGate === "lenient"
          ? didNotWorsen
          : criticalDidNotWorsen && aiDidNotWorsen
            && (improvedSeverity || (severityDidNotWorsen && improvedAITells));

      if (!shouldApplyRevision) {
        const remainingIssues = effectivePostRevision.revisionBlockingIssues
          .filter((issue) => issue.severity === "warning" || issue.severity === "critical")
          .slice(0, 6)
          .map((issue) => ({
            severity: issue.severity,
            category: issue.category,
            description: issue.description,
            ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
          }));
        await persistCurrentRecoveryState({
          issues: preRevision.auditResult.issues,
          status: "audit-failed",
          terminationReason: "revision-not-applied",
        });
        return {
          episodeNumber: targetEpisode,
          episodeDurationSeconds: revisionBaseCount,
          fixedIssues: [],
          applied: false,
          status: "unchanged",
          skippedReason: `Manual revision kept original episode: before blocking=${preRevision.blockingCount}, critical=${preRevision.criticalCount}, aiTell=${preRevision.aiTellCount}; after blocking=${effectivePostRevision.blockingCount}, critical=${effectivePostRevision.criticalCount}, aiTell=${effectivePostRevision.aiTellCount}.`,
          revisionDiagnostics: {
            standard: REVISION_GATE_STANDARDS[revisionGate],
            before: {
              blockingCount: preRevision.blockingCount,
              criticalCount: preRevision.criticalCount,
              aiTellCount: preRevision.aiTellCount,
            },
            after: {
              blockingCount: effectivePostRevision.blockingCount,
              criticalCount: effectivePostRevision.criticalCount,
              aiTellCount: effectivePostRevision.aiTellCount,
            },
            remainingIssues,
          },
          ...(recovery.kind === "none" ? {} : { recovery }),
        };
      }
      this.logLengthWarnings(lengthWarnings);
      const hardLengthPassed = episodeMeta.lengthTelemetry === undefined || lengthWarnings.length === 0;
      const revisionQuality = resolveEpisodeReviewStatus({
        auditResult: effectivePostRevision.auditResult,
        hardLengthPassed,
      });
      const revisionStatus: Exclude<EpisodeQualityStatus, "state-degraded"> =
        revisionQuality.status === "audit-failed" ? "audit-failed" : "ready-for-review";
      const truthAccepted = revisionStatus === "ready-for-review";

      // Save revised episode file
      this.logStage(stageLanguage, {
        zh: `落盘第${targetEpisode}集修订结果`,
        en: `persisting revision for episode ${targetEpisode}`,
      });
      const episodesDir = join(bookDir, "episodes");
      const files = await readdir(episodesDir);
      const paddedNum = String(targetEpisode).padStart(4, "0");
      const existingFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
      if (!existingFile) {
        throw new Error(`Episode ${targetEpisode} file not found in ${episodesDir} (expected filename starting with ${paddedNum})`);
      }
      const reviseLang = book.language ?? gp.language;
      const reviseHeading = reviseLang === "en"
        ? `# Episode ${targetEpisode}: ${episodeMeta.title}`
        : `# 第${targetEpisode}集 ${episodeMeta.title}`;
      await writeFile(
        join(episodesDir, existingFile),
        `${reviseHeading}\n\n${normalizedRevision.content}`,
        "utf-8",
      );

      // Keep the JSON sidecar in sync with the revised projection. Previously
      // only the .md was rewritten, so deterministic gates that read the JSON
      // (e.g. the emotional-hook question check) kept validating the stale
      // pre-revision script and the episode could never pass (observed in
      // 20-episode production testing).
      const existingJsonFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".json") && !f.endsWith("_review.json"));
      if (existingJsonFile) {
        await writeFile(
          join(episodesDir, existingJsonFile),
          `${JSON.stringify(normalizedRevision.script, null, 2)}\n`,
          "utf-8",
        );
      }

      // An explicit revision may keep a body that still needs review, but
      // failed bodies must not mutate durable truth, memory, or snapshots.
      const storyDir = join(bookDir, "story");
      if (truthAccepted) {
        if (reviseOutput.updatedState !== "(状态卡未更新)") {
          await writeFile(join(storyDir, "current_state.md"), reviseOutput.updatedState, "utf-8");
        }
        if (gp.numericalSystem && reviseOutput.updatedLedger && reviseOutput.updatedLedger !== "(账本未更新)") {
          await writeFile(join(storyDir, "particle_ledger.md"), reviseOutput.updatedLedger, "utf-8");
        }
        if (reviseOutput.updatedHooks !== "(伏笔池未更新)") {
          await writeFile(join(storyDir, "pending_hooks.md"), reviseOutput.updatedHooks, "utf-8");
        }
        await this.upsertAcceptedRevisionSummary({
          storyDir,
          episodeNumber: targetEpisode,
          title: episodeMeta.title,
          content: normalizedRevision.content,
          language,
          changeKind: reviseOutput.changeKind,
        });
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetEpisode);
      }

      // Update index
      const updatedIndex = index.map((ch) =>
        ch.episodeNumber === targetEpisode
          ? {
              ...ch,
              status: revisionStatus,
              episodeDurationSeconds: normalizedRevision.episodeDurationSeconds,
              updatedAt: new Date().toISOString(),
              auditIssues: effectivePostRevision.auditResult.issues.map((i) => `[${i.severity}] ${i.description}`),
              lengthWarnings,
              lengthTelemetry,
              reviewNote: undefined,
              recoveryState: buildEpisodeRecoveryState({
                content: normalizedRevision.content,
                issues: effectivePostRevision.auditResult.issues,
                operationId: ch.operationId,
                terminationReason: revisionStatus === "audit-failed"
                  ? "revision-still-blocked"
                  : "revision-passed",
              }),
            }
          : ch,
      );
      await this.state.saveEpisodeIndex(bookId, updatedIndex);
      const latestEpisode = index.length > 0 ? Math.max(...index.map((episode) => episode.episodeNumber)) : targetEpisode;
      if (targetEpisode === latestEpisode) {
        await this.persistAuditDriftGuidance({
          bookDir,
          episodeNumber: targetEpisode,
          issues: effectivePostRevision.auditResult.issues.filter(
            (issue) => issue.severity === "critical" || issue.severity === "warning",
          ),
          language,
        }).catch(() => undefined);
      }

      if (truthAccepted) {
        this.logStage(stageLanguage, {
          zh: `更新第${targetEpisode}集索引与快照`,
          en: `updating episode index and snapshots for episode ${targetEpisode}`,
        });
        await this.state.snapshotState(bookId, targetEpisode);
        await this.syncNarrativeMemoryIndex(bookId);
        await this.syncCurrentStateFactHistory(bookId, targetEpisode);
        await this.markBookActiveIfNeeded(bookId);
      }

      await this.emitWebhook("revision-complete", bookId, targetEpisode, {
        episodeDurationSeconds: normalizedRevision.episodeDurationSeconds,
        fixedCount: reviseOutput.fixedIssues.length,
      });

      return {
        episodeNumber: targetEpisode,
        episodeDurationSeconds: normalizedRevision.episodeDurationSeconds,
        fixedIssues: reviseOutput.fixedIssues,
        applied: true,
        status: revisionStatus,
        lengthWarnings,
        lengthTelemetry,
        ...(recovery.kind === "none" ? {} : { recovery }),
      };
    } finally {
      await releaseLock();
    }
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return "(文件不存在)";
      }
    };

    // Phase 5: prefer the new prose outline files; fall back to legacy paths.
    const readOutline = async (newRel: string, legacyRel: string): Promise<string> => {
      const preferred = await readSafe(join(storyDir, newRel));
      if (preferred.trim() && preferred !== "(文件不存在)") return preferred;
      return readSafe(join(storyDir, legacyRel));
    };

    const [currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules] =
      await Promise.all([
        readSafe(join(storyDir, "current_state.md")),
        readSafe(join(storyDir, "particle_ledger.md")),
        readSafe(join(storyDir, "pending_hooks.md")),
        readOutline("outline/story_frame.md", "story_bible.md"),
        readOutline("outline/volume_map.md", "volume_outline.md"),
        readSafe(join(storyDir, "book_rules.md")),
      ]);

    return { currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules };
  }

  async reviseEpisode(
    bookId: string,
    episodeNumber?: number,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    externalContext?: string,
  ): Promise<Omit<ReviseResult, "episodeNumber"> & { readonly episodeNumber: number }> {
    await this.state.loadEpisodeBookConfig(bookId);
    const result = await this.reviseDraft(bookId, episodeNumber, mode, externalContext);
    const { episodeNumber: revisedEpisodeNumber, ...rest } = result;
    return { ...rest, episodeNumber: revisedEpisodeNumber };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const episodes = await this.state.loadEpisodeIndex(bookId);
    const nextEpisode = await this.state.getNextEpisodeNumber(bookId);
    const totalDurationSeconds = episodes.reduce((sum, episode) => sum + episode.episodeDurationSeconds, 0);
    const runtimeDir = join(this.state.bookDir(bookId), "story", "runtime");
    const performanceFiles = (await readdir(runtimeDir).catch(() => [] as string[]))
      .filter((file) => /^episode-\d{4}\.performance\.json$/u.test(file));
    const performanceReports = await Promise.all(performanceFiles.map(async (file) => {
      try {
        return JSON.parse(await readFile(join(runtimeDir, file), "utf8")) as EpisodePerformanceReport;
      } catch {
        return undefined;
      }
    }));
    const validReports = performanceReports.filter((report): report is EpisodePerformanceReport => Boolean(report));
    const episodePerformance = validReports.length > 0
      ? {
          totalCalls: validReports.reduce((sum, report) => sum + Object.values(report.calls).reduce((a, b) => a + b, 0), 0),
          totalTokens: validReports.reduce((sum, report) => sum + report.totalTokens, 0),
          averageContextEstimatedTokens: Math.round(validReports.reduce((sum, report) => sum + report.contextEstimatedTokens, 0) / validReports.length),
          cacheHits: validReports.reduce((sum, report) => sum + report.cacheHits, 0),
          cacheMisses: validReports.reduce((sum, report) => sum + report.cacheMisses, 0),
        }
      : undefined;

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      episodesWritten: episodes.length,
      totalDurationSeconds,
      nextEpisode,
      episodes: [...episodes],
      ...(episodePerformance ? { episodePerformance } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextEpisode(bookId: string, episodeDurationSeconds?: number, temperatureOverride?: number): Promise<EpisodePipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    const operationId = this.startOperation(bookId);
    try {
      this.throwIfAborted();
      await this.state.recoverIncompleteCoreWorkflowMutation(bookId);
      const recovery = await this.state.recoverIncompleteEpisodePersistence(bookId);
      const result = await this._writeNextEpisodeLocked(bookId, episodeDurationSeconds, temperatureOverride, this.config.externalContext);
      return { ...result, operationId, ...(recovery.kind === "none" ? {} : { recovery }) };
    } catch (error) {
      const episode = this.operationEpisodes.get(operationId);
      if (episode !== undefined) {
        await this.persistEpisodePerformanceReport(bookId, operationId, episode, true, 4).catch(() => undefined);
      }
      throw error;
    } finally {
      this.finishOperation(bookId, operationId);
      await releaseLock();
    }
  }

  async rewriteEpisode(
    bookId: string,
    episodeNumber: number,
    episodeDurationSeconds?: number,
    externalContext?: string,
  ): Promise<RewriteEpisodeResult> {
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
      throw new Error(`Invalid episode number: ${episodeNumber}`);
    }

    const releaseLock = await this.state.acquireBookLock(bookId);
    const operationId = this.startOperation(bookId);
    let rewriteTransactionStarted = false;
    try {
      this.throwIfAborted();
      await this.state.recoverIncompleteCoreWorkflowMutation(bookId);
      const recovery = await this.state.recoverIncompleteEpisodePersistence(bookId);
      await this.state.beginCoreWorkflowMutation(bookId, "rewrite-episode");
      rewriteTransactionStarted = true;
      const rolledBackTo = episodeNumber - 1;
      const discarded = await this.state.rollbackToEpisode(bookId, rolledBackTo);
      const nextEpisode = await this.state.getNextEpisodeNumber(bookId);
      if (nextEpisode !== episodeNumber) {
        throw new Error(
          `Cannot rewrite episode ${episodeNumber}: expected next episode to be ${episodeNumber}, but resolved to ${nextEpisode}`,
        );
      }
      const result = await this._writeNextEpisodeLocked(
        bookId,
        episodeDurationSeconds,
        undefined,
        externalContext ?? this.config.externalContext,
      );
      await this.state.commitCoreWorkflowMutation(bookId, "rewrite-episode");
      rewriteTransactionStarted = false;
      return {
        ...result,
        operationId,
        rolledBackTo,
        discarded,
        ...(recovery.kind === "none" ? {} : { recovery }),
      };
    } catch (error) {
      if (rewriteTransactionStarted) {
        await this.state.recoverIncompleteCoreWorkflowMutation(bookId).catch(() => undefined);
      }
      throw error;
    } finally {
      this.finishOperation(bookId, operationId);
      await releaseLock();
    }
  }

  async repairEpisodeState(bookId: string, episodeNumber?: number): Promise<EpisodePipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    const operationId = this.startOperation(bookId);
    try {
      const recovery = await this.state.recoverIncompleteEpisodePersistence(bookId);
      const result = await this._repairEpisodeStateLocked(bookId, episodeNumber);
      return { ...result, operationId, ...(recovery.kind === "none" ? {} : { recovery }) };
    } finally {
      this.finishOperation(bookId, operationId);
      await releaseLock();
    }
  }

  async resyncEpisodeArtifacts(bookId: string, episodeNumber?: number): Promise<EpisodePipelineResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    const operationId = this.startOperation(bookId);
    try {
      const recovery = await this.state.recoverIncompleteEpisodePersistence(bookId);
      const result = await this._resyncEpisodeArtifactsLocked(bookId, episodeNumber);
      return { ...result, operationId, ...(recovery.kind === "none" ? {} : { recovery }) };
    } finally {
      this.finishOperation(bookId, operationId);
      await releaseLock();
    }
  }

  private async _writeNextEpisodeLocked(
    bookId: string,
    episodeDurationSeconds?: number,
    temperatureOverride?: number,
    externalContext?: string,
  ): Promise<EpisodePipelineResult> {
    this.throwIfAborted();
    await this.state.ensureControlDocuments(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    await this.assertNoPendingStateRepair(bookId);
    await this.assertCanonRefreshBacklog(bookId, bookDir);
    const episodeNumber = await this.state.getNextEpisodeNumber(bookId);
    this.setOperationEpisode(bookId, episodeNumber);
    const stageLanguage = await this.resolveBookLanguage(book);
    this.logStage(stageLanguage, { zh: "准备剧集输入", en: "preparing episode inputs" });
    const previousEpisodeScript = book.format === "screenplay"
      ? await loadPersistedEpisodeScript(bookDir, episodeNumber - 1)
      : undefined;
    const writeInput = await this.prepareWriteInput(
      book,
      bookDir,
      episodeNumber,
      externalContext,
      previousEpisodeScript?.contract.handoffState,
    );
    const reducedControlInput = writeInput.episodeIntent && writeInput.contextPackage && writeInput.ruleStack
      ? {
          episodeIntent: writeInput.episodeIntent,
          episodeMemo: writeInput.episodeMemo,
          episodeIntentData: writeInput.episodeIntentData,
          contextPackage: writeInput.contextPackage,
          ruleStack: writeInput.ruleStack,
        }
      : undefined;
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const lengthSpec = buildLengthSpec(
      episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
      pipelineLang,
    );
    const { normalizePostWriteSurface } = await import("../agents/post-write-validator.js");
    const auditGates = await this.prepareEpisodeAuditGates({
      bookId,
      bookDir,
      episodeNumber,
      language: pipelineLang,
      genreProfile: gp,
      episodeMemo: writeInput.episodeMemo,
      contextPackage: writeInput.contextPackage,
    });
    const compiledClaimsForPostGate = auditGates.compiledClaims;
    const volumeContractForPostGate = auditGates.volumeContract;
    const volumeProgressForPostGate = auditGates.volumeProgress;
    const settingsIndex = await buildSettingsEntityIndex(bookDir, episodeNumber);

    // 1. Write episode
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    this.logStage(stageLanguage, { zh: "撰写剧集草稿", en: "writing episode draft" });
    const { output: initialOutput, writerFailedUsage } = await this.writeEpisodeWithRetry({
      writer,
      book,
      bookDir,
      episodeNumber,
      writeInput,
      lengthSpec,
      episodeDurationSeconds,
      temperatureOverride,
    });
    let output = initialOutput;
    this.throwIfAborted();
    // The previous handoff is authoritative for the next episode's incoming
    // contract. Models may omit a carried fact while still depicting it in
    // the shots; merge it deterministically before review and persistence so
    // continuity state cannot drift from the screenplay boundary.
    if (output.episodeScript) {
      let authoritativeScript = output.episodeScript;
      if (previousEpisodeScript) {
        authoritativeScript = carryForwardEpisodeIncomingState(
          authoritativeScript,
          previousEpisodeScript.contract.handoffState,
        );
      }
      // Deterministic duration normalization: scale shot seconds toward the
      // target before review so auditor findings and persisted metrics see
      // the same authoritative timing.
      const normalized = normalizeEpisodeShotDurations(
        authoritativeScript,
        episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
      );
      if (normalized.adjusted) authoritativeScript = normalized.script;
      output = {
        ...output,
        content: renderEpisodeScriptMarkdown(authoritativeScript),
        episodeScript: authoritativeScript,
        episodeScriptMetrics: measureEpisodeScript(authoritativeScript, episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS),
      };
    }
    const writerCount = output.episodeScriptMetrics
      ? output.episodeScriptMetrics.estimatedDurationSeconds
      : countEpisodeLength(output.content, lengthSpec.countingMode);

    // Token usage accumulator
    let totalUsage: TokenUsageSummary = output.tokenUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (writerFailedUsage) {
      totalUsage = {
        promptTokens: totalUsage.promptTokens + writerFailedUsage.promptTokens,
        completionTokens: totalUsage.completionTokens + writerFailedUsage.completionTokens,
        totalTokens: totalUsage.totalTokens + writerFailedUsage.totalTokens,
      };
    }
    let finalContent: string;
    let finalWordCount: number;
    let revised: boolean;
    let auditResult: AuditResult;
    let postReviseCount: number;
    let normalizeApplied: boolean;
    let preAuditNormalizedWordCount: number | undefined;
    let reviewAttempts: ReadonlyArray<EpisodeReviewAttempt> | undefined;
    let reviewTelemetry: EpisodeReviewTelemetry;

    if ((this.config.episodeReviewMode ?? "auto") === "manual") {
      // C4a: write-only checkpoint. Stop right after the draft — skip the
      // automatic audit→revise loop (which silently doubled episode time when it
      // fired). The user drives review / revise / accept afterwards.
      this.logStage(stageLanguage, { zh: "写完即停（手动审查模式）", en: "draft written — stopping for manual review" });
      finalContent = normalizePostWriteSurface(output.content, pipelineLang);
      this.assertEpisodeContentNotEmpty(finalContent, episodeNumber, "manual write");
      finalWordCount = output.episodeScriptMetrics
        ? output.episodeScriptMetrics.estimatedDurationSeconds
        : countEpisodeLength(finalContent, lengthSpec.countingMode);
      revised = false;
      postReviseCount = 0;
      normalizeApplied = finalContent !== output.content;
      preAuditNormalizedWordCount = writerCount;
      auditResult = {
        passed: false,
        issues: [],
        summary: pipelineLang === "en"
          ? "Not reviewed yet (manual mode: stopped after writing — run review when ready)."
          : "尚未审查（手动模式：写完即停，需要时点“审查”）。",
      };
      reviewTelemetry = {
        terminationReason: "manual-mode",
        auditCalls: 0,
        revisionCalls: 0,
        normalizationCalls: 0,
        reviewedCandidates: 0,
        configuredMaxRevisions: 0,
      };
    } else {
      const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
      const screenplayBook = book.format === "screenplay" || book.schemaVersion === "inkos-episode-v2";
      const reviewResult = await runEpisodeReviewCycle({
        book: { genre: book.genre, episodeDurationSeconds: book.episodeDurationSeconds },
        bookDir,
        episodeNumber,
        initialOutput: output,
        reducedControlInput,
        lengthSpec,
        initialUsage: totalUsage,
        episodeContextSnapshot: writeInput.episodeContextSnapshot,
        createReviser: () => new ReviserAgent(this.agentCtxFor("reviser", bookId)),
        evaluateEpisode: async (content, options) => {
          if (output.episodeScript) {
            try {
              const script = parseEpisodeScriptOutput(content, episodeNumber);
              const recentScripts = await loadRecentEpisodeScripts(bookDir, episodeNumber);
              const deterministicIssues = auditEpisodeScript(script, previousEpisodeScript, book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS, settingsIndex, recentScripts, pipelineLang);
              // P0-4: a post-revision verification request (patch or rewrite)
              // must reach the LLM regression-checklist verifier even when the
              // deterministic gate is already clean — a clean gate cannot see
              // a lost hook payoff or silently dropped content.
              const verificationRequested = (options?.verificationIssues?.length ?? 0) > 0;
              if (!verificationRequested && !deterministicIssues.some((issue) => issue.severity === "critical")) {
                return {
                  auditResult: {
                    passed: true,
                    issues: deterministicIssues,
                    summary: "Deterministic screenplay quality gate completed.",
                  },
                  aiTellCount: 0,
                  blockingCount: deterministicIssues.filter((issue) => issue.severity !== "info").length,
                  criticalCount: 0,
                  revisionBlockingIssues: deterministicIssues,
                };
              }
              const llmEvaluation = await this.evaluateMergedAudit({
                auditor,
                book,
                bookDir,
                episodeContent: content,
                episodeNumber,
                language: pipelineLang,
                auditOptions: reducedControlInput
                  ? {
                      episodeIntent: reducedControlInput.episodeIntent,
                      episodeMemo: reducedControlInput.episodeMemo,
                      contextPackage: reducedControlInput.contextPackage,
                      ruleStack: reducedControlInput.ruleStack,
                      episodeContextSnapshot: writeInput.episodeContextSnapshot,
                      ...(options ?? {}),
                    }
                  : options,
                runPostWriteChecks: auditGates.runPostWriteChecks,
              });
              const mergedIssues = deduplicateAuditIssues([
                ...llmEvaluation.auditResult.issues,
                ...deterministicIssues,
              ]);
              const mergedBlockingIssues = deduplicateAuditIssues([
                ...llmEvaluation.revisionBlockingIssues,
                ...deterministicIssues.filter((issue) => issue.severity !== "info"),
              ]);
              return {
                ...llmEvaluation,
                auditResult: {
                  ...llmEvaluation.auditResult,
                  passed: !mergedIssues.some((issue) => issue.severity === "critical")
                    && (llmEvaluation.auditResult.overallScore ?? 0) >= 80,
                  issues: mergedIssues,
                },
                blockingCount: mergedBlockingIssues.filter((issue) => issue.severity === "warning" || issue.severity === "critical").length,
                criticalCount: mergedBlockingIssues.filter((issue) => issue.severity === "critical").length,
                revisionBlockingIssues: mergedBlockingIssues,
              };
            } catch {
              // Fall through to the continuity auditor when local parsing fails.
            }
          }
          return this.evaluateMergedAudit({
            auditor,
            book,
            bookDir,
            episodeContent: content,
            episodeNumber,
            language: pipelineLang,
            auditOptions: reducedControlInput
              ? {
                  episodeIntent: reducedControlInput.episodeIntent,
                  episodeMemo: reducedControlInput.episodeMemo,
                  contextPackage: reducedControlInput.contextPackage,
                  ruleStack: reducedControlInput.ruleStack,
                  episodeContextSnapshot: writeInput.episodeContextSnapshot,
                  ...(options ?? {}),
                }
              : options,
            runPostWriteChecks: auditGates.runPostWriteChecks,
          });
        },
        validateRevisionCandidate: output.episodeScript
          ? (content) => {
              const script = parseEpisodeScriptOutput(content, episodeNumber);
              const metrics = measureEpisodeScript(script, book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS);
              return {
                episodeDurationSeconds: metrics.estimatedDurationSeconds,
              };
            }
          : undefined,
        normalizeDraftLengthIfNeeded: (episodeContent) => Promise.resolve(
          this.normalizeEpisodeScriptProjection({
            episodeNumber,
            episodeContent,
            targetDurationSeconds: book.episodeDurationSeconds,
          }),
        ),
        normalizePostWriteSurface: (episodeContent) =>
          normalizePostWriteSurface(episodeContent, pipelineLang),
        assertEpisodeContentNotEmpty: (content, stage) =>
          this.assertEpisodeContentNotEmpty(content, episodeNumber, stage),
        addUsage: PipelineRunner.addUsage,
        maxReviewIterations: screenplayBook ? 1 : this.config.writingReviewRetries,
        maxRevisionCalls: screenplayBook
          ? 1
          : this.config.governanceCallLimits?.maxRevisionCallsPerEpisode,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logStage: (message) => this.logStage(stageLanguage, message),
      });
      totalUsage = reviewResult.totalUsage;
      finalContent = reviewResult.finalContent;
      finalWordCount = reviewResult.finalWordCount;
      revised = reviewResult.revised;
      auditResult = reviewResult.auditResult;
      postReviseCount = reviewResult.postReviseCount;
      normalizeApplied = reviewResult.normalizeApplied;
      preAuditNormalizedWordCount = reviewResult.preAuditNormalizedWordCount;
      reviewAttempts = reviewResult.reviewAttempts;
      reviewTelemetry = reviewResult.reviewTelemetry;

      // P0-2: when the cycle stops at requires-upstream-revision, the
      // remaining blocking findings belong to planner/canon. Persist them as
      // planning feedback so the next `inkos plan episode` for this episode
      // resolves them in the memo itself instead of leaving them stranded in
      // a review log.
      if (reviewTelemetry.terminationReason === "requires-upstream-revision") {
        const recorded = await recordUpstreamRevisionFeedback(
          bookDir,
          episodeNumber,
          reviewResult.auditResult.issues,
          resolveAuditIssueOwner,
        );
        if (recorded) {
          this.logWarn(pipelineLang, {
            zh: `已把 ${recorded.findings.length} 条上游问题写入规划反馈，下一次 inkos plan episode 将要求 memo 直接解决`,
            en: `Recorded ${recorded.findings.length} upstream finding(s) as planning feedback; the next inkos plan episode run must resolve them in the memo.`,
          });
        }
      }
    }

    // Screenplay timing is derived from the authoritative final JSON, not
    // from review-cycle legacy length counters. This also keeps a revised
    // script's index row aligned with its shot durations.
    if (book.format === "screenplay" || book.schemaVersion === "inkos-episode-v2") {
      try {
        let finalScript = parseEpisodeScriptOutput(finalContent, episodeNumber);
        const normalized = normalizeEpisodeShotDurations(finalScript, book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS);
        if (normalized.adjusted) {
          finalScript = normalized.script;
          finalContent = renderEpisodeScriptMarkdown(finalScript);
        }
        finalWordCount = measureEpisodeScript(finalScript, book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS).estimatedDurationSeconds;
      } catch {
        // The deterministic writer gate already rejects invalid screenplay
        // JSON; leave the prior value only for diagnostic recovery paths.
      }
    }

    this.throwIfAborted();

    if (writeInput.episodeMemo && volumeContractForPostGate) {
      const visibleKrRefs = detectVisibleKrRefs(volumeContractForPostGate, finalContent);
      const attemptedKrRefs = detectAttemptedKrRefs(volumeContractForPostGate, finalContent);
      await recordVisibleVolumeProgress(bookDir, {
        episode: episodeNumber,
        contract: volumeContractForPostGate,
        visibleKrRefs,
        attemptedKrRefs,
      });
    }

    if (compiledClaimsForPostGate) {
      const revealedClaimIds = detectVisibleRevealClaimIds({
        text: finalContent,
        compiled: compiledClaimsForPostGate,
      });
      if (revealedClaimIds.length > 0) {
        await recordReaderClaimReveals(bookDir, {
          episode: episodeNumber,
          claimIds: revealedClaimIds,
        });
      }
    }

    // 3b. Lightweight per-episode promotion pass — check if any hooks should
    // be promoted based on advanced_count derived from episode_summaries.
    // Runs BEFORE persistence so the reviewer of the NEXT episode sees the
    // updated ledger. No LLM calls — pure ledger parse + threshold check.
    {
      const { rerunPromotionPass } = await import("../utils/hook-promotion.js");
      const { parsePendingHooksMarkdown, renderHookSnapshot } = await import("../utils/story-markdown.js");
      const promotionStoryDir = join(bookDir, "story");
      const ledgerPath = join(promotionStoryDir, "pending_hooks.md");
      const ledgerRaw = await readFile(ledgerPath, "utf-8").catch(() => "");
      if (ledgerRaw.trim()) {
        const hooks = parsePendingHooksMarkdown(ledgerRaw);
        if (hooks.length > 0) {
          const summariesRaw = await readFile(join(promotionStoryDir, "episode_summaries.md"), "utf-8").catch(() => "");
          const promotionResult = rerunPromotionPass(hooks, summariesRaw);
          if (promotionResult.updated) {
            const ledgerLang: "zh" | "en" = /[\u4e00-\u9fff]/.test(ledgerRaw) ? "zh" : "en";
            await writeFile(ledgerPath, renderHookSnapshot([...promotionResult.hooks], ledgerLang), "utf-8");
            this.config.logger?.info(`[promotion] ${promotionResult.flippedCount} hook(s) promoted after episode ${episodeNumber}`);
          }
        }
      }
    }

    // 4. Save the final episode and truth files from a single persistence source
        this.logStage(stageLanguage, { zh: "落盘最终剧集", en: "persisting final episode" });
    this.logStage(stageLanguage, { zh: "生成最终真相文件", en: "rebuilding final truth files" });
    const episodeIndexBeforePersist = await this.state.loadEpisodeIndex(bookId);
    const { resolveDuplicateTitle } = await import("../agents/post-write-validator.js");
    const initialTitleResolution = resolveDuplicateTitle(
      output.title,
      episodeIndexBeforePersist.map((episode) => episode.title),
      pipelineLang,
      { content: finalContent },
    );
    let persistenceOutput = await this.buildPersistenceOutput(
      bookId,
      book,
      bookDir,
      episodeNumber,
      initialTitleResolution.title === output.title
        ? output
        : { ...output, title: initialTitleResolution.title },
      finalContent,
      lengthSpec.countingMode,
      reducedControlInput,
      writeInput.episodeContextSnapshot!,
    );
    const finalTitleResolution = resolveDuplicateTitle(
      persistenceOutput.title,
      episodeIndexBeforePersist.map((episode) => episode.title),
      pipelineLang,
      { content: finalContent },
    );
    if (finalTitleResolution.title !== persistenceOutput.title) {
      persistenceOutput = {
        ...persistenceOutput,
        title: finalTitleResolution.title,
      };
    }
    // Keep the authoritative JSON script and its markdown projection in sync
    // with the deduplicated title. Previously only the index/file name changed,
    // leaving the script title and md header on the original (now duplicate)
    // value — the same title kept reappearing because the dedup index no longer
    // matched what the writer saw.
    if (persistenceOutput.episodeScript && persistenceOutput.episodeScript.title !== persistenceOutput.title) {
      const { renderEpisodeScriptMarkdown } = await import("../models/episode-script.js");
      const renamedScript = { ...persistenceOutput.episodeScript, title: persistenceOutput.title };
      persistenceOutput = {
        ...persistenceOutput,
        episodeScript: renamedScript,
        content: renderEpisodeScriptMarkdown(renamedScript),
        episodeHandoffCapsule: buildEpisodeHandoffCapsule(
          renamedScript,
          `${JSON.stringify(renamedScript, null, 2)}\n`,
        ),
      };
    }
    if (persistenceOutput.title !== output.title) {
      const description = pipelineLang === "en"
        ? `Episode title "${output.title}" was auto-adjusted to "${persistenceOutput.title}".`
        : `剧集标题"${output.title}"已自动调整为"${persistenceOutput.title}"。`;
      this.config.logger?.warn(`[title] ${description}`);
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, {
          severity: "warning",
          category: "title-dedup",
          description,
          suggestion: pipelineLang === "en"
            ? "If the auto-renamed title is weak, revise the episode title manually."
            : "如果自动改名不理想，可以在后续手动修订剧集标题。",
        }],
      };
    }
    const persistedScriptForAudit = persistenceOutput.episodeScript;
    const episodeScriptIssues = persistedScriptForAudit
      ? (async () => {
          const recentScripts = await loadRecentEpisodeScripts(bookDir, episodeNumber);
          return (await import("./episode-quality-gate.js")).auditEpisodeScript(
            persistedScriptForAudit,
            previousEpisodeScript,
            book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
            settingsIndex,
            recentScripts,
            pipelineLang,
          );
        })()
      : Promise.resolve([] as AuditIssue[]);
    const resolvedEpisodeScriptIssues = await episodeScriptIssues;
    // Deterministic early-payoff guard: a hook whose scheduled payoff episode
    // lies ahead must not have its key facts consumed on screen already.
    if (persistedScriptForAudit) {
      const { auditEarlyHookPayoff } = await import("./episode-quality-gate.js");
      const { parsePendingHooksMarkdown } = await import("../utils/story-markdown.js");
      const hooksMarkdown = writeInput.episodeContextSnapshot
        ? getEpisodeContextContent(writeInput.episodeContextSnapshot, "story/pending_hooks.md")
        : "";
      if (hooksMarkdown) {
        resolvedEpisodeScriptIssues.push(
          ...auditEarlyHookPayoff(
            persistedScriptForAudit,
            parsePendingHooksMarkdown(hooksMarkdown),
          ),
        );
      }
    }
    if (persistenceOutput.episodeScript) {
      const episodeJson = `${JSON.stringify(persistenceOutput.episodeScript, null, 2)}\n`;
      persistenceOutput = {
        ...persistenceOutput,
        episodeHandoffCapsule: buildEpisodeHandoffCapsule(persistenceOutput.episodeScript, episodeJson),
        episodeReviewEvidence: buildEpisodeReviewEvidence({
          artifact: `episodes/${String(episodeNumber).padStart(4, "0")}.json`,
          content: episodeJson,
          issues: resolvedEpisodeScriptIssues,
        }),
      };
    }
    const longSpanFatigue = persistenceOutput.episodeScript
      ? { issues: [] as AuditIssue[] }
      : await analyzeLongSpanFatigue({
          bookDir,
          episodeNumber,
          episodeContent: finalContent,
          episodeSummary: persistenceOutput.episodeSummary,
          language: pipelineLang,
        });
    auditResult = {
      ...auditResult,
      issues: [
        ...auditResult.issues,
        ...resolvedEpisodeScriptIssues,
        ...longSpanFatigue.issues,
        ...(persistenceOutput.hookHealthIssues ?? []),
      ],
    };
    finalWordCount = persistenceOutput.episodeDurationSeconds;
    const lengthWarnings = persistenceOutput.episodeScriptMetrics
      ? this.buildEpisodeDurationWarnings(episodeNumber, persistenceOutput.episodeScriptMetrics)
      : this.buildLengthWarnings(episodeNumber, finalWordCount, lengthSpec);
    const lengthTelemetry = persistenceOutput.episodeScriptMetrics
      ? undefined
      : this.buildLengthTelemetry({
          lengthSpec,
          writerCount,
          postWriterNormalizeCount: preAuditNormalizedWordCount,
          postReviseCount,
          finalCount: finalWordCount,
          normalizeApplied,
          lengthWarning: lengthWarnings.length > 0,
        });
    this.logLengthWarnings(lengthWarnings);

    // 4.1 Validate settler output before writing
    this.logStage(stageLanguage, { zh: "校验真相文件变更", en: "validating truth file updates" });
    const storyDir = join(bookDir, "story");
    const [oldState, oldHooks, oldLedger, authorityStoryFrame, authorityBookRules, authorityEpisodeSummaries] = await Promise.all([
      readFile(join(storyDir, "current_state.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "particle_ledger.md"), "utf-8").catch(() => ""),
      readStoryFrame(bookDir).catch(() => ""),
      readFile(join(storyDir, "book_rules.md"), "utf-8").catch(() => ""),
      readFile(join(storyDir, "episode_summaries.md"), "utf-8").catch(() => ""),
    ]);
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    const recoveryIssues = auditResult.issues;
    const truthValidation = await validateEpisodeTruthPersistence({
      writer,
      validator,
      book,
      bookDir,
      episodeNumber,
      title: persistenceOutput.title,
      content: finalContent,
      persistenceOutput,
      episodeContextSnapshot: writeInput.episodeContextSnapshot!,
      auditResult,
      previousTruth: {
        oldState,
        oldHooks,
        oldLedger,
      },
      authorityContext: {
        storyFrame: authorityStoryFrame,
        bookRules: authorityBookRules,
        episodeSummaries: authorityEpisodeSummaries,
      },
      reducedControlInput,
      language: pipelineLang,
      maxSettlementCalls: this.config.governanceCallLimits?.maxSettlementCallsPerEpisode,
      recoverAfterSettlementLimit: (previousValidation) => this.recoverResyncWithDeterministicReplay({
        bookId,
        book,
        bookDir,
        episodeNumber,
        title: persistenceOutput.title,
        content: finalContent,
        reducedControlInput,
        validator,
        oldState,
        oldHooks,
        language: pipelineLang,
        previousValidation,
        settlementAttempts: 1,
        episodeContextSnapshot: writeInput.episodeContextSnapshot!,
      }),
      logWarn: (message) => this.logWarn(pipelineLang, message),
      logger: this.config.logger,
    });
    const currentOperationId = this.activeOperationIds.get(bookId);
    let episodeStatus: EpisodePipelineResult["status"] | null = truthValidation.episodeStatus;
    let performanceReport = currentOperationId && persistenceOutput.episodeScript
      ? this.buildOperationPerformanceReport(
          bookId,
          currentOperationId,
          episodeNumber,
          truthValidation.episodeStatus === "state-degraded",
          revised ? 5 : truthValidation.episodeStatus === "state-degraded" ? 4 : 3,
        )
      : undefined;
    let degradedIssues: ReadonlyArray<AuditIssue> = truthValidation.degradedIssues;
    persistenceOutput = truthValidation.persistenceOutput;
    // Recovery/degraded projections are allowed to replace the writer output,
    // but the operation report still belongs to this episode transaction.
    if (performanceReport && !persistenceOutput.episodePerformanceReport) {
      persistenceOutput = { ...persistenceOutput, episodePerformanceReport: performanceReport };
    }
    auditResult = truthValidation.auditResult;

    // Volume contract coverage guard: writing beyond the current outline's
    // range means the planner is binding stale volume KRs. Surface a clear,
    // non-blocking warning so the operator can extend the foundation.
    if (volumeContractForPostGate?.episodeEnd !== undefined
      && episodeNumber > volumeContractForPostGate.episodeEnd) {
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, {
          severity: "warning",
          category: "volume-contract-coverage",
          repairScope: "structural",
          ruleClass: "reviewed_invariant",
          description: `Episode ${episodeNumber} is beyond the current volume contract (ends at ${volumeContractForPostGate.episodeEnd}); volume KR guidance is stale. Run "inkos foundation extend" or regenerate the foundation.`,
          suggestion: "Extend the volume contract to the new target episode count before continuing.",
        }],
      };
    }

    // 4.2 Final paragraph shape check on persisted content (post-normalize, post-revise)
    if (!persistenceOutput.episodeScript) {
      const {
        detectParagraphLengthDrift,
        detectParagraphShapeWarnings,
      } = await import("../agents/post-write-validator.js");
      const chapDir = join(bookDir, "episodes");
      const recentFiles = (await readdir(chapDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith(".md") && /^\d{4}/.test(f))
        .sort()
        .slice(-5);
      const recentContent = (await Promise.all(
        recentFiles.map((f) => readFile(join(chapDir, f), "utf-8").catch(() => "")),
      )).join("\n\n");
      const paragraphIssues = [
        ...detectParagraphShapeWarnings(finalContent, pipelineLang),
        ...detectParagraphLengthDrift(finalContent, recentContent, pipelineLang),
      ];
      if (paragraphIssues.length > 0) {
        for (const issue of paragraphIssues) {
          this.config.logger?.warn(`[paragraph] ${issue.description}`);
        }
        auditResult = {
          ...auditResult,
          issues: [...auditResult.issues, ...paragraphIssues.map((v) => ({
            severity: v.severity as "warning",
            category: "paragraph-shape",
            description: v.description,
            suggestion: v.suggestion,
          }))],
        };
      }
    }

    const finalAuditResult: AuditResult = {
      ...auditResult,
      issues: deduplicateAuditIssues(auditResult.issues),
    };
    auditResult = {
      ...finalAuditResult,
      passed: deriveAuditPassed(finalAuditResult),
    };

    const hardLengthPassed = persistenceOutput.episodeScriptMetrics
      ? persistenceOutput.episodeScriptMetrics.estimatedDurationSeconds >= EPISODE_DURATION_HARD_MIN_SECONDS
        && persistenceOutput.episodeScriptMetrics.estimatedDurationSeconds <= EPISODE_DURATION_HARD_MAX_SECONDS
      : lengthWarnings.length === 0;
    const quality = resolveEpisodeReviewStatus({
      auditResult,
      hardLengthPassed,
      stateDegraded: episodeStatus === "state-degraded",
    });
    const resolvedStatus = quality.status;
    if (currentOperationId && persistenceOutput.episodeScript) {
      performanceReport = this.buildOperationPerformanceReport(
        bookId,
        currentOperationId,
        episodeNumber,
        resolvedStatus === "state-degraded",
        revised ? 5 : resolvedStatus === "state-degraded" ? 4 : 3,
      );
    }
    if (performanceReport) {
      persistenceOutput = { ...persistenceOutput, episodePerformanceReport: performanceReport };
    }
    this.throwIfAborted();
    await this.state.beginEpisodePersistence(bookId, episodeNumber, this.activeOperationIds.get(bookId));
    try {
      await persistEpisodeArtifacts({
        episodeNumber,
        episodeTitle: persistenceOutput.title,
        episodeContent: finalContent,
        status: resolvedStatus,
        auditResult,
        recoveryIssues,
        finalWordCount,
        lengthWarnings,
        lengthTelemetry,
        episodeScriptMetrics: persistenceOutput.episodeScriptMetrics,
        degradedIssues,
        tokenUsage: totalUsage,
        reviewTelemetry,
        operationId: this.activeOperationIds.get(bookId),
        loadEpisodeIndex: () => this.state.loadEpisodeIndex(bookId),
        saveEpisode: ({ persistTruth }) => writer.saveEpisode(
          bookDir,
          persistenceOutput,
          gp.numericalSystem,
          pipelineLang,
          { persistTruth },
        ),
        saveTruthFiles: async () => {
          await writer.saveNewTruthFiles(bookDir, persistenceOutput, pipelineLang);
          await this.syncLegacyStructuredStateFromMarkdown(bookDir, episodeNumber, persistenceOutput);
          this.logStage(stageLanguage, { zh: "同步记忆索引", en: "syncing memory indexes" });
          await this.syncNarrativeMemoryIndex(bookId);
        },
        saveEpisodeIndex: (index) => this.state.saveEpisodeIndex(bookId, index),
        markBookActiveIfNeeded: () => this.markBookActiveIfNeeded(bookId),
        persistAuditDriftGuidance: (issues) => this.persistAuditDriftGuidance({
          bookDir,
          episodeNumber,
          issues,
          language: stageLanguage,
        }).catch(() => undefined),
        snapshotState: () => this.state.snapshotState(bookId, episodeNumber),
        syncCurrentStateFactHistory: () => this.syncCurrentStateFactHistory(bookId, episodeNumber),
        logSnapshotStage: () =>
          this.logStage(stageLanguage, { zh: "更新剧集索引与快照", en: "updating episode index and snapshots" }),
      });
      await this.state.commitEpisodePersistence(bookId, episodeNumber, this.activeOperationIds.get(bookId));
      // Review evidence is a derived sidecar. If it was not written (or was
      // lost during a recovery path), rebuild it deterministically from the
      // authoritative episode JSON so audit results never exist without the
      // evidence file.
      if (persistenceOutput.episodeScript) {
        await ensureEpisodeReviewSidecar({
          bookDir,
          episode: episodeNumber,
          targetDurationSeconds: book.episodeDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
        });
        await applyEpisodeCanonUpdates({
          bookDir,
          script: persistenceOutput.episodeScript,
        });
      }
      if (performanceReport?.status === "budget-exceeded") {
        const budget = revised ? 5 : resolvedStatus === "state-degraded" ? 4 : 3;
        this.emitDiagnostic({
          kind: "call-budget-exceeded",
          severity: "error",
          agent: "pipeline",
          phase: "episode",
          bookId,
          episodeNumber: episodeNumber,
          message: `Episode ${episodeNumber} used ${Object.values(performanceReport.calls).reduce((sum, value) => sum + value, 0)} model calls; budget is ${budget}.`,
          details: {
            plannerCalls: performanceReport.calls.planner,
            writerCalls: performanceReport.calls.writer,
            auditorCalls: performanceReport.calls.auditor,
            reviserCalls: performanceReport.calls.reviser,
            recoveryCalls: performanceReport.calls.recovery,
          },
        });
      }
    } catch (error) {
      try {
        await this.state.abortEpisodePersistence(bookId, episodeNumber);
      } catch (rollbackError) {
        throw new Error(
          `Episode ${episodeNumber} persistence failed and rollback also failed: ${String(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }

    // 6. Send notification
    if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
      const statusEmoji = resolvedStatus === "state-degraded"
        ? "🧯"
        : quality.warning > 0 || quality.critical > 0 ? "⚠️" : "✅";
      const episodeLength = formatLengthCount(finalWordCount, lengthSpec.countingMode);
      await dispatchNotification(this.config.notifyChannels, {
        title: `${statusEmoji} ${book.title} 第${episodeNumber}集`,
        body: [
          `**${persistenceOutput.title}** | ${episodeLength}`,
          revised ? "📝 已自动修正" : "",
          resolvedStatus === "state-degraded"
            ? "状态结算: 已降级保存，需先修复 state 再继续"
            : quality.warning > 0
              ? `审稿: 发现 ${quality.warning} 个轻微问题，待人工审核`
              : "审稿: 通过",
          ...auditResult.issues
            .filter((i) => i.severity !== "info")
            .map((i) => `- [${i.severity}] ${i.description}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }

    await this.emitWebhook("pipeline-complete", bookId, episodeNumber, {
      title: persistenceOutput.title,
      episodeDurationSeconds: finalWordCount,
      passed: deriveAuditPassed(auditResult),
      revised,
      status: resolvedStatus,
    });

    return {
      episodeNumber,
      title: persistenceOutput.title,
      episodeDurationSeconds: finalWordCount,
      auditResult,
      revised,
      status: resolvedStatus,
      lengthWarnings,
      lengthTelemetry,
      tokenUsage: totalUsage,
      ...(reviewAttempts ? { reviewAttempts } : {}),
      reviewTelemetry,
      ...(performanceReport ? { performanceReport } : {}),
    };
  }

  private async _repairEpisodeStateLocked(bookId: string, episodeNumber?: number): Promise<EpisodePipelineResult> {
    this.throwIfAborted();
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadEpisodeIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted episodes to repair.`);
    }

    const targetEpisode = episodeNumber ?? index[index.length - 1]!.episodeNumber;
    const targetIndex = index.findIndex((episode) => episode.episodeNumber === targetEpisode);
    if (targetIndex < 0) {
      throw new Error(`Episode ${targetEpisode} not found in "${bookId}".`);
    }
    const targetMeta = index[targetIndex]!;
    const latestEpisode = Math.max(...index.map((episode) => episode.episodeNumber));
    if (targetMeta.status !== "state-degraded") {
      throw new Error(`Episode ${targetEpisode} is not state-degraded.`);
    }
    if (targetEpisode !== latestEpisode) {
      throw new Error(`Only the latest state-degraded episode can be repaired safely (latest is ${latestEpisode}).`);
    }

    this.logStage(stageLanguage, { zh: "修复剧集状态投影", en: "repairing episode state projection" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    const content = await this.readEpisodeContent(bookDir, targetEpisode);
    const writerCtx = this.agentCtxFor("writer", bookId);
    const episodeContextSnapshot = await loadEpisodeContextSnapshot({
      bookDir,
      episode: targetEpisode,
      model: writerCtx.model,
      service: writerCtx.client.service ?? "unknown",
    });
    const oldState = getEpisodeContextContent(episodeContextSnapshot, "story/current_state.md");
    const oldHooks = getEpisodeContextContent(episodeContextSnapshot, "story/pending_hooks.md");
    const writer = new WriterAgent(writerCtx);
    let repairedOutput = await writer.replayEpisodeState({
      book,
      bookDir,
      episodeNumber: targetEpisode,
      title: targetMeta.title,
      content,
      allowReapply: true,
      episodeContextSnapshot,
    });
    const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
    let validation = await validator.validate(
      content,
      targetEpisode,
      oldState,
      repairedOutput.updatedState,
      oldHooks,
      repairedOutput.updatedHooks,
      pipelineLang,
    );

    let degradedIssues: ReadonlyArray<AuditIssue> | undefined;
    const settlementRetryAllowed = this.config.governanceCallLimits?.maxSettlementCallsPerEpisode === undefined
      || this.config.governanceCallLimits.maxSettlementCallsPerEpisode > 1;
    if (!validation.passed && settlementRetryAllowed) {
      const recovery = await replayEpisodeStateAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        episodeNumber: targetEpisode,
        title: targetMeta.title,
        content,
        episodeContextSnapshot,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
      if (recovery.kind !== "recovered") {
        degradedIssues = recovery.issues;
      } else {
        repairedOutput = recovery.output;
        validation = recovery.validation;
      }
    }

    if (!validation.passed) {
      const issues = degradedIssues ?? buildStateDegradedIssues(validation.warnings, pipelineLang);
      return {
        episodeNumber: targetEpisode,
        title: targetMeta.title,
        episodeDurationSeconds: targetMeta.episodeDurationSeconds,
        auditResult: {
          passed: false,
          issues,
          summary: pipelineLang === "en"
            ? "State repair remained degraded within the settlement call budget."
            : "状态修复在结算调用预算内仍处于降级状态。",
        },
        revised: false,
        status: "state-degraded",
        lengthWarnings: targetMeta.lengthWarnings,
        lengthTelemetry: targetMeta.lengthTelemetry,
        tokenUsage: targetMeta.tokenUsage,
      };
    }

    this.throwIfAborted();
    await writer.saveEpisode(bookDir, repairedOutput, gp.numericalSystem, pipelineLang);
    await writer.saveNewTruthFiles(bookDir, repairedOutput, pipelineLang);
    await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetEpisode, repairedOutput);
    await this.state.snapshotState(bookId, targetEpisode);

    const baseStatus = resolveStateDegradedBaseStatus(targetMeta);
    const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
    const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
    index[targetIndex] = {
      ...targetMeta,
      status: baseStatus,
      updatedAt: new Date().toISOString(),
      auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
      reviewNote: undefined,
    };
    await this.state.saveEpisodeIndex(bookId, index);
    // Memory bootstrap derives durable progress from the episode index. Commit
    // the repaired status before rebuilding indexes so it cannot normalize the
    // repaired manifest back behind the current-state episode.
    await this.syncNarrativeMemoryIndex(bookId);
    await this.syncCurrentStateFactHistory(bookId, targetEpisode);

    const repairedPassesAudit = baseStatus !== "audit-failed";
    const remainingAuditIssues = repairedPassesAudit
      ? []
      : auditIssuesFromEpisodeRecovery(targetMeta, content);
    if (repairedPassesAudit) {
      await this.markBookActiveIfNeeded(bookId);
    }
    return {
      episodeNumber: targetEpisode,
      title: targetMeta.title,
      episodeDurationSeconds: targetMeta.episodeDurationSeconds,
      auditResult: {
        passed: repairedPassesAudit,
        issues: remainingAuditIssues,
        summary: repairedPassesAudit ? "state repaired" : "state repaired but episode still needs review",
      },
      revised: false,
      status: baseStatus,
      lengthWarnings: targetMeta.lengthWarnings,
      lengthTelemetry: targetMeta.lengthTelemetry,
      tokenUsage: targetMeta.tokenUsage,
    };
  }

  private async _resyncEpisodeArtifactsLocked(bookId: string, episodeNumber?: number): Promise<EpisodePipelineResult> {
    this.throwIfAborted();
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const stageLanguage = await this.resolveBookLanguage(book);
    const index = [...(await this.state.loadEpisodeIndex(bookId))];
    if (index.length === 0) {
      throw new Error(`Book "${bookId}" has no persisted episodes to sync.`);
    }

    const targetEpisode = episodeNumber ?? index[index.length - 1]!.episodeNumber;
    const targetIndex = index.findIndex((episode) => episode.episodeNumber === targetEpisode);
    if (targetIndex < 0) {
      throw new Error(`Episode ${targetEpisode} not found in "${bookId}".`);
    }

    const targetMeta = index[targetIndex]!;
    const latestEpisode = Math.max(...index.map((episode) => episode.episodeNumber));
    if (targetEpisode !== latestEpisode) {
      throw new Error(`Only the latest persisted episode can be synced safely (latest is ${latestEpisode}).`);
    }

    this.logStage(stageLanguage, { zh: "根据已编辑正文同步真相文件与索引", en: "syncing truth files and indexes from edited episode body" });
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const pipelineLang = book.language ?? gp.language;
    // The authoritative episode JSON wins over the markdown projection: editors
    // (and this session's deterministic fixes) often patch the .json directly,
    // and the .md sidecar then carries a stale embedded script. Prefer the .json
    // and re-project it into markdown so both files converge on the same script.
    const authoritativeScript = await loadPersistedEpisodeScript(bookDir, targetEpisode);
    const content = authoritativeScript
      ? renderEpisodeScriptMarkdown(authoritativeScript)
      : await this.readEpisodeContent(bookDir, targetEpisode);
    const storyDir = join(bookDir, "story");

    // Resync must replay the edited episode from the previous durable truth.
    // Using the live truth here can re-apply the same episode on top of itself
    // and preserve hallucinated state from an earlier settlement.
    await this.state.snapshotState(bookId, targetEpisode);
    await this.state.saveEpisodeIndex(bookId, index.map((episode) =>
      episode.episodeNumber === targetEpisode
        ? { ...episode, status: "state-degraded" as const }
        : episode,
    ));
    let restoreOriginalIndexOnFailure = true;
    const restoredPreviousTruth = targetEpisode > 0
      ? await this.state.restoreState(bookId, targetEpisode - 1)
      : false;

    try {
      if (restoredPreviousTruth) {
        await rewriteStructuredStateFromMarkdown({
          bookDir,
          fallbackEpisode: targetEpisode - 1,
          authoritativeEpisode: targetEpisode - 1,
        });
      }
      const reducedControlInput = await this.createGovernedArtifacts(
        book,
        bookDir,
        targetEpisode,
        this.config.externalContext,
        { reuseExistingIntentWhenContextMissing: true },
      );
      const oldState = getEpisodeContextContent(
        reducedControlInput.episodeContextSnapshot,
        "story/current_state.md",
      );
      const oldHooks = getEpisodeContextContent(
        reducedControlInput.episodeContextSnapshot,
        "story/pending_hooks.md",
      );

      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      let syncedOutput = await writer.replayEpisodeState({
      book,
      bookDir,
      episodeNumber: targetEpisode,
      title: targetMeta.title,
      content,
      episodeIntent: reducedControlInput?.plan.intentMarkdown,
      contextPackage: reducedControlInput?.composed.contextPackage,
      ruleStack: reducedControlInput?.composed.ruleStack,
      allowReapply: true,
      episodeContextSnapshot: reducedControlInput.episodeContextSnapshot,
    });
      const validator = new StateValidatorAgent(this.agentCtxFor("state-validator", bookId));
      let validation = this.validateResyncSettlementCompleteness(
        syncedOutput,
        pipelineLang,
      ) ?? await validator.validate(
        content,
        targetEpisode,
        oldState,
        syncedOutput.updatedState,
        oldHooks,
        syncedOutput.updatedHooks,
        pipelineLang,
      );

      const settlementRetryAllowed = this.config.governanceCallLimits?.maxSettlementCallsPerEpisode === undefined
        || this.config.governanceCallLimits.maxSettlementCallsPerEpisode > 1;
      if (!validation.passed && settlementRetryAllowed) {
        const recovery = await replayEpisodeStateAfterValidationFailure({
        writer,
        validator,
        book,
        bookDir,
        episodeNumber: targetEpisode,
        title: targetMeta.title,
        content,
        reducedControlInput: reducedControlInput
          ? {
              episodeIntent: reducedControlInput.plan.intentMarkdown,
              contextPackage: reducedControlInput.composed.contextPackage,
              ruleStack: reducedControlInput.composed.ruleStack,
            }
          : undefined,
        episodeContextSnapshot: reducedControlInput.episodeContextSnapshot,
        oldState,
        oldHooks,
        originalValidation: validation,
        language: pipelineLang,
        logWarn: (message) => this.logWarn(pipelineLang, message),
        logger: this.config.logger,
      });
        if (recovery.kind === "recovered") {
          syncedOutput = recovery.output;
          validation = recovery.validation;
        } else {
          validation = {
            passed: false,
            warnings: recovery.issues.map((issue) => ({
              category: issue.category,
              description: issue.description,
            })),
          };
        }
      }

      const incompleteRetry = this.validateResyncSettlementCompleteness(
        syncedOutput,
        pipelineLang,
      );
      if (incompleteRetry || !validation.passed) {
        const replayRecovery = await this.recoverResyncWithDeterministicReplay({
          bookId,
          book,
          bookDir,
          episodeNumber: targetEpisode,
          title: targetMeta.title,
          content,
          reducedControlInput: reducedControlInput
            ? {
                episodeIntent: reducedControlInput.plan.intentMarkdown,
                contextPackage: reducedControlInput.composed.contextPackage,
                ruleStack: reducedControlInput.composed.ruleStack,
              }
            : undefined,
          episodeContextSnapshot: reducedControlInput.episodeContextSnapshot,
          validator,
          oldState,
          oldHooks,
          language: pipelineLang,
          previousValidation: incompleteRetry ?? validation,
          settlementAttempts: settlementRetryAllowed ? 2 : 1,
        });
        syncedOutput = replayRecovery.output;
        validation = replayRecovery.validation;
      }

      this.throwIfAborted();
      await writer.saveEpisode(bookDir, syncedOutput, gp.numericalSystem, pipelineLang);
      await writer.saveNewTruthFiles(bookDir, syncedOutput, pipelineLang);
      await this.syncLegacyStructuredStateFromMarkdown(bookDir, targetEpisode, syncedOutput);
      await this.state.snapshotState(bookId, targetEpisode);

      const finalStatus: "ready-for-review" | "audit-failed" = targetMeta.status === "state-degraded"
        ? resolveStateDegradedBaseStatus(targetMeta)
        : targetMeta.status === "audit-failed"
          ? "audit-failed"
          : "ready-for-review";
      const remainingAuditIssues = finalStatus === "audit-failed"
        ? auditIssuesFromEpisodeRecovery(targetMeta, content)
        : [];

      if (targetMeta.status === "state-degraded") {
        const degradedMetadata = parseStateDegradedReviewNote(targetMeta.reviewNote);
        const injectedIssues = new Set(degradedMetadata?.injectedIssues ?? []);
        index[targetIndex] = {
          ...targetMeta,
          status: finalStatus,
          updatedAt: new Date().toISOString(),
          auditIssues: targetMeta.auditIssues.filter((issue) => !injectedIssues.has(issue)),
          reviewNote: undefined,
        };
      } else {
        index[targetIndex] = {
          ...targetMeta,
          status: finalStatus,
          updatedAt: new Date().toISOString(),
        };
      }
      await this.state.saveEpisodeIndex(bookId, index);
      restoreOriginalIndexOnFailure = false;
      await this.syncNarrativeMemoryIndex(bookId);
      await this.syncCurrentStateFactHistory(bookId, targetEpisode);
      if (finalStatus === "ready-for-review") {
        await this.markBookActiveIfNeeded(bookId);
      }
      return {
        episodeNumber: targetEpisode,
        title: targetMeta.title,
        episodeDurationSeconds: targetMeta.episodeDurationSeconds,
        auditResult: {
          passed: finalStatus !== "audit-failed",
          issues: remainingAuditIssues,
          summary: finalStatus === "audit-failed"
            ? "episode truth/state resynced from edited body, but episode still needs audit fixes"
            : "episode truth/state resynced from edited body",
        },
        revised: false,
        status: finalStatus,
        lengthWarnings: targetMeta.lengthWarnings,
        lengthTelemetry: targetMeta.lengthTelemetry,
        tokenUsage: targetMeta.tokenUsage,
      };
    } catch (error) {
      if (restoredPreviousTruth) {
        await this.state.restoreState(bookId, targetEpisode);
      }
      if (restoreOriginalIndexOnFailure) {
        await this.state.saveEpisodeIndex(bookId, index);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Import operations (canon for spinoff)
  // ---------------------------------------------------------------------------

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    // Validate both books exist
    const bookIds = await this.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(`Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(`Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }

    const parentDir = this.state.bookDir(parentBookId);
    const targetDir = this.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readSafe = async (path: string): Promise<string> => {
      try { return await readFile(path, "utf-8"); } catch { return "(无)"; }
    };

    const parentBook = await this.state.loadBookConfig(parentBookId);

    // Phase 5: parent book may be on the new prose layout; prefer outline/.
    const readParentOutline = async (newRel: string, legacyRel: string): Promise<string> => {
      const preferred = await readSafe(join(parentDir, "story", newRel));
      if (preferred.trim() && preferred !== "(无)") return preferred;
      return readSafe(join(parentDir, "story", legacyRel));
    };

    const [storyBible, currentState, ledger, hooks, summaries, subplots, emotions, matrix] =
      await Promise.all([
        readParentOutline("outline/story_frame.md", "story_bible.md"),
        readSafe(join(parentDir, "story/current_state.md")),
        readSafe(join(parentDir, "story/particle_ledger.md")),
        readSafe(join(parentDir, "story/pending_hooks.md")),
        readSafe(join(parentDir, "story/episode_summaries.md")),
        readSafe(join(parentDir, "story/subplot_board.md")),
        readSafe(join(parentDir, "story/emotional_arcs.md")),
        readSafe(join(parentDir, "story/character_matrix.md")),
      ]);

    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位网络小说架构师。基于正传的全部设定和状态文件，生成一份完整的"正传正典参照"文档，供番外写作和审计使用。

输出格式（Markdown）：
# 正传正典（《{正传书名}》）

## 世界规则（完整，来自正传设定）
（力量体系、地理设定、阵营关系、核心规则——完整复制，不压缩）

## 正典约束（不可违反的事实）
| 约束ID | 类型 | 约束内容 | 严重性 |
|---|---|---|---|
| C01 | 人物存亡 | ... | critical |
（列出所有硬性约束：谁活着、谁死了、什么事件已经发生、什么规则不可违反）

## 角色快照
| 角色 | 当前状态 | 性格底色 | 对话特征 | 已知信息 | 未知信息 |
|---|---|---|---|---|---|
（从状态卡和角色矩阵中提取每个重要角色的完整快照）

## 角色双态处理原则
- 未来会变强的角色：写潜力暗示
- 未来会黑化的角色：写微小裂痕
- 未来会死的角色：写导致死亡的性格底色

## 关键事件时间线
| 剧集 | 事件 | 涉及角色 | 对番外的约束 |
|---|---|---|---|
（从剧集摘要中提取关键事件）

## 伏笔状态
| Hook ID | 类型 | 状态 | 内容 | 预期回收 |
|---|---|---|---|---|

## 资源账本快照
（当前资源状态）

---
meta:
  parentBookId: "{parentBookId}"
  parentTitle: "{正传书名}"
  generatedAt: "{ISO timestamp}"

要求：
1. 世界规则完整复制，不压缩——准确性优先
2. 正典约束必须穷尽，遗漏会导致番外与正传矛盾
3. 角色快照必须包含信息边界（已知/未知），防止番外中角色引用不该知道的信息`,
      },
      {
        role: "user",
        content: `正传书名：${parentBook.title}
正传ID：${parentBookId}

## 正传世界设定
${storyBible}

## 正传当前状态卡
${currentState}

## 正传资源账本
${ledger}

## 正传伏笔池
${hooks}

## 正传剧集摘要
${summaries}

## 正传支线进度
${subplots}

## 正传情感弧线
${emotions}

## 正传角色矩阵
${matrix}`,
      },
    ], { temperature: 0.3 });

    // Append deterministic meta block (LLM may hallucinate timestamps)
    const metaBlock = [
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");
    const canon = response.content + metaBlock;

    await writeFile(join(storyDir, "parent_canon.md"), canon, "utf-8");

    return canon;
  }

  // ---------------------------------------------------------------------------
  // Episode import (for continuation writing from existing episodes)
  // ---------------------------------------------------------------------------

  /**
   * Import existing episodes into a book. Reverse-engineers all truth files
   * via sequential replay so the Writer and Auditor can continue naturally.
   *
   * Step 1: Generate foundation (story_frame, volume_map, book_rules) from all episodes.
   * Step 2: Sequentially replay each authoritative EpisodeScript through the deterministic reducer.
   */
  async importEpisodes(input: ImportEpisodesInput): Promise<ImportEpisodesResult> {
    const releaseLock = await this.state.acquireBookLock(input.bookId);
    try {
      const recovery = await this.state.recoverIncompleteEpisodePersistence(input.bookId);
      const book = await this.state.loadBookConfig(input.bookId);
      const bookDir = this.state.bookDir(input.bookId);
      const { profile: gp } = await this.loadGenreProfile(book.genre);
      const resolvedLanguage = book.language ?? gp.language;

      const startFrom = input.resumeFrom ?? 1;

      const log = this.config.logger?.child("import");

      // Step 1: Generate foundation on first run (not on resume)
      if (startFrom === 1) {
        log?.info(this.localize(resolvedLanguage, {
          zh: `步骤 1：从 ${input.episodes.length} 章生成基础设定...`,
          en: `Step 1: Generating foundation from ${input.episodes.length} episodes...`,
        }));
        const foundationSource = buildImportFoundationSource(input.episodes, resolvedLanguage);

        const architect = new ArchitectAgent(this.agentCtxFor("architect", input.bookId));
        const isSeries = input.importMode === "series";
        const foundation = isSeries
          ? await this.generateAndReviewFoundation({
              generate: (reviewFeedback) => architect.generateFoundationFromImport(book, foundationSource, undefined, reviewFeedback, { importMode: "series" }),
              reviewer: new FoundationReviewerAgent(this.agentCtxFor("foundation-reviewer", input.bookId)),
              mode: "series",
              language: resolvedLanguage === "en" ? "en" : "zh",
              stageLanguage: resolvedLanguage,
              bookId: input.bookId,
              targetEpisodes: book.targetEpisodes,
            })
          : await architect.generateFoundationFromImport(book, foundationSource);
        await architect.writeFoundationFiles(
          bookDir,
          foundation,
          gp.numericalSystem,
          resolvedLanguage,
        );
        await this.resetImportReplayTruthFiles(bookDir, resolvedLanguage);
        await this.state.saveEpisodeIndex(input.bookId, [], { allowEmptyWithEpisodeFiles: true });
        await this.state.snapshotState(input.bookId, 0);

        log?.info(this.localize(resolvedLanguage, {
          zh: "基础设定已生成。",
          en: "Foundation generated.",
        }));
      }

      // Step 2: Sequential replay
      log?.info(this.localize(resolvedLanguage, {
        zh: `步骤 2：从第 ${startFrom} 集开始顺序回放...`,
        en: `Step 2: Sequential replay from episode ${startFrom}...`,
      }));
      const writerCtx = this.agentCtxFor("writer", input.bookId);
      const writer = new WriterAgent(writerCtx);
      let totalDurationSeconds = 0;
      let importedCount = 0;

      for (let i = startFrom - 1; i < input.episodes.length; i++) {
        const ch = input.episodes[i]!;
        const episodeNumber = i + 1;
        log?.info(this.localize(resolvedLanguage, {
          zh: `投影剧集 ${episodeNumber}/${input.episodes.length}：${ch.title}...`,
          en: `Projecting episode ${episodeNumber}/${input.episodes.length}: ${ch.title}...`,
        }));

        const episodeContextSnapshot = await loadEpisodeContextSnapshot({
          bookDir,
          episode: episodeNumber,
          model: writerCtx.model,
          service: writerCtx.client.service ?? "unknown",
        });

        const output = await writer.replayEpisodeState({
          book,
          bookDir,
          episodeNumber,
          content: ch.content,
          title: ch.title,
          episodeContextSnapshot,
        });

        const episodeDurationSeconds = output.episodeScriptMetrics?.estimatedDurationSeconds
          ?? output.episodeDurationSeconds;
        const persistedOutput: WriteEpisodeOutput = {
          ...output,
          content: ch.content,
          episodeDurationSeconds: episodeDurationSeconds,
          postWriteErrors: [],
          postWriteWarnings: [],
        };

        // Save episode file + core truth files (state, ledger, hooks)
        await writer.saveEpisode(bookDir, persistedOutput, gp.numericalSystem, resolvedLanguage);

        // Save extended truth files (summaries, subplots, emotional arcs, character matrix)
        await writer.saveNewTruthFiles(bookDir, {
          ...output,
          postWriteErrors: [],
          postWriteWarnings: [],
        }, resolvedLanguage);
        await this.syncLegacyStructuredStateFromMarkdown(bookDir, episodeNumber, output);
        await this.syncNarrativeMemoryIndex(input.bookId);

        // Update episode index
        const existingIndex = await this.state.loadEpisodeIndex(input.bookId);
        const now = new Date().toISOString();
        const newEntry: EpisodeMeta = {
          episodeNumber: episodeNumber,
          title: output.title,
          status: "imported",
          episodeDurationSeconds: episodeDurationSeconds,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        };
        // Replace if exists (resume case), otherwise append
        const existingIdx = existingIndex.findIndex((e) => e.episodeNumber === episodeNumber);
        const updatedIndex = existingIdx >= 0
          ? existingIndex.map((e, idx) => idx === existingIdx ? newEntry : e)
          : [...existingIndex, newEntry];
        await this.state.saveEpisodeIndex(input.bookId, updatedIndex);

        // Snapshot state after each episode for rollback + resume support
        await this.state.snapshotState(input.bookId, episodeNumber);

        importedCount++;
        totalDurationSeconds += episodeDurationSeconds;
      }

      if (input.episodes.length > 0) {
        await this.markBookActiveIfNeeded(input.bookId);
        await this.syncCurrentStateFactHistory(input.bookId, input.episodes.length);
      }

      const nextEpisode = input.episodes.length + 1;
      log?.info(this.localize(resolvedLanguage, {
        zh: `完成。已导入 ${importedCount} 集，共 ${totalDurationSeconds} 秒。下一集：${nextEpisode}`,
        en: `Done. ${importedCount} episodes imported, ${totalDurationSeconds}s. Next episode: ${nextEpisode}`,
      }));

      return {
        bookId: input.bookId,
        importedCount,
        totalDurationSeconds,
        nextEpisode,
        ...(recovery.kind === "none" ? {} : { recovery }),
      };
    } finally {
      await releaseLock();
    }
  }

  private static addUsage(
    a: TokenUsageSummary,
    b?: { readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number },
  ): TokenUsageSummary {
    if (!b) return a;
    return {
      promptTokens: a.promptTokens + b.promptTokens,
      completionTokens: a.completionTokens + b.completionTokens,
      totalTokens: a.totalTokens + b.totalTokens,
    };
  }

  private async buildPersistenceOutput(
    bookId: string,
    book: BookConfig,
    bookDir: string,
    episodeNumber: number,
    output: WriteEpisodeOutput,
    finalContent: string,
    countingMode: Parameters<typeof countEpisodeLength>[1],
    reducedControlInput?: {
      episodeIntent: string;
      contextPackage: ContextPackage;
      ruleStack: RuleStack;
    },
    episodeContextSnapshot?: EpisodeContextSnapshot,
  ): Promise<WriteEpisodeOutput> {
    if (finalContent === output.content) {
      return output.episodeScriptMetrics
        ? {
            ...output,
            episodeDurationSeconds: output.episodeScriptMetrics.estimatedDurationSeconds,
          }
        : output;
    }

    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    const replayed = await writer.replayEpisodeState({
      book,
      bookDir,
      episodeNumber,
      title: output.title,
      content: finalContent,
      allowReapply: true,
      episodeContextSnapshot: episodeContextSnapshot
        ?? await this.loadWriterEpisodeContextSnapshot(bookId, bookDir, episodeNumber),
    });

    return {
      ...replayed,
      title: output.title,
      postWriteErrors: [],
      postWriteWarnings: [],
      hookHealthIssues: output.hookHealthIssues,
      tokenUsage: output.tokenUsage,
    };
  }

  private async assertNoPendingStateRepair(bookId: string): Promise<void> {
    const existingIndex = await this.state.loadEpisodeIndex(bookId);
    const latestEpisode = [...existingIndex].sort((left, right) => right.episodeNumber - left.episodeNumber)[0];
    if (latestEpisode?.status !== "state-degraded" && latestEpisode?.status !== "audit-failed") {
      return;
    }

    if (latestEpisode.status === "audit-failed") {
      throw new Error(
        `Latest episode ${latestEpisode.episodeNumber} is audit-failed. Revise or rewrite that episode before continuing.`,
      );
    }

    throw new Error(
      `Latest episode ${latestEpisode.episodeNumber} is state-degraded. Repair state or rewrite that episode before continuing. To repair: run \`inkos write repair-state <book> ${latestEpisode.episodeNumber}\` (rebuilds truth files without rewriting body text), or \`inkos write sync <book> ${latestEpisode.episodeNumber} [--brief "<guidance>"]\` after manual edits.`,
    );
  }

  private async assertCanonRefreshBacklog(bookId: string, bookDir: string): Promise<void> {
    const unclaimed = await loadUnclaimedFacts(bookDir);
    const threshold = this.config.unclaimedFactsBacklogThreshold
      ?? DEFAULT_UNCLAIMED_FACTS_BACKLOG_THRESHOLD;
    if (!hasUnclaimedFactsBacklog(unclaimed, threshold)) return;
    throw new Error(
      `CANON_REFRESH_REQUIRED: ${unclaimed.facts.length} unclaimed episode facts exceed the ${threshold}-fact backlog threshold for ${bookId}. Run \`inkos canon refresh ${bookId}\` and review the resulting claims before planning or writing another episode.`,
    );
  }

  private async loadWriterEpisodeContextSnapshot(
    bookId: string,
    bookDir: string,
    episodeNumber: number,
  ): Promise<EpisodeContextSnapshot> {
    const writerCtx = this.agentCtxFor("writer", bookId);
    return loadEpisodeContextSnapshot({
      bookDir,
      episode: episodeNumber,
      model: writerCtx.model,
      service: writerCtx.client.service ?? "unknown",
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async prepareEpisodeAuditGates(params: {
    readonly bookId: string;
    readonly bookDir: string;
    readonly episodeNumber: number;
    readonly language: LengthLanguage;
    readonly genreProfile: GenreProfile;
    readonly episodeMemo?: EpisodeMemo;
    readonly contextPackage?: ContextPackage;
  }): Promise<PreparedEpisodeAuditGates> {
    const { validatePostWrite } = await import("../agents/post-write-validator.js");
    const { validateHookLedger } = await import("../utils/hook-ledger-validator.js");
    const { readBookRules } = await import("../agents/rules-reader.js");
    const parsedBookRules = (await readBookRules(params.bookDir))?.rules ?? null;
    const compiledClaims = await this.loadCompiledClaimsForPostGate(
      params.bookDir,
      params.episodeNumber,
      params.contextPackage,
    );
    const volumeContract = await this.loadVolumeContractForPostGate(
      params.bookDir,
      params.episodeNumber,
      params.contextPackage,
    );
    const volumeProgress = volumeContract
      ? await loadVolumeProgress(params.bookDir)
      : null;

    return {
      compiledClaims,
      volumeContract,
      volumeProgress,
      runPostWriteChecks: (content) => {
        const baseIssues = validatePostWrite(
          content,
          params.genreProfile,
          parsedBookRules,
          params.language,
        ).map((violation) => ({
          severity: violation.severity === "error" ? "critical" as const : "warning" as const,
          category: violation.rule,
          description: violation.description,
          suggestion: violation.suggestion,
          repairScope: violation.repairScope,
        }));
        const memoBody = params.episodeMemo?.body ?? "";
        const ledgerIssues = memoBody
          ? validateHookLedger(memoBody, content)
          : [];

        return [
          ...baseIssues,
          ...ledgerIssues,
          ...(memoBody
            ? validateMemoInternalConsistency(memoBody, params.language)
            : []),
          ...(memoBody
            ? validateEpisodeMemoCommitments(memoBody, content, params.language)
            : []),
          ...this.runPostWriteClaimGateForEpisode(content, params.bookId, compiledClaims),
          ...this.runPostWriteVolumeGateForEpisode(
            content,
            params.bookId,
            params.episodeMemo,
            volumeContract,
            volumeProgress,
          ),
        ];
      },
    };
  }

  private async loadCompiledClaimsForPostGate(
    bookDir: string,
    episodeNumber: number,
    contextPackage?: ContextPackage,
  ): Promise<CompiledEpisodeClaims | null> {
    const hasClaimBrief = contextPackage?.selectedContext.some((entry) =>
      entry.source === "runtime/episode_claim_brief"
    );
    if (!hasClaimBrief) return null;

    const claimsPath = join(
      bookDir,
      "story",
      "runtime",
      `episode-${String(episodeNumber).padStart(4, "0")}.claims.json`,
    );
    try {
      return JSON.parse(await readFile(claimsPath, "utf-8")) as CompiledEpisodeClaims;
    } catch (error) {
      this.config.logger?.warn(`[claim-gate] failed to load ${claimsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private runPostWriteClaimGateForEpisode(
    content: string,
    bookId: string,
    compiled: CompiledEpisodeClaims | null,
  ): ReadonlyArray<AuditIssue> {
    if (!compiled) return [];
    const claimValidator = new ClaimValidatorAgent(this.agentCtxFor("claim-validator", bookId));
    return claimValidator.runPostWriteClaimGate({
      text: content,
      compiled,
      phase: "post",
    });
  }

  private async loadVolumeContractForPostGate(
    bookDir: string,
    episodeNumber: number,
    _contextPackage?: ContextPackage,
  ): Promise<VolumeContract | null> {
    // The volume contract is compiled into `runtime/compiled-context` when the
    // context budget is applied, so the discrete `runtime/volume_contract`
    // entry may be absent from the persisted context. The contracts file is
    // authoritative: presence of the file means the composer resolved the
    // volume for this book. Read it directly instead of relying on a context
    // entry that budgeting may have folded away.
    try {
      return await readSavedVolumeContract(bookDir, episodeNumber);
    } catch (error) {
      this.config.logger?.warn(`[volume-gate] failed to load volume contract: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private runPostWriteVolumeGateForEpisode(
    content: string,
    bookId: string,
    memo: EpisodeMemo | undefined,
    contract: VolumeContract | null,
    progress: VolumeProgressFile | null,
  ): ReadonlyArray<AuditIssue> {
    if (!memo || !contract) return [];
    const volumeAuditor = new VolumeAuditorAgent(this.agentCtxFor("volume-auditor", bookId));
    return volumeAuditor.auditVolumeGate({
      text: content,
      memo,
      contract,
      progress: progress ?? undefined,
      episodeNumber: memo.episode,
      phase: "post",
    }).map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      description: issue.description,
      suggestion: issue.suggestion ?? "Bind this episode to a valid volume KR or explain the buffer/transition exception.",
      repairScope: toAuditRepairScope(issue.repairScope),
    }));
  }

  private async prepareWriteInput(
    book: BookConfig,
    bookDir: string,
    episodeNumber: number,
    externalContext?: string,
    incomingState?: EpisodeScript["contract"]["handoffState"],
  ): Promise<Pick<WriteEpisodeInput, "externalContext" | "episodeIntent" | "episodeMemo" | "episodeIntentData" | "contextPackage" | "ruleStack" | "episodeContextSnapshot">> {
    const { plan, composed, episodeContextSnapshot } = await this.createGovernedArtifacts(
      book,
      bookDir,
      episodeNumber,
      externalContext,
      { reuseExistingIntentWhenContextMissing: true },
      incomingState,
    );

    return {
      externalContext,
      episodeIntent: plan.intentMarkdown,
      episodeMemo: plan.memo,
      episodeIntentData: plan.intent,
      contextPackage: composed.contextPackage,
      ruleStack: composed.ruleStack,
      episodeContextSnapshot,
    };
  }

  private async resetImportReplayTruthFiles(
    bookDir: string,
    language: LengthLanguage,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");

    await Promise.all([
      writeFile(
        join(storyDir, "current_state.md"),
        this.buildImportReplayStateSeed(language),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        this.buildImportReplayHooksSeed(language),
        "utf-8",
      ),
      rm(join(storyDir, "episode_summaries.md"), { force: true }),
      rm(join(storyDir, "subplot_board.md"), { force: true }),
      rm(join(storyDir, "emotional_arcs.md"), { force: true }),
      rm(join(storyDir, "character_matrix.md"), { force: true }),
      rm(join(storyDir, "volume_summaries.md"), { force: true }),
      rm(join(storyDir, "particle_ledger.md"), { force: true }),
      rm(join(storyDir, "memory.db"), { force: true }),
      rm(join(storyDir, "memory.db-shm"), { force: true }),
      rm(join(storyDir, "memory.db-wal"), { force: true }),
      rm(join(storyDir, "state"), { recursive: true, force: true }),
      rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
    ]);
  }

  private buildImportReplayStateSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Episode | 0 |",
        "| Current Location | (not set) |",
        "| Protagonist State | (not set) |",
        "| Current Goal | (not set) |",
        "| Current Constraint | (not set) |",
        "| Current Alliances | (not set) |",
        "| Current Conflict | (not set) |",
        "",
      ].join("\n");
    }

    return [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前剧集 | 0 |",
      "| 当前位置 | （未设定） |",
      "| 主角状态 | （未设定） |",
      "| 当前目标 | （未设定） |",
      "| 当前限制 | （未设定） |",
      "| 当前敌我 | （未设定） |",
      "| 当前冲突 | （未设定） |",
      "",
    ].join("\n");
  }

  private buildImportReplayHooksSeed(language: LengthLanguage): string {
    if (language === "en") {
      return [
        "# Pending Hooks",
        "",
        "| hook_id | start_episode | type | status | last_advanced_episode | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "",
      ].join("\n");
    }

    return [
      "# 伏笔池",
      "",
      "| hook_id | 起始剧集 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  private normalizeEpisodeScriptProjection(params: {
    episodeNumber: number;
    episodeContent: string;
    targetDurationSeconds: number;
  }): {
    content: string;
    episodeDurationSeconds: number;
    applied: boolean;
    script: EpisodeScript;
  } {
    const script = parseEpisodeScriptOutput(params.episodeContent, params.episodeNumber);
    const content = renderEpisodeScriptMarkdown(script);
    const metrics = measureEpisodeScript(script, params.targetDurationSeconds);
    return {
      content,
      episodeDurationSeconds: metrics.estimatedDurationSeconds,
      applied: content !== params.episodeContent,
      script,
    };
  }

  private assertEpisodeContentNotEmpty(content: string, episodeNumber: number, stage: string): void {
    if (content.trim().length > 0) return;
    throw new Error(`Episode ${episodeNumber} has empty episode content after ${stage}`);
  }

  private async syncCurrentStateFactHistory(bookId: string, uptoEpisode: number): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.rebuildCurrentStateFactHistory(bookDir, uptoEpisode);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildCurrentStateFactHistory(bookDir, uptoEpisode);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `状态事实同步已跳过：${String(error)}`,
        en: `State fact sync skipped: ${String(error)}`,
      });
    }
  }

  private async syncLegacyStructuredStateFromMarkdown(
    bookDir: string,
    episodeNumber: number,
    output?: {
      readonly runtimeStateDelta?: WriteEpisodeOutput["runtimeStateDelta"];
      readonly runtimeStateSnapshot?: WriteEpisodeOutput["runtimeStateSnapshot"];
    },
  ): Promise<void> {
    // Only a reducer-backed delta guarantees that the manifest and every
    // structured state file were advanced as one coherent snapshot. Legacy
    // settlement output may include an LLM-provided snapshot without a delta;
    // rebuild that case from the persisted markdown projections before memory
    // indexing so a current-state episode cannot run ahead of the manifest.
    if (output?.runtimeStateDelta) {
      return;
    }

    await rewriteStructuredStateFromMarkdown({
      bookDir,
      fallbackEpisode: episodeNumber,
      authoritativeEpisode: episodeNumber,
    });
  }

  private async upsertAcceptedRevisionSummary(params: {
    readonly storyDir: string;
    readonly episodeNumber: number;
    readonly title: string;
    readonly content: string;
    readonly language: "zh" | "en";
    readonly changeKind?: "patch" | "rewrite";
  }): Promise<void> {
    const summaryPath = join(params.storyDir, "episode_summaries.md");
    const markdown = await readFile(summaryPath, "utf-8").catch(() => "");
    const summaries = parseEpisodeSummariesMarkdown(markdown);
    const existing = summaries.find((row) => row.episode === params.episodeNumber);
    const shouldRefreshEvents = !existing || params.changeKind === "rewrite";
    const contentExcerpt = params.content
      .replace(/^#{1,6}\s+.*$/gmu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, params.language === "en" ? 360 : 240)
      .trim();
    const fallbackEvent = contentExcerpt || (params.language === "en"
      ? "Accepted revised episode."
      : "已接受修订后的剧集脚本。");
    const revisedSummary = {
      episodeNumber: params.episodeNumber,
      title: params.title,
      characters: existing?.characters ?? "",
      events: shouldRefreshEvents ? fallbackEvent : existing.events,
      stateChanges: existing?.stateChanges ?? "",
      hookActivity: existing?.hookActivity ?? "",
      mood: existing?.mood ?? "",
      episodeType: existing?.episodeType ?? "",
    };
    const nextRows = [
      ...summaries
        .filter((row) => row.episode !== params.episodeNumber)
        .map((row) => ({ ...row, episodeNumber: row.episode })),
      revisedSummary,
    ];

    await writeFile(
      summaryPath,
      renderEpisodeSummariesProjection({ rows: nextRows }, params.language),
      "utf-8",
    );
  }

  private async syncNarrativeMemoryIndex(bookId: string): Promise<void> {
    const bookDir = this.state.bookDir(bookId);
    try {
      await this.rebuildNarrativeMemoryIndex(bookDir);
    } catch (error) {
      if (this.isMemoryIndexUnavailableError(error)) {
        if (this.canOpenMemoryIndex(bookDir)) {
          try {
            await this.rebuildNarrativeMemoryIndex(bookDir);
            return;
          } catch (retryError) {
            error = retryError;
          }
        } else {
          if (!this.memoryIndexFallbackWarned) {
            this.memoryIndexFallbackWarned = true;
            this.logWarn(await this.resolveBookLanguageById(bookId), {
              zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
              en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
            });
            await this.logMemoryIndexDebugInfo(bookId, error);
          }
          return;
        }
      }
      this.logWarn(await this.resolveBookLanguageById(bookId), {
        zh: `叙事记忆同步已跳过：${String(error)}`,
        en: `Narrative memory sync skipped: ${String(error)}`,
      });
    }
  }

  private async rebuildCurrentStateFactHistory(bookDir: string, uptoEpisode: number): Promise<void> {
    const memoryDb = await this.withMemoryIndexRetry(async () => {
      const db = new MemoryDB(bookDir);
      try {
        db.resetFacts();

        const activeFacts = new Map<string, { id: number; object: string }>();

        for (let episode = 0; episode <= uptoEpisode; episode++) {
          const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, episode);
          if (snapshotFacts.length === 0) continue;
          const nextFacts = new Map<string, Omit<Fact, "id">>();

          for (const fact of snapshotFacts) {
            nextFacts.set(this.factKey(fact), {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.object,
              validFromEpisode: episode,
              validUntilEpisode: null,
              sourceEpisode: episode,
            });
          }

          for (const [key, previous] of activeFacts.entries()) {
            const next = nextFacts.get(key);
            if (!next || next.object !== previous.object) {
              db.invalidateFact(previous.id, episode);
              activeFacts.delete(key);
            }
          }

          for (const [key, fact] of nextFacts.entries()) {
            if (activeFacts.has(key)) continue;
            const id = db.addFact(fact);
            activeFacts.set(key, { id, object: fact.object });
          }
        }

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private async rebuildNarrativeMemoryIndex(bookDir: string): Promise<void> {
    const memorySeed = await loadNarrativeMemorySeed(bookDir);

    const memoryDb = await this.withMemoryIndexRetry(() => {
      const db = new MemoryDB(bookDir);
      try {
        db.replaceSummaries(memorySeed.summaries);
        db.replaceHooks(memorySeed.hooks);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    });

    try {
      // No-op: keep the db open only for the duration of the rebuild.
    } finally {
      memoryDb.close();
    }
  }

  private canOpenMemoryIndex(bookDir: string): boolean {
    let memoryDb: MemoryDB | null = null;
    try {
      memoryDb = new MemoryDB(bookDir);
      return true;
    } catch {
      return false;
    } finally {
      memoryDb?.close();
    }
  }

  private async logMemoryIndexDebugInfo(bookId: string, error: unknown): Promise<void> {
    if (process.env.INKOS_DEBUG_SQLITE_MEMORY !== "1") {
      return;
    }

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    this.logWarn(await this.resolveBookLanguageById(bookId), {
      zh: `SQLite 记忆索引调试：node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
      en: `SQLite memory debug: node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
    });
  }

  private async withMemoryIndexRetry<T>(operation: () => Promise<T> | T): Promise<T> {
    const retryDelaysMs = [0, 25, 75];
    let lastError: unknown;

    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isMemoryIndexBusyError(error) || attempt === retryDelaysMs.length - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt + 1]!));
      }
    }

    throw lastError;
  }

  private isMemoryIndexUnavailableError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);
    const normalizedMessage = message.trim();

    return /^No such built-in module:\s*node:sqlite$/i.test(normalizedMessage)
      || /^Cannot find module ['"]node:sqlite['"]$/i.test(normalizedMessage)
      || (code === "ERR_UNKNOWN_BUILTIN_MODULE" && /\bnode:sqlite\b/i.test(normalizedMessage));
  }

  private isMemoryIndexBusyError(error: unknown): boolean {
    if (!error) return false;

    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    const message = error instanceof Error
      ? error.message
      : String(error);

    return code === "SQLITE_BUSY"
      || code === "SQLITE_LOCKED"
      || /\bSQLITE_BUSY\b/i.test(message)
      || /\bSQLITE_LOCKED\b/i.test(message)
      || /database is locked/i.test(message)
      || /database is busy/i.test(message);
  }

  private factKey(fact: Pick<Fact, "subject" | "predicate">): string {
    return `${fact.subject}::${fact.predicate}`;
  }

  private buildLengthWarnings(
    episodeNumber: number,
    finalCount: number,
    lengthSpec: LengthSpec,
  ): string[] {
    if (!isOutsideHardRange(finalCount, lengthSpec)) {
      return [];
    }
    return [
      this.localize(this.languageFromLengthSpec(lengthSpec), {
        zh: `第${episodeNumber}集经过一次时长归一化后仍超出硬区间（${lengthSpec.hardMin}-${lengthSpec.hardMax}，实际 ${finalCount}）。`,
        en: `Episode ${episodeNumber} remains outside hard range (${lengthSpec.hardMin}-${lengthSpec.hardMax}, actual ${finalCount}) after a single normalization pass.`,
      }),
    ];
  }

  /**
   * Persist the writer's raw unparseable output for post-hoc diagnosis. The
   * file lands under story/runtime next to the episode traces; the error
   * message points at it so a failed `write next` is debuggable instead of
   * evaporating with the process.
   */
  /**
   * Write an episode through the WriterAgent with one bounded retry on output
   * parse failure. Transient model jitter can make both the initial response
   * and the writer's internal repair unparseable (observed in paid production
   * runs; a retry from scratch almost always succeeded). All write paths must
   * share this retry so `write next` / `auto` batch production gets the same
   * resilience as `write draft`; the failed attempts' tokens stay in the
   * accounting and the final raw output is persisted for diagnosis.
   */
  private async writeEpisodeWithRetry(params: {
    readonly writer: WriterAgent;
    readonly book: BookConfig;
    readonly bookDir: string;
    readonly episodeNumber: number;
    readonly writeInput: ReturnType<PipelineRunner["prepareWriteInput"]> extends Promise<infer T> ? T : never;
    readonly lengthSpec: LengthSpec;
    readonly episodeDurationSeconds?: number;
    readonly temperatureOverride?: number;
  }): Promise<{ readonly output: WriteEpisodeOutput; readonly writerFailedUsage: TokenUsageSummary | undefined }> {
    const { writer, book, bookDir, episodeNumber, writeInput, lengthSpec, episodeDurationSeconds, temperatureOverride } = params;
    let output: WriteEpisodeOutput | undefined;
    let writerFailedUsage: TokenUsageSummary | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        output = await writer.writeEpisode({
          book,
          bookDir,
          episodeNumber,
          ...writeInput,
          lengthSpec,
          ...(episodeDurationSeconds ? { durationSecondsOverride: episodeDurationSeconds } : {}),
          ...(temperatureOverride ? { temperatureOverride } : {}),
        });
        break;
      } catch (error) {
        if (!isWriterOutputParseFailure(error)) throw error;
        const failedUsage = (error as { tokenUsage?: TokenUsageSummary }).tokenUsage;
        if (failedUsage) {
          writerFailedUsage = {
            promptTokens: (writerFailedUsage?.promptTokens ?? 0) + failedUsage.promptTokens,
            completionTokens: (writerFailedUsage?.completionTokens ?? 0) + failedUsage.completionTokens,
            totalTokens: (writerFailedUsage?.totalTokens ?? 0) + failedUsage.totalTokens,
          };
        }
        if (attempt < 2) {
          this.config.logger?.warn(
            `[writer] 第${episodeNumber}集分镜稿解析失败（第${attempt}次），重新生成一次`,
          );
          continue;
        }
        const dumpPath = await this.dumpWriterRawOutput(bookDir, episodeNumber, error.rawOutput)
          .catch(() => undefined);
        if (dumpPath) {
          error.message += `\n原始输出已留存：${dumpPath}`;
        }
        throw error;
      }
    }
    if (!output) throw new Error(`writer produced no output for episode ${episodeNumber}`);
    return { output, writerFailedUsage };
  }

  private async dumpWriterRawOutput(
    bookDir: string,
    episodeNumber: number,
    rawOutput: string,
  ): Promise<string> {
    const runtimeDir = join(bookDir, "story", "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const padded = String(episodeNumber).padStart(4, "0");
    const dumpPath = join(runtimeDir, `episode-${padded}-writer-raw-fail.txt`);
    await writeFile(dumpPath, rawOutput, "utf-8");
    return dumpPath;
  }

  async getSeriesStatus(bookId: string): Promise<BookStatusInfo> {
    await this.state.loadEpisodeBookConfig(bookId);
    return this.getBookStatus(bookId);
  }

  async completeSeries(bookId: string): Promise<import("./series-completion.js").SeriesCompletionReport> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      await this.state.loadEpisodeBookConfig(bookId);
      const book = await this.state.loadBookConfig(bookId);
      const episodes = await this.state.loadEpisodeIndex(bookId);
      const runtimeState = await import("../state/runtime-state-store.js")
        .then(({ loadEpisodeRuntimeStateSnapshot }) => loadEpisodeRuntimeStateSnapshot(this.state.bookDir(bookId)))
        .catch(() => undefined);
      const targetEpisodes = book.targetEpisodes ?? 100;
      const finalEpisodeScript = await loadPersistedEpisodeScript(this.state.bookDir(bookId), targetEpisodes);
      const { evaluateSeriesCompletion } = await import("./series-completion.js");
      const report = evaluateSeriesCompletion({ book, episodes, runtimeState, finalEpisodeScript });
      if (report.completed && book.status !== "completed") {
        await this.state.saveBookConfig(bookId, {
          ...book,
          status: "completed",
          updatedAt: new Date().toISOString(),
        });
      }
      return report;
    } finally {
      await releaseLock();
    }
  }

  /**
   * Rewrite only the volume_map to cover a new target episode count, keeping
   * story_frame / roles / book_rules / pending_hooks intact. One explicit
   * architect call; surfaces foundation-scale warnings without blocking.
   */
  async extendFoundation(
    bookId: string,
    targetEpisodes: number,
  ): Promise<{ readonly volumeMap: string; readonly warnings: string[] }> {
    if (!Number.isInteger(targetEpisodes) || targetEpisodes < 1) {
      throw new Error(`Invalid target episode count: ${targetEpisodes}`);
    }
    await this.state.loadEpisodeBookConfig(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const [{ profile, body: genreBody }] = await Promise.all([
      readGenreProfile(this.config.projectRoot, book.genre),
    ]);
    const [storyFrame, currentVolumeMap] = await Promise.all([
      readStoryFrame(bookDir).catch(() => ""),
      readVolumeMap(bookDir).catch(() => ""),
    ]);
    const architect = new ArchitectAgent(this.agentCtxFor("architect", bookId));
    const result = await architect.generateVolumeMapExtension({
      book,
      genreProfile: profile,
      genreBody,
      storyFrame,
      currentVolumeMap,
      targetEpisodes,
      language: book.language ?? profile.language,
    });
    if (!result.volumeMap.trim()) {
      throw new Error("Foundation extension produced an empty volume_map.");
    }
    await writeFile(join(bookDir, "story", "outline", "volume_map.md"), result.volumeMap.trim() + "\n", "utf-8");
    return result;
  }

  /**
   * Explicit, user-triggered canon refresh: turn unclaimed episode facts into
   * new canon claims. One LLM call; never part of the per-episode budget.
   */
  async refreshCanon(
    bookId: string,
  ): Promise<{
    readonly added: number;
    readonly claims: ReadonlyArray<import("../models/canon.js").CanonClaim>;
  }> {
    await this.state.loadEpisodeBookConfig(bookId);
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const [{ profile }] = await Promise.all([
      readGenreProfile(this.config.projectRoot, book.genre),
    ]);
    const extractor = new CanonExtractor(this.agentCtxFor("canon-extractor", bookId));
    return extractor.refreshFromUnclaimed(bookDir, book.language ?? profile.language);
  }

  private buildEpisodeDurationWarnings(
    episodeNumber: number,
    metrics: import("../models/episode-script.js").EpisodeScriptMetrics,
  ): string[] {
    if (!metrics.durationWarning) return [];
    return [`第${episodeNumber}集时长提示：${metrics.durationWarning}`];
  }

  private buildLengthTelemetry(params: {
    lengthSpec: LengthSpec;
    writerCount: number;
    postWriterNormalizeCount: number;
    postReviseCount: number;
    finalCount: number;
    normalizeApplied: boolean;
    lengthWarning: boolean;
  }): LengthTelemetry {
    return {
      target: params.lengthSpec.target,
      softMin: params.lengthSpec.softMin,
      softMax: params.lengthSpec.softMax,
      hardMin: params.lengthSpec.hardMin,
      hardMax: params.lengthSpec.hardMax,
      countingMode: params.lengthSpec.countingMode,
      writerCount: params.writerCount,
      postWriterNormalizeCount: params.postWriterNormalizeCount,
      postReviseCount: params.postReviseCount,
      finalCount: params.finalCount,
      normalizeApplied: params.normalizeApplied,
      lengthWarning: params.lengthWarning,
    };
  }

  private async persistAuditDriftGuidance(params: {
    readonly bookDir: string;
    readonly episodeNumber: number;
    readonly issues: ReadonlyArray<AuditIssue>;
    readonly language: LengthLanguage;
  }): Promise<void> {
    const storyDir = join(params.bookDir, "story");
    const driftPath = join(storyDir, "audit_drift.md");
    const statePath = join(storyDir, "current_state.md");
    const currentState = await readFile(statePath, "utf-8").catch(() => "");
    const sanitizedState = this.stripAuditDriftCorrectionBlock(currentState).trimEnd();

    if (sanitizedState !== currentState) {
      await writeFile(statePath, sanitizedState, "utf-8");
    }

    if (params.issues.length === 0) {
      await rm(driftPath, { force: true }).catch(() => undefined);
      return;
    }

    const block = [
      this.localize(params.language, {
        zh: "# 审计纠偏",
        en: "# Audit Drift",
      }),
      "",
      this.localize(params.language, {
        zh: "## 审计纠偏（自动生成，下一集写作前参照）",
        en: "## Audit Drift Correction",
      }),
      "",
      this.localize(params.language, {
        zh: `> 第${params.episodeNumber}集审计发现以下问题，下一集写作时必须避免：`,
        en: `> Episode ${params.episodeNumber} audit found the following issues to avoid in the next episode:`,
      }),
      ...params.issues.map((issue) => `> - [${issue.severity}] ${issue.category}: ${issue.description}`),
      "",
    ].join("\n");

    await writeFile(driftPath, block, "utf-8");
  }

  private stripAuditDriftCorrectionBlock(currentState: string): string {
    const headers = [
      "## 审计纠偏（自动生成，下一集写作前参照）",
      "## Audit Drift Correction",
      "# 审计纠偏",
      "# Audit Drift",
    ];

    let cutIndex = -1;
    for (const header of headers) {
      const index = currentState.indexOf(header);
      if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
        cutIndex = index;
      }
    }

    if (cutIndex < 0) {
      return currentState;
    }

    return currentState.slice(0, cutIndex).trimEnd();
  }

  private logLengthWarnings(lengthWarnings: ReadonlyArray<string>): void {
    for (const warning of lengthWarnings) {
      this.config.logger?.warn(warning);
    }
  }

  private restoreLostAuditIssues(previous: AuditResult, next: AuditResult): AuditResult {
    if (next.passed || next.issues.length > 0 || previous.issues.length === 0) {
      return next;
    }

    return {
      ...next,
      issues: previous.issues,
      summary: next.summary || previous.summary,
    };
  }

  private restoreActionableAuditIfLost(
    previous: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
    next: {
      auditResult: AuditResult;
      aiTellCount: number;
      blockingCount: number;
      criticalCount: number;
      revisionBlockingIssues: ReadonlyArray<AuditIssue>;
    },
  ): MergedAuditEvaluation {
    const auditResult = this.restoreLostAuditIssues(previous.auditResult, next.auditResult);
    if (auditResult === next.auditResult) {
      return next;
    }

    return {
      ...next,
      auditResult,
      revisionBlockingIssues: previous.revisionBlockingIssues,
      blockingCount: previous.blockingCount,
      criticalCount: previous.criticalCount,
    };
  }

  private async evaluateMergedAudit(params: {
    auditor: ContinuityAuditor;
    book: BookConfig;
    bookDir: string;
    episodeContent: string;
    episodeNumber: number;
    language: LengthLanguage;
    auditOptions?: {
      temperature?: number;
      episodeIntent?: string;
      episodeMemo?: EpisodeMemo;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      episodeContextSnapshot?: EpisodeContextSnapshot;
      truthFileOverrides?: {
        currentState?: string;
        ledger?: string;
        hooks?: string;
      };
      verificationIssues?: ReadonlyArray<AuditIssue>;
      /** Which revision path produced the candidate under verification. */
      revisionKind?: "patch" | "rewrite";
    };
    runPostWriteChecks?: (content: string) => ReadonlyArray<AuditIssue>;
  }): Promise<MergedAuditEvaluation> {
    const visibleContent = params.episodeContent
      .replace(/<!--\s*inkos-episode-script-json[\s\S]*?-->/giu, "")
      .trimEnd();
    const isScreenplayProjection = visibleContent !== params.episodeContent.trimEnd();
    let screenplayShotSurface = visibleContent;
    if (isScreenplayProjection) {
      try {
        const screenplayScript = parseEpisodeScriptOutput(params.episodeContent, params.episodeNumber);
        screenplayShotSurface = screenplayScript.scenes.flatMap((scene) => scene.shots.flatMap((shot) => [
          shot.visual,
          shot.action,
          shot.narration,
          ...shot.dialogue.map((line) => `${line.speaker}：${line.text}`),
          shot.sound,
        ].filter((part): part is string => Boolean(part?.trim())))).join("\n");
      } catch {
        screenplayShotSurface = visibleContent;
      }
    }
    const llmAudit = await params.auditor.auditEpisode(
      params.bookDir,
      screenplayShotSurface,
      params.episodeNumber,
      params.book.genre,
      params.auditOptions,
    );
    const aiTells = analyzeAITells(screenplayShotSurface, params.language);
    const sensitiveResult = analyzeSensitiveWords(screenplayShotSurface, undefined, params.language);
    const longSpanFatigue = isScreenplayProjection
      ? { issues: [] as AuditIssue[] }
      : await analyzeLongSpanFatigue({
          bookDir: params.bookDir,
          episodeNumber: params.episodeNumber,
          episodeContent: screenplayShotSurface,
          language: params.language,
        });
    const postWriteIssues = params.runPostWriteChecks?.(screenplayShotSurface) ?? [];
    const normalizedLlmIssues = isScreenplayProjection
      ? llmAudit.issues
        .filter((issue) => !(/(?:破折号|em dash|long dash)/iu.test(issue.category)
          && !/[—–-]{2}/u.test(screenplayShotSurface)))
        .map((issue) => normalizeScreenplayReviewedIssue(issue, screenplayShotSurface))
      : llmAudit.issues;
    const issues: ReadonlyArray<AuditIssue> = deduplicateAuditIssues([
      ...normalizedLlmIssues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...postWriteIssues,
      ...longSpanFatigue.issues,
    ]);
    // revisionBlockingIssues excludes long-span-fatigue issues by
    // construction (not by category name) so that an LLM-reported issue
    // sharing a category label with a long-span issue is still counted.
    const revisionBlockingIssues: ReadonlyArray<AuditIssue> = deduplicateAuditIssues([
      ...normalizedLlmIssues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
      ...postWriteIssues,
    ]);

    const mergedAuditResult: AuditResult = { ...llmAudit, issues };
    return {
      auditResult: {
        ...mergedAuditResult,
        passed: deriveAuditPassed(mergedAuditResult),
      },
      aiTellCount: aiTells.issues.length,
      blockingCount: revisionBlockingIssues.filter((issue) => issue.severity === "warning" || issue.severity === "critical").length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  }

  private async recoverResyncWithDeterministicReplay(params: {
    readonly bookId: string;
    readonly book: BookConfig;
    readonly bookDir: string;
    readonly episodeNumber: number;
    readonly title: string;
    readonly content: string;
    readonly reducedControlInput?: {
      readonly episodeIntent: string;
      readonly contextPackage: ContextPackage;
      readonly ruleStack: RuleStack;
    };
    readonly validator: StateValidatorAgent;
    readonly oldState: string;
    readonly oldHooks: string;
    readonly language: LengthLanguage;
    readonly previousValidation: ValidationResult;
    readonly settlementAttempts?: number;
    readonly episodeContextSnapshot: EpisodeContextSnapshot;
  }): Promise<{ readonly output: WriteEpisodeOutput; readonly validation: ValidationResult }> {
    const settlementAttempts = params.settlementAttempts ?? 2;
    this.logWarn(params.language, {
      zh: `第${params.episodeNumber}集在 ${settlementAttempts} 次状态重放后仍不完整，拒绝写入不一致状态。`,
      en: `Episode ${params.episodeNumber} state replay remained incomplete after ${settlementAttempts} attempt(s); refusing inconsistent state.`,
    });
    this.emitDiagnostic({
      kind: "resync-deterministic-replay-failed",
      severity: "error",
      agent: "writer",
      phase: "resync",
      bookId: params.bookId,
      episodeNumber: params.episodeNumber,
      message: `${settlementAttempts} deterministic state replay attempt(s) were incomplete.`,
      details: { settlementAttempts },
    });
    for (const warning of params.previousValidation.warnings) {
      this.config.logger?.warn(`  [resync-fallback:${warning.category}] ${warning.description}`);
    }

    const writer = new WriterAgent(this.agentCtxFor("writer", params.bookId));
    const replayed = await writer.replayEpisodeState({
      book: params.book,
      bookDir: params.bookDir,
      episodeNumber: params.episodeNumber,
      title: params.title,
      content: params.content,
      allowReapply: true,
      episodeContextSnapshot: params.episodeContextSnapshot,
    });
    const output: WriteEpisodeOutput = {
      ...replayed,
      episodeNumber: params.episodeNumber,
      title: params.title,
      postWriteErrors: [],
      postWriteWarnings: [],
      updatedHooks: normalizePendingHookIdsMarkdown(replayed.updatedHooks),
    };
    const incomplete = this.validateResyncSettlementCompleteness(output, params.language);
    if (incomplete) {
      throw new Error(incomplete.warnings.map((warning) => warning.description).join("; "));
    }

    const validation = await params.validator.validate(
      params.content,
      params.episodeNumber,
      params.oldState,
      output.updatedState,
      params.oldHooks,
      output.updatedHooks,
      params.language,
    );
    if (!validation.passed) {
      const detail = validation.warnings.map((warning) => warning.description).join("; ");
      throw new Error(
        params.language === "en"
          ? `Deterministic episode replay failed state validation${detail ? `: ${detail}` : "."}`
          : `确定性剧集重放未通过状态校验${detail ? `：${detail}` : "。"}`,
      );
    }

    return { output, validation };
  }

  private validateResyncSettlementCompleteness(
    output: WriteEpisodeOutput,
    language: LengthLanguage,
  ): ValidationResult | null {
    const missingState = this.isMissingSettlementProjection(output.updatedState, "state");
    const missingHooks = this.isMissingSettlementProjection(output.updatedHooks, "hooks");
    const hasSummary = Boolean(
      output.runtimeStateDelta?.episodeSummary
      || output.updatedEpisodeSummaries?.trim()
      || output.episodeSummary.trim(),
    );
    if (!missingState && !missingHooks && hasSummary) return null;

    const warnings: ValidationWarning[] = [];
    if (missingState) {
      warnings.push({
        category: "settlement-missing-state",
        description: language === "en"
          ? "Resync settlement is missing a usable current-state projection."
          : "Resync 状态结算缺少可用的当前状态投影。",
      });
    }
    if (missingHooks) {
      warnings.push({
        category: "settlement-missing-hooks",
        description: language === "en"
          ? "Resync settlement is missing a usable hook-ledger projection."
          : "Resync 状态结算缺少可用的伏笔账本投影。",
      });
    }
    if (!hasSummary) {
      warnings.push({
        category: "settlement-missing-summary",
        description: language === "en"
          ? "Resync settlement is missing the current-episode summary."
          : "Resync 状态结算缺少当前章摘要。",
      });
    }
    return {
      passed: false,
      warnings,
    };
  }

  private isMissingSettlementProjection(
    value: string,
    kind: "state" | "hooks",
  ): boolean {
    const normalized = value.trim();
    if (!normalized) return true;
    const placeholders = kind === "state"
      ? ["(状态卡未更新)", "(state card not updated)"]
      : ["(伏笔池未更新)", "(hooks not updated)"];
    return placeholders.some((placeholder) => normalized.toLowerCase() === placeholder.toLowerCase());
  }

  private async markBookActiveIfNeeded(bookId: string): Promise<void> {
    const book = await this.state.loadBookConfig(bookId);
    if (book.status !== "outlining") return;

    await this.state.saveBookConfig(bookId, {
      ...book,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  private async createGovernedArtifacts(
    book: BookConfig,
    bookDir: string,
    episodeNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
    incomingState?: EpisodeScript["contract"]["handoffState"],
  ): Promise<{
    plan: PlanEpisodeOutput;
    composed: ComposeEpisodeOutput;
    episodeContextSnapshot: EpisodeContextSnapshot;
  }> {
    const plannerCtx = this.agentCtxFor("planner", book.id);
    const episodeContextSnapshot = await loadEpisodeContextSnapshot({
      bookDir,
      episode: episodeNumber,
      model: plannerCtx.model,
      service: plannerCtx.client.service ?? "unknown",
    });
    const resolvedPlan = await this.resolveGovernedPlan(book, bookDir, episodeNumber, externalContext, options, episodeContextSnapshot);
    const plan = incomingState
      ? { ...resolvedPlan, memo: bindEpisodeMemoIncomingState(resolvedPlan.memo, incomingState) }
      : resolvedPlan;
    if (incomingState) await savePersistedPlan(bookDir, plan);
    const composerCtx = this.agentCtxFor("composer", book.id);
    const composer = new ComposerAgent(composerCtx);
    const composed = await composeGovernedEpisode({
      book,
      bookDir,
      episodeNumber,
      plan,
      contextBudget: contextBudgetFromClient(composerCtx.client),
      contextCompilationCache: this.contextCompilationCache,
      // Episode v2 uses the deterministic context reducer. Calling the LLM
      // merely to summarize context would consume the per-episode model
      // budget before Writer/Auditor and made normal runs appear as recovery.
      ...(book.format === "screenplay"
        ? {}
        : {
            compressibleContextCompiler: (request: Parameters<ComposerAgent["compileCompressibleContext"]>[0]) =>
              composer.compileCompressibleContext(request, this.contextCompilationCache),
          }),
      onContextCompression: this.config.onContextCompression,
      claimValidator: new ClaimValidatorAgent(this.agentCtxFor("claim-validator", book.id)),
      volumeAuditor: new VolumeAuditorAgent(this.agentCtxFor("volume-auditor", book.id)),
      episodeContextSnapshot,
    });

    return { plan, composed, episodeContextSnapshot };
  }

  private async resolveGovernedPlan(
    book: BookConfig,
    bookDir: string,
    episodeNumber: number,
    externalContext?: string,
    options?: {
      readonly reuseExistingIntentWhenContextMissing?: boolean;
    },
    episodeContextSnapshot?: EpisodeContextSnapshot,
  ): Promise<PlanEpisodeOutput> {
    if (
      options?.reuseExistingIntentWhenContextMissing &&
      (!externalContext || externalContext.trim().length === 0)
    ) {
      const persisted = await loadPersistedPlan(bookDir, episodeNumber);
      if (persisted) {
        if (!episodeContextSnapshot) {
          throw new Error("EPISODE_CONTEXT_REQUIRED: persisted plan reuse requires the operation EpisodeContextSnapshot.");
        }
        if (!episodeContextSnapshot.planningMemorySelection) {
          const materials = await gatherPlanningMaterials({
            bookDir,
            episodeNumber,
            goal: persisted.intent.goal,
            outlineNode: persisted.intent.outlineNode,
            mustKeep: persisted.intent.mustKeep,
            episodeContextSnapshot,
          });
          attachEpisodePlanningMemory(episodeContextSnapshot, materials.memorySelection);
        }
        return persisted;
      }
    }

    const planner = new PlannerAgent(this.agentCtxFor("planner", book.id));
    // P0-2: feed persisted upstream revision feedback into the memo prompt so
    // planner/canon-owned findings are resolved by the planner itself, then
    // clear it — if the problem persists, the next review cycle re-records it.
    const upstreamFeedback = await loadUpstreamRevisionFeedback(bookDir, episodeNumber);
    const upstreamRevisionFeedbackBlock = upstreamFeedback
      ? buildUpstreamRevisionFeedbackBlock(
          upstreamFeedback.findings,
          book.language === "en" ? "en" : "zh",
        )
      : undefined;
    const plan = await planner.planEpisode({
      book,
      bookDir,
      episodeNumber,
      externalContext,
      episodeContextSnapshot,
      ...(upstreamRevisionFeedbackBlock ? { upstreamRevisionFeedbackBlock } : {}),
    });
    if (upstreamFeedback) await clearUpstreamRevisionFeedback(bookDir);
    // Persist in the new memo format so subsequent compose/write phases can
    // skip the planner LLM call when no new context is supplied.
    await savePersistedPlan(bookDir, plan);
    return plan;
  }

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    episodeNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      episodeNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async readEpisodeContent(bookDir: string, episodeNumber: number): Promise<string> {
    const paddedNum = String(episodeNumber).padStart(4, "0");
    const episodesDir = join(bookDir, "episodes");
    const files = await readdir(episodesDir).catch(() => []);
    const episodeFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
    if (!episodeFile) {
      throw new Error(`Episode/episode ${episodeNumber} file not found in ${episodesDir} or ${episodesDir}`);
    }
    const raw = await readFile(join(episodesDir, episodeFile), "utf-8");
    // Strip the title line
    const lines = raw.split("\n");
    const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
    return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
  }
}
