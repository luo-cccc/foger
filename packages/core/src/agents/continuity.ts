import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { EpisodeMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { filterHooks, filterSummaries, filterSubplots, filterEmotionalArcs, filterCharacterMatrix } from "../utils/context-filter.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { renderMemoAsNarrativeBlock } from "../utils/narrative-control.js";
import { estimateTextTokens } from "../llm/provider.js";
import { resolvePromptCompactionTarget, truncatePromptBlock } from "../utils/prompt-budget.js";
import { buildNarrativeDriveContract } from "./narrative-drive-contract.js";
import { EN_AI_TELL_WORDS } from "./post-write-validator.js";
import {
  getEpisodeContextContent,
  getEpisodeContextRecentEpisodes,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

interface AuditTokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

function mergeTokenUsage(
  first: AuditTokenUsage | undefined,
  second: AuditTokenUsage | undefined,
): AuditTokenUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    promptTokens: first.promptTokens + second.promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    totalTokens: first.totalTokens + second.totalTokens,
  };
}

export interface AuditResult {
  readonly passed: boolean;  readonly issues: ReadonlyArray<AuditIssue>;
  readonly summary: string;
  /** True when the auditor response itself was not parseable; callers must not auto-revise content from this result. */
  readonly parseFailed?: boolean;
  /** 0-100 overall quality score. Present when the auditor supports scoring. */
  readonly overallScore?: number;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface AuditIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
  readonly repairScope?: "local" | "structural" | "unknown";
  readonly ruleClass?:
    | "structural_invariant"
    | "reviewed_invariant"
    | "craft_default"
    | "taste_option";
  readonly evidenceRefs?: ReadonlyArray<string>;
}

type PromptLanguage = "zh" | "en";

function normalizeRepairScope(value: unknown): AuditIssue["repairScope"] {
  if (value === "local" || value === "structural" || value === "unknown") return value;
  return undefined;
}

function isSelfRefutingCriticalIssue(issue: AuditIssue): boolean {
  if (issue.severity !== "critical") return false;
  const conclusion = `${issue.description}\n${issue.suggestion}`;
  const tail = conclusion.slice(-180);
  if (/(?:无\s*critical\s*偏离|无关键偏离|未违反任何(?:禁止事项|硬性规则)|no\s+critical\s+(?:issue|deviation)|does\s+not\s+(?:violate|constitute\s+a\s+violation))/iu.test(tail)) {
    return true;
  }
  const saysCompliant = /(?:此条|当前短信|本集|该条)?\s*(?:合规|符合禁令|不构成违规|未违反)/iu.test(conclusion);
  const hasActionableViolation = /(?:未落地|未完全落地|不符合|违反|冲突|缺少|缺乏|未能|越过|越界|不足|fails?\s+to|does\s+not\s+fully|violat(?:e|es|ed)|conflict|missing|insufficient)/iu.test(conclusion);
  return saysCompliant && !hasActionableViolation;
}

const DIMENSION_LABELS: Record<number, { readonly zh: string; readonly en: string }> = {
  1: { zh: "OOC检查", en: "OOC Check" },
  2: { zh: "时间线检查", en: "Timeline Check" },
  3: { zh: "设定冲突", en: "Lore Conflict Check" },
  4: { zh: "战力崩坏", en: "Power Scaling Check" },
  5: { zh: "数值检查", en: "Numerical Consistency Check" },
  6: { zh: "伏笔检查", en: "Hook Check" },
  7: { zh: "节奏检查", en: "Pacing Check" },
  8: { zh: "文风检查", en: "Style Check" },
  9: { zh: "信息越界", en: "Information Boundary Check" },
  10: { zh: "词汇疲劳", en: "Lexical Fatigue Check" },
  11: { zh: "利益链断裂", en: "Incentive Chain Check" },
  12: { zh: "年代考据", en: "Era Accuracy Check" },
  13: { zh: "配角降智", en: "Side Character Competence Check" },
  14: { zh: "配角工具人化", en: "Side Character Instrumentalization Check" },
  15: { zh: "爽点虚化", en: "Payoff Dilution Check" },
  16: { zh: "台词失真", en: "Dialogue Authenticity Check" },
  17: { zh: "流水账", en: "Chronicle Drift Check" },
  18: { zh: "知识库污染", en: "Knowledge Base Pollution Check" },
  19: { zh: "视角一致性", en: "POV Consistency Check" },
  20: { zh: "段落等长", en: "Paragraph Uniformity Check" },
  21: { zh: "套话密度", en: "Cliche Density Check" },
  22: { zh: "公式化转折", en: "Formulaic Twist Check" },
  23: { zh: "列表式结构", en: "List-like Structure Check" },
  24: { zh: "支线停滞", en: "Subplot Stagnation Check" },
  25: { zh: "弧线平坦", en: "Arc Flatline Check" },
  26: { zh: "节奏单调", en: "Pacing Monotony Check" },
  27: { zh: "敏感词检查", en: "Sensitive Content Check" },
  28: { zh: "正传事件冲突", en: "Mainline Canon Event Conflict" },
  29: { zh: "未来信息泄露", en: "Future Knowledge Leak Check" },
  30: { zh: "世界规则跨书一致性", en: "Cross-Book World Rule Check" },
  31: { zh: "番外伏笔隔离", en: "Spinoff Hook Isolation Check" },
  32: { zh: "读者期待管理", en: "Reader Expectation Check" },
  33: { zh: "剧集备忘偏离", en: "Episode Memo Drift Check" },
  34: { zh: "角色还原度", en: "Character Fidelity Check" },
  35: { zh: "世界规则遵守", en: "World Rule Compliance Check" },
  36: { zh: "关系动态", en: "Relationship Dynamics Check" },
  37: { zh: "正典事件一致性", en: "Canon Event Consistency Check" },
};

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function resolveGenreLabel(genreId: string, profileName: string, language: PromptLanguage): string {
  if (language === "zh" || !containsChinese(profileName)) {
    return profileName;
  }

  if (genreId === "other") {
    return "general";
  }

  return genreId.replace(/[_-]+/g, " ");
}

function dimensionName(id: number, language: PromptLanguage): string | undefined {
  return DIMENSION_LABELS[id]?.[language];
}

function joinLocalized(items: ReadonlyArray<string>, language: PromptLanguage): string {
  return items.join(language === "en" ? ", " : "、");
}

