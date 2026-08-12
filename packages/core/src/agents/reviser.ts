import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { EpisodeIntent, EpisodeMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { countEpisodeLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { filterSummaries } from "../utils/context-filter.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
  mergeTableMarkdownByKey,
} from "../utils/governed-working-set.js";
import {
  buildNarrativeIntentBrief,
  renderMemoAsNarrativeBlock,
  renderNarrativeSelectedContext,
  sanitizeNarrativeEvidenceBlock,
} from "../utils/narrative-control.js";
import { z } from "zod";
import { estimateTextTokens } from "../llm/provider.js";
import { resolvePromptCompactionTarget, truncatePromptBlock } from "../utils/prompt-budget.js";
import { measureEpisodeScript, parseEpisodeScriptOutput, renderEpisodeScriptMarkdown, EPISODE_DURATION_HARD_MAX_SECONDS, EPISODE_DURATION_HARD_MIN_SECONDS, EPISODE_DURATION_TARGET_SECONDS, episodeShotBudget, episodeSoftDurationRange } from "../models/episode-script.js";
import { applyEpisodeRevisionPatch, parseEpisodeRevisionPatch } from "../utils/episode-revision-patch.js";
import {
  getEpisodeContextContent,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

export const ReviseModeSchema = z.enum(["auto", "polish", "rewrite", "rework", "anti-detect", "spot-fix"]);
export type ReviseMode = z.infer<typeof ReviseModeSchema>;

export const DEFAULT_REVISE_MODE: ReviseMode = "auto";

/**
 * Safe ceiling for one revision-rewrite output call. Raised from 8192 (which
 * truncated long rewrites on larger models); effective limit = min(ceiling,
 * client.defaults.maxTokens) so small models fall back to their own maxOutput.
 */
const DEFAULT_REVISE_MAX_OUTPUT_TOKENS = 32768;

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly episodeDurationSeconds: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly changeKind?: "patch" | "rewrite";
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

function buildTieredIssueList(
  issues: ReadonlyArray<AuditIssue>,
  isEnglish: boolean,
): string {
  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];

  for (const issue of issues) {
    const line = `- ${issue.category}: ${issue.description}`;
    if (issue.severity === "critical") {
      critical.push(line);
    } else if (issue.severity === "warning") {
      high.push(line);
    } else {
      medium.push(line);
    }
  }

  const parts: string[] = [];
  if (critical.length > 0) {
    parts.push(isEnglish
      ? `## Critical — Must Fix\n${critical.join("\n")}`
      : `## Critical（必须解决）\n${critical.join("\n")}`);
  }
  if (high.length > 0) {
    parts.push(isEnglish
      ? `## High — Should Improve\n${high.join("\n")}`
      : `## High（应当改善）\n${high.join("\n")}`);
  }
  if (medium.length > 0) {
    parts.push(isEnglish
      ? `## Medium — Reference\n${medium.join("\n")}`
      : `## Medium（参考建议）\n${medium.join("\n")}`);
  }

  return parts.join("\n\n");
}

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  /**
   * Effective output-token limit for a full rewrite: the safe ceiling clamped
   * by the model card's maxOutput (same policy as the writer's screenplay
   * call). Large models get the full budget; smaller models fall back to
   * their own limit instead of hitting an API max_tokens error.
   */
  private reviseOutputTokens(): number {
    const modelMax = this.ctx.client.defaults?.maxTokens;
    if (!Number.isFinite(modelMax) || modelMax <= 0) return DEFAULT_REVISE_MAX_OUTPUT_TOKENS;
    return Math.min(DEFAULT_REVISE_MAX_OUTPUT_TOKENS, modelMax);
  }

  async reviseEpisode(
    bookDir: string,
    episodeContent: string,
    episodeNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    genre?: string,
    options?: {
      episodeIntent?: string;
      episodeMemo?: EpisodeMemo;
      episodeIntentData?: EpisodeIntent;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      lengthSpec?: LengthSpec;
      targetDurationSeconds?: number;
      episodeContextSnapshot?: EpisodeContextSnapshot;
    },
  ): Promise<ReviseOutput> {
    const snapshot = options?.episodeContextSnapshot;
    if (!snapshot) {
      throw new Error("EPISODE_CONTEXT_REQUIRED: reviser requires the operation EpisodeContextSnapshot.");
    }
    const missing = "(文件不存在)";
    const diskCurrentState = getEpisodeContextContent(snapshot, "story/current_state.md", missing);
    const ledger = getEpisodeContextContent(snapshot, "story/particle_ledger.md", missing);
    const hooks = getEpisodeContextContent(snapshot, "story/pending_hooks.md", missing);
    const styleGuideRaw = getEpisodeContextContent(snapshot, "story/style_guide.md", missing);
    const volumeOutline = getEpisodeContextContent(snapshot, "story/outline/volume_map.md", missing);
    const storyBible = getEpisodeContextContent(snapshot, "story/outline/story_frame.md", missing);
    const characterMatrix = getEpisodeContextContent(snapshot, "story/character_context.md", missing);
    const episodeSummaries = getEpisodeContextContent(snapshot, "story/episode_summaries.md", missing);
    const parentCanon = getEpisodeContextContent(snapshot, "story/parent_canon.md", missing);
    let currentState = diskCurrentState;

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    const [{ profile: gp }, bookLanguage] = await Promise.all([
      readGenreProfile(this.ctx.projectRoot, genreId),
      readBookLanguage(bookDir),
    ]);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;

    // Fallback: use book_rules body when style_guide.md doesn't exist.
    // Phase 5 hotfix 2: parsedRules.body is only populated for legacy
    // book_rules.md sources — story_frame.md frontmatter yields an empty
    // body, and an empty string is NOT a usable style guide. Treat
    // missing/empty body as "no fallback available".
    const legacyRulesBody = parsedRules?.body?.trim();
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (legacyRulesBody || "(无文风指南)");

    const isEnglish = (bookLanguage ?? gp.language) === "en";
    const resolvedLanguage = isEnglish ? "en" : "zh";

    let issueList = mode === "auto"
      ? buildTieredIssueList(issues, isEnglish)
      : issues
          .map((i) => `- [${i.severity}] ${i.category}: ${i.description}\n  ${isEnglish ? "Suggestion" : "建议"}: ${i.suggestion}`)
          .join("\n");

    const numericalRule = gp.numericalSystem
      ? (isEnglish
          ? "\n3. Numerical errors must be fixed precisely — cross-check before and after"
          : "\n3. 数值错误必须精确修正，前后对账")
      : "";
    const protagonistBlock = bookRules?.protagonist
      ? (isEnglish
          ? `\n\nProtagonist lock: ${bookRules.protagonist.name} — ${bookRules.protagonist.personalityLock.join(", ")}. Revisions must not violate the protagonist profile.`
          : `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`)
      : "";
    const langPrefix = isEnglish
      ? `【LANGUAGE OVERRIDE】ALL output (FIXED_ISSUES, REVISED_CONTENT, UPDATED_STATE, UPDATED_HOOKS) MUST be in English.\n\n`
      : "";
    const governedMode = Boolean(options?.episodeIntent && options?.contextPackage && options?.ruleStack);
    const hooksWorkingSet = governedMode && options?.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: options.contextPackage,
          episodeNumber,
          language: resolvedLanguage,
        })
      : hooks;
    const episodeSummariesWorkingSet = governedMode
      ? filterSummaries(episodeSummaries, episodeNumber)
      : episodeSummaries;
    const characterMatrixWorkingSet = governedMode
      ? buildGovernedCharacterMatrixWorkingSet({
          matrixMarkdown: characterMatrix,
          episodeIntent: options?.episodeIntent ?? volumeOutline,
          contextPackage: options!.contextPackage!,
          protagonistName: bookRules?.protagonist?.name,
        })
      : characterMatrix;

    const systemPromptBase = this.buildAutoSystemPrompt({
      langPrefix,
      gp,
      protagonistBlock,
      numericalRule,
      allowPatch: issues.every((issue) => issue.repairScope === "local"),
      resolvedLanguage,
      lengthSpec: options?.lengthSpec,
      targetDurationSeconds: options?.targetDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
    });
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.reviser");

    let ledgerBlock = gp.numericalSystem
      ? `\n## 资源账本\n${ledger}`
      : "";
    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;
    let hookDebtBlock = sanitizeNarrativeEvidenceBlock(
      governedMemoryBlocks?.hookDebtBlock ?? "",
      resolvedLanguage,
    ) ?? "";
    let hooksBlock = sanitizeNarrativeEvidenceBlock(
      governedMemoryBlocks?.hooksBlock ?? `\n## 伏笔池\n${hooksWorkingSet}\n`,
      resolvedLanguage,
    ) ?? "";
    let outlineBlock = volumeOutline !== "(文件不存在)"
      ? `\n## 卷纲\n${volumeOutline}\n`
      : "";
    let bibleBlock = !governedMode && storyBible !== "(文件不存在)"
      ? `\n## 世界观设定\n${storyBible}\n`
      : "";
    let matrixBlock = characterMatrixWorkingSet !== "(文件不存在)"
      ? `\n## 角色交互矩阵\n${characterMatrixWorkingSet}\n`
      : "";
    let summariesBlock = sanitizeNarrativeEvidenceBlock(governedMemoryBlocks?.summariesBlock
      ?? (episodeSummariesWorkingSet !== "(文件不存在)"
        ? `\n## 剧集摘要\n${episodeSummariesWorkingSet}\n`
        : ""), resolvedLanguage) ?? "";
    let volumeSummariesBlock = sanitizeNarrativeEvidenceBlock(
      governedMemoryBlocks?.volumeSummariesBlock ?? "",
      resolvedLanguage,
    ) ?? "";

    const hasParentCanon = parentCanon !== "(文件不存在)";

    let canonBlock = hasParentCanon
      ? `\n## 正传正典参照（修稿专用）\n本书为番外作品。修改时参照正典约束，不可改变正典事实。\n${parentCanon}\n`
      : "";

    let reducedControlBlock = options?.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.episodeMemo, options.episodeIntentData, options.episodeIntent, options.contextPackage, options.ruleStack)
      : "";
    const lengthGuidanceBlock = mode !== "auto" && options?.targetDurationSeconds
      ? `\n## 时长护栏\n目标时长：${options.targetDurationSeconds} 秒\n建议区间：${episodeSoftDurationRange(options.targetDurationSeconds).softMin}-${episodeSoftDurationRange(options.targetDurationSeconds).softMax} 秒\n硬区间：${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS} 秒\n如果超时，优先压缩重复动作、弱信息对白和多余解释，不得新增支线或删掉核心事实。\n`
      : "";
    let styleGuideBlock = reducedControlBlock.length === 0
      ? `\n## 文风指南\n${styleGuide}`
      : "";

    const renderUserPrompt = (): string => `请修正第${episodeNumber}集分镜剧本。

## 审稿问题
${issueList}

## 当前状态卡
${currentState}
${ledgerBlock}
${hookDebtBlock}${hooksBlock}${volumeSummariesBlock}${reducedControlBlock || outlineBlock}${bibleBlock}${matrixBlock}${summariesBlock}${canonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## 待修正剧集
${episodeContent}`;

    let userPrompt = renderUserPrompt();
    const promptTarget = resolvePromptCompactionTarget(this.ctx.maxPromptEstimatedTokens);
    if (promptTarget !== undefined) {
      const promptTokens = (): number => estimateTextTokens(systemPrompt) + estimateTextTokens(userPrompt);
      const rebuild = (): void => {
        userPrompt = renderUserPrompt();
      };
      const optionalBlocks: Array<() => void> = [
        () => { volumeSummariesBlock = ""; },
        () => { summariesBlock = ""; },
        () => { bibleBlock = ""; },
        () => { outlineBlock = ""; },
        () => { styleGuideBlock = ""; },
      ];
      for (const dropOptionalBlock of optionalBlocks) {
        if (promptTokens() <= promptTarget) break;
        dropOptionalBlock();
        rebuild();
      }

      const marker = isEnglish
        ? "\n[Lower-priority revision context truncated.]"
        : "\n[低优先级修稿上下文已截断]";
      const compactBlock = (
        value: string,
        minimumTokens: number,
        assign: (next: string) => void,
      ): void => {
        const overage = promptTokens() - promptTarget;
        if (overage <= 0 || value.length === 0) return;
        const currentTokens = estimateTextTokens(value);
        const nextBudget = Math.max(minimumTokens, currentTokens - overage - 64);
        if (nextBudget >= currentTokens) return;
        assign(truncatePromptBlock(value, nextBudget, marker));
        rebuild();
      };

      compactBlock(reducedControlBlock, 768, (next) => { reducedControlBlock = next; });
      compactBlock(matrixBlock, 512, (next) => { matrixBlock = next; });
      compactBlock(canonBlock, 512, (next) => { canonBlock = next; });
      compactBlock(hooksBlock, 384, (next) => { hooksBlock = next; });
      compactBlock(hookDebtBlock, 192, (next) => { hookDebtBlock = next; });
      compactBlock(ledgerBlock, 256, (next) => { ledgerBlock = next; });
      compactBlock(currentState, 256, (next) => { currentState = next; });
      compactBlock(issueList, 512, (next) => { issueList = next; });
    }

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.3, stream: false, callPhase: "revise", maxTokens: this.reviseOutputTokens() },
    );

    const output = this.parseOutput(
      response.content,
      gp,
      episodeContent,
    );
    const mergedOutput = governedMode && output.updatedHooks !== "(伏笔池未更新)"
      ? {
          ...output,
          updatedHooks: mergeTableMarkdownByKey(hooks, output.updatedHooks, [0]),
        }
      : output;
    let episodeDurationSeconds = mergedOutput.episodeDurationSeconds;
    try {
      episodeDurationSeconds = measureEpisodeScript(
        parseEpisodeScriptOutput(mergedOutput.revisedContent),
        options?.targetDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS,
      ).estimatedDurationSeconds;
    } catch {
      if (options?.lengthSpec) {
        episodeDurationSeconds = countEpisodeLength(mergedOutput.revisedContent, options.lengthSpec.countingMode);
      }
    }
    return { ...mergedOutput, episodeDurationSeconds, tokenUsage: response.usage };
  }

  private parseOutput(
    content: string,
    gp: GenreProfile,
    originalEpisode: string,
  ): ReviseOutput {
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const fixedRaw = extract("FIXED_ISSUES");
    const fixedIssues = fixedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const makeResult = (
      revisedContent: string,
      applied: boolean,
      changeKind?: "patch" | "rewrite",
    ): ReviseOutput => {
      let normalizedContent = revisedContent;
      if (applied) {
        try {
          const script = parseEpisodeScriptOutput(revisedContent);
          normalizedContent = renderEpisodeScriptMarkdown(script);
        } catch (error) {
          this.ctx.logger?.warn(
            `[reviser] rejected invalid EpisodeScript candidate: ${error instanceof Error ? error.message : String(error)}`,
          );
          normalizedContent = originalEpisode;
          applied = false;
          changeKind = undefined;
        }
      }
      return {
      revisedContent: normalizedContent,
      episodeDurationSeconds: normalizedContent.length,
      fixedIssues: applied ? fixedIssues : [],
      updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
      updatedLedger: gp.numericalSystem
        ? (extract("UPDATED_LEDGER") || "(账本未更新)")
        : "",
      updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
      ...(applied && changeKind ? { changeKind } : {}),
      };
    };

    const patchRaw = extract("REVISED_PATCH");
    if (patchRaw) {
      const patch = parseEpisodeRevisionPatch(patchRaw);
      if (patch) {
        const applied = applyEpisodeRevisionPatch(originalEpisode, patch);
        if (applied.applied) {
          return makeResult(applied.content, true, "patch");
        }
      }
    }

    // Manual modes use the same EpisodeScript authority as automatic repair.
    const revisedContent = extract("REVISED_CONTENT");
    return makeResult(
      revisedContent || originalEpisode,
      revisedContent.length > 0,
      revisedContent.length > 0 ? "rewrite" : undefined,
    );
  }

  private buildAutoSystemPrompt(params: {
    langPrefix: string;
    gp: GenreProfile;
    protagonistBlock: string;
    numericalRule: string;
    allowPatch: boolean;
    resolvedLanguage: "zh" | "en";
    lengthSpec?: LengthSpec;
    targetDurationSeconds: number;
  }): string {
    const {
      langPrefix,
      gp,
      protagonistBlock,
      numericalRule,
      allowPatch,
      resolvedLanguage,
      targetDurationSeconds,
    } = params;
    const en = resolvedLanguage === "en";
    const ledgerSection = gp.numericalSystem
      ? (en ? "\n=== UPDATED_LEDGER ===\n(Full updated resource ledger)" : "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)")
      : "";
    const { softMin, softMax } = episodeSoftDurationRange(targetDurationSeconds);
    const shotBudget = episodeShotBudget(targetDurationSeconds);
    const rewriteLengthConstraint = en
      ? `\n  HARD CONSTRAINT: Return a valid EpisodeScript JSON object with 1-3 scenes, ${shotBudget.min}-${shotBudget.softMax} shots (soft upper cap), target ${targetDurationSeconds} seconds, preferred ${softMin}-${softMax} seconds, and hard range ${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS} seconds.`
      : `\n  硬性约束：返回合法的 EpisodeScript JSON 对象，包含 1-3 个场景、${shotBudget.min}-${shotBudget.softMax} 个镜头（上限为软约束），目标 ${targetDurationSeconds} 秒，建议区间 ${softMin}-${softMax} 秒，硬区间 ${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS} 秒。`;
    const patchModeHint = en
      ? (allowPatch
          ? `\n\nAll cited findings are localized. You MAY output a === REVISED_PATCH === block instead of a full REVISED_CONTENT: {"episode":N,"replaceShots":[{"sceneId":"S1","shotId":"S1-02","shot":{...complete shot object}}],"updateContract":[{"path":"localDramaticResult.stateChange","value":"..."}],"title":"..."}. Patch only what the findings demand; keep everything else byte-identical.`
          : "")
      : (allowPatch
          ? `\n\n本次指出的问题均为局部问题。你可以只输出 === REVISED_PATCH === 块代替完整 REVISED_CONTENT：{"episode":N,"replaceShots":[{"sceneId":"S1","shotId":"S1-02","shot":{完整镜头对象}}],"updateContract":[{"path":"localDramaticResult.stateChange","value":"..."}],"title":"..."}。只修补 finding 要求的内容，其余保持原样。`
          : "");

    return en
      ? `${langPrefix}You are a professional ${gp.name} comic-drama screenplay revision editor. Return one complete, valid EpisodeScript JSON rewrite.${protagonistBlock}${rewriteLengthConstraint}${patchModeHint}

Revision principles:
1. Fix only the cited findings and preserve established facts, chronology, character intent, and hook identity.
2. Keep hook status synchronized with the provided hook context.
3. Preserve incoming state, objective, reversal identity, local dramatic result, outgoing pressure, handoff state, and information permissions unless the finding explicitly owns that field.
4. Every repaired contract claim must remain traceable to a visible or audible shot.
5. Do not output prose, partial patches, or Markdown code fences.
6. One pass solves one failure type. When several findings are cited, work through them in this order — causality, scene movement, performability, dialogue, production facts, handoff — one finding at a time. In FIXED_ISSUES declare which cited finding each change resolves; a change that resolves nothing cited does not belong in this pass.
7. Localized repair preserves unrelated shots verbatim. The deterministic patch applier and the revision verifier carry that guarantee, so never "improve" a shot no finding cited.

Output only:

=== FIXED_ISSUES ===
(List each completed fix on its own line.)

${allowPatch ? "=== REVISED_PATCH ===\n(Optional localized patch JSON; omit when the fix is structural and requires REVISED_CONTENT.)\n" : ""}
=== REVISED_CONTENT ===
(A complete raw EpisodeScript JSON object.)

=== UPDATED_STATE ===
(Full updated state card.)
${ledgerSection}
=== UPDATED_HOOKS ===
(Full updated hooks board.)`
      : `${langPrefix}你是一位专业的${gp.name}漫剧分镜修稿编辑。只返回一份完整、合法的 EpisodeScript JSON 改写。${protagonistBlock}${rewriteLengthConstraint}${patchModeHint}

修稿原则：
1. 只修复审查指出的问题，保留既有事实、时间线、角色意图和 Hook 身份。
2. Hook 状态必须与提供的上下文一致。
3. 除非 finding 明确负责对应字段，否则保留进入状态、目标、反转身份、当集兑现、出去压力、交接状态和信息权限。
4. 修复后的每个 contract 声明都必须能在可见或可听镜头中找到证据。
5. 禁止输出小说散文、局部补丁或 Markdown 代码围栏。
6. 一遍只解决一种失败。收到多个 finding 时按 因果→场景运动→可表演性→对白→生产事实→交接 的顺序逐个处理，一次只处理一个；在 FIXED_ISSUES 里声明每处修改解决的是哪条 finding，不解决任何 finding 的修改不属于这一遍。
7. 局部修订逐字保留无关镜头。保留保证由确定性 patch 应用器与修订复核共同承担，不要顺手"优化"任何 finding 未指向的镜头。

只输出：

=== FIXED_ISSUES ===
(逐条说明已完成的修复。)

${allowPatch ? "=== REVISED_PATCH ===\n(可选：局部修复 JSON；当修复需要结构性重写时省略此块并用 REVISED_CONTENT。)\n" : ""}
=== REVISED_CONTENT ===
(完整的原始 EpisodeScript JSON 对象。)

=== UPDATED_STATE ===
(更新后的完整状态卡。)
${ledgerSection}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池。)`;
  }

  private buildReducedControlBlock(
    memo: EpisodeMemo | undefined,
    intent: EpisodeIntent | undefined,
    episodeIntent: string | undefined,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
  ): string {
    const boundedSelectedContext = contextPackage.selectedContext
      .filter((entry) => entry.source !== "runtime/episode_memo"
        && entry.source !== "runtime/compiled-context")
      .map((entry) => {
        const excerpt = entry.excerpt?.trim();
        const boundedExcerpt = excerpt
          ? truncatePromptBlock(excerpt, 192, "\n[上下文摘录已截断]")
          : "";
        return { ...entry, ...(boundedExcerpt ? { excerpt: boundedExcerpt } : { excerpt: undefined }) };
      });
    const selectedContext = renderNarrativeSelectedContext(boundedSelectedContext, "zh")
      .replace(/^### /gm, "- ");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";
    // Prefer memo-based narrative block; fall back to legacy intent markdown
    const narrativeBlock = memo
      ? renderMemoAsNarrativeBlock(memo, intent, "zh")
      : episodeIntent
        ? buildNarrativeIntentBrief(episodeIntent, "zh")
        : "(无)";

    return `\n## 本集控制输入（由 Planner/Composer 编译）
${narrativeBlock}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }
}
