import type {
  ActiveOverride,
  EpisodeTrace,
  ContextPackage,
  RuleStack,
} from "../models/input-governance.js";
import { estimateTextTokens } from "../llm/provider.js";
import {
  EpisodeTraceSchema,
  RuleStackSchema,
} from "../models/input-governance.js";
import type { PlanEpisodeOutput } from "../agents/planner.js";

const MAX_OVERRIDE_REASON_CHARS = 80;

function truncateForOverrideReason(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_OVERRIDE_REASON_CHARS
    ? `${collapsed.slice(0, MAX_OVERRIDE_REASON_CHARS - 1)}…`
    : collapsed;
}

/**
 * Compose the per-episode rule stack used by writer / continuity / reviser
 * prompts. Source names follow the Phase 5 layout (story_frame, volume_map,
 * roles/) and activeOverrides are derived from the planner's intent so the
 * "Governed Control Stack" block surfaces the actual gating in effect for
 * the current episode — it used to be a static stub that ignored both
 * `plan` and `episodeNumber`.
 *
 * Phase hotfix 6 (Option A): make this honestly dynamic instead of deleting
 * it, because writer.ts (~L820/L900), continuity.ts (~L590), and
 * reviser.ts (~L600) all render ruleStack.sections / activeOverrides into
 * the model prompt. Removing the function would require a much larger
 * prompt refactor; making it real fixes the lie at the source.
 */
export function buildGovernedRuleStack(plan: PlanEpisodeOutput, episodeNumber: number): RuleStack {
  const activeOverrides: ActiveOverride[] = [];

  // L4 → L3: per-episode prohibitions narrow the planning layer for this
  // episode only. mustAvoid items come from rules-reader prohibitions +
  // current_focus avoid section (planner.collectMustAvoid).
  for (const item of plan.intent.mustAvoid) {
    activeOverrides.push({
      from: "L4",
      to: "L3",
      target: `episode:${episodeNumber}/mustAvoid`,
      reason: truncateForOverrideReason(item),
    });
  }

  // L4 → L3: planner-issued style emphasis is also a per-episode override
  // on the planning layer. Style emphasis surfaces things like POV tightness
  // or character-conflict focus that the writer must honor this episode.
  for (const item of plan.intent.styleEmphasis) {
    activeOverrides.push({
      from: "L4",
      to: "L3",
      target: `episode:${episodeNumber}/styleEmphasis`,
      reason: truncateForOverrideReason(item),
    });
  }

  return RuleStackSchema.parse({
    layers: [
      { id: "L1", name: "hard_facts", precedence: 100, scope: "global" },
      { id: "L2", name: "author_intent", precedence: 80, scope: "book" },
      { id: "L3", name: "planning", precedence: 60, scope: "arc" },
      { id: "L4", name: "current_task", precedence: 70, scope: "local" },
    ],
    sections: {
      // Phase 5 authoritative source names (was: story_bible, volume_outline).
      hard: ["story_frame", "current_state", "book_rules", "roles"],
      soft: ["author_intent", "current_focus", "volume_map"],
      diagnostic: ["anti_ai_checks", "continuity_audit", "style_regression_checks"],
    },
    overrideEdges: [
      { from: "L4", to: "L3", allowed: true, scope: "current_episode" },
      { from: "L4", to: "L2", allowed: false, scope: "current_episode" },
      { from: "L4", to: "L1", allowed: false, scope: "current_episode" },
    ],
    activeOverrides,
  });
}

