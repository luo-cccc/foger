import { createHash } from "node:crypto";
import type { ChapterMemo } from "../models/input-governance.js";
import { parseHookLedger, type HookLedgerEntry } from "./hook-ledger-validator.js";

export type ChapterExecutionDirectiveKind =
  | "current-task"
  | "payoff"
  | "end-change"
  | "do-not"
  | "keep-buried"
  | "open-hook";

export interface ChapterExecutionDirective {
  readonly id: string;
  readonly kind: ChapterExecutionDirectiveKind;
  readonly text: string;
  readonly anchors: ReadonlyArray<string>;
}

export interface ChapterExecutionHookAction {
  readonly hookId: string;
  readonly action: "advance" | "resolve";
  readonly description: string;
  readonly anchors: ReadonlyArray<string>;
}

export interface ChapterDeferredHook {
  readonly hookId: string;
  readonly description: string;
  readonly anchors: ReadonlyArray<string>;
}

export interface ChapterExecutionContract {
  readonly version: "1.0";
  readonly chapter: number;
  readonly goal: string;
  readonly referencedHooks: ReadonlyArray<string>;
  readonly volumeMovement: ReadonlyArray<string>;
  readonly mustLand: ReadonlyArray<ChapterExecutionDirective>;
  readonly mustAvoid: ReadonlyArray<ChapterExecutionDirective>;
  readonly hookActions: ReadonlyArray<ChapterExecutionHookAction>;
  readonly deferredHooks: ReadonlyArray<ChapterDeferredHook>;
  readonly fingerprint: string;
}

const SECTION_HEADINGS = {
  currentTask: ["## 当前任务", "## Current task"],
  payoff: ["## 该兑现的 / 暂不掀的", "## To pay off / to keep buried"],
  endChange: ["## 章尾必须发生的改变", "## Required end-of-chapter change"],
  doNot: ["## 不要做", "## Do not"],
  volumeMovement: ["## 卷级 KR 绑定", "## Volume KR binding"],
} as const;

const PLACEHOLDER = /^(?:none|n\/a|na|无|暂无|不适用|本章无|无额外要求)$/i;
const MAX_DIRECTIVE_CHARS = 280;

export function compileChapterExecutionContract(memo: ChapterMemo): ChapterExecutionContract {
  const currentTask = extractSection(memo.body, SECTION_HEADINGS.currentTask);
  const payoff = extractSection(memo.body, SECTION_HEADINGS.payoff);
  const endChange = extractSection(memo.body, SECTION_HEADINGS.endChange);
  const doNot = extractSection(memo.body, SECTION_HEADINGS.doNot);
  const volumeMovementSection = extractSection(memo.body, SECTION_HEADINGS.volumeMovement);
  const ledger = parseHookLedger(memo.body);

  const mustLand: ChapterExecutionDirective[] = [];
  for (const text of sectionItems(currentTask)) {
    mustLand.push(directive("task", "current-task", text));
  }
  for (const text of sectionItems(payoff).flatMap(splitPayoffClauses)) {
    if (isPayoffDirective(text)) {
      mustLand.push(directive("payoff", "payoff", stripDirectivePrefix(text)));
    }
  }
  for (const text of sectionItems(endChange)) {
    mustLand.push(directive("end", "end-change", text));
  }
  for (const text of ledger.newOpenDescriptions) {
    mustLand.push(directive("open", "open-hook", text));
  }

  const mustAvoid: ChapterExecutionDirective[] = [];
  for (const text of sectionItems(payoff).flatMap(splitPayoffClauses)) {
    if (isKeepBuriedDirective(text)) {
      mustAvoid.push(directive("buried", "keep-buried", stripDirectivePrefix(text)));
    }
  }
  for (const text of sectionItems(doNot)) {
    mustAvoid.push(directive("avoid", "do-not", text));
  }

  const hookActions = [
    ...ledger.advance.map((entry) => hookAction("advance", entry)),
    ...ledger.resolve.map((entry) => hookAction("resolve", entry)),
  ];
  const deferredHooks = ledger.defer.map(deferredHook);

  const base = {
    version: "1.0" as const,
    chapter: memo.chapter,
    goal: memo.goal.trim(),
    referencedHooks: [...new Set(memo.threadRefs.map((id) => id.trim()).filter(Boolean))],
    volumeMovement: compileVolumeMovement(memo, volumeMovementSection),
    mustLand: dedupeDirectives(mustLand),
    mustAvoid: dedupeDirectives(mustAvoid),
    hookActions: dedupeHookActions(hookActions),
    deferredHooks: dedupeDeferredHooks(deferredHooks),
  };
  return {
    ...base,
    fingerprint: createHash("sha256").update(JSON.stringify(base), "utf8").digest("hex").slice(0, 20),
  };
}

