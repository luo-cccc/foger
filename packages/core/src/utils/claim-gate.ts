import type { AuditIssue } from "../agents/continuity.js";
import type { CanonClaim } from "../models/canon.js";
import type { CompiledChapterClaims } from "./chapter-claim-compiler.js";

export type ClaimGateIssue = AuditIssue;

export interface ClaimGateTextInput {
  readonly text: string;
  readonly compiled: CompiledChapterClaims;
  readonly phase: "pre" | "post";
}

export function runPreWriteClaimGate(input: ClaimGateTextInput): ReadonlyArray<ClaimGateIssue> {
  return runClaimGate(input);
}

export function runPostWriteClaimGate(input: ClaimGateTextInput): ReadonlyArray<ClaimGateIssue> {
  return runClaimGate(input);
}

export function detectVisibleRevealClaimIds(input: Pick<ClaimGateTextInput, "text" | "compiled">): string[] {
  return input.compiled.revealNow
    .filter((claim) => makesRevealObservable(input.text, claim))
    .map((claim) => claim.id);
}

function runClaimGate(input: ClaimGateTextInput): ReadonlyArray<ClaimGateIssue> {
  const issues: ClaimGateIssue[] = [];
  const text = normalizeText(input.text);

  for (const claim of input.compiled.mustHide) {
    if (textMentionsClaim(text, claim)) {
      const characterKnowledgeLeak = detectCharacterKnowledgeLeak(input.text, claim);
      issues.push(issue({
        severity: "critical",
        category: characterKnowledgeLeak ? "claim-character-knowledge-leak" : "claim-hidden-leak",
        claim,
        phase: input.phase,
        description: characterKnowledgeLeak
          ? `Text appears to give a hidden canon claim "${claim.id}" to a character who should not know it.`
          : input.phase === "pre"
            ? `Chapter memo references hidden canon claim "${claim.id}" before it is available.`
            : `Chapter prose appears to reveal hidden canon claim "${claim.id}" before it is available.`,
        suggestion: characterKnowledgeLeak
          ? "Keep the character's knowledge within the declared visibility boundary, or make this chapter an explicit reveal."
          : "Remove the hidden fact from this chapter or move it into an explicit reveal plan.",
      }));
    }
  }

  if (input.phase === "pre") {
    for (const claim of input.compiled.revealNow) {
      issues.push(issue({
        severity: "warning",
        category: "claim-reveal-planned",
        claim,
        phase: input.phase,
        description: `Chapter memo plans to reveal canon claim "${claim.id}" this chapter.`,
        suggestion: "Make the reveal explicit, paid off on-page, and keep unrevealed adjacent facts hidden.",
      }));
    }
  }

  if (input.phase === "post") {
    for (const claim of input.compiled.revealNow) {
      if (makesRevealObservable(input.text, claim)) continue;
      issues.push(issue({
        severity: "warning",
        category: "claim-reveal-missing",
        claim,
        phase: input.phase,
        description: `Chapter memo planned to reveal canon claim "${claim.id}", but the draft does not make that reveal observable on-page.`,
        suggestion: "Either stage the reveal explicitly in prose, or revise the chapter memo so this canon fact is not promised for this chapter.",
      }));
    }
  }

  for (const claim of input.compiled.usable) {
    if (claim.claimType === "prohibition" && textMentionsClaim(text, claim)) {
      issues.push(issue({
        severity: "critical",
        category: "claim-prohibition",
        claim,
        phase: input.phase,
        description: `Text appears to invoke prohibited canon claim "${claim.id}".`,
        suggestion: "Delete or rewrite the prohibited element; hard prohibitions cannot be bypassed by chapter prose.",
      }));
    }

    if (claim.claimType === "institution_rule" && detectsInstitutionRuleBypass(input.text, claim)) {
      issues.push(issue({
        severity: input.phase === "pre" ? "warning" : "critical",
        category: "claim-institution-rule-bypass",
        claim,
        phase: input.phase,
        description: `Text appears to bypass institution rule "${claim.id}" without an on-page cause or consequence.`,
        suggestion: "Show the authorization, loophole, penalty, or explicit rule change that makes the institution rule fail here.",
      }));
    }

    if (claim.claimType === "objective_rule" && claim.authority.priority === "hard" && detectsHardRuleBypass(input.text, claim)) {
      issues.push(issue({
        severity: input.phase === "pre" ? "warning" : "critical",
        category: "claim-hard-rule-bypass",
        claim,
        phase: input.phase,
        description: `Text appears to bypass hard world rule "${claim.id}" without paying its declared cost or consequence.`,
        suggestion: claim.constraints.requiresCost.length > 0
          ? `Make the required consequence visible: ${claim.constraints.requiresCost.join(" / ")}`
          : "Keep the hard rule intact, or add an explicit canon-level exception before bypassing it.",
      }));
    }
  }

  for (const claim of input.compiled.noGeneralize) {
    const forbiddenUse = claim.constraints.forbiddenUses.find((use) => text.includes(normalizeText(use)));
    const excludedTarget = claim.scope.excludes?.find((target) => text.includes(normalizeText(target)));
    const generalizationSignal = /配角|反派|组织|所有人|人人|其他人|弟子都|everyone|anyone|all\s+characters/i.test(input.text);
    const claimMentioned = textMentionsClaim(text, claim);
    if (!claimMentioned && !forbiddenUse) continue;
    if (forbiddenUse || (claimMentioned && (excludedTarget || generalizationSignal))) {
      issues.push(issue({
        severity: "critical",
        category: "claim-non-generalizable",
        claim,
        phase: input.phase,
        description: `Text risks generalizing non-generalizable canon claim "${claim.id}".`,
        suggestion: "Keep the exception scoped to its declared subject; do not grant it to side characters, organizations, or the world at large.",
      }));
    }
  }

  for (const claim of input.compiled.costRequired) {
    if (!textMentionsClaim(text, claim) && !mentionsRuleSubjectOrAction(input.text, claim)) continue;
    const paysCost = claim.constraints.requiresCost.some((cost) => text.includes(normalizeText(cost)));
    if (!paysCost) {
      issues.push(issue({
        severity: input.phase === "pre" ? "warning" : "critical",
        category: "claim-cost-missing",
        claim,
        phase: input.phase,
        description: `Text uses cost-bound canon claim "${claim.id}" without mentioning its required cost.`,
        suggestion: `Make the cost visible: ${claim.constraints.requiresCost.join(" / ")}`,
      }));
    }
  }

  return issues;
}

