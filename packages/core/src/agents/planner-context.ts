import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseMarkdownTableRows } from "../utils/story-markdown.js";
import { readCharacterContext } from "../utils/outline-paths.js";
import { readBookRules as readStructuredBookRules } from "./rules-reader.js";
import type { StoredHook } from "../state/memory-db.js";

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Phase 5: prefer roles/ directory; fall back to legacy character_matrix.md.
 * storyDir is <bookDir>/story, so the caller indirectly points us at bookDir
 * via dirname().
 */
export async function readCharacterMatrix(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  return readCharacterContext(bookDir, "");
}

export async function readSubplotBoard(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "subplot_board.md"));
}

export async function readEmotionalArcs(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "emotional_arcs.md"));
}

export async function readPendingHooks(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "pending_hooks.md"));
}

export async function readBrief(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "brief.md"));
}

/**
 * Render the structured book rules (protagonist / prohibitions / genreLock /
 * behavioral constraints) as a compact markdown block for the planner prompt.
 *
 * Phase 5 cleanup #3: reads the YAML frontmatter via readStructuredBookRules
 * (which prefers story_frame.md and falls back to legacy book_rules.md).
 * Returns "" when no structured rules are defined — the planner template
 * provides its own placeholder for that case.
 */
export async function renderBookRulesMarkdown(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  const parsed = await readStructuredBookRules(bookDir);
  if (!parsed) return "";

  const { rules, body } = parsed;
  const lines: string[] = [];

  if (rules.protagonist) {
    const proto = rules.protagonist;
    const personality = proto.personalityLock.join("、");
    const constraints = proto.behavioralConstraints.join("、");
    lines.push(`- 主角 ${proto.name}${personality ? ` / 人设锁：${personality}` : ""}${constraints ? ` / 行为约束：${constraints}` : ""}`);
  }

  if (rules.prohibitions.length > 0) {
    lines.push("- 本书禁忌：");
    for (const p of rules.prohibitions) {
      lines.push(`  - ${p}`);
    }
  }

  if (rules.genreLock) {
    const forbidden = rules.genreLock.forbidden.join("、");
    lines.push(`- 题材锁：${rules.genreLock.primary}${forbidden ? ` / 禁止混入：${forbidden}` : ""}`);
  }

  const trimmedBody = body.trim();
  // The body holds narrative guidance prose (e.g. 叙事视角). Include it verbatim
  // so the planner sees the same text as before the cleanup.
  if (trimmedBody) {
    lines.push("", trimmedBody);
  }

  return lines.join("\n").trim();
}

/**
 * Grab the last N row(s) from chapter_summaries.md formatted as markdown
 * table. Returns original table slice (with header) so the planner gets
 * column meaning implicitly.
 */
export function formatRecentSummaries(
  chapterSummariesRaw: string,
  chapterNumber: number,
  limit: number,
): string {
  const rows = parseMarkdownTableRows(chapterSummariesRaw)
    .filter((row) => /^\d+$/.test(row[0] ?? ""))
    .filter((row) => parseInt(row[0]!, 10) < chapterNumber)
    .sort((a, b) => parseInt(a[0]!, 10) - parseInt(b[0]!, 10));

  const recent = rows.slice(-limit);
  if (recent.length === 0) {
    return "（暂无前章摘要）";
  }

  const header = "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = recent.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [header, divider, body].join("\n");
}

export interface CurrentArcSubplot {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly status: string;
  readonly lastTouchChapter?: number;
  readonly silenceChapters?: number;
  readonly pressure: string;
  readonly raw: string;
}

export interface CurrentArcEmotion {
  readonly character: string;
  readonly chapter: number;
  readonly state: string;
  readonly trigger: string;
  readonly intensity?: number;
  readonly direction: string;
  readonly raw: string;
}

export interface CurrentArcTrajectory {
  readonly character: string;
  readonly entries: ReadonlyArray<CurrentArcEmotion>;
}

export interface CurrentArcSnapshot {
  readonly activeSubplots: ReadonlyArray<CurrentArcSubplot>;
  readonly emotionalTrajectories: ReadonlyArray<CurrentArcTrajectory>;
  readonly pressureSummary: ReadonlyArray<string>;
  readonly nextPlanningFocus: ReadonlyArray<string>;
}

const CURRENT_ARC_SUBPLOT_LIMIT = 6;
const CURRENT_ARC_EMOTION_LIMIT = 6;

