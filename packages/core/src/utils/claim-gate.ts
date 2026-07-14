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
    if (textRevealsHiddenClaim(input.text, claim)) {
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
    if (claim.claimType === "prohibition" && detectsProhibitedContent(input.text, claim)) {
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
    if (!activelyUsesCostBoundClaim(input.text, claim)) continue;
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

function detectsProhibitedContent(text: string, claim: CanonClaim): boolean {
  const normalized = normalizeText(text);
  const targets = extractProhibitedTargets(claim);
  if (targets.some((target) =>
    !prohibitionTargetRequiresContext(claim, target)
    && containsUnnegatedTarget(normalized, target)
  )) {
    return true;
  }
  return detectsSemanticProhibitionViolation(normalized, claim, targets);
}

function detectsSemanticProhibitionViolation(
  text: string,
  claim: CanonClaim,
  targets: ReadonlyArray<string>,
): boolean {
  const prohibition = normalizeText([claim.content, ...claim.constraints.forbiddenUses, ...targets].join(" "));
  const scopeTerms = extractProhibitionScopeTerms(claim.content, targets);
  const scopeHit = scopeTerms.length === 0 || scopeTerms.some((term) => text.includes(term));
  if (!scopeHit) return false;

  if (/(?:万能解释|解释一切|all-purpose explanation|explain everything)/iu.test(prohibition)) {
    const subjectMentioned = targets.some((target) => containsUnnegatedTarget(text, target));
    const usedAsUniversalExplanation = /(?:万能解释|解释一切|一切都(?:能|可以|可由).{0,12}解释|无需.{0,12}(?:逻辑|原理|机制|证据)|不需要.{0,12}(?:逻辑|原理|机制|证据)|all-purpose explanation|explain(?:s|ed)? everything|without.{0,18}(?:logic|mechanism|evidence))/iu.test(text);
    if (subjectMentioned && usedAsUniversalExplanation) return true;
  }

  if (/(?:打怪|升级|刷级|成长循环|progression|level(?:ing)?)/iu.test(prohibition)) {
    const progression = containsAnyUnnegatedTarget(text, [
      "升级", "升阶", "进阶", "变强", "强化", "提升一级", "突破一级",
      "level up", "power up", "grow stronger",
    ]);
    const repetitiveOrAutomatic = /(?:每次|每回|每当|每点亮|每修复|反复|循环|自动|无条件|固定).{0,18}(?:升级|升阶|进阶|变强|强化|提升|突破)|(?:升级|升阶|进阶|变强|强化|提升|突破).{0,18}(?:一级|一阶|一层|一次|自动|无条件|固定)|(?:every|each|automatically|unconditionally).{0,24}(?:level|stronger|power)/iu.test(text);
    if (progression && repetitiveOrAutomatic) return true;
  }

  if (/(?:治愈|找回|恢复|复原|回来|recover|restore|heal)/iu.test(prohibition)) {
    if (containsAnyUnnegatedTarget(text, [
      "恢复", "找回", "复原", "重新拥有", "回来了", "治好了",
      "recover", "restore", "regain", "came back", "healed",
    ])) return true;
  }

  if (/(?:顿悟|爆种|临阵突破|sudden breakthrough|power spike)/iu.test(prohibition)) {
    if (containsAnyUnnegatedTarget(text, [
      "顿悟", "爆种", "临阵突破", "突然突破", "凭空掌握", "瞬间掌握",
      "sudden breakthrough", "instant mastery", "power spike",
    ])) return true;
  }

  if (/(?:降智|失去判断|无条件配合|idiot plot|act stupid)/iu.test(prohibition)) {
    if (containsAnyUnnegatedTarget(text, [
      "无条件配合", "突然犯蠢", "放弃思考", "失去判断", "毫无理由地相信",
      "act stupid", "stops thinking", "without question",
    ])) return true;
  }

  return false;
}

function prohibitionTargetRequiresContext(claim: CanonClaim, target: string): boolean {
  const content = normalizeText(claim.content);
  const index = content.indexOf(target);
  if (index < 0) return false;
  const suffix = content.slice(index + target.length, index + target.length + 24);
  return /^(?:\s|[”"'’])+?(?:作为|当作|当成|用作|用于|拿来|被当作|被视为|as\s+(?:an?\s+)?|used\s+as)/iu.test(suffix);
}

function extractProhibitionScopeTerms(content: string, targets: ReadonlyArray<string>): string[] {
  let scope = normalizeText(content);
  for (const target of targets) {
    scope = scope.replace(target, " ");
  }
  scope = scope
    .split(/[（(]/u, 1)[0]!
    .replace(/^(?:严禁|禁止|不得|不能|不可|不要|切勿|must\s+not|do\s+not|don't|never)\s*/iu, "")
    .replace(/(?:变成|成为|演变为|turn(?:s|ed)?\s+into|become(?:s)?).*/iu, "")
    .trim();

  const terms = new Set<string>();
  for (const match of scope.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    const cleaned = match.replace(/(?:主角|配角|角色|行为|内容|情节|核心冲突)/gu, "");
    if (cleaned.length >= 2 && cleaned.length <= 8) terms.add(cleaned);
    if (cleaned.length > 3) {
      for (let index = 0; index <= cleaned.length - 2; index += 1) {
        terms.add(cleaned.slice(index, index + 2));
      }
    }
  }
  for (const token of scope.match(/[a-z][a-z0-9-]{3,}/giu) ?? []) {
    if (!/^(must|never|into|become|turn)$/i.test(token)) terms.add(token.toLowerCase());
  }
  return [...terms];
}

function containsAnyUnnegatedTarget(text: string, targets: ReadonlyArray<string>): boolean {
  return targets.some((target) => containsUnnegatedTarget(text, normalizeText(target)));
}

function extractProhibitedTargets(claim: CanonClaim): string[] {
  const targets = new Set<string>();
  for (const forbiddenUse of claim.constraints.forbiddenUses) {
    const normalized = normalizeText(forbiddenUse);
    if (normalized.length >= 2) targets.add(normalized);
  }

  const content = normalizeText(claim.content);
  const quoted = [...content.matchAll(/[“"'‘]([^”"'’]{2,})[”"'’]/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length >= 2);
  if (quoted.length > 0) {
    for (const value of quoted) targets.add(value);
    return [...targets];
  }

  const directive = content
    .split(/[（(]/u, 1)[0]!
    .replace(/^(?:严禁|禁止|不得|不能|不可|不要|切勿|must\s+not|do\s+not|don't|never)\s*/iu, "")
    .replace(/^(?:出现|包含|写入|写出|写|使用|include|write|use)\s*/iu, "")
    .trim();
  if (directive.length >= 2) targets.add(directive);
  return [...targets];
}

function containsUnnegatedTarget(text: string, target: string): boolean {
  let index = text.indexOf(target);
  while (index >= 0) {
    // "无条件" means unconditional, not grammatical negation.
    const prefix = text.slice(Math.max(0, index - 32), index).replace(/无条件/gu, "");
    const negated = /(?:不|未|无|非|别|禁止|避免|防止|不得|不能|不可|绝不|严禁|并非|不是|没有|without|avoid|forbid|must\s+not|do\s+not|don't|never)[^。！？.!?]{0,24}$/iu.test(prefix);
    if (!negated) return true;
    index = text.indexOf(target, index + target.length);
  }
  return false;
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

const HIDDEN_REVEAL_CUES = /知道|知晓|知情|意识到|明白|看穿|得知|确认|证实|原来|其实|真相|揭示|揭晓|揭露|透露|交代|并非.{0,24}而是|不是.{0,24}而是|learns?|knows?|realizes?|confirms?|reveals?|turns? out|the truth/iu;

function textRevealsHiddenClaim(text: string, claim: CanonClaim): boolean {
  const normalized = normalizeText(text);
  if (normalized.includes(normalizeText(claim.id))) return true;
  const content = normalizeText(claim.content);
  if (content.length > 0 && normalized.includes(content)) return true;
  return splitEvidenceSegments(text).some((segment) => segmentRevealsHiddenClaim(segment, claim));
}

function segmentRevealsHiddenClaim(segment: string, claim: CanonClaim): boolean {
  if (!HIDDEN_REVEAL_CUES.test(segment)) return false;
  const normalized = normalizeText(segment);
  const terms = hiddenClaimEvidenceTerms(claim);
  if (terms.length === 0) return false;
  const hits = terms.filter((term) => normalized.includes(term)).length;
  return hits >= Math.min(3, terms.length);
}

function hiddenClaimEvidenceTerms(claim: CanonClaim): string[] {
  const focused = claim.content.match(/(?:而是|其实|原来|真相(?:是|为)?)[：:]?([\s\S]+)/u)?.[1];
  const focus = focused && (focused.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 4
    ? focused
    : claim.content;
  return extractCoreTerms(focus);
}

function splitEvidenceSegments(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])|\r?\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function detectCharacterKnowledgeLeak(text: string, claim: CanonClaim): boolean {
  if (claim.visibility.hiddenFrom.length === 0) return false;
  return splitEvidenceSegments(text).some((segment) => {
    const normalized = normalizeText(segment);
    const hiddenCharacter = claim.visibility.hiddenFrom.some((name) =>
      normalized.includes(normalizeText(name))
    );
    return hiddenCharacter && segmentRevealsHiddenClaim(segment, claim);
  });
}

function activelyUsesCostBoundClaim(text: string, claim: CanonClaim): boolean {
  const capabilityClaim = claim.domain === "power"
    || claim.domain === "protagonist"
    || claim.claimType === "character_exception";
  if (capabilityClaim) return mentionsRuleSubjectOrAction(text, claim);
  return bypassEvidenceSegments(text, claim).some((segment) => mentionsRuleSubjectOrAction(segment, claim));
}

function detectsInstitutionRuleBypass(text: string, claim: CanonClaim): boolean {
  return bypassEvidenceSegments(text, claim).some((segment) =>
    textMentionsClaim(normalizeText(segment), claim)
    && !hasGroundedException(segment)
  );
}

function detectsHardRuleBypass(text: string, claim: CanonClaim): boolean {
  return bypassEvidenceSegments(text, claim).some((segment) => {
    if (!mentionsRuleSubjectOrAction(segment, claim)) return false;
    if (claim.constraints.requiresCost.some((cost) => normalizeText(segment).includes(normalizeText(cost)))) {
      return false;
    }
    return !hasGroundedException(segment);
  });
}

function bypassEvidenceSegments(text: string, claim: CanonClaim): string[] {
  return text
    .split(/(?<=[。！？.!?])|\r?\n+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && hasBypassSignal(segment, claim));
}

function hasBypassSignal(text: string, claim: CanonClaim): boolean {
  // Only strong "the rule was circumvented" signals. Generic narrative adverbs
  // (直接/照样/依然能/仍然能/轻易/随手, freely, "still can") were removed: they
  // fire constantly in ordinary prose ("他直接推门而入") and produced critical
  // false positives on hard/institution rule bypass checks. Real bypasses in the
  // corpus pair a rule mention with an explicit circumvention verb below.
  if (/无视|绕过|越过|跳过|破例|例外|失效|失灵|作废|不再生效|无需(?:遵守|遵循|服从|执行)|不必(?:遵守|遵循|服从|执行)|bypass(?:es|ed)?|ignore(?:s|d)?/i.test(text)) {
    return true;
  }

  // Payment/cost wording is ordinary story content for financial and legal
  // claims. It only proves a bypass when this claim actually declares a cost.
  return claim.constraints.requiresCost.length > 0
    && /无需(?:支付|承担|付出)|没有(?:任何)?代价|不必(?:支付|付出|承担)|without\s+(?:any\s+)?cost|no\s+cost/i.test(text);
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
