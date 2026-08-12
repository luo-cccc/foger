/**
 * Phase 2 — CanonExtractor.
 *
 * Pulls CanonClaim records out of the architect prose foundation (design
 * doc section 6.1). Primary path is an LLM call that emits structured
 * claims; the other canon projections are deterministically derived from the
 * foundation and extracted claims. If the LLM is unavailable or returns junk, a deterministic
 * heuristic fallback still produces a useful first-pass claim set so book
 * creation is never blocked (doc section 8 Phase 2: extractor degradation
 * must not block book creation, only record a warning).
 *
 * Sources:
 *   story/outline/story_frame.md  -> world objective rules / iron laws
 *   story/roles (one file per character) -> protagonist system + exceptions
 *   story/book_rules.md           -> hard prohibitions / protagonist locks
 *   story/outline/volume_map.md   -> volume-level goals / irreversible events
 */

import { z } from "zod";
import { BaseAgent } from "./base.js";
import type { LLMClient } from "../llm/provider.js";
import { readBookRules } from "./rules-reader.js";
import {
  readRoleCards,
  readStoryFrame,
  readVolumeMap,
} from "../utils/outline-paths.js";
import {
  CanonClaimSchema,
  ClaimsFileSchema,
  ProtagonistSystemSchema,
  SystemRelationSchema,
  WorldSystemSchema,
  type CanonClaim,
  type CanonDomain,
  type CanonClaimType,
  type ProtagonistSystem,
  type SystemRelation,
  type UnclaimedFactsFile,
  type WorldSystem,
} from "../models/canon.js";
import { loadClaimsFile, loadUnclaimedFacts, saveClaimsFile, saveUnclaimedFacts } from "../state/canon-store.js";
import { claimTextMatches } from "../utils/claim-gate.js";

/** Safe ceiling for a canon-extraction output call (min with model maxOutput). */
const CANON_EXTRACT_MAX_OUTPUT_TOKENS = 32768;

function extractOutputTokens(client: LLMClient): number {
  const modelMax = client.defaults?.maxTokens;
  if (!Number.isFinite(modelMax) || modelMax <= 0) return CANON_EXTRACT_MAX_OUTPUT_TOKENS;
  return Math.min(CANON_EXTRACT_MAX_OUTPUT_TOKENS, modelMax);
}

export interface ExtractedCanon {
  readonly claims: ReadonlyArray<CanonClaim>;
  readonly worldSystem: WorldSystem;
  readonly protagonistSystem: ProtagonistSystem | null;
  readonly systemRelations: SystemRelation | null;
  readonly warnings: ReadonlyArray<string>;
  readonly usedFallback: boolean;
}

export class CanonExtractor extends BaseAgent {
  get name(): string {
    return "canon-extractor";
  }

  async extract(bookDir: string, language: "zh" | "en" = "zh"): Promise<ExtractedCanon> {
    const [storyFrame, volumeMap, roleCards, bookRules] = await Promise.all([
      readStoryFrame(bookDir),
      readVolumeMap(bookDir),
      readRoleCards(bookDir),
      readBookRules(bookDir),
    ]);

    const protagonist = roleCards.find((r) => r.tier === "major");
    const deterministicBaseline = heuristicExtract({
      storyFrame,
      volumeMap,
      roleCards,
      prohibitions: bookRules?.rules.prohibitions ?? [],
      protagonistName: protagonist?.name ?? bookRules?.rules.protagonist?.name,
    });

    const extractionInput = {
      storyFrame,
      volumeMap,
      roleCards,
      prohibitions: bookRules?.rules.prohibitions ?? [],
      protagonistName: protagonist?.name ?? bookRules?.rules.protagonist?.name,
      language,
    };
    let result: ExtractedCanon;
    try {
      result = await this.extractWithLlm(extractionInput);
    } catch (firstError) {
      try {
        const retry = await this.extractWithLlm({
          ...extractionInput,
          retryAfterIncomplete: true,
        });
        if (!retry.usedFallback) {
          return enrichCompleteExtraction(deterministicBaseline, {
            ...retry,
            warnings: [
              ...retry.warnings,
              "Initial canon JSON was invalid; bounded retry returned a complete envelope.",
            ],
          });
        }
        const merged = mergeCanonExtractions(deterministicBaseline, retry);
        return {
          ...merged,
          warnings: [
            ...merged.warnings,
            "Initial canon extraction failed before salvage: "
              + (firstError instanceof Error ? firstError.message : String(firstError)),
          ],
        };
      } catch (retryError) {
        return {
          ...deterministicBaseline,
          usedFallback: true,
          warnings: [
            ...deterministicBaseline.warnings,
            "LLM canon extraction and bounded retry failed; used heuristic fallback: "
              + (firstError instanceof Error ? firstError.message : String(firstError))
              + "; retry: "
              + (retryError instanceof Error ? retryError.message : String(retryError)),
          ],
        };
      }
    }

    if (!result.usedFallback) return enrichCompleteExtraction(deterministicBaseline, result);
    try {
      const retry = await this.extractWithLlm({
        ...extractionInput,
        retryAfterIncomplete: true,
      });
      if (!retry.usedFallback) {
        return enrichCompleteExtraction(deterministicBaseline, {
          ...retry,
          warnings: [
            ...retry.warnings,
            "Initial canon JSON was incomplete; bounded retry returned a complete envelope.",
          ],
        });
      }
      return mergeCanonExtractions(
        deterministicBaseline,
        mergeCanonExtractions(result, retry),
      );
    } catch (retryError) {
      const merged = mergeCanonExtractions(deterministicBaseline, result);
      return {
        ...merged,
        warnings: [
          ...merged.warnings,
          "Canon bounded retry failed: "
            + (retryError instanceof Error ? retryError.message : String(retryError)),
        ],
      };
    }
  }

