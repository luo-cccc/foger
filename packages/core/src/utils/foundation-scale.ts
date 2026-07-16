import { extractVolumeContracts } from "./volume-contract.js";

export const FOUNDATION_COMPACT_MAX_CHAPTERS = 12;
const TARGET_CHAPTERS_PER_VOLUME = 40;

export interface FoundationVolumeRange {
  readonly volume: number;
  readonly startChapter: number;
  readonly endChapter: number;
}

export interface FoundationScalePlan {
  readonly targetChapters: number;
  readonly volumeCount: number;
  readonly ranges: ReadonlyArray<FoundationVolumeRange>;
  readonly chaptersPerKr: number;
  readonly compact: boolean;
}

export interface FoundationScaleIssue {
  readonly code:
    | "volume-count-exceeds-plan"
    | "chapter-range-exceeds-target"
    | "volume-contract-count-mismatch"
    | "volume-contract-range-mismatch"
    | "volume-contract-kr-count-mismatch"
    | "compact-book-defers-resolution"
    | "compact-beat-count-mismatch"
    | "compact-beat-fields-missing";
  readonly zh: string;
  readonly en: string;
}

export function buildFoundationScalePlan(targetChapters: number): FoundationScalePlan {
  const target = Number.isFinite(targetChapters)
    ? Math.max(1, Math.round(targetChapters))
    : 1;
  const volumeCount = target <= FOUNDATION_COMPACT_MAX_CHAPTERS
    ? 1
    : Math.max(1, Math.ceil(target / TARGET_CHAPTERS_PER_VOLUME));
  const baseSize = Math.floor(target / volumeCount);
  const remainder = target % volumeCount;
  const ranges: FoundationVolumeRange[] = [];
  let startChapter = 1;

  for (let volume = 1; volume <= volumeCount; volume += 1) {
    const size = baseSize + (volume <= remainder ? 1 : 0);
    const endChapter = startChapter + size - 1;
    ranges.push({ volume, startChapter, endChapter });
    startChapter = endChapter + 1;
  }

  return {
    targetChapters: target,
    volumeCount,
    ranges,
    chaptersPerKr: Math.max(1, Math.round((target / volumeCount) / 3)),
    compact: target <= FOUNDATION_COMPACT_MAX_CHAPTERS,
  };
}

