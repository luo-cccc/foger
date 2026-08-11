import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import {
  ContextPackageSchema,
  type EpisodeTrace,
  type ContextPackage,
  type RuleStack,
} from "../models/input-governance.js";
import type { PlanEpisodeOutput } from "./planner.js";
import {
  buildGovernedRuleStack,
  buildGovernedTrace,
  getContextSourceTier,
} from "../utils/context-assembly.js";
import { writeGovernedRuntimeArtifacts } from "../utils/runtime-writer.js";
import { estimateTextTokens, type LLMClient } from "../llm/provider.js";
import { truncatePromptBlock } from "../utils/prompt-budget.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import { loadClaimsFile } from "../state/canon-store.js";
import { loadSystemRelations } from "../state/canon-store.js";
import { loadClaimVisibilityState, revealedClaimIds } from "../state/claim-visibility.js";
import { validateCanonClaims as validateCanonClaimsDeterministic } from "./canon-validator.js";
import {
  compileEpisodeClaims,
  renderClaimBrief,
  saveEpisodeClaimArtifacts,
  type EpisodeClaimArtifactPaths,
} from "../utils/episode-claim-compiler.js";
import { runPreWriteClaimGate as runPreWriteClaimGateDeterministic } from "../utils/claim-gate.js";
import {
  loadVolumeContracts,
  loadVolumeProgress,
  recordVolumeProgressEntry,
  renderVolumeContractBrief,
  renderVolumeProgressBrief,
  runVolumeGate,
  saveVolumeContractArtifacts,
  selectVolumeContract,
} from "../utils/volume-contract.js";
import { ClaimValidatorAgent } from "./claim-validator.js";
import { VolumeAuditorAgent, type VolumeAuditInput } from "./volume-auditor.js";
import {
  fingerprintContextCompilationKey,
  type ContextCompilationCache,
} from "../utils/context-compilation-cache.js";
import {
  compileEpisodeExecutionContract,
  renderEpisodeExecutionContract,
} from "../utils/episode-execution-contract.js";
import {
  attachEpisodeContextArtifacts,
  getEpisodeContextContent,
  getEpisodeContextRecentEpisodes,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

export interface ComposeEpisodeInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly plan: PlanEpisodeOutput;
  readonly contextBudget?: ContextBudget;
  readonly contextCompilationCache?: ContextCompilationCache;
  readonly compressibleContextCompiler?: CompressibleContextCompiler;
  readonly outlineSectionSelector?: OutlineSectionSelector;
  readonly onContextCompression?: ContextCompressionCallback;
  readonly volumeAuditor?: Pick<VolumeAuditorAgent, "auditVolumeGate" | "name">;
  readonly claimValidator?: Pick<ClaimValidatorAgent, "validateCanonClaims" | "runPreWriteClaimGate" | "name">;
  readonly episodeContextSnapshot?: EpisodeContextSnapshot;
}

export interface ContextBudget {
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly attentionInputTokens?: number;
}

export const DEFAULT_ATTENTION_INPUT_TOKENS = 8_000;

/**
 * Hard read-side cap for `story/author_intent.md` when it is loaded into the
 * per-episode protected context. CJK counts roughly one token per character,
 * so this keeps the direction card well inside the input budget even when the
 * file was seeded with an oversized document (see runner initBook).
 */
export const AUTHOR_INTENT_MAX_CHARS = 3_000;

export interface CompressibleContextCompileRequest {
  readonly episodeNumber: number;
  readonly goal: string;
  readonly language: "zh" | "en";
  readonly maxInputTokens: number;
  readonly protectedEntries: ContextPackage["selectedContext"];
  readonly semanticEntries: ContextPackage["selectedContext"];
  readonly compressibleEntries: ContextPackage["selectedContext"];
}

export type CompressibleContextCompiler = (request: CompressibleContextCompileRequest) => Promise<string>;

export interface OutlineSectionSelectionRequest {
  readonly fileName: string;
  readonly kind: "story-frame" | "volume-map";
  readonly episodeNumber: number;
  readonly goal: string;
  readonly outlineNode: string;
  readonly language: "zh" | "en";
  readonly candidates: ReadonlyArray<{
    readonly source: string;
    readonly heading: string;
    readonly excerpt: string;
  }>;
}

export type OutlineSectionSelector = (request: OutlineSectionSelectionRequest) => Promise<ReadonlyArray<string>>;

export interface ComposeEpisodeOutput {
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
  readonly trace: EpisodeTrace;
  readonly contextPath: string;
  readonly ruleStackPath: string;
  readonly tracePath: string;
  readonly claimArtifacts?: EpisodeClaimArtifactPaths;
}

