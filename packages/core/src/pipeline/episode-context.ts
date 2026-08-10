import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { MemorySelection } from "../utils/memory-retrieval.js";
import {
  readCharacterContext,
  readCurrentStateWithFallback,
  readStoryFrame,
  readVolumeMap,
} from "../utils/outline-paths.js";

export interface EpisodeContextEntry {
  readonly source: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface EpisodeContextSnapshot {
  readonly episode: number;
  readonly schemaVersion: string;
  readonly model: string;
  readonly service: string;
  readonly ruleStackVersion: string;
  readonly entries: ReadonlyArray<EpisodeContextEntry>;
  /** Populated by Composer and shared by all later agents in the operation. */
  planningMemorySelection?: MemorySelection;
  contextPackage?: ContextPackage;
  ruleStack?: RuleStack;
  hash: string;
  readonly duplicateChars: number;
}

export function attachEpisodePlanningMemory(
  snapshot: EpisodeContextSnapshot,
  memorySelection: MemorySelection,
): EpisodeContextSnapshot {
  snapshot.planningMemorySelection = memorySelection;
  snapshot.hash = hash([snapshot.hash, JSON.stringify(memorySelection)].join("\u001f"));
  return snapshot;
}

export function attachEpisodeContextArtifacts(
  snapshot: EpisodeContextSnapshot,
  contextPackage: ContextPackage,
  ruleStack: RuleStack,
): EpisodeContextSnapshot {
  snapshot.contextPackage = contextPackage;
  snapshot.ruleStack = ruleStack;
  snapshot.hash = hash([
    snapshot.hash,
    JSON.stringify(contextPackage),
    JSON.stringify(ruleStack),
  ].join("\u001f"));
  return snapshot;
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function canonicalSource(source: string): string {
  const match = source.match(/^(?:runtime\/hook_debt|story\/pending_hooks\.md)#(.+)$/u);
  return match ? `hook:${match[1]}` : source;
}

export function getEpisodeContextContent(
  snapshot: EpisodeContextSnapshot,
  source: string,
  fallback = "",
): string {
  const canonical = canonicalSource(source);
  return snapshot.entries.find((entry) => entry.source === canonical)?.content ?? fallback;
}

export function getEpisodeContextRecentEpisodes(
  snapshot: EpisodeContextSnapshot,
): ReadonlyArray<string> {
  return snapshot.entries
    .filter((entry) => /^episodes\/recent\/\d+$/u.test(entry.source))
    .sort((left, right) => left.source.localeCompare(right.source))
    .map((entry) => entry.content);
}

export function buildEpisodeContextSnapshot(params: {
  readonly episode: number;
  readonly schemaVersion?: string;
  readonly model: string;
  readonly service: string;
  readonly ruleStackVersion?: string;
  readonly entries: ReadonlyArray<{ readonly source: string; readonly content: string }>;
}): EpisodeContextSnapshot {
  const bySource = new Map<string, EpisodeContextEntry>();
  let duplicateChars = 0;
  for (const entry of params.entries) {
    const content = entry.content.trim();
    if (!content) continue;
    const source = canonicalSource(entry.source);
    const contentHash = hash(content);
    if (bySource.has(source)) {
      duplicateChars += content.length;
      continue;
    }
    bySource.set(source, { source, content, contentHash });
  }
  const entries = [...bySource.values()];
  const identity = [
    params.schemaVersion ?? "inkos-episode-v2",
    params.episode,
    params.model,
    params.service,
    params.ruleStackVersion ?? "episode-rules-v1",
    ...entries.map((entry) => `${entry.source}:${entry.contentHash}`),
  ].join("\u001f");
  return {
    episode: params.episode,
    schemaVersion: params.schemaVersion ?? "inkos-episode-v2",
    model: params.model,
    service: params.service,
    ruleStackVersion: params.ruleStackVersion ?? "episode-rules-v1",
    entries,
    hash: hash(identity),
    duplicateChars,
  };
}

export async function loadEpisodeContextSnapshot(params: {
  readonly bookDir: string;
  readonly episode: number;
  readonly model: string;
  readonly service: string;
  readonly schemaVersion?: string;
  readonly ruleStackVersion?: string;
}): Promise<EpisodeContextSnapshot> {
  const storyDir = join(params.bookDir, "story");
  const placeholder = "(文件尚未创建)";
  const fileSources = [
    "author_intent.md",
    "current_focus.md",
    "brief.md",
    "book_rules.md",
    "style_guide.md",
    "style_profile.json",
    "particle_ledger.md",
    "pending_hooks.md",
    "episode_summaries.md",
    "subplot_board.md",
    "emotional_arcs.md",
    "parent_canon.md",
  ] as const;
  const [storyFrame, volumeMap, currentState, characterContext, fileEntries, recentEpisodes] = await Promise.all([
    readStoryFrame(params.bookDir, placeholder),
    readVolumeMap(params.bookDir, placeholder),
    readCurrentStateWithFallback(params.bookDir, placeholder),
    readCharacterContext(params.bookDir, placeholder),
    Promise.all(fileSources.map(async (source) => ({
      source: `story/${source}`,
      content: await readFile(join(storyDir, source), "utf8").catch(() => ""),
    }))),
    loadRecentEpisodeEntries(params.bookDir, params.episode),
  ]);
  const entries = [
    { source: "story/outline/story_frame.md", content: storyFrame },
    { source: "story/outline/volume_map.md", content: volumeMap },
    { source: "story/current_state.md", content: currentState },
    { source: "story/character_context.md", content: characterContext },
    ...fileEntries,
    ...recentEpisodes,
  ];
  return buildEpisodeContextSnapshot({ ...params, entries });
}

async function loadRecentEpisodeEntries(
  bookDir: string,
  episode: number,
): Promise<ReadonlyArray<{ readonly source: string; readonly content: string }>> {
  const episodesDir = join(bookDir, "episodes");
  const minimumEpisode = Math.max(1, episode - 5);
  const files = await readdir(episodesDir).catch(() => []);
  const selected = files
    .filter((file) => /\.md$/iu.test(file))
    .map((file) => ({ file, episode: Number.parseInt(file.slice(0, 4), 10) }))
    .filter((entry) => Number.isInteger(entry.episode)
      && entry.episode >= minimumEpisode
      && entry.episode < episode)
    .sort((left, right) => left.episode - right.episode);
  return Promise.all(selected.map(async (entry) => ({
    source: `episodes/recent/${String(entry.episode).padStart(4, "0")}`,
    content: await readFile(join(episodesDir, entry.file), "utf8").catch(() => ""),
  })));
}