export function renderFoundationScaleGuidance(
  targetChapters: number,
  language: "zh" | "en",
): string {
  const plan = buildFoundationScalePlan(targetChapters);
  const ranges = plan.ranges
    .map((range) => language === "en"
      ? `Volume ${range.volume}: chapters ${range.startChapter}-${range.endChapter}`
      : `第${range.volume}卷：第${range.startChapter}-${range.endChapter}章`)
    .join(language === "en" ? "; " : "；");
  const contractTemplate = plan.ranges
    .map((range) => language === "en"
      ? `## Volume ${range.volume}: <title> (Chapters ${range.startChapter}-${range.endChapter})
Objective: <verifiable volume-end state>
KR1: <observable result>
KR2: <observable result>
KR3: <observable result>
Irreversible Event: <mandatory volume-end change>`
      : `## 第${range.volume}卷《卷名》（第${range.startChapter}-${range.endChapter}章）
Objective: <可验证的卷末状态>
KR1: <可观察结果>
KR2: <可观察结果>
KR3: <可观察结果>
Irreversible Event: <卷尾必须发生的不可逆改变>`)
    .join("\n\n");
  const compactBeatTemplate = plan.compact
    ? Array.from({ length: plan.targetChapters }, (_, index) => language === "en"
      ? `Chapter ${index + 1}: Goal=<active scene goal> | Obstacle=<concrete resistance> | Turn=<new decision or reversal> | Delivery=<observable result> | End Hook=<causal handoff or final aftermath>`
      : `第${index + 1}章：目标=<本章主动行动> | 阻碍=<具体阻力> | 转折=<新决定或反转> | 交付=<可观察结果> | 章末钩子=<因果接力或终局后效>`)
      .join("\n")
    : "";

  if (language === "en") {
    return `## Whole-book scale contract (overrides generic volume advice)
- The requested ${plan.targetChapters} chapters are the TOTAL chapter count, not the number of volumes.
- Plan exactly ${plan.volumeCount} volume(s): ${ranges}. All volume ranges must add up to exactly ${plan.targetChapters} chapters.
- The five content paragraphs required inside volume_map are five planning dimensions, NOT five volumes.
- Start volume_map with exactly these parseable execution blocks (replace angle-bracket placeholders, keep the Markdown headings and field labels exactly):
${contractTemplate}
- The assigned ranges are volume boundaries, not chapter-by-chapter tasks. Put the five prose planning dimensions after the execution blocks without creating extra volume headings.
- Complete each volume's three KRs inside its assigned chapter range; place observable KR delivery points roughly every ${plan.chaptersPerKr} chapter(s), instead of blindly spending 3-5 chapters on every KR.
- Chapter ${plan.targetChapters} is the book ending: it must complete the Book Objective and resolve the core conflict. Do not defer that work to a later volume or another "chapter ${plan.targetChapters}".${plan.compact ? `
- This is a compact complete work. Volume 1 is the entire book, not the opening arc of a longer serialization. Volume 1's Objective must equal the complete Book Objective, and KR3 must deliver it. Phrases such as "first clue", "tip of the iceberg", "left for a sequel/later work", or "still not fully revealed" are contract violations.
- Compact works are the sole exception to the general ban on chapter-level planning. Immediately after the volume execution block, emit this exact parseable beat contract with one distinct line per chapter. Replace every placeholder and keep all five labels:
### Compact Chapter Beat Contract
${compactBeatTemplate}
- Every turn must change the available choice or information, every delivery must be externally observable, and each End Hook must causally launch the next chapter. The final chapter's End Hook is aftermath/closure, not deferred core conflict.` : ""}`;
  }

  return `## 全书尺度合同（优先级高于通用分卷建议）
- 用户要求的${plan.targetChapters}章是全书总章数，不是卷数。
- 必须恰好规划${plan.volumeCount}卷：${ranges}。所有卷的章节范围相加必须严格等于${plan.targetChapters}章。
- volume_map 要求的“5段主体”是五个规划维度，不是五卷，禁止据此生成五卷。
- volume_map 开头必须严格输出以下可解析执行合同（替换尖括号占位内容，Markdown 标题和字段名必须原样保留；不能只用加粗文本表示卷名）：
${contractTemplate}
- 上述范围只是卷边界，不是逐章任务。执行合同之后再写五个散文规划维度，不得创建额外卷标题。
- 每卷3个 KR 必须在该卷分配的章节内全部完成，约每${plan.chaptersPerKr}章出现一个可观察的 KR 交付点；不要机械套用“每个 KR 都花3-5章”。
- 第${plan.targetChapters}章就是全书终章，必须完成全书 Objective 并解决核心冲突，不得把终局推迟到后续卷，也不得在第${plan.targetChapters}章里再写“留到第${plan.targetChapters}章大结局”。${plan.compact ? `
- 这是紧凑完结作品，第1卷就是全书，不是更长连载的开篇卷。第1卷 Objective 必须等于完整的全书 Objective，KR3 必须交付它；“第一块线索”“冰山一角”“留待后续作品”“核心仍未完全揭示”等表述均属于合同违规。
- 紧凑完结作是“禁止章级规划”的唯一例外。紧接卷执行合同，严格输出以下可解析节拍合同：每章恰好一行、替换全部占位符、保留五个字段名。
### 紧凑篇逐章节拍合同
${compactBeatTemplate}
- 每章转折必须改变选择或信息，交付必须可被外部观察；章末钩子必须因果启动下一章。终章钩子写后效/闭环，不得把核心冲突留到书外。` : ""}`;
}

