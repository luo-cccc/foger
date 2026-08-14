import { extractVolumeContracts } from "./volume-contract.js";

export const FOUNDATION_COMPACT_MAX_EPISODES = 12;
const TARGET_EPISODES_PER_VOLUME = 10;

export interface FoundationScaleOptions {
  readonly unitsPerVolume?: number;
}

export interface FoundationVolumeRange {
  readonly volume: number;
  readonly startEpisode: number;
  readonly endEpisode: number;
}

export interface FoundationScalePlan {
  readonly targetEpisodes: number;
  readonly volumeCount: number;
  readonly ranges: ReadonlyArray<FoundationVolumeRange>;
  readonly episodesPerKr: number;
  readonly compact: boolean;
}

export interface FoundationScaleIssue {
  readonly code:
    | "volume-count-exceeds-plan"
    | "episode-range-exceeds-target"
    | "volume-contract-count-mismatch"
    | "volume-contract-range-mismatch"
    | "volume-contract-kr-count-mismatch"
    | "compact-book-defers-resolution"
    | "compact-beat-count-mismatch"
    | "compact-beat-fields-missing";
  readonly zh: string;
  readonly en: string;
}

export function buildFoundationScalePlan(
  targetEpisodes: number,
  options: FoundationScaleOptions = {},
): FoundationScalePlan {
  const unitsPerVolume = Number.isFinite(options.unitsPerVolume)
    ? Math.max(1, Math.round(options.unitsPerVolume!))
    : TARGET_EPISODES_PER_VOLUME;
  const target = Number.isFinite(targetEpisodes)
    ? Math.max(1, Math.round(targetEpisodes))
    : 1;
  const volumeCount = target <= FOUNDATION_COMPACT_MAX_EPISODES
    ? 1
    : Math.max(1, Math.ceil(target / unitsPerVolume));
  const baseSize = Math.floor(target / volumeCount);
  const remainder = target % volumeCount;
  const ranges: FoundationVolumeRange[] = [];
  let startEpisode = 1;

  for (let volume = 1; volume <= volumeCount; volume += 1) {
    const size = baseSize + (volume <= remainder ? 1 : 0);
    const endEpisode = startEpisode + size - 1;
    ranges.push({ volume, startEpisode, endEpisode });
    startEpisode = endEpisode + 1;
  }

  return {
    targetEpisodes: target,
    volumeCount,
    ranges,
    episodesPerKr: Math.max(1, Math.round((target / volumeCount) / 3)),
    compact: target <= FOUNDATION_COMPACT_MAX_EPISODES,
  };
}