/**
 * Phase 8: build a structured current-arc snapshot from subplot_board.md and
 * emotional_arcs.md. The planner still receives compact prose, but the
 * selection now has explicit fields for active subplots, recent emotional
 * pressure, and next-chapter focus instead of dumping raw recent rows.
 */
export function buildCurrentArcSnapshot(
  subplotBoardRaw: string,
  emotionalArcsRaw: string,
  chapterNumber: number,
): CurrentArcSnapshot {
  const activeSubplots = extractActiveSubplots(subplotBoardRaw, chapterNumber)
    .slice(0, CURRENT_ARC_SUBPLOT_LIMIT);
  const recentEmotions = extractRecentEmotionalArcEntries(
    emotionalArcsRaw,
    chapterNumber,
    CURRENT_ARC_EMOTION_LIMIT,
  );

  return {
    activeSubplots,
    emotionalTrajectories: groupEmotionsByCharacter(recentEmotions),
    pressureSummary: summarizeCurrentArcPressure(activeSubplots, recentEmotions),
    nextPlanningFocus: deriveNextPlanningFocus(activeSubplots, recentEmotions),
  };
}

export function composeCurrentArcProse(
  subplotBoardRaw: string,
  emotionalArcsRaw: string,
  chapterNumber: number,
): string {
  const snapshot = buildCurrentArcSnapshot(subplotBoardRaw, emotionalArcsRaw, chapterNumber);
  if (snapshot.activeSubplots.length === 0 && snapshot.emotionalTrajectories.length === 0) {
    return "（暂无 arc 数据——可能是新书起始阶段）";
  }

  const parts: string[] = [];
  if (snapshot.pressureSummary.length > 0) {
    parts.push("当前叙事压力：\n" + snapshot.pressureSummary.map((line) => `- ${line}`).join("\n"));
  }
  if (snapshot.activeSubplots.length > 0) {
    parts.push("活跃支线：\n" + snapshot.activeSubplots.map(renderCurrentArcSubplot).join("\n"));
  }
  if (snapshot.emotionalTrajectories.length > 0) {
    parts.push("近期情感线：\n" + snapshot.emotionalTrajectories.map(renderCurrentArcTrajectory).join("\n"));
  }
  if (snapshot.nextPlanningFocus.length > 0) {
    parts.push("下一章规划焦点：\n" + snapshot.nextPlanningFocus.map((line) => `- ${line}`).join("\n"));
  }
  return parts.join("\n\n");
}

function extractActiveSubplots(raw: string, chapterNumber: number): CurrentArcSubplot[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => line.replace(/^-\s*/, ""))
      .filter(Boolean)
      .map((line) => ({
        id: inferInlineId(line) ?? "subplot",
        name: line,
        owner: "",
        status: "active",
        pressure: "",
        raw: line,
      }));
  }
  return rows
    .filter((row) => !isSubplotHeaderRow(row))
    .filter((row) => {
      const status = subplotStatusCell(row);
      const dormant = row.some((cell) => /暂稳待续|暂挂|dormant|paused/i.test(cell));
      return isActiveStatus(status) && !dormant;
    })
    .map((row) => parseActiveSubplotRow(row, chapterNumber))
    .filter((subplot) => subplot.id.length > 0 || subplot.name.length > 0);
}

// subplot_board.md column layout (writer-prompts.ts):
// 支线ID | 支线名 | 相关角色 | 起始章 | 最近活跃章 | 距今章数 | 状态 | 进度概述 | 回收ETA
// The status column is index 6. Prefer it so an activity keyword that only
// appears in the 进度概述/压力 column can't flip a non-active subplot to active.
// Fall back to scanning the whole row only when the status column is empty
// (non-standard/legacy layouts) — matching parseActiveSubplotRow's fallback.
const ACTIVE_STATUS_RE = /进行|推进|高压|激活|activ|progress|partial/i;

function subplotStatusCell(row: ReadonlyArray<string>): string {
  const statusCol = (row[6] ?? "").trim();
  if (statusCol) return statusCol;
  return (row.find((cell) => ACTIVE_STATUS_RE.test(cell)) ?? "").trim();
}

function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUS_RE.test(status);
}

