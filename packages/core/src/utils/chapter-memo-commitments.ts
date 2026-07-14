import type { AuditIssue } from "../agents/continuity.js";
import {
  compileChapterExecutionContract,
  type ChapterDeferredHook,
  type ChapterExecutionDirective,
} from "./chapter-execution-contract.js";

const ZH_GENERIC_BIGRAMS = new Set([
  "本章", "当前", "必须", "发生", "改变", "信息", "关系", "物理", "权力", "需要",
  "应该", "读者", "主角", "行动", "场景", "通过", "进行", "完成", "推进", "明确",
  "获得", "发现", "确认", "变为", "成为", "主动", "被动", "具体", "部分", "直接",
  "不要", "不得", "禁止", "暂不", "内容", "状态", "作为", "一个", "任何", "已经",
]);

const EN_GENERIC_TERMS = new Set([
  "chapter", "current", "task", "must", "should", "change", "information", "relationship",
  "physical", "power", "payoff", "advance", "resolve", "defer", "reader", "protagonist",
  "scene", "action", "through", "become", "becomes", "make", "makes", "made", "happen",
  "happens", "required", "keep", "buried", "hidden", "avoid", "without", "directly",
  "from", "with", "into", "across", "beside", "inside", "outside", "after", "before",
]);

const ZH_REVEAL_MARKERS = /确认|证实|证明|揭示|表明|就是|原来|真是|真实身份|完整名单|全部身份|直指|锁定|确定|无疑|答案|名单中|标注|显示|身份为/;
const EN_REVEAL_MARKERS = /\b(?:confirm(?:s|ed)?|prove[sd]?|reveal(?:s|ed)?|show(?:s|ed)?|is|was|identity|complete list|points? to|locks? onto|certain|answer)\b/i;
const ZH_UNCERTAINTY = /无法.{0,10}(?:确认|证实)|尚未.{0,10}(?:确认|证实)|只是怀疑|仅是怀疑|可能|或许|疑似|待验证|有待验证|间接印证/;
const EN_UNCERTAINTY = /\b(?:cannot confirm|not yet confirm|only suspects?|might|may be|possibly|perhaps|unverified|indirect evidence)\b/i;

export function validateChapterMemoCommitments(
  memoBody: string,
  chapterContent: string,
  language: "zh" | "en" = "zh",
): ReadonlyArray<AuditIssue> {
  const contract = compileChapterExecutionContract({
    chapter: 1,
    goal: "memo",
    isGoldenOpening: false,
    body: memoBody,
    threadRefs: [],
  });
  const issues: AuditIssue[] = [];

  for (const directive of contract.mustLand) {
    if (!isRequiredCommitment(directive) || hasDirectiveEvidence(chapterContent, directive.text, language)) {
      continue;
    }
    issues.push(missingCommitmentIssue(directive, language));
  }

  const deferredDescriptions = contract.deferredHooks.map((hook) => hook.description);
  for (const hook of contract.deferredHooks) {
    const evidence = findRevealEvidence(chapterContent, hook.description, language);
    if (evidence) issues.push(deferredRevealIssue(hook, evidence, language));
  }

  for (const directive of contract.mustAvoid) {
    if (directive.kind === "keep-buried") {
      if (deferredDescriptions.some((description) => conceptsOverlap(description, directive.text, language))) {
        continue;
      }
      const evidence = findRevealEvidence(chapterContent, directive.text, language);
      if (evidence) issues.push(keepBuriedRevealIssue(directive, evidence, language));
      continue;
    }
    if (directive.kind === "do-not") {
      const evidence = findForbiddenActionEvidence(chapterContent, directive.text, language);
      if (evidence) issues.push(forbiddenActionIssue(directive, evidence, language));
    }
  }

  return dedupeIssues(issues);
}

function isRequiredCommitment(directive: ChapterExecutionDirective): boolean {
  return directive.kind === "current-task"
    || directive.kind === "payoff"
    || directive.kind === "end-change";
}

