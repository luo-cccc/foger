import { BaseAgent } from "./base.js";
import type { LengthNormalizeMode, LengthSpec } from "../models/length-governance.js";
import { countChapterLength, chooseNormalizeMode, isOutsideHardRange, isOutsideSoftRange } from "../utils/length-metrics.js";

export interface NormalizeLengthInput {
  readonly chapterContent: string;
  readonly lengthSpec: LengthSpec;
  readonly chapterIntent?: string;
  readonly reducedControlBlock?: string;
}

export interface NormalizeLengthOutput {
  readonly normalizedContent: string;
  readonly finalCount: number;
  readonly applied: boolean;
  readonly mode: LengthNormalizeMode;
  readonly warning?: string;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

interface NormalizationAttempt {
  readonly normalizedContent: string;
  readonly finalCount: number;
  readonly accepted: boolean;
  readonly warning?: string;
}

export class LengthNormalizerAgent extends BaseAgent {
  get name(): string {
    return "length-normalizer";
  }

  async normalizeChapter(input: NormalizeLengthInput): Promise<NormalizeLengthOutput> {
    const originalCount = countChapterLength(input.chapterContent, input.lengthSpec.countingMode);
    const mode = input.lengthSpec.normalizeMode === "none"
      ? chooseNormalizeMode(originalCount, input.lengthSpec)
      : input.lengthSpec.normalizeMode;

    if (mode === "none") {
      return {
        normalizedContent: input.chapterContent,
        finalCount: originalCount,
        applied: false,
        mode,
      };
    }

    let totalUsage = this.zeroUsage();
    let bestAccepted: NormalizationAttempt | null = null;
    let lastWarning = this.buildWarning(originalCount, input.lengthSpec);

    const firstAttempt = await this.runNormalizationAttempt({
      input,
      chapterContent: input.chapterContent,
      currentCount: originalCount,
      mode,
      strict: false,
    });
    totalUsage = this.addUsage(totalUsage, firstAttempt.tokenUsage);
    bestAccepted = this.pickBetterAttempt(bestAccepted, firstAttempt.result, input.lengthSpec);
    lastWarning = firstAttempt.result.warning ?? lastWarning;

    const bestAfterFirst = bestAccepted ?? firstAttempt.result;
    if (bestAfterFirst.accepted && !isOutsideSoftRange(bestAfterFirst.finalCount, input.lengthSpec)) {
      return {
        normalizedContent: bestAfterFirst.normalizedContent,
        finalCount: bestAfterFirst.finalCount,
        applied: bestAfterFirst.normalizedContent !== input.chapterContent,
        mode,
        warning: bestAfterFirst.warning,
        tokenUsage: totalUsage,
      };
    }

    const strictSource = firstAttempt.result.accepted
      ? firstAttempt.result.normalizedContent
      : input.chapterContent;
    const strictSourceCount = firstAttempt.result.accepted
      ? firstAttempt.result.finalCount
      : originalCount;

    if (isOutsideSoftRange(strictSourceCount, input.lengthSpec)) {
      const strictAttempt = await this.runNormalizationAttempt({
        input,
        chapterContent: strictSource,
        currentCount: strictSourceCount,
        mode,
        strict: true,
      });
      totalUsage = this.addUsage(totalUsage, strictAttempt.tokenUsage);
      bestAccepted = this.pickBetterAttempt(bestAccepted, strictAttempt.result, input.lengthSpec);
      lastWarning = strictAttempt.result.warning ?? lastWarning;
    }

    const normalizedContent = bestAccepted?.normalizedContent ?? input.chapterContent;
    const finalCountBeforeHardBound = bestAccepted?.finalCount ?? originalCount;
    const hardBounded = mode === "compress" && bestAccepted
      ? this.boundOverlongContent(normalizedContent, input)
      : undefined;
    const finalContent = hardBounded?.normalizedContent ?? normalizedContent;
    const finalCount = hardBounded?.finalCount ?? finalCountBeforeHardBound;

    return {
      normalizedContent: finalContent,
      finalCount,
      applied: finalContent !== input.chapterContent,
      mode,
      warning: hardBounded
        ? this.buildWarning(finalCount, input.lengthSpec)
        : bestAccepted ? bestAccepted.warning : lastWarning,
      tokenUsage: totalUsage,
    };
  }