function buildDimensionNote(
  id: number,
  language: PromptLanguage,
  gp: GenreProfile,
  bookRules: BookRules | null,
): string {
  const words = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
    ? bookRules.fatigueWordsOverride
    : gp.fatigueWords;

  if (id === 10 && words.length > 0) {
    return language === "en"
      ? `Fatigue words: ${words.join(", ")}. Also check universal AI-tell markers (${EN_AI_TELL_WORDS.join(", ")}); warn when any appears more than once per 3,000 words.`
      : `高疲劳词：${words.join("、")}。同时检查AI标记词（仿佛/不禁/宛如/竟然/忽然/猛地）密度，每3000字超过1次即warning`;
  }

  if (id === 15 && gp.satisfactionTypes.length > 0) {
    return language === "en"
      ? `Payoff types: ${gp.satisfactionTypes.join(", ")}`
      : `爽点类型：${gp.satisfactionTypes.join("、")}`;
  }

  if (id === 12 && bookRules?.eraConstraints) {
    const era = bookRules.eraConstraints;
    const parts = [era.period, era.region].filter(Boolean);
    if (parts.length > 0) {
      return language === "en"
        ? `Era: ${parts.join(", ")}`
        : `年代：${parts.join("，")}`;
    }
  }

  // v10: Enhanced dimension notes with writing methodology awareness
  if (id === 7) {
    return language === "en"
      ? "Check pacing rhythm: Do the recent 3-5 episodes form a complete mini-goal cycle (build-up -> escalation -> climax -> aftermath)? If 5+ consecutive episodes pass without a climax (payoff/reward/reversal), flag as pacing stagnation. If the previous episode was a climax/big reversal, does this episode show change (relationships shifted, status changed, costs paid)? If it jumps straight to new build-up without showing impact, flag as 'post-climax impact missing'. Daily/transition scenes must carry at least one task: plant a hook, advance a relationship, set up contrast, or prepare the next cycle."
      : "检查节奏波形：最近 3-5 集是否形成了完整的「蓄压→升级→爆发→后效」周期？如果连续 5 集没有爆发（兑现/回报/翻转），标记为节奏停滞。如果上一集是爆发/高潮/大反转，本集是否写出了改变？如果直接跳到新蓄压而没有展示前一波爆发的影响，标记为「高潮后影响缺失」。非冲突集中的日常/过渡/对话段落，是否至少承担了一项任务：埋伏笔、推关系、建立反差、准备下一轮蓄压。纯水日常标记为流水账风险。";
  }

  if (id === 15) {
    const base = gp.satisfactionTypes.length > 0
      ? (language === "en" ? `Payoff types: ${gp.satisfactionTypes.join(", ")}. ` : `爽点类型：${gp.satisfactionTypes.join("、")}。`)
      : "";
    return language === "en"
      ? `${base}Check desire engine: Has the episode created an emotional gap (reader wants release) OR delivered a payoff that exceeds expectations? A payoff that only satisfies 70% of built-up anticipation counts as diluted. If this episode is in the aftermath phase of a mini-goal cycle, verify that consequences are shown — not just emotional reactions, but concrete changes to status, relationships, or resources.`
      : `${base}检查欲望驱动：本集是否制造了情绪缺口（读者渴望释放）或完成了超出预期的兑现？只满足读者70%期待的兑现等于爽点虚化。如果本集处于小目标周期的后效阶段，检查是否展示了具体改变——不只是情绪反应，而是地位、关系或资源的实际变化。`;
  }

  if (id === 25) {
    return language === "en"
      ? "Cross-check character behavior against the 3-question test: (1) Why does the character do this? (2) Does it match their established profile? (3) Would a reader who only read prior episodes find it jarring? Also check if character's emotional state progresses or stagnates."
      : "人设三问检查：(1)角色为什么这么做？(2)符合之前建立的人设吗？(3)只看过前面剧集的读者会觉得突兀吗？同时检查角色情绪弧线是否在推进还是停滞。";
  }

  if (id === 16) {
    return language === "en"
      ? "Dialogue audit: for each important exchange, cite the surrounding action to identify the speaker's agenda (what they want the other to do), the strategy used, how the other party counters it, and which line changes information, power, relationship, or the next action. Subtext requires inferable cues the audience can point to. If the lines still work after swapping speakers, the voices have not separated. Never issue a vague 'dialogue feels unnatural' finding."
      : "对白审查：对每轮重要对白引用前后动作，识别说话者的议程（想让对方做什么）、所用策略、对方如何反制，以及哪句话改变了信息、权力、关系或下一动作。潜台词必须能指出观众可推断的线索。交换说话者后台词仍成立，说明人物声音没有立住。禁止给“台词不自然/不够好”这种空泛结论。";
  }

  if (id === 21) {
    return language === "en"
      ? "Anti-template diagnosis (mechanisms, not keywords): causal repetition (every round relies on strangers delivering answers, coincidence rescues, or opponents confessing), strategy repetition (all characters use the same question-denial-volume escalation), expression repetition or over-neatness (the same micro-behavior after every line), plus over-explanation, over-closure, even information density, and same-episode cost settlement (all costs introduced this episode are fully paid by its end, so nothing accumulates). A repetition finding must cite at least two locations and state the audience or production loss. Deliberate ritual, running gags, genre convention, trauma repetition and creator choices are non-blocking."
      : "去模板诊断（定位机制，不用关键词清单）：因果重复（每轮都靠陌生人带答案、巧合救场、对手自曝）、策略重复（所有人物都用同一套质问—否认—提高音量）、表达重复或过度工整（每句后都配同构微表情），以及过度解释、过度收口、信息密度均匀、代价即时结清（本集造成的代价全部在本集还完，什么都不积累）。发重复 finding 必须引用至少两个位置并说明观众或制作损失；有意的仪式、喜剧梗、类型惯例、创伤重复和创作者选择不阻断。";
  }

  switch (id) {
    case 6:
      // Phase 7 — hook-debt escalation. Reviewer now reads pending_hooks.md
      // not just for "is this hook undelivered" but for causal/temporal
      // debt escalation. The ledger's status column carries "过期 (距=…/半衰=…)"
      // and "受阻于 …" markers emitted by the stale/blocked detector; this
      // dimension tells the reviewer how to escalate them.
      return language === "en"
        ? `Hook-debt escalation (Phase 7 + hotfixes 2/3). Read the pending_hooks.md ledger and escalate based on the stale / blocked / core_hook / depends_on / promoted columns, NOT only on "undelivered hook present":

• Critical severity only applies to hooks with promoted=true in the ledger. A stale/blocked non-promoted hook stays at info — the promotion flag is the gate that keeps reviewer noise down, because architect-seed emits many non-load-bearing seeds.
• A promoted core_hook=true hook that has been stale for over 10 episodes → escalate from warning to critical. The book has only 3-7 core hooks; letting one drift that long is the lead symptom of narrative rot.
• A promoted hook whose status cell contains "blocked on X (blocked Y episodes)" with Y >= 6 → warning. The literal "blocked Y episodes" token comes straight from the ledger — read it, don't guess. Call out the upstream hook id so the planner can route the resolution.
• At volume end (final episode of any volume per volume_map) a promoted core_hook that is still open or stale without explicit "carried over to volume N+1" planning → critical.
• Any non-promoted stale hook → info-level log; do not fail the episode on it, but note it so the planner can schedule cleanup.

Quote the exact hook_id in description and include the stale / blocked marker text verbatim. Structure check only — do not judge hook prose quality.`
        : `Phase 7 hook-debt 升级规则（含 hotfix 2/3）。阅读 pending_hooks.md 伏笔池时不要只看"有没有悬而未决的伏笔"，要读状态列中的 stale / blocked 标记、core_hook 列、depends_on 列、以及升级列：

• critical 级别仅适用于升级=是（promoted=true）的伏笔。非升级的 stale/blocked 伏笔一律保持 info——升级标志是降噪的开关，因为架构师阶段会产出大量非承重的伏笔种子。
• 升级=是且 core_hook=是 的伏笔过期超过 10 集未回收 → warning 升级为 critical。全书只有 3-7 条核心伏笔，任何一条漂移这么久都是烂尾前兆。
• 升级=是的受阻伏笔，状态列中"受阻于 X (已阻 Y 章)"且 Y ≥ 6 → warning。"已阻 Y 章"这个字面 token 直接读自账本，不要猜。描述中要写出具体的上游 hook_id，让 planner 能安排落地路径。
• 卷尾（volume_map 中任一卷的末集）仍有升级=是的主线伏笔处于 open 或 stale 且没有显式"延至下一卷"规划 → critical。
• 升级=否的 stale 伏笔 → info 级记录，不判本集失败，但保留以便 planner 安排清理。

description 中要明确引用 hook_id，并把状态列中 stale / blocked 的原文标记字面抄进去。本维度只审结构，不评价伏笔文笔。`;
    case 19:
      return language === "en"
        ? "Check whether POV shifts are signaled clearly and stay consistent with the configured viewpoint."
        : "检查视角切换是否有过渡、是否与设定视角一致";
    case 24:
      return language === "en"
        ? "Cross-check subplot_board and episode_summaries: flag any subplot that stays dormant long enough to feel abandoned, or a recent run where every subplot is only restated instead of genuinely moving."
        : "对照 subplot_board 和 episode_summaries：标记那些沉寂到接近被遗忘的支线，或近期连续只被重复提及、没有真实推进的支线。";
    case 25:
      return language === "en"
        ? "Cross-check emotional_arcs and episode_summaries: flag any major character whose emotional line holds one pressure shape across a run instead of taking new pressure, release, reversal, or reinterpretation. Distinguish unchanged circumstances from unchanged inner movement."
        : "对照 emotional_arcs 和 episode_summaries：标记主要角色在一段时间内始终停留在同一种情绪压力形态、没有新压力、释放、转折或重估的情况。注意区分'处境未变'和'内心未变'。";
    case 26:
      return language === "en"
        ? "Cross-check episode_summaries for episode-type distribution: warn when the recent sequence stays in the same mode long enough to flatten rhythm, or when payoff / release beats disappear for too long. Explicitly list the recent type sequence."
        : "对照 episode_summaries 的剧集类型分布：当近期剧集长时间停留在同一种模式、把节奏压平，或回收/释放/高潮剧集缺席过久时给出 warning。请明确列出最近剧集的类型序列。";
    case 28:
      return language === "en"
        ? "Check whether spinoff events contradict the mainline canon constraints."
        : "检查番外事件是否与正典约束表矛盾";
    case 29:
      return language === "en"
        ? "Check whether characters reference information that should only be revealed after the divergence point (see the information-boundary table)."
        : "检查角色是否引用了分歧点之后才揭示的信息（参照信息边界表）";
    case 30:
      return language === "en"
        ? "Check whether the spinoff violates mainline world rules (power system, geography, factions)."
        : "检查番外是否违反正传世界规则（力量体系、地理、阵营）";
    case 31:
      return language === "en"
        ? "Check whether the spinoff resolves mainline hooks without authorization (warning level)."
        : "检查番外是否越权回收正传伏笔（warning级别）";
    case 32:
      return language === "en"
        ? "Check whether the ending renews curiosity, whether promised payoffs are landing on the cadence their hooks imply, whether pressure gets any release, and whether reader expectation gaps are accumulating faster than they are being satisfied. If a climax just occurred, check whether the aftermath episodes show concrete change before starting a new cycle."
        : "检查：集末是否重新点燃好奇心，已经承诺的回收是否按伏笔自身节奏落地，压力是否得到释放，读者期待缺口是在持续累积还是在被满足。如果刚经历高潮，检查后效剧集是否在开启新周期前展示了具体改变。";
    case 33:
      return language === "en"
        ? "Cross-check the supplied episode_memo against the finished prose. Audit only fields the memo actually populates: current task, payoff / held-back boundary, transitional function, key choices, required end change, hook actions, volume-KR movement, and prohibitions. For each populated commitment, identify visible prose evidence or report the missing/contradicted commitment as critical. For numeric caps such as 'at most 3 scenes', count actual scenes first: an arrow/list naming the 3 allowed scenes is not violation evidence, and a critical issue requires identifying a 4th or later scene. A sparse memo is legitimate. Do not invent plot decisions, expand the memo, or rewrite prose; report evidence gaps for Planner/Writer to repair."
        : "对照随集提供的 episode_memo 与成稿，只审 memo 实际填充的字段：当前任务、该兑现/暂不掀边界、过渡功能、关键抉择、集末改变、hook 动作、卷级 KR 推进和不要做。每个已填承诺都要能指到正文中的可见证据；缺失或写反则标记 critical。遇到“场景最多3个/不要超过3个场景”之类数量上限时，必须先统计实际场景：箭头或清单列出的3个允许场景不是违禁证据，只有明确指出第4个及以后新增场景时才可判 critical。稀疏 memo 合法。Auditor 不发明剧情、不扩写 memo、不重写正文，只报告需要 Planner/Writer 修复的证据缺口。";
    default:
      return "";
  }
}

