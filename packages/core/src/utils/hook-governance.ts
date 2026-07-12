import type { HookRecord, HookStatus, RuntimeStateDelta } from "../models/runtime-state.js";
import { describeHookLifecycle } from "./hook-lifecycle.js";

export type HookDisposition = "none" | "mention" | "advance" | "resolve" | "defer";

export interface HookAdmissionCandidate {
  readonly type: string;
  readonly expectedPayoff?: string;
  readonly payoffTiming?: string;
  readonly notes?: string;
}

export interface HookAdmissionDecision {
  readonly admit: boolean;
  readonly reason: "admit" | "missing_type" | "missing_payoff_signal" | "duplicate_family";
  readonly matchedHookId?: string;
}

export function collectStaleHookDebt(params: {
  readonly hooks: ReadonlyArray<HookRecord>;
  readonly chapterNumber: number;
  readonly targetChapters?: number;
  readonly staleAfterChapters?: number;
}): HookRecord[] {
  return params.hooks
    .filter((hook) => hook.status !== "resolved" && hook.status !== "deferred")
    .filter((hook) => hook.startChapter <= params.chapterNumber)
    .filter((hook) => {
      const lifecycle = describeHookLifecycle({
        payoffTiming: hook.payoffTiming,
        expectedPayoff: hook.expectedPayoff,
        notes: hook.notes,
        startChapter: hook.startChapter,
        lastAdvancedChapter: hook.lastAdvancedChapter,
        status: hook.status,
        chapterNumber: params.chapterNumber,
        targetChapters: params.targetChapters,
      });

      if (params.staleAfterChapters !== undefined) {
        return hook.lastAdvancedChapter <= params.chapterNumber - params.staleAfterChapters;
      }

      return lifecycle.stale || lifecycle.overdue;
    })
    .sort((left, right) => (
      left.lastAdvancedChapter - right.lastAdvancedChapter
      || left.startChapter - right.startChapter
      || left.hookId.localeCompare(right.hookId)
    ));
}

export function evaluateHookAdmission(params: {
  readonly candidate: HookAdmissionCandidate;
  readonly activeHooks: ReadonlyArray<HookRecord>;
}): HookAdmissionDecision {
  const candidateType = normalizeHookFamily(params.candidate.type);
  if (!candidateType) {
    return {
      admit: false,
      reason: "missing_type",
    };
  }

  const payoffSignal = [params.candidate.expectedPayoff, params.candidate.notes]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(" ")
    .trim();

  if (!payoffSignal) {
    return {
      admit: false,
      reason: "missing_payoff_signal",
    };
  }

  const candidateNormalized = normalizeText([
    params.candidate.type,
    params.candidate.expectedPayoff ?? "",
    params.candidate.payoffTiming ?? "",
    params.candidate.notes ?? "",
  ].join(" "));
  const candidateTerms = extractTerms(candidateNormalized);
  const candidateChineseBigrams = extractChineseBigrams(candidateNormalized);

  for (const hook of params.activeHooks) {
    const activeNormalized = normalizeText([
      hook.type,
      hook.expectedPayoff,
      hook.payoffTiming ?? "",
      hook.notes,
    ].join(" "));

    if (candidateNormalized === activeNormalized) {
      return {
        admit: false,
        reason: "duplicate_family",
        matchedHookId: hook.hookId,
      };
    }

    if (candidateType !== normalizeHookFamily(hook.type)) {
      continue;
    }

    const activeTerms = extractTerms(activeNormalized);
    const overlap = [...candidateTerms].filter((term) => activeTerms.has(term));
    const activeChineseBigrams = extractChineseBigrams(activeNormalized);
    const chineseOverlap = [...candidateChineseBigrams].filter((term) =>
      activeChineseBigrams.has(term),
    );
    if (overlap.length >= 2 || chineseOverlap.length >= 3) {
      return {
        admit: false,
        reason: "duplicate_family",
        matchedHookId: hook.hookId,
      };
    }
  }

  return {
    admit: true,
    reason: "admit",
  };
}

export function normalizeHookFamily(value: string): string {
  const normalized = normalizeText(value).replace(/[\s_-]+/g, "");
  if (/^(?:information|info|clue|信息|线索|情报)$/.test(normalized)) return "information";
  if (/^(?:mystery|谜团|悬疑|秘密)$/.test(normalized)) return "mystery";
  if (/^(?:relationship|relation|关系|人物关系)$/.test(normalized)) return "relationship";
  if (/^(?:threat|risk|danger|威胁|风险|危险)$/.test(normalized)) return "threat";
  if (/^(?:emotion|emotional|情绪|情感)$/.test(normalized)) return "emotion";
  if (/^(?:institution|organization|组织|机构)$/.test(normalized)) return "institution";
  if (/^(?:artifact|item|物品|物件|道具)$/.test(normalized)) return "artifact";
  return normalized;
}

export function normalizeHookTypeLabel(value: string): string {
  const trimmed = value.trim();
  const family = normalizeHookFamily(trimmed);
  if ([
    "information",
    "mystery",
    "relationship",
    "threat",
    "emotion",
    "institution",
    "artifact",
  ].includes(family)) {
    return family;
  }
  return trimmed;
}

export function normalizeHookStatusAlias(value: unknown): HookStatus | unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (/(unresolved|not[_ -]?resolved|未回收|未解决|尚未解决|待定|pending|seeded|planted|已埋|已种下|已铺垫)/i.test(normalized)) return "open";
  if (/(deferred|paused|hold|dormant|inactive|unplanted|unseeded|not[_ -]?started|not[_ -]?active|搁置|延后|延期|暂缓|休眠|未开启|待开启|未激活|未启动|待启动|待推进|未推进|尚未推进)/i.test(normalized)) return "deferred";
  if (/(resolved|closed|done|paid[_ -]?off|已回收|回收|完成|已解决|已兑现|兑现)/i.test(normalized)) return "resolved";
  if (/(confirmed[_ -]?hit|confirmed|advanced|progressing|progress|active|pressured|命中|已确认命中|已推进|推进|进行中|持续推进|重大推进)/i.test(normalized)) return "progressing";
  if (/open/i.test(normalized)) return "open";
  return value;
}

export function classifyHookDisposition(params: {
  readonly hookId: string;
  readonly delta: Pick<RuntimeStateDelta, "chapter" | "hookOps">;
}): HookDisposition {
  const { hookId, delta } = params;

  if (delta.hookOps.defer.includes(hookId)) {
    return "defer";
  }

  if (delta.hookOps.resolve.includes(hookId)) {
    return "resolve";
  }

  if (delta.hookOps.upsert.some((hook) => hook.hookId === hookId && hook.lastAdvancedChapter === delta.chapter)) {
    return "advance";
  }

  if (delta.hookOps.mention.includes(hookId)) {
    return "mention";
  }

  return "none";
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTerms(value: string): Set<string> {
  const english = value
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 4)
    .filter((term) => !STOP_WORDS.has(term));
  const chinese = value.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
  return new Set([...english, ...chinese]);
}

function extractChineseBigrams(value: string): Set<string> {
  const segments = value.match(/[\u4e00-\u9fff]+/g) ?? [];
  const terms = new Set<string>();

  for (const segment of segments) {
    if (segment.length < 2) {
      continue;
    }

    for (let index = 0; index <= segment.length - 2; index += 1) {
      terms.add(segment.slice(index, index + 2));
    }
  }

  return terms;
}

const STOP_WORDS = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "still",
  "just",
  "have",
  "will",
  "reveal",
]);