export function validateFoundationVolumeScale(
  volumeMap: string,
  targetChapters: number,
): ReadonlyArray<FoundationScaleIssue> {
  const plan = buildFoundationScalePlan(targetChapters);
  const declaredVolumes = extractDeclaredVolumeNumbers(volumeMap);
  const explicitTotals = extractExplicitVolumeTotals(volumeMap);
  const detectedVolumeCount = Math.max(0, ...declaredVolumes, ...explicitTotals);
  const issues: FoundationScaleIssue[] = [];

  if (detectedVolumeCount > plan.volumeCount) {
    issues.push({
      code: "volume-count-exceeds-plan",
      zh: `确定性尺度校验失败：目标${plan.targetChapters}章只能规划${plan.volumeCount}卷，但卷纲声明或引用了${detectedVolumeCount}卷。`,
      en: `Deterministic scale check failed: ${plan.targetChapters} target chapters allow ${plan.volumeCount} volume(s), but the volume map declares or references ${detectedVolumeCount}.`,
    });
  }

  const maxReferencedChapter = extractMaxChapterRangeEnd(volumeMap);
  if (maxReferencedChapter > plan.targetChapters) {
    issues.push({
      code: "chapter-range-exceeds-target",
      zh: `确定性尺度校验失败：卷纲章节范围延伸到第${maxReferencedChapter}章，超过全书目标${plan.targetChapters}章。`,
      en: `Deterministic scale check failed: the volume map extends to chapter ${maxReferencedChapter}, beyond the ${plan.targetChapters}-chapter target.`,
    });
  }

  const contracts = extractVolumeContracts(volumeMap);
  if (contracts.length !== plan.volumeCount) {
    issues.push({
      code: "volume-contract-count-mismatch",
      zh: `确定性尺度校验失败：卷纲必须提供${plan.volumeCount}个可解析卷合同（Markdown 卷标题 + Objective/KR1-KR3/Irreversible Event），实际解析到${contracts.length}个。`,
      en: `Deterministic scale check failed: volume_map must provide ${plan.volumeCount} parseable volume contract(s) (Markdown volume heading + Objective/KR1-KR3/Irreversible Event), but ${contracts.length} were parsed.`,
    });
  }

  for (const expected of plan.ranges) {
    const contract = contracts.find((candidate) => candidate.volumeNumber === expected.volume);
    if (!contract) continue;
    if (contract.chapterStart !== expected.startChapter || contract.chapterEnd !== expected.endChapter) {
      issues.push({
        code: "volume-contract-range-mismatch",
        zh: `确定性尺度校验失败：第${expected.volume}卷合同必须覆盖第${expected.startChapter}-${expected.endChapter}章，实际解析范围为${renderParsedRange(contract.chapterStart, contract.chapterEnd, "zh")}。`,
        en: `Deterministic scale check failed: Volume ${expected.volume} must cover chapters ${expected.startChapter}-${expected.endChapter}, but its parsed range is ${renderParsedRange(contract.chapterStart, contract.chapterEnd, "en")}.`,
      });
    }
    if (contract.keyResults.length !== 3) {
      issues.push({
        code: "volume-contract-kr-count-mismatch",
        zh: `确定性尺度校验失败：第${expected.volume}卷合同必须包含恰好3个可解析 KR，实际解析到${contract.keyResults.length}个。`,
        en: `Deterministic scale check failed: Volume ${expected.volume} must contain exactly 3 parseable KRs, but ${contract.keyResults.length} were parsed.`,
      });
    }
  }

  if (plan.compact) {
    const beatSection = extractCompactBeatSection(volumeMap);
    const declaredBeatChapters = extractCompactBeatLineChapterNumbers(beatSection);
    const expectedBeatChapters = Array.from({ length: plan.targetChapters }, (_, index) => index + 1);
    if (
      declaredBeatChapters.length !== expectedBeatChapters.length
      || declaredBeatChapters.some((chapter, index) => chapter !== expectedBeatChapters[index])
    ) {
      issues.push({
        code: "compact-beat-count-mismatch",
        zh: `确定性节奏校验失败：紧凑完结作必须按顺序提供第1-${plan.targetChapters}章的逐章节拍合同，实际识别为${declaredBeatChapters.length > 0 ? declaredBeatChapters.join("、") : "无"}。`,
        en: `Deterministic pacing check failed: the compact complete work must provide ordered chapter beats 1-${plan.targetChapters}, but detected ${declaredBeatChapters.length > 0 ? declaredBeatChapters.join(", ") : "none"}.`,
      });
    } else {
      const completeBeats = extractCompleteCompactChapterBeats(beatSection);
      if (completeBeats.length !== plan.targetChapters) {
        issues.push({
          code: "compact-beat-fields-missing",
          zh: "确定性节奏校验失败：每章节拍必须同时填写目标、阻碍、转折、交付和章末钩子，且不能保留占位符。",
          en: "Deterministic pacing check failed: every chapter beat must fill Goal, Obstacle, Turn, Delivery, and End Hook without placeholders.",
        });
      }
    }

    const deferralSignals = extractCompactDeferralSignals(volumeMap);
    if (deferralSignals.length > 0) {
      issues.push({
        code: "compact-book-defers-resolution",
        zh: `确定性尺度校验失败：紧凑完结作把核心解决推迟到了书外：${deferralSignals.join("；")}。第${plan.targetChapters}章必须完成全书 Objective。`,
        en: `Deterministic scale check failed: the compact complete work defers core resolution beyond the book: ${deferralSignals.join("; ")}. Chapter ${plan.targetChapters} must complete the Book Objective.`,
      });
    }
  }

  return issues;
}

