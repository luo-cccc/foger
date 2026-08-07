import { ChapterMemoSchema, type ChapterMemo } from "../models/input-governance.js";

export class PlannerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerParseError";
  }
}

// Phase hotfix 4: each required section is a (zh, en) heading pair.
// The English headings come from PLANNER_MEMO_SYSTEM_PROMPT_EN — we accept
// EITHER language at parse time so the same parser works for both.
//
// Phase hotfix 7: minContentChars enforces non-emptiness per section so
// "all 7 headings + blank payload" no longer slips through. The "do not"
// section uses a relaxed threshold because "无 / N/A / none." is legitimate
// for chapters with no extra prohibitions.
//
// Threshold rationale:
// - 20 chars: long enough to catch obvious empty sections (whitespace,
//   "(略)", "TODO") but short enough to accept genuinely sparse memos for
//   breath/transition chapters (Phase 6 sparse-memo principle).
// - 10 chars for the slow/transition function because one concrete sentence
//   is sufficient; forcing filler here caused unnecessary Planner retries.
// - 1 char for "## 不要做" / "## Do not" because "无" / "N/A" / "none" /
//   "—" are all legitimate for a chapter with no extra prohibitions; we
//   only need to ensure the section is not whitespace-only.
interface RequiredSection {
  readonly zh: string;
  readonly en: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly minContentChars: number;
}

const REQUIRED_SECTIONS: ReadonlyArray<RequiredSection> = [
  { zh: "## 当前任务", en: "## Current task", minContentChars: 20 },
  { zh: "## 本集爽点", en: "## Episode payoff", minContentChars: 10 },
  { zh: "## 进入状态", en: "## Incoming state", minContentChars: 20 },
  { zh: "## 当前目标", en: "## Episode objective", minContentChars: 20 },
  { zh: "## 反对力量", en: "## Opposition", minContentChars: 20 },
  { zh: "## 因果升级", en: "## Causal escalation", minContentChars: 20 },
  { zh: "## 关系压力", en: "## Relationship pressure", minContentChars: 10 },
  { zh: "## 方向性转折", en: "## Directional turn", minContentChars: 10 },
  { zh: "## 反转铺垫", en: "## Reversal setup", minContentChars: 10 },
  { zh: "## 本集反转", en: "## Episode reversal", minContentChars: 10 },
  { zh: "## 反转后果", en: "## Reversal consequence", minContentChars: 10 },
  { zh: "## 当集兑现", en: "## Local dramatic result", minContentChars: 20 },
  { zh: "## 出去压力", en: "## Outgoing pressure", minContentChars: 20 },
  { zh: "## 结尾交接状态", en: "## Handoff state", minContentChars: 20 },
  { zh: "## 信息权限", en: "## Information permissions", minContentChars: 20 },
  { zh: "## 情绪钩子", en: "## Emotional hook", minContentChars: 10 },
  { zh: "## 结尾状态", en: "## End state", minContentChars: 10 },
  {
    zh: "## 本集 Hook ledger",
    en: "## Hook ledger for this episode",
    aliases: ["## 本章 hook 账", "## Hook ledger for this chapter"],
    minContentChars: 20,
  },
  { zh: "## 不要做", en: "## Do not", minContentChars: 1 },
];

// Internal chapter aliases remain readable for persisted plans created before
// the episode contract switch. New Planner output never uses this shape.
const LEGACY_REQUIRED_SECTIONS: ReadonlyArray<RequiredSection> = [
  { zh: "## 当前任务", en: "## Current task", minContentChars: 20 },
  { zh: "## 读者此刻在等什么", en: "## What the reader is waiting for right now", minContentChars: 20 },
  { zh: "## 该兑现的 / 暂不掀的", en: "## To pay off / to keep buried", minContentChars: 20 },
  { zh: "## 日常/过渡承担什么任务", en: "## What the slow / transitional beats carry", minContentChars: 10 },
  { zh: "## 关键抉择过三连问", en: "## Three-question check on the key choice", minContentChars: 20 },
  { zh: "## 章尾必须发生的改变", en: "## Required end-of-chapter change", minContentChars: 20 },
  { zh: "## 本章 hook 账", en: "## Hook ledger for this chapter", minContentChars: 20 },
  { zh: "## 卷级 KR 绑定", en: "## Volume KR binding", minContentChars: 8 },
  { zh: "## 不要做", en: "## Do not", minContentChars: 1 },
];