export function renderFoundationScaleGuidance(
  targetEpisodes: number,
  language: "zh" | "en",
  options: FoundationScaleOptions = {},
): string {
  const plan = buildFoundationScalePlan(targetEpisodes, options);
  const ranges = plan.ranges
    .map((range) => language === "en"
      ? `Arc ${range.volume}: episodes ${range.startEpisode}-${range.endEpisode}`
      : `第${range.volume}篇：第${range.startEpisode}-${range.endEpisode}集`)
    .join(language === "en" ? "; " : "；");
  const contractTemplate = plan.ranges
    .map((range) => language === "en"
      ? `## Arc ${range.volume}: <title> (Episodes ${range.startEpisode}-${range.endEpisode})
Objective: <verifiable arc-end state>
KR1: <observable result>
KR2: <observable result>
KR3: <observable result>
Irreversible Event: <mandatory arc-end change>`
      : `## 第${range.volume}篇《篇章名》（第${range.startEpisode}-${range.endEpisode}集）
Objective: <可验证的篇章末状态>
KR1: <可观察结果>
KR2: <可观察结果>
KR3: <可观察结果>
Irreversible Event: <篇章尾必须发生的不可逆改变>`)
    .join("\n\n");
  const compactBeatTemplate = plan.compact
    ? Array.from({ length: plan.targetEpisodes }, (_, index) => language === "en"
      ? `Episode ${index + 1}: Goal=<active scene goal> | Obstacle=<concrete resistance> | Turn=<new decision or reversal> | Delivery=<observable result> | End Hook=<causal handoff or final aftermath>`
      : `第${index + 1}集：目标=<本集主动行动> | 阻碍=<具体阻力> | 转折=<新决定或反转> | 交付=<可观察结果> | 集末钩子=<因果接力或终局后效>`)
      .join("\n")
    : "";

  if (language === "en") {
    return `## 100-episode comic-drama scale contract (overrides generic volume advice)
- The requested ${plan.targetEpisodes} episodes are the TOTAL work length, not the number of arcs.
- Treat each volume as a story arc of about 10 episodes. The full plan must lock the final conflict and ending before episode writing begins.
- Every arc must advance the novelty premise, deliver familiar payoffs, intensify a high-pressure relationship, land causally prepared reversals, and carry an emotional hook into the next arc.
- Plan exactly ${plan.volumeCount} story arc(s): ${ranges}. All ranges must add up to exactly ${plan.targetEpisodes} episodes.
- The five content paragraphs required inside volume_map are five planning dimensions, NOT five volumes.
- Start volume_map with exactly these parseable execution blocks (replace angle-bracket placeholders, keep the Markdown headings and field labels exactly):
${contractTemplate}
- The assigned ranges are volume boundaries, not episode-by-episode tasks. Put the five prose planning dimensions after the execution blocks without creating extra volume headings.
- Complete each volume's three KRs inside its assigned episode range; place observable KR delivery points roughly every ${plan.episodesPerKr} episode(s), instead of applying a fixed mini-cycle.
- Episode ${plan.targetEpisodes} is the ending: it must complete the Book Objective and resolve the core conflict. Do not defer that work beyond the series.${plan.compact ? `
- This is a compact complete work. Volume 1 is the entire book, not the opening arc of a longer serialization. Volume 1's Objective must equal the complete Book Objective, and KR3 must deliver it. Phrases such as "first clue", "tip of the iceberg", "left for a sequel/later work", or "still not fully revealed" are contract violations.
- Compact works are the sole exception to the general ban on episode-level planning. Immediately after the volume execution block, emit this exact parseable beat contract with one distinct line per episode. Replace every placeholder and keep all five labels:
### Compact Episode Beat Contract
${compactBeatTemplate}
- Every turn must change the available choice or information, every delivery must be externally observable, and each End Hook must causally launch the next episode. The final episode's End Hook is aftermath/closure, not deferred core conflict.` : ""}`;
  }

  return `## 百集漫剧尺度合同（优先级高于通用分篇建议）
- 用户要求的${plan.targetEpisodes}集是全剧总长度，不是篇章数。
- 每卷按约 10 集的故事篇章处理；开始逐集写作前必须锁定最终冲突、终局选择和第${plan.targetEpisodes}集结局。
- 每个篇章必须推进新颖设定、兑现熟悉爽点、持续提高关系压力、完成有因果的反转，并把明确情绪钩子传递到下一篇章。
- 必须恰好规划${plan.volumeCount}个故事篇章：${ranges}。所有范围相加必须严格等于${plan.targetEpisodes}集。
- volume_map 要求的“5段主体”是五个规划维度，不是五卷，禁止据此生成五卷。
- volume_map 开头必须严格输出以下可解析执行合同（替换尖括号占位内容，Markdown 标题和字段名必须原样保留；不能只用加粗文本表示卷名）：
${contractTemplate}
- 上述范围只是卷边界，不是逐集任务。执行合同之后再写五个散文规划维度，不得创建额外卷标题。
- 每卷3个 KR 必须在该卷分配的剧集内全部完成，约每${plan.episodesPerKr}集出现一个可观察的 KR 交付点；不要机械套用“每个 KR 都花3-5集”。
- 第${plan.targetEpisodes}集就是全剧终局，必须完成全剧 Objective 并解决核心冲突，不得把终局推迟到后续篇章。${plan.compact ? `
- 这是紧凑完结作品，第1卷就是全书，不是更长连载的开篇卷。第1卷 Objective 必须等于完整的全书 Objective，KR3 必须交付它；“第一块线索”“冰山一角”“留待后续作品”“核心仍未完全揭示”等表述均属于合同违规。
- 紧凑完结作是“禁止逐集规划”的唯一例外。紧接卷执行合同，严格输出以下可解析节拍合同：每集恰好一行、替换全部占位符、保留五个字段名。
### 紧凑篇逐集节拍合同
${compactBeatTemplate}
- 每集转折必须改变选择或信息，交付必须可被外部观察；集末钩子必须因果启动下一集。终集钩子写后效/闭环，不得把核心冲突留到书外。` : ""}`;
}