function buildDimensionList(
  gp: GenreProfile,
  bookRules: BookRules | null,
  language: PromptLanguage,
  hasParentCanon = false,
): ReadonlyArray<{ readonly id: number; readonly name: string; readonly note: string }> {
  const activeIds = new Set(gp.auditDimensions);

  // Add book-level additional dimensions (supports both numeric IDs and name strings)
  if (bookRules?.additionalAuditDimensions) {
    // Build reverse lookup: name → id
    const nameToId = new Map<string, number>();
    for (const [id, labels] of Object.entries(DIMENSION_LABELS)) {
      nameToId.set(labels.zh, Number(id));
      nameToId.set(labels.en, Number(id));
    }

    for (const d of bookRules.additionalAuditDimensions) {
      if (typeof d === "number") {
        activeIds.add(d);
      } else if (typeof d === "string") {
        // Try exact match first, then substring match
        const exactId = nameToId.get(d);
        if (exactId !== undefined) {
          activeIds.add(exactId);
        } else {
          // Fuzzy: find dimension whose name contains the string
          for (const [name, id] of nameToId) {
            if (name.includes(d) || d.includes(name)) {
              activeIds.add(id);
              break;
            }
          }
        }
      }
    }
  }

  // Always-active dimensions
  activeIds.add(32); // 读者期待管理 — universal
  activeIds.add(33); // 剧集备忘偏离 — universal (replaces legacy volume-outline drift)

  // Conditional overrides
  if (gp.eraResearch || bookRules?.eraConstraints?.enabled) {
    activeIds.add(12);
  }

  // Spinoff dimensions — activated when parent_canon.md exists
  if (hasParentCanon) {
    activeIds.add(28); // 正传事件冲突
    activeIds.add(29); // 未来信息泄露
    activeIds.add(30); // 世界规则跨书一致性
    activeIds.add(31); // 番外伏笔隔离
  }

  const dims: Array<{ id: number; name: string; note: string }> = [];

  for (const id of [...activeIds].sort((a, b) => a - b)) {
    const name = dimensionName(id, language);
    if (!name) continue;

    const note = buildDimensionNote(id, language, gp, bookRules);

    dims.push({ id, name, note });
  }

  return dims;
}

