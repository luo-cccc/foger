import { BaseAgent, type AgentContext } from "./base.js";
import type { BookConfig } from "../models/book.js";
import { assertEpisodeBookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { buildWriterSystemPrompt } from "./writer-prompts.js";
import { readGenreProfile, readBookRules } from "./rules-reader.js";
import {
  detectCrossEpisodeRepetition,
  detectParagraphLengthDrift,
  normalizePostWriteSurface,
  validatePostWrite,
  type PostWriteViolation,
} from "./post-write-validator.js";
import { analyzeAITells } from "./ai-tells.js";
import type { EpisodeIntent, EpisodeMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { EpisodeRuntimeStateDelta } from "../models/runtime-state.js";
import { buildLengthSpec, countEpisodeLength } from "../utils/length-metrics.js";
import {
  capContextBlock,
  filterHooks,
  filterSummaries,
  filterSubplots,
  filterEmotionalArcs,
  filterCharacterMatrix,
} from "../utils/context-filter.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
} from "../utils/governed-working-set.js";
import { extractPOVFromOutline, filterMatrixByPOV, filterHooksByPOV } from "../utils/pov-filter.js";
import { parseCreativeOutput } from "./writer-parser.js";
import { buildRuntimeStateArtifacts, type RuntimeStateArtifacts } from "../state/runtime-state-store.js";
import { deriveEpisodeRuntimeDelta } from "../state/episode-runtime.js";
import type { EpisodeRuntimeStateSnapshot } from "../state/episode-state-reducer.js";
import {
  type LLMPromptSourceInput,
} from "../llm/provider.js";
import { parsePendingHooksMarkdown } from "../utils/memory-retrieval.js";
import { analyzeHookHealth } from "../utils/hook-health.js";
import {
  renderMemoAsNarrativeBlock,
  renderNarrativeSelectedContext,
  sanitizeNarrativeEvidenceBlock,
} from "../utils/narrative-control.js";
import { getContextSourceTier } from "../utils/context-assembly.js";
import { truncatePromptBlock } from "../utils/prompt-budget.js";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EpisodeScript, EpisodeScriptMetrics } from "../models/episode-script.js";
import {
  EPISODE_DURATION_HARD_MAX_SECONDS,
  EPISODE_DURATION_HARD_MIN_SECONDS,
  EPISODE_DURATION_TARGET_SECONDS,
  episodeSoftDurationRange,
} from "../models/episode-script.js";
import type { EpisodeHandoffCapsule } from "../pipeline/episode-handoff.js";
import type { EpisodePerformanceReport } from "../pipeline/episode-performance.js";
import type { EpisodeReviewEvidence } from "../pipeline/episode-review-evidence.js";
import { loadPersistedPlan } from "../pipeline/persisted-governed-plan.js";

const LEGACY_WRITER_CONTEXT_BUDGET = {
  storyBible: 14_000,
  currentState: 7_000,
  ledger: 6_000,
  hooks: 9_000,
  episodeSummaries: 9_000,
  subplotBoard: 7_000,
  emotionalArcs: 7_000,
  characterMatrix: 12_000,
  parentCanon: 12_000,
  volumeOutline: 12_000,
} as const;

const SCREENPLAY_MAX_OUTPUT_TOKENS = 8192;
const SCREENPLAY_REPAIR_INPUT_TOKENS = 4096;
import {
  getEpisodeContextContent,
  getEpisodeContextRecentEpisodes,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

export interface WriteEpisodeInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly externalContext?: string;
  readonly episodeIntent?: string;
  readonly episodeMemo?: EpisodeMemo;
  readonly episodeIntentData?: EpisodeIntent;
  readonly contextPackage?: ContextPackage;
  readonly ruleStack?: RuleStack;
  readonly lengthSpec?: LengthSpec;
  readonly durationSecondsOverride?: number;
  readonly temperatureOverride?: number;
  readonly episodeContextSnapshot?: EpisodeContextSnapshot;
}

export interface ReplayEpisodeStateInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly title: string;
  readonly content: string;
  readonly allowReapply?: boolean;
  readonly episodeMemo?: EpisodeMemo;
  readonly episodeIntent?: string;
  readonly contextPackage?: ContextPackage;
  readonly ruleStack?: RuleStack;
  readonly validationFeedback?: string;
  readonly episodeContextSnapshot: EpisodeContextSnapshot;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface WriteEpisodeOutput {
  readonly episodeNumber: number;
  readonly title: string;
  readonly content: string;
  readonly episodeDurationSeconds: number;
  readonly episodeScript?: EpisodeScript;
  readonly episodeScriptMetrics?: EpisodeScriptMetrics;
  readonly episodeHandoffCapsule?: EpisodeHandoffCapsule;
  readonly episodePerformanceReport?: EpisodePerformanceReport;
  readonly episodeReviewEvidence?: EpisodeReviewEvidence;
  readonly preWriteCheck: string;
  readonly stateProjection: string;
  readonly runtimeStateDelta?: EpisodeRuntimeStateDelta;
  readonly runtimeStateSnapshot?: EpisodeRuntimeStateSnapshot;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly episodeSummary: string;
  readonly updatedEpisodeSummaries?: string;
  readonly updatedSubplots: string;
  readonly updatedEmotionalArcs: string;
  readonly updatedCharacterMatrix: string;
  readonly postWriteErrors: ReadonlyArray<PostWriteViolation>;
  readonly postWriteWarnings: ReadonlyArray<PostWriteViolation>;
  readonly hookHealthIssues?: ReadonlyArray<{
    readonly severity: "critical" | "warning" | "info";
    readonly category: string;
    readonly description: string;
    readonly suggestion: string;
  }>;
  readonly tokenUsage?: TokenUsage;
}

export class WriterAgent extends BaseAgent {
  get name(): string {
    return "writer";
  }