  /**
   * Explicit, user-triggered canon refresh: turn unclaimed episode facts into
   * new canon claims without duplicating existing ones. One LLM call; does
   * not touch worldSystem/protagonistSystem/systemRelations.
   *
   * Two-stage contract (borrowed from drama-skills short-drama-assets):
   * 1. occurrence — the model restates each fact verbatim with its episode
   *    evidence and marks ambiguous references as unresolved instead of
   *    guessing;
   * 2. decision — each occurrence gets exactly one of reuse / new_variant /
   *    new_asset / unresolved. reuse and unresolved never enter the claims
   *    file (unclaimed facts are kept for the next episode); costumes,
   *    injuries and other temporary states may only be new_variant, never a
   *    new identity. The deterministic layer enforces all of the above.
   */
  async refreshFromUnclaimed(
    bookDir: string,
    language: "zh" | "en" = "zh",
  ): Promise<{ readonly added: number; readonly claims: ReadonlyArray<CanonClaim> }> {
    const existingFile = await loadClaimsFile(bookDir);
    const existing = existingFile.claims;
    const unclaimed = await loadUnclaimedFacts(bookDir);
    const facts = unclaimed.facts.map((entry) => entry.fact).filter(Boolean);
    if (facts.length === 0) return { added: 0, claims: existing };

    const isEn = language === "en";
    const existingDigest = existing.length > 0
      ? existing.map((claim) => `- ${claim.id} [${claim.domain}/${claim.claimType}] ${claim.content}`).join("\n")
      : "(none)";
    const claimSpec = isEn
      ? "CanonClaim fields: id(string), domain(one of world|protagonist|character|organization|power|relationship|history|style), claimType(one of objective_rule|institution_rule|character_exception|belief|rumor|secret_truth|temporary_state|prohibition), content(string, under 140 chars), scope{appliesTo:string[]}, authority{source:string,priority:hard|strong|soft}, visibility{readerKnownFrom?:number,characterKnownBy:string[],hiddenFrom:string[]}, constraints?{nonGeneralizable?:boolean,requiresCost:string[],forbiddenUses:string[]}."
      : "CanonClaim 字段：id(字符串), domain(取 world|protagonist|character|organization|power|relationship|history|style), claimType(取 objective_rule|institution_rule|character_exception|belief|rumor|secret_truth|temporary_state|prohibition), content(字符串，不超过 140 字), scope{appliesTo:string[]}, authority{source:string,priority:hard|strong|soft}, visibility{readerKnownFrom?:数字,characterKnownBy:string[],hiddenFrom:string[]}, constraints?{nonGeneralizable?:布尔,requiresCost:string[],forbiddenUses:string[]}。";
    const system = isEn
      ? [
          "You are the InkOS canon registrar. Process the supplied unclaimed episode facts in two stages.",
          "Stage 1 (occurrence): restate each fact verbatim as the screenplay wrote it, with its source episode. If a fact contains a reference you cannot resolve from the fact itself (\"he\", \"that woman\", \"back then\"), set unresolvedReference=true — never guess.",
          "Stage 2 (decision): compare each occurrence against the existing claims and assign exactly one outcome:",
          "- reuse: already covered by an existing claim — do not register;",
          "- new_variant: a new state of the same identity/object (costume, injury, temporary state, location change all belong here) — register and supersede the old wording;",
          "- new_asset: a genuinely new durable fact — register;",
          "- unresolved: insufficient evidence or ambiguous reference — keep for the next episode, do not register.",
          'Return ONLY strict JSON: {"decisions":[{"fact":"verbatim wording","evidenceEpisode":number,"decision":"reuse|new_variant|new_asset|unresolved","unresolvedReference":boolean(optional),"claim":{...required only for new_variant/new_asset...}}]}.',
          claimSpec,
          "Rules: reuse/unresolved decisions must NOT carry a claim; costumes, injuries and temporary states may only be new_variant, never new_asset; do not invent mechanics absent from the facts; at most 8 registered claims.",
        ].join("\n")
      : [
          "你是 InkOS 的设定入库器。分两段处理下面提供的未认领剧集事实。",
          "第一段（occurrence）：逐条保持剧本的原始表述，标注来源集号；如果事实里有无法从事实本身解析的含混指代（“他”“那个女人”“当时”等），设 unresolvedReference=true，不要猜。",
          "第二段（decision）：把每条事实与既有 claims 比对，只给四种结论：",
          "- reuse：既有 claims 已覆盖该事实，不入库；",
          "- new_variant：同一身份/对象的新状态（服装、伤势、临时状态、位置变化都属此类），入库并取代旧表述；",
          "- new_asset：确属全新的持久事实，入库；",
          "- unresolved：证据不足或指代含混，保留待下集，不入库。",
          '只返回严格 JSON：{"decisions":[{"fact":"原文表述","evidenceEpisode":集号,"decision":"reuse|new_variant|new_asset|unresolved","unresolvedReference":布尔(可省),"claim":{...仅 new_variant/new_asset 必填...}}]}。',
          claimSpec,
          "规则：decision=reuse/unresolved 不得附带 claim；服装、伤势、临时状态只能 new_variant，不得 new_asset；不要发明事实里没有的机制；最多入库 8 条。",
        ].join("\n");
    const user = [
      isEn ? "## Existing claims (do not duplicate)" : "## 既有 claims（不要重复）",
      existingDigest,
      "",
      isEn ? "## Unclaimed episode facts to canonize" : "## 待入库的未认领剧集事实",
      facts.map((fact, index) => `${index + 1}. ${fact}`).join("\n"),
    ].join("\n");

    const response = await this.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.2, stream: false, callPhase: "canon-refresh", maxTokens: 4096 },
    );

    let decisions: ReadonlyArray<RefreshDecision>;
    try {
      decisions = parseRefreshDecisions(response.content);
    } catch {
      return { added: 0, claims: existing };
    }
    const applied = applyRefreshDecisions(existing, decisions);
    // Prune settled facts from the unclaimed pool: reuse / new_variant /
    // new_asset are decided and must not be re-submitted on every refresh;
    // only unresolved (or model-dropped) facts stay for the next episode.
    await pruneSettledUnclaimedFacts(bookDir, unclaimed, decisions);
    if (applied.added === 0 && applied.superseded === 0) return { added: 0, claims: existing };
    await saveClaimsFile(bookDir, { claims: applied.claims });
    return { added: applied.added, claims: applied.claims };
  }

  private async extractWithLlm(input: {
    storyFrame: string;
    volumeMap: string;
    roleCards: ReadonlyArray<{ name: string; tier: string; content: string }>;
    prohibitions: ReadonlyArray<string>;
    protagonistName?: string;
    language: "zh" | "en";
    retryAfterIncomplete?: boolean;
  }): Promise<ExtractedCanon> {
    const isEn = input.language === "en";
    const system = isEn
      ? [
          "You are InkOS canon extractor. Read the prose foundation and emit ONLY strict JSON.",
          'Return one JSON object with exactly one top-level key: "claims" (array). Do not output worldSystem, protagonistSystem, systemRelations, schema placeholders, or commentary; InkOS derives those projections deterministically.',
          "CanonClaim fields: id(string), domain(one of world|protagonist|character|organization|power|relationship|history|style), claimType(one of objective_rule|institution_rule|character_exception|belief|rumor|secret_truth|temporary_state|prohibition), content(string), scope{appliesTo:string[],excludes?,geography?,timeRange?}, authority{source:string,priority:hard|strong|soft}, visibility{readerKnownFrom?:number,characterKnownBy:string[],hiddenFrom:string[]}, relations?{conflictsWith?:string[],resolvesBy?:string,dependsOn?:string[]}, constraints?{nonGeneralizable?:boolean,requiresCost:string[],forbiddenUses:string[]}.",
          "Defaults matter: character_exception MUST set constraints.nonGeneralizable=true unless content explains a generalization. secret_truth MUST set a visibility boundary. Extract objective world rules as objective_rule with priority hard; book prohibitions as prohibition with priority hard.",
          "Style/POV/terminology constraints use domain=style, are always visible (no readerKnownFrom or hiddenFrom), and never require a story-world cost. Set requiresCost only for an actively exercised ability or rule with a direct on-page cost, never for merely discovering or mentioning a fact, organization, or system.",
          "Keep the JSON bounded: output at most 6 high-value claims, keep each content field under 140 characters, omit decorative details and temporary flavor, and always close the claims array and JSON object. Prioritize objective rules, prohibitions, protagonist exceptions, institutional rules, and secret truths.",
          ...(input.retryAfterIncomplete
            ? ["RETRY AFTER INCOMPLETE JSON: reduce the claim count if needed and close every array and object. Return one complete JSON envelope, not commentary."]
            : []),
        ].join("\n")
      : [
          "你是 InkOS 的设定抽取器。读取散文基础设定，只输出严格 JSON。",
          '返回一个 JSON 对象，顶层只允许一个字段："claims"（数组）。禁止输出 worldSystem、protagonistSystem、systemRelations、模式占位符或解释；InkOS 会确定性生成这些投影。',
          "CanonClaim 字段：id(字符串), domain(取 world|protagonist|character|organization|power|relationship|history|style 之一), claimType(取 objective_rule|institution_rule|character_exception|belief|rumor|secret_truth|temporary_state|prohibition 之一), content(字符串), scope{appliesTo:string[],excludes?,geography?,timeRange?}, authority{source:string,priority:hard|strong|soft}, visibility{readerKnownFrom?:数字,characterKnownBy:string[],hiddenFrom:string[]}, relations?{conflictsWith?:string[],resolvesBy?:string,dependsOn?:string[]}, constraints?{nonGeneralizable?:布尔,requiresCost:string[],forbiddenUses:string[]}。",
          "默认值很重要：character_exception 必须设置 constraints.nonGeneralizable=true（除非 content 解释可泛化条件）；secret_truth 必须设置可见性边界；世界客观规则抽成 objective_rule 且 priority=hard；本书禁令抽成 prohibition 且 priority=hard。",
          "叙事视角、文风、术语等写作约束必须使用 domain=style，始终可见（不设 readerKnownFrom / hiddenFrom），也不绑定故事世界代价。requiresCost 只用于角色实际施展能力或绕过规则时必然支付的直接代价，不能用于单纯发现或提及某个事实、组织或系统。",
          "控制 JSON 规模：最多输出 6 条高价值 claim，每条 content 不超过 140 字；省略装饰性细节和临时风味，必须闭合 claims 数组和 JSON 对象。优先抽取客观规则、禁令、主角例外、制度规则和秘密真相。",
          ...(input.retryAfterIncomplete
            ? ["这是不完整 JSON 后的重试：必要时继续减少 claim 数量，闭合所有数组和对象，只返回一个完整 JSON，不要解释。"]
            : []),
        ].join("\n");

    const roleBlock = input.roleCards
      .map((r) => "### " + r.name + " (" + r.tier + ")\n" + r.content)
      .join("\n\n");
    const user = [
      isEn ? "## Story frame" : "## 故事框架",
      input.storyFrame || "(none)",
      isEn ? "## Volume map" : "## 卷纲",
      input.volumeMap || "(none)",
      isEn ? "## Character cards" : "## 角色卡",
      roleBlock || "(none)",
      isEn ? "## Book prohibitions" : "## 本书禁令",
      input.prohibitions.join("\n") || "(none)",
    ].join("\n\n");

    const extra = canonCallExtra(this.ctx.client, this.ctx.model);
    const response = await this.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        temperature: 0.2,
        maxTokens: extractOutputTokens(this.ctx.client),
        stream: false,
        callPhase: "extract",
        ...(extra ? { extra } : {}),
      },
    );

    return parseLlmCanon(response.content);
  }
}

