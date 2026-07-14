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
  type WorldSystem,
} from "../models/canon.js";

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
        maxTokens: 8192,
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
      claims.push({
        id: nextId("prot"),
        domain: "protagonist",
        claimType: "character_exception",
        content: exceptionality,
        scope: { appliesTo: [input.protagonistName] },
        authority: { source: "roles/" + input.protagonistName, priority: "strong" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
        constraints: { nonGeneralizable: true, requiresCost: [], forbiddenUses: [] },
      });
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
  return {
    id,
    domain,
    claimType,
    content,
    scope: { appliesTo: [...appliesTo] },
    authority: { source: "story_frame", priority },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
  };
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
