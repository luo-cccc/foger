import { join } from "node:path";
import type { StoredHook, StoredSummary } from "../state/memory-db.js";
import {
  parseEpisodeSummariesMarkdown,
  retrieveMemorySelection,
  type MemorySelection,
} from "./memory-retrieval.js";
import {
  getEpisodeContextContent,
  getEpisodeContextRecentEpisodes,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

export interface PlanningSeedMaterials {
  readonly storyDir: string;
  readonly authorIntent: string;
  readonly currentFocus: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRulesRaw: string;
  readonly currentState: string;
  readonly episodeSummariesRaw: string;
  readonly brief: string;
  readonly outlineNode?: string;
  readonly recentSummaries: ReadonlyArray<StoredSummary>;
  readonly previousEndingHook?: string;
  readonly previousEndingExcerpt?: string;
}

export interface PlanningMaterials extends PlanningSeedMaterials {
  readonly activeHooks: ReadonlyArray<StoredHook>;
  readonly memorySelection: MemorySelection;
  readonly plannerInputs: ReadonlyArray<string>;
}

export async function loadPlanningSeedMaterials(params: {
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly episodeContextSnapshot?: EpisodeContextSnapshot;
}): Promise<PlanningSeedMaterials> {
  if (!params.episodeContextSnapshot) {
    throw new Error("EPISODE_CONTEXT_REQUIRED: planning materials require the operation EpisodeContextSnapshot.");
  }
  const storyDir = join(params.bookDir, "story");
  const placeholder = "(文件尚未创建)";
  const snapshot = params.episodeContextSnapshot;
  const recentEpisode = snapshot ? getEpisodeContextRecentEpisodes(snapshot).at(-1) : undefined;
  const [
    authorIntent,
    currentFocus,
    storyBible,
    volumeOutline,
    episodeSummariesRaw,
    bookRulesRaw,
    currentState,
    previousEndingExcerpt,
    brief,
  ] = [
    getEpisodeContextContent(snapshot, "story/author_intent.md", placeholder),
    getEpisodeContextContent(snapshot, "story/current_focus.md", placeholder),
    getEpisodeContextContent(snapshot, "story/outline/story_frame.md", placeholder),
    getEpisodeContextContent(snapshot, "story/outline/volume_map.md", placeholder),
    getEpisodeContextContent(snapshot, "story/episode_summaries.md", placeholder),
    getEpisodeContextContent(snapshot, "story/book_rules.md", placeholder),
    getEpisodeContextContent(snapshot, "story/current_state.md", placeholder),
    recentEpisode?.slice(-320).trim(),
    getEpisodeContextContent(snapshot, "story/brief.md", ""),
  ];

  const episodeSummaries = parseEpisodeSummariesMarkdown(episodeSummariesRaw)
    .filter((summary) => summary.episode < params.episodeNumber)
    .sort((left, right) => right.episode - left.episode);

  return {
    storyDir,
    authorIntent,
    currentFocus,
    storyBible,
    volumeOutline,
    bookRulesRaw,
    currentState,
    episodeSummariesRaw,
    brief,
    recentSummaries: episodeSummaries.slice(0, 4).sort((left, right) => left.episode - right.episode),
    previousEndingHook: episodeSummaries[0]?.hookActivity || undefined,
    previousEndingExcerpt,
  };
}

export async function gatherPlanningMaterials(params: {
  readonly bookDir: string;
  readonly episodeNumber: number;
  readonly goal: string;
  readonly outlineNode?: string;
  readonly mustKeep?: ReadonlyArray<string>;
  readonly seed?: PlanningSeedMaterials;
  readonly episodeContextSnapshot?: EpisodeContextSnapshot;
}): Promise<PlanningMaterials> {
  const seed = params.seed ?? await loadPlanningSeedMaterials({
    bookDir: params.bookDir,
    episodeNumber: params.episodeNumber,
    episodeContextSnapshot: params.episodeContextSnapshot,
  });

  const memorySelection = await retrieveMemorySelection({
    bookDir: params.bookDir,
    episodeNumber: params.episodeNumber,
    goal: params.goal,
    outlineNode: params.outlineNode,
    mustKeep: params.mustKeep,
  });

  return {
    ...seed,
    outlineNode: params.outlineNode,
    activeHooks: memorySelection.activeHooks,
    memorySelection,
    plannerInputs: [
      join(seed.storyDir, "author_intent.md"),
      join(seed.storyDir, "current_focus.md"),
      join(seed.storyDir, "outline", "story_frame.md"),
      join(seed.storyDir, "outline", "volume_map.md"),
      join(seed.storyDir, "episode_summaries.md"),
      join(seed.storyDir, "book_rules.md"),
      join(seed.storyDir, "current_state.md"),
      join(seed.storyDir, "pending_hooks.md"),
      ...(memorySelection.dbPath ? [memorySelection.dbPath] : []),
    ],
  };
}