/**
 * Premise-device contract check (borrowed from drama-skills
 * premise-devices.md): a premise device — rebirth, foresight, mind-reading,
 * a system, a golden finger — removes resistance, so the foundation must
 * record the device contract up front: capability range, failure conditions,
 * visible cost, and rule reliability. Returns a craft warning when device
 * signals are present but no boundary/cost wording is. Never blocks.
 */
export interface PremiseDeviceIssue {
  readonly zh: string;
  readonly en: string;
}

const PREMISE_DEVICE_PATTERN = /重生|重来一次|回到过去|穿越|预知未来|前世记忆|读心|金手指|外挂|系统流|系统面板|绑定系统|\brebirth\b|\breborn\b|reincarnat|second chance|foresight|precognition|mind[- ]reading|golden finger|cheat (?:ability|system)|system panel|bound (?:to )?a system/iu;
const DEVICE_BOUNDARY_PATTERN = /代价|成本|失效|限制|边界|约束|不能|无法|不得|有限|消耗|反噬|冷却|\bcost\b|\bprice\b|\blimit|restriction|cannot|can't|unable|only once|cooldown|backlash/iu;

export function checkPremiseDeviceContract(storyFrame: string): PremiseDeviceIssue | undefined {
  if (!storyFrame.trim()) return undefined;
  if (!PREMISE_DEVICE_PATTERN.test(storyFrame)) return undefined;
  if (DEVICE_BOUNDARY_PATTERN.test(storyFrame)) return undefined;
  return {
    zh: "前提装置提示：检测到重生/预知/系统/金手指类装置设定，但 story_frame 未记录装置契约（能力范围、失效条件、可见代价、规则可靠性）。装置取消阻力，必须先给边界与代价。这是工艺提示，不阻断建书。",
    en: "Premise-device note: a rebirth/foresight/system/golden-finger device is present, but story_frame records no device contract (capability range, failure conditions, visible cost, rule reliability). A device removes resistance, so its boundaries and costs must be set first. Craft note only — book creation is not blocked.",
  };
}

