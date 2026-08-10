import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import { readBookRules as readAuthoritativeBookRules } from "./rules-reader.js";
import {
  EpisodeIntentSchema,
  type EpisodeIntent,
  type EpisodeMemo,
} from "../models/input-governance.js";
import {
  renderHookSnapshot,
  renderSummarySnapshot,
} from "../utils/memory-retrieval.js";
import {
  gatherPlanningMaterials,
  loadPlanningSeedMaterials,
} from "../utils/planning-materials.js";
import { parseMemo, PlannerParseError } from "../utils/episode-memo-parser.js";
import {
  normalizePlannedHookLedgerActions,
  validatePlannedHookLedger,
} from "../utils/hook-ledger-validator.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";
import {
  buildPlannerUserMessage,
  getPlannerMemoSystemPrompt,
} from "./planner-prompts.js";
import {
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  extractRelevantThreads,
  formatRecentSummaries,
  formatRecyclableHooks,
} from "./planner-context.js";
import type { StoredHook } from "../state/memory-db.js";
import {
  loadVolumeContracts,
  loadVolumeProgress,
  renderVolumeContractBrief,
  renderVolumeProgressBrief,
  saveVolumeContractArtifacts,
  selectVolumeContract,
} from "../utils/volume-contract.js";
import {
  attachEpisodePlanningMemory,
  getEpisodeContextContent,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

export interface PlanEpisodeInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly externalContext?: string;
  readonly episodeContextSnapshot?: EpisodeContextSnapshot;
  /** Pre-rendered upstream-revision feedback block (P0-2), consumed by the memo prompt. */
  readonly upstreamRevisionFeedbackBlock?: string;
}

export interface PlanEpisodeOutput {
  readonly intent: EpisodeIntent;
  readonly memo: EpisodeMemo;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
}

const MEMO_RETRY_LIMIT = 2;
const PLANNER_MAX_OUTPUT_TOKENS = 4096;

/**
 * Phase 3 planner.
 *
 * Produces:
 *   - a simplified EpisodeIntent (goal + outline + keep/avoid/style) —
 *     still deterministic, used for retrieval hints and the intent markdown.
 *   - a full EpisodeMemo (plain markdown sections) via LLM call + strict
 *     parser.
 *
 * Retry policy: up to 3 attempts. Each failed parse appends an error
 * feedback block to the user message and re-invokes the LLM. If all attempts
 * fail, the planner emits a degraded but valid memo with an explicit warning
 * instead of crashing the whole episode pipeline.
 */