function canonCallExtra(client: LLMClient, model: string): Record<string, unknown> | undefined {
  const service = client.service?.toLowerCase() ?? "";
  const baseUrl = client._piModel?.baseUrl?.toLowerCase() ?? "";
  const isOpenRouter = service === "openrouter" || baseUrl.includes("openrouter.ai");
  if (!isOpenRouter || model.toLowerCase() !== "deepseek/deepseek-v4-flash") return undefined;
  return {
    response_format: { type: "json_object" },
    reasoning: { effort: "none" },
    include_reasoning: false,
  };
}

function parseLlmCanon(raw: string): ExtractedCanon {
  try {
    const json = normalizeLlmCanonEnvelope(extractJson(raw));
    const llmSchema = z.object({
      claims: z.array(CanonClaimSchema),
      worldSystem: WorldSystemSchema.optional(),
      protagonistSystem: ProtagonistSystemSchema.nullable().optional(),
      systemRelations: SystemRelationSchema.nullable().optional(),
    });
    const parsed = llmSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("LLM canon output failed schema validation: " + parsed.error.message);
    }

    const claims = (parsed.data.claims ?? []).map((c) => normalizeExtractedClaim(CanonClaimSchema.parse(c)));
    return {
      claims,
      worldSystem: parsed.data.worldSystem ?? worldSystemFromClaims(claims),
      protagonistSystem: parsed.data.protagonistSystem ?? null,
      systemRelations: parsed.data.systemRelations ?? null,
      warnings: [],
      usedFallback: false,
    };
  } catch (error) {
    const claims = salvageCompleteClaims(raw);
    if (claims.length === 0) throw error;
    return {
      claims,
      worldSystem: worldSystemFromClaims(claims),
      protagonistSystem: null,
      systemRelations: null,
      warnings: [
        `LLM canon JSON was incomplete; recovered ${claims.length} complete claim objects instead of discarding the full extraction.`,
      ],
      usedFallback: true,
    };
  }
}