export function validateFoundationVolumeScale(  volumeMap: string,
  targetEpisodes: number,
  options: FoundationScaleOptions = {},
): ReadonlyArray<FoundationScaleIssue> {
  const plan = buildFoundationScalePlan(targetEpisodes, options);
  const declaredVolumes = extractDeclaredVolumeNumbers(volumeMap);
  const explicitTotals = extractExplicitVolumeTotals(volumeMap);
  const detectedVolumeCount = Math.max(0, ...declaredVolumes, ...explicitTotals);
  const issues: FoundationScaleIssue[] = [];

  if (detectedVolumeCount > plan.volumeCount) {
    issues.push({
      code: "volume-count-exceeds-plan",
      zh: `确定性尺度校验失败：目标${plan.targetEpisodes}集只能规划${plan.volumeCount}个故事篇章，但篇章计划声明或引用了${detectedVolumeCount}个篇章。`,
      en: `Deterministic scale check failed: ${plan.targetEpisodes} target episodes allow ${plan.volumeCount} volume(s), but the volume map declares or references ${detectedVolumeCount}.`,
    });
  }

  const maxReferencedEpisode = extractMaxEpisodeRangeEnd(volumeMap);
  if (maxReferencedEpisode > plan.targetEpisodes) {
    issues.push({
      code: "episode-range-exceeds-target",
      zh: `确定性尺度校验失败：篇章计划范围延伸到第${maxReferencedEpisode}集，超过全剧目标${plan.targetEpisodes}集。`,
      en: `Deterministic scale check failed: the volume map extends to episode ${maxReferencedEpisode}, beyond the ${plan.targetEpisodes}-episode target.`,
    });
  }

  const contracts = extractVolumeContracts(volumeMap);
  if (contracts.length !== plan.volumeCount) {
    issues.push({
      code: "volume-contract-count-mismatch",
      zh: `确定性尺度校验失败：篇章计划必须提供${plan.volumeCount}个可解析篇章合同（Markdown 篇章标题 + Objective/KR1-KR3/Irreversible Event），实际解析到${contracts.length}个。`,
      en: `Deterministic scale check failed: volume_map must provide ${plan.volumeCount} parseable volume contract(s) (Markdown volume heading + Objective/KR1-KR3/Irreversible Event), but ${contracts.length} were parsed.`,
    });
  }

  for (const expected of plan.ranges) {
    const contract = contracts.find((candidate) => candidate.volumeNumber === expected.volume);
    if (!contract) continue;
    if (contract.episodeStart !== expected.startEpisode || contract.episodeEnd !== expected.endEpisode) {
      issues.push({
        code: "volume-contract-range-mismatch",
        zh: `确定性尺度校验失败：第${expected.volume}篇合同必须覆盖第${expected.startEpisode}-${expected.endEpisode}集，实际解析范围为${renderParsedRange(contract.episodeStart, contract.episodeEnd, "zh")}。`,
        en: `Deterministic scale check failed: Volume ${expected.volume} must cover episodes ${expected.startEpisode}-${expected.endEpisode}, but its parsed range is ${renderParsedRange(contract.episodeStart, contract.episodeEnd, "en")}.`,
      });
    }
    if (contract.keyResults.length !== 3) {
      issues.push({
        code: "volume-contract-kr-count-mismatch",
        zh: `确定性尺度校验失败：第${expected.volume}篇合同必须包含恰好3个可解析 KR，实际解析到${contract.keyResults.length}个。`,
        en: `Deterministic scale check failed: Volume ${expected.volume} must contain exactly 3 parseable KRs, but ${contract.keyResults.length} were parsed.`,
      });
    }
  }

  if (plan.compact) {
    const beatSection = extractCompactBeatSection(volumeMap);
    const declaredBeatEpisodes = extractCompactBeatLineEpisodeNumbers(beatSection);
    const expectedBeatEpisodes = Array.from({ length: plan.targetEpisodes }, (_, index) => index + 1);
    if (
      declaredBeatEpisodes.length !== expectedBeatEpisodes.length
      || declaredBeatEpisodes.some((episode, index) => episode !== expectedBeatEpisodes[index])
    ) {
      issues.push({
        code: "compact-beat-count-mismatch",
        zh: `确定性节奏校验失败：紧凑完结漫剧必须按顺序提供第1-${plan.targetEpisodes}集的逐集节拍合同，实际识别为${declaredBeatEpisodes.length > 0 ? declaredBeatEpisodes.join("、") : "无"}。`,
        en: `Deterministic pacing check failed: the compact complete work must provide ordered episode beats 1-${plan.targetEpisodes}, but detected ${declaredBeatEpisodes.length > 0 ? declaredBeatEpisodes.join(", ") : "none"}.`,
      });
    } else {
      const completeBeats = extractCompleteCompactEpisodeBeats(beatSection);
      if (completeBeats.length !== plan.targetEpisodes) {
        issues.push({
          code: "compact-beat-fields-missing",
          zh: "确定性节奏校验失败：每集节拍必须同时填写目标、阻碍、转折、交付和集末钩子，且不能保留占位符。",
          en: "Deterministic pacing check failed: every episode beat must fill Goal, Obstacle, Turn, Delivery, and End Hook without placeholders.",
        });
      }
    }

    const deferralSignals = extractCompactDeferralSignals(volumeMap);
    if (deferralSignals.length > 0) {
      issues.push({
        code: "compact-book-defers-resolution",
        zh: `确定性尺度校验失败：紧凑完结漫剧把核心解决推迟到了全剧之外：${deferralSignals.join("；")}。第${plan.targetEpisodes}集必须完成全剧 Objective。`,
        en: `Deterministic scale check failed: the compact complete work defers core resolution beyond the book: ${deferralSignals.join("; ")}. Episode ${plan.targetEpisodes} must complete the Book Objective.`,
      });
    }
  }

  return issues;
}