export async function composeGovernedEpisode(input: ComposeEpisodeInput): Promise<ComposeEpisodeOutput> {
  if (!input.episodeContextSnapshot) {
    throw new Error("EPISODE_CONTEXT_REQUIRED: composer requires the operation EpisodeContextSnapshot.");
  }
  const storyDir = join(input.bookDir, "story");
  const runtimeDir = join(storyDir, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const baseSelectedContext = collectSelectedContextFromSnapshot(
    input.episodeContextSnapshot,
    input.plan,
    input.book.language ?? "zh",
  );
  const claimContext = await buildEpisodeClaimContext(input.bookDir, input.episodeNumber, input.plan, input.claimValidator);
  const volumeContext = await buildEpisodeVolumeContext(input.bookDir, input.episodeNumber, input.plan, input.volumeAuditor);
  const selectedContext = [
    ...baseSelectedContext,
    ...volumeContext.contextEntries,
    ...claimContext.contextEntries,
  ];
  const initialContextPackage = ContextPackageSchema.parse({
    episode: input.episodeNumber,
    selectedContext,
  });
  const budgeted = await applyContextBudgetIfNeeded({
    contextPackage: initialContextPackage,
    episodeNumber: input.episodeNumber,
    goal: input.plan.intent.goal,
    language: input.book.language ?? "zh",
    contextBudget: input.contextBudget,
    // Screenplay context is an engineering artifact, not a creative decision.
    // Keep the normal Episode v2 path deterministic so Composer never spends a
    // model call before Writer. Callers can still inject a compiler explicitly
    // for legacy/non-screenplay workflows.
    compiler: input.compressibleContextCompiler
      ?? (input.book.format === "screenplay" ? deterministicCompressibleContext : undefined),
    onContextCompression: input.onContextCompression,
  });
  const contextPackage = budgeted.contextPackage;

  const ruleStack = buildGovernedRuleStack(input.plan, input.episodeNumber);
  attachEpisodeContextArtifacts(input.episodeContextSnapshot, contextPackage, ruleStack);
  const trace = buildGovernedTrace({
    episodeNumber: input.episodeNumber,
    plan: input.plan,
    contextPackage,
    composerInputs: [input.plan.runtimePath, ...volumeContext.composerInputs, ...claimContext.composerInputs],
    notes: [...budgeted.notes, ...volumeContext.notes, ...claimContext.notes],
    compression: budgeted.compression,
  });
  const {
    contextPath,
    ruleStackPath,
    tracePath,
  } = await writeGovernedRuntimeArtifacts({
    runtimeDir,
    episodeNumber: input.episodeNumber,
    contextPackage,
    ruleStack,
    trace,
  });

  return {
    contextPackage,
    ruleStack,
    trace,
    contextPath,
    ruleStackPath,
    tracePath,
    ...(claimContext.artifacts ? { claimArtifacts: claimContext.artifacts } : {}),
  };
}

function deterministicCompressibleContext(request: CompressibleContextCompileRequest): Promise<string> {
  const entries = [...request.semanticEntries, ...request.compressibleEntries];
  const rendered = renderContextEntries(entries);
  const bounded = truncatePromptBlock(
    rendered,
    Math.max(1, request.maxInputTokens),
    request.language === "en" ? "\n[context truncated]" : "\n[上下文已裁剪]",
  );
  return Promise.resolve(bounded);
}

async function buildEpisodeVolumeContext(
  bookDir: string,
  episodeNumber: number,
  plan: PlanEpisodeOutput,
  volumeAuditor?: Pick<VolumeAuditorAgent, "auditVolumeGate" | "name">,
): Promise<{
  readonly contextEntries: ContextPackage["selectedContext"];
  readonly composerInputs: string[];
  readonly notes: string[];
}> {
  const contractFile = await loadVolumeContracts(bookDir, { episodeNumber });
  const contract = selectVolumeContract(contractFile.contracts, episodeNumber);
  if (!contract) {
    return { contextEntries: [], composerInputs: [], notes: [] };
  }
  await saveVolumeContractArtifacts(bookDir, contractFile);
  const previousProgress = await loadVolumeProgress(bookDir);
  const auditInput: VolumeAuditInput = {
    memo: plan.memo,
    contract,
    phase: "pre",
    progress: previousProgress,
    episodeNumber,
    miniCycleWindow: 5,
  };
  const issues = volumeAuditor?.auditVolumeGate(auditInput) ?? runVolumeGate(auditInput);
  const updatedProgress = await recordVolumeProgressEntry(bookDir, {
    episode: episodeNumber,
    volumeId: contract.volumeId,
    volumeNumber: contract.volumeNumber,
    krRefs: plan.memo.volumeKrRefs ?? [],
    rationale: plan.memo.volumeKrRationale ?? "",
    memoGoal: plan.memo.goal,
  });
  const gateExcerpt = issues.length > 0
    ? [
        "# Pre-write volume gate issues",
        ...issues.map((issue) => `- [${issue.severity}] ${issue.category}: ${issue.description}${issue.suggestion ? ` 修复建议：${issue.suggestion}` : ""}`),
      ].join("\n")
    : "";
  return {
    composerInputs: [
      "story/outline/volume_map.md",
      "story/runtime/volume-contracts.json",
      `story/runtime/${contract.volumeId}.contract.json`,
      `story/runtime/${contract.volumeId}.dashboard.md`,
      "story/runtime/volume-progress.json",
    ],
    notes: [
      `volume-auditor:${volumeAuditor?.name ?? "deterministic"}`,
      ...issues.map((issue) => `volume-auditor:${issue.severity}:${issue.category}`),
    ],
    contextEntries: [
      {
        source: "runtime/volume_contract",
        reason: "Binding current volume objective, key results, and irreversible event for this episode.",
        excerpt: renderVolumeContractBrief(contract, updatedProgress),
      },
      {
        source: "runtime/volume_progress",
        reason: "Recent KR binding history for the current volume mini-cycle.",
        excerpt: renderVolumeProgressBrief(updatedProgress, contract, {
          beforeEpisode: episodeNumber + 1,
          windowSize: 5,
        }),
      },
      ...(gateExcerpt
        ? [{
            source: "runtime/volume_gate",
            reason: "Pre-write volume gate warnings that the writer must honor or repair.",
            excerpt: gateExcerpt,
          }]
        : []),
    ],
  };
}

async function buildEpisodeClaimContext(
  bookDir: string,
  episodeNumber: number,
  plan: PlanEpisodeOutput,
  claimValidator?: Pick<ClaimValidatorAgent, "validateCanonClaims" | "runPreWriteClaimGate" | "name">,
): Promise<{
  readonly contextEntries: ContextPackage["selectedContext"];
  readonly composerInputs: string[];
  readonly notes: string[];
  readonly artifacts?: EpisodeClaimArtifactPaths;
}> {
  const claimsFile = await loadClaimsFile(bookDir);
  if (claimsFile.claims.length === 0) {
    return { contextEntries: [], composerInputs: [], notes: [] };
  }

  const memoText = [plan.memo.goal, plan.memo.body, ...plan.memo.threadRefs].filter(Boolean).join("\n");
  const pov = inferPovFromMemo(memoText);
  const systemRelations = await loadSystemRelations(bookDir);
  const canonIssues = claimValidator?.validateCanonClaims({
    claims: claimsFile.claims,
    relations: systemRelations,
  }) ?? validateCanonClaimsDeterministic(claimsFile.claims, systemRelations);
  const claimVisibility = await loadClaimVisibilityState(bookDir);
  const compiled = compileEpisodeClaims(claimsFile.claims, {
    episodeNumber,
    pov,
    memo: memoText,
    activeHookIds: plan.memo.threadRefs,
    revealedClaimIds: revealedClaimIds(claimVisibility),
  });
  const preGateInput = {
    text: memoText,
    compiled,
    phase: "pre",
  } as const;
  const preGateIssues = claimValidator?.runPreWriteClaimGate(preGateInput)
    ?? runPreWriteClaimGateDeterministic(preGateInput);
  const artifacts = await saveEpisodeClaimArtifacts(bookDir, compiled, { episodeNumber, pov });
  const validatorExcerpt = canonIssues.length > 0
    ? [
        "# Canon validator issues",
        ...canonIssues.map((issue) =>
          `- [${issue.severity}] ${issue.code}${issue.claimId ? ` (${issue.claimId})` : ""}: ${issue.message}`,
        ),
      ].join("\n")
    : "";
  const preGateExcerpt = preGateIssues.length > 0
    ? [
        "# Pre-write claim gate issues",
        ...preGateIssues.map((issue) => `- [${issue.severity}] ${issue.category}: ${issue.description} 修复建议：${issue.suggestion}`),
      ].join("\n")
    : "";
  return {
    artifacts,
    notes: [
      `claim-validator:${claimValidator?.name ?? "deterministic"}`,
      ...canonIssues.map((issue) => `claim-validator:${issue.severity}:${issue.code}`),
      ...preGateIssues.map((issue) => `claim-gate:${issue.severity}:${issue.category}`),
    ],
    composerInputs: [
      "story/canon/claims.json",
      "story/canon/system_relations.json",
      `story/runtime/episode-${String(episodeNumber).padStart(4, "0")}.claims.json`,
      `story/runtime/episode-${String(episodeNumber).padStart(4, "0")}.claim-brief.md`,
    ],
    contextEntries: [
      {
        source: "runtime/episode_claim_brief",
        reason: "Binding episode-level canon working set: usable claims, hidden truths, non-generalizable exceptions, costs, and conflict resolution.",
        excerpt: renderClaimBrief(compiled, { episodeNumber, pov }).trim(),
      },
      ...(validatorExcerpt
        ? [{
            source: "runtime/canon_validator",
            reason: "Deterministic canon schema and governance issues that must be honored before drafting.",
            excerpt: validatorExcerpt,
          }]
        : []),
      ...(preGateExcerpt
        ? [{
            source: "runtime/pre_write_claim_gate",
            reason: "Pre-write canon gate issues that must be fixed or avoided during drafting.",
            excerpt: preGateExcerpt,
          }]
        : []),
    ],
  };
}

function inferPovFromMemo(text: string): string | undefined {
  const match = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:POV|Point of view|视角|本章视角|本集视角|视角人物)\s*[：:]\s*([^\n,，;；/|]+)/i);
  const pov = match?.[1]?.trim();
  if (!pov) return undefined;
  if (/多视角|multiple|multi[-\s]?pov/i.test(pov)) return undefined;
  return pov.replace(/[。.!?）)]$/, "").trim() || undefined;
}