export function renderChapterExecutionContract(
  contract: ChapterExecutionContract,
  language: "zh" | "en" = "zh",
): string {
  const isEnglish = language === "en";
  const lines = [
    `## ${isEnglish ? "Chapter execution contract" : "章节执行合同"} (${contract.fingerprint})`,
    `- ${isEnglish ? "Goal" : "目标"}: ${contract.goal}`,
    `- ${isEnglish ? "Contract IDs and the fingerprint are control metadata; never print them in prose." : "合同 ID 与指纹仅供控制使用，不得写入正文。"}`,
    `- ${isEnglish ? "Unlisted hooks are implicitly deferred; do not resolve them." : "未列入执行动作的 hook 默认延后，正文不得擅自回收。"}`,
  ];

  appendDirectiveSection(
    lines,
    isEnglish ? "Must land on page" : "正文必须落地",
    contract.mustLand,
  );
  appendDirectiveSection(
    lines,
    isEnglish ? "Must not happen / reveal ceiling" : "禁止事项 / 揭示上限",
    contract.mustAvoid,
  );

  if (contract.referencedHooks.length > 0) {
    lines.push(`### ${isEnglish ? "Referenced hooks" : "关联 hook"}`);
    lines.push(`- ${contract.referencedHooks.slice(0, 12).join(", ")}`);
  }

  if (contract.volumeMovement.length > 0) {
    lines.push(`### ${isEnglish ? "Volume KR movement" : "卷级 KR 推进"}`);
    for (const item of contract.volumeMovement.slice(0, 6)) {
      lines.push(`- ${truncate(item)}`);
    }
  }

  if (contract.hookActions.length > 0) {
    lines.push(`### ${isEnglish ? "Allowed hook actions" : "允许的 hook 动作"}`);
    for (const item of contract.hookActions.slice(0, 8)) {
      lines.push(`- [${item.action}:${item.hookId}] ${truncate(item.description)}`);
    }
  }

  if (contract.deferredHooks.length > 0) {
    lines.push(`### ${isEnglish ? "Explicitly deferred reveals" : "明确延后的揭示"}`);
    for (const item of contract.deferredHooks.slice(0, 8)) {
      lines.push(`- [defer:${item.hookId}] ${truncate(item.description)}`);
    }
  }

  return lines.join("\n");
}