function hasDirectiveEvidence(content: string, directive: string, language: "zh" | "en"): boolean {
  if (language === "zh" && hasChineseRelationshipChangeEvidence(content, directive)) return true;
  const terms = extractEvidenceTerms(directive, language);
  if (terms.length === 0) return true;
  const normalizedContent = normalizeText(content);
  const matched = terms.filter((term) => normalizedContent.includes(normalizeText(term))).length;
  const required = language === "en"
    ? (terms.length >= 3 ? 3 : terms.length)
    : Math.min(3, Math.max(2, Math.ceil(terms.length * 0.18)));
  return matched >= Math.min(required, terms.length);
}

function hasChineseRelationshipChangeEvidence(content: string, directive: string): boolean {
  if (!/关系改变/.test(directive)) return false;
  const pair = directive.match(/关系改变\s*[:：]?\s*([\u4e00-\u9fff]{2,8})(?:与|和)([\u4e00-\u9fff]{2,8}?)(?:之间|建立|从|由|的)/u);
  if (!pair?.[1] || !pair[2] || !content.includes(pair[1]) || !content.includes(pair[2])) return false;

  if (/监视|被监|盯|看他|看她|观察|跟踪|监控/.test(directive)) {
    return /监视|被监|盯|注视|观察|跟踪|监控|打量|盯梢|看着|看了.{0,4}一眼|抬眼看|知道了/.test(content);
  }

  return /信任|怀疑|敌意|合作|同盟|疏远|靠近|保护|背叛|拒绝|答应|承诺|让步|试探|戒备|关系/.test(content);
}

function findRevealEvidence(
  content: string,
  directive: string,
  language: "zh" | "en",
): string | undefined {
  const terms = extractSensitiveConcepts(directive, language);
  if (terms.length < 2) return undefined;
  for (const clause of splitClauses(content)) {
    const normalizedClause = normalizeText(clause);
    const matched = terms.filter((term) => normalizedClause.includes(normalizeText(term)));
    if (matched.length < Math.min(2, terms.length)) continue;
    const hasStrongReveal = language === "en"
      ? EN_REVEAL_MARKERS.test(clause)
      : ZH_REVEAL_MARKERS.test(clause);
    if (!hasStrongReveal) continue;
    const isUncertain = language === "en"
      ? EN_UNCERTAINTY.test(clause)
      : ZH_UNCERTAINTY.test(clause);
    if (isUncertain && !hasIrreversibleRevealMarker(clause, language)) continue;
    return clause.trim();
  }
  return undefined;
}

function findForbiddenActionEvidence(
  content: string,
  directive: string,
  language: "zh" | "en",
): string | undefined {
  const core = prohibitedCore(directive);
  const quoted = [...core.matchAll(/[“"']([^”"'\n]{2,80})[”"']/g)].map((match) => match[1]!);
  const terms = extractSensitiveConcepts(core, language);
  for (const clause of splitClauses(content)) {
    for (const phrase of quoted) {
      if (normalizeText(clause).includes(normalizeText(phrase)) && !isNegatedNear(clause, phrase, language)) {
        return clause.trim();
      }
    }
    if (terms.length === 0) continue;
    const normalizedClause = normalizeText(clause);
    const matched = terms.filter((term) => normalizedClause.includes(normalizeText(term)));
    const required = terms.length <= 3 ? terms.length : Math.ceil(terms.length * 0.65);
    if (matched.length < required) continue;
    const positiveMatches = matched.filter((term) => !isNegatedNear(clause, term, language));
    if (positiveMatches.length >= required) return clause.trim();
  }
  return undefined;
}

