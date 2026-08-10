import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readCurrentStateWithFallback } from "./outline-paths.js";
import {
  EpisodeSummariesStateSchema,
  CurrentStateStateSchema,
  HooksStateSchema,
} from "../models/runtime-state.js";
import { MemoryDB, type Fact, type StoredHook, type StoredSummary } from "../state/memory-db.js";
import { bootstrapStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import {
  filterActiveHooks,
  isFuturePlannedHook,
  isHookWithinEpisodeWindow,
} from "./hook-lifecycle.js";
import {
  parseEpisodeSummariesMarkdown,
  parseCurrentStateFacts,
  parsePendingHooksMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
} from "./story-markdown.js";
export {
  isFuturePlannedHook,
  isHookWithinEpisodeWindow,
} from "./hook-lifecycle.js";
export {
  parseEpisodeSummariesMarkdown,
  parseCurrentStateFacts,
  parsePendingHooksMarkdown,
  renderHookSnapshot,
  renderSummarySnapshot,
} from "./story-markdown.js";

export interface MemorySelection {
  readonly summaries: ReadonlyArray<StoredSummary>;
  readonly hooks: ReadonlyArray<StoredHook>;
  readonly activeHooks: ReadonlyArray<StoredHook>;
  /**
   * Hooks with recycling pressure — stale hooks that the planner must
   * advance/resolve/defer (and if deferred, justify). Sorted by staleness DESC
   * (most overdue first). See computeRecyclableHooks for the selection rule.
   */
  readonly recyclableHooks: ReadonlyArray<StoredHook>;
  readonly facts: ReadonlyArray<Fact>;
  readonly volumeSummaries: ReadonlyArray<VolumeSummarySelection>;
  readonly dbPath?: string;
}

export interface VolumeSummarySelection {
  readonly heading: string;
  readonly content: string;
  readonly anchor: string;
}

export async function retrieveMemorySelection(params: {
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly goal: string;
  readonly outlineNode?: string;
  readonly mustKeep?: ReadonlyArray<string>;
}): Promise<MemorySelection> {
  const storyDir = join(params.bookDir, "story");
  const stateDir = join(storyDir, "state");
  const fallbackEpisode = Math.max(0, params.episodeNumber - 1);

  await bootstrapStructuredStateFromMarkdown({
    bookDir: params.bookDir,
    fallbackEpisode,
  }).catch(() => undefined);

  const [
    currentStateMarkdown,
    hooksMarkdown,
    volumeSummariesMarkdown,
    structuredCurrentState,
    structuredHooks,
    structuredSummaries,
  ] = await Promise.all([
    readCurrentStateWithFallback(params.bookDir),
    readFile(join(storyDir, "pending_hooks.md"), "utf-8").catch(() => ""),
    readFile(join(storyDir, "volume_summaries.md"), "utf-8").catch(() => ""),
    readStructuredState(join(stateDir, "current_state.json"), CurrentStateStateSchema),
    readStructuredState(join(stateDir, "hooks.json"), HooksStateSchema),
    readStructuredState(join(stateDir, "episode_summaries.json"), EpisodeSummariesStateSchema),
  ]);
  const facts = structuredCurrentState?.facts ?? parseCurrentStateFacts(
    currentStateMarkdown,
    fallbackEpisode,
  );
  const narrativeQueryTerms = extractQueryTerms(
    params.goal,
    params.outlineNode,
    [],
  );
  const factQueryTerms = extractQueryTerms(
    params.goal,
    params.outlineNode,
    params.mustKeep ?? [],
  );
  const volumeSummaries = selectRelevantVolumeSummaries(
    parseVolumeSummariesMarkdown(volumeSummariesMarkdown),
    narrativeQueryTerms,
  );
  // Hooks stay on the authority path instead of the SQLite acceleration path:
  // the DB table intentionally stores only a small subset and cannot preserve
  // promoted/core/dependency metadata, which is load-bearing for hook debt.
  const hooks = structuredHooks?.hooks ?? parsePendingHooksMarkdown(hooksMarkdown);
  const activeHooks = filterActiveHooks(hooks);

  const memoryDb = openMemoryDB(params.bookDir);
  if (memoryDb) {
    try {
      if (memoryDb.getEpisodeCount() === 0) {
        const summaries = toStoredSummaries(structuredSummaries?.rows ?? parseEpisodeSummariesMarkdown(
          await readFile(join(storyDir, "episode_summaries.md"), "utf-8").catch(() => ""),
        ));
        if (summaries.length > 0) {
          memoryDb.replaceSummaries(summaries);
        }
      }
      if (memoryDb.getCurrentFacts().length === 0 && facts.length > 0) {
        memoryDb.replaceCurrentFacts(facts);
      }

      // Structured/markdown hook state is authoritative because it preserves
      // metadata the SQLite acceleration table does not. In migration/minimal
      // projects that projection can be absent or empty while SQLite already
      // has usable hook rows, so fall back only when the authority path yields
      // no active hooks at all.
      const effectiveActiveHooks = activeHooks.length > 0
        ? activeHooks
        : filterActiveHooks(memoryDb.getActiveHooks());

      return {
        summaries: selectRelevantSummaries(
          memoryDb.getSummaries(1, Math.max(1, params.episodeNumber - 1)),
          params.episodeNumber,
          narrativeQueryTerms,
        ),
        hooks: selectRelevantHooks(effectiveActiveHooks, narrativeQueryTerms, params.episodeNumber),
        activeHooks: effectiveActiveHooks,
        recyclableHooks: computeRecyclableHooks(effectiveActiveHooks, params.episodeNumber),
        facts: selectRelevantFacts(memoryDb.getCurrentFacts(), factQueryTerms),
        volumeSummaries,
        dbPath: join(storyDir, "memory.db"),
      };
    } finally {
      memoryDb.close();
    }
  }

  const [summariesMarkdown] = await Promise.all([
    readFile(join(storyDir, "episode_summaries.md"), "utf-8").catch(() => ""),
  ]);
  const summaries = toStoredSummaries(structuredSummaries?.rows ?? parseEpisodeSummariesMarkdown(summariesMarkdown));

  return {
    summaries: selectRelevantSummaries(summaries, params.episodeNumber, narrativeQueryTerms),
    hooks: selectRelevantHooks(activeHooks, narrativeQueryTerms, params.episodeNumber),
    activeHooks,
    recyclableHooks: computeRecyclableHooks(activeHooks, params.episodeNumber),
    facts: selectRelevantFacts(facts, factQueryTerms),
    volumeSummaries,
  };
}

function toStoredSummaries(rows: ReadonlyArray<StoredSummary | {
  readonly episodeNumber: number;
  readonly title: string;
  readonly characters: string;
  readonly events: string;
  readonly stateChanges: string;
  readonly hookActivity: string;
  readonly mood: string;
  readonly episodeType: string;
}>): StoredSummary[] {
  return rows.map((row) => "episode" in row
    ? row
    : {
        episode: row.episodeNumber,
        title: row.title,
        characters: row.characters,
        events: row.events,
        stateChanges: row.stateChanges,
        hookActivity: row.hookActivity,
        mood: row.mood,
        episodeType: row.episodeType,
      });
}

/**
 * Phase 9-2: Hooks that the planner MUST address this episode.
 *
 * An active hook is "recyclable" (i.e., stale enough to force an
 * advance/resolve/defer decision) when any of the following holds:
 *
 *   - pressured / near_payoff / progressing: silent for ≥ 5 episodes
 *   - planted / open: silent for ≥ 10 episodes
 *   - coreHook === true:                      silent for ≥ 8 episodes
 *
 * "Silent" = (episodeNumber − max(startEpisode, lastAdvancedEpisode)).
 * Future-planted hooks are excluded (they aren't overdue yet).
 * Sorted by silence DESC — most overdue first — so the planner sees the
 * worst debt at the top of its prompt slice.
 */
export function computeRecyclableHooks(
  hooks: ReadonlyArray<StoredHook>,
  episodeNumber: number,
): StoredHook[] {
  return hooks
    .filter((hook) => !isRecycleTerminalStatus(hook.status))
    .filter((hook) => !isFuturePlannedHook(hook, episodeNumber))
    .map((hook) => ({ hook, silence: hookSilence(hook, episodeNumber) }))
    .filter(({ hook, silence }) => silence >= recycleThreshold(hook))
    .sort((a, b) => b.silence - a.silence || a.hook.startEpisode - b.hook.startEpisode)
    .map(({ hook }) => hook);
}

function isRecycleTerminalStatus(status: string): boolean {
  return /^(resolved|closed|done|已回收|已解决|deferred|paused|hold|延后|延期|搁置|暂缓)$/i.test(status.trim());
}

function hookSilence(hook: StoredHook, episodeNumber: number): number {
  const lastTouch = Math.max(hook.startEpisode, hook.lastAdvancedEpisode);
  if (lastTouch <= 0) return episodeNumber;
  return Math.max(0, episodeNumber - lastTouch);
}

function recycleThreshold(hook: StoredHook): number {
  const status = hook.status.trim().toLowerCase();
  if (/pressured|near[_\s-]?payoff|progressing|重大推进|持续推进/.test(status)) return 5;
  if (hook.coreHook === true) return 8;
  return 10;
}

export function extractQueryTerms(goal: string, outlineNode: string | undefined, mustKeep: ReadonlyArray<string>): string[] {
  const primaryTerms = uniqueTerms([
    ...extractTermsFromText(stripNegativeGuidance(goal)),
    ...mustKeep.flatMap((item) => extractTermsFromText(item)),
  ]);

  if (primaryTerms.length >= 2) {
    return primaryTerms.slice(0, 12);
  }

  return uniqueTerms([
    ...primaryTerms,
    ...extractTermsFromText(stripNegativeGuidance(outlineNode ?? "")),
  ]).slice(0, 12);
}

function openMemoryDB(bookDir: string): MemoryDB | null {
  try {
    return new MemoryDB(bookDir);
  } catch {
    return null;
  }
}

async function readStructuredState<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return schema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function buildLegacyQueryTerms(goal: string, outlineNode: string | undefined, mustKeep: ReadonlyArray<string>): string[] {
  const stopWords = new Set([
    "bring", "focus", "back", "episode", "clear", "narrative", "before", "opening",
    "track", "the", "with", "from", "that", "this", "into", "still", "cannot",
    "current", "state", "advance", "conflict", "story", "keep", "must", "local",
  ]);

  const source = [goal, outlineNode ?? "", ...mustKeep].join(" ");
  const english = source.match(/[a-z]{4,}/gi) ?? [];
  const chinese = source.match(/[\u4e00-\u9fff]{2,4}/g) ?? [];

  return [...new Set(
    [...english, ...chinese]
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .filter((term) => !stopWords.has(term.toLowerCase())),
  )].slice(0, 12);
}

function extractTermsFromText(text: string): string[] {
  if (!text.trim()) return [];

  const stopWords = new Set([
    "bring", "focus", "back", "episode", "clear", "narrative", "before", "opening",
    "track", "the", "with", "from", "that", "this", "into", "still", "cannot",
    "current", "state", "advance", "conflict", "story", "keep", "must", "local",
    "does", "not", "only", "just", "then", "than",
  ]);

  const normalized = text.replace(/第\d+章/g, " ");
  const english = (normalized.match(/[a-z]{4,}/gi) ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .filter((term) => !stopWords.has(term.toLowerCase()));

  const chineseSegments = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const chinese = chineseSegments.flatMap((segment) => extractChineseFocusTerms(segment));

  return [...english, ...chinese];
}

function extractChineseFocusTerms(segment: string): string[] {
  const stripped = segment
    .replace(/^(本章|继续|重新|拉回|回到|推进|优先|围绕|聚焦|坚持|保持|把注意力|注意力|将注意力|请把注意力|先把注意力)+/, "")
    .replace(/^(处理|推进|回拉|拉回到)+/, "")
    .trim();

  const target = stripped.length >= 2 ? stripped : segment;
  const terms = new Set<string>();

  if (target.length <= 4) {
    terms.add(target);
  }

  for (let size = 2; size <= 4; size += 1) {
    if (target.length >= size) {
      terms.add(target.slice(-size));
    }
  }

  return [...terms].filter((term) => term.length >= 2);
}

function stripNegativeGuidance(text: string): string {
  if (!text) return "";

  return text
    .replace(/\b(do not|don't|avoid|without|instead of)\b[\s\S]*$/i, " ")
    .replace(/(?:不要|不让|别|禁止|避免|但不允许)[\s\S]*$/u, " ")
    .trim();
}

function uniqueTerms(terms: ReadonlyArray<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(term.trim());
  }

  return result;
}

function parseVolumeSummariesMarkdown(markdown: string): VolumeSummarySelection[] {
  if (!markdown.trim()) return [];

  const sections = markdown
    .split(/^##\s+/m)
    .map((section) => section.trim())
    .filter(Boolean);

  return sections.map((section) => {
    const [headingLine, ...bodyLines] = section.split("\n");
    const heading = headingLine?.trim() ?? "";
    const content = bodyLines.join("\n").trim();

    return {
      heading,
      content,
      anchor: slugifyAnchor(heading),
    };
  }).filter((section) => section.heading.length > 0 && section.content.length > 0);
}

function isUnresolvedHook(status: string): boolean {
  return status.trim().length === 0 || /open|待定|推进|active|progressing/i.test(status);
}

function selectRelevantSummaries(
  summaries: ReadonlyArray<StoredSummary>,
  episodeNumber: number,
  queryTerms: ReadonlyArray<string>,
): StoredSummary[] {
  return summaries
    .filter((summary) => summary.episode < episodeNumber)
    .map((summary) => ({
      summary,
      score: scoreSummary(summary, episodeNumber, queryTerms),
      matched: matchesAny([
        summary.title,
        summary.characters,
        summary.events,
        summary.stateChanges,
        summary.hookActivity,
        summary.episodeType,
      ].join(" "), queryTerms),
    }))
    .filter((entry) => entry.matched || entry.summary.episode >= episodeNumber - 3)
    .sort((left, right) => right.score - left.score || right.summary.episode - left.summary.episode)
    .slice(0, 4)
    .map((entry) => entry.summary)
    .sort((left, right) => left.episode - right.episode);
}

function selectRelevantHooks(
  hooks: ReadonlyArray<StoredHook>,
  queryTerms: ReadonlyArray<string>,
  episodeNumber: number,
): StoredHook[] {
  const ranked = hooks
    .map((hook) => ({
      hook,
      score: scoreHook(hook, queryTerms, episodeNumber),
      matched: matchesAny(
        [hook.hookId, hook.type, hook.expectedPayoff, hook.payoffTiming ?? "", hook.notes].join(" "),
        queryTerms,
      ),
    }))
    .filter((entry: { hook: StoredHook; score: number; matched: boolean }) =>
      entry.matched || isUnresolvedHook(entry.hook.status),
    );

  const primary = ranked
    .filter((entry: { hook: StoredHook; score: number; matched: boolean }) =>
      entry.matched || isHookWithinEpisodeWindow(entry.hook, episodeNumber, 5),
    )
    .sort((left, right) => right.score - left.score || right.hook.lastAdvancedEpisode - left.hook.lastAdvancedEpisode)
    .slice(0, 6);

  const selectedIds = new Set(primary.map((entry: { hook: StoredHook; score: number; matched: boolean }) => entry.hook.hookId));
  const stale = ranked
    .filter((entry: { hook: StoredHook; score: number; matched: boolean }) =>
      !selectedIds.has(entry.hook.hookId)
      && !isFuturePlannedHook(entry.hook, episodeNumber)
      && isUnresolvedHook(entry.hook.status),
    )
    .sort((left, right) => left.hook.lastAdvancedEpisode - right.hook.lastAdvancedEpisode || right.score - left.score)
    .slice(0, 2);

  return [...primary, ...stale].map((entry: { hook: StoredHook; score: number; matched: boolean }) => entry.hook);
}

function selectRelevantFacts(
  facts: ReadonlyArray<Fact>,
  queryTerms: ReadonlyArray<string>,
): Fact[] {
  const prioritizedPredicates = [
    /^(当前冲突|current conflict)$/i,
    /^(当前目标|current goal)$/i,
    /^(主角状态|protagonist state)$/i,
    /^(当前限制|current constraint)$/i,
    /^(当前位置|current location)$/i,
    /^(当前敌我|current alliances|current relationships)$/i,
  ];

  return facts
    .map((fact) => {
      const text = [fact.subject, fact.predicate, fact.object].join(" ");
      const priority = prioritizedPredicates.findIndex((pattern) => pattern.test(fact.predicate));
      const baseScore = priority === -1 ? 5 : 20 - priority * 2;
      const termScore = queryTerms.reduce(
        (score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0),
        0,
      );

      return {
        fact,
        score: baseScore + termScore,
        matched: matchesAny(text, queryTerms),
      };
    })
    .filter((entry) => entry.matched || entry.score >= 14)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((entry) => entry.fact);
}

function selectRelevantVolumeSummaries(
  summaries: ReadonlyArray<VolumeSummarySelection>,
  queryTerms: ReadonlyArray<string>,
): VolumeSummarySelection[] {
  if (summaries.length === 0) return [];

  const ranked = summaries
    .map((summary, index) => {
      const text = `${summary.heading} ${summary.content}`;
      const termScore = queryTerms.reduce(
        (score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0),
        0,
      );

      return {
        index,
        summary,
        score: termScore + index,
        matched: matchesAny(text, queryTerms),
      };
    })
    .filter((entry, index, all) => entry.matched || index === all.length - 1)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.summary);

  return ranked;
}

function scoreSummary(summary: StoredSummary, episodeNumber: number, queryTerms: ReadonlyArray<string>): number {
  const text = [
    summary.title,
    summary.characters,
    summary.events,
    summary.stateChanges,
    summary.hookActivity,
    summary.episodeType,
  ].join(" ");
  const age = Math.max(0, episodeNumber - summary.episode);
  const recencyScore = Math.max(0, 12 - age);
  const termScore = queryTerms.reduce((score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0), 0);
  return recencyScore + termScore;
}

function scoreHook(
  hook: StoredHook,
  queryTerms: ReadonlyArray<string>,
  _episodeNumber: number,
): number {
  const text = [hook.hookId, hook.type, hook.expectedPayoff, hook.payoffTiming ?? "", hook.notes].join(" ");
  const freshness = Math.max(0, hook.lastAdvancedEpisode);
  const termScore = queryTerms.reduce((score, term) => score + (includesTerm(text, term) ? Math.max(8, term.length * 2) : 0), 0);
  return termScore + freshness;
}

function matchesAny(text: string, queryTerms: ReadonlyArray<string>): boolean {
  return queryTerms.some((term) => includesTerm(text, term));
}

function includesTerm(text: string, term: string): boolean {
  return text.toLowerCase().includes(term.toLowerCase());
}

function slugifyAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "volume-summary";
}