  private boundOverlongContent(
    content: string,
    input: NormalizeLengthInput,
  ): { readonly normalizedContent: string; readonly finalCount: number } | undefined {
    const { lengthSpec } = input;
    if (countChapterLength(content, lengthSpec.countingMode) <= lengthSpec.hardMax) {
      return undefined;
    }

    const requiredMarkers = this.collectRequiredMarkers(input)
      .filter((marker) => content.includes(marker) || input.chapterContent.includes(marker));
    let clipped = this.preserveHeadAndTail(content, lengthSpec.hardMax, lengthSpec.countingMode);
    let markerSuffix = requiredMarkers.filter((marker) => !clipped.includes(marker));
    if (markerSuffix.length > 0) {
      const markerCount = countChapterLength(markerSuffix.join("\n"), lengthSpec.countingMode);
      const contentLimit = lengthSpec.hardMax - markerCount;
      if (contentLimit < lengthSpec.hardMin) {
        return undefined;
      }
      clipped = this.preserveHeadAndTail(content, contentLimit, lengthSpec.countingMode);
      markerSuffix = requiredMarkers.filter((marker) => !clipped.includes(marker));
    }
    const candidate = markerSuffix.length > 0
      ? `${clipped.trimEnd()}\n${markerSuffix.join("\n")}`.trim()
      : clipped.trim();
    const finalCount = countChapterLength(candidate, lengthSpec.countingMode);
    if (finalCount < lengthSpec.hardMin || finalCount > lengthSpec.hardMax) {
      return undefined;
    }
    return { normalizedContent: candidate, finalCount };
  }

  private collectRequiredMarkers(input: NormalizeLengthInput): string[] {
    const source = `${input.chapterIntent ?? ""}\n${input.reducedControlBlock ?? ""}`;
    return [...source.matchAll(/\[\[[^\]\n]+\]\]/g)].map((match) => match[0]);
  }

  private truncateEnglishWords(content: string, maxWords: number): string {
    const words = [...content.matchAll(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g)];
    const cutoff = words[maxWords - 1]?.index;
    const end = words[maxWords - 1] && cutoff !== undefined
      ? cutoff + words[maxWords - 1][0].length
      : content.length;
    return this.trimAtSentenceBoundary(content.slice(0, end), true);
  }

  private preserveHeadAndTail(
    content: string,
    maxCount: number,
    countingMode: LengthSpec["countingMode"],
  ): string {
    if (countChapterLength(content, countingMode) <= maxCount) return content;

    const headBudget = Math.max(1, Math.floor(maxCount * 0.6));
    const tailBudget = Math.max(1, maxCount - headBudget);
    const head = countingMode === "en_words"
      ? this.truncateEnglishWords(content, headBudget)
      : this.truncateZhCharacters(content, headBudget);
    const tail = countingMode === "en_words"
      ? this.takeLastEnglishWords(content, tailBudget)
      : this.takeLastZhCharacters(content, tailBudget);
    const candidate = `${head.trimEnd()}\n${tail.trimStart()}`.trim();

    if (countChapterLength(candidate, countingMode) <= maxCount) return candidate;

    // Sentence-boundary trimming can leave a small overrun when the two
    // retained sections meet. Reduce the head first so the promised tail stays.
    const reducedHeadBudget = Math.max(1, headBudget - (countChapterLength(candidate, countingMode) - maxCount));
    const reducedHead = countingMode === "en_words"
      ? this.truncateEnglishWords(content, reducedHeadBudget)
      : this.truncateZhCharacters(content, reducedHeadBudget);
    return `${reducedHead.trimEnd()}\n${tail.trimStart()}`.trim();
  }

  private takeLastEnglishWords(content: string, maxWords: number): string {
    const words = [...content.matchAll(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g)];
    const first = words[Math.max(0, words.length - maxWords)];
    const suffix = first?.index === undefined ? content : content.slice(first.index);
    return this.trimFromSentenceBoundary(suffix, true);
  }