export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planEpisode(input: PlanEpisodeInput): Promise<PlanEpisodeOutput> {
    if (!input.episodeContextSnapshot) {
      throw new Error("EPISODE_CONTEXT_REQUIRED: planner requires the operation EpisodeContextSnapshot.");
    }
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const seedMaterials = await loadPlanningSeedMaterials({
      bookDir: input.bookDir,
      episodeNumber: input.episodeNumber,
      episodeContextSnapshot: input.episodeContextSnapshot,
    });
    const outlineNode = this.findOutlineNode(seedMaterials.volumeOutline, input.episodeNumber);
    const goal = this.deriveGoal(
      input.externalContext,
      seedMaterials.currentFocus,
      seedMaterials.authorIntent,
      outlineNode,
      input.episodeNumber,
    );
    // Phase hotfix 5: read structured rules through the Phase 5 authoritative
    // loader. It prefers outline/story_frame.md frontmatter, falls back to
    // legacy book_rules.md, and refuses to silently zero out rules when the
    // legacy file is just a compat shim. Reading raw bookRulesRaw via
    // parseBookRules() bypassed all of that.
    const parsedRules = await readAuthoritativeBookRules(input.bookDir);
    const prohibitions = parsedRules?.rules.prohibitions ?? [];
    const mustKeep = this.collectMustKeep(seedMaterials.currentState, seedMaterials.storyBible);
    const mustAvoid = this.collectMustAvoid(seedMaterials.currentFocus, prohibitions);
    const styleEmphasis = this.collectStyleEmphasis(seedMaterials.authorIntent, seedMaterials.currentFocus);
    const materials = await gatherPlanningMaterials({
      bookDir: input.bookDir,
      episodeNumber: input.episodeNumber,
      goal,
      outlineNode,
      mustKeep,
      seed: seedMaterials,
      episodeContextSnapshot: input.episodeContextSnapshot,
    });
    const memorySelection = materials.memorySelection;
    attachEpisodePlanningMemory(input.episodeContextSnapshot, memorySelection);
    const volumeContractFile = await loadVolumeContracts(input.bookDir, {
      episodeNumber: input.episodeNumber,
    });
    const volumeContract = selectVolumeContract(volumeContractFile.contracts, input.episodeNumber);
    const volumeProgress = volumeContract ? await loadVolumeProgress(input.bookDir) : null;
    await saveVolumeContractArtifacts(input.bookDir, volumeContractFile);
    const activeHookCount = memorySelection.activeHooks.filter(
      (hook) => hook.status !== "resolved" && hook.status !== "deferred",
    ).length;

    const arcContext = this.buildArcContext(
      input.book.language,
      seedMaterials.volumeOutline,
      outlineNode,
    );

    const intent = EpisodeIntentSchema.parse({
      episode: input.episodeNumber,
      goal,
      outlineNode,
      arcContext,
      mustKeep,
      mustAvoid,
      styleEmphasis,
    });

    const isGoldenOpening = this.isGoldenOpeningEpisode(input.book.language, input.episodeNumber);
    const memo = await this.planEpisodeMemo({
      storyDir,
      bookDir: input.bookDir,
      episodeNumber: input.episodeNumber,
      isGoldenOpening,
      fallbackGoal: goal,
      episodeSummariesRaw: seedMaterials.episodeSummariesRaw,
      previousEndingExcerpt: seedMaterials.previousEndingExcerpt,
      brief: seedMaterials.brief,
      episodeContext: input.externalContext,
      recyclableHooks: memorySelection.recyclableHooks,
      volumeContractBrief: volumeContract
        ? [
            renderVolumeContractBrief(volumeContract, volumeProgress!),
            "",
            renderVolumeProgressBrief(volumeProgress!, volumeContract, {
              beforeEpisode: input.episodeNumber,
              windowSize: 5,
            }),
          ].join("\n")
        : "",
      // Phase hotfix 4: thread book language through so the planner uses
      // English prompts (system + user template + golden opening guidance)
      // for English books instead of always-Chinese.
      language: input.book.language ?? "zh",
      episodeContextSnapshot: input.episodeContextSnapshot,
      upstreamRevisionFeedbackBlock: input.upstreamRevisionFeedbackBlock,
    });

    // memo.goal is LLM-produced and specific (<=50 chars, validated).
    // Overwrite intent.goal so downstream composer/retrieval gets the
    // concrete task statement instead of the outline-derived fallback.
    intent.goal = memo.goal;

    const runtimePath = join(runtimeDir, `episode-${String(input.episodeNumber).padStart(4, "0")}.intent.md`);
    const currentArcPath = join(runtimeDir, "tier2_current_arc.md");
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      memo,
      input.book.language ?? "zh",
      renderHookSnapshot(memorySelection.hooks, input.book.language ?? "zh"),
      renderSummarySnapshot(memorySelection.summaries, input.book.language ?? "zh"),
      activeHookCount,
    );
    await writeFile(runtimePath, intentMarkdown, "utf-8");
    if (input.book.format === "screenplay") {
      await writeFile(
        join(runtimeDir, `episode-${String(input.episodeNumber).padStart(4, "0")}.intent.md`),
        intentMarkdown,
        "utf-8",
      );
    }

    return {
      intent,
      memo,
      intentMarkdown,
      plannerInputs: volumeContract
        ? [
            ...materials.plannerInputs,
            currentArcPath,
            join(storyDir, "runtime", "volume-contracts.json"),
            join(storyDir, "runtime", `${volumeContract.volumeId}.contract.json`),
            join(storyDir, "runtime", "volume-progress.json"),
          ]
        : [...materials.plannerInputs, currentArcPath],
      runtimePath,
    };
  }

  /**
   * Invoke the LLM to produce a episode memo contract and parse it. Retries up to
   * 3 times on parse failure, injecting the error message back into the user
   * prompt so the LLM can correct itself.
   */
  async planEpisodeMemo(input: {
    readonly storyDir: string;
    readonly bookDir: string;
    readonly episodeNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly episodeSummariesRaw: string;
    readonly previousEndingExcerpt?: string;
    readonly brief?: string;
    readonly episodeContext?: string;
    readonly recyclableHooks?: ReadonlyArray<StoredHook>;
    readonly volumeContractBrief?: string;
    readonly language?: "zh" | "en";
    readonly episodeContextSnapshot: EpisodeContextSnapshot;
    readonly upstreamRevisionFeedbackBlock?: string;
  }): Promise<EpisodeMemo> {
    const characterMatrix = getEpisodeContextContent(input.episodeContextSnapshot, "story/character_context.md");
    const subplotBoard = getEpisodeContextContent(input.episodeContextSnapshot, "story/subplot_board.md");
    const emotionalArcs = getEpisodeContextContent(input.episodeContextSnapshot, "story/emotional_arcs.md");
    const pendingHooks = getEpisodeContextContent(input.episodeContextSnapshot, "story/pending_hooks.md");
    const bookRulesRaw = getEpisodeContextContent(input.episodeContextSnapshot, "story/book_rules.md");

    const language = input.language ?? "zh";
    const noPriorEpisode = language === "en"
      ? "(this is the opening episode — no prior episode)"
      : "（本集为起始集，无前集）";
    const noBookRules = language === "en"
      ? "(no book_rules entries)"
      : "（暂无 book_rules 条目）";
    const retryFeedbackHeader = language === "en"
      ? "## Error from previous output"
      : "## 上次输出的错误";
    const retryFeedbackTrailer = language === "en"
      ? "Fix and re-emit."
      : "请修正后重新输出。";

    const currentArcProse = composeCurrentArcProse(subplotBoard, emotionalArcs, input.episodeNumber);
    await this.saveCurrentArcRuntimeArtifact(input.storyDir, input.episodeNumber, currentArcProse);

    const userMessage = buildPlannerUserMessage({
      episodeNumber: input.episodeNumber,
      previousEpisodeEndingExcerpt: input.previousEndingExcerpt?.trim()
        ? input.previousEndingExcerpt.trim()
        : noPriorEpisode,
      recentSummaries: formatRecentSummaries(input.episodeSummariesRaw, input.episodeNumber, 3),
      currentArcProse,
      protagonistMatrixRow: extractProtagonistRow(characterMatrix),
      opponentRows: extractOpponentRows(characterMatrix, 3),
      collaboratorRows: extractCollaboratorRows(characterMatrix, 3),
      relevantThreads: extractRelevantThreads(pendingHooks, subplotBoard, input.episodeNumber),
      recyclableHooks: formatRecyclableHooks(
        input.recyclableHooks ?? [],
        input.episodeNumber,
        language,
      ),
      isGoldenOpening: input.isGoldenOpening,
      bookRulesRelevant: bookRulesRaw.trim().length > 0 ? bookRulesRaw.trim() : noBookRules,
      brief: input.brief ?? "",
      episodeContext: input.episodeContext ?? "",
      volumeContract: input.volumeContractBrief ?? "",
      upstreamRevisionFeedback: input.upstreamRevisionFeedbackBlock ?? "",
      language,
    });

    const systemPrompt = getPlannerMemoSystemPrompt(language);
    const existingHooks = parsePendingHooksMarkdown(pendingHooks);

    let currentUserMessage = userMessage;
    let lastError: PlannerParseError | undefined;

    for (let attempt = 0; attempt < MEMO_RETRY_LIMIT; attempt += 1) {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: currentUserMessage },
        ],
        { temperature: 0.7, stream: false, callPhase: "plan", maxTokens: PLANNER_MAX_OUTPUT_TOKENS },
      );

      try {
        const parsedMemo = parseMemo(response.content, input.episodeNumber, input.isGoldenOpening);
        // Models sometimes put one durable hook under both advance and resolve.
        // Canonicalize the memo before compiling its execution contract so a
        // recoverable formatting conflict does not consume a paid retry.
        const normalizedBody = normalizePlannedHookLedgerActions(parsedMemo.body, existingHooks);
        const memo = normalizedBody === parsedMemo.body
          ? parsedMemo
          : { ...parsedMemo, body: normalizedBody };
        const hookLedgerIssues = validatePlannedHookLedger(
          memo.body,
          existingHooks,
        );
        if (hookLedgerIssues.length > 0) {
          throw new PlannerParseError(`invalid hook ledger: ${hookLedgerIssues.join("; ")}`);
        }
        return memo;
      } catch (error) {
        if (!(error instanceof PlannerParseError)) {
          throw error;
        }
        lastError = error;
        this.log?.warn(`[planner] memo parse failed (attempt ${attempt + 1}/${MEMO_RETRY_LIMIT}): ${error.message}`);
        this.emitDiagnostic({
          kind: "planner-parse-retry",
          severity: "warning",
          phase: "plan",
          episodeNumber: input.episodeNumber,
          attempt: attempt + 1,
          maxAttempts: MEMO_RETRY_LIMIT,
          message: error.message,
        });
        const hookIdHint = /hook ledger/i.test(error.message) && existingHooks.length > 0
          ? language === "en"
            ? `\nAllowed hook ids (copy exactly; do not shorten or reconstruct):\n${existingHooks.map((hook) => `- ${hook.hookId}`).join("\n")}\nExisting ids must use advance/resolve/defer; never put them under [new]. Write \"none\" for an empty action slot.`
            : `\n允许使用的伏笔 ID（必须原样复制，不要截断或重组）：\n${existingHooks.map((hook) => `- ${hook.hookId}`).join("\n")}\n已有 ID 必须放在 advance/resolve/defer，绝不能放进 [new]；空动作栏写“无”。`
          : "";
        currentUserMessage = `${userMessage}\n\n${retryFeedbackHeader}\n${error.message}${hookIdHint}\n${retryFeedbackTrailer}`;
      }
    }

    const fallbackError = lastError ?? new PlannerParseError("memo planner exhausted retries without a specific error");
    this.log?.warn(`[planner] memo planner fell back after ${MEMO_RETRY_LIMIT} attempts: ${fallbackError.message}`);
    this.emitDiagnostic({
      kind: "planner-fallback",
      severity: "warning",
      phase: "plan",
      episodeNumber: input.episodeNumber,
      attempt: MEMO_RETRY_LIMIT,
      maxAttempts: MEMO_RETRY_LIMIT,
      message: fallbackError.message,
    });
    return parseMemo(
      this.buildFallbackMemoMarkdown({
        episodeNumber: input.episodeNumber,
        isGoldenOpening: input.isGoldenOpening,
        fallbackGoal: input.fallbackGoal,
        errorMessage: fallbackError.message,
        language,
      }),
      input.episodeNumber,
      input.isGoldenOpening,
    );
  }

  private async saveCurrentArcRuntimeArtifact(
    storyDir: string,
    episodeNumber: number,
    currentArcProse: string,
  ): Promise<void> {
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      join(runtimeDir, "tier2_current_arc.md"),
      [
        "# Tier2 Current Arc",
        "",
        `- updated_for_episode: ${episodeNumber}`,
        "- source: subplot_board.md + emotional_arcs.md",
        "",
        currentArcProse,
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  private buildFallbackMemoMarkdown(input: {
    readonly episodeNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly errorMessage: string;
    readonly language: "zh" | "en";
  }): string {
    if (input.language === "en") {
      return [
        `# Episode ${input.episodeNumber} memo`,
        "",
        "## Episode goal",
        input.fallbackGoal || `Continue episode ${input.episodeNumber} according to the current outline`,
        "",
        "## Thread refs",
        "none",
        "",
        "## Volume KR binding",
        "Binding: none. Buffer/transition fallback memo; carry the volume KR to the next planned episode.",
        "",
        "## Current task",
        `Use the current episode goal and authoritative series context to continue episode ${input.episodeNumber} without inventing a new direction.`,
        "",
        "## Episode payoff",
        "Deliver one concrete local result supported by the current objective and established context.",
        "",
        "## Incoming state",
        "Carry the latest knowledge, power, relationship, physical and active-action facts into the opening.",
        "",
        "## Episode objective",
        "The protagonist must produce a visible change that directly advances the current goal now.",
        "",
        "## Opposition",
        "Use an established actor or constraint with its own goal and leverage; do not invent arbitrary resistance.",
        "",
        "## Causal escalation",
        "Because of an established fact, the protagonist chooses an action; opposition counters; the state changes and creates the next pressure.",
        "",
        "## Relationship pressure",
        "Apply pressure to an existing relationship through leverage, secrecy, obligation or conflicting interests.",
        "",
        "## Directional turn",
        "State the old course of action, the new course and the established fact that forces the turn.",
        "",
        "## Reversal setup",
        "Use an existing clue or choice to prepare the audience's initial interpretation.",
        "",
        "## Episode reversal",
        "Invalidate the initial plan or interpretation through the prepared action or evidence.",
        "",
        "## Reversal consequence",
        "Record what is lost and how power, relationship, information or safety changes.",
        "",
        "## Local dramatic result",
        "Land a success, failure or redirection and a concrete cost before starting the outgoing pressure.",
        "",
        "## Outgoing pressure",
        "Start a decision, danger or question that follows directly from the local result.",
        "",
        "## Handoff state",
        "State the exact knowledge, power, relationship, physical and active-action facts inherited by the next episode.",
        "",
        "## Information permissions",
        "Keep audience and character knowledge, suspicions, mistakes and unknown facts distinct.",
        "",
        "## Emotional hook",
        "End with a concrete emotional audience question after the local result has landed.",
        "",
        "## End state",
        "Finish with an irreversible information, relationship, power, physical or survival change.",
        "",
        "## Hook ledger for this episode",
        "open: none; advance: keep only active promises moving; resolve: settle only what has evidence; defer: preserve larger threads without manufacturing replacements.",
        "",
        "## Do not",
        "Do not contradict established facts, ignore the user's current instruction, or turn the fallback memo into a new outline.",
        "",
        "## Planner warning",
        `The model failed to produce a valid episode memo after ${MEMO_RETRY_LIMIT} attempts. Last parser error: ${input.errorMessage}`,
      ].join("\n");
    }

    return [
      `# 第 ${input.episodeNumber} 集 memo`,
      "",
      "## 本集目标",
      input.fallbackGoal || `按当前大纲继续推进第 ${input.episodeNumber} 集`,
      "",
      "## 关联线索",
      "无",
      "",
      "## 卷级 KR 绑定",
      "绑定：无。这是缓冲/过渡 fallback memo，卷级 KR 顺延到下一集推进。",
      "",
      "## 当前任务",
      `沿用当前单集目标和权威设定推进第 ${input.episodeNumber} 集，不临时改方向，也不把本集写成泛泛过渡。`,
      "",
      "## 本集爽点",
      "交付一个由当前目标和既有上下文支撑的具体局部结果。",
      "",
      "## 进入状态",
      "首场接住最近的知识、权力、关系、物理和未完成动作事实。",
      "",
      "## 当前目标",
      "主角必须现在完成一个直接推进当前目标的可见改变。",
      "",
      "## 反对力量",
      "使用已有角色或约束作为阻力，写清其目标和筹码，不临时制造随机阻碍。",
      "",
      "## 因果升级",
      "因为既有事实，主角作出选择；阻力方反制；状态改变并制造下一压力。",
      "",
      "## 关系压力",
      "通过筹码、秘密、义务或利益冲突施压一段已有关系。",
      "",
      "## 方向性转折",
      "写清旧行动方向、新行动方向，以及迫使人物转向的既有事实。",
      "",
      "## 反转铺垫",
      "使用已有线索或选择建立观众最初判断。",
      "",
      "## 本集反转",
      "由已铺垫的行动或证据使原计划或判断失效。",
      "",
      "## 反转后果",
      "写清谁失去什么，以及权力、关系、信息或安全怎样变化。",
      "",
      "## 当集兑现",
      "在启动出去压力前，落地一次成功、失败或转向及其具体代价。",
      "",
      "## 出去压力",
      "由本集结果直接启动一个决定、危险或问题。",
      "",
      "## 结尾交接状态",
      "写清下一集继承的知识、权力、关系、物理和未完成动作事实。",
      "",
      "## 信息权限",
      "区分观众和角色分别知道、怀疑、误信和未知的事实。",
      "",
      "## 情绪钩子",
      "在本集结果落地后留下一个具体的情绪追问。",
      "",
      "## 结尾状态",
      "以不可逆的信息、关系、权力、物理或生存变化结束。",
      "",
      "## 本集 Hook ledger",
      "open: 无；advance: 只推进当前活跃承诺；resolve: 只结清已有证据支撑的线索；defer: 保留大线，不为补数量制造替代 Hook。",
      "",
      "## 不要做",
      "不要违背既成事实，不要无视用户当前指令，不要把 fallback memo 当成新大纲重写整本书。",
      "",
      "## Planner warning",
      `模型连续 ${MEMO_RETRY_LIMIT} 次没有产出合格单集 memo。最后一次解析错误：${input.errorMessage}`,
    ].join("\n");
  }

  private isGoldenOpeningEpisode(language: string | undefined, episodeNumber: number): boolean {
    const isZh = (language ?? "zh").toLowerCase().startsWith("zh");
    return isZh ? episodeNumber <= 3 : episodeNumber <= 5;
  }

  private buildArcContext(
    language: string | undefined,
    volumeOutline: string,
    outlineNode: string | undefined,
  ): string | undefined {
    if (!outlineNode) return undefined;
    if (volumeOutline === "(文件尚未创建)") return undefined;
    return this.isChineseLanguage(language)
      ? `卷纲节点：${outlineNode}`
      : `Outline node: ${outlineNode}`;
  }

  private deriveGoal(
    externalContext: string | undefined,
    currentFocus: string,
    authorIntent: string,
    outlineNode: string | undefined,
    episodeNumber: number,
  ): string {
    const first = this.extractFirstDirective(externalContext);
    if (first) return first;
    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (localOverride) return localOverride;
    const outline = this.extractFirstDirective(outlineNode);
    if (outline) return outline;
    const focus = this.extractFocusGoal(currentFocus);
    if (focus) return focus;
    const author = this.extractFirstDirective(authorIntent);
    if (author) return author;
    return `Advance episode ${episodeNumber} with clear narrative focus.`;
  }

  private collectMustKeep(currentState: string, storyBible: string): string[] {
    return this.unique([
      ...this.extractListItems(currentState, 2),
      ...this.extractListItems(storyBible, 2),
    ]).slice(0, 4);
  }

  private collectMustAvoid(currentFocus: string, prohibitions: ReadonlyArray<string>): string[] {
    const avoidSection = this.extractSection(currentFocus, [
      "avoid",
      "must avoid",
      "禁止",
      "避免",
      "避雷",
    ]);
    const focusAvoids = avoidSection
      ? this.extractListItems(avoidSection, 10)
      : currentFocus
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith("-") &&
          /avoid|don't|do not|不要|别|禁止/i.test(line),
        )
        .map((line) => this.cleanListItem(line))
        .filter((line): line is string => Boolean(line));

    return this.unique([...focusAvoids, ...prohibitions]).slice(0, 6);
  }

  private collectStyleEmphasis(authorIntent: string, currentFocus: string): string[] {
    return this.unique([
      ...this.extractFocusStyleItems(currentFocus),
      ...this.extractListItems(authorIntent, 2),
    ]).slice(0, 4);
  }

  private extractFirstDirective(content?: string): string | undefined {
    if (!content) return undefined;
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line),
      );
  }

  private extractListItems(content: string, limit: number): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => this.cleanListItem(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  private extractFocusGoal(currentFocus: string): string | undefined {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    const directives = this.extractFocusStyleItems(focusSection, 3);
    if (directives.length === 0) {
      return this.extractFirstDirective(focusSection);
    }
    return directives.join(this.containsChinese(focusSection) ? "；" : "; ");
  }

  private extractLocalOverrideGoal(currentFocus: string): string | undefined {
    const overrideSection = this.extractSection(currentFocus, [
      "local override",
      "explicit override",
      "episode override",
      "local task override",
      "局部覆盖",
      "本章覆盖",
      "临时覆盖",
      "当前覆盖",
    ]);
    if (!overrideSection) {
      return undefined;
    }

    const directives = this.extractListItems(overrideSection, 3);
    if (directives.length > 0) {
      return directives.join(this.containsChinese(overrideSection) ? "；" : "; ");
    }

    return this.extractFirstDirective(overrideSection);
  }

  private extractFocusStyleItems(currentFocus: string, limit = 3): string[] {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    return this.extractListItems(focusSection, limit);
  }

  private renderHookBudget(activeCount: number, language: "zh" | "en"): string {
    const cap = 12;
    if (activeCount < 10) {
      return language === "en"
        ? `### Hook Budget\n- ${activeCount} active hooks (capacity: ${cap})`
        : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔（容量：${cap}）`;
    }
    const remaining = Math.max(0, cap - activeCount);
    return language === "en"
      ? `### Hook Budget\n- ${activeCount} active hooks — approaching capacity (${cap}). Only ${remaining} new hook(s) allowed. Prioritize resolving existing debt over opening new threads.`
      : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔——接近容量上限（${cap}）。仅剩 ${remaining} 个新坑位。优先回收旧债，不要轻易开新线。`;
  }

  private extractSection(content: string, headings: ReadonlyArray<string>): string | undefined {
    const targets = headings.map((heading) => this.normalizeHeading(heading));
    const lines = content.split("\n");
    let buffer: string[] | null = null;
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s*(.+?)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const heading = this.normalizeHeading(headingMatch[2]!);

        if (buffer && level <= sectionLevel) {
          break;
        }

        if (targets.includes(heading)) {
          buffer = [];
          sectionLevel = level;
          continue;
        }
      }

      if (buffer) {
        buffer.push(line);
      }
    }

    const section = buffer?.join("\n").trim();
    return section && section.length > 0 ? section : undefined;
  }

  private normalizeHeading(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[*_`:#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanListItem(line: string): string | undefined {
    const cleaned = line.replace(/^-\s*/, "").trim();
    if (cleaned.length === 0) return undefined;
    if (/^[-|]+$/.test(cleaned)) return undefined;
    if (this.isTemplatePlaceholder(cleaned)) return undefined;
    return cleaned;
  }

  private isTemplatePlaceholder(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    return (
      /^\((describe|briefly describe|write)\b[\s\S]*\)$/i.test(normalized)
      || /^（(?:在这里描述|描述|填写|写下)[\s\S]*）$/u.test(normalized)
    );
  }

  private containsChinese(content: string): boolean {
    return /[\u4e00-\u9fff]/.test(content);
  }

  private findOutlineNode(volumeOutline: string, episodeNumber: number): string | undefined {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchExactOutlineLine(line, episodeNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[1]);
      if (inlineContent) {
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchRangeOutlineLine(line, episodeNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[3]);
      if (inlineContent) {
        return inlineContent;
      }

      const rangeStart = Number(match[1]);
      const sectionContent = this.extractSectionAroundRange(lines, index);
      if (sectionContent) {
        const beatIndex = episodeNumber - rangeStart;
        const specificBeat = this.extractNumberedBeat(sectionContent, beatIndex);
        return specificBeat ?? sectionContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!this.isOutlineAnchorLine(line)) continue;

      const exactMatch = this.matchAnyExactOutlineLine(line);
      if (exactMatch) {
        const inlineContent = this.cleanOutlineContent(exactMatch[1]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const rangeMatch = this.matchAnyRangeOutlineLine(line);
      if (rangeMatch) {
        const inlineContent = this.cleanOutlineContent(rangeMatch[3]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }

      break;
    }

    return this.extractFirstOutlineDirective(volumeOutline);
  }

  private extractFirstOutlineDirective(content: string): string | undefined {
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line)
        && !this.isOutlineMetadata(line),
      );
  }

  private isOutlineMetadata(line: string): boolean {
    return /^(?:本书|全书).{0,16}(?:共|分为).{0,8}[一二三四五六七八九十百\d]+卷|^(?:this\s+)?(?:book|novel).{0,24}\bvolumes?\b/i.test(line);
  }

  private cleanOutlineContent(content?: string): string | undefined {
    const cleaned = content?.trim();
    if (!cleaned) return undefined;
    if (/^[*_`~:：-]+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  private extractSectionAroundRange(lines: ReadonlyArray<string>, rangeLineIndex: number): string | undefined {
    let headingIndex = -1;
    for (let i = rangeLineIndex - 1; i >= 0; i--) {
      if (lines[i]!.startsWith("#")) {
        headingIndex = i;
        break;
      }
      if (this.matchAnyRangeOutlineLine(lines[i]!) || this.matchAnyExactOutlineLine(lines[i]!)) {
        break;
      }
    }

    if (headingIndex < 0) {
      return undefined;
    }

    const headingLine = lines[headingIndex]!;
    const headingLevel = headingLine.match(/^(#+)/)?.[1]?.length ?? 3;

    const sectionLines: string[] = [];
    for (let i = headingIndex; i < lines.length; i++) {
      if (i > headingIndex) {
        const nextHeadingMatch = lines[i]!.match(/^(#+)/);
        if (nextHeadingMatch && (nextHeadingMatch[1]?.length ?? 0) <= headingLevel) {
          break;
        }
      }
      sectionLines.push(lines[i]!);
    }

    const content = sectionLines.join("\n").trim();
    return content.length > 0 ? content : undefined;
  }

  private extractNumberedBeat(section: string, beatIndex: number): string | undefined {
    if (beatIndex < 0) return undefined;

    const beats: string[] = [];
    for (const line of section.split("\n")) {
      const trimmed = line.trim();
      if (/^\d+[.)]\s/.test(trimmed)) {
        beats.push(trimmed.replace(/^\d+[.)]\s*/, ""));
      }
    }

    if (beats.length === 0 || beatIndex >= beats.length) return undefined;
    return beats[beatIndex];
  }

  private findNextOutlineContent(lines: ReadonlyArray<string>, startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) {
        continue;
      }

      if (this.isOutlineAnchorLine(line)) {
        return undefined;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const cleaned = this.cleanOutlineContent(line);
      if (cleaned) {
        return cleaned;
      }
    }

    return undefined;
  }

  private matchExactOutlineLine(line: string, episodeNumber: number): RegExpMatchArray | undefined {
    const patterns = [
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Episode\\s*${episodeNumber}(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`, "i"),
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${episodeNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`),
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchAnyExactOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Episode\s*\d+(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*\d+\s*章(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchRangeOutlineLine(line: string, episodeNumber: number): RegExpMatchArray | undefined {
    const match = this.matchAnyRangeOutlineLine(line);
    if (!match) return undefined;
    if (this.isEpisodeWithinRange(match[1], match[2], episodeNumber)) {
      return match;
    }

    return undefined;
  }

  private matchAnyRangeOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Episode\s*(\d+)\s*[-~–—]\s*(\d+)\b(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:[-*]\s+)?(?:\*\*)?章节范围(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\s*章\s*(.*)$/,
      /^(?:[-*]\s+)?(?:\*\*)?Episode\s*[Rr]ange(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\b\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private isOutlineAnchorLine(line: string): boolean {
    return this.matchAnyExactOutlineLine(line) !== undefined
      || this.matchAnyRangeOutlineLine(line) !== undefined;
  }

  private isEpisodeWithinRange(startText: string | undefined, endText: string | undefined, episodeNumber: number): boolean {
    const start = Number.parseInt(startText ?? "", 10);
    const end = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    return episodeNumber >= lower && episodeNumber <= upper;
  }

  private renderIntentMarkdown(
    intent: EpisodeIntent,
    memo: EpisodeMemo,
    language: "zh" | "en",
    pendingHooks: string,
    episodeSummaries: string,
    activeHookCount: number,
  ): string {
    const mustKeep = intent.mustKeep.length > 0
      ? intent.mustKeep.map((item) => `- ${item}`).join("\n")
      : "- none";

    const mustAvoid = intent.mustAvoid.length > 0
      ? intent.mustAvoid.map((item) => `- ${item}`).join("\n")
      : "- none";

    const styleEmphasis = intent.styleEmphasis.length > 0
      ? intent.styleEmphasis.map((item) => `- ${item}`).join("\n")
      : "- none";

    const memoBody = memo.body.trim();
    const threadRefsLine = memo.threadRefs.length > 0
      ? memo.threadRefs.map((id) => `- ${id}`).join("\n")
      : "- (none)";
    const volumeKrRefs = memo.volumeKrRefs ?? [];
    const volumeKrRefsLine = volumeKrRefs.length > 0
      ? volumeKrRefs.map((id) => `- ${id}`).join("\n")
      : "- (none)";

    return [
      "# Episode Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Outline Node",
      intent.outlineNode ?? "(not found)",
      "",
      "## Arc Context",
      intent.arcContext ?? "(none)",
      "",
      "## Episode Payoff",
      memo.payoff ?? intent.payoff ?? "(none)",
      "",
      "## Relationship Pressure",
      memo.relationshipPressure ?? intent.relationshipPressure ?? "(none)",
      "",
      "## Reversal Setup",
      memo.reversalSetup ?? intent.reversalSetup ?? "(none)",
      "",
      "## Episode Reversal",
      memo.reversalTurn ?? intent.reversalTurn ?? "(none)",
      "",
      "## Reversal Consequence",
      memo.reversalConsequence ?? intent.reversalConsequence ?? "(none)",
      "",
      "## Emotional Hook",
      memo.emotionalHook ?? intent.emotionalHook ?? "(none)",
      "",
      "## End State",
      memo.endState ?? intent.endState ?? "(none)",
      "",
      "## Must Keep",
      mustKeep,
      "",
      "## Must Avoid",
      mustAvoid,
      "",
      "## Style Emphasis",
      styleEmphasis,
      "",
      "## Episode Memo",
      `- isGoldenOpening: ${memo.isGoldenOpening ? "true" : "false"}`,
      "",
      "### Thread Refs",
      threadRefsLine,
      "",
      "### Volume KR Binding",
      volumeKrRefsLine,
      "",
      "### Volume KR Rationale",
      memo.volumeKrRationale ?? "(none)",
      "",
      "### Body",
      memoBody,
      "",
      this.renderHookBudget(activeHookCount, language),
      "",
      "## Pending Hooks Snapshot",
      pendingHooks,
      "",
      "## Episode Summaries Snapshot",
      episodeSummaries,
      "",
    ].join("\n");
  }

  private unique(values: ReadonlyArray<string>): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private isChineseLanguage(language: string | undefined): boolean {
    return (language ?? "zh").toLowerCase().startsWith("zh");
  }

}