type RefreshDecisionKind = "reuse" | "new_variant" | "new_asset" | "unresolved";

interface RefreshDecision {
  readonly fact: string;
  readonly decision: RefreshDecisionKind;
  readonly evidenceEpisode?: number;
  readonly unresolvedReference?: boolean;
  readonly claim?: CanonClaim;
}

/**
 * Parse the two-stage refresh envelope. Accepts the new {"decisions":[...]}
 * contract and the legacy {"claims":[...]} envelope (treated as all
 * new_asset) so a model that ignores the new instructions still degrades to
 * the old behavior instead of failing the whole refresh.
 */
function parseRefreshDecisions(raw: string): ReadonlyArray<RefreshDecision> {
  const json = extractJson(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Canon refresh output is not a JSON object");
  }
  const root = json as Record<string, unknown>;

  if (Array.isArray(root.decisions)) {
    const decisions: RefreshDecision[] = [];
    for (const entry of root.decisions) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const fact = typeof record.fact === "string" ? record.fact.trim() : "";
      if (!fact) continue;
      const kind = record.decision;
      const decision: RefreshDecisionKind = kind === "reuse" || kind === "new_variant"
        || kind === "new_asset" || kind === "unresolved"
        ? kind
        : "unresolved";
      const claimCandidate = record.claim;
      const parsedClaim = claimCandidate && typeof claimCandidate === "object"
        ? CanonClaimSchema.safeParse(claimCandidate)
        : undefined;
      decisions.push({
        fact,
        decision,
        ...(typeof record.evidenceEpisode === "number" && Number.isInteger(record.evidenceEpisode)
          ? { evidenceEpisode: record.evidenceEpisode }
          : {}),
        ...(record.unresolvedReference === true ? { unresolvedReference: true } : {}),
        ...(parsedClaim?.success ? { claim: normalizeExtractedClaim(parsedClaim.data) } : {}),
      });
    }
    return decisions;
  }

  if (Array.isArray(root.claims)) {
    const decisions: RefreshDecision[] = [];
    for (const entry of root.claims) {
      const parsedClaim = CanonClaimSchema.safeParse(entry);
      if (!parsedClaim.success) continue;
      const claim = normalizeExtractedClaim(parsedClaim.data);
      decisions.push({ fact: claim.content, decision: "new_asset", claim });
    }
    return decisions;
  }

  throw new Error("Canon refresh output has neither decisions nor claims");
}

