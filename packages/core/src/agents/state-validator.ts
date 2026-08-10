import { BaseAgent } from "./base.js";
import { normalizeStoredHookStatus } from "../utils/hook-lifecycle.js";
import { parsePendingHooksMarkdown } from "../utils/story-markdown.js";

export interface ValidationWarning {
  readonly category: string;
  readonly description: string;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly passed: boolean;
}

export function applyBlockingStateWarningPolicy(result: ValidationResult): ValidationResult {
  if (!result.passed || !result.warnings.some(isBlockingStateWarning)) {
    return result;
  }
  return { ...result, passed: false };
}

function isBlockingStateWarning(warning: ValidationWarning): boolean {
  const category = warning.category.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (/^missing_(?:state_change|hook_update|summary|episode_summary)/.test(category)) {
    return true;
  }
  return category === "hook_anomaly"
    && /(?:removed|disappeared|dropped|missing from|删除|移除|消失|丢失|未保留)/i.test(warning.description);
}

export interface StateValidationAuthorityContext {
  readonly storyFrame?: string;
  readonly bookRules?: string;
  readonly episodeSummaries?: string;
}

/**
 * Validates projected episode state by comparing prior and next truth files.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * Uses a minimal verdict protocol instead of requiring structured JSON:
 *   Line 1: PASS or FAIL
 *   Remaining lines: free-form warnings (one per line, optional category prefix)
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    episodeContent: string,
    episodeNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
    authorityContext?: StateValidationAuthorityContext,
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");
    const deterministicWarnings = detectHookStateContradictions(
      oldHooks,
      newHooks,
      episodeNumber,
      language,
    );

    if (deterministicWarnings.length > 0) {
      return { warnings: deterministicWarnings, passed: false };
    }

    // Skip validation if nothing changed
    if (!stateDiff && !hooksDiff) {
      return { warnings: [], passed: true };
    }

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `You are a continuity validator for a serialized comic-drama screenplay system. ${langInstruction}

Given the episode text and the CHANGES made to truth files (state card + hooks pool), check for contradictions:

1. State change without narrative support — truth file says something changed but the episode text doesn't describe it
2. Missing state change — episode text describes something happening but the truth file didn't capture it
3. Temporal impossibility — character moves locations without transition, injury heals without time passing
4. Hook anomaly — a hook disappeared without being marked resolved, or a new hook has no basis in the episode
5. Retroactive edit — truth file change implies something happened in a PREVIOUS episode, not the current one
6. Cross-truth key-setting conflict — numbered rules, named laws, ranks, identities, locations, or relationship labels in the new truth files contradict the episode text or the authority context
7. Internal hook contradiction — a hook is marked progressing/resolved in its status or last-advanced episode while its own new note says the promised event did not appear, did not happen, remains untriggered, or is deferred to a later episode

Output format:
- Preferred: plain-text protocol — first line exactly PASS or FAIL (nothing else on that line), then one warning per line, optionally prefixed with [category]; if no issues at all, output just: PASS
- Alternative: a single JSON verdict object {"passed": boolean, "warnings": [{"category": string, "description": string}]}
- Do NOT wrap either form in Markdown code fences

Example:
PASS
[unsupported_change] State card says character moved to the forest, but text only shows intent
[minor] Hook H03 advanced but text mention is brief

Or if there are hard contradictions:
FAIL
[contradiction] State says character is dead but episode text shows them speaking
[unsupported_change] New location not mentioned anywhere in episode text

IMPORTANT: Output FAIL ONLY for hard contradictions — facts that directly conflict with the episode text. Do NOT fail for:
- A status/note contradiction from item 7 is a hard contradiction: output FAIL even if the underlying hook management choice would otherwise be advisory
- Slightly ahead-of-text inferences
- Missing details that the state card didn't capture
- Reasonable extrapolations from text
- Hook management differences that don't contradict text
These should be warnings with PASS, not FAIL.`;

    const authorityBlock = this.buildAuthorityContextBlock(authorityContext);

    const userPrompt = `Episode ${episodeNumber} validation:

${authorityBlock}

## State Card Changes
${stateDiff || "(no changes)"}

## Hooks Pool Changes
${hooksDiff || "(no changes)"}

## Episode Text (for reference)
${episodeContent}`;

    try {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.1, stream: false, callPhase: "validate-state", maxTokens: 2048 },
      );

      return applyBlockingStateWarningPolicy(this.parseResult(response.content));
    } catch (error) {
      this.log?.warn(`State validation failed: ${error}`);
      throw error;
    }
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private buildAuthorityContextBlock(authorityContext?: StateValidationAuthorityContext): string {
    if (!authorityContext) return "## Authority / Cross-Truth Context\n(no authority context provided)";

    const storyFrame = (authorityContext.storyFrame ?? "").trim();
    const bookRules = (authorityContext.bookRules ?? "").trim();
    const episodeSummaries = (authorityContext.episodeSummaries ?? "").trim();

    return [
      "## Authority / Cross-Truth Context",
      "Authority priority: current episode text > runtime truth files/current summaries > story_frame/book_rules > legacy story_bible intro or marketing-style prose. If the current episode establishes a numbered/name mapping, new truth files must follow that mapping instead of preserving an older intro-only version.",
      "",
      "### story_frame / legacy story_bible excerpt",
      storyFrame || "(empty)",
      "",
      "### book_rules excerpt",
      bookRules || "(empty)",
      "",
      "### recent episode_summaries excerpt",
      episodeSummaries || "(empty)",
    ].join("\n");
  }

  private parseResult(content: string): ValidationResult {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("LLM returned empty response");
    }

    const jsonResult = this.tryParseJsonResult(trimmed);
    if (jsonResult) {
      return jsonResult;
    }

    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    const verdictLine = lines[0]!;
    if (!/^(PASS|FAIL)$/i.test(verdictLine)) {
      throw new Error("State validator returned invalid response");
    }
    const passed = /^PASS$/i.test(verdictLine);

    const warnings: ValidationWarning[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^(PASS|FAIL)$/i.test(line)) continue;

      const categoryMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (categoryMatch) {
        warnings.push({
          category: categoryMatch[1]!.trim(),
          description: categoryMatch[2]!.trim(),
        });
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        warnings.push({
          category: "general",
          description: line.slice(2).trim(),
        });
      } else if (line.length > 5) {
        warnings.push({
          category: "general",
          description: line,
        });
      }
    }

    return { warnings, passed };
  }

  private tryParseJsonResult(text: string): ValidationResult | null {
    const direct = this.tryParseExactJsonResult(text);
    if (direct) {
      return direct;
    }

    const candidate = extractBalancedJsonObject(text);
    if (!candidate) {
      return null;
    }
    return this.tryParseExactJsonResult(candidate);
  }

  private tryParseExactJsonResult(text: string): ValidationResult | null {
    try {
      const parsed = JSON.parse(text) as {
        warnings?: Array<{ category?: string; description?: string }>;
        passed?: boolean;
      };
      if (typeof parsed.passed !== "boolean") return null;
      return applyBlockingStateWarningPolicy({
        warnings: (parsed.warnings ?? []).map((w) => ({
          category: w.category ?? "unknown",
          description: w.description ?? "",
        })),
        passed: parsed.passed,
      });
    } catch {
      return null;
    }
  }
}

function detectHookStateContradictions(
  oldHooksMarkdown: string,
  newHooksMarkdown: string,
  episodeNumber: number,
  language: "zh" | "en",
): ValidationWarning[] {
  const oldHooks = new Map(
    parsePendingHooksMarkdown(oldHooksMarkdown).map((hook) => [hook.hookId, hook]),
  );
  const warnings: ValidationWarning[] = [];

  for (const hook of parsePendingHooksMarkdown(newHooksMarkdown)) {
    const previous = oldHooks.get(hook.hookId);
    const status = normalizeStoredHookStatus(hook.status);
    const previousStatus = previous ? normalizeStoredHookStatus(previous.status) : undefined;
    const statusAdvanced = previousStatus !== status && (status === "progressing" || status === "resolved");
    const episodeAdvanced = hook.lastAdvancedEpisode >= episodeNumber
      && hook.lastAdvancedEpisode > (previous?.lastAdvancedEpisode ?? -1);
    const note = hook.notes.trim();

    if (hook.lastAdvancedEpisode > episodeNumber) {
      warnings.push({
        category: "hook-state-contradiction",
        description: language === "en"
          ? `Hook ${hook.hookId} claims last advancement in future episode ${hook.lastAdvancedEpisode}, while validating episode ${episodeNumber}.`
          : `伏笔 ${hook.hookId} 的最近推进被写成未来第${hook.lastAdvancedEpisode}集，但当前校验的是第${episodeNumber}集。`,
      });
      continue;
    }

    if (status === "resolved" && noteContradictsResolution(note)) {
      warnings.push({
        category: "hook-state-contradiction",
        description: language === "en"
          ? `Hook ${hook.hookId} is resolved, but its note says the payoff remains unresolved or deferred: ${note}`
          : `伏笔 ${hook.hookId} 已标记为回收，但备注仍说明尚未兑现或被延后：${note}`,
      });
      continue;
    }

    if (status === "deferred" && episodeAdvanced) {
      warnings.push({
        category: "hook-state-contradiction",
        description: language === "en"
          ? `Hook ${hook.hookId} is deferred in episode ${episodeNumber}, but lastAdvancedEpisode was also advanced. Deferral must preserve the previous advancement episode.`
          : `伏笔 ${hook.hookId} 在第${episodeNumber}集被标记为延后，却同时更新了最近推进剧集；延后必须保留此前的推进剧集。`,
      });
      continue;
    }

    if ((statusAdvanced || episodeAdvanced) && noteDeniesCurrentEpisodeMovement(note)) {
      warnings.push({
        category: "hook-state-contradiction",
        description: language === "en"
          ? `Hook ${hook.hookId} is marked as advanced in episode ${episodeNumber}, but its note explicitly says this episode did not advance it: ${note}`
          : `伏笔 ${hook.hookId} 被标记为第${episodeNumber}集已推进，但备注明确写着本集没有推进：${note}`,
      });
    }
  }

  return warnings;
}

function noteContradictsResolution(note: string): boolean {
  return /(?:尚未|仍未|还未|没有|未能|并未|不曾).{0,12}(?:回收|解决|兑现|完成|揭晓|揭示|触发|发生)|(?:留待|留到|延后至|推迟到).{0,12}(?:后续|以后|下一集|第\s*\d+\s*集)|(?:remains?|still|not|never).{0,16}(?:unresolved|unpaid|unrevealed|incomplete)|(?:defer(?:red)?|postpone(?:d)?).{0,16}(?:later|future|next episode)/iu.test(note);
}

function noteDeniesCurrentEpisodeMovement(note: string): boolean {
  return /(?:本章|这一章|当章|本集|这一集|当集).{0,10}(?:未|没有|不|并未|不会).{0,10}(?:推进|触发|涉及|触达|出现|发生|兑现|回收|激活|变化)|(?:未在本章|没有在本章|不在本章|未在本集|没有在本集|不在本集).{0,10}(?:推进|触发|涉及|触达|出现|发生|兑现|回收|激活)|(?:this episode).{0,16}(?:did not|does not|never|no).{0,16}(?:advance|trigger|touch|appear|occur|resolve|activate|change)/iu.test(note);
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  if (endIndex < 0) return null;

  // Only accept the candidate if what follows the closing brace is
  // nothing, whitespace, or a structural JSON terminator.
  // This rejects trailing content like "{...} more text here"
  const followingChar = text[endIndex + 1];
  if (
    followingChar !== undefined &&
    followingChar !== "\n" &&
    followingChar !== "\r" &&
    followingChar !== "\t" &&
    followingChar !== " " &&
    followingChar !== "," &&
    followingChar !== "]" &&
    followingChar !== "}"
  ) {
    return null;
  }

  return text.slice(start, endIndex + 1);
}