async function applyContextBudgetIfNeeded(params: {
  readonly contextPackage: ContextPackage;
  readonly episodeNumber: number;
  readonly goal: string;
  readonly language: "zh" | "en";
  readonly contextBudget?: ContextBudget;
  readonly compiler?: CompressibleContextCompiler;
  readonly onContextCompression?: ContextCompressionCallback;
}): Promise<{
  readonly contextPackage: ContextPackage;
  readonly notes: string[];
  readonly compression?: EpisodeTrace["compression"];
}> {
  const budget = params.contextBudget;
  if (!budget || budget.contextWindowTokens <= 0) {
    return { contextPackage: params.contextPackage, notes: [] };
  }

  const modelInputTokens = budget.contextWindowTokens - Math.max(0, budget.reservedOutputTokens);
  const attentionInputTokens = Number.isFinite(budget.attentionInputTokens)
      && (budget.attentionInputTokens ?? 0) > 0
    ? Math.floor(budget.attentionInputTokens!)
    : DEFAULT_ATTENTION_INPUT_TOKENS;
  const availableInputTokens = Math.max(1, Math.min(modelInputTokens, attentionInputTokens));
  const selectedContext = params.contextPackage.selectedContext;
  const totalTokens = estimateSelectedContextTokens(selectedContext);
  if (totalTokens <= availableInputTokens) {
    return { contextPackage: params.contextPackage, notes: [] };
  }

  const protectedEntries = selectedContext.filter((entry) => getContextSourceTier(entry.source) === "verbatim");
  const semanticEntries = selectedContext.filter((entry) => getContextSourceTier(entry.source) === "semantic");
  const compressibleEntries = selectedContext.filter((entry) => getContextSourceTier(entry.source) === "compressible");
  const protectedTokens = estimateSelectedContextTokens(protectedEntries);
  const semanticTokens = estimateSelectedContextTokens(semanticEntries);
  if (protectedTokens > availableInputTokens) {
    params.onContextCompression?.({
      category: "story_context",
      phase: "error",
      message: "Protected context exceeds available input budget.",
      protectedTokens,
      semanticTokens,
      compressibleTokens: estimateSelectedContextTokens(compressibleEntries),
      budgetTokens: availableInputTokens,
      sources: protectedEntries.map((entry) => entry.source),
    });
    throw new Error(
      `Protected context exceeds available input budget (${protectedTokens}/${availableInputTokens} tokens). ` +
      "InkOS will not rewrite verbatim author direction, episode memos, claim gates, or hook seed evidence.",
    );
  }
  if (semanticEntries.length === 0 && compressibleEntries.length === 0) {
    return { contextPackage: params.contextPackage, notes: ["context-over-budget-no-compressible-entries"] };
  }
  if (!params.compiler) {
    params.onContextCompression?.({
      category: "story_context",
      phase: "error",
      message: "Context exceeds available input budget but no compiler was provided.",
      protectedTokens,
      semanticTokens,
      compressibleTokens: estimateSelectedContextTokens(compressibleEntries),
      budgetTokens: availableInputTokens,
      sources: [...semanticEntries, ...compressibleEntries].map((entry) => entry.source),
    });
    throw new Error(
      `Context exceeds available input budget (${totalTokens}/${availableInputTokens} tokens), ` +
      "but no semantic context compiler was provided.",
    );
  }

  const compileBudget = Math.max(1, availableInputTokens - protectedTokens);
  const compressibleTokens = estimateSelectedContextTokens(compressibleEntries);
  params.onContextCompression?.({
    category: "story_context",
    phase: "start",
    protectedTokens,
    semanticTokens,
    compressibleTokens,
    budgetTokens: compileBudget,
    sources: [...semanticEntries, ...compressibleEntries].map((entry) => entry.source),
  });
  let compiled: string;
  try {
    compiled = (await params.compiler({
      episodeNumber: params.episodeNumber,
      goal: params.goal,
      language: params.language,
      maxInputTokens: compileBudget,
      protectedEntries,
      semanticEntries,
      compressibleEntries,
    })).trim();
  } catch (error) {
    params.onContextCompression?.({
      category: "story_context",
      phase: "error",
      message: error instanceof Error ? error.message : String(error),
      protectedTokens,
      semanticTokens,
      compressibleTokens,
      budgetTokens: compileBudget,
      sources: [...semanticEntries, ...compressibleEntries].map((entry) => entry.source),
    });
    throw error;
  }
  if (!compiled) {
    params.onContextCompression?.({
      category: "story_context",
      phase: "error",
        message: "Semantic context compiler returned empty output.",
      protectedTokens,
      semanticTokens,
      compressibleTokens,
      budgetTokens: compileBudget,
      sources: [...semanticEntries, ...compressibleEntries].map((entry) => entry.source),
    });
    throw new Error("Semantic context compiler returned empty output.");
  }
  params.onContextCompression?.({
    category: "story_context",
    phase: "end",
    protectedTokens,
    semanticTokens,
    compressibleTokens,
    budgetTokens: compileBudget,
    sources: [...semanticEntries, ...compressibleEntries].map((entry) => entry.source),
  });

  return {
    contextPackage: ContextPackageSchema.parse({
      episode: params.contextPackage.episode,
      selectedContext: [
        ...protectedEntries,
        {
          source: "runtime/compiled-context",
          reason: "Semantic compilation of binding semantic context and lower-priority context after the input budget was exceeded.",
          excerpt: compiled,
        },
      ],
    }),
    notes: ["compiled-context"],
    compression: {
      compiledSource: "runtime/compiled-context",
      protectedSources: protectedEntries.map((entry) => entry.source),
      semanticSources: semanticEntries.map((entry) => entry.source),
      compressedSources: compressibleEntries.map((entry) => entry.source),
      protectedTokens,
      semanticTokens,
      compressibleTokens,
      budgetTokens: compileBudget,
    },
  };
}