  private takeLastZhCharacters(content: string, maxCharacters: number): string {
    const chars = Array.from(content);
    let count = 0;
    let start = 0;
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      if (!/\s/.test(chars[index] ?? "")) count += 1;
      if (count >= maxCharacters) {
        start = index;
        break;
      }
    }
    return this.trimFromSentenceBoundary(chars.slice(start).join(""), false);
  }

  private truncateZhCharacters(content: string, maxCharacters: number): string {
    const chars = Array.from(content);
    let count = 0;
    let end = chars.length;
    for (let index = 0; index < chars.length; index += 1) {
      if (!/\s/.test(chars[index] ?? "")) count += 1;
      if (count >= maxCharacters) {
        end = index + 1;
        break;
      }
    }
    return this.trimAtSentenceBoundary(chars.slice(0, end).join(""), false);
  }

  private trimAtSentenceBoundary(content: string, english: boolean): string {
    const boundaryPattern = english
      ? /[.!?](?:["'”’\u201d\u2019)\]]*)|\n\s*\n/g
      : /[。！？!?；;](?:[”’」』》）)\]]*)|\n\s*\n/g;
    let boundaryEnd = -1;
    for (const match of content.matchAll(boundaryPattern)) {
      boundaryEnd = (match.index ?? 0) + match[0].length;
    }
    if (boundaryEnd <= 0) return content;
    const bounded = content.slice(0, boundaryEnd).trimEnd();
    return bounded || content;
  }

  private trimFromSentenceBoundary(content: string, english: boolean): string {
    const boundaryPattern = english
      ? /[.!?](?:["'”’\u201d\u2019)\]]*)|\n\s*\n/
      : /[。！？!?；;](?:[”’」』》）)\]]*)|\n\s*\n/;
    const match = content.match(boundaryPattern);
    if (!match || match.index === undefined) return content.trimStart();
    return content.slice(match.index + match[0].length).trimStart() || content.trimStart();
  }

  private zeroUsage(): {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  } {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }

  private addUsage(
    left: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    },
    right?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    },
  ): {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  } {
    return {
      promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
      completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
      totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
    };
  }

  private async runNormalizationAttempt(params: {
    readonly input: NormalizeLengthInput;
    readonly chapterContent: string;
    readonly currentCount: number;
    readonly mode: LengthNormalizeMode;
    readonly strict: boolean;
  }): Promise<{
    readonly result: NormalizationAttempt;
    readonly tokenUsage: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    };
  }> {
    const response = await this.chat(
      [
        { role: "system", content: this.buildSystemPrompt(params.mode, params.strict) },
        {
          role: "user",
          content: this.buildUserPrompt({
            input: params.input,
            chapterContent: params.chapterContent,
            currentCount: params.currentCount,
            mode: params.mode,
            strict: params.strict,
          }),
        },
      ],
      {
        temperature: params.strict ? 0.1 : 0.2,
        stream: false,
        callPhase: "normalize-length",
      },
    );

    return {
      result: this.evaluateAttempt(
        response.content,
        params.chapterContent,
        params.currentCount,
        params.input.lengthSpec,
      ),
      tokenUsage: response.usage,
    };
  }

  private buildSystemPrompt(mode: LengthNormalizeMode, strict = false): string {
    const action = mode === "compress" ? "compress" : "expand";
    const strictLine = strict
      ? "- This is the final correction pass. The output MUST land inside the soft target range."
      : "";

    return [
      "You are a chapter length normalizer.",
      "Rewrite the chapter body exactly once. Do not explain your work.",
      `Goal: ${action} the chapter into the requested range while preserving facts, names, hooks, and required markers.`,
      "- Preserve the first concrete action, event, dialogue, anomaly, objective, or resistance; do not replace it with atmosphere or background exposition.",
      "- Preserve the final concrete action, evidence, decision, dialogue, or threat; do not replace it with abstract recap or a future-facing forecast.",
      "- Do not add new subplots, future reveals, or recap commentary.",
      "- Output only the full revised chapter body.",
      strictLine,
    ].filter(Boolean).join("\n");
  }

  private buildUserPrompt(params: {
    readonly input: NormalizeLengthInput;
    readonly chapterContent: string;
    readonly currentCount: number;
    readonly mode: LengthNormalizeMode;
    readonly strict: boolean;
  }): string {
    const { input, chapterContent, currentCount, mode, strict } = params;
    const intentBlock = input.chapterIntent
      ? `\n## Chapter Intent\n${input.chapterIntent}\n`
      : "";
    const controlBlock = input.reducedControlBlock
      ? `\n## Reduced Control Block\n${input.reducedControlBlock}\n`
      : "";
    const requiredDelta = mode === "compress"
      ? Math.max(0, currentCount - input.lengthSpec.softMax)
      : Math.max(0, input.lengthSpec.softMin - currentCount);
    const targetRatio = currentCount > 0
      ? Math.max(1, Math.round((input.lengthSpec.target / currentCount) * 100))
      : 100;
    const strictBlock = strict
      ? `\n## Strict Length Requirement
- Final count MUST be between ${input.lengthSpec.softMin} and ${input.lengthSpec.softMax}
- Never cross the hard bounds ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax}
- ${mode === "compress"
  ? `Delete at least ${requiredDelta} counted characters; keep about ${targetRatio}% of the current text`
  : `Add at least ${requiredDelta} counted characters; reach about ${targetRatio}% of the current text`}
- If compressing, remove recap, repeated emotion restatement, scenic filler, and duplicated action beats first
- If compressing, merge repeated deductions and cut entire redundant beats; preserving every paragraph is forbidden
- If expanding, add only concrete action, sensory detail, or causally necessary beats already implied by the scene
- Before returning, silently recount and revise again until the soft range is satisfied
`
      : "";

    return `Revise the chapter by ${mode === "compress" ? "compressing" : "expanding"} it.
## Length Spec
- Target: ${input.lengthSpec.target}
- Soft Range: ${input.lengthSpec.softMin}-${input.lengthSpec.softMax}
- Hard Range: ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax}
- Counting Mode: ${input.lengthSpec.countingMode}

## Current Count
${currentCount}

## Correction Rules
- Rewrite once only
- Preserve names, places, facts, markers, and continuity
- Preserve the opening's first concrete story beat and the ending's final concrete consequence or choice
- Do not invent new subplot material
- Do not add meta explanation or analysis
- Return only the revised chapter body
${intentBlock}${controlBlock}${strictBlock}
## Chapter Content
${chapterContent}`;
  }

  private evaluateAttempt(
    rawContent: string,
    originalContent: string,
    originalCount: number,
    lengthSpec: LengthSpec,
  ): NormalizationAttempt {
    const sanitizedContent = this.sanitizeNormalizedContent(rawContent, originalContent);
    const sanitizedCount = countChapterLength(sanitizedContent, lengthSpec.countingMode);
    const wasTruncated = sanitizedContent !== originalContent
      && sanitizedCount < lengthSpec.hardMin
      && this.looksTruncated(sanitizedContent);
    const crossedHardRange = sanitizedContent !== originalContent
      && this.crossesOppositeHardBound(originalCount, sanitizedCount, lengthSpec);

    if (wasTruncated) {
      return {
        normalizedContent: originalContent,
        finalCount: originalCount,
        accepted: false,
        warning: "Length normalizer output appeared truncated; kept original chapter.",
      };
    }
    if (crossedHardRange) {
      return {
        normalizedContent: originalContent,
        finalCount: originalCount,
        accepted: false,
        warning: "Length normalizer output crossed the hard range; kept original chapter.",
      };
    }

    const finalCount = countChapterLength(sanitizedContent, lengthSpec.countingMode);
    return {
      normalizedContent: sanitizedContent,
      finalCount,
      accepted: true,
      warning: this.buildWarning(finalCount, lengthSpec),
    };
  }

  private pickBetterAttempt(
    current: NormalizationAttempt | null,
    candidate: NormalizationAttempt,
    lengthSpec: LengthSpec,
  ): NormalizationAttempt | null {
    if (!candidate.accepted) {
      return current;
    }
    if (!current || !current.accepted) {
      return candidate;
    }

    const currentInSoftRange = !isOutsideSoftRange(current.finalCount, lengthSpec);
    const candidateInSoftRange = !isOutsideSoftRange(candidate.finalCount, lengthSpec);
    if (candidateInSoftRange !== currentInSoftRange) {
      return candidateInSoftRange ? candidate : current;
    }

    const currentInRange = !isOutsideHardRange(current.finalCount, lengthSpec);
    const candidateInRange = !isOutsideHardRange(candidate.finalCount, lengthSpec);
    if (candidateInRange !== currentInRange) {
      return candidateInRange ? candidate : current;
    }

    const currentDistance = Math.abs(current.finalCount - lengthSpec.target);
    const candidateDistance = Math.abs(candidate.finalCount - lengthSpec.target);
    if (candidateDistance !== currentDistance) {
      return candidateDistance < currentDistance ? candidate : current;
    }

    return candidate.normalizedContent.length < current.normalizedContent.length
      ? candidate
      : current;
  }

  private buildWarning(finalCount: number, lengthSpec: LengthSpec): string | undefined {
    if (!isOutsideSoftRange(finalCount, lengthSpec)) {
      return undefined;
    }

    if (isOutsideHardRange(finalCount, lengthSpec)) {
      return `Final count ${finalCount} is outside the hard range ${lengthSpec.hardMin}-${lengthSpec.hardMax} after normalization.`;
    }

    return `Final count ${finalCount} is outside the soft range ${lengthSpec.softMin}-${lengthSpec.softMax} after normalization.`;
  }

  private crossesOppositeHardBound(
    originalCount: number,
    candidateCount: number,
    lengthSpec: LengthSpec,
  ): boolean {
    if (originalCount > lengthSpec.hardMax && candidateCount < lengthSpec.hardMin) {
      return true;
    }
    if (originalCount < lengthSpec.hardMin && candidateCount > lengthSpec.hardMax) {
      return true;
    }
    return false;
  }

  private sanitizeNormalizedContent(rawContent: string, fallbackContent: string): string {
    const trimmed = rawContent.trim();
    if (!trimmed) return fallbackContent;

    const fenced = this.extractFirstFencedBlock(trimmed);
    if (fenced) return fenced;

    const stripped = this.stripCommonWrappers(trimmed);
    if (stripped !== undefined) {
      if (!stripped) return fallbackContent;
      if (stripped.length < trimmed.length * 0.5) return trimmed;
      return stripped;
    }

    return trimmed;
  }

  private looksTruncated(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith("```")) return false;
    if (/[。！？!?」』】）》)\]"]$/.test(trimmed)) return false;
    if (/\n\s*$/.test(content) && /[，、；：,:]$/.test(trimmed)) return true;
    return /[，、；：,:]$/.test(trimmed) || /[\u4e00-\u9fffA-Za-z0-9]$/.test(trimmed);
  }

  private extractFirstFencedBlock(content: string): string | undefined {
    const match = content.match(/```(?:[a-zA-Z-]+)?\s*\n([\s\S]*?)\n```/);
    if (!match) return undefined;
    const body = match[1]?.trim();
    return body ? body : undefined;
  }

  private stripCommonWrappers(content: string): string | undefined {
    const lines = content.split("\n");
    let removedAny = false;
    const keptLines: string[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (this.isWrapperLine(trimmed)) {
        removedAny = true;
        continue;
      }
      keptLines.push(rawLine);
    }

    if (!removedAny) {
      return undefined;
    }

    return keptLines.join("\n").trim();
  }

  private isWrapperLine(line: string): boolean {
    if (!line) return false;
    if (/^```/.test(line)) return true;
    if (/^#+\s*(explanation|analysis|analysis note|note)\b/i.test(line)) return true;

    if (/^(below is|here(?:'s| is)).*(chapter|draft|content|rewrite|revised|compressed|expanded|normalized|adjusted|output|version|result)/i.test(line)) {
      return true;
    }

    if (/^i(?:'ll| will)\s+(rewrite|revise|reword|compress|expand|normalize|adjust|shorten|lengthen|trim|fix)\b/i.test(line)) {
      return true;
    }

    if (/^(下面是|以下是).*(正文|章节|压缩|扩写|修正|修改|调整|改写|润色|结果|内容|输出|版本)/.test(line)) {
      return true;
    }

    if (/^我先.*(压缩|扩写|修正|修改|调整|改写|润色|处理).*(正文|章节)?/.test(line)) {
      return true;
    }

    return false;
  }
}