function extractRecentEmotionalArcEntries(raw: string, chapterNumber: number, limit: number): CurrentArcEmotion[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .slice(-limit)
      .map((line) => line.replace(/^-\s*/, ""))
      .filter(Boolean)
      .map((line) => ({
        character: inferInlineId(line) ?? "未标明角色",
        chapter: 0,
        state: line,
        trigger: "",
        direction: "",
        raw: line,
      }));
  }
  // emotional_arcs.md column layout: 角色 | 章节 | 情绪状态 | 触发事件 | 强度 | 弧线方向
  // Chapter number lives in column index 1 (row[1]), not column 0.
  return rows
    .filter((row) => !isEmotionalArcHeaderRow(row))
    .map(parseEmotionalArcRow)
    .filter((entry) => entry.chapter > 0 && entry.chapter < chapterNumber)
    .sort((a, b) => a.chapter - b.chapter)
    .slice(-limit)
    .map((entry) => entry);
}

function parseActiveSubplotRow(row: ReadonlyArray<string>, chapterNumber: number): CurrentArcSubplot {
  const lastTouchChapter = parseChapterCell(row[4]) ?? latestChapterRef(row);
  const explicitSilence = parsePlainInteger(row[5]);
  const silenceChapters = explicitSilence ?? (
    lastTouchChapter === undefined ? undefined : Math.max(0, chapterNumber - lastTouchChapter)
  );
  const status = subplotStatusCell(row);
  const pressure = row.slice(7).filter(Boolean).join("；");

  return {
    id: (row[0] ?? "").trim(),
    name: (row[1] ?? "").trim(),
    owner: (row[2] ?? "").trim(),
    status,
    lastTouchChapter,
    silenceChapters,
    pressure,
    raw: row.filter(Boolean).join(" | "),
  };
}

function parseEmotionalArcRow(row: ReadonlyArray<string>): CurrentArcEmotion {
  const chapter = parsePlainInteger(row[1]) ?? 0;
  return {
    character: (row[0] ?? "未标明角色").trim() || "未标明角色",
    chapter,
    state: (row[2] ?? "").trim(),
    trigger: (row[3] ?? "").trim(),
    intensity: parsePlainInteger(row[4]),
    direction: (row[5] ?? "").trim(),
    raw: row.filter(Boolean).join(" | "),
  };
}

function groupEmotionsByCharacter(entries: ReadonlyArray<CurrentArcEmotion>): CurrentArcTrajectory[] {
  const grouped = new Map<string, CurrentArcEmotion[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.character) ?? [];
    bucket.push(entry);
    grouped.set(entry.character, bucket);
  }
  return Array.from(grouped.entries()).map(([character, characterEntries]) => ({
    character,
    entries: characterEntries,
  }));
}

function summarizeCurrentArcPressure(
  activeSubplots: ReadonlyArray<CurrentArcSubplot>,
  recentEmotions: ReadonlyArray<CurrentArcEmotion>,
): string[] {
  const lines: string[] = [];
  if (activeSubplots.length > 0) {
    const labels = activeSubplots.map(formatSubplotLabel).join("、");
    lines.push(`支线压力集中在 ${labels}，本章应选择其中 1 条做可见推进或明确暂压理由`);
  }

  const highestEmotion = [...recentEmotions]
    .filter((entry) => entry.intensity !== undefined)
    .sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0) || b.chapter - a.chapter)[0];
  if (highestEmotion) {
    const chapterLabel = highestEmotion.chapter > 0 ? `ch${highestEmotion.chapter} ` : "";
    lines.push(
      `情绪压力最高点：${highestEmotion.character} ${chapterLabel}${highestEmotion.state}`
        + `${highestEmotion.intensity !== undefined ? `（强度 ${highestEmotion.intensity}）` : ""}`,
    );
  } else if (recentEmotions.length > 0) {
    const latest = recentEmotions[recentEmotions.length - 1]!;
    const chapterLabel = latest.chapter > 0 ? `ch${latest.chapter} ` : "";
    lines.push(`最近情绪落点：${latest.character} ${chapterLabel}${latest.state}`);
  }

  return lines.slice(0, 3);
}

