/**
 * Phase 3 — EpisodeClaimCompiler.
 *
 * Given the book's canon claims and the current episode context (memo, POV,
 * episode number, recent hooks, current runtime state), selects the per-episode
 * CLAIM WORKING SET the writer is allowed to use (design doc section 5.2 / 6.3).
 *
 * The writer never sees the full canon — only:
 *   - usable:        claims in scope and visible at this episode / POV
 *   - mustHide:      secret truths not yet revealed to reader / POV
 *   - noGeneralize:  character exceptions that must not leak to other roles
 *   - costRequired:  claims whose use must pay the declared cost
 *   - conflictResolve: conflicts and their resolution edges
 *
 * Output is written to story/runtime/episode-XXXX.claims.json + a human-readable
 * episode-XXXX.claim-brief.md (design doc section 4).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanonClaim } from "../models/canon.js";

export interface EpisodeClaimContext {
  readonly episodeNumber: number;
  readonly pov?: string;
  readonly memo?: string;
  readonly activeHookIds?: ReadonlyArray<string>;
  readonly revealedClaimIds?: ReadonlyArray<string>;
  /** Character names the writer must NOT generalize the protagonist exception to. */
  readonly excludedCharacters?: ReadonlyArray<string>;
}

export interface CompiledEpisodeClaims {
  readonly episodeNumber: number;
  readonly usable: ReadonlyArray<CanonClaim>;
  readonly revealNow: ReadonlyArray<CanonClaim>;
  readonly mustHide: ReadonlyArray<CanonClaim>;
  readonly noGeneralize: ReadonlyArray<CanonClaim>;
  readonly costRequired: ReadonlyArray<CanonClaim>;
  readonly conflictResolve: ReadonlyArray<{
    readonly claim: CanonClaim;
    readonly resolvesBy: string;
  }>;
}

function claimVisibleToReader(claim: CanonClaim, episodeNumber: number, revealedClaimIds: ReadonlySet<string>): boolean {
  if (claim.domain === "style") return true;
  if (revealedClaimIds.has(claim.id)) return true;
  if (claim.visibility.readerKnownFrom === undefined) return true;
  return episodeNumber >= claim.visibility.readerKnownFrom;
}

function claimVisibleToPov(claim: CanonClaim, pov?: string): boolean {
  if (claim.domain === "style") return true;
  if (!pov) return true;
  if (claim.visibility.hiddenFrom.includes(pov)) return false;
  if (claim.claimType === "secret_truth") {
    // A secret truth is only POV-visible when explicitly known by that POV.
    return claim.visibility.characterKnownBy.includes(pov);
  }
  return true;
}

function claimInScopeForEpisode(claim: CanonClaim, ctx: EpisodeClaimContext): boolean {
  const { appliesTo, excludes, timeRange } = claim.scope;
  if (appliesTo.length > 0) {
    const appliesAll = appliesTo.includes("all");
    const appliesPov = ctx.pov ? appliesTo.includes(ctx.pov) : false;
    // No POV marker means the memo left the viewpoint unconstrained. Keep
    // objective world rules available to the writer, while still withholding
    // character-bound secret truths until a POV explicitly authorizes them.
    if (!appliesAll && !appliesPov && (ctx.pov || claim.claimType === "secret_truth")) return false;
  }
  if (excludes && ctx.pov && excludes.includes(ctx.pov)) return false;
  // timeRange is informational prose; we do not parse it strictly here, only
  // note that an explicit future-range claim is deferred to mustHide.
  if (timeRange && /未来|以后|终局|endgame|future/i.test(timeRange)) {
    return episodeNumberWithinRangeHint(timeRange, ctx.episodeNumber);
  }
  return true;
}

function episodeNumberWithinRangeHint(timeRange: string, episodeNumber: number): boolean {
  const nums = (timeRange.match(/\d+/g) ?? []).map(Number);
  if (nums.length === 0) return true;
  const min = nums[0];
  const max = nums.length > 1 ? nums[1] : Number.POSITIVE_INFINITY;
  return episodeNumber >= min && episodeNumber <= max;
}

function memoMentionsClaim(claim: CanonClaim, memo?: string): boolean {
  if (!memo) return false;
  // Match on id or a salient keyword from the claim content (>= 2 chars).
  if (memo.includes(claim.id)) return true;
  const keyword = claim.content.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 4);
  return keyword.length >= 2 && memo.includes(keyword);
}
/**
 * Chinese/English cue phrases that signal a deliberate reveal intent in the
 * planner memo. They rescue paraphrase commitments that never echo the claim
 * id verbatim, the common case for LLM-written memos.
 */