export class ContinuityAuditor extends BaseAgent {
  get name(): string {
    return "continuity-auditor";
  }

  async auditEpisode(
    bookDir: string,
    episodeContent: string,
    episodeNumber: number,
    genre?: string,
    options?: {
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
    },
  ): Promise<AuditResult> {
    const snapshot = options?.episodeContextSnapshot;
    if (!snapshot) {
      throw new Error("EPISODE_CONTEXT_REQUIRED: auditor requires the operation EpisodeContextSnapshot.");
    }
    const missing = "(文件不存在)";
    const diskCurrentState = getEpisodeContextContent(snapshot, "story/current_state.md", missing);
    const diskLedger = getEpisodeContextContent(snapshot, "story/particle_ledger.md", missing);
    const diskHooks = getEpisodeContextContent(snapshot, "story/pending_hooks.md", missing);
    const styleGuideRaw = getEpisodeContextContent(snapshot, "story/style_guide.md", missing);
    const subplotBoard = getEpisodeContextContent(snapshot, "story/subplot_board.md", missing);
    const emotionalArcs = getEpisodeContextContent(snapshot, "story/emotional_arcs.md", missing);
    const characterMatrix = getEpisodeContextContent(snapshot, "story/character_context.md", missing);
    const episodeSummaries = getEpisodeContextContent(snapshot, "story/episode_summaries.md", missing);
    const parentCanon = getEpisodeContextContent(snapshot, "story/parent_canon.md", missing);
    const volumeOutline = getEpisodeContextContent(snapshot, "story/outline/volume_map.md", missing);
    let currentState = options?.truthFileOverrides?.currentState ?? diskCurrentState;
    const ledger = options?.truthFileOverrides?.ledger ?? diskLedger;
    const hooks = options?.truthFileOverrides?.hooks ?? diskHooks;

    const hasParentCanon = parentCanon !== "(文件不存在)";

    // Load the previous episode text for fine-grained continuity checking
    const previousEpisode = getEpisodeContextRecentEpisodes(snapshot).at(-1) ?? "";

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

    const resolvedLanguage = bookLanguage ?? gp.language;
    const isEnglish = resolvedLanguage === "en";
    const verificationIssues = options?.verificationIssues?.filter((issue) => issue.severity !== "info") ?? [];
    const verificationMode = verificationIssues.length > 0;
    // P0-4 (REV-09): the rewrite fallback carries no preservation guarantee,
    // so the regression checklist must compare against the pre-REVISION draft
    // for both paths; the intra-shot drift row only means something for the
    // deterministic patch path.
    const revisionKind = options?.revisionKind === "rewrite" ? "rewrite" : "patch";
    const dimensions = buildDimensionList(gp, bookRules, resolvedLanguage, hasParentCanon);
    const dimList = dimensions
      .map((d) => `${d.id}. ${d.name}${d.note ? (isEnglish ? ` (${d.note})` : `（${d.note}）`) : ""}`)
      .join("\n");
    const genreLabel = resolveGenreLabel(genreId, gp.name, resolvedLanguage);

    const protagonistBlock = bookRules?.protagonist
      ? isEnglish
        ? `\n\nProtagonist lock: ${bookRules.protagonist.name}; personality locks: ${joinLocalized(bookRules.protagonist.personalityLock, resolvedLanguage)}; behavioral constraints: ${joinLocalized(bookRules.protagonist.behavioralConstraints, resolvedLanguage)}.`
        : `\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}，行为约束：${bookRules.protagonist.behavioralConstraints.join("、")}`
      : "";

    const searchNote = gp.eraResearch
      ? isEnglish
        ? "\n\nFor real-world eras, people, events, geography, or policies, favor concrete period detail and internal consistency over vague modern assumptions."
        : "\n\n涉及真实年代、人物、事件、地理、政策时，优先用具体时代细节与内部一致性，避免套用模糊的现代假设。"
      : "";

    const verificationIntroEn = revisionKind === "rewrite"
      ? "A full structural audit already ran before a complete rewrite of the episode."
      : "A full structural audit already ran before a local patch.";
    const verificationChecklistHeaderEn = revisionKind === "rewrite"
      ? "## Rewrite regression checklist (check every row against the pre-rewrite draft)"
      : "## Rewrite regression checklist (check every row against the pre-patch draft)";
    const verificationDriftNoteEn = revisionKind === "rewrite"
      ? "This candidate came from a full rewrite: every scene, shot, and contract field unrelated to the supplied findings must survive verbatim — a rewrite is not a license to redraw unrelated content."
      : "Also compare against the findings the patch addressed: shots touched by the patch must not drift in fields unrelated to those findings.";
    const verificationIntroZh = revisionKind === "rewrite"
      ? "完整结构审计已经在整集改写前执行。"
      : "完整结构审计已经在局部补丁前执行。";
    const verificationChecklistHeaderZh = revisionKind === "rewrite"
      ? "## 改写回归检查表（逐项对照改写前草稿）"
      : "## 改写回归检查表（逐项对照补丁前草稿）";
    const verificationDriftNoteZh = revisionKind === "rewrite"
      ? "本次候选来自整集改写：与所列 finding 无关的场景、镜头和 contract 字段必须原样保留——改写不是顺手重写的借口。"
      : "同时对照本次补丁针对的 finding：被补丁触及的镜头，其未关联字段不得漂移。";
    const verificationCoverageRowEn = revisionKind === "rewrite"
      ? "1. Source coverage: scenes and shots of the pre-rewrite draft still exist — the rewrite must not silently drop content it was not asked to remove."
      : "1. Source coverage: scenes and shots of the pre-patch draft still exist — the patch must not silently drop content it was not asked to remove.";
    const verificationCoverageRowZh = revisionKind === "rewrite"
      ? "1. 原文覆盖：改写前草稿的计划场景与镜头仍然存在——改写不得静默删除它未被要求删除的内容。"
      : "1. 原文覆盖：补丁前草稿的计划场景与镜头仍然存在——补丁不得静默删除它未被要求删除的内容。";
    const verificationSystemPrompt = isEnglish
      ? `You are a strict revision verifier. ${verificationIntroEn}

Verify only that every supplied blocking issue is resolved and that the edited episode introduces no new critical contradiction with the current state, hooks, episode memo, rules, or previous episode. Do not reopen unrelated stylistic preferences or repeat resolved issues. Return unresolved prior issues and new critical regressions only.

${verificationChecklistHeaderEn}

For each row confirm "kept / lost / changed"; any unintended loss is a critical regression:
${verificationCoverageRowEn}
2. Shot purpose and hook placement: each shot still serves its original purpose and every Hook payoff beat still lands.
3. Duration budget: the total estimated duration still fits the target budget.
4. Assets and continuity: registered characters, props, locations and their states are unchanged unless a supplied issue required the change.
5. Dialogue verbatim content: lines not targeted by a supplied issue keep their original wording.
6. Memo constraints: every requirement stated in the episode memo is still delivered.

${verificationDriftNoteEn}

For every issue, set repair_scope to "local", "structural", or "unknown". Output JSON only:
{
  "passed": true/false,
  "overall_score": 0-100,
  "issues": [{ "severity": "critical|warning|info", "repair_scope": "local|structural|unknown", "category": "name", "description": "evidence", "suggestion": "fix" }],
  "summary": "one sentence"
}

Set passed=true and overall_score=100 when all supplied issues are resolved and there is no new critical regression. Set passed=false when any critical issue remains.`
      : `你是一位严格的修订复核员。${verificationIntroZh}

只验证两件事：列出的阻塞问题是否全部解决，以及修订后的正文是否与当前状态、伏笔、剧集备忘、规则或上一集产生新的 critical 矛盾。不要重开无关文风偏好，不要重复已经解决的问题。只报告未解决的原问题和新出现的 critical 回归。

${verificationChecklistHeaderZh}

逐项确认"保留/丢失/改变"，任何非预期丢失即 critical 回归：
${verificationCoverageRowZh}
2. 镜头目的与 Hook 落点：每个镜头仍服务于原本的目的，每个 Hook 兑现节拍仍然落地。
3. 时长预算：总预估时长仍符合目标预算。
4. 资产与连续性：已登记的人物、道具、场景及其状态保持不变，除非所列问题明确要求改动。
5. 对白逐字内容：未被所列问题针对的台词保持原文措辞。
6. memo 约束：剧集备忘的每项要求仍然兑现。

${verificationDriftNoteZh}

每条 issue 必须填写 repair_scope="local|structural|unknown"。只输出 JSON：
{
  "passed": true/false,
  "overall_score": 0-100,
  "issues": [{ "severity": "critical|warning|info", "repair_scope": "local|structural|unknown", "category": "名称", "description": "正文证据", "suggestion": "修复建议" }],
  "summary": "一句话"
}

全部原问题已解决且没有新 critical 回归时，passed=true、overall_score=100；仍有 critical 问题时 passed=false。`;
    const systemPromptBase = verificationMode
      ? verificationSystemPrompt
      : isEnglish
      ? `You are a strict ${genreLabel} episodic screenplay editor. Audit the episode for production clarity, continuity, dramatic movement, and structure. ALL OUTPUT MUST BE IN ENGLISH.${protagonistBlock}${searchNote}

## Reviewer Scope (hard constraints)

You audit completion and structure only. Your job is to decide whether the episode delivers the plan, keeps characters and timelines intact, and moves the book forward. Wording, sentence rhythm, paragraph shape, punctuation, imagery, and other prose-surface choices are NOT yours — those belong to the Polisher pass that runs after you. If you notice prose-surface issues, you may flag them with severity "info" so the Polisher can see them, but they do not count toward passed / overall_score and they must never be critical.

This is a short comic-drama screenplay with a per-episode target duration. Verify 1-3 scenes and an executable shot list whose count and total duration fit the episode's target budget (duration and shot-count budgets are enforced by deterministic gates — never file count-only findings), visible/audible action, a concrete familiar payoff, sustained relationship pressure, a causally prepared reversal with consequences, and an ending emotional question. Novel-style internal exposition or unshootable prose is critical.

Coincidence may create pressure but must not resolve the protagonist's core dilemma; a misunderstanding must produce an action and leave residue when it is cleared.

Dialogue voice spot-check (speaker-swap thought experiment): in a dialogue-dense scene, mentally swap two lines between speakers. If both lines still work unchanged after the swap, file a finding naming which difference is missing — goal, relationship, or knowledge. Differing catchphrases alone do not count as voice distinction. False-positive bounds: monologues, proclamations, and ritual exchanges are exempt from this test. These findings are reviewed_invariant craft guidance at warning severity — never critical.

Escalation evidence (for stagnant-episode concerns): before filing stagnation or thin escalation, check the state dimensions between adjacent beats — leverage, knowledge, relationship boundary, retreat options, irreversible decisions, threats made real. A stagnation finding must cite that NONE of these dimensions changed between the two beats it names; conversely, if one dimension did change in a citable way, do not file stagnation for that stretch. More intense wording without a state-dimension change is not escalation.

You audit twelve structural reader-pain patterns: dragging / flat openings, blurry worldbuilding disconnected from reality, contradictory character setup, tangled POV, mainline drift or stagnation, weak conflict with missing payoff, pacing loss of control and abrupt transitions, character inconsistency across the arc, thin/one-note characters without contrast, stiff emotion expression and abrupt relationship jumps, imbalanced cheats/power gifts, and settings that never land in concrete action. Alongside these, keep the engineering dimensions listed below (OOC, timeline coherence, information boundary, hook debt, cross-episode repetition, lexical fatigue, length band, title fatigue, paragraph shape).

Sparse episode_memo is legitimate. Breather / aftermath / transition episodes may ship a memo that only contains goal + a skeleton body — do NOT flag such memos as incomplete, and do NOT penalise the episode for lacking content against sections the memo itself does not populate. Judge drift only against what the memo actually says.

If the episode memo, rule stack, or supplied context specifies content proportions between lines (politics/romance, career/relationship, case/character, etc.), audit whether those lines appear as actual scenes, dialogue, action, or relationship movement. A line that is only summarized in one sentence counts as missing. Mark it critical only when the memo explicitly required it for this episode.

${buildNarrativeDriveContract("auditor", "en")}

For every issue, set repair_scope as a typed routing hint: "local" for wording, paragraph shape, small repetition, or narrow sentence-level fixes; "structural" for plot drift, timeline break, missing scene/payoff, character logic collapse, POV/knowledge boundary failure, or anything requiring a rewritten scene/episode; "unknown" only when you genuinely cannot decide.

Audit dimensions:
${dimList}

Output format MUST be JSON:
{
  "passed": true/false,
  "overall_score": 0-100,
  "issues": [
	    {
	      "severity": "critical|warning|info",
	      "repair_scope": "local|structural|unknown",
	      "category": "dimension name",
	      "description": "specific issue description",
	      "suggestion": "fix suggestion"
	    }
  ],
  "summary": "one-sentence audit conclusion"
}

## Finding quality requirements (apply to every issue)

- Every issue must cite a concrete evidence location: a scene ID, shot ID, contract field, or Hook id. Do not write an issue you cannot point at.
- description states which confirmed fact is violated at that location or what downstream loss it causes; suggestion states the outcome the revision must reach — never ghost-write replacement dialogue or prose inside a suggestion.
- Do not file an issue merely because the episode differs from an example or a numeric habit: word counts, shot counts, dialogue ratios and sentence lengths are not defects by themselves.
- A "template feel / AI taste" claim is only valid when it names the specific repeated device, the cliché that replaces concrete content, or the unearned pattern, and explains what it harms for the audience or production. "Feels AI-written" alone is not a finding.

Adequate finding: "The reversal in S2 overturns a belief the audience never formed — no setup beat lands in S1, so viewers read it as an author's rescue; writer must seed a recoverable evidence shot in S1." Inadequate finding: "pacing is bad", "too few shots", "AI flavor".

## Template-feel diagnostic rules (before filing "template feel / AI taste")

First classify the mechanism, then decide whether it is a finding at all:

1. Repeated device: the same resolution / dialogue / camera mechanism recurs (e.g. every reveal comes from the opponent confessing; every dialogue line is close-up + push). Valid only with at least two cited locations and the stated loss; a single use of a genre convention is not evidence.
2. Cliché replacing concrete content: abstract quality words ("premium", "cinematic", "exquisite") or generic emotion words stand in for producible facts (identity, material, state, scale). Name the missing concrete fact — do not ban a word.
3. Unearned text patterns: over-explaining (a meaning note after the action already showed the choice), over-closing (every scene sealed with a summary line), over-symmetry (every line paired with an isomorphic micro-gesture), costs settled instantly within the same episode. Cite at least two locations and state what audience inference space is flattened.

False positives — never file template feel on surface repetition alone: deliberate ritual repetition whose meaning flips when the holder changes; a comedy running gag that costs a new character each time; a fixed multi-episode opening structure that is accepted format; a trauma-driven repeated action where the work is depicting stagnation. When unsure whether repetition is a creator choice, file it as severity "info" with the question — do not escalate.

Template-feel findings default to severity "warning" and stay non-blocking craft guidance; only mark critical when the pattern directly breaks audience comprehension of the plot. Prose-surface items still follow the Reviewer Scope and remain "info".

passed is false ONLY when critical-severity issues exist.

overall_score calibration:
- 95-100: Publishable as-is, no noticeable issues
- 85-94: Minor blemishes but smooth reading, the reader won't break immersion
- 75-84: Noticeable problems but the story backbone holds, needs revision but not urgent
- 65-74: Multiple issues hurt the reading experience, pacing or continuity has gaps
- < 65: Structural breakdown, needs major rewrite
Score holistically — do not let a single minor issue tank the score.`
      : `你是一位严格的${gp.name}漫剧分镜结构审稿编辑。你审可制作性、连续性、戏剧推进和结构，不审小说文笔。${protagonistBlock}${searchNote}

## 审稿边界（硬约束）

你不审文笔、不审排版、不审句式——这些归 Polisher。你发现的文笔问题只能以 severity="info" 标注供 Polisher 参考，不计入 reviewer 的 passed/overall_score，也绝不可标为 critical。

这是一集有目标时长的漫剧分镜稿。必须检查 1-3 个场景、镜头数量与总时长符合本集目标预算（时长与镜头数预算由确定性门禁强制——不要只凭数量记 finding）、所有内容可见或可听、熟悉爽点得到兑现、人物关系持续受压、反转有前置证据和后果、结尾留下明确情绪问题。小说式心理散文或无法制作的抽象描写属于 critical。

巧合只能制造压力，不能替人物解决核心困境；误会必须产生行动，并在解除时留下残余。

对白声音抽查（交换说话者思想实验）：在高密度对白场景里，心里交换两句台词的说话者——交换后台词仍完全成立，记 finding 并说明缺的是目标差、关系差还是认知差；仅靠常用词差异不算声音区分。误报边界：独白、宣告、仪式性对话不适用此测试。此类 finding 属 reviewed_invariant 工艺建议，记 warning，绝不可标 critical。

升级证据要求（判停滞/升级不足前必查）：检查相邻两拍之间的状态维度——筹码、知识、关系边界、退路、不可撤回的决定、威胁变现实。停滞类 finding 必须引用"所指两拍之间以上维度无一发生可引用变化"；反之只要有一个维度发生了可引用变化，这段就不得判停滞。只有措辞更激烈而状态维度不变，不算升级。

你审 12 条结构类雷点：开篇拖沓/平淡、世界观模糊脱现实、人设矛盾、视角杂乱、主线偏离/停滞、冲突乏力爽点缺失、节奏失控过渡生硬、人设前后矛盾、人物单薄无反差、情感表达生硬/关系突兀、金手指失衡、设定无落地。同时保留工程维度（OOC、timeline 一致、信息越界、hook-debt、跨集重复、词汇疲劳、剧集字数、标题疲劳、段落形状）。

稀疏 memo 是合法状态。喘息集 / 后效集 / 过渡集的 memo 可以只有 goal + 骨架 body——此类 memo 不判 incomplete，也不能因为 memo 没写的段落就扣成稿的分。只按 memo 实际写出来的内容判偏离。

如果剧集备忘、规则栈或输入上下文明确指定多条剧情线的比例（权谋/感情、事业/恋爱、案件/人物等），要审它们是否真正落成了场景、对话、行动或关系变化。只用一句总结带过的线，视为缺失。只有当 memo 明确要求本集必须推进该线时，才标 critical。

${buildNarrativeDriveContract("auditor", "zh")}

每条 issue 必须给 repair_scope 作为 typed 路由提示："local" 表示措辞、段落形状、小重复、句段级小修；"structural" 表示主线偏离、时间线断裂、场面/回报缺失、人物逻辑崩、视角/信息边界失败，或任何需要重写场景/整集的问题；只有确实无法判断时才写 "unknown"。

审查维度：
${dimList}

输出格式必须为 JSON：
{
  "passed": true/false,
  "overall_score": 0-100,
  "issues": [
	    {
	      "severity": "critical|warning|info",
	      "repair_scope": "local|structural|unknown",
	      "category": "审查维度名称",
	      "description": "具体问题描述",
	      "suggestion": "修改建议"
	    }
  ],
  "summary": "一句话总结审查结论"
}

## Finding 质量要求（每条 issue 必须遵守）

- 每条 issue 必须引用具体证据位置：场景 ID、镜头 ID、contract 字段名或 Hook id；指不出位置的 issue 不要写。
- description 写"哪个位置违反了哪条已确认事实，或会造成什么下游损失"；suggestion 写"修订后必须达到的结果"——不要在 suggestion 里代写台词或正文。
- 不要因为"和示例不一样"或偏离某个数量习惯就报问题；字数、镜头数、台词比例、句式长短本身不是缺陷。
- 判"模板感/AI 味"时，必须定位到具体的重复手法、替代具体内容的套话或无铺垫的文句模式，并说明它伤害了观众理解或制作的哪一环；只写"AI 味重"的 issue 无效。

合格示例："S2 的反转推翻的判断在 S1 没有铺垫落点，观众会把它读成作者临时补救；由 writer 在 S1 补一个可被回收的证据镜头。"不合格示例："节奏不好""镜头太少""AI 味重"。

## 模板感诊断规范（判"模板感/AI 味"前必须过一遍）

先区分机制类别，再决定它是不是 finding：

1. 重复手法：同一解题/对话/运镜机制重复出现（如每轮揭示都靠对手自曝、每句台词都 close-up+推镜）。必须引用至少两处位置并说明损失才成立；单次使用类型惯例不算罪证。
2. 套话替代具体内容：抽象质量词（"高级""电影感""精致"）或泛化情绪词顶替了身份/材质/状态等可制作事实。指出缺的是哪个具体事实，而不是禁用某个词。
3. 无铺垫的文句模式：过度解释（动作已表达人物选择后又补一句意义说明）、过度收口（每场用总结句封死余波）、过度工整（每轮台词配同构微动作）、代价在本集内即时结清。引用至少两处位置，说明被抹平的观众推断空间。

误报反例——不得仅凭表面重复判模板：有意的仪式性重复（第二次因持有人改变而意义反转）；喜剧 running gag（每次让新人物付不同代价）；题材惯例的固定结构（多集相同片头）；人物因创伤反复做同一动作（作品正在表现停滞）。不确定是否为创作者选择时，记 severity="info" 并写明疑问，不要升级。

此类 finding 默认 severity="warning"，属不阻断的工艺建议；只有当该模式直接破坏观众对剧情的理解时才可标 critical。文笔表层问题仍按审稿边界只记 info。

只有当存在 critical 级别问题时，passed 才为 false。

overall_score 评分校准：
- 95-100：可直接发布，无明显问题
- 85-94：有小瑕疵但整体流畅可读，读者不会出戏
- 75-84：有明显问题但故事主干完整，需要修但不紧急
- 65-74：多处影响阅读体验的问题，节奏或连续性有断裂
- < 65：结构性问题，需要大幅重写
综合评分，不要因为单一小问题大幅拉低分数。`;
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.auditor");

    const ledgerBlock = gp.numericalSystem
      ? isEnglish
        ? `\n## Resource Ledger\n${ledger}`
        : `\n## 资源账本\n${ledger}`
      : "";

    // Smart context filtering for auditor — same logic as writer
    const bookRulesForFilter = parsedRules?.rules ?? null;
    const filteredSubplots = filterSubplots(subplotBoard);
    const filteredArcs = filterEmotionalArcs(emotionalArcs, episodeNumber);
    const filteredMatrix = filterCharacterMatrix(characterMatrix, volumeOutline, bookRulesForFilter?.protagonist?.name);
    const filteredSummaries = filterSummaries(episodeSummaries, episodeNumber);
    const filteredHooks = filterHooks(hooks);

    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;

    let hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? (filteredHooks !== "(文件不存在)"
        ? isEnglish
          ? `\n## Pending Hooks\n${filteredHooks}\n`
          : `\n## 伏笔池\n${filteredHooks}\n`
        : "");
    let subplotBlock = filteredSubplots !== "(文件不存在)"
      ? isEnglish
        ? `\n## Subplot Board\n${filteredSubplots}\n`
        : `\n## 支线进度板\n${filteredSubplots}\n`
      : "";
    let emotionalBlock = filteredArcs !== "(文件不存在)"
      ? isEnglish
        ? `\n## Emotional Arcs\n${filteredArcs}\n`
        : `\n## 情感弧线\n${filteredArcs}\n`
      : "";
    let matrixBlock = filteredMatrix !== "(文件不存在)"
      ? isEnglish
        ? `\n## Character Interaction Matrix\n${filteredMatrix}\n`
        : `\n## 角色交互矩阵\n${filteredMatrix}\n`
      : "";
    let summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (filteredSummaries !== "(文件不存在)"
        ? isEnglish
          ? `\n## Episode Summaries (for pacing checks)\n${filteredSummaries}\n`
          : `\n## 剧集摘要（用于节奏检查）\n${filteredSummaries}\n`
        : "");
    let volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    let canonBlock = hasParentCanon
      ? isEnglish
        ? `\n## Mainline Canon Reference (for spinoff audit)\n${parentCanon}\n`
        : `\n## 正传正典参照（番外审查专用）\n${parentCanon}\n`
      : "";

    const memoBlock = options?.episodeMemo
      ? `\n${renderMemoAsNarrativeBlock(options.episodeMemo, undefined, resolvedLanguage)}\n`
      : "";
    let reducedControlBlock = options?.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(
          options.episodeMemo ? "" : options.episodeIntent ?? "",
          options.contextPackage,
          options.ruleStack,
          resolvedLanguage,
        )
      : "";
    let styleGuideBlock = reducedControlBlock.length === 0
      ? isEnglish
        ? `\n## Style Guide\n${styleGuide}`
        : `\n## 文风指南\n${styleGuide}`
      : "";

    let prevEpisodeBlock = previousEpisode
      ? isEnglish
        ? `\n## Previous Episode Full Text (for transition checks)\n${previousEpisode}\n`
        : `\n## 上一集全文（用于衔接检查）\n${previousEpisode}\n`
      : "";

    if (verificationMode) {
      subplotBlock = "";
      emotionalBlock = "";
      matrixBlock = "";
      summariesBlock = "";
      volumeSummariesBlock = "";
      canonBlock = "";
      styleGuideBlock = "";
    }

    const verificationBlock = verificationMode
      ? isEnglish
        ? `\n## Blocking Issues From The Previous Audit\n${verificationIssues.map((issue) => `- [${issue.severity}] ${issue.category}: ${issue.description}\n  Required fix: ${issue.suggestion}`).join("\n")}\n`
        : `\n## 上次审计的阻塞问题\n${verificationIssues.map((issue) => `- [${issue.severity}] ${issue.category}：${issue.description}\n  必须修复：${issue.suggestion}`).join("\n")}\n`
      : "";

    const renderUserPrompt = (): string => isEnglish
      ? `Review episode ${episodeNumber}.

## Current State Card
${currentState}
${verificationBlock}${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${reducedControlBlock}${memoBlock}${prevEpisodeBlock}${styleGuideBlock}

## Episode Content Under Review
${episodeContent}`
      : `请审查第${episodeNumber}集漫剧分镜稿。

## 当前状态卡
${currentState}
${verificationBlock}${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${reducedControlBlock}${memoBlock}${prevEpisodeBlock}${styleGuideBlock}

## 待审剧集内容
${episodeContent}`;

    let userPrompt = renderUserPrompt();
    const promptTarget = resolvePromptCompactionTarget(this.ctx.maxPromptEstimatedTokens);
    if (promptTarget !== undefined) {
      const promptTokens = (): number => estimateTextTokens(systemPrompt) + estimateTextTokens(userPrompt);
      const rebuild = (): void => {
        userPrompt = renderUserPrompt();
      };
      const optionalBlocks: Array<() => void> = [
        () => { matrixBlock = ""; },
        () => { emotionalBlock = ""; },
        () => { subplotBlock = ""; },
        () => { volumeSummariesBlock = ""; },
        () => { summariesBlock = ""; },
        () => { styleGuideBlock = ""; },
        () => { prevEpisodeBlock = ""; },
        () => { canonBlock = ""; },
      ];

      for (const dropOptionalBlock of optionalBlocks) {
        if (promptTokens() <= promptTarget) break;
        dropOptionalBlock();
        rebuild();
      }

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
        assign(truncatePromptBlock(
          value,
          nextBudget,
          isEnglish ? "\n[Lower-priority audit context truncated.]" : "\n[低优先级审稿上下文已截断]",
        ));
        rebuild();
      };

      compactBlock(reducedControlBlock, 512, (next) => { reducedControlBlock = next; });
      compactBlock(hooksBlock, 256, (next) => { hooksBlock = next; });
      compactBlock(currentState, 512, (next) => { currentState = next; });
    }