function extractCompactBeatSection(content: string): string {
  const lines = content.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => (
    /^#{2,6}\s*(?:(?:紧凑篇)?逐(?:章|集)节拍合同|(?:Compact\s+)?Episode Beat Contract)\b.*$/iu.test(line.trim())
  ));
  if (headingIndex < 0) return content;
  const start = headingIndex + 1;
  const section: string[] = [];
  for (const line of lines.slice(start)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s+/u.test(trimmed) && !/^(?:#{1,6}\s*)?(?:第\s*\d+\s*(?:章|集)|Episode\s+\d+)\s*[：:]/iu.test(trimmed)) break;
    section.push(line);
  }
  return section.join("\n");
}

function extractCompactBeatLineEpisodeNumbers(section: string): number[] {
  const values: number[] = [];
  for (const rawLine of section.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = line.match(/^(?:#{1,6}\s*)?(?:[-*+•]\s*|\d+[.)、]\s*)?(?:第\s*(\d+)\s*(?:章|集)|Episode\s+(\d+))\s*[：:]/iu);
    const value = Number.parseInt(match?.[1] ?? match?.[2] ?? "", 10);
    const tableValue = parseCompactBeatTableRow(line)?.episode;
    const genericValue = hasCompleteCompactBeatFields(line)
      ? extractCompactBeatEpisodeNumber(line)
      : undefined;
    const resolved = Number.isInteger(value) && value > 0 ? value : (tableValue ?? genericValue);
    if (resolved !== undefined && resolved > 0 && !values.includes(resolved)) values.push(resolved);
  }
  return values;
}

function extractCompleteCompactEpisodeBeats(section: string): number[] {
  const complete: number[] = [];
  const value = "([^|｜<>\\r\\n]{2,})";
  const zhPattern = new RegExp(
    `^(?:#{1,6}\\s*)?(?:[-*+•]\\s*|\\d+[.)、]\\s*)?第\\s*(\\d+)\\s*(?:章|集)\\s*[：:]\\s*目标\\s*[:=：]\\s*${value}\\s*[|｜]\\s*阻碍\\s*[:=：]\\s*${value}\\s*[|｜]\\s*转折\\s*[:=：]\\s*${value}\\s*[|｜]\\s*交付\\s*[:=：]\\s*${value}\\s*[|｜]\\s*(?:章|集)末钩子\\s*[:=：]\\s*${value}\\s*$`,
    "iu",
  );
  const enPattern = new RegExp(
    `^(?:#{1,6}\\s*)?(?:[-*+•]\\s*|\\d+[.)、]\\s*)?Episode\\s+(\\d+)\\s*[：:]\\s*Goal\\s*[:=：]\\s*${value}\\s*[|｜]\\s*Obstacle\\s*[:=：]\\s*${value}\\s*[|｜]\\s*Turn\\s*[:=：]\\s*${value}\\s*[|｜]\\s*Delivery\\s*[:=：]\\s*${value}\\s*[|｜]\\s*End Hook\\s*[:=：]\\s*${value}\\s*$`,
    "iu",
  );
  for (const rawLine of section.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = line.match(zhPattern) ?? line.match(enPattern);
    const tableBeat = parseCompactBeatTableRow(line);
    const episode = Number.parseInt(match?.[1] ?? "", 10);
    const genericEpisode = extractCompactBeatEpisodeNumber(line);
    if (tableBeat && !complete.includes(tableBeat.episode)) complete.push(tableBeat.episode);
    if (Number.isInteger(episode) && episode > 0 && !complete.includes(episode)) complete.push(episode);
    if (genericEpisode !== undefined && hasCompleteCompactBeatFields(line) && !complete.includes(genericEpisode)) {
      complete.push(genericEpisode);
    }
  }
  return complete;
}

function extractCompactBeatEpisodeNumber(line: string): number | undefined {
  const match = line.match(/(?:第\s*(\d+)\s*(?:章|集)|Episode\s*(\d+)|EP(?:ISODE)?[-_\s]*(\d+))/iu);
  const value = Number.parseInt(match?.[1] ?? match?.[2] ?? match?.[3] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function hasCompleteCompactBeatFields(line: string): boolean {
  const labels = [
    /目标|Goal/iu,
    /阻碍|Obstacle/iu,
    /转折|Turn/iu,
    /交付|Delivery/iu,
    /(?:章|集)末钩子|End\s*Hook/iu,
  ];
  return labels.every((label) => label.test(line)) && !/<[^>]+>/.test(line);
}

function parseCompactBeatTableRow(line: string): { episode: number } | undefined {
  if (!line.includes("|")) return undefined;
  const cells = line.split("|").map((cell) => cell.trim()).filter((cell, index, all) => !(index === 0 && cell === "") && !(index === all.length - 1 && cell === ""));
  if (cells.length < 6 || /^[-: ]+$/u.test(cells[0] ?? "")) return undefined;
  const episodeMatch = (cells[0] ?? "").match(/^(?:第\s*)?(\d+)\s*(?:集|章)?$/iu);
  if (!episodeMatch?.[1]) return undefined;
  const fields = cells.slice(1, 6);
  if (fields.some((field) => !field || /^[-—–:：]+$/u.test(field) || /<[^>]+>/u.test(field))) return undefined;
  return { episode: Number.parseInt(episodeMatch[1], 10) };
}

export function normalizeFoundationVolumeContracts(
  volumeMap: string,
  targetEpisodes: number,
  language: "zh" | "en",
  options: FoundationScaleOptions = {},
): string {
  const plan = buildFoundationScalePlan(targetEpisodes, options);
  // A single-volume book still needs an executable volume contract even when
  // it is longer than the compact episode-beat range. Models often place the
  // required fields in prose sections instead of a standalone volume heading.
  if (plan.volumeCount !== 1 || extractVolumeContracts(volumeMap).length > 0) return volumeMap;

  const plain = volumeMap.replace(/\*\*/g, "");
  const objective = extractLooseContractField(plain, [
    "Objective",
    "篇章 Objective",
    "本篇 Objective",
    "卷级 Objective",
    "本卷 Objective",
    "本篇目标",
    "篇章目标",
    "本卷目标",
    "卷级目标",
    "目标",
  ]);
  const keyResults = [1, 2, 3].map((index) => (
    extractLooseKeyResult(plain, index)
  ));
  const irreversibleEvent = extractLooseContractField(plain, [
    "Irreversible Event",
    "篇章尾不可逆事件",
    "篇章尾不可逆改变",
    "本篇不可逆事件",
    "本篇不可逆改变",
    "卷尾不可逆事件",
    "不可逆事件",
    "不可逆改变",
    "卷尾改变",
  ])
    ?? extractCompactIrreversibleEvent(plain, language);
  if (!objective || keyResults.some((value) => !value) || !irreversibleEvent) return volumeMap;

  const title = extractCompactVolumeTitle(plain, language);
  const range = plan.ranges[0]!;
  const contract = [
    language === "en"
      ? `## Volume 1: ${title} (Episodes ${range.startEpisode}-${range.endEpisode})`
      : `## 第1篇《${title}》（第${range.startEpisode}-${range.endEpisode}集）`,
    `Objective: ${objective}`,
    ...keyResults.map((value, index) => `KR${index + 1}: ${value}`),
    `Irreversible Event: ${irreversibleEvent}`,
  ].join("\n");
  return `${contract}\n\n---\n\n${volumeMap.trim()}`;
}

function extractLooseContractField(
  content: string,
  labels: ReadonlyArray<string>,
): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/u, "");
    for (const label of labels) {
      if (line.slice(0, label.length).toLowerCase() !== label.toLowerCase()) continue;
      const source = line.slice(label.length);
      const remainder = source
        .replace(/^\s*[（(][^）)\r\n]*[）)]/u, "")
        .replace(/^\s*[：:]\s*/u, "");
      if (remainder === source) continue;
      const value = cleanLooseContractValue(remainder);
      if (value) return value;
    }
  }
  return undefined;
}