/**
 * Remove decided facts from the unclaimed pool after a refresh. Matching is
 * verbatim-only by design: a paraphrased decision never evicts a fact, so an
 * uncertain eviction can only keep a fact (resubmitted next time), never
 * silently lose it.
 */
async function pruneSettledUnclaimedFacts(
  bookDir: string,
  unclaimed: UnclaimedFactsFile,
  decisions: ReadonlyArray<RefreshDecision>,
): Promise<void> {
  const decisionByFact = new Map(decisions.map((decision) => [decision.fact, decision]));
  const kept = unclaimed.facts.filter((entry) => {
    const decision = decisionByFact.get(entry.fact);
    if (!decision) return true; // model dropped it — keep for the next episode
    return decision.decision === "unresolved" || decision.unresolvedReference === true;
  });
  if (kept.length === unclaimed.facts.length) return;
  await saveUnclaimedFacts(bookDir, {
    version: 1,
    updatedAt: new Date().toISOString(),
    facts: kept,
  });
}

/**
 * Deterministic decision stage enforcement:
 * - reuse / unresolved / unresolvedReference never touch the claims file;
 * - temporary states (costume, injury, temporary_state) are coerced to
 *   new_variant — they must never found a new identity;
 * - new_variant supersedes the existing claim(s) its content matches and is
 *   added as the active wording;
 * - new_asset goes through the usual duplicate guards.
 */