function extractCompactBeatSection(content: string): string {
  const lines = content.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => (
    /^#{2,6}\s*(?:紧凑篇逐章节拍合同|Compact Chapter Beat Contract)\s*$/iu.test(line.trim())
  ));
  const firstBeatLineIndex = lines.findIndex((line) => (
    /^(?:第\s*\d+\s*章\s*[：:]\s*目标\s*[:=：]|Chapter\s+\d+\s*[：:]\s*Goal\s*[:=：])/iu.test(line.trim())
  ));
  const start = headingIndex >= 0 ? headingIndex + 1 : firstBeatLineIndex;
  if (start < 0) return "";
  const section: string[] = [];
  for (const line of lines.slice(start)) {
    if (/^#{1,6}\s+/u.test(line.trim())) break;
    section.push(line);
  }
  return section.join("\n");
}

function extractCompactBeatLineChapterNumbers(section: string): number[] {
  const values: number[] = [];
  for (const rawLine of section.split(/\r?\n/u)) {
    const match = rawLine.trim().match(/^(?:第\s*(\d+)\s*章|Chapter\s+(\d+))\s*[：:]/iu);
    const value = Number.parseInt(match?.[1] ?? match?.[2] ?? "", 10);
    if (Number.isInteger(value) && value > 0 && !values.includes(value)) values.push(value);
  }
  return values;
}

function extractCompleteCompactChapterBeats(section: string): number[] {
  const complete: number[] = [];
  const value = "([^|｜<>\\r\\n]{2,})";
  const zhPattern = new RegExp(
    `^第\\s*(\\d+)\\s*章\\s*[：:]\\s*目标\\s*[:=：]\\s*${value}\\s*[|｜]\\s*阻碍\\s*[:=：]\\s*${value}\\s*[|｜]\\s*转折\\s*[:=：]\\s*${value}\\s*[|｜]\\s*交付\\s*[:=：]\\s*${value}\\s*[|｜]\\s*章末钩子\\s*[:=：]\\s*${value}\\s*$`,
    "iu",
  );
  const enPattern = new RegExp(
    `^Chapter\\s+(\\d+)\\s*[：:]\\s*Goal\\s*[:=：]\\s*${value}\\s*[|｜]\\s*Obstacle\\s*[:=：]\\s*${value}\\s*[|｜]\\s*Turn\\s*[:=：]\\s*${value}\\s*[|｜]\\s*Delivery\\s*[:=：]\\s*${value}\\s*[|｜]\\s*End Hook\\s*[:=：]\\s*${value}\\s*$`,
    "iu",
  );
  for (const rawLine of section.split(/\r?\n/u)) {
    const match = rawLine.trim().match(zhPattern) ?? rawLine.trim().match(enPattern);
    const chapter = Number.parseInt(match?.[1] ?? "", 10);
    if (Number.isInteger(chapter) && chapter > 0 && !complete.includes(chapter)) complete.push(chapter);
  }
  return complete;
}