export function extractDirectiveAnchors(
  text: string,
  language: "zh" | "en" = /[\u4e00-\u9fff]/.test(text) ? "zh" : "en",
): ReadonlyArray<string> {
  const quoted = text.match(/[“"']([^”"'\n]{2,80})[”"']/)?.[1];
  const source = (quoted ?? text)
    .replace(/\b[A-Z]\d{2,}\b/gi, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/（[^）]*）/g, " ")
    .replace(/(?:->|→|\|\|).*/g, " ");

  if (language === "en") {
    const generic = new Set([
      "chapter", "current", "must", "should", "keep", "buried", "payoff", "advance",
      "resolve", "defer", "change", "information", "relationship", "physical", "power",
    ]);
    return [...new Set((source.match(/[A-Za-z][A-Za-z'-]{3,}/g) ?? [])
      .map((term) => term.toLowerCase())
      .filter((term) => !generic.has(term)))]
      .slice(0, 6);
  }

  const normalized = source
    .replace(/(?:不要|不得|禁止|必须|本章|当前|需要|应该|暂不|不动|留到|等待|理由|时机|是否|为何|为什么|怎么|内容|身份|来历|真相|完整|部分)/g, "|")
    .replace(/[：:，,。；;、\s/]+/g, "|");
  const generic = new Set([
    "主角", "角色", "读者", "信息", "关系", "改变", "动作", "场景", "证据", "目标",
    "推进", "发生", "确认", "发现", "获得", "处理", "揭示", "答案", "名单",
  ]);
  const terms = normalized
    .split("|")
    .map((term) => term.replace(/^(?:让|把|给|为|与|和|的|对)/, "").trim())
    .filter((term) => /^[\u4e00-\u9fff]{2,12}$/.test(term))
    .filter((term) => !generic.has(term));
  return [...new Set(terms)].slice(0, 6);
}

function directive(
  prefix: string,
  kind: ChapterExecutionDirectiveKind,
  text: string,
): ChapterExecutionDirective {
  const normalized = truncate(text);
  return {
    id: `${prefix}-${createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 8)}`,
    kind,
    text: normalized,
    anchors: extractDirectiveAnchors(normalized),
  };
}

function hookAction(
  action: ChapterExecutionHookAction["action"],
  entry: HookLedgerEntry,
): ChapterExecutionHookAction {
  return {
    hookId: entry.id,
    action,
    description: truncate(entry.descriptor),
    anchors: extractDirectiveAnchors(entry.descriptor),
  };
}

function deferredHook(entry: HookLedgerEntry): ChapterDeferredHook {
  return {
    hookId: entry.id,
    description: truncate(entry.descriptor),
    anchors: extractDirectiveAnchors(entry.descriptor),
  };
}

function extractSection(body: string, headings: ReadonlyArray<string>): string {
  const lines = body.split(/\r?\n/);
  let collecting = false;
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (headings.includes(trimmed)) {
      collecting = true;
      continue;
    }
    if (collecting && /^##\s+/.test(trimmed)) break;
    if (collecting) result.push(line);
  }
  return result.join("\n").trim();
}

function sectionItems(section: string): string[] {
  if (!section.trim()) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !PLACEHOLDER.test(line));
}

function splitPayoffClauses(text: string): string[] {
  return text
    .split(/[；;](?=\s*(?:该兑现|兑现|暂不掀|暂不兑现|Pay off|Keep buried|Keep hidden)\s*[:：])/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compileVolumeMovement(memo: ChapterMemo, section: string): string[] {
  const sectionValues = sectionItems(section);
  if (sectionValues.length > 0) return [...new Set(sectionValues.map(truncate))];
  const refs = memo.volumeKrRefs?.map((ref) => ref.trim()).filter(Boolean) ?? [];
  const rationale = memo.volumeKrRationale?.trim();
  if (refs.length === 0 && !rationale) return [];
  return [truncate(`${refs.join(", ") || "buffer"}${rationale ? `: ${rationale}` : ""}`)];
}

function isPayoffDirective(text: string): boolean {
  return /^(?:该兑现|兑现|Pay off)\s*[:：]/i.test(text);
}

function isKeepBuriedDirective(text: string): boolean {
  return /^(?:暂不掀|暂不兑现|Keep buried|Keep hidden)\s*[:：]/i.test(text);
}

function stripDirectivePrefix(text: string): string {
  return text.replace(/^(?:该兑现|兑现|暂不掀|暂不兑现|Pay off|Keep buried|Keep hidden)\s*[:：]\s*/i, "").trim();
}

function appendDirectiveSection(
  lines: string[],
  heading: string,
  directives: ReadonlyArray<ChapterExecutionDirective>,
): void {
  if (directives.length === 0) return;
  lines.push(`### ${heading}`);
  for (const item of directives.slice(0, 8)) {
    lines.push(`- [${item.id}] ${truncate(item.text)}`);
  }
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > MAX_DIRECTIVE_CHARS
    ? `${normalized.slice(0, MAX_DIRECTIVE_CHARS - 3)}...`
    : normalized;
}

function dedupeDirectives(items: ReadonlyArray<ChapterExecutionDirective>): ChapterExecutionDirective[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeHookActions(items: ReadonlyArray<ChapterExecutionHookAction>): ChapterExecutionHookAction[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.action}:${item.hookId.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDeferredHooks(items: ReadonlyArray<ChapterDeferredHook>): ChapterDeferredHook[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.hookId.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