function applyRefreshDecisions(
  existing: ReadonlyArray<CanonClaim>,
  decisions: ReadonlyArray<RefreshDecision>,
): { readonly claims: CanonClaim[]; readonly added: number; readonly superseded: number } {
  const result: CanonClaim[] = [...existing];
  const usedIds = new Set(result.map((claim) => claim.id));
  const claimedContent = new Set(result.map((claim) => claim.content.trim()).filter(Boolean));
  let added = 0;
  let superseded = 0;
  const nextId = (): string => {
    let id = `refresh-${String(added + 1).padStart(3, "0")}`;
    while (usedIds.has(id)) {
      added += 1;
      id = `refresh-${String(added + 1).padStart(3, "0")}`;
    }
    usedIds.add(id);
    return id;
  };

  for (const entry of decisions) {
    if (!entry.claim) continue;
    if (entry.unresolvedReference || entry.decision === "unresolved" || entry.decision === "reuse") {
      continue;
    }
    const effectiveDecision = entry.decision === "new_asset" && entry.claim.claimType === "temporary_state"
      ? "new_variant" as const
      : entry.decision;
    const content = entry.claim.content.trim();
    if (!content || claimedContent.has(content)) continue;

    if (effectiveDecision === "new_variant") {
      for (let index = 0; index < result.length; index += 1) {
        const old = result[index]!;
        if (old.status !== "active") continue;
        if (!claimTextMatches(content, old.content) && !claimTextMatches(old.content, content)) continue;
        result[index] = {
          ...old,
          status: "superseded",
          ...(entry.evidenceEpisode ? { statusUpdatedAtEpisode: entry.evidenceEpisode } : {}),
        };
        superseded += 1;
      }
    } else if (result.some((existingClaim) =>
      claimTextMatches(content, existingClaim.content) || claimTextMatches(existingClaim.content, content),
    )) {
      continue;
    }

    const id = entry.claim.id && !usedIds.has(entry.claim.id) ? entry.claim.id : nextId();
    usedIds.add(id);
    claimedContent.add(content);
    result.push({ ...entry.claim, id, status: "active" });
    added += 1;
  }
  return { claims: result, added, superseded };
}

function worldSystemFromClaims(claims: ReadonlyArray<CanonClaim>): WorldSystem {
  return WorldSystemSchema.parse({
    objectiveRules: claims
      .filter((claim) => claim.claimType === "objective_rule")
      .map((claim) => claim.content),
    taboos: claims
      .filter((claim) => claim.claimType === "prohibition")
      .map((claim) => claim.content),
  });
}

function enrichCompleteExtraction(
  baseline: ExtractedCanon,
  extracted: ExtractedCanon,
): ExtractedCanon {
  return {
    ...extracted,
    worldSystem: WorldSystemSchema.parse({
      ...baseline.worldSystem,
      objectiveRules: [...new Set([
        ...baseline.worldSystem.objectiveRules,
        ...extracted.worldSystem.objectiveRules,
      ])],
      taboos: [...new Set([
        ...baseline.worldSystem.taboos,
        ...extracted.worldSystem.taboos,
      ])],
    }),
    protagonistSystem: extracted.protagonistSystem ?? baseline.protagonistSystem,
    systemRelations: extracted.systemRelations ?? baseline.systemRelations,
    usedFallback: false,
  };
}