const REVEAL_INTENT_CUES = [
  "揭示", "揭晓", "揭露", "揭破", "揭穿", "摊牌", "坦白", "曝光", "浮出水面",
  "真相大白", "水落石出", "公之于众", "抖出", "点破", "捅破", "说破",
  "reveal", "reveals", "revealed", "revealing", "unveil", "unveils",
  "unveiled", "uncover", "uncovers", "expose", "exposes", "exposed", "disclose",
];

const REVEAL_NEGATION_CUES = [
  "暂不揭示", "先不揭示", "暂缓揭示", "留到", "推迟", "延后", "保留", "埋下",
  "不急于", "不在此章", "放到后面", "后续再", "以后再说", "下回分解",
  "do not reveal", "not yet reveal", "defer", "postpone", "hold back", "keep hidden",
];

/**
 * Whether the memo explicitly commits to revealing claim this episode.
 *
 * Catches verbatim echoes of the claim id/keyword AND paraphrase commitments,
 * as long as the claim subject matter is named and the memo is not explicitly
 * deferring the reveal.
 */
export function memoCommitsToReveal(claim: CanonClaim, memo?: string): boolean {
  if (!memo) return false;
  const lower = memo.toLowerCase();
  if (REVEAL_NEGATION_CUES.some((cue) => lower.includes(cue.toLowerCase()))) return false;
  if (!REVEAL_INTENT_CUES.some((cue) => lower.includes(cue.toLowerCase()))) return false;
  return memoMentionsClaim(claim, memo) || memoMentionsClaimSubject(claim, memo);
}

/**
 * Distinctive subject terms for a claim: its id plus content-derived CJK
 * 3-grams / latin tokens (>=4 chars). Links a memo paraphrase to the claim
 * even when it never echoes the id verbatim.
 */
function claimSubjectTerms(claim: CanonClaim): ReadonlyArray<string> {
  const terms = new Set<string>([claim.id]);
  const content = claim.content.replace(/[^\p{L}\p{N}]/gu, "");
  for (const token of content.split(/[^\p{L}\p{N}]+/u)) {
    if (/^[a-z0-9]+$/i.test(token) && token.length >= 4) terms.add(token.toLowerCase());
  }
  for (const match of content.match(/[\u4e00-\u9fff]+/gu) ?? []) {
    for (let i = 0; i <= match.length - 2; i += 1) terms.add(match.slice(i, i + 2));
    for (let i = 0; i <= match.length - 3; i += 1) terms.add(match.slice(i, i + 3));
  }
  return [...terms];
}

/**
 * Whether the memo text references a claim's subject matter.
 */
function memoMentionsClaimSubject(claim: CanonClaim, memo?: string): boolean {
  if (!memo) return false;
  const normalized = memo.toLowerCase().replace(/\s+/g, " ");
  return claimSubjectTerms(claim).some((term) => term.length > 0 && normalized.includes(term.toLowerCase()));
}

function memoMentionsClaimId(claim: CanonClaim, memo?: string): boolean {
  return memo?.includes(claim.id) ?? false;
}

export function compileEpisodeClaims(
  claims: ReadonlyArray<CanonClaim>,
  ctx: EpisodeClaimContext,
): CompiledEpisodeClaims {
  const usable: CanonClaim[] = [];
  const revealNow: CanonClaim[] = [];
  const mustHide: CanonClaim[] = [];
  const noGeneralize: CanonClaim[] = [];
  const costRequired: CanonClaim[] = [];
  const conflictResolve: { claim: CanonClaim; resolvesBy: string }[] = [];
  const revealedClaimIds = new Set(ctx.revealedClaimIds ?? []);

  for (const claim of claims) {
    const readerVisible = claimVisibleToReader(
      claim,
      ctx.episodeNumber,
      revealedClaimIds,
    );
    const povVisible = claimVisibleToPov(claim, ctx.pov);
    const inScope = claim.domain === "style" || claimInScopeForEpisode(claim, ctx);

    if (!readerVisible || !povVisible || !inScope) {
      mustHide.push(claim);
      continue;
    }

    usable.push(claim);

    if (claim.constraints.nonGeneralizable) {
      noGeneralize.push(claim);
    }
    if (claim.constraints.requiresCost.length > 0) {
      costRequired.push(claim);
    }
    if (claim.relations?.conflictsWith?.length && claim.relations.resolvesBy) {
      conflictResolve.push({ claim, resolvesBy: claim.relations.resolvesBy });
    }
  }

  // When a memo / active hooks name a hidden claim, surface it as a
  // "must reveal this episode" obligation instead of keeping it buried.
  for (const claim of [...mustHide]) {
    if (
      memoCommitsToReveal(claim, ctx.memo) ||
      memoMentionsClaimId(claim, ctx.memo) ||
      (ctx.activeHookIds ?? []).includes(claim.id)
    ) {

      revealNow.push(claim);
      usable.push(claim);
      if (claim.constraints.nonGeneralizable) {
        noGeneralize.push(claim);
      }
      if (claim.constraints.requiresCost.length > 0) {
        costRequired.push(claim);
      }
      if (claim.relations?.conflictsWith?.length && claim.relations.resolvesBy) {
        conflictResolve.push({ claim, resolvesBy: claim.relations.resolvesBy });
      }
    }
  }
  const revealIds = new Set(revealNow.map((claim) => claim.id));

  return {
    episodeNumber: ctx.episodeNumber,
    usable,
    revealNow,
    mustHide: mustHide.filter((claim) => !revealIds.has(claim.id)),
    noGeneralize,
    costRequired,
    conflictResolve,
  };
}

