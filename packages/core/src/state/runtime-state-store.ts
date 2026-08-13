import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EpisodeSummariesStateSchema,
  CurrentStateStateSchema,
  HooksStateSchema,
  StateManifestSchema,
  type EpisodeRuntimeStateDelta,
} from "../models/runtime-state.js";
import type { Fact, StoredHook, StoredSummary } from "./memory-db.js";
import {
  bootstrapStructuredStateFromMarkdown,
  normalizeHookId,
  parseCurrentStateFacts,
} from "./state-bootstrap.js";
import { renderEpisodeSummariesProjection, renderCurrentStateProjection, renderHooksProjection } from "./state-projections.js";
import { applyEpisodeRuntimeStateDelta, type EpisodeRuntimeStateSnapshot } from "./episode-state-reducer.js";
import { validateRuntimeState } from "./state-validator.js";
import { arbitrateEpisodeRuntimeStateDeltaHooks } from "../utils/hook-arbiter.js";
import { atomicWriteJson } from "../utils/atomic-write.js";

export interface RuntimeStateArtifacts {
  readonly snapshot: EpisodeRuntimeStateSnapshot;
  readonly resolvedDelta: EpisodeRuntimeStateDelta;
  readonly currentStateMarkdown: string;
  readonly hooksMarkdown: string;
  readonly episodeSummariesMarkdown: string;
}

export interface NarrativeMemorySeed {
  readonly summaries: ReadonlyArray<StoredSummary>;
  readonly hooks: ReadonlyArray<StoredHook>;
}

export async function loadEpisodeRuntimeStateSnapshot(bookDir: string): Promise<EpisodeRuntimeStateSnapshot> {
  const stateDir = join(bookDir, "story", "state");

  const loadSnapshot = async (): Promise<EpisodeRuntimeStateSnapshot> => {
    const [manifest, currentState, hooks, episodeSummaries] = await Promise.all([
      readJson(join(stateDir, "manifest.json"), StateManifestSchema),
      readJson(join(stateDir, "current_state.json"), CurrentStateStateSchema),
      readJson(join(stateDir, "hooks.json"), HooksStateSchema),
      readJson(join(stateDir, "episode_summaries.json"), EpisodeSummariesStateSchema),
    ]);
    return { manifest, currentState, hooks, episodeSummaries };
  };

  try {
    const existing = await loadSnapshot();
    const normalizedHookIds = existing.hooks.hooks.map((hook) => normalizeHookId(hook.hookId));
    const hookIdsAreCanonical = normalizedHookIds.every(
      (hookId, index) => hookId === existing.hooks.hooks[index]?.hookId,
    );
    const hookIdsAreUnique = new Set(normalizedHookIds).size === normalizedHookIds.length;
    if (
      validateRuntimeState(existing).length === 0
      && hookIdsAreCanonical
      && hookIdsAreUnique
    ) {
      return existing;
    }
  } catch {
    // Missing or invalid structured state is rebuilt from durable projections.
  }

  await bootstrapStructuredStateFromMarkdown({ bookDir });

  const snapshot = await loadSnapshot();

  const issues = validateRuntimeState(snapshot);
  if (issues.length > 0) {
    const summary = issues
      .map((issue) => `${issue.code}${issue.path ? `@${issue.path}` : ""}`)
      .join(", ");
    throw new Error(
      `Invalid persisted runtime state: ${summary}. Repair hint: run \`inkos write sync <book> <episode> [--brief "<guidance>"]\` to rebuild truth files from the episode body, or \`inkos write repair-state <book> <episode>\` for a state-degraded episode.`,
    );
  }

  return snapshot;
}

export async function buildRuntimeStateArtifacts(params: {
  readonly bookDir: string;
  readonly delta: EpisodeRuntimeStateDelta;
  readonly language: "zh" | "en";
  readonly allowReapply?: boolean;
}): Promise<RuntimeStateArtifacts> {
  const snapshot = await loadEpisodeRuntimeStateSnapshot(params.bookDir);
  const { resolvedDelta } = arbitrateEpisodeRuntimeStateDeltaHooks({
    hooks: snapshot.hooks.hooks,
    delta: params.delta,
  });
  const next = applyEpisodeRuntimeStateDelta({
    snapshot,
    delta: resolvedDelta,
    allowReapply: params.allowReapply,
  });

  return {
    snapshot: next,
    resolvedDelta,
    currentStateMarkdown: renderCurrentStateProjection(next.currentState, params.language),
    // Pass the episode number so the projection can tag stale / blocked hooks.
    hooksMarkdown: renderHooksProjection(next.hooks, params.language, {
      currentEpisode: resolvedDelta.episode,
    }),
    episodeSummariesMarkdown: renderEpisodeSummariesProjection(next.episodeSummaries, params.language),
  };
}

export async function saveEpisodeRuntimeStateSnapshot(
  bookDir: string,
  snapshot: EpisodeRuntimeStateSnapshot,
): Promise<void> {
  const stateDir = join(bookDir, "story", "state");
  await mkdir(stateDir, { recursive: true });

  await Promise.all([
    atomicWriteJson(join(stateDir, "manifest.json"), snapshot.manifest),
    atomicWriteJson(join(stateDir, "current_state.json"), snapshot.currentState),
    atomicWriteJson(join(stateDir, "hooks.json"), snapshot.hooks),
    atomicWriteJson(join(stateDir, "episode_summaries.json"), snapshot.episodeSummaries),
  ]);
}

export async function loadNarrativeMemorySeed(bookDir: string): Promise<NarrativeMemorySeed> {
  const snapshot = await loadEpisodeRuntimeStateSnapshot(bookDir);

  return {
    summaries: snapshot.episodeSummaries.rows.map((row) => ({
      episode: row.episodeNumber,
      title: row.title,
      characters: row.characters,
      events: row.events,
      stateChanges: row.stateChanges,
      hookActivity: row.hookActivity,
      mood: row.mood,
      episodeType: row.episodeType,
    })),
      hooks: snapshot.hooks.hooks.map((hook) => ({
        hookId: hook.hookId,
        startEpisode: hook.startEpisode,
        type: hook.type,
        status: hook.status,
        lastAdvancedEpisode: hook.lastAdvancedEpisode,
        expectedPayoff: hook.expectedPayoff,
        payoffTiming: hook.payoffTiming,
        notes: hook.notes,
        targetPayoffEpisode: hook.targetPayoffEpisode,
        seedEvidence: hook.seedEvidence,
        advanceEvidence: hook.advanceEvidence,
        payoffEvidence: hook.payoffEvidence,
        lastVerifiedEvidenceEpisode: hook.lastVerifiedEvidenceEpisode,
      })),
  };
}

export async function loadSnapshotCurrentStateFacts(
  bookDir: string,
  episodeNumber: number,
): Promise<ReadonlyArray<Fact>> {
  const snapshotDir = join(bookDir, "story", "snapshots", String(episodeNumber));
  const structuredState = await readJsonOrNull(
    join(snapshotDir, "state", "current_state.json"),
    CurrentStateStateSchema,
  );
  if (structuredState) {
    return structuredState.facts;
  }

  const markdown = await readFile(join(snapshotDir, "current_state.md"), "utf-8").catch(() => "");
  return parseCurrentStateFacts(markdown, episodeNumber);
}

async function readJson<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return schema.parse(JSON.parse(raw));
}

async function readJsonOrNull<T>(
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | null> {
  try {
    return await readJson(path, schema);
  } catch {
    return null;
  }
}