function extractLooseKeyResult(content: string, index: number): string | undefined {
  const label = [
    `KR\\s*${index}`,
    `关键(?:结果|成果)\\s*${index}`,
    `关键(?:结果|成果)\\s*[（(]\\s*${index}\\s*[）)]`,
  ].join("|");
  const pattern = new RegExp(`^(?:${label})(?:\\s*[（(][^）)\\r\\n]*[）)])?\\s*[：:]\\s*(.+)$`, "iu");

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^\s*(?:[-*]|\d+[.)、])\s*/u, "");
    const match = line.match(pattern);
    if (!match?.[1]) continue;
    const value = cleanLooseContractValue(match[1]);
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
    /(?:后续|下一部|续作|续篇)(?:作品|卷|章节|故事)?[^。！？\r\n]{0,40}(?:揭(?:示|秘|晓)|回收|解释|解决|完成|实作|展开)/gu,
    /(?:仍然|仍|尚|还)(?:没有|未)[^。！？\r\n]{0,28}(?:揭示|解释|回收|解决|完成|播放)/gu,
    /(?:冰山一角|第一(?:个|块|步|阶段)[^。！？\r\n]{0,24}(?:线索|碎片|推进|突破))/gu,
    /(?:left|saved|reserved|deferred)\s+for\s+(?:a\s+)?(?:sequel|later|future|the\s+next)[^.!?\r\n]{0,40}/giu,
    /(?:tip of the iceberg|first (?:clue|fragment|step|breakthrough)|still not (?:fully )?(?:revealed|resolved|explained|completed))/giu,
  ];
  const signals: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const signal = match[0].trim();
      const start = match.index ?? 0;
      const preceding = content.slice(Math.max(0, start - 24), start);
      if (/不(?:得|会|应|要)?\s*$/u.test(preceding) || /(?:无需|不能算作|不是).*$/u.test(preceding)) continue;
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
  return language === "zh" ? `第${start}-${end}集` : `episodes ${start}-${end}`;
}

function extractDeclaredVolumeNumbers(content: string): number[] {
  const values: number[] = [];
  for (const match of content.matchAll(/第\s*([零〇一二三四五六七八九十百两\d]+)\s*(?:卷|篇)/gu)) {
    const value = parseChineseInteger(match[1] ?? "");
    if (value > 0) values.push(value);
  }
  for (const match of content.matchAll(/\b(?:Volume|Arc)\s+(\d+)\b/giu)) {
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

function extractMaxEpisodeRangeEnd(content: string): number {
  const ends: number[] = [];
  for (const match of content.matchAll(/(?:第\s*)?(\d+)\s*(?:-|–|—|~|至|到)\s*(\d+)\s*(?:章|集)/gu)) {
    ends.push(Number.parseInt(match[2] ?? "0", 10));
  }
  for (const match of content.matchAll(/(?:episodes?|episodes?)\s+(\d+)\s*(?:-|–|—|~|to)\s*(\d+)/giu)) {
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