const SECTION_HEADERS: Record<keyof Pick<CompiledEpisodeClaims, "usable" | "revealNow" | "mustHide" | "noGeneralize" | "costRequired" | "conflictResolve">, string> = {
  usable: "## 本集可用设定（writer 可渲染）",
  revealNow: "## 本集计划揭示（允许转为前台信息）",
  mustHide: "## 本集必须隐藏（不得泄露）",
  noGeneralize: "## 不可泛化（主角例外不得给配角/组织/反派）",
  costRequired: "## 使用需付出代价",
  conflictResolve: "## 冲突解析",
};

function renderClaimLine(claim: CanonClaim): string {
  const tags = [
    claim.domain,
    claim.claimType,
    claim.authority.priority,
  ].join(" / ");
  return `- [${claim.id}] (${tags}) ${claim.content}`;
}

export function renderClaimBrief(compiled: CompiledEpisodeClaims, ctx: EpisodeClaimContext): string {
  const lines: string[] = [];
  lines.push(`# 本集设定工作集 — 第 ${compiled.episodeNumber} 集`);
  if (ctx.pov) lines.push(`\n视角：${ctx.pov}`);
  lines.push("");

  lines.push(SECTION_HEADERS.usable);
  if (compiled.usable.length === 0) lines.push("(无)");
  for (const claim of compiled.usable) lines.push(renderClaimLine(claim));

  lines.push("");
  lines.push(SECTION_HEADERS.revealNow);
  if (compiled.revealNow.length === 0) lines.push("(无)");
  for (const claim of compiled.revealNow) lines.push(renderClaimLine(claim));

  lines.push("");
  lines.push(SECTION_HEADERS.mustHide);
  if (compiled.mustHide.length === 0) lines.push("(无)");
  for (const claim of compiled.mustHide) lines.push(renderClaimLine(claim));

  lines.push("");
  lines.push(SECTION_HEADERS.noGeneralize);
  if (compiled.noGeneralize.length === 0) lines.push("(无)");
  for (const claim of compiled.noGeneralize) {
    const forbidden = claim.constraints.forbiddenUses.length
      ? ` 禁止：${claim.constraints.forbiddenUses.join("、")}`
      : "";
    lines.push(renderClaimLine(claim) + forbidden);
  }

  lines.push("");
  lines.push(SECTION_HEADERS.costRequired);
  if (compiled.costRequired.length === 0) lines.push("(无)");
  for (const claim of compiled.costRequired) {
    lines.push(renderClaimLine(claim) + ` 代价：${claim.constraints.requiresCost.join("、")}`);
  }

  lines.push("");
  lines.push(SECTION_HEADERS.conflictResolve);
  if (compiled.conflictResolve.length === 0) lines.push("(无)");
  for (const entry of compiled.conflictResolve) {
    lines.push(`- [${entry.claim.id}] 与 ${entry.claim.relations?.conflictsWith?.join("、") ?? "?"} 冲突 → 解析：${entry.resolvesBy}`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

export interface EpisodeClaimArtifactPaths {
  readonly claimsPath: string;
  readonly briefPath: string;
}

export async function saveEpisodeClaimArtifacts(
  bookDir: string,
  compiled: CompiledEpisodeClaims,
  ctx: EpisodeClaimContext,
): Promise<EpisodeClaimArtifactPaths> {
  const runtimeDir = join(bookDir, "story", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const slug = `episode-${String(ctx.episodeNumber).padStart(4, "0")}`;

  const claimsPath = join(runtimeDir, `${slug}.claims.json`);
  const briefPath = join(runtimeDir, `${slug}.claim-brief.md`);

  await Promise.all([
    writeFile(
      claimsPath,
      JSON.stringify(
        {
          episodeNumber: compiled.episodeNumber,
          usable: compiled.usable,
          revealNow: compiled.revealNow,
          mustHide: compiled.mustHide,
          noGeneralize: compiled.noGeneralize,
          costRequired: compiled.costRequired,
          conflictResolve: compiled.conflictResolve,
        },
        null,
        2,
      ),
      "utf-8",
    ),
    writeFile(briefPath, renderClaimBrief(compiled, ctx), "utf-8"),
  ]);

  return { claimsPath, briefPath };
}