function deriveNextPlanningFocus(
  activeSubplots: ReadonlyArray<CurrentArcSubplot>,
  recentEmotions: ReadonlyArray<CurrentArcEmotion>,
): string[] {
  const focus: string[] = [];
  const staleSubplot = activeSubplots
    .filter((subplot) => (subplot.silenceChapters ?? 0) >= 3)
    .sort((a, b) => (b.silenceChapters ?? 0) - (a.silenceChapters ?? 0))[0];
  if (staleSubplot) {
    focus.push(
      `优先处理 ${formatSubplotLabel(staleSubplot)}，它已沉默 ${staleSubplot.silenceChapters} 章，避免活跃支线悬置`,
    );
  } else if (activeSubplots.length > 0) {
    focus.push(`从 ${formatSubplotLabel(activeSubplots[0]!)} 切入，给活跃支线一个动作、证据或关系变化`);
  }

  const chargedEmotion = [...recentEmotions]
    .filter((entry) => (entry.intensity ?? 0) >= 8 || /升|顶点|爆发|crisis|peak|escalat/i.test(entry.direction))
    .sort((a, b) => b.chapter - a.chapter || (b.intensity ?? 0) - (a.intensity ?? 0))[0];
  if (chargedEmotion) {
    focus.push(
      `承接 ${chargedEmotion.character} ${chargedEmotion.state}`
        + `${chargedEmotion.trigger ? `（${chargedEmotion.trigger}）` : ""}，让情绪变化落成选择或后果`,
    );
  } else if (recentEmotions.length > 0) {
    focus.push("把近期情绪变化转成场面里的判断、误解或关系位移，不只复述状态");
  }

  return focus.slice(0, 4);
}

function renderCurrentArcSubplot(subplot: CurrentArcSubplot): string {
  const meta: string[] = [];
  if (subplot.status) meta.push(`状态=${subplot.status}`);
  if (subplot.lastTouchChapter !== undefined) meta.push(`最近触达=ch${subplot.lastTouchChapter}`);
  if (subplot.silenceChapters !== undefined) meta.push(`沉默=${subplot.silenceChapters}章`);
  if (subplot.pressure) meta.push(subplot.pressure);
  const label = formatSubplotLabel(subplot);
  return `- ${label}${meta.length > 0 ? `：${meta.join("；")}` : ""}`;
}

function renderCurrentArcTrajectory(trajectory: CurrentArcTrajectory): string {
  const entries = trajectory.entries.map((entry) => {
    const chapter = entry.chapter > 0 ? `ch${entry.chapter} ` : "";
    const details = [
      entry.trigger,
      entry.intensity !== undefined ? `强度${entry.intensity}` : "",
      entry.direction,
    ].filter(Boolean).join("，");
    return `${chapter}${entry.state}${details ? `（${details}）` : ""}`;
  });
  return `- ${trajectory.character}：${entries.join(" → ")}`;
}

function isSubplotHeaderRow(row: ReadonlyArray<string>): boolean {
  return row.some((cell) => /^(id|subplot_id|subplot|支线|状态|status|last_touch|最近触达)$/i.test(cell.trim()));
}

function isEmotionalArcHeaderRow(row: ReadonlyArray<string>): boolean {
  return row.some((cell) => /^(角色|character|章节|chapter|情绪状态|state|触发事件|trigger|强度|intensity|弧线方向|direction)$/i.test(cell.trim()));
}

function formatSubplotLabel(subplot: CurrentArcSubplot): string {
  if (subplot.id && subplot.name) return `${subplot.id}「${subplot.name}」`;
  return subplot.id || subplot.name || subplot.raw;
}

function parseChapterCell(value: string | undefined): number | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/(?:ch|第)?\s*(\d+)/i);
  if (!match) return undefined;
  return parseInt(match[1]!, 10);
}

function latestChapterRef(row: ReadonlyArray<string>): number | undefined {
  const refs = row
    .map(parseChapterCell)
    .filter((value): value is number => value !== undefined);
  if (refs.length === 0) return undefined;
  return Math.max(...refs);
}

function parsePlainInteger(value: string | undefined): number | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/\d+/);
  if (!match) return undefined;
  return parseInt(match[0]!, 10);
}

function inferInlineId(value: string): string | undefined {
  return value.match(/\b[A-Z]{1,4}\d{1,4}\b/)?.[0];
}

const CHARACTER_MATRIX_HEADER_CELLS = /^(角色|character|name|核心标签|与主角关系|relation)$/i;

function isLikelyHeaderRow(row: ReadonlyArray<string>): boolean {
  return row.some((cell) => CHARACTER_MATRIX_HEADER_CELLS.test(cell.trim()));
}

/**
 * Extract the protagonist row from character_matrix.md. Protagonist is detected
 * by a cell in the 与主角关系 column matching "主角本人" / "主角" / "protagonist"
 * (case-insensitive). Falls back to the first non-header data row if no
 * explicit match is found — that row is almost always the protagonist by
 * convention.
 */
