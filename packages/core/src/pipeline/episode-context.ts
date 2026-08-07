import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";

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
  contextPackage?: ContextPackage;
  ruleStack?: RuleStack;
  hash: string;
  readonly duplicateChars: number;
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
  const sources = [
    "outline/story_frame.md",
    "outline/volume_map.md",
    "current_state.md",
    "pending_hooks.md",
    "episode_summaries.md",
  ];
  const entries = await Promise.all(sources.map(async (source) => ({
    source: `story/${source}`,
    content: await readFile(join(storyDir, source), "utf8").catch(() => ""),
  })));
  return buildEpisodeContextSnapshot({ ...params, entries });
}