    const chatMessages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const chatOptions = {
      temperature: options?.temperature ?? 0.3,
      stream: false,
      callPhase: "audit",
      maxTokens: 4096,
    };

    const response = await this.chat(chatMessages, chatOptions);

    let result = this.parseAuditResult(response.content, resolvedLanguage);
    let tokenUsage: AuditTokenUsage | undefined = response.usage;
    if (result.parseFailed) {
      // Model jitter (observed with smaller models such as deepseek flash
      // variants) occasionally returns non-JSON audit output. Retry once with
      // an explicit format reminder before surfacing a blocking critical.
      const reminder = resolvedLanguage === "en"
        ? "Your previous reply could not be parsed. Reply again with ONLY the JSON object described above — no prose, no code fences, no reasoning before or after it."
        : "你上一条回复无法解析。请只输出上面要求的 JSON 对象——不要任何解释文字、代码围栏或前后推理。";
      const retryResponse = await this.chat(
        [...chatMessages, { role: "user" as const, content: reminder }],
        chatOptions,
      );
      const retryResult = this.parseAuditResult(retryResponse.content, resolvedLanguage);
      tokenUsage = mergeTokenUsage(tokenUsage, retryResponse.usage);
      if (!retryResult.parseFailed) {
        result = retryResult;
      }
    }
    return tokenUsage ? { ...result, tokenUsage } : result;
  }

  private parseAuditResult(content: string, language: PromptLanguage): AuditResult {
    // Try multiple JSON extraction strategies (handles small/local models)

    // Strategy 1: Find balanced JSON object (not greedy)
    const balanced = this.extractBalancedJson(content);
    if (balanced) {
      const result = this.tryParseAuditJson(balanced, language);
      if (result) return result;
    }

    // Strategy 2: Try the whole content as JSON (some models output pure JSON)
    const trimmed = content.trim();
    if (trimmed.startsWith("{")) {
      const result = this.tryParseAuditJson(trimmed, language);
      if (result) return result;
    }

    // Strategy 3: Look for ```json code blocks
    const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      const result = this.tryParseAuditJson(codeBlockMatch[1]!.trim(), language);
      if (result) return result;
    }

    // Strategy 4: Try to extract individual fields via regex (last resort fallback)
    const passedMatch = content.match(/"passed"\s*:\s*(true|false)/);
    const issuesMatch = content.match(/"issues"\s*:\s*\[([\s\S]*?)\]/);
    const summaryMatch = content.match(/"summary"\s*:\s*"([^"]*)"/);
    if (passedMatch) {
      const issues: AuditIssue[] = [];
      if (issuesMatch) {
        // Try to parse individual issue objects
        const issuePattern = /\{[^{}]*"severity"\s*:\s*"[^"]*"[^{}]*\}/g;
        let match: RegExpExecArray | null;
        while ((match = issuePattern.exec(issuesMatch[1]!)) !== null) {
          try {
            const issue = JSON.parse(match[0]);
	            issues.push({
	              severity: issue.severity ?? "warning",
	              category: issue.category ?? (language === "en" ? "Uncategorized" : "未分类"),
	              description: issue.description ?? "",
	              suggestion: issue.suggestion ?? "",
	              repairScope: normalizeRepairScope(issue.repair_scope ?? issue.repairScope),
	            });
          } catch {
            // skip malformed individual issue
          }
        }
      }
      return {
        passed: passedMatch[1] === "true",
        issues,
        summary: summaryMatch?.[1] ?? "",
      };
    }

    return {
      passed: false,
      parseFailed: true,
      issues: [{
        severity: "critical",
        category: language === "en" ? "System Error" : "系统错误",
        description: language === "en"
          ? "Audit output format was invalid and could not be parsed as JSON."
          : "审稿输出格式异常，无法解析为 JSON",
        suggestion: language === "en"
          ? "The model may not support reliable structured output. Try a stronger model or inspect the API response format."
          : "可能是模型不支持结构化输出。尝试换一个更大的模型，或检查 API 返回格式。",
      }],
      summary: language === "en" ? "Audit output parsing failed" : "审稿输出解析失败",
    };
  }

  private buildReducedControlBlock(
    episodeIntent: string,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
    language: PromptLanguage,
  ): string {
    const selectedContext = contextPackage.selectedContext
      .filter((entry) =>
        entry.source !== "runtime/episode_memo"
        && entry.source !== "runtime/episode_claim_brief"
        && !hasDedicatedAuditorEvidenceBlock(entry.source)
      )
      .map((entry) => `- ${entry.source}: ${entry.reason}${entry.excerpt ? ` | ${entry.excerpt}` : ""}`)
      .join("\n");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";

    return language === "en"
      ? `\n## Episode Control Inputs (compiled by Planner/Composer)
${episodeIntent}

### Rule Stack
- Hard guardrails: ${ruleStack.sections.hard.join(", ") || "(none)"}
- Soft constraints: ${ruleStack.sections.soft.join(", ") || "(none)"}
- Diagnostic rules: ${ruleStack.sections.diagnostic.join(", ") || "(none)"}

### Active Overrides
${overrides}

### Selected Context
${selectedContext || "- none"}\n`
      : `\n## 本集控制输入（由 Planner/Composer 编译）
${episodeIntent}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}

### 已选上下文
${selectedContext || "- none"}\n`;
  }

  private extractBalancedJson(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  private tryParseAuditJson(json: string, language: PromptLanguage = "zh"): AuditResult | null {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed.passed !== "boolean" && parsed.passed !== undefined) return null;
      const rawScore = parsed.overall_score ?? parsed.overallScore;
      const overallScore = typeof rawScore === "number" && Number.isFinite(rawScore)
        ? Math.round(Math.max(0, Math.min(100, rawScore)))
        : undefined;
      return {
        passed: Boolean(parsed.passed ?? false),
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.map((i: Record<string, unknown>) => ({
              severity: (i.severity as string) ?? "warning",
              category: (i.category as string) ?? (language === "en" ? "Uncategorized" : "未分类"),
              description: (i.description as string) ?? "",
              suggestion: (i.suggestion as string) ?? "",
              repairScope: normalizeRepairScope(i.repair_scope ?? i.repairScope),
            })).filter((issue: AuditIssue) => !isSelfRefutingCriticalIssue(issue))
          : [],
        summary: String(parsed.summary ?? ""),
        overallScore,
      };
    } catch {
      return null;
    }
  }

}

function hasDedicatedAuditorEvidenceBlock(source: string): boolean {
  if (source.startsWith("story/pending_hooks.md#")) return true;
  if (source.startsWith("story/volume_summaries.md#")) return true;
  return source.startsWith("story/episode_summaries.md#")
    && source !== "story/episode_summaries.md#recent_titles"
    && source !== "story/episode_summaries.md#recent_mood_type_trail";
}