function estimateSelectedContextTokens(entries: ContextPackage["selectedContext"]): number {
  return entries.reduce((total, entry) => (
    total + estimateTextTokens([entry.source, entry.reason, entry.excerpt].filter(Boolean).join("\n"))
  ), 0);
}

function isStableContextSource(source: string): boolean {
  return source === "story/story_bible.md"
    || source.startsWith("story/story_bible.md#")
    || source === "story/parent_canon.md"
    || source.startsWith("story/parent_canon.md#")
    || source === "story/volume_summaries.md"
    || source.startsWith("story/volume_summaries.md#")
    || source === "story/outline/story_frame.md"
    || source.startsWith("story/outline/story_frame.md#")
    || source === "story/outline/volume_map.md"
    || source.startsWith("story/outline/volume_map.md#")
    || source.startsWith("story/outline/roles/")
    || source.startsWith("story/roles/");
}

function renderContextEntries(
  entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
): string {
  return entries.map((entry) =>
    [
      `### ${entry.source}`,
      `Reason: ${entry.reason}`,
      entry.excerpt ? entry.excerpt : "(no excerpt)",
    ].join("\n"),
  ).join("\n\n");
}

function canonicalContextSource(source: string): string {
  const hookMatch = source.match(/(?:runtime\/hook_debt|story\/pending_hooks\.md)#(.+)$/u);
  if (hookMatch?.[1]) return `hook:${hookMatch[1]}`;
  return source
    .replace(/^runtime\/episode_/u, "runtime/episode_")
    .replace(/^episode-/u, "episode-");
}

function dedupeContextEntries(
  entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
): ContextPackage["selectedContext"] {
  const merged = new Map<string, ContextPackage["selectedContext"][number]>();
  for (const entry of entries) {
    const key = canonicalContextSource(entry.source);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, entry);
      continue;
    }
    const currentExcerpt = current.excerpt ?? "";
    const nextExcerpt = entry.excerpt ?? "";
    merged.set(key, {
      source: current.source,
      reason: current.reason.length >= entry.reason.length ? current.reason : entry.reason,
      excerpt: currentExcerpt.length >= nextExcerpt.length ? currentExcerpt : nextExcerpt,
    });
  }
  return [...merged.values()];
}