  private localize(language: "zh" | "en", messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private logInfo(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.info(this.localize(language, messages));
  }

  private logWarn(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.warn(this.localize(language, messages));
  }

  async writeEpisode(input: WriteEpisodeInput): Promise<WriteEpisodeOutput> {
    const { book, bookDir, episodeNumber } = input;

    // Episode v2 must never silently fall back to the legacy novel prompt. A
    // missing planner/composer artifact is a pipeline fault, not permission to
    // invent a different creative contract.
    if (book.schemaVersion === "inkos-episode-v2") {
      assertEpisodeBookConfig(book);
      const missing = [
        ["episodeMemo", input.episodeMemo],
        ["contextPackage", input.contextPackage],
        ["ruleStack", input.ruleStack],
        ["episodeContextSnapshot", input.episodeContextSnapshot],
      ].filter(([, value]) => value === undefined).map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(`EPISODE_CONTEXT_INCOMPLETE: missing ${missing.join(", ")}`);
      }
    }

    const placeholder = "(文件尚未创建)";
    const snapshot = input.episodeContextSnapshot!;
    const storyBible = getEpisodeContextContent(snapshot, "story/outline/story_frame.md", placeholder);
    const volumeOutline = getEpisodeContextContent(snapshot, "story/outline/volume_map.md", placeholder);
    const styleGuide = getEpisodeContextContent(snapshot, "story/style_guide.md", placeholder);
    const currentState = getEpisodeContextContent(snapshot, "story/current_state.md", placeholder);
    const ledger = getEpisodeContextContent(snapshot, "story/particle_ledger.md", placeholder);
    const hooks = getEpisodeContextContent(snapshot, "story/pending_hooks.md", placeholder);
    const episodeSummaries = getEpisodeContextContent(snapshot, "story/episode_summaries.md", placeholder);
    const subplotBoard = getEpisodeContextContent(snapshot, "story/subplot_board.md", placeholder);
    const emotionalArcs = getEpisodeContextContent(snapshot, "story/emotional_arcs.md", placeholder);
    const characterMatrix = getEpisodeContextContent(snapshot, "story/character_context.md", placeholder);
    const styleProfileRaw = getEpisodeContextContent(snapshot, "story/style_profile.json", placeholder);
    const parentCanon = getEpisodeContextContent(snapshot, "story/parent_canon.md", placeholder);
    const recentEpisodeEntries = [...getEpisodeContextRecentEpisodes(snapshot)];
    const fingerprintEpisodes = recentEpisodeEntries.join("\n\n---\n\n");
    const recentEpisodes = recentEpisodeEntries.slice(-3).join("\n\n---\n\n");

    // Load genre profile + book rules
    const { profile: genreProfile, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const parsedBookRules = await readBookRules(bookDir);
    const bookRules = parsedBookRules?.rules ?? null;
    const bookRulesBody = parsedBookRules?.body ?? "";

    const styleFingerprint = this.buildStyleFingerprint(styleProfileRaw);

    const dialogueFingerprints = this.extractDialogueFingerprints(fingerprintEpisodes, storyBible);
    const relevantSummaries = this.findRelevantSummaries(episodeSummaries, volumeOutline, episodeNumber);

    const hasParentCanon = parentCanon !== "(文件尚未创建)";
    const resolvedLanguage = book.language ?? genreProfile.language;
    const targetDurationSeconds = input.durationSecondsOverride ?? book.episodeDurationSeconds;
    const promptBook = targetDurationSeconds === book.episodeDurationSeconds
      ? book
      : { ...book, episodeDurationSeconds: targetDurationSeconds };
    const resolvedLengthSpec = input.lengthSpec ?? buildLengthSpec(targetDurationSeconds, resolvedLanguage);
    const governedMemoryBlocks = input.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(input.contextPackage, resolvedLanguage)
      : undefined;

    // ── Phase 1: Creative writing (temperature 0.7) ──
    const creativeSystemPrompt = await this.withPromptPackGuidance(buildWriterSystemPrompt(
      promptBook, genreProfile, bookRules, bookRulesBody, genreBody, styleGuide, styleFingerprint,
      episodeNumber, "creative", resolvedLanguage,
      input.episodeMemo ? "governed" : "legacy",
      resolvedLengthSpec,
    ), "longform.writer");

    const creativeUserPrompt = input.episodeMemo && input.contextPackage && input.ruleStack
      ? this.buildGovernedUserPrompt({
          episodeNumber,
          episodeMemo: input.episodeMemo,
          episodeIntentData: input.episodeIntentData,
          contextPackage: input.contextPackage,
          ruleStack: input.ruleStack,
          externalContext: input.externalContext,
          lengthSpec: resolvedLengthSpec,
          targetDurationSeconds,
          language: book.language ?? genreProfile.language,
          varianceBrief: undefined,
          selectedEvidenceBlock: this.joinGovernedEvidenceBlocks(governedMemoryBlocks),
        })
      : (() => {
          // Smart context filtering: inject only relevant parts of truth files
          const filteredHooks = filterHooks(hooks);
          const filteredSummaries = filterSummaries(episodeSummaries, episodeNumber);
          const filteredSubplots = filterSubplots(subplotBoard);
          const filteredArcs = filterEmotionalArcs(emotionalArcs, episodeNumber);
          const filteredMatrix = filterCharacterMatrix(characterMatrix, volumeOutline, bookRules?.protagonist?.name);

          // POV-aware filtering: limit context to what the POV character knows
          const povCharacter = extractPOVFromOutline(volumeOutline, episodeNumber);
          const povFilteredMatrix = povCharacter
            ? filterMatrixByPOV(filteredMatrix, povCharacter)
            : filteredMatrix;
          const povFilteredHooks = povCharacter
            ? filterHooksByPOV(filteredHooks, povCharacter, episodeSummaries)
            : filteredHooks;

          return this.buildUserPrompt({
            episodeNumber,
            storyBible,
            currentState,
            ledger: genreProfile.numericalSystem ? ledger : "",
            hooks: povFilteredHooks,
            recentEpisodes,
            lengthSpec: resolvedLengthSpec,
            targetDurationSeconds,
            externalContext: input.externalContext,
            episodeSummaries: filteredSummaries,
            subplotBoard: filteredSubplots,
            emotionalArcs: filteredArcs,
            characterMatrix: povFilteredMatrix,
            dialogueFingerprints,
            relevantSummaries,
            parentCanon: hasParentCanon ? parentCanon : undefined,
            language: book.language ?? genreProfile.language,
          });
        })();

    const creativeTemperature = input.temperatureOverride ?? 0.7;
    const creativePromptSources: LLMPromptSourceInput[] = input.contextPackage
      ? [
          ...input.contextPackage.selectedContext.map((entry) => ({
            source: entry.source,
            content: [entry.reason, entry.excerpt].filter(Boolean).join("\n"),
            tier: getContextSourceTier(entry.source),
            stable: isStableWriterPromptSource(entry.source),
            selected: true,
            compressed: entry.source === "runtime/compiled-compressible-context",
          })),
          {
            source: "runtime/rule_stack",
            content: JSON.stringify(input.ruleStack ?? {}),
            tier: "semantic" as const,
            stable: false,
            selected: true,
            compressed: false,
          },
          ...(input.externalContext?.trim()
            ? [{
                source: "runtime/episode_user_instruction",
                content: input.externalContext.trim(),
                tier: "verbatim" as const,
                stable: false,
                selected: true,
                compressed: false,
              }]
            : []),
        ]
      : [];

    this.logInfo(resolvedLanguage, {
      zh: `阶段 1：创作剧集分镜（第${episodeNumber}集）`,
      en: `Phase 1: creative writing for episode ${episodeNumber}`,
    });

    let creativeResponse = await this.chat(
      [
        { role: "system", content: creativeSystemPrompt },
        { role: "user", content: creativeUserPrompt },
      ],
      {
        temperature: creativeTemperature,
        maxTokens: book.format === "screenplay" ? SCREENPLAY_MAX_OUTPUT_TOKENS : undefined,
        promptSources: creativePromptSources,
      },
    );
    let creativeUsage = creativeResponse.usage;

    let creative: ReturnType<typeof parseCreativeOutput>;
    try {
      creative = parseCreativeOutput(
        episodeNumber,
        creativeResponse.content,
        resolvedLengthSpec.countingMode,
        targetDurationSeconds,
      );
    } catch (error) {
      // Screenplay output is a strict machine contract. Give the model one
      // bounded repair attempt with the parser error, then fail the episode
      // without ever persisting free-form prose as a script.
      if (book.format !== "screenplay") throw error;
      const repairResponse = await this.chat(
        [
          { role: "system", content: creativeSystemPrompt },
          {
            role: "user",
            content: [
              "Your previous response did not satisfy the EpisodeScript JSON contract.",
              `Parser feedback: ${error instanceof Error ? error.message : String(error)}`,
              "If the feedback reports a shot or scene count, correct the count by adding or removing shots — do not just renumber the existing ones.",
              "Return only PRE_WRITE_CHECK and a corrected EPISODE_SCRIPT_JSON object. Do not add prose.",
              "Previous response:",
              truncatePromptBlock(
                creativeResponse.content,
                SCREENPLAY_REPAIR_INPUT_TOKENS,
                "\n[previous response truncated for repair]",
              ),
            ].join("\n\n"),
          },
        ],
        {
          temperature: Math.min(creativeTemperature, 0.4),
          maxTokens: SCREENPLAY_MAX_OUTPUT_TOKENS,
          promptSources: creativePromptSources,
        },
      );
      creativeResponse = repairResponse;
      creativeUsage = {
        promptTokens: creativeUsage.promptTokens + repairResponse.usage.promptTokens,
        completionTokens: creativeUsage.completionTokens + repairResponse.usage.completionTokens,
        totalTokens: creativeUsage.totalTokens + repairResponse.usage.totalTokens,
      };
      try {
        creative = parseCreativeOutput(
          episodeNumber,
          creativeResponse.content,
          resolvedLengthSpec.countingMode,
          targetDurationSeconds,
        );
      } catch (finalError) {
        // Both the initial response and the bounded repair failed to parse.
        // Attach the consumed tokens so the runner can keep usage accounting
        // honest when it retries or aborts the episode.
        if (finalError instanceof Error) {
          (finalError as { tokenUsage?: TokenUsage }).tokenUsage = creativeUsage;
        }
        throw finalError;
      }
    }

    if (book.format === "screenplay" && !creative.episodeScript) {
      throw new Error(
        "Screenplay writer output did not contain a valid EpisodeScript JSON contract; legacy episode text was rejected.",
      );
    }

    // PRE_WRITE_CHECK is model-facing scaffolding, not a source of truth. The
    // planner memo and the structured EpisodeScript contract are authoritative;
    // deterministic gates below validate those artifacts directly. Do not
    // emit a warning merely because the model abbreviated its self-check.

    // ── Phase 2: Deterministic screenplay state projection ──
    this.logInfo(resolvedLanguage, {
      zh: `阶段 2：投影剧集状态（第${episodeNumber}集，${creative.episodeDurationSeconds}秒）`,
      en: `Phase 2: projecting episode state for episode ${episodeNumber} (${creative.episodeDurationSeconds}s)`,
    });
    if (!creative.episodeScript) {
      throw new Error("EPISODE_SCRIPT_REQUIRED: deterministic state projection requires a valid EpisodeScript JSON contract.");
    }
    const projectionResult = this.deriveScreenplayProjection({
      script: creative.episodeScript,
      title: creative.title,
      episodeNumber,
      metrics: creative.episodeScriptMetrics,
      episodeMemo: input.episodeMemo,
      hooksMarkdown: hooks,
      ledgerMarkdown: genreProfile.numericalSystem ? ledger : "",
      subplotBoard,
      emotionalArcs,
      characterMatrix,
    });
    const projection = projectionResult.projection;
    const projectionUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const baseEpisodeRuntimeStateDelta = projection.runtimeStateDelta
      ? this.normalizeEpisodeRuntimeStateDeltaEpisode(projection.runtimeStateDelta, episodeNumber)
      : undefined;
    const resolvedEpisodeRuntimeStateDelta = creative.episodeScript && baseEpisodeRuntimeStateDelta
      ? this.enrichEpisodeRuntimeStateDelta(baseEpisodeRuntimeStateDelta, creative.episodeScript, creative.title, episodeNumber,
        creative.episodeScriptMetrics)
      : baseEpisodeRuntimeStateDelta;
    // Build the durable snapshot only after screenplay-derived summary fields
    // have been merged. Building it earlier would persist an incomplete
    // projection and silently drop payoff/relationship data.
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      bookDir,
      resolvedEpisodeRuntimeStateDelta,
      resolvedLanguage,
      episodeNumber,
    );
    const priorHookIds = new Set(parsePendingHooksMarkdown(hooks).map((hook) => hook.hookId));
    const hookHealthIssues = resolvedEpisodeRuntimeStateDelta
      && (runtimeStateArtifacts?.snapshot ?? projection.runtimeStateSnapshot)
      ? analyzeHookHealth({
          language: resolvedLanguage,
          episodeNumber,
          targetEpisodes: book.targetEpisodes,
          hooks: (runtimeStateArtifacts?.snapshot ?? projection.runtimeStateSnapshot)!.hooks.hooks,
          delta: resolvedEpisodeRuntimeStateDelta,
          existingHookIds: [...priorHookIds],
        })
      : [];

    // ── Post-write validation (regex + rule-based, zero LLM cost) ──
    const surfaceNormalizedContent = normalizePostWriteSurface(creative.content, resolvedLanguage);
    const surfaceNormalizedWordCount = countEpisodeLength(surfaceNormalizedContent, resolvedLengthSpec.countingMode);
    const authoritativeEpisodeDuration = creative.episodeScriptMetrics?.estimatedDurationSeconds
      ?? surfaceNormalizedWordCount;
    const ruleViolations = creative.episodeScript
      ? []
      : [
          ...validatePostWrite(surfaceNormalizedContent, genreProfile, bookRules, resolvedLanguage),
          ...detectCrossEpisodeRepetition(surfaceNormalizedContent, fingerprintEpisodes, resolvedLanguage),
          ...detectParagraphLengthDrift(surfaceNormalizedContent, fingerprintEpisodes, resolvedLanguage),
        ];
    const aiTellIssues = creative.episodeScript
      ? []
      : analyzeAITells(surfaceNormalizedContent, resolvedLanguage).issues;

    const postWriteErrors = ruleViolations.filter(v => v.severity === "error");
    const postWriteWarnings = ruleViolations.filter(v => v.severity === "warning");

    if (ruleViolations.length > 0) {
      this.logWarn(resolvedLanguage, {
        zh: `后写校验：第${episodeNumber}集 ${postWriteErrors.length} 个错误，${postWriteWarnings.length} 个警告`,
        en: `Post-write: ${postWriteErrors.length} errors, ${postWriteWarnings.length} warnings in episode ${episodeNumber}`,
      });
      for (const v of ruleViolations) {
        this.ctx.logger?.warn(`[${v.severity}] ${v.rule}: ${v.description}`);
      }
    }
    if (aiTellIssues.length > 0) {
      this.logWarn(resolvedLanguage, {
        zh: `AI 味检查：第${episodeNumber}集发现 ${aiTellIssues.length} 个问题`,
        en: `AI-tell check: ${aiTellIssues.length} issues in episode ${episodeNumber}`,
      });
      for (const issue of aiTellIssues) {
        this.ctx.logger?.warn(`[${issue.severity}] ${issue.category}: ${issue.description}`);
      }
    }
    if (hookHealthIssues.length > 0) {
      this.logWarn(resolvedLanguage, {
        zh: `伏笔健康：第${episodeNumber}集发现 ${hookHealthIssues.length} 条警告`,
        en: `Hook health: ${hookHealthIssues.length} warning(s) in episode ${episodeNumber}`,
      });
      for (const issue of hookHealthIssues) {
        this.ctx.logger?.warn(`[${issue.severity}] ${issue.category}: ${issue.description}`);
      }
    }

    // ── Merge into WriteEpisodeOutput ──
    const tokenUsage: TokenUsage = {
      promptTokens: creativeUsage.promptTokens + projectionUsage.promptTokens,
      completionTokens: creativeUsage.completionTokens + projectionUsage.completionTokens,
      totalTokens: creativeUsage.totalTokens + projectionUsage.totalTokens,
    };

    return {
      episodeNumber,
      title: creative.title,
      content: surfaceNormalizedContent,
      episodeDurationSeconds: authoritativeEpisodeDuration,
      ...(creative.episodeScript ? { episodeScript: creative.episodeScript } : {}),
      ...(creative.episodeScriptMetrics ? { episodeScriptMetrics: creative.episodeScriptMetrics } : {}),
      preWriteCheck: creative.preWriteCheck,
      stateProjection: projection.stateProjection,
      runtimeStateDelta: runtimeStateArtifacts?.resolvedDelta ?? resolvedEpisodeRuntimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts?.snapshot ?? projection.runtimeStateSnapshot,
      updatedState: runtimeStateArtifacts?.currentStateMarkdown ?? projection.updatedState,
      updatedLedger: projection.updatedLedger,
      updatedHooks: runtimeStateArtifacts?.hooksMarkdown ?? projection.updatedHooks,
      episodeSummary: resolvedEpisodeRuntimeStateDelta
        ? this.renderDeltaSummaryRow(resolvedEpisodeRuntimeStateDelta)
        : projection.episodeSummary,
      updatedEpisodeSummaries: runtimeStateArtifacts?.episodeSummariesMarkdown,
      updatedSubplots: projection.updatedSubplots,
      updatedEmotionalArcs: projection.updatedEmotionalArcs,
      updatedCharacterMatrix: projection.updatedCharacterMatrix,
      postWriteErrors,
      postWriteWarnings,
      hookHealthIssues,
      tokenUsage,
    };
  }