function extractEvidenceTerms(text: string, language: "zh" | "en"): string[] {
  const source = stripPlanningSyntax(text);
  if (language === "en") {
    return [...new Set((source.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => !EN_GENERIC_TERMS.has(term)))];
  }
  const cleaned = source
    .replace(/信息改变|关系改变|物理改变|权力改变|信息变化|关系变化|物理变化|权力变化/g, " ")
    .replace(/本章|当前任务|该兑现|兑现|必须|需要|应该|不要|不得|禁止|暂不掀|暂不兑现/g, " ");
  const terms: string[] = [];
  for (const run of cleaned.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (run.length <= 6 && !ZH_GENERIC_BIGRAMS.has(run)) terms.push(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (!ZH_GENERIC_BIGRAMS.has(bigram)) terms.push(bigram);
    }
  }
  return [...new Set(terms)];
}

function extractSensitiveConcepts(text: string, language: "zh" | "en"): string[] {
  const stripped = stripPlanningSyntax(text);
  const quoted = stripped.match(/[“"']([^”"'\n]{2,80})[”"']/)?.[1];
  const source = (quoted ?? stripped.split(/(?:→|->|\|\||——)/, 1)[0]!)
    .replace(/\bH\d+\b/gi, " ")
    .replace(/[（）()]/g, " ");
  if (language === "en") {
    return [...new Set(source
      .split(/\b(?:whether|if|why|who|when|where|how|is|was|are|were|the|a|an|of|for|to|and|or)\b/i)
      .map((term) => term.replace(/[^A-Za-z0-9' -]/g, " ").trim().toLowerCase())
      .filter((term) => term.length >= 3 && !EN_GENERIC_TERMS.has(term)))];
  }
  const concepts = source
    .replace(/是不是|是否|为何|为什么|何时|哪里|怎么|谁|为/g, "|")
    .replace(/不要让|不要|不得|禁止|暂不掀|暂不兑现|本章|完整的/g, "|")
    .replace(/让|在|从|遇到|发现|揭示|使用|超过|作为|展开|写成|拿到|获得|确认|看到|知道|对质|进入|找到|或/g, "|")
    .split(/[|：:，,。；;、/\s]+/)
    .map((term) => term.replace(/^(?:让|把|给|与|和|的|对|在|从)/, "").trim())
    .filter((term) => /^[\u4e00-\u9fff]{2,12}$/.test(term))
    .filter((term) => !ZH_GENERIC_BIGRAMS.has(term));
  return [...new Set(concepts)];
}

function prohibitedCore(text: string): string {
  return stripPlanningSyntax(text)
    .replace(/^(?:不要让|不要用|不要|不得|禁止)\s*/, "")
    .split(/(?:——|\|\||理由[:：]|修复建议[:：])/, 1)[0]!
    .trim();
}

function stripPlanningSyntax(text: string): string {
  return text
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*(?:该兑现|兑现|暂不掀|暂不兑现|Pay off|Keep buried|Keep hidden)\s*[:：]\s*/i, "")
    .replace(/\bH\d+\b/gi, " ");
}

function conceptsOverlap(left: string, right: string, language: "zh" | "en"): boolean {
  const leftTerms = new Set(extractSensitiveConcepts(left, language).map(normalizeText));
  const rightTerms = extractSensitiveConcepts(right, language).map(normalizeText);
  if (leftTerms.size < 2 || rightTerms.length < 2) return false;
  const overlap = rightTerms.filter((term) => leftTerms.has(term)).length;
  return overlap >= 2;
}

function hasIrreversibleRevealMarker(clause: string, language: "zh" | "en"): boolean {
  return language === "en"
    ? /\b(?:proved|confirmed|revealed|identity is|points? directly to|complete list)\b/i.test(clause)
    : /证实|证明|确认无误|就是|身份为|直指|完整名单|全部身份/.test(clause);
}

function isNegatedNear(clause: string, term: string, language: "zh" | "en"): boolean {
  const index = normalizeText(clause).indexOf(normalizeText(term));
  if (index < 0) return false;
  const normalizedClause = normalizeText(clause);
  const prefix = normalizedClause.slice(Math.max(0, index - 8), index);
  return language === "en"
    ? /(?:not|never|without|avoids?|refuses?)$/i.test(prefix)
    : /(?:没有|并未|不曾|未曾|不会|未|无|避免|拒绝)$/.test(prefix);
}

function splitClauses(content: string): string[] {
  return content
    .split(/[。！？!?；;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "").replace(/[，。！？、；：,.!?;:"'“”‘’（）()【】\[\]「」—>-]/g, "");
}

function missingCommitmentIssue(
  directive: ChapterExecutionDirective,
  language: "zh" | "en",
): AuditIssue {
  const labels = language === "en"
    ? { "current-task": "memo-current-task", payoff: "memo-payoff", "end-change": "memo-end-change" }
    : { "current-task": "memo-当前任务", payoff: "memo-兑现承诺", "end-change": "memo-章尾承诺" };
  return {
    severity: "critical",
    category: labels[directive.kind as keyof typeof labels],
    description: language === "en"
      ? `The draft lacks enough visible evidence for the chapter contract commitment: ${directive.text}`
      : `章节执行合同中的承诺缺少足够正文证据：${directive.text}`,
    suggestion: language === "en"
      ? "Rewrite the relevant scene so the commitment lands through action, dialogue, evidence, or a visible state change."
      : "重写对应场景，用动作、对话、证据或可见状态变化落地该承诺。",
    repairScope: "structural",
  };
}

function deferredRevealIssue(
  hook: ChapterDeferredHook,
  evidence: string,
  language: "zh" | "en",
): AuditIssue {
  return {
    severity: "critical",
    category: language === "en" ? "memo-deferred-reveal" : "memo-延后揭示越界",
    description: language === "en"
      ? `Deferred hook ${hook.hookId} is confirmed or materially revealed in the draft: ${evidence}`
      : `明确延后的 hook ${hook.hookId} 被正文确认或实质揭示：${evidence}`,
    suggestion: language === "en"
      ? "Remove the confirmation and keep only uncertainty or indirect pressure until the contract allows this hook to advance."
      : "删除确认性信息，只保留怀疑或间接压力，等执行合同允许推进后再揭示。",
    repairScope: "structural",
  };
}

function keepBuriedRevealIssue(
  directive: ChapterExecutionDirective,
  evidence: string,
  language: "zh" | "en",
): AuditIssue {
  return {
    severity: "critical",
    category: language === "en" ? "memo-keep-buried-reveal" : "memo-暂不掀越界",
    description: language === "en"
      ? `The draft crosses a reveal ceiling that the chapter contract says to keep buried: ${directive.text}. Evidence: ${evidence}`
      : `正文越过了执行合同的“暂不掀”上限：${directive.text}。证据：${evidence}`,
    suggestion: language === "en"
      ? "Remove the confirmation and preserve only the explicitly allowed partial clue."
      : "删除确认性揭示，只保留合同明确允许的部分线索。",
    repairScope: "structural",
  };
}

function forbiddenActionIssue(
  directive: ChapterExecutionDirective,
  evidence: string,
  language: "zh" | "en",
): AuditIssue {
  return {
    severity: "critical",
    category: language === "en" ? "memo-forbidden-action" : "memo-禁止事项违规",
    description: language === "en"
      ? `The draft performs an action forbidden by the chapter contract: ${directive.text}. Evidence: ${evidence}`
      : `正文执行了章节合同明确禁止的事项：${directive.text}。证据：${evidence}`,
    suggestion: language === "en"
      ? "Rewrite the scene to stay below the contract's action or reveal ceiling."
      : "重写该场景，使动作和揭示不超过章节合同规定的上限。",
    repairScope: "structural",
  };
}

function dedupeIssues(issues: ReadonlyArray<AuditIssue>): AuditIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.category}:${issue.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