export function normalizeFoundationVolumeContracts(
  volumeMap: string,
  targetChapters: number,
  language: "zh" | "en",
): string {
  const plan = buildFoundationScalePlan(targetChapters);
  if (!plan.compact || extractVolumeContracts(volumeMap).length > 0) return volumeMap;

  const plain = volumeMap.replace(/\*\*/g, "");
  const objective = extractLooseContractField(plain, "Objective");
  const keyResults = [1, 2, 3].map((index) => (
    extractLooseContractField(plain, `KR${index}`)
  ));
  const irreversibleEvent = extractLooseContractField(plain, "Irreversible Event")
    ?? extractCompactIrreversibleEvent(plain, language);
  if (!objective || keyResults.some((value) => !value) || !irreversibleEvent) return volumeMap;

  const title = extractCompactVolumeTitle(plain, language);
  const range = plan.ranges[0]!;
  const contract = [
    language === "en"
      ? `## Volume 1: ${title} (Chapters ${range.startChapter}-${range.endChapter})`
      : `## 第1卷《${title}》（第${range.startChapter}-${range.endChapter}章）`,
    `Objective: ${objective}`,
    ...keyResults.map((value, index) => `KR${index + 1}: ${value}`),
    `Irreversible Event: ${irreversibleEvent}`,
  ].join("\n");
  return `${contract}\n\n---\n\n${volumeMap.trim()}`;
}

function extractLooseContractField(content: string, label: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/u, "");
    if (line.slice(0, label.length).toLowerCase() !== label.toLowerCase()) continue;
    const remainder = line
      .slice(label.length)
      .replace(/^\s*[（(][^）)\r\n]*[）)]/u, "")
      .replace(/^\s*[：:]\s*/u, "");
    if (remainder === line.slice(label.length)) continue;
    const value = cleanLooseContractValue(remainder);
    if (value) return value;
  }
  return undefined;
}

function extractCompactIrreversibleEvent(
  content: string,
  language: "zh" | "en",
): string | undefined {
  const lines = content.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => {
    const heading = line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim() ?? "";
    return language === "en"
      ? /^(?:04[_\s].*Volume.End|Volume.End.Mandatory.Changes)/iu.test(heading)
      : /^(?:段\s*4|卷尾必须发生的改变)/u.test(heading);
  });
  if (sectionStart < 0) return undefined;

  for (const rawLine of lines.slice(sectionStart + 1)) {
    if (/^#{1,6}\s+/u.test(rawLine)) break;
    const line = cleanLooseContractValue(rawLine);
    if (!line || line === "---") continue;
    if (language === "en" && /must (?:contain|include|happen)|following changes/i.test(line)) continue;
    if (language === "zh" && /必须发生以下|一条都不能少|必须发生什么/.test(line)) continue;
    if (line.length >= 8) return line;
  }
  return undefined;
}