  async replayEpisodeState(input: ReplayEpisodeStateInput): Promise<WriteEpisodeOutput> {
    const snapshot = input.episodeContextSnapshot;
    const missing = "(文件尚未创建)";
    const ledger = getEpisodeContextContent(snapshot, "story/particle_ledger.md", missing);
    const hooks = getEpisodeContextContent(snapshot, "story/pending_hooks.md", missing);
    const subplotBoard = getEpisodeContextContent(snapshot, "story/subplot_board.md", missing);
    const emotionalArcs = getEpisodeContextContent(snapshot, "story/emotional_arcs.md", missing);
    const characterMatrix = getEpisodeContextContent(snapshot, "story/character_context.md", missing);

    const { profile: genreProfile } = await readGenreProfile(this.ctx.projectRoot, input.book.genre);
    const resolvedLanguage = input.book.language ?? genreProfile.language;
    // Deterministic replays (revised drafts, resync, state recovery) must
    // consume the same hook-ledger annotations the planner wrote. The memo is
    // normally threaded by the caller; when it is missing, fall back to the
    // persisted plan so hook advance/resolve/defer cannot silently disappear
    // from settlement just because the draft was re-derived.
    let episodeMemo = input.episodeMemo;
    if (!episodeMemo) {
      try {
        const persisted = await loadPersistedPlan(input.bookDir, input.episodeNumber);
        episodeMemo = persisted?.memo;
      } catch {
        // Fall through without a memo; the reducer then emits an empty ledger.
      }
    }
    const governedMemoryBlocks = input.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(input.contextPackage, resolvedLanguage)
      : undefined;

    // Episode v2 has a single authoritative creative artifact. State repair
    // and edited-script resync must replay that artifact through the same
    // deterministic reducer as normal writing; no model-based state agent is used.
    const creative = parseCreativeOutput(
      input.episodeNumber,
      input.content,
      resolvedLanguage === "en" ? "en_words" : "zh_chars",
      input.book.episodeDurationSeconds,
    );
    if (!creative.episodeScript || !creative.episodeScriptMetrics) {
      throw new Error(
        "EPISODE_SCRIPT_REQUIRED: state recovery requires a valid persisted EpisodeScript JSON contract.",
      );
    }
    const deterministic = this.deriveScreenplayProjection({
      script: creative.episodeScript,
      title: creative.title,
      episodeNumber: input.episodeNumber,
      metrics: creative.episodeScriptMetrics,
      episodeMemo,
      hooksMarkdown: hooks,
      ledgerMarkdown: genreProfile.numericalSystem ? ledger : "",
      subplotBoard,
      emotionalArcs,
      characterMatrix,
    });
    const recoveryRuntimeStateDelta = this.normalizeEpisodeRuntimeStateDeltaEpisode(
      deterministic.projection.runtimeStateDelta,
      input.episodeNumber,
    );
    const recoveryResolvedRuntimeStateDelta = this.enrichEpisodeRuntimeStateDelta(
      recoveryRuntimeStateDelta,
      creative.episodeScript,
      creative.title,
      input.episodeNumber,
      creative.episodeScriptMetrics,
    );
    const recoveryRuntimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      input.bookDir,
      recoveryResolvedRuntimeStateDelta,
      resolvedLanguage,
      input.episodeNumber,
      input.allowReapply,
    );