function parseSelectedSources(raw: string): string[] {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parse = (value: string): unknown => JSON.parse(value);
  let parsed: unknown;
  try {
    parsed = parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    try {
      parsed = parse(trimmed.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const values = (parsed as { selectedSources?: unknown }).selectedSources;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export class ComposerAgent extends BaseAgent {
  get name(): string {
    return "composer";
  }

  async composeEpisode(input: ComposeEpisodeInput): Promise<ComposeEpisodeOutput> {
    const contextBudget = input.contextBudget ?? contextBudgetFromClient(this.ctx.client);
    return composeGovernedEpisode({
      ...input,
      contextBudget,
      compressibleContextCompiler: input.compressibleContextCompiler
        ?? (contextBudget
          ? (request) => this.compileCompressibleContext(request, input.contextCompilationCache)
          : undefined),
      outlineSectionSelector: input.outlineSectionSelector ?? ((request) => this.selectOutlineSections(request)),
      claimValidator: input.claimValidator ?? new ClaimValidatorAgent({
        ...this.ctx,
        logger: this.ctx.logger?.child("claim-validator"),
      }),
      volumeAuditor: input.volumeAuditor ?? new VolumeAuditorAgent({
        ...this.ctx,
        logger: this.ctx.logger?.child("volume-auditor"),
      }),
    });
  }

  async selectOutlineSections(request: OutlineSectionSelectionRequest): Promise<ReadonlyArray<string>> {
    if (request.candidates.length <= 1) {
      return request.candidates.map((candidate) => candidate.source);
    }
    const isEn = request.language === "en";
    const candidates = request.candidates.map((candidate, index) => [
      `#${index + 1} ${candidate.source}`,
      `heading: ${candidate.heading}`,
      candidate.excerpt,
    ].join("\n")).join("\n\n");
    const system = isEn
      ? [
          "You are InkOS's semantic outline-section selector.",
          "Select only the outline sections needed for the current episode. Prefer semantic relevance over keyword overlap.",
          "Return strict JSON only: {\"selectedSources\":[\"...\"]}. Use exact source ids from the candidates. If uncertain, include the safest relevant anchors rather than inventing ids.",
        ].join("\n")
      : [
          "你是 InkOS 的语义大纲选段器。",
          "只选择当前剧集真正需要的大纲段落。按语义相关性判断，不要按关键词重合机械选择。",
          "只返回严格 JSON：{\"selectedSources\":[\"...\"]}。必须使用候选里的精确 source id；不确定时选最安全的相关锚点，不要编造 id。",
        ].join("\n");
    const user = isEn
      ? [
          `File: ${request.fileName}`,
          `Episode: ${request.episodeNumber}`,
          `Goal: ${request.goal}`,
          `Outline node: ${request.outlineNode}`,
          "",
          "Candidates:",
          candidates,
        ].join("\n")
      : [
          `文件：${request.fileName}`,
          `剧集：第${request.episodeNumber}集`,
          `目标：${request.goal}`,
          `大纲节点：${request.outlineNode}`,
          "",
          "候选段落：",
          candidates,
        ].join("\n");
    const response = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], {
      temperature: 0.1,
      maxTokens: 1024,
      stream: false,
      callPhase: "compose-select-context",
    });
    const allowed = new Set(request.candidates.map((candidate) => candidate.source));
    return parseSelectedSources(response.content).filter((source) => allowed.has(source));
  }

  async compileCompressibleContext(
    request: CompressibleContextCompileRequest,
    cache?: ContextCompilationCache,
  ): Promise<string> {
    const isEn = request.language === "en";
    const protectedEntries = dedupeContextEntries(request.protectedEntries);
    const selectedEntries = dedupeContextEntries([
      ...request.semanticEntries,
      ...request.compressibleEntries,
    ]);
    const protectedBlock = renderContextEntries(protectedEntries);
    const stableEntries = selectedEntries
      .filter((entry) => isStableContextSource(entry.source));
    const dynamicSemanticEntries = selectedEntries
      .filter((entry) => getContextSourceTier(entry.source) === "semantic")
      .filter((entry) => !isStableContextSource(entry.source));
    const dynamicCompressibleEntries = selectedEntries
      .filter((entry) => getContextSourceTier(entry.source) === "compressible")
      .filter((entry) => !isStableContextSource(entry.source));
    const stableSummary = stableEntries.length > 0 && cache
      ? await this.getOrCompileStableContext(request, stableEntries, cache)
      : undefined;
    const semanticEntries = [
      ...(stableSummary
        ? [{
            source: "runtime/stable-context-cache",
            reason: "Stable foundation, role, canon, and volume context compiled once for this book/model budget.",
            excerpt: stableSummary,
          }]
        : stableEntries),
      ...dynamicSemanticEntries,
    ];
    const compressibleEntries = dynamicCompressibleEntries;
    const semanticBlock = renderContextEntries(semanticEntries);
    const compressibleBlock = renderContextEntries(compressibleEntries);
    const system = isEn
      ? [
          "You are InkOS's semantic context compiler.",
          "Do not rewrite the VERBATIM CONTEXT. Compile the SEMANTIC CONTEXT without losing any fact, id, prohibition, precedence, or timing constraint. Summarize or omit low-relevance COMPRESSIBLE CONTEXT.",
          "Output concise Markdown with source pointers. Exact prose is optional for semantic context, but its binding meaning is not.",
        ].join("\n")
      : [
          "你是 InkOS 的语义上下文编译器。",
          "不得改写【原文保护上下文】。编译【语义保护上下文】时，任何事实、ID、禁令、优先级和时间约束都不能丢失；【可压缩上下文】可以按相关性概括或删除。",
          "输出简洁 Markdown 并保留来源指针。语义保护内容可以换表达，但绑定含义不能削弱。",
        ].join("\n");
    const user = isEn
      ? [
          `Episode: ${request.episodeNumber}`,
          `Goal: ${request.goal}`,
          `Target budget for compiled context: <= ${request.maxInputTokens} estimated input tokens`,
          "",
          "## Verbatim Context (reference only, do not compile)",
          protectedBlock || "(none)",
          "",
          "## Semantic Context (compile fully; preserve every binding meaning)",
          semanticBlock || "(none)",
          "",
          "## Compressible Context (summarize by relevance)",
          compressibleBlock || "(none)",
        ].join("\n")
      : [
          `剧集：第${request.episodeNumber}集`,
          `目标：${request.goal}`,
          `压缩后目标预算：不超过 ${request.maxInputTokens} 估算输入 tokens`,
          "",
          "## 原文保护上下文（只作为参照，不要编译）",
          protectedBlock || "（无）",
          "",
          "## 语义保护上下文（完整编译，绑定含义不得丢失）",
          semanticBlock || "（无）",
          "",
          "## 可压缩上下文（按相关性概括）",
          compressibleBlock || "（无）",
        ].join("\n");

    const response = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], {
      temperature: 0.2,
      maxTokens: Math.min(8192, Math.max(512, request.maxInputTokens)),
      stream: false,
      callPhase: "compose-context",
    });
    return response.content.trim();
  }

  private async getOrCompileStableContext(
    request: CompressibleContextCompileRequest,
    entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
    cache: ContextCompilationCache,
  ): Promise<string> {
    const key = fingerprintContextCompilationKey([
      "inkos-stable-context-v1",
      this.ctx.projectRoot,
      this.ctx.bookId ?? "unknown-book",
      this.ctx.client.service ?? "",
      this.ctx.model,
      request.language,
      String(request.maxInputTokens),
      ...entries.map((entry) => [entry.source, entry.reason, entry.excerpt ?? ""].join("\n")),
    ]);
    const cached = cache.get(key);
    if (cached) return cached;

    const isEn = request.language === "en";
    const system = isEn
      ? [
          "You are InkOS's stable context compiler.",
          "Compile only stable foundation, role, canon, and volume context.",
          "Preserve every fact, id, prohibition, precedence, and timing constraint.",
          "Return concise Markdown with source pointers. Do not add facts or episode-specific events.",
        ].join("\n")
      : [
          "你是 InkOS 的稳定上下文编译器。",
          "只编译稳定的基础设定、角色、正典和卷级上下文。",
          "任何事实、ID、禁令、优先级和时间约束都不能丢失。",
          "输出带来源指针的简洁 Markdown，不得添加事实或剧集专属事件。",
        ].join("\n");
    const user = isEn
      ? [
          `Target budget: <= ${request.maxInputTokens} estimated input tokens`,
          "",
          renderContextEntries(entries),
        ].join("\n")
      : [
          `目标预算：不超过 ${request.maxInputTokens} 估算输入 tokens`,
          "",
          renderContextEntries(entries),
        ].join("\n");
    const response = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], {
      temperature: 0.1,
      maxTokens: Math.min(4096, Math.max(512, request.maxInputTokens)),
      stream: false,
      callPhase: "compose-context-cache",
      promptSources: [
        { source: "runtime/stable-context-cache/instructions", content: system, tier: "system", stable: true },
        ...entries.map((entry) => ({
          source: entry.source,
          content: entry.excerpt ?? "",
          tier: "semantic" as const,
          stable: true,
        })),
      ],
    });
    const compiled = response.content.trim();
    if (!compiled) throw new Error("Stable context compiler returned empty output.");
    cache.set(key, compiled);
    return compiled;
  }
}