function issue(params: {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly claim: CanonClaim;
  readonly phase: "pre" | "post";
  readonly description: string;
  readonly suggestion: string;
}): ClaimGateIssue {
  return {
    severity: params.severity,
    category: params.category,
    description: `[${params.phase}-write claim gate] ${params.description} Claim: ${params.claim.content}`,
    suggestion: params.suggestion,
    repairScope: "local",
  };
}

function textMentionsClaim(text: string, claim: CanonClaim): boolean {
  if (text.includes(normalizeText(claim.id))) return true;
  const content = normalizeText(claim.content);
  if (content.length > 0 && text.includes(content)) return true;
  if (claim.claimType === "prohibition") {
    const compactText = text.replace(/[^\p{L}\p{N}]/gu, "");
    const compactClaim = content
      .replace(/[^\p{L}\p{N}]/gu, "")
      .replace(/^(不得|禁止|不要|不能|donot|mustnot)/i, "")
      .replace(/^(出现|包含|写|使用|include|write|use)/i, "");
    if (compactClaim.length >= 4 && compactText.includes(compactClaim)) return true;
  }
  return salientClaimContentTerms(claim).some((term) => text.includes(term));
}

function detectCharacterKnowledgeLeak(text: string, claim: CanonClaim): boolean {
  if (claim.visibility.hiddenFrom.length === 0) return false;
  const normalized = normalizeText(text);
  const hiddenCharacter = claim.visibility.hiddenFrom.some((name) =>
    normalized.includes(normalizeText(name))
  );
  if (!hiddenCharacter) return false;
  if (!/(知道|知晓|知情|察觉|意识到|明白|发现|看穿|得知|learns?|knows?|realizes?|discovers?|finds?\s+out)/i.test(text)) {
    return false;
  }
  return claimMentionTerms(claim, { contentOnly: true }).some((term) => normalized.includes(term));
}

function detectsInstitutionRuleBypass(text: string, claim: CanonClaim): boolean {
  if (!textMentionsClaim(normalizeText(text), claim)) return false;
  if (!hasBypassSignal(text)) return false;
  return !hasGroundedException(text);
}

function detectsHardRuleBypass(text: string, claim: CanonClaim): boolean {
  if (!hasBypassSignal(text)) return false;
  if (!mentionsRuleSubjectOrAction(text, claim)) return false;
  if (claim.constraints.requiresCost.some((cost) => normalizeText(text).includes(normalizeText(cost)))) {
    return false;
  }
  return !hasGroundedException(text);
}

function hasBypassSignal(text: string): boolean {
  // Only strong "the rule was circumvented" signals. Generic narrative adverbs
  // (直接/照样/依然能/仍然能/轻易/随手, freely, "still can") were removed: they
  // fire constantly in ordinary prose ("他直接推门而入") and produced critical
  // false positives on hard/institution rule bypass checks. Real bypasses in the
  // corpus pair a rule mention with an explicit circumvention verb below.
  return /无视|绕过|越过|跳过|破例|例外|失效|失灵|作废|不再生效|无需|没有(?:任何)?代价|不必(?:付出|承担)|bypass(?:es|ed)?|ignore(?:s|d)?|without\s+(?:any\s+)?cost|no\s+cost/i.test(text);
}