    return {
      episodeNumber: input.episodeNumber,
      title: creative.title,
      content: creative.content,
      episodeDurationSeconds: creative.episodeScriptMetrics.estimatedDurationSeconds,
      episodeScript: creative.episodeScript,
      episodeScriptMetrics: creative.episodeScriptMetrics,
      preWriteCheck: creative.preWriteCheck,
      stateProjection: deterministic.projection.stateProjection,
      runtimeStateDelta: recoveryRuntimeStateArtifacts?.resolvedDelta ?? recoveryResolvedRuntimeStateDelta,
      runtimeStateSnapshot: recoveryRuntimeStateArtifacts?.snapshot,
      updatedState: recoveryRuntimeStateArtifacts?.currentStateMarkdown ?? "",
      updatedLedger: deterministic.projection.updatedLedger,
      updatedHooks: recoveryRuntimeStateArtifacts?.hooksMarkdown ?? hooks,
      episodeSummary: this.renderDeltaSummaryRow(recoveryResolvedRuntimeStateDelta),
      updatedEpisodeSummaries: recoveryRuntimeStateArtifacts?.episodeSummariesMarkdown,
      updatedSubplots: deterministic.projection.updatedSubplots,
      updatedEmotionalArcs: deterministic.projection.updatedEmotionalArcs,
      updatedCharacterMatrix: deterministic.projection.updatedCharacterMatrix,
      postWriteErrors: [],
      postWriteWarnings: [],
      tokenUsage: deterministic.usage,
    };

  }

  async saveEpisode(
    bookDir: string,
    output: WriteEpisodeOutput,
    numericalSystem: boolean = true,
    language: "zh" | "en" = "zh",
    options: { readonly persistTruth?: boolean } = {},
  ): Promise<void> {
    const episodesDir = join(bookDir, "episodes");
    const storyDir = join(bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(storyDir, { recursive: true });
    if (output.episodeScript) {
      await mkdir(episodesDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
    } else {
      await mkdir(episodesDir, { recursive: true });
    }

    const paddedNum = String(output.episodeNumber).padStart(4, "0");
    const filename = `${paddedNum}_${this.sanitizeFilename(output.title)}.md`;
    const episodeMarkdownFilename = `${paddedNum}_${this.sanitizeFilename(output.title)}.md`;
    const episodeJsonFilename = `${paddedNum}_${this.sanitizeFilename(output.title)}.json`;
    const operations: Array<{ readonly path: string; readonly content?: string }> = [];
    if (output.episodeScript) {
      const existingEpisodeFiles = await readdir(episodesDir).catch(() => []);
      for (const file of existingEpisodeFiles) {
        if (
          file.startsWith(`${paddedNum}_`)
          && file !== episodeMarkdownFilename
          && file !== episodeJsonFilename
        ) {
          operations.push({ path: join(episodesDir, file) });
        }
      }
    } else {
      const existingEpisodeFiles = await readdir(episodesDir).catch(() => []);
      for (const file of existingEpisodeFiles) {
        if (file.startsWith(`${paddedNum}_`) && file.endsWith(".md") && file !== filename) {
          operations.push({ path: join(episodesDir, file) });
        }
      }
    }

    const trimmedTitle = output.title.trim();
    const titleIsEpisodeNumber = language === "en"
      ? new RegExp(`^Episode\\s+${output.episodeNumber}$`, "iu").test(trimmedTitle)
      : new RegExp(`^第\\s*${output.episodeNumber}\\s*集$`, "u").test(trimmedTitle);
    const heading = language === "en"
      ? `# Episode ${output.episodeNumber}${titleIsEpisodeNumber ? "" : `: ${trimmedTitle}`}`
      : `# 第${output.episodeNumber}集${titleIsEpisodeNumber ? "" : ` ${trimmedTitle}`}`;
    const episodeContent = output.episodeScript
      ? output.content
      : [heading, "", output.content].join("\n");
    const persistTruth = options.persistTruth ?? true;
    const runtimeStateArtifacts = persistTruth
      ? await this.resolveRuntimeStateArtifactsForOutput(bookDir, output, language)
      : undefined;
    const nextStateMarkdown = runtimeStateArtifacts?.currentStateMarkdown ?? output.updatedState;
    const nextHooksMarkdown = runtimeStateArtifacts?.hooksMarkdown ?? output.updatedHooks;
    const previousStateMarkdown = await this.readFileOrDefault(join(storyDir, "current_state.md"));
    const previousHooksMarkdown = await this.readFileOrDefault(join(storyDir, "pending_hooks.md"));
    const shouldWriteState = this.isMeaningfulTruthUpdate(nextStateMarkdown, "(状态卡未更新)")
      || !this.isMeaningfulTruthUpdate(previousStateMarkdown, "(状态卡未更新)");
    const shouldWriteHooks = this.isMeaningfulTruthUpdate(nextHooksMarkdown, "(伏笔池未更新)")
      || !this.isMeaningfulTruthUpdate(previousHooksMarkdown, "(伏笔池未更新)");
    const shouldSaveRuntimeSnapshot = runtimeStateArtifacts?.snapshot
      ? this.isMeaningfulRuntimeSnapshot(runtimeStateArtifacts.snapshot)
      : output.runtimeStateSnapshot
        ? this.isMeaningfulRuntimeSnapshot(output.runtimeStateSnapshot)
        : false;

    if (!output.episodeScript) {
      operations.push({ path: join(episodesDir, filename), content: episodeContent });
    }
    if (output.episodeScript) {
      operations.push(
        { path: join(episodesDir, episodeMarkdownFilename), content: output.content },
        {
          path: join(episodesDir, episodeJsonFilename),
          content: `${JSON.stringify(output.episodeScript, null, 2)}\n`,
        },
      );
      if (output.episodeHandoffCapsule) {
        operations.push({
          path: join(runtimeDir, `episode-${paddedNum}-handoff.json`),
          content: `${JSON.stringify(output.episodeHandoffCapsule, null, 2)}\n`,
        });
      }
      if (output.episodePerformanceReport) {
        operations.push({
          path: join(runtimeDir, `episode-${paddedNum}.performance.json`),
          content: `${JSON.stringify(output.episodePerformanceReport, null, 2)}\n`,
        });
      }
      if (output.episodeReviewEvidence) {
        const evidence = {
          ...output.episodeReviewEvidence,
          reviewedArtifacts: output.episodeReviewEvidence.reviewedArtifacts.map((artifact, index) =>
            index === 0 ? { ...artifact, artifact: `episodes/${episodeJsonFilename}` } : artifact,
          ),
        };
        operations.push({
          path: join(episodesDir, `${paddedNum}_review.json`),
          content: `${JSON.stringify(evidence, null, 2)}\n`,
        });
      }
    }
    if (persistTruth && shouldWriteState) {
      operations.push({ path: join(storyDir, "current_state.md"), content: nextStateMarkdown });
    }
    if (persistTruth && shouldWriteHooks) {
      operations.push({ path: join(storyDir, "pending_hooks.md"), content: nextHooksMarkdown });
    }

    if (persistTruth && runtimeStateArtifacts?.episodeSummariesMarkdown) {
      operations.push({
        path: join(storyDir, "episode_summaries.md"),
        content: runtimeStateArtifacts.episodeSummariesMarkdown,
      });
    }

    if (persistTruth && shouldSaveRuntimeSnapshot && (runtimeStateArtifacts?.snapshot ?? output.runtimeStateSnapshot)) {
      const snapshot = runtimeStateArtifacts?.snapshot ?? output.runtimeStateSnapshot!;
      const stateDir = join(storyDir, "state");
      await mkdir(stateDir, { recursive: true });
      operations.push(
        { path: join(stateDir, "manifest.json"), content: `${JSON.stringify(snapshot.manifest, null, 2)}\n` },
        { path: join(stateDir, "current_state.json"), content: `${JSON.stringify(snapshot.currentState, null, 2)}\n` },
        { path: join(stateDir, "hooks.json"), content: `${JSON.stringify(snapshot.hooks, null, 2)}\n` },
        { path: join(stateDir, "episode_summaries.json"), content: `${JSON.stringify(snapshot.episodeSummaries, null, 2)}\n` },
      );
    }

    if (persistTruth && numericalSystem) {
      operations.push({ path: join(storyDir, "particle_ledger.md"), content: output.updatedLedger });
    }

    if (persistTruth) {
      const summaryProjection = runtimeStateArtifacts?.episodeSummariesMarkdown
        ?? await readFile(join(storyDir, "episode_summaries.md"), "utf-8").catch(() => "");
      if (summaryProjection) {
        operations.push({ path: join(storyDir, "episode_summaries.md"), content: summaryProjection });
      }
    }
    await this.commitFileTransaction(operations);
  }

  private deriveScreenplayProjection(params: {
    readonly script: EpisodeScript;
    readonly title: string;
    readonly episodeNumber: number;
    readonly metrics?: EpisodeScriptMetrics;
    readonly episodeMemo?: EpisodeMemo;
    readonly hooksMarkdown: string;
    readonly ledgerMarkdown: string;
    readonly subplotBoard: string;
    readonly emotionalArcs: string;
    readonly characterMatrix: string;
  }): {
    readonly projection: {
      readonly stateProjection: string;
      readonly runtimeStateDelta: EpisodeRuntimeStateDelta;
      readonly runtimeStateSnapshot?: EpisodeRuntimeStateSnapshot;
      readonly updatedState: string;
      readonly updatedLedger: string;
      readonly updatedHooks: string;
      readonly episodeSummary: string;
      readonly updatedSubplots: string;
      readonly updatedEmotionalArcs: string;
      readonly updatedCharacterMatrix: string;
    };
    readonly usage: TokenUsage;
  } {
    const existingHooks = parsePendingHooksMarkdown(params.hooksMarkdown);
    const delta = deriveEpisodeRuntimeDelta({
      script: params.script,
      title: params.title,
      episode: params.episodeNumber,
      metrics: params.metrics,
      memo: params.episodeMemo,
      existingHooks,
    });
    return {
      projection: {
        stateProjection: "deterministic-episode-state-projection",
        runtimeStateDelta: delta,
        updatedState: "",
        updatedLedger: params.ledgerMarkdown,
        updatedHooks: params.hooksMarkdown,
        episodeSummary: this.renderDeltaSummaryRow(delta),
        updatedSubplots: params.subplotBoard,
        updatedEmotionalArcs: params.emotionalArcs,
        updatedCharacterMatrix: params.characterMatrix,
      },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  /** Apply all saveEpisode mutations together and restore prior bytes on failure. */
  private async commitFileTransaction(
    operations: ReadonlyArray<{ readonly path: string; readonly content?: string }>,
  ): Promise<void> {
    const originals = new Map<string, string | null>();
    for (const operation of operations) {
      if (originals.has(operation.path)) continue;
      originals.set(operation.path, await readFile(operation.path, "utf-8").catch(() => null));
    }
    const applied: string[] = [];
    try {
      for (const operation of operations) {
        await mkdir(dirname(operation.path), { recursive: true });
        applied.push(operation.path);
        if (operation.content === undefined) {
          await rm(operation.path, { force: true });
        } else {
          await writeFile(operation.path, operation.content, "utf-8");
        }
      }
    } catch (error) {
      for (const path of [...applied].reverse()) {
        const previous = originals.get(path);
        if (previous === null || previous === undefined) {
          await rm(path, { force: true }).catch(() => undefined);
        } else {
          await writeFile(path, previous, "utf-8").catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private isMeaningfulTruthUpdate(content: string | undefined, placeholder: string): boolean {
    const trimmed = content?.trim() ?? "";
    return trimmed.length > 0 && trimmed !== placeholder;
  }

  private isMeaningfulRuntimeSnapshot(snapshot: EpisodeRuntimeStateSnapshot): boolean {
    return snapshot.currentState.facts.length > 0 || snapshot.hooks.hooks.length > 0;
  }

  private buildUserPrompt(params: {
    readonly episodeNumber: number;
    readonly storyBible: string;
    readonly currentState: string;
    readonly ledger: string;
    readonly hooks: string;
    readonly recentEpisodes: string;
    readonly lengthSpec: LengthSpec;
    readonly targetDurationSeconds: number;
    readonly externalContext?: string;
    readonly episodeSummaries: string;
    readonly subplotBoard: string;
    readonly emotionalArcs: string;
    readonly characterMatrix: string;
    readonly dialogueFingerprints?: string;
    readonly relevantSummaries?: string;
    readonly parentCanon?: string;
    readonly language?: "zh" | "en";
  }): string {
    const currentState = this.capLegacyContext("current_state", params.currentState, LEGACY_WRITER_CONTEXT_BUDGET.currentState);
    const ledger = this.capLegacyContext("particle_ledger", params.ledger, LEGACY_WRITER_CONTEXT_BUDGET.ledger);
    const hooks = this.capLegacyContext("pending_hooks", params.hooks, LEGACY_WRITER_CONTEXT_BUDGET.hooks);
    const episodeSummaries = this.capLegacyContext(
      "episode_summaries",
      params.episodeSummaries,
      LEGACY_WRITER_CONTEXT_BUDGET.episodeSummaries,
    );
    const subplotBoard = this.capLegacyContext("subplot_board", params.subplotBoard, LEGACY_WRITER_CONTEXT_BUDGET.subplotBoard);
    const emotionalArcs = this.capLegacyContext("emotional_arcs", params.emotionalArcs, LEGACY_WRITER_CONTEXT_BUDGET.emotionalArcs);
    const characterMatrix = this.capLegacyContext(
      "character_matrix",
      params.characterMatrix,
      LEGACY_WRITER_CONTEXT_BUDGET.characterMatrix,
    );
    const storyBible = this.capLegacyContext("story_bible", params.storyBible, LEGACY_WRITER_CONTEXT_BUDGET.storyBible);
    const parentCanon = params.parentCanon
      ? this.capLegacyContext("parent_canon", params.parentCanon, LEGACY_WRITER_CONTEXT_BUDGET.parentCanon)
      : undefined;
    const contextBlock = params.externalContext
      ? `\n## 外部指令\n以下是来自外部系统的创作指令，请在本集中融入：\n\n${params.externalContext}\n`
      : "";

    const ledgerBlock = ledger
      ? `\n## 资源账本\n${ledger}\n`
      : "";

    const summariesBlock = episodeSummaries !== "(文件尚未创建)"
      ? `\n## 剧集摘要（全部历史剧集压缩上下文）\n${episodeSummaries}\n`
      : "";

    const subplotBlock = subplotBoard !== "(文件尚未创建)"
      ? `\n## 支线进度板\n${subplotBoard}\n`
      : "";

    const emotionalBlock = emotionalArcs !== "(文件尚未创建)"
      ? `\n## 情感弧线\n${emotionalArcs}\n`
      : "";

    const matrixBlock = characterMatrix !== "(文件尚未创建)"
      ? `\n## 角色交互矩阵\n${characterMatrix}\n`
      : "";

    const fingerprintBlock = params.dialogueFingerprints
      ? `\n## 角色对话指纹\n${params.dialogueFingerprints}\n`
      : "";

    const relevantBlock = params.relevantSummaries
      ? `\n## 相关历史剧集摘要\n${params.relevantSummaries}\n`
      : "";

    const canonBlock = parentCanon
      ? `\n## 正传正典参照（番外写作专用）
本书是番外作品。以下正典约束不可违反，角色不得引用超出其信息边界的信息。
${parentCanon}\n`
      : "";
    const lengthRequirementBlock = this.buildLengthRequirementBlock(
      params.lengthSpec,
      params.language ?? "zh",
      params.targetDurationSeconds,
    );

    if (params.language === "en") {
      return `Write episode ${params.episodeNumber} as a production-oriented screenplay.
${contextBlock}
## Current State
${currentState}
${ledgerBlock}
## Plot Threads
${hooks}
${summariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${fingerprintBlock}${relevantBlock}${canonBlock}
## Recent Episodes
${params.recentEpisodes || "(This is the first episode, no previous text)"}

## Worldbuilding
${storyBible}

${lengthRequirementBlock}
- Output PRE_WRITE_CHECK first, then EPISODE_SCRIPT_JSON
- Output only PRE_WRITE_CHECK and EPISODE_SCRIPT_JSON blocks`;
    }

    return `请创作第${params.episodeNumber}集漫剧分镜稿。
${contextBlock}
## 当前状态卡
${currentState}
${ledgerBlock}
## 伏笔池
${hooks}
${summariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${fingerprintBlock}${relevantBlock}${canonBlock}
## 最近剧集
${params.recentEpisodes || "(这是第一集，无前情)"}

## 世界观设定
${storyBible}

${lengthRequirementBlock}
- 先输出写作自检表，再输出 EPISODE_SCRIPT_JSON
- 只需输出 PRE_WRITE_CHECK、EPISODE_SCRIPT_JSON 两个区块`;
  }

  private capLegacyContext(label: string, content: string, maxChars: number): string {
    return capContextBlock(content, { label, maxChars });
  }

  private buildGovernedUserPrompt(params: {
    readonly episodeNumber: number;
    readonly episodeMemo: EpisodeMemo;
    readonly episodeIntentData?: EpisodeIntent;
    readonly contextPackage: ContextPackage;
    readonly ruleStack: RuleStack;
    readonly externalContext?: string;
    readonly lengthSpec: LengthSpec;
    readonly targetDurationSeconds: number;
    readonly language?: "zh" | "en";
    readonly varianceBrief?: string;
    readonly selectedEvidenceBlock?: string;
  }): string {
    const language = params.language ?? "zh";
    // The user's steering docs (author_intent = long-term direction, current_focus =
    // short-term focus) must land as a prominent, binding block near the top — not
    // buried among generic "evidence" entries where the model treats them as optional.
    const DIRECTION_SOURCES = new Set(["story/author_intent.md", "story/current_focus.md"]);
    const directionEntries = params.contextPackage.selectedContext.filter((entry) =>
      DIRECTION_SOURCES.has(entry.source),
    );
    const otherEntries = params.contextPackage.selectedContext.filter((entry) =>
      !DIRECTION_SOURCES.has(entry.source)
        && entry.source !== "runtime/episode_memo"
        && !isGovernedSemanticEvidenceSource(entry.source),
    );
    // The full governed context is useful for audit artifacts but is too
    // repetitive for a 90-second writer call. Keep the memo intact enough to
    // carry the contract, then bound lower-priority evidence deterministically.
    const contextSections = truncatePromptBlock(
      renderNarrativeSelectedContext(otherEntries, language),
      700,
      language === "en" ? "\n[secondary evidence truncated]" : "\n[次要证据已裁剪]",
    );
    const userDirectionBlock = directionEntries.length > 0
      ? (language === "en"
          ? `## User direction (overrides model defaults — must follow)\n${truncatePromptBlock(renderNarrativeSelectedContext(directionEntries, language), 250, "\n[direction truncated]")}\n`
          : `## 用户方向（优先于模型默认，必须遵循）\n${truncatePromptBlock(renderNarrativeSelectedContext(directionEntries, language), 250, "\n[方向已裁剪]")}\n`)
      : "";

    const diagnosticLines = params.ruleStack.sections.diagnostic.length > 0
      ? params.ruleStack.sections.diagnostic.join(", ")
      : "none";

    const lengthRequirementBlock = this.buildLengthRequirementBlock(
      params.lengthSpec,
      params.language ?? "zh",
      params.targetDurationSeconds,
    );
    const varianceBlock = params.varianceBrief
      ? `\n${params.varianceBrief}\n`
      : "";
    const selectedEvidenceBlock = params.selectedEvidenceBlock
      ? `\n${truncatePromptBlock(
          sanitizeNarrativeEvidenceBlock(params.selectedEvidenceBlock, language) ?? "",
          300,
          language === "en" ? "\n[governed evidence truncated]" : "\n[治理证据已裁剪]",
        )}\n`
      : "";
    const episodeContextBlock = this.buildEpisodeContextBlock(params.externalContext, language);
    const briefNarrative = truncatePromptBlock(
      renderMemoAsNarrativeBlock(params.episodeMemo, params.episodeIntentData, language),
      3_200,
      language === "en" ? "\n[memo detail truncated; contract fields remain authoritative]" : "\n[备忘细节已裁剪，合同字段仍以结构化输入为准]",
    );

    if (params.language === "en") {
      return `Write episode ${params.episodeNumber} as a production-oriented screenplay.

${episodeContextBlock}

${userDirectionBlock}
${briefNarrative}

## Selected Context
${contextSections || "(none)"}
${selectedEvidenceBlock}

## Rule Stack
- Hard: ${params.ruleStack.sections.hard.join(", ") || "(none)"}
- Soft: ${params.ruleStack.sections.soft.join(", ") || "(none)"}
- Diagnostic: ${diagnosticLines}

${varianceBlock}
${lengthRequirementBlock}
- Output PRE_WRITE_CHECK first, then EPISODE_SCRIPT_JSON
- Output only PRE_WRITE_CHECK and EPISODE_SCRIPT_JSON blocks`;
    }

    return `请创作第${params.episodeNumber}集漫剧分镜稿。

${episodeContextBlock}

${userDirectionBlock}
${briefNarrative}

## 已选上下文
${contextSections || "(无)"}
${selectedEvidenceBlock}

## 规则栈
- 硬护栏：${params.ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${params.ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${diagnosticLines}

${varianceBlock}
${lengthRequirementBlock}
- 先输出写作自检表，再输出 EPISODE_SCRIPT_JSON
- 只需输出 PRE_WRITE_CHECK、EPISODE_SCRIPT_JSON 两个区块`;
  }

  private buildEpisodeContextBlock(externalContext: string | undefined, language: "zh" | "en"): string {
    const trimmed = externalContext?.trim();
    if (!trimmed) return "";
    if (language === "en") {
      return `## Per-episode user instruction (highest priority)
${trimmed}

Obey this direct instruction for the current episode. If it specifies an episode title, use it exactly in EpisodeScript.title. Keep continuity, but do not replace this instruction with an outline fallback.`;
    }
    return `## 本集用户指令（最高优先级）
${trimmed}

这是用户对当前剧集的直接指令。若其中指定剧集标题，EpisodeScript.title 必须原样使用。保持连续性，但不要用篇章计划兜底替换这条指令。`;
  }

  private joinGovernedEvidenceBlocks(blocks: ReturnType<typeof buildGovernedMemoryEvidenceBlocks> | undefined): string | undefined {
    if (!blocks) {
      return undefined;
    }

    const joined = [
      blocks.titleHistoryBlock,
      blocks.moodTrailBlock,
      blocks.canonBlock,
      blocks.hookDebtBlock,
      blocks.hooksBlock,
      blocks.summariesBlock,
      blocks.volumeSummariesBlock,
    ]
      .filter((block): block is string => Boolean(block))
      .join("\n");

    return joined || undefined;
  }

  /**
   * Soft-check that the LLM's PRE_WRITE_CHECK output references the three
   * non-negotiable memo sections: 当前目标, 当集兑现, 不要做.
   *
   * This is NOT a hard gate — the memo was already parse-validated in the
   * planner, and the writer prompt already tells the LLM to align to memo.
   * We only warn when the LLM skipped a section, so the episode still ships.
   */
  private verifyPreWriteCheckAlignsWithMemo(
    preWriteCheck: string,
    episodeNumber: number,
    language: "zh" | "en",
  ): void {
    if (!preWriteCheck || preWriteCheck.trim().length === 0) {
      this.logWarn(language, {
        zh: `第${episodeNumber}集 PRE_WRITE_CHECK 为空，无法对齐 episode_memo`,
        en: `Episode ${episodeNumber} PRE_WRITE_CHECK is empty; cannot verify memo alignment`,
      });
      return;
    }

    const required = language === "en"
      ? [
          { needle: "Episode objective", label: "Episode objective" },
          { needle: "Local result", label: "Local result and outgoing pressure" },
          { needle: "Do not", label: "Do not" },
        ]
      : [
          { needle: "当前目标", label: "当前目标" },
          { needle: "当集兑现", label: "当集兑现" },
          { needle: "不要做", label: "不要做" },
        ];
    const missing = required.filter((r) => !preWriteCheck.includes(r.needle)).map((r) => r.label);

    if (missing.length > 0) {
      this.logWarn(language, {
        zh: `第${episodeNumber}集 PRE_WRITE_CHECK 缺少 memo 剧集检查：${missing.join("、")}`,
        en: `Episode ${episodeNumber} PRE_WRITE_CHECK missing memo sections: ${missing.join(", ")}`,
      });
    }
  }

  private buildLengthRequirementBlock(
    _lengthSpec: LengthSpec,
    language: "zh" | "en",
    targetDurationSeconds: number,
  ): string {
    const normalizedDuration = Number.isFinite(targetDurationSeconds)
      && targetDurationSeconds >= EPISODE_DURATION_HARD_MIN_SECONDS
      && targetDurationSeconds <= EPISODE_DURATION_HARD_MAX_SECONDS
      ? targetDurationSeconds
      : EPISODE_DURATION_TARGET_SECONDS;
    const { softMin, softMax } = episodeSoftDurationRange(normalizedDuration);
    if (language === "en") {
      return `Episode timing requirements:
- Target duration: about ${normalizedDuration} seconds
- Soft range: ${softMin}-${softMax} seconds
- Hard range: ${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS} seconds
- Use shot durationSeconds as the authoritative timing value.`;
    }

    return `剧集时长要求：
- 目标时长：约 ${normalizedDuration} 秒
- 允许区间：${softMin}-${softMax} 秒
- 硬区间：${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS} 秒
- 以每个镜头的 durationSeconds 作为最终时长依据。`;
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }

  /** Save new truth files (summaries, subplots, emotional arcs, character matrix). */
  async saveNewTruthFiles(
    bookDir: string,
    output: WriteEpisodeOutput,
    language: "zh" | "en" = "zh",
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const writes: Array<Promise<void>> = [];

    // Append episode summary to episode_summaries.md
    if (!output.runtimeStateDelta && output.updatedEpisodeSummaries) {
      writes.push(writeFile(
        join(storyDir, "episode_summaries.md"),
        output.updatedEpisodeSummaries,
        "utf-8",
      ));
    } else if (!output.runtimeStateDelta && output.episodeSummary) {
      writes.push(this.appendEpisodeSummary(storyDir, output.episodeSummary, language));
    }

    // Overwrite subplot board
    if (output.updatedSubplots) {
      writes.push(writeFile(join(storyDir, "subplot_board.md"), output.updatedSubplots, "utf-8"));
    }

    // Overwrite emotional arcs
    if (output.updatedEmotionalArcs) {
      writes.push(writeFile(join(storyDir, "emotional_arcs.md"), output.updatedEmotionalArcs, "utf-8"));
    }

    // Overwrite character matrix
    if (output.updatedCharacterMatrix) {
      writes.push(writeFile(join(storyDir, "character_matrix.md"), output.updatedCharacterMatrix, "utf-8"));
    }

    await Promise.all(writes);
  }

  private renderDeltaSummaryRow(delta: EpisodeRuntimeStateDelta): string {
    if (!delta.episodeSummary) return "";
    const summary = delta.episodeSummary;
    const row = [
      summary.episodeNumber,
      summary.title,
      summary.characters,
      summary.events,
      summary.stateChanges,
      summary.hookActivity,
      summary.mood,
      summary.episodeType,
      summary.payoff ?? "",
      summary.reversal ?? "",
      summary.relationshipChange ?? "",
      summary.emotionalHook ?? "",
      summary.endingQuestion ?? "",
      summary.estimatedDurationSeconds ?? "",
      summary.shotCount ?? "",
    ].map((value) => String(value).replace(/\|/g, "\\|").trim()).join(" | ");

    return `| ${row} |`;
  }

  private normalizeEpisodeRuntimeStateDeltaEpisode(
    delta: EpisodeRuntimeStateDelta,
    authoritativeEpisodeNumber: number,
  ): EpisodeRuntimeStateDelta {
    const hookOps = delta.hookOps ?? {
      upsert: [],
      mention: [],
      resolve: [],
      defer: [],
    };
    let changed = delta.episode !== authoritativeEpisodeNumber;
    const normalizedUpserts = hookOps.upsert.map((hook) => {
      const startEpisode = Math.min(hook.startEpisode, authoritativeEpisodeNumber);
      const lastAdvancedEpisode = Math.min(hook.lastAdvancedEpisode, authoritativeEpisodeNumber);
      if (startEpisode !== hook.startEpisode || lastAdvancedEpisode !== hook.lastAdvancedEpisode) {
        changed = true;
      }
      if (startEpisode === hook.startEpisode && lastAdvancedEpisode === hook.lastAdvancedEpisode) {
        return hook;
      }
      return {
        ...hook,
        startEpisode,
        lastAdvancedEpisode,
      };
    });

    if (delta.episodeSummary?.episodeNumber !== undefined && delta.episodeSummary.episodeNumber !== authoritativeEpisodeNumber) {
      changed = true;
    }
    if (!changed) {
      return delta;
    }

    return {
      ...delta,
      episode: authoritativeEpisodeNumber,
      hookOps: {
        ...hookOps,
        upsert: normalizedUpserts,
      },
      episodeSummary: delta.episodeSummary
        ? {
            ...delta.episodeSummary,
            episodeNumber: authoritativeEpisodeNumber,
          }
        : undefined,
    };
  }

  private enrichEpisodeRuntimeStateDelta(
    delta: EpisodeRuntimeStateDelta,
    script: EpisodeScript,
    title: string,
    episodeNumber: number,
    metrics?: EpisodeScriptMetrics,
  ): EpisodeRuntimeStateDelta {
    const summary = delta.episodeSummary;
    return {
      ...delta,
      episode: episodeNumber,
      episodeSummary: {
        episodeNumber,
        title,
        characters: summary?.characters ?? "",
        events: summary?.events ?? script.endState,
        stateChanges: summary?.stateChanges ?? script.endState,
        hookActivity: summary?.hookActivity ?? "",
        mood: summary?.mood ?? "",
        episodeType: summary?.episodeType ?? "episode",
        payoff: summary?.payoff
          ?? [
            script.contract.localDramaticResult.goalOutcome,
            script.contract.localDramaticResult.stateChange,
            `代价：${script.contract.localDramaticResult.costPaid}`,
          ].join("；"),
        reversal: script.reversal,
        relationshipChange: summary?.relationshipChange
          ?? script.contract.handoffState.relationship.join("；"),
        emotionalHook: script.emotionalHook,
        endingQuestion: script.emotionalHook,
        estimatedDurationSeconds: metrics?.estimatedDurationSeconds ?? script.estimatedDurationSeconds,
        shotCount: metrics?.shotCount ?? script.scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
      },
    };
  }

  private async buildRuntimeStateArtifactsIfPresent(
    bookDir: string,
    delta: EpisodeRuntimeStateDelta | undefined,
    language: "zh" | "en",
    authoritativeEpisodeNumber?: number,
    allowReapply?: boolean,
  ): Promise<RuntimeStateArtifacts | null> {
    if (!delta) return null;
    const safeDelta = authoritativeEpisodeNumber === undefined
      ? delta
      : this.normalizeEpisodeRuntimeStateDeltaEpisode(delta, authoritativeEpisodeNumber);
    return buildRuntimeStateArtifacts({
      bookDir,
      delta: safeDelta,
      language,
      allowReapply,
    });
  }

  private async resolveRuntimeStateArtifactsForOutput(
    bookDir: string,
    output: WriteEpisodeOutput,
    language: "zh" | "en",
  ): Promise<RuntimeStateArtifacts | null> {
    if (!output.runtimeStateDelta) return null;
    const safeDelta = this.normalizeEpisodeRuntimeStateDeltaEpisode(
      output.runtimeStateDelta,
      output.episodeNumber,
    );
    if (
      safeDelta === output.runtimeStateDelta
      && output.runtimeStateSnapshot
      && output.updatedEpisodeSummaries
      && output.updatedState
      && output.updatedHooks
    ) {
      return {
        snapshot: output.runtimeStateSnapshot,
        resolvedDelta: safeDelta,
        currentStateMarkdown: output.updatedState,
        hooksMarkdown: output.updatedHooks,
        episodeSummariesMarkdown: output.updatedEpisodeSummaries,
      };
    }

    return buildRuntimeStateArtifacts({
      bookDir,
      delta: safeDelta,
      language,
    });
  }

  private async appendEpisodeSummary(
    storyDir: string,
    summary: string,
    language: "zh" | "en",
  ): Promise<void> {
    const summaryPath = join(storyDir, "episode_summaries.md");
    let existing = "";
    try {
      existing = await readFile(summaryPath, "utf-8");
    } catch {
      // File doesn't exist yet — start with header
      existing = language === "en"
        ? "# Episode Summaries\n\n| Episode | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Episode Type | Payoff | Reversal | Relationship Change | Emotional Hook | Ending Question | Duration (s) | Shots |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n"
        : "# 剧集摘要\n\n| 集 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 剧集类型 | 爽点 | 反转 | 关系变化 | 情绪钩子 | 结尾问题 | 时长（秒） | 镜头数 |\n|---|------|----------|----------|----------|----------|----------|----------|------|------|----------|----------|----------|----------|------|\n";
    }

    // Extract only the data row(s) from the summary (skip header lines)
    const dataRows = summary
      .split("\n")
      .filter((line) =>
        line.startsWith("|")
        && !line.startsWith("| 剧集")
        && !line.startsWith("| 集")
        && !line.startsWith("| Episode")
        && !line.startsWith("| Episode")
        && !line.startsWith("|--")
        && !line.startsWith("| ---"),
      )
      .join("\n");

    if (dataRows) {
      // Deduplicate: remove existing rows with the same episode number before appending
      const newEpisodeNums = new Set(
        dataRows.split("\n")
          .map((line) => line.split("|")[1]?.trim())
          .filter((ch) => ch && /^\d+$/.test(ch)),
      );
      const deduped = existing
        .split("\n")
        .filter((line) => {
          if (!line.startsWith("|")) return true;
          const chNum = line.split("|")[1]?.trim();
          return !chNum || !newEpisodeNums.has(chNum);
        })
        .join("\n");
      await writeFile(summaryPath, `${deduped.trimEnd()}\n${dataRows}\n`, "utf-8");
    }
  }

  private buildStyleFingerprint(styleProfileRaw: string): string | undefined {
    if (!styleProfileRaw || styleProfileRaw === "(文件尚未创建)") return undefined;
    try {
      const profile = JSON.parse(styleProfileRaw);
      const lines: string[] = [];
      if (profile.avgSentenceLength) lines.push(`- 平均句长：${profile.avgSentenceLength}字`);
      if (profile.sentenceLengthStdDev) lines.push(`- 句长标准差：${profile.sentenceLengthStdDev}`);
      if (profile.avgParagraphLength) lines.push(`- 平均段落长度：${profile.avgParagraphLength}字`);
      if (profile.paragraphLengthRange) lines.push(`- 段落长度范围：${profile.paragraphLengthRange.min}-${profile.paragraphLengthRange.max}字`);
      if (profile.vocabularyDiversity) lines.push(`- 词汇多样性(TTR)：${profile.vocabularyDiversity}`);
      if (profile.topPatterns?.length > 0) lines.push(`- 高频句式：${profile.topPatterns.join("、")}`);
      if (profile.rhetoricalFeatures?.length > 0) lines.push(`- 修辞特征：${profile.rhetoricalFeatures.join("、")}`);
      return lines.length > 0 ? lines.join("\n") : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract dialogue fingerprints from recent episodes.
   * For each character with multiple dialogue lines, compute speaking style markers.
   */
  private extractDialogueFingerprints(recentEpisodes: string, _storyBible: string): string {
    if (!recentEpisodes) return "";

    // Match dialogue patterns:
    // Chinese: "speaker说道：" or dialogue in ""「」
    // English: "dialogue," speaker said. or "dialogue."
    const dialogueRegex = /(?:(.{1,6})(?:说道|道|喝道|冷声道|笑道|怒道|低声道|大声道|喝骂道|冷笑道|沉声道|喊道|叫道|问道|答道)\s*[：:]\s*["""「]([^"""」]+)["""」])|["""「]([^"""」]{2,})["""」]|"([^"]{2,})"/g;

    const characterDialogues = new Map<string, string[]>();
    let match: RegExpExecArray | null;

    while ((match = dialogueRegex.exec(recentEpisodes)) !== null) {
      const speaker = match[1]?.trim();
      const line = match[2] ?? match[3] ?? "";
      if (speaker && line.length > 1) {
        const existing = characterDialogues.get(speaker) ?? [];
        characterDialogues.set(speaker, [...existing, line]);
      }
    }

    // Only include characters with >=2 dialogue lines
    const fingerprints: string[] = [];
    for (const [character, lines] of characterDialogues) {
      if (lines.length < 2) continue;

      const avgLen = Math.round(lines.reduce((sum, l) => sum + l.length, 0) / lines.length);
      const isShort = avgLen < 15;

      // Find frequent words/phrases (2+ occurrences)
      const wordCounts = new Map<string, number>();
      for (const line of lines) {
        // Extract 2-3 char segments as "words"
        for (let i = 0; i < line.length - 1; i++) {
          const bigram = line.slice(i, i + 2);
          wordCounts.set(bigram, (wordCounts.get(bigram) ?? 0) + 1);
        }
      }
      const frequentWords = [...wordCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => `「${w}」`);

      // Detect style markers
      const markers: string[] = [];
      if (isShort) markers.push("短句为主");
      else markers.push("长句为主");

      const questionCount = lines.filter((l) => l.includes("？") || l.includes("?")).length;
      if (questionCount > lines.length * 0.3) markers.push("反问多");

      if (frequentWords.length > 0) markers.push(`常用${frequentWords.join("")}`);

      fingerprints.push(`${character}：${markers.join("，")}`);
    }

    return fingerprints.length > 0 ? fingerprints.join("；") : "";
  }

  /**
   * Find relevant episode summaries based on volume outline context.
   * Extracts character names and hook IDs from the current volume's outline,
   * then searches episode summaries for matching entries.
   */
  private findRelevantSummaries(
    episodeSummaries: string,
    volumeOutline: string,
    episodeNumber: number,
  ): string {
    if (!episodeSummaries || episodeSummaries === "(文件尚未创建)") return "";
    if (!volumeOutline || volumeOutline === "(文件尚未创建)") return "";

    // Extract character names from volume outline (Chinese name patterns)
    const nameRegex = /[\u4e00-\u9fff]{2,4}(?=[，、。：]|$)/g;
    const outlineNames = new Set<string>();
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRegex.exec(volumeOutline)) !== null) {
      outlineNames.add(nameMatch[0]);
    }

    // Extract hook IDs from volume outline
    const hookRegex = /H\d{2,}/g;
    const hookIds = new Set<string>();
    let hookMatch: RegExpExecArray | null;
    while ((hookMatch = hookRegex.exec(volumeOutline)) !== null) {
      hookIds.add(hookMatch[0]);
    }

    if (outlineNames.size === 0 && hookIds.size === 0) return "";

    // Search episode summaries for matching rows
    const rows = episodeSummaries.split("\n").filter((line) =>
      line.startsWith("|") && !line.startsWith("| 剧集") && !line.startsWith("|--") && !line.startsWith("| -"),
    );

    const matchedRows = rows.filter((row) => {
      for (const name of outlineNames) {
        if (row.includes(name)) return true;
      }
      for (const hookId of hookIds) {
        if (row.includes(hookId)) return true;
      }
      return false;
    });

    // Skip only the latest episode (its full text is already in context via loadRecentEpisodes)
    const filteredRows = matchedRows.filter((row) => {
      const chNumMatch = row.match(/\|\s*(\d+)\s*\|/);
      if (!chNumMatch) return true;
      const num = parseInt(chNumMatch[1]!, 10);
      return num < episodeNumber - 1;
    });

    return filteredRows.length > 0 ? filteredRows.join("\n") : "";
  }

  private sanitizeFilename(title: string): string {
    return title
      .replace(/[/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 50);
  }
}

function isStableWriterPromptSource(source: string): boolean {
  return source === "story/author_intent.md"
    || source === "story/outline/story_frame.md"
    || source.startsWith("story/outline/story_frame.md#")
    || source === "story/outline/volume_map.md"
    || source.startsWith("story/outline/volume_map.md#")
    || source === "story/parent_canon.md";
}

function isGovernedSemanticEvidenceSource(source: string): boolean {
  return source.startsWith("story/pending_hooks.md#")
    || source.startsWith("runtime/hook_debt#")
    || source.startsWith("story/episode_summaries.md#")
    || source.startsWith("story/volume_summaries.md#")
    || source === "story/parent_canon.md";
}
