/** Legacy persistence adapter. The reducer implementation is Episode-native;
 * this module converts the durable v2 field names at the boundary. */
import type {
  ChapterSummariesState,
  HookRecord,
  RuntimeStateDelta,
} from "../models/runtime-state.js";
import {
  applyEpisodeRuntimeStateDelta,
  type EpisodeRuntimeStateDelta,
  type EpisodeRuntimeStateSnapshot,
} from "./episode-state-reducer.js";

export type { EpisodeRuntimeStateSnapshot, EpisodeRuntimeStateDelta } from "./episode-state-reducer.js";

export interface RuntimeStateSnapshot {
  readonly manifest: {
    readonly schemaVersion: 2;
    readonly language: "zh" | "en";
    readonly lastAppliedChapter: number;
    readonly projectionVersion: number;
    readonly migrationWarnings: string[];
  };
  readonly currentState: {
    readonly chapter: number;
    readonly facts: Array<{
      readonly subject: string;
      readonly predicate: string;
      readonly object: string;
      readonly validFromChapter: number;
      readonly validUntilChapter: number | null;
      readonly sourceChapter: number;
    }>;
  };
  readonly hooks: { readonly hooks: HookRecord[] };
  readonly chapterSummaries: ChapterSummariesState;
}

export function applyRuntimeStateDelta(params: {
  readonly snapshot: RuntimeStateSnapshot;
  readonly delta: RuntimeStateDelta;
  readonly allowReapply?: boolean;
}): RuntimeStateSnapshot {
  const next = applyEpisodeRuntimeStateDelta({
    snapshot: toEpisodeSnapshot(params.snapshot),
    delta: toEpisodeDelta(params.delta),
    allowReapply: params.allowReapply,
  });
  return fromEpisodeSnapshot(next);
}

function toEpisodeSnapshot(snapshot: RuntimeStateSnapshot): EpisodeRuntimeStateSnapshot {
  return {
    manifest: {
      schemaVersion: 2,
      language: snapshot.manifest.language,
      lastAppliedEpisode: snapshot.manifest.lastAppliedChapter,
      projectionVersion: snapshot.manifest.projectionVersion,
      migrationWarnings: [...snapshot.manifest.migrationWarnings],
    },
    currentState: {
      episode: snapshot.currentState.chapter,
      facts: snapshot.currentState.facts.map((fact) => ({
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        validFromEpisode: fact.validFromChapter,
        validUntilEpisode: fact.validUntilChapter,
        sourceEpisode: fact.sourceChapter,
      })),
    },
    hooks: {
      hooks: snapshot.hooks.hooks.map(toEpisodeHook),
    },
    episodeSummaries: {
      rows: snapshot.chapterSummaries.rows.map((row) => ({
        ...row,
        episode: row.chapter,
        episodeType: row.chapterType,
      })),
    },
  };
}

function toEpisodeDelta(delta: RuntimeStateDelta): EpisodeRuntimeStateDelta {
  return {
    ...delta,
    episode: delta.chapter,
    hookOps: {
      upsert: delta.hookOps.upsert.map(toEpisodeHook),
      mention: [...delta.hookOps.mention],
      resolve: [...delta.hookOps.resolve],
      defer: [...delta.hookOps.defer],
    },
    episodeSummary: delta.chapterSummary
      ? { ...delta.chapterSummary, episode: delta.chapterSummary.chapter, episodeType: delta.chapterSummary.chapterType }
      : undefined,
  };
}

function fromEpisodeSnapshot(snapshot: EpisodeRuntimeStateSnapshot): RuntimeStateSnapshot {
  return {
    manifest: {
      schemaVersion: 2,
      language: snapshot.manifest.language,
      lastAppliedChapter: snapshot.manifest.lastAppliedEpisode,
      projectionVersion: snapshot.manifest.projectionVersion,
      migrationWarnings: [...snapshot.manifest.migrationWarnings],
    },
    currentState: {
      chapter: snapshot.currentState.episode,
      facts: snapshot.currentState.facts.map((fact) => ({
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        validFromChapter: fact.validFromEpisode,
        validUntilChapter: fact.validUntilEpisode,
        sourceChapter: fact.sourceEpisode,
      })),
    },
    hooks: {
      hooks: snapshot.hooks.hooks.map(fromEpisodeHook),
    },
    chapterSummaries: {
      rows: snapshot.episodeSummaries.rows.map((row) => ({
        ...row,
        chapter: row.episode,
        chapterType: row.episodeType,
      })),
    } satisfies ChapterSummariesState,
  };
}

function toEpisodeHook(hook: HookRecord): import("./episode-state-reducer.js").EpisodeHookRecord {
  return {
    hookId: hook.hookId,
    hookKind: hook.hookKind,
    startEpisode: hook.startChapter,
    type: hook.type,
    status: hook.status,
    lastAdvancedEpisode: hook.lastAdvancedChapter,
    expectedPayoff: hook.expectedPayoff,
    payoffTiming: hook.payoffTiming,
    notes: hook.notes,
    audienceQuestion: hook.audienceQuestion,
    seedEpisode: hook.seedEpisode,
    targetPayoffEpisode: hook.targetPayoffEpisode,
    pressureSource: hook.pressureSource,
    dependsOn: hook.dependsOn,
    paysOffInArc: hook.paysOffInArc,
    coreHook: hook.coreHook,
    halfLifeEpisodes: hook.halfLifeChapters,
    advancedCount: hook.advancedCount,
    promoted: hook.promoted,
  };
}

function fromEpisodeHook(
  hook: import("./episode-state-reducer.js").EpisodeHookRecord,
): HookRecord {
  return {
    hookId: hook.hookId,
    hookKind: hook.hookKind,
    startChapter: hook.startEpisode,
    type: hook.type,
    status: hook.status,
    lastAdvancedChapter: hook.lastAdvancedEpisode,
    expectedPayoff: hook.expectedPayoff,
    payoffTiming: hook.payoffTiming,
    notes: hook.notes,
    audienceQuestion: hook.audienceQuestion,
    seedEpisode: hook.seedEpisode,
    targetPayoffEpisode: hook.targetPayoffEpisode,
    pressureSource: hook.pressureSource,
    dependsOn: hook.dependsOn,
    paysOffInArc: hook.paysOffInArc,
    coreHook: hook.coreHook,
    halfLifeChapters: hook.halfLifeEpisodes,
    advancedCount: hook.advancedCount,
    promoted: hook.promoted,
  };
}