function isLegacyMemoBody(body: string): boolean {
  return body.includes("## 读者此刻在等什么")
    || body.includes("## What the reader is waiting for right now")
    || body.includes("## 关键抉择过三连问")
    || body.includes("## Three-question check on the key choice");
}

const GOAL_HEADINGS = ["## 本集目标", "## Episode goal", "## 本章目标", "## Chapter goal"] as const;
const THREAD_HEADINGS = ["## 关联线索", "## Thread refs", "## Related threads"] as const;
const VOLUME_KR_HEADINGS = ["## 卷级 KR 绑定", "## Volume KR binding"] as const;
const PAYOFF_HEADINGS = ["## 本集爽点", "## Episode payoff", "## 本章爽点"] as const;
const RELATIONSHIP_PRESSURE_HEADINGS = ["## 关系压力", "## Relationship pressure"] as const;
const REVERSAL_SETUP_HEADINGS = ["## 反转铺垫", "## Reversal setup"] as const;
const REVERSAL_TURN_HEADINGS = ["## 本集反转", "## Episode reversal", "## Reversal turn"] as const;
const REVERSAL_CONSEQUENCE_HEADINGS = ["## 反转后果", "## Reversal consequence"] as const;
const EMOTIONAL_HOOK_HEADINGS = ["## 情绪钩子", "## Emotional hook"] as const;
const END_STATE_HEADINGS = ["## 结尾状态", "## End state"] as const;
const INCOMING_STATE_HEADINGS = ["## 进入状态", "## Incoming state"] as const;
const OBJECTIVE_HEADINGS = ["## 当前目标", "## Episode objective"] as const;
const OPPOSITION_HEADINGS = ["## 反对力量", "## Opposition"] as const;
const CAUSAL_ESCALATION_HEADINGS = ["## 因果升级", "## Causal escalation"] as const;
const TURN_HEADINGS = ["## 方向性转折", "## Directional turn"] as const;
const LOCAL_RESULT_HEADINGS = ["## 当集兑现", "## Local dramatic result"] as const;
const OUTGOING_PRESSURE_HEADINGS = ["## 出去压力", "## Outgoing pressure"] as const;
const HANDOFF_STATE_HEADINGS = ["## 结尾交接状态", "## Handoff state"] as const;
const INFORMATION_PERMISSION_HEADINGS = ["## 信息权限", "## Information permissions"] as const;
const KNOWN_ZH_HEADINGS = [
  ...GOAL_HEADINGS.filter((heading) => /[\u4e00-\u9fff]/u.test(heading)),
  ...THREAD_HEADINGS.filter((heading) => /[\u4e00-\u9fff]/u.test(heading)),
  ...VOLUME_KR_HEADINGS.filter((heading) => /[\u4e00-\u9fff]/u.test(heading)),
  ...REQUIRED_SECTIONS.flatMap((section) => [section.zh, ...(section.aliases ?? [])]),
  ...LEGACY_REQUIRED_SECTIONS.flatMap((section) => [section.zh, ...(section.aliases ?? [])]),
];

function requiredSectionHeadings(section: RequiredSection): ReadonlyArray<string> {
  return [section.zh, section.en, ...(section.aliases ?? [])];
}

/**
 * Extract the content between `heading` and the next `## ...` heading (or
 * end-of-body). Strips whitespace and returns "" if the section payload is
 * absent. The heading itself is NOT included.
 */
function extractSectionContent(body: string, heading: string): string {
  const startIndex = body.indexOf(heading);
  if (startIndex < 0) return "";
  const after = body.slice(startIndex + heading.length);
  // Find the next H2 heading on its own line. The leading newline + ## guards
  // against false matches inside the current section's prose.
  const nextHeadingMatch = after.match(/\n##\s/);
  const sectionRaw = nextHeadingMatch
    ? after.slice(0, nextHeadingMatch.index)
    : after;
  return sectionRaw.replace(/\s+/g, " ").trim();
}

function extractSectionRaw(body: string, heading: string): string {
  const startIndex = body.indexOf(heading);
  if (startIndex < 0) return "";
  const after = body.slice(startIndex + heading.length);
  const nextHeadingMatch = after.match(/\n##\s/);
  const sectionRaw = nextHeadingMatch
    ? after.slice(0, nextHeadingMatch.index)
    : after;
  return sectionRaw.trim();
}

function stripWrappingFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:md|markdown)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function normalizeKnownMemoHeadings(raw: string): string {
  const canonicalByCompactHeading = new Map(
    KNOWN_ZH_HEADINGS.map((heading) => [heading.replace(/\s+/g, ""), heading]),
  );
  return raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("##")) return line;
      return canonicalByCompactHeading.get(trimmed.replace(/\s+/g, "")) ?? line;
    })
    .join("\n");
}