function hasGroundedException(text: string): boolean {
  if (/无需|没有(?:任何)?代价|不必(?:付出|承担)|without\s+(?:any\s+)?cost|no\s+cost/i.test(text)) return false;
  return /因为|由于|凭借|付出|代价|惩罚|反噬|后果|授权|许可|批准|特批|豁免|漏洞|交换|牺牲|罚|审判|改令|改制|because|due\s+to|with\s+(?:authorization|permission)|authorized|permission|cost|penalty|consequence|loophole|exception/i.test(text);
}

function mentionsRuleSubjectOrAction(text: string, claim: CanonClaim): boolean {
  const normalized = normalizeText(text);
  if (textMentionsClaim(normalized, claim)) return true;
  const contentTerms = salientClaimContentTerms(claim);
  const scopeTerms = claimMentionTerms({
    ...claim,
    content: "",
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
  });
  const contentHit = contentTerms.some((term) => normalized.includes(term));
  const scopeHit = scopeTerms.length === 0 || scopeTerms.some((term) => normalized.includes(term));
  return (contentHit && scopeHit) || hasCoreTermOverlap(normalized, claim.content);
}

function makesRevealObservable(text: string, claim: CanonClaim): boolean {
  const normalized = normalizeText(text);
  if (normalized.includes(normalizeText(claim.id))) return true;

  const content = normalizeText(claim.content);
  if (content.length > 0 && normalized.includes(content)) return true;

  const contentTerms = salientClaimContentTerms(claim);
  if (contentTerms.some((term) => normalized.includes(term))) return true;

  return hasCoreTermOverlap(normalized, claim.content);
}

function hasCoreTermOverlap(normalizedText: string, claimContent: string): boolean {
  const terms = extractCoreTerms(claimContent);
  if (terms.length === 0) return false;
  const hits = terms.filter((term) => normalizedText.includes(term));
  return hits.length >= Math.min(2, terms.length);
}

function extractCoreTerms(value: string): string[] {
  const normalized = normalizeText(value);
  const out = new Set<string>();
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (/^[a-z0-9]+$/i.test(token) && token.length >= 4) out.add(token);
  }
  for (const match of normalized.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    const cleaned = match.replace(/不能|不得|不可|必须|只能|禁止|不会|没有|无需|不必|可以|需要|任何/gu, "");
    if (cleaned.length === 2) out.add(cleaned);
    if (cleaned.length > 2) {
      for (let index = 0; index <= cleaned.length - 2; index += 1) {
        out.add(cleaned.slice(index, index + 2));
      }
    }
  }
  return [...out].filter((term) => !/^(他人|所有|任何|直接|限制)$/u.test(term));
}

function claimMentionTerms(
  claim: CanonClaim,
  options: { readonly contentOnly?: boolean } = {},
): string[] {
  const raw = options.contentOnly ? [claim.content] : [
    ...claim.scope.appliesTo,
    ...(claim.scope.excludes ?? []),
    ...(claim.scope.geography ?? []),
    claim.scope.timeRange ?? "",
    ...claim.visibility.characterKnownBy,
    ...claim.visibility.hiddenFrom,
    ...claim.constraints.requiresCost,
    ...claim.constraints.forbiddenUses,
    claim.content,
  ];
  const out = new Set<string>();
  for (const value of raw) {
    for (const term of extractSearchTerms(value)) out.add(term);
  }
  return [...out];
}

function salientClaimContentTerms(claim: CanonClaim): string[] {
  const actorTerms = new Set([
    ...claim.scope.appliesTo,
    ...(claim.scope.excludes ?? []),
    ...claim.visibility.characterKnownBy,
    ...claim.visibility.hiddenFrom,
  ].flatMap((value) => extractSearchTerms(value)));
  return claimMentionTerms(claim, { contentOnly: true })
    .filter((term) => !actorTerms.has(term));
}

function extractSearchTerms(value: string): string[] {
  const normalized = normalizeText(value);
  const out = new Set<string>();
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (/^[a-z0-9]+$/i.test(token) && token.length >= 4) out.add(token);
  }
  for (const match of normalized.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    addCjkTerms(out, match);
  }
  return [...out];
}

function addCjkTerms(out: Set<string>, value: string): void {
  if (value.length <= 8) {
    out.add(value);
  }
  const knowledge = value.match(/^(.{2,8}?)(?:早已|已经|其实|一直|都)?(?:知道|知晓|知情|清楚|明白|掌握|了解)(.{0,8})$/u);
  if (knowledge?.[1] && knowledge[1].length >= 2) out.add(knowledge[1]);
  if (knowledge?.[2] && knowledge[2].length >= 2) out.add(knowledge[2]);
  if (value.length >= 4) {
    for (let index = 0; index <= value.length - 4; index += 1) {
      out.add(value.slice(index, index + 4));
    }
  }
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