export function buildGovernedTrace(params: {
  readonly episodeNumber: number;
  readonly plan: PlanEpisodeOutput;
  readonly contextPackage: ContextPackage;
  readonly composerInputs: ReadonlyArray<string>;
  readonly notes?: ReadonlyArray<string>;
  readonly usedSkills?: ReadonlyArray<string>;
  readonly promptPacks?: ReadonlyArray<string>;
  readonly contextNeeds?: ReadonlyArray<string>;
  readonly compression?: EpisodeTrace["compression"];
}): EpisodeTrace {
  const protectedEntries = params.contextPackage.selectedContext.filter((entry) =>
    getContextSourceTier(entry.source) === "verbatim",
  );
  const semanticEntries = params.contextPackage.selectedContext.filter((entry) =>
    getContextSourceTier(entry.source) === "semantic",
  );
  const compressibleEntries = params.contextPackage.selectedContext.filter((entry) =>
    getContextSourceTier(entry.source) === "compressible",
  );
  const protectedTokens = sumContextTokens(protectedEntries);
  const semanticTokens = sumContextTokens(semanticEntries);
  const compressibleTokens = sumContextTokens(compressibleEntries);
  const sourceStats = params.contextPackage.selectedContext.map((entry) => {
    const content = [entry.reason, entry.excerpt].filter(Boolean).join("\n");
    return {
      source: entry.source,
      tier: getContextSourceTier(entry.source),
      chars: content.length,
      estimatedTokens: estimateTextTokens(content),
      contentHash: fingerprintContextContent(content),
    };
  });

  return EpisodeTraceSchema.parse({
    episode: params.episodeNumber,
    plannerInputs: params.plan.plannerInputs,
    composerInputs: params.composerInputs,
    selectedSources: params.contextPackage.selectedContext.map((entry) => entry.source),
    usedSkills: params.usedSkills ?? [],
    promptPacks: params.promptPacks ?? [],
    contextNeeds: params.contextNeeds ?? [],
    contextTiers: {
      protectedSources: protectedEntries.map((entry) => entry.source),
      semanticSources: semanticEntries.map((entry) => entry.source),
      compressibleSources: compressibleEntries.map((entry) => entry.source),
    },
    tokenBudget: {
      protectedTokens,
      semanticTokens,
      compressibleTokens,
      totalSelectedTokens: protectedTokens + semanticTokens + compressibleTokens,
    },
    sourceStats,
    ...(params.compression ? { compression: params.compression } : {}),
    notes: params.notes ?? [],
  });
}

function fingerprintContextContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type ContextSourceTier = "verbatim" | "semantic" | "compressible";

/**
 * Verbatim sources survive byte-for-byte. Semantic sources may be compiled,
 * but their facts, ids, prohibitions, and precedence must survive. Everything
 * else is best-effort context that may be summarized or omitted by relevance.
 */
export function getContextSourceTier(source: string): ContextSourceTier {
  if (source === "runtime/episode_memo"
    || source === "runtime/episode_claim_brief"
    || source === "runtime/canon_validator"
    || source === "runtime/pre_write_claim_gate"
    || source === "runtime/volume_gate"
    || source === "story/current_focus.md"
    || source === "story/author_intent.md"
    || source === "story/audit_drift.md"
    || source.startsWith("runtime/hook_debt#")) {
    return "verbatim";
  }
  if (source === "runtime/current_arc"
    || source === "runtime/volume_contract"
    || source === "runtime/volume_progress"
    || source === "runtime/compiled-context"
    || source === "story/outline/story_frame.md"
    || source.startsWith("story/outline/story_frame.md#")
    || source === "story/story_bible.md"
    || source === "story/outline/volume_map.md"
    || source.startsWith("story/outline/volume_map.md#")
    || source === "story/volume_outline.md"
    || source === "story/parent_canon.md"
    || source.startsWith("story/current_state.md")
    || source.startsWith("story/pending_hooks.md#")) {
    return "semantic";
  }
  return "compressible";
}

export function isProtectedContextSource(source: string): boolean {
  return getContextSourceTier(source) === "verbatim";
}

function sumContextTokens(entries: ReadonlyArray<ContextPackage["selectedContext"][number]>): number {
  return entries.reduce((total, entry) => total + estimateContextSourceTokens(entry), 0);
}

function estimateContextSourceTokens(entry: ContextPackage["selectedContext"][number]): number {
  return estimateTextTokens([entry.source, entry.reason, entry.excerpt].filter(Boolean).join("\n"));
}