function dropLeadingProse(raw: string): string {
  const markers = [
    "# 第 ",
    "# Chapter ",
    ...GOAL_HEADINGS,
    ...THREAD_HEADINGS,
    ...VOLUME_KR_HEADINGS,
    ...REQUIRED_SECTIONS.flatMap(requiredSectionHeadings),
  ];
  let first = -1;
  for (const marker of markers) {
    const index = raw.indexOf(marker);
    if (index >= 0 && (first < 0 || index < first)) {
      first = index;
    }
  }
  return first >= 0 ? raw.slice(first).trim() : raw.trim();
}

function extractAnyHeading(body: string, headings: ReadonlyArray<string>): string {
  for (const heading of headings) {
    const content = extractSectionContent(body, heading);
    if (content) return content;
  }
  return "";
}

function extractAnyHeadingRaw(body: string, headings: ReadonlyArray<string>): string {
  for (const heading of headings) {
    const content = extractSectionRaw(body, heading);
    if (content) return content;
  }
  return "";
}

function extractGoal(body: string): string {
  const explicitGoal = extractAnyHeading(body, GOAL_HEADINGS);
  if (explicitGoal) {
    return explicitGoal.split(/\n|。|\. /)[0]?.trim() ?? "";
  }
  return "";
}

function extractThreadRefs(body: string): string[] {
  const block = extractAnyHeadingRaw(body, THREAD_HEADINGS);
  if (!block || /^(无|none|n\/a|na|—|-|\(none\))$/i.test(block.trim())) {
    return [];
  }
  const listRefs = block
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(line))
    .filter((line) => !/^(?:none|n\/a|na)$/i.test(line));
  const legacyMatches = block.match(/\b[A-Za-z][A-Za-z0-9_-]*\d+[A-Za-z0-9_-]*\b/g) ?? [];
  return [...new Set([...listRefs, ...legacyMatches])];
}

