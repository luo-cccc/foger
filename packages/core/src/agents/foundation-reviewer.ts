import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";
import {
  FOUNDATION_COMPACT_MAX_EPISODES,
  validateFoundationVolumeScale,
} from "../utils/foundation-scale.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly totalScore: number;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
  readonly blockingIssues?: ReadonlyArray<string>;
}

const PASS_THRESHOLD = 80;
const DIMENSION_FLOOR = 60;

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "en";
    readonly targetEpisodes?: number;
  }): Promise<FoundationReviewResult> {
    const canonBlock = params.sourceCanon
      ? `\n## 原作正典参照\n${params.sourceCanon}\n`
      : "";
    const styleBlock = params.styleGuide
      ? `\n## 原作风格参照\n${params.styleGuide}\n`
      : "";

    const dimensions = params.mode === "original"
      ? this.originalDimensions(params.language, params.targetEpisodes)
      : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = params.language === "en"
      ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
      : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { temperature: 0.3, stream: false, callPhase: "foundation-review" });

    const parsed = this.parseReviewResult(response.content, dimensions);
    if (params.mode !== "original" || params.targetEpisodes === undefined) {
      return parsed;
    }

    const scaleIssues = validateFoundationVolumeScale(
      params.foundation.volumeMap ?? params.foundation.volumeOutline,
      params.targetEpisodes,
    );
    if (scaleIssues.length === 0) return parsed;

    const blockingIssues = scaleIssues.map((issue) => (
      params.language === "en" ? issue.en : issue.zh
    ));
    const dimensionsWithGate = parsed.dimensions.map((dimension, index) => (
      index === parsed.dimensions.length - 1
        ? {
            ...dimension,
            score: Math.min(dimension.score, 40),
            feedback: `${blockingIssues.join("\n")}\n${dimension.feedback}`,
          }
        : dimension
    ));
    const averagedScore = dimensionsWithGate.length > 0
      ? Math.round(dimensionsWithGate.reduce((sum, dimension) => sum + dimension.score, 0) / dimensionsWithGate.length)
      : 0;
    const totalScore = Math.min(PASS_THRESHOLD - 1, averagedScore);

    return {
      passed: false,
      totalScore,
      dimensions: dimensionsWithGate,
      overallFeedback: `${blockingIssues.join("\n")}\n${parsed.overallFeedback}`,
      blockingIssues,
    };
  }

  private originalDimensions(language: "zh" | "en", targetEpisodes?: number): ReadonlyArray<string> {
    const target = Number.isFinite(targetEpisodes) && targetEpisodes && targetEpisodes > 0
      ? Math.round(targetEpisodes)
      : 40;
    const openingWindow = Math.min(5, target);
    const repeatWindow = Math.min(10, Math.max(3, target));
    const compact = target <= FOUNDATION_COMPACT_MAX_EPISODES;
    return language === "en"
      ? [
          `Core Conflict (Is there a compelling high-pressure relationship whose parties cannot simply walk away, with enough leverage and cost to sustain the requested ${target} episodes?)`,
          `Opening Momentum (Can the first ${openingWindow} episodes combine a familiar payoff with a concrete emotional hook rather than only introducing lore?)`,
          "World Coherence (Is the premise difference internally consistent, specific, and consequential for character choices and costs rather than cosmetic renaming?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          compact
            ? `Pacing Feasibility (Does the Compact Episode Beat Contract cover all ${target} episodes with a distinct Goal, Obstacle, evidence-driven Turn, observable familiar Delivery, and emotional End Hook per episode, while episode ${target} closes the core conflict?)`
            : `Pacing Feasibility (Does the outline fit the requested ${target} episodes, vary evidence-driven reversals with aftermath, and avoid repeating the same beat for ${repeatWindow} episodes?)`,
        ]
      : [
          `核心冲突（是否有双方不能轻易退出、各自握有筹码与退出代价的高压关系，足以支撑用户要求的${target}集？）`,
          `开篇节奏（前${openingWindow}集能否用熟悉爽点承接新设定，并形成具体的情绪追看钩子，而不是只介绍世界观？）`,
          "世界一致性（新颖设定是否内洽、具体，并真实改变人物选择与失败代价，而非只替换术语？）",
          "角色区分度（主要角色的声音和动机是否各不相同？）",
          compact
            ? `节奏可行性（紧凑篇逐集节拍合同是否覆盖全部${target}集，每集都有不同的目标、阻碍、转折、可观察交付和因果集末钩子；其中转折有前置证据、交付承接熟悉回报、集末留下情绪余震，且第${target}集闭合核心冲突？）`
            : `节奏可行性（篇章计划是否适配用户要求的${target}集，让有证据的反转与后效交替，并避免连续${repeatWindow}集同一种节拍？）`,
        ];
  }

  private derivativeDimensions(language: "zh" | "en", _mode: "series"): ReadonlyArray<string> {
    const modeLabel = language === "en" ? "Series" : "系列";

    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Does the new story create a distinct high-pressure relationship whose parties cannot simply walk away?)",
          "Opening Momentum (Can the first 5 episodes pair a source-familiar payoff with the new narrative space and a concrete emotional hook?)",
          `Pacing Feasibility (Does the outline avoid re-walking the original's plot beats, using evidence-driven reversals and aftermath instead of arbitrary surprise?)`,
        ]
      : [
          `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
          `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
          "核心冲突（新故事是否建立了区别于原作、双方又不能轻易退出的高压关系？）",
          "开篇节奏（前5集能否让原作读者熟悉的回报承接新叙事空间，并形成具体的情绪追看钩子？）",
          `节奏可行性（卷纲是否避免重走原作剧情节拍，用有证据的反转及后效替代任意惊讶？）`,
        ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深漫剧策划编辑，正在审核一部漫剧的基础设定（世界观 + 全剧规划 + 规则）。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格。不要因为"还行"就给高分。80分意味着"可以直接开写，不需要改"。
若设定含重生/预知/系统/金手指类前提装置，检查 story_frame 是否显式记录装置契约（能力范围、失效条件、可见代价、规则可靠性）；缺失时在相关维度意见中指出，但它是工艺建议，不要仅因此判不通过。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Score each dimension (0-100) with specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental direction problem

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict. 80 means "ready to write without changes."
If the foundation includes a premise device (rebirth, foresight, mind-reading, a system, a golden finger), check whether story_frame records the device contract (capability range, failure conditions, visible cost, rule reliability); point out a missing contract in the relevant dimension's feedback, but treat it as craft guidance — do not fail the review for it alone.`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "en"): string {
    return language === "en"
      ? `## Story Bible\n${foundation.storyBible}\n\n## Volume Outline\n${foundation.volumeOutline}\n\n## Book Rules\n${foundation.bookRules}\n\n## Initial State\n${foundation.currentState}\n\n## Initial Hooks\n${foundation.pendingHooks}`
      : `## 世界设定\n${foundation.storyBible}\n\n## 卷纲\n${foundation.volumeOutline}\n\n## 规则\n${foundation.bookRules}\n\n## 初始状态\n${foundation.currentState}\n\n## 初始伏笔\n${foundation.pendingHooks}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
  ): FoundationReviewResult {
    const parsedDimensions: Array<{ readonly name: string; readonly score: number; readonly feedback: string }> = [];

    for (let i = 0; i < dimensions.length; i++) {
      const regex = new RegExp(
        `=== DIMENSION: ${i + 1} ===\\s*[\\s\\S]*?(?:分数|Score)[：:]\\s*(\\d+)[\\s\\S]*?(?:意见|Feedback)[：:]\\s*([\\s\\S]*?)(?==== |$)`,
      );
      const match = content.match(regex);
      parsedDimensions.push({
        name: dimensions[i]!,
        score: match ? parseInt(match[1]!, 10) : 50,
        feedback: match ? match[2]!.trim() : "(parse failed)",
      });
    }

    const totalScore = parsedDimensions.length > 0
      ? Math.round(parsedDimensions.reduce((sum, d) => sum + d.score, 0) / parsedDimensions.length)
      : 0;
    const anyBelowFloor = parsedDimensions.some((d) => d.score < DIMENSION_FLOOR);
    const passed = totalScore >= PASS_THRESHOLD && !anyBelowFloor;

    const overallMatch = content.match(
      /=== OVERALL ===[\s\S]*?(?:总评|Summary)[：:]\s*([\s\S]*?)$/,
    );
    const overallFeedback = overallMatch ? overallMatch[1]!.trim() : "(parse failed)";

    return { passed, totalScore, dimensions: parsedDimensions, overallFeedback };
  }
}
