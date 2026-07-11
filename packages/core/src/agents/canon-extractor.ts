/**
 * Phase 2 — CanonExtractor.
 *
 * Pulls CanonClaim records out of the architect prose foundation (design
 * doc section 6.1). Primary path is an LLM call that emits structured
 * claims; if the LLM is unavailable or returns junk, a deterministic
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

    try {
      const result = await this.extractWithLlm({
        storyFrame,
        volumeMap,
        roleCards,
        prohibitions: bookRules?.rules.prohibitions ?? [],
        protagonistName: protagonist?.name ?? bookRules?.rules.protagonist?.name,
        language,
      });
      return { ...result, usedFallback: false };
    } catch (error) {
      const fallback = heuristicExtract({
        storyFrame,
        volumeMap,
        roleCards,
        prohibitions: bookRules?.rules.prohibitions ?? [],
        protagonistName: protagonist?.name ?? bookRules?.rules.protagonist?.name,
      });
      return {
        ...fallback,
        usedFallback: true,
        warnings: [
          ...fallback.warnings,
          "LLM canon extraction failed, used heuristic fallback: " +
            (error instanceof Error ? error.message : String(error)),
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
  }): Promise<ExtractedCanon> {
    const isEn = input.language === "en";
    const system = isEn
      ? [
          "You are InkOS canon extractor. Read the prose foundation and emit ONLY strict JSON.",
          'Return {"claims":[CanonClaim...],"worldSystem":{...},"protagonistSystem":{...}|null,"systemRelations":{...}|null}.',
          "CanonClaim fields: id(string), domain(one of world|protagonist|character|organization|power|relationship|history|style), claimType(one of objective_rule|institution_rule|character_exception|belief|rumor|secret_truth|temporary_state|prohibition), content(string), scope{appliesTo:string[],excludes?,geography?,timeRange?}, authority{source:string,priority:hard|strong|soft}, visibility{readerKnownFrom?:number,characterKnownBy:string[],hiddenFrom:string[]}, relations?{conflictsWith?:string[],resolvesBy?:string,dependsOn?:string[]}, constraints?{nonGeneralizable?:boolean,requiresCost:string[],forbiddenUses:string[]}.",
          "Defaults matter: character_exception MUST set constraints.nonGeneralizable=true unless content explains a generalization. secret_truth MUST set a visibility boundary. Extract objective world rules as objective_rule with priority hard; book prohibitions as prohibition with priority hard.",
        ].join("\n")
      : [
          "你是 InkOS 的设定抽取器。读取散文基础设定，只输出严格 JSON。",
          '返回 {"claims":[CanonClaim...],"worldSystem":{...},"protagonistSystem":{...}|null,"systemRelations":{...}|null}。',
          "CanonClaim 字段：id(字符串), domain(取 world|protagonist|character|organization|power|relationship|history|style 之一), claimType(取 objective_rule|institution_rule|character_exception|belief|rumor|secret_truth|temporary_state|prohibition 之一), content(字符串), scope{appliesTo:string[],excludes?,geography?,timeRange?}, authority{source:string,priority:hard|strong|soft}, visibility{readerKnownFrom?:数字,characterKnownBy:string[],hiddenFrom:string[]}, relations?{conflictsWith?:string[],resolvesBy?:string,dependsOn?:string[]}, constraints?{nonGeneralizable?:布尔,requiresCost:string[],forbiddenUses:string[]}。",
          "默认值很重要：character_exception 必须设置 constraints.nonGeneralizable=true（除非 content 解释可泛化条件）；secret_truth 必须设置可见性边界；世界客观规则抽成 objective_rule 且 priority=hard；本书禁令抽成 prohibition 且 priority=hard。",
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

    const response = await this.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.2, maxTokens: 8192 },
    );

    return parseLlmCanon(response.content);
  }
}

function parseLlmCanon(raw: string): ExtractedCanon {
  const json = extractJson(raw);
  const llmSchema = z.object({
    claims: z.array(CanonClaimSchema).optional(),
    worldSystem: WorldSystemSchema.optional(),
    protagonistSystem: ProtagonistSystemSchema.nullable().optional(),
    systemRelations: SystemRelationSchema.nullable().optional(),
  });
  const parsed = llmSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("LLM canon output failed schema validation: " + parsed.error.message);
  }

  const claims = (parsed.data.claims ?? []).map((c) => CanonClaimSchema.parse(c));
  return {
    claims,
    worldSystem: parsed.data.worldSystem ?? WorldSystemSchema.parse({}),
    protagonistSystem: parsed.data.protagonistSystem ?? null,
    systemRelations: parsed.data.systemRelations ?? null,
    warnings: [],
    usedFallback: false,
  };
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenceMatch = /^(?:```(?:json)?\s*\n)?([\s\S]*?)(?:\n```)?\s*$/.exec(trimmed);
  const body = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    return JSON.parse(body.trim());
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1));
    }
    throw new Error("No JSON object found in LLM canon output");
  }
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