function extractVolumeKrBinding(body: string): { refs: string[]; rationale: string } {
  const block = extractAnyHeadingRaw(body, VOLUME_KR_HEADINGS);
  if (!block || /^(无|none|n\/a|na|—|-|\(none\))$/i.test(block.trim())) {
    return { refs: [], rationale: "" };
  }
  const refs = new Set<string>();
  for (const match of block.matchAll(/\b(?:V(?:olume)?\s*[-_#:]?\s*\d+\s*[-_:])?KR\s*[-_#:]?\s*(\d+)\b/gi)) {
    refs.add(`KR${match[1]}`);
  }
  for (const match of block.matchAll(/\bV\s*(\d+)\s*[-_:]\s*KR\s*(\d+)\b/gi)) {
    refs.add(`V${match[1]}-KR${match[2]}`);
  }
  const rationaleLines = block
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => line.length > 0)
    .filter((line) => !/^refs?\s*[：:]/i.test(line))
    .filter((line) => !/^(?:绑定|binding)\s*[：:]/i.test(line))
    .map((line) => line.replace(/^(?:推进方式|advancement)\s*[：:]\s*/i, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { refs: [...refs], rationale: rationaleLines };
}

function extractMemoBody(markdown: string): string {
  const starts = REQUIRED_SECTIONS
    .flatMap(requiredSectionHeadings)
    .map((heading) => markdown.indexOf(heading))
    .filter((index) => index >= 0);
  if (starts.length === 0) return markdown.trim();
  return markdown.slice(Math.min(...starts)).trim();
}

function makeDisplayGoal(goal: string): string {
  if (goal.length <= 50) return goal;
  return `${goal.slice(0, 47).trimEnd()}...`;
}

function prependFullGoalIfNeeded(markdown: string, body: string, fullGoal: string, displayGoal: string): string {
  if (fullGoal === displayGoal) return body;
  const heading = markdown.includes("## Episode goal") || markdown.includes("## Chapter goal")
    ? "## Episode goal"
    : "## 本集目标";
  return `${heading}\n${fullGoal}\n\n${body}`;
}

/**
 * Parse a planner memo produced by the LLM.
 *
 * Format: plain Markdown containing a `## 本章目标` / `## Chapter goal`
 * section, an optional thread-ref section, and the required memo section
 * headings.
 *
 * Strict on the LLM-owned memo sections. Caller-owned fields (chapter /
 * golden-opening) come from the host, not from the model. A long chapter goal
 * is kept in the memo body and reduced only to a short display label for the
 * schema field, so parser robustness does not silently delete planning intent.
 *
 * The parser strips a wrapping Markdown code fence and any leading assistant
 * prose ("好的，下面是...") before the first memo heading. It does not accept
 * YAML frontmatter as a required model protocol anymore.
 */
export function parseMemo(
  raw: string,
  expectedChapter: number,
  isGoldenOpening: boolean,
): ChapterMemo {
  const markdown = dropLeadingProse(normalizeKnownMemoHeadings(stripWrappingFence(raw)));
  const goal = extractGoal(markdown);
  const body = extractMemoBody(markdown);
  const requiredSections = isLegacyMemoBody(body) ? LEGACY_REQUIRED_SECTIONS : REQUIRED_SECTIONS;
  const threadRefs = extractThreadRefs(markdown);
  const volumeKrBinding = extractVolumeKrBinding(markdown);
  const optionalFields = {
    payoff: extractAnyHeading(markdown, PAYOFF_HEADINGS) || undefined,
    relationshipPressure: extractAnyHeading(markdown, RELATIONSHIP_PRESSURE_HEADINGS) || undefined,
    reversalSetup: extractAnyHeading(markdown, REVERSAL_SETUP_HEADINGS) || undefined,
    reversalTurn: extractAnyHeading(markdown, REVERSAL_TURN_HEADINGS) || undefined,
    reversalConsequence: extractAnyHeading(markdown, REVERSAL_CONSEQUENCE_HEADINGS) || undefined,
    emotionalHook: extractAnyHeading(markdown, EMOTIONAL_HOOK_HEADINGS) || undefined,
    endState: extractAnyHeading(markdown, END_STATE_HEADINGS) || undefined,
    incomingState: extractAnyHeading(markdown, INCOMING_STATE_HEADINGS) || undefined,
    objective: extractAnyHeading(markdown, OBJECTIVE_HEADINGS) || undefined,
    opposition: extractAnyHeading(markdown, OPPOSITION_HEADINGS) || undefined,
    causalEscalation: extractAnyHeading(markdown, CAUSAL_ESCALATION_HEADINGS) || undefined,
    turn: extractAnyHeading(markdown, TURN_HEADINGS) || undefined,
    localDramaticResult: extractAnyHeading(markdown, LOCAL_RESULT_HEADINGS) || undefined,
    outgoingPressure: extractAnyHeading(markdown, OUTGOING_PRESSURE_HEADINGS) || undefined,
    handoffState: extractAnyHeading(markdown, HANDOFF_STATE_HEADINGS) || undefined,
    informationPermissions: extractAnyHeading(markdown, INFORMATION_PERMISSION_HEADINGS) || undefined,
  };

  if (goal.length === 0) {
    throw new PlannerParseError("goal must be a non-empty string");
  }
  const displayGoal = makeDisplayGoal(goal);

  const missing = requiredSections.filter(
    (section) => !requiredSectionHeadings(section).some((heading) => body.includes(heading)),
  );
  if (missing.length > 0) {
    // Report by zh heading (canonical) so the LLM-feedback loop stays stable.
    throw new PlannerParseError(
      `missing sections: ${missing.map((s) => s.zh).join(", ")}`,
    );
  }

  // Phase hotfix 7: each section's payload must be non-empty (≥ minContentChars).
  // Headings present + blank payload was previously accepted, allowing useless
  // "shell" memos to flow downstream. Threshold differs per section: most need
  // 20 chars (one short sentence) while "## 不要做" / "## Do not" allows 5
  // (e.g. "无", "N/A") since "no extra prohibitions" is a legitimate state.
  const empty = requiredSections.filter((section) => {
    const heading = requiredSectionHeadings(section).find((candidate) => body.includes(candidate)) ?? section.zh;
    const content = extractSectionContent(body, heading);
    return content.length < section.minContentChars;
  });
  if (empty.length > 0) {
    const detail = empty
      .map((s) => `${s.zh} (need ≥ ${s.minContentChars} chars)`)
      .join(", ");
    throw new PlannerParseError(`empty sections: ${detail}`);
  }

  return ChapterMemoSchema.parse({
    chapter: expectedChapter,
    goal: displayGoal,
    isGoldenOpening,
    body: prependFullGoalIfNeeded(markdown, body, goal, displayGoal),
    threadRefs,
    volumeKrRefs: volumeKrBinding.refs,
    volumeKrRationale: volumeKrBinding.rationale,
    ...optionalFields,
  });
}