export function contextBudgetFromClient(client: LLMClient): ContextBudget | undefined {
  const contextWindowTokens = client._piModel?.contextWindow;
  const reservedOutputTokens = Math.max(0, client.defaults?.maxTokens ?? 0);
  return {
    contextWindowTokens: Number.isFinite(contextWindowTokens) && contextWindowTokens && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_ATTENTION_INPUT_TOKENS + reservedOutputTokens,
    reservedOutputTokens,
    attentionInputTokens: DEFAULT_ATTENTION_INPUT_TOKENS,
  };
}

function collectSelectedContextFromSnapshot(
  snapshot: EpisodeContextSnapshot,
  plan: PlanEpisodeOutput,
  language: "zh" | "en",
): ContextPackage["selectedContext"] {
  const executionContract = compileEpisodeExecutionContract(plan.memo);
  const memorySelection = snapshot.planningMemorySelection;
  if (!memorySelection) {
    throw new Error("EPISODE_CONTEXT_INCOMPLETE: planner memory selection is missing from the operation snapshot.");
  }

  const entries: ContextPackage["selectedContext"] = [{
    source: "runtime/episode_memo",
    reason: skillReason("episode-memo", "Carry the host-compiled episode execution contract into governed writing."),
    excerpt: renderEpisodeExecutionContract(executionContract, language),
  }];
  const stableSources = [
    ["story/current_focus.md", "Current task focus for this episode."],
    ["story/author_intent.md", "Binding long-term creator intent."],
    ["story/current_state.md", "Authoritative incoming state for the episode."],
    ["story/outline/story_frame.md", "Stable series premise and canon constraints."],
    ["story/outline/volume_map.md", "Current arc position and planned destination."],
    ["story/parent_canon.md", "Parent-series canon constraints."],
  ] as const;
  for (const [source, reason] of stableSources) {
    let excerpt = getEpisodeContextContent(snapshot, source).trim();
    if (!excerpt) continue;
    // author_intent.md is a verbatim tier source that is never compiled away.
    // Guard against an oversized direction card (e.g. a pasted brief) blowing
    // the protected-context input budget; truncate to a readable tail instead
    // of failing the whole episode operation.
    if (source === "story/author_intent.md" && excerpt.length > AUTHOR_INTENT_MAX_CHARS) {
      excerpt = `${excerpt.slice(0, AUTHOR_INTENT_MAX_CHARS)}\n…（作者意图过长，已截断）`;
    }
    entries.push({ source, reason, excerpt });
  }

  const previousEpisode = getEpisodeContextRecentEpisodes(snapshot).at(-1)?.trim();
  if (previousEpisode) {
    entries.push({
      source: `episodes/recent/${String(Math.max(1, plan.intent.episode - 1)).padStart(4, "0")}`,
      reason: "Preserve the immediate visual, dialogue, and handoff continuity from the previous episode.",
      excerpt: previousEpisode.slice(-1_600),
    });
  }

  entries.push(
    ...memorySelection.facts.map((fact) => ({
      source: `story/current_state.md#${toFactAnchor(fact.predicate)}`,
      reason: skillReason("episodic-memory", "Relevant current-state fact selected during planning."),
      excerpt: `${fact.predicate} | ${fact.object}`,
    })),
    ...memorySelection.summaries.map((summary) => ({
      source: `story/episode_summaries.md#${summary.episode}`,
      reason: skillReason("episodic-memory", "Relevant episode summary selected during planning."),
      excerpt: [summary.title, summary.events, summary.stateChanges, summary.hookActivity]
        .filter(Boolean)
        .join(" | "),
    })),
    ...memorySelection.volumeSummaries.map((summary) => ({
      source: `story/volume_summaries.md#${summary.anchor}`,
      reason: skillReason("episodic-memory", "Relevant long-span arc summary selected during planning."),
      excerpt: `${summary.heading} | ${summary.content}`,
    })),
    ...memorySelection.hooks.map((hook) => ({
      source: `story/pending_hooks.md#${hook.hookId}`,
      reason: skillReason("active-hooks", "Relevant unresolved hook selected during planning."),
      excerpt: [hook.type, hook.status, hook.expectedPayoff, hook.payoffTiming, hook.notes]
        .filter(Boolean)
        .join(" | "),
    })),
  );
  return dedupeContextEntries(entries);
}

function skillReason(_needId: string, fallback: string): string {
  return fallback;
}

function toFactAnchor(predicate: string): string {
    return predicate
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      || "fact";
}