function mergeCanonExtractions(
  baseline: ExtractedCanon,
  recovered: ExtractedCanon,
): ExtractedCanon {
  const claims = [...baseline.claims];
  const seenIds = new Set(claims.map((claim) => claim.id));
  const seenContent = new Set(claims.map((claim) => `${claim.claimType}:${claim.content}`));
  for (const claim of recovered.claims) {
    const contentKey = `${claim.claimType}:${claim.content}`;
    if (seenIds.has(claim.id) || seenContent.has(contentKey)) continue;
    seenIds.add(claim.id);
    seenContent.add(contentKey);
    claims.push(claim);
  }
  const objectiveRules = [...new Set([
    ...baseline.worldSystem.objectiveRules,
    ...recovered.worldSystem.objectiveRules,
  ])];
  const taboos = [...new Set([
    ...baseline.worldSystem.taboos,
    ...recovered.worldSystem.taboos,
  ])];
  return {
    claims,
    worldSystem: WorldSystemSchema.parse({
      ...baseline.worldSystem,
      objectiveRules,
      taboos,
    }),
    protagonistSystem: recovered.protagonistSystem ?? baseline.protagonistSystem,
    systemRelations: recovered.systemRelations ?? baseline.systemRelations,
    warnings: [...baseline.warnings, ...recovered.warnings],
    usedFallback: true,
  };
}

function salvageCompleteClaims(raw: string): CanonClaim[] {
  const claimsKey = raw.search(/"claims"\s*:/i);
  if (claimsKey < 0) return [];
  const arrayStart = raw.indexOf("[", claimsKey);
  if (arrayStart < 0) return [];

  const claims: CanonClaim[] = [];
  const seenIds = new Set<string>();
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart + 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || objectStart < 0) continue;
    try {
      const candidate = JSON.parse(raw.slice(objectStart, index + 1));
      const parsed = CanonClaimSchema.safeParse(candidate);
      if (parsed.success && !seenIds.has(parsed.data.id)) {
        seenIds.add(parsed.data.id);
        claims.push(normalizeExtractedClaim(parsed.data));
      }
    } catch {
      // Skip malformed individual objects and keep scanning for later complete claims.
    }
    objectStart = -1;
  }
  return claims;
}

const STYLE_CLAIM_PATTERN = /叙事视角|第一人称|第三人称|有限视角|上帝视角|叙事人称|文风|措辞|术语|point of view|\bpov\b|narrative perspective|terminology|prose style/iu;
const SPECULATIVE_COST_PATTERN = /可能|也许|或许|大概|未必|may\b|might\b|could\b|possibly|perhaps/iu;

function normalizeExtractedClaim(claim: CanonClaim): CanonClaim {
  const normalized = STYLE_CLAIM_PATTERN.test(claim.content)
    ? {
        ...claim,
        domain: "style" as const,
        scope: { ...claim.scope, appliesTo: ["all"] },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { ...claim.constraints, requiresCost: [] },
      }
    : {
        ...claim,
        constraints: {
          ...claim.constraints,
          requiresCost: claim.constraints.requiresCost.filter(
            (cost) => !SPECULATIVE_COST_PATTERN.test(cost),
          ),
        },
      };
  return CanonClaimSchema.parse(normalized);
}

function normalizeLlmCanonEnvelope(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;

  const root = { ...(input as Record<string, unknown>) };
  if (Array.isArray(root.protagonistSystem)
    || (root.protagonistSystem && typeof root.protagonistSystem === "object"
      && typeof (root.protagonistSystem as Record<string, unknown>).name !== "string")) {
    root.protagonistSystem = null;
  }
  if (Array.isArray(root.systemRelations)
    || (root.systemRelations && typeof root.systemRelations === "object"
      && typeof (root.systemRelations as Record<string, unknown>).mode !== "string")) {
    root.systemRelations = null;
  }
  return root;
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenceMatch = /^(?:```(?:json)?\s*\n)?([\s\S]*?)(?:\n```)?\s*$/.exec(trimmed);
  const body = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    return JSON.parse(body.trim());
  } catch {
    const candidates = extractCompleteJsonObjects(body);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
          && Object.hasOwn(parsed, "claims")) {
          return parsed;
        }
      } catch {
        // Keep scanning: a later complete object may be the requested envelope.
      }
    }
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error("No JSON object found in LLM canon output");
  }
}

function extractCompleteJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      starts.push(index);
      continue;
    }
    if (char !== "}" || starts.length === 0) continue;
    const start = starts.pop()!;
    objects.push(raw.slice(start, index + 1));
  }

  return objects;
}

