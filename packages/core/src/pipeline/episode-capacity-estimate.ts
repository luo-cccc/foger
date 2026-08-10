/**
 * Episode capacity feasibility estimate (STY-16, borrowed from drama-skills
 * episode-design §9.4). Pure deterministic module — no LLM.
 *
 * The question it answers: does the plan for an upcoming episode promise
 * roughly one episode's worth of material, or two / half? It converts the
 * plan text volume into an estimated shot count and duration using ratios
 * sampled from the book's accepted episodes, and only speaks up on MAGNITUDE
 * deviations (≥2× or ≤½). This is a craft hint, never a quality gate: it
 * writes a non-blocking note and never stops planning or writing.
 *
 * Mount points:
 * - single-episode stage (active): PipelineRunner.planEpisode attaches the
 *   note to PlanEpisodeResult so `inkos plan episode` can display it.
 * - volume-planning stage (dormant by design): long books keep no per-episode
 *   outline text in volume_map (only compact ≤12-episode books have a beat
 *   contract, and at foundation time no accepted-episode baseline exists yet),
 *   so there is currently no data seam for volume-level estimation. The
 *   generic `estimateEpisodeCapacityFromPlan` API is exported for whenever
 *   per-episode outline text becomes available.
 */

import {
  EPISODE_DURATION_TARGET_SECONDS,
  episodeShotBudget,
} from "../models/episode-script.js";

export interface EpisodeCapacitySample {
  readonly shotCount: number;
  readonly spokenCharacters: number;
  readonly narrationCharacters: number;
  readonly estimatedDurationSeconds: number;
}

export interface EpisodeCapacityBaseline {
  readonly sampleSize: number;
  readonly avgCharactersPerShot: number;
  readonly avgSecondsPerShot: number;
}

/** Accepted episodes needed before ratios mean anything. */
export const EPISODE_CAPACITY_MIN_SAMPLES = 3;
/** Only deviations of this magnitude (or more) produce a note. */
export const EPISODE_CAPACITY_MAGNITUDE = 2;

export function buildEpisodeCapacityBaseline(
  samples: ReadonlyArray<EpisodeCapacitySample>,
): EpisodeCapacityBaseline | undefined {
  const usable = samples.filter((sample) => sample.shotCount > 0);
  if (usable.length < EPISODE_CAPACITY_MIN_SAMPLES) return undefined;

  const totalCharacters = usable.reduce(
    (sum, sample) => sum + sample.spokenCharacters + sample.narrationCharacters,
    0,
  );
  const totalShots = usable.reduce((sum, sample) => sum + sample.shotCount, 0);
  const totalSeconds = usable.reduce((sum, sample) => sum + sample.estimatedDurationSeconds, 0);
  if (totalShots === 0) return undefined;

  return {
    sampleSize: usable.length,
    avgCharactersPerShot: totalCharacters / totalShots,
    avgSecondsPerShot: totalSeconds / totalShots,
  };
}

export interface EpisodeCapacityEstimateOptions {
  readonly shotMin?: number;
  readonly shotMax?: number;
  readonly targetDurationSeconds?: number;
}

export interface EpisodeCapacityNote {
  readonly zh: string;
  readonly en: string;
}

export interface EpisodeCapacityEstimate {
  readonly planCharacters: number;
  readonly estimatedShots: number;
  readonly estimatedDurationSeconds: number;
  readonly deviation: "within" | "over" | "under";
  readonly note?: EpisodeCapacityNote;
}