function extractCompactVolumeTitle(content: string, language: "zh" | "en"): string {
  if (language === "en") {
    return content.match(/Volume\s+1\s*[:：-]?\s*([^\r\n(]{1,80})/iu)?.[1]?.trim()
      || "Complete Work";
  }
  return content.match(/第\s*[1一]\s*卷\s*《([^》\r\n]{1,80})》/u)?.[1]?.trim()
    || "全书";
}

function cleanLooseContractValue(value: string): string {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)、])\s*/u, "")
    .replace(/^[：:]\s*/u, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractCompactDeferralSignals(content: string): string[] {
  const patterns: ReadonlyArray<RegExp> = [
    /(?:留待|留到|推迟到|延后到)(?:后续|以后|下一|未来)[^。！？\r\n]{0,40}/gu,
    /(?:后续|下一部|续作|续篇|未来)(?:作品|卷|章节|故事)?[^。！？\r\n]{0,40}(?:揭(?:示|秘|晓)|回收|解释|解决|完成|实作|展开)/gu,
    /(?:仍然|仍|尚|还)(?:没有|未)[^。！？\r\n]{0,28}(?:揭示|解释|回收|解决|完成|播放)/gu,
    /(?:冰山一角|第一(?:个|块|步|阶段)[^。！？\r\n]{0,24}(?:线索|碎片|推进|突破))/gu,
    /(?:left|saved|reserved|deferred)\s+for\s+(?:a\s+)?(?:sequel|later|future|the\s+next)[^.!?\r\n]{0,40}/giu,
    /(?:tip of the iceberg|first (?:clue|fragment|step|breakthrough)|still not (?:fully )?(?:revealed|resolved|explained|completed))/giu,
  ];
  const signals: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const signal = match[0].trim();
      if (signal && !signals.includes(signal)) signals.push(signal);
      if (signals.length >= 3) return signals;
    }
  }
  return signals;
}

function renderParsedRange(
  start: number | undefined,
  end: number | undefined,
  language: "zh" | "en",
): string {
  if (start === undefined || end === undefined) {
    return language === "zh" ? "缺失" : "missing";
  }
  return language === "zh" ? `第${start}-${end}章` : `chapters ${start}-${end}`;
}

function extractDeclaredVolumeNumbers(content: string): number[] {
  const values: number[] = [];
  for (const match of content.matchAll(/第\s*([零〇一二三四五六七八九十百两\d]+)\s*卷/gu)) {
    const value = parseChineseInteger(match[1] ?? "");
    if (value > 0) values.push(value);
  }
  for (const match of content.matchAll(/\bVolume\s+(\d+)\b/giu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (value > 0) values.push(value);
  }
  return values;
}

function extractExplicitVolumeTotals(content: string): number[] {
  const values: number[] = [];
  for (const match of content.matchAll(/(?:全书|本书)?\s*共\s*([零〇一二三四五六七八九十百两\d]+)\s*卷/gu)) {
    const value = parseChineseInteger(match[1] ?? "");
    if (value > 0) values.push(value);
  }
  for (const match of content.matchAll(/(?:total(?:s|ing)?|consists?\s+of)\s+(\d+)\s+volumes?/giu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (value > 0) values.push(value);
  }
  return values;
}

function extractMaxChapterRangeEnd(content: string): number {
  const ends: number[] = [];
  for (const match of content.matchAll(/(?:第\s*)?(\d+)\s*(?:-|–|—|~|至|到)\s*(\d+)\s*章/gu)) {
    ends.push(Number.parseInt(match[2] ?? "0", 10));
  }
  for (const match of content.matchAll(/chapters?\s+(\d+)\s*(?:-|–|—|~|to)\s*(\d+)/giu)) {
    ends.push(Number.parseInt(match[2] ?? "0", 10));
  }
  return Math.max(0, ...ends);
}

function parseChineseInteger(value: string): number {
  if (/^\d+$/u.test(value)) return Number.parseInt(value, 10);
  const digits: Readonly<Record<string, number>> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  if (value === "百") return 100;
  const hundredIndex = value.indexOf("百");
  if (hundredIndex >= 0) {
    const hundreds = hundredIndex === 0 ? 1 : digits[value[hundredIndex - 1] ?? ""] ?? 0;
    return (hundreds * 100) + parseChineseInteger(value.slice(hundredIndex + 1));
  }
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[value[tenIndex - 1] ?? ""] ?? 0;
    const ones = digits[value[tenIndex + 1] ?? ""] ?? 0;
    return (tens * 10) + ones;
  }
  return [...value].reduce((total, char) => (total * 10) + (digits[char] ?? 0), 0);
}