function heuristicExtract(input: {
  storyFrame: string;
  volumeMap: string;
  roleCards: ReadonlyArray<{ name: string; tier: string; content: string }>;
  prohibitions: ReadonlyArray<string>;
  protagonistName?: string;
}): ExtractedCanon {
  const claims: CanonClaim[] = [];
  const warnings: string[] = [];
  let idx = 0;
  const nextId = (prefix: string): string => prefix + "-" + String(++idx).padStart(3, "0");

  const worldRules = scanRuleLines(input.storyFrame, ["铁律", "规则", "客观规则", "iron law", "objective rule"]);
  for (const rule of worldRules) {
    claims.push(makeClaim(nextId("world"), "world", "objective_rule", rule, "hard", ["all"]));
  }

  for (const prohibition of input.prohibitions) {
    if (!prohibition.trim()) continue;
    claims.push(makeClaim(nextId("prohibit"), "world", "prohibition", prohibition, "hard", ["all"]));
  }

  const major = input.roleCards.find((r) => r.tier === "major");
  if (major && input.protagonistName) {
    const exceptionality = scanFirstSection(major.content, ["特殊", "例外", "异常", "exception", "special"]);
    if (exceptionality) {
      claims.push(CanonClaimSchema.parse({
        id: nextId("prot"),
        domain: "protagonist",
        claimType: "character_exception",
        content: exceptionality,
        scope: { appliesTo: [input.protagonistName] },
        authority: { source: "roles/" + input.protagonistName, priority: "strong" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { nonGeneralizable: true, requiresCost: [], forbiddenUses: [] },
      }));
    }
  }

  const worldSystem = WorldSystemSchema.parse({
    objectiveRules: worldRules,
    taboos: input.prohibitions,
  });
  const protagonistSystem: ProtagonistSystem | null = major
    ? ProtagonistSystemSchema.parse({
        name: input.protagonistName ?? major.name,
        exceptionality: scanFirstSection(major.content, ["特殊", "例外", "exception"]) ?? "",
        entryPoint: scanFirstSection(major.content, ["现状", "起点", "current", "entry"]) ?? "",
        growthPath: scanFirstSection(major.content, ["成长", "路径", "growth"]) ?? "",
        nonGeneralizable: [scanFirstSection(major.content, ["特殊", "例外", "exception"]) ?? ""].filter(
          Boolean,
        ),
      })
    : null;
  const systemRelations = SystemRelationSchema.parse({
    mode: "hybrid",
    conflictPoints: [],
    nonGeneralizable: [],
    auditRules: ["主角例外不得泛化为世界通用规则", "主角绕开规则不等于规则失效"],
  });

  if (claims.length === 0) {
    warnings.push("Heuristic canon extraction found no claims; canon is empty for this book.");
  }

  return {
    claims,
    worldSystem,
    protagonistSystem,
    systemRelations,
    warnings,
    usedFallback: true,
  };
}

function makeClaim(
  id: string,
  domain: CanonDomain,
  claimType: CanonClaimType,
  content: string,
  priority: "hard" | "strong" | "soft",
  appliesTo: ReadonlyArray<string>,
): CanonClaim {
  return CanonClaimSchema.parse({
    id,
    domain,
    claimType,
    content,
    scope: { appliesTo: [...appliesTo] },
    authority: { source: "story_frame", priority },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
  });
}

function scanRuleLines(text: string, headingKeywords: ReadonlyArray<string>): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inRuleBlock = false;
  const headingRe = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
  for (const line of lines) {
    const heading = headingRe.exec(line)?.[1];
    if (heading) {
      inRuleBlock = headingKeywords.some((kw) => heading.toLowerCase().includes(kw.toLowerCase()));
      continue;
    }
    if (!inRuleBlock) continue;
    const item = line.trim();
    if (/^[-*]\s+/.test(item)) out.push(item.replace(/^[-*]\s+/, "").trim());
    else if (item.length > 6 && !/^#/.test(item)) out.push(item);
  }
  return out.filter((v) => v.length > 0).slice(0, 40);
}

function scanFirstSection(text: string, headingKeywords: ReadonlyArray<string>): string | null {
  const lines = text.split(/\r?\n/);
  let collecting = false;
  const out: string[] = [];
  const headingRe = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
  for (const line of lines) {
    const heading = headingRe.exec(line)?.[1];
    if (heading) {
      if (collecting) break;
      collecting = headingKeywords.some((kw) => heading.toLowerCase().includes(kw.toLowerCase()));
      continue;
    }
    if (collecting && line.trim()) out.push(line.trim());
  }
  const joined = out.join(" ").trim();
  return joined.length > 0 ? joined : null;
}