export function estimateEpisodeCapacityFromPlan(
  planText: string,
  baseline: EpisodeCapacityBaseline,
  options: EpisodeCapacityEstimateOptions = {},
): EpisodeCapacityEstimate {
  const targetDurationSeconds = options.targetDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS;
  const budget = episodeShotBudget(targetDurationSeconds);
  const shotMin = options.shotMin ?? budget.min;
  const shotMax = options.shotMax ?? budget.softMax;

  const planCharacters = planText.replace(/\s+/gu, "").length;
  const estimatedShots = baseline.avgCharactersPerShot > 0
    ? planCharacters / baseline.avgCharactersPerShot
    : 0;
  const estimatedDurationSeconds = estimatedShots * baseline.avgSecondsPerShot;

  const over = estimatedShots >= shotMax * EPISODE_CAPACITY_MAGNITUDE
    || estimatedDurationSeconds >= targetDurationSeconds * EPISODE_CAPACITY_MAGNITUDE;
  const under = estimatedShots > 0 && (
    estimatedShots <= shotMin / EPISODE_CAPACITY_MAGNITUDE
    || estimatedDurationSeconds <= targetDurationSeconds / EPISODE_CAPACITY_MAGNITUDE
  );
  const deviation = over ? "over" : under ? "under" : "within";

  const roundedShots = Math.round(estimatedShots * 10) / 10;
  const roundedSeconds = Math.round(estimatedDurationSeconds);
  const note: EpisodeCapacityNote | undefined = deviation === "within"
    ? undefined
    : deviation === "over"
      ? {
          zh: `容量提示：按本书已接受集的平均承载换算，这份规划约合 ${roundedShots} 个镜头 / ${roundedSeconds} 秒，明显超出 ${shotMin}-${shotMax} 镜头（目标 ${targetDurationSeconds} 秒）的单集体量。这不是质量门槛——请确认是否应拆成两集或压缩承诺的场面。`,
          en: `Capacity note: scaled by this book's accepted-episode averages, this plan converts to roughly ${roundedShots} shots / ${roundedSeconds}s, well beyond one episode's ${shotMin}-${shotMax} shots (target ${targetDurationSeconds}s). Not a quality gate — confirm whether it should be split into two episodes or trimmed.`,
        }
      : {
          zh: `容量提示：按本书已接受集的平均承载换算，这份规划约合 ${roundedShots} 个镜头 / ${roundedSeconds} 秒，明显低于 ${shotMin}-${shotMax} 镜头（目标 ${targetDurationSeconds} 秒）的单集体量。这不是质量门槛——请确认场面承诺是否过薄，或与相邻集合并。`,
          en: `Capacity note: scaled by this book's accepted-episode averages, this plan converts to roughly ${roundedShots} shots / ${roundedSeconds}s, well below one episode's ${shotMin}-${shotMax} shots (target ${targetDurationSeconds}s). Not a quality gate — confirm whether the promised beats are too thin or should merge with a neighbor.`,
        };

  return {
    planCharacters,
    estimatedShots: roundedShots,
    estimatedDurationSeconds: roundedSeconds,
    deviation,
    ...(note ? { note } : {}),
  };
}

export interface MemoCapacityCommitments {
  readonly scenes: number;
  readonly causalChains: number;
  readonly promisedBeats: number;
  readonly note?: EpisodeCapacityNote;
}

/**
 * Auxiliary single-episode metric: count the beats a memo explicitly
 * promises (scene intents + causal-escalation chains) and compare against
 * the shot budget. Non-blocking; a memo may legitimately under-declare.
 */
export function summarizeMemoCapacityCommitments(
  memo: {
    readonly sceneLimit?: number;
    readonly shotMin?: number;
    readonly shotMax?: number;
    readonly causalEscalation?: string;
  },
  options: EpisodeCapacityEstimateOptions = {},
): MemoCapacityCommitments {
  const budget = episodeShotBudget(options.targetDurationSeconds ?? EPISODE_DURATION_TARGET_SECONDS);
  const shotMin = options.shotMin ?? budget.min;
  const shotMax = options.shotMax ?? budget.softMax;

  const scenes = memo.sceneLimit && memo.sceneLimit > 0 ? memo.sceneLimit : 1;
  const escalationText = memo.causalEscalation?.trim() ?? "";
  const chainLines = escalationText
    .split(/\r?\n/u)
    .filter((line) => line.includes("→") || /->/u.test(line))
    .length;
  const causalChains = escalationText.length === 0 ? 0 : Math.max(1, chainLines);
  const promisedBeats = scenes + causalChains;

  const note: EpisodeCapacityNote | undefined = promisedBeats > shotMax
    ? {
        zh: `容量提示：memo 承诺了 ${scenes} 个场景意图 + ${causalChains} 条因果升级链（合计 ${promisedBeats} 拍），超过 ${shotMin}-${shotMax} 镜头的执行预算；这不是质量门槛，写作时可能需要合并节拍。`,
        en: `Capacity note: the memo promises ${scenes} scene intent(s) + ${causalChains} causal chain(s) (${promisedBeats} beats total), above the ${shotMin}-${shotMax}-shot budget; not a quality gate, but beats may need merging during writing.`,
      }
    : undefined;

  return { scenes, causalChains, promisedBeats, ...(note ? { note } : {}) };
}