export function extractProtagonistRow(characterMatrixRaw: string): string {
  const rows = parseMarkdownTableRows(characterMatrixRaw);
  const protagonist = rows.find((row) =>
    row.some((cell) => /^(主角本人|主角|protagonist)$/i.test(cell.trim())),
  );
  if (protagonist) {
    return `| ${protagonist.join(" | ")} |`;
  }
  const firstDataRow = rows.find((row) => !isLikelyHeaderRow(row));
  if (firstDataRow) {
    return `| ${firstDataRow.join(" | ")} |`;
  }
  return "（未找到主角行——请检查 character_matrix.md）";
}

const OPPONENT_PATTERNS = /敌对|对手|阻力|opponent|antagonist|foe/i;
const COLLABORATOR_PATTERNS = /协力|盟友|临时助力|ally|collaborator|mentor/i;

export function extractOpponentRows(characterMatrixRaw: string, limit: number): string {
  return extractRowsByRelation(characterMatrixRaw, OPPONENT_PATTERNS, limit, "（暂无明确对手登场）");
}

export function extractCollaboratorRows(characterMatrixRaw: string, limit: number): string {
  return extractRowsByRelation(characterMatrixRaw, COLLABORATOR_PATTERNS, limit, "（暂无明确协作者登场）");
}

function extractRowsByRelation(
  characterMatrixRaw: string,
  pattern: RegExp,
  limit: number,
  emptyText: string,
): string {
  const rows = parseMarkdownTableRows(characterMatrixRaw)
    .filter((row) => row.some((cell) => pattern.test(cell)))
    .filter((row) => !row.some((cell) => /^(主角|protagonist)$/i.test(cell.trim())))
    .slice(0, limit);
  if (rows.length === 0) {
    return emptyText;
  }
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

const RELEVANT_THREAD_STATUS_PATTERN = /activat|partial_payoff|推进|高压|open|progress/i;
const STALE_STATUS_PATTERN = /resolved|deferred|dormant|暂稳待续|暂挂|已回收/i;

export function extractRelevantThreads(pendingHooksRaw: string, subplotBoardRaw: string): string {
  const hookRows = parseMarkdownTableRows(pendingHooksRaw)
    .filter((row) => !/^(hook_id)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => RELEVANT_THREAD_STATUS_PATTERN.test(cell)))
    .filter((row) => !row.some((cell) => STALE_STATUS_PATTERN.test(cell)))
    .map((row) => `- ${row[0]}: ${row.slice(1).filter(Boolean).join(" | ")}`);

  const subplotRows = parseMarkdownTableRows(subplotBoardRaw)
    .filter((row) => !/^(id|subplot_id|subplot)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => RELEVANT_THREAD_STATUS_PATTERN.test(cell)))
    .filter((row) => !row.some((cell) => STALE_STATUS_PATTERN.test(cell)))
    .map((row) => `- ${row[0]}: ${row.slice(1).filter(Boolean).join(" | ")}`);

  const lines = [...hookRows, ...subplotRows];
  if (lines.length === 0) {
    return "（暂无活跃线索）";
  }
  return lines.join("\n");
}

/**
 * Phase 9-2: render stale hooks that the planner MUST dispose of in this
 * chapter's memo ("## 本章 hook 账"). These are already filtered by
 * computeRecyclableHooks; here we just format them for the prompt.
 *
 * Language switch mirrors the rest of the planner prompt: zh by default,
 * en for English books.
 */
export function formatRecyclableHooks(
  hooks: ReadonlyArray<StoredHook>,
  chapterNumber: number,
  language: "zh" | "en" = "zh",
): string {
  if (hooks.length === 0) {
    return language === "en"
      ? "(no stale hooks — the ledger is clean)"
      : "（暂无陈旧 hook——账本干净）";
  }

  const topSlice = hooks.slice(0, 6);
  const lines = topSlice.map((hook) => {
    const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
    const silence = lastTouch <= 0 ? chapterNumber : Math.max(0, chapterNumber - lastTouch);
    const payoff = hook.expectedPayoff?.trim() || hook.notes?.trim() || "";
    const core = hook.coreHook === true ? (language === "en" ? " [core]" : " [核心]") : "";
    return language === "en"
      ? `- ${hook.hookId} "${payoff}" — status=${hook.status}, silent ${silence} ch${core}`
      : `- ${hook.hookId} "${payoff}" — 状态=${hook.status}，已沉默 ${silence} 章${core}`;
  });

  const header = language === "en"
    ? "The planner MUST place each of these under advance / resolve / defer in the hook ledger (deferring requires an explicit reason):"
    : "规划时必须把以下每个 hook 放入 advance / resolve / defer（若 defer，必须写出理由）：";
  return [header, ...lines].join("\n");
}
