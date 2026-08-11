import type { BookConfig } from "../models/book.js";
import type { EpisodeMeta } from "../models/episode.js";
import type { EpisodeRuntimeStateSnapshot } from "../state/episode-state-reducer.js";
import type { EpisodeScript } from "../models/episode-script.js";

export interface SeriesCompletionIssue {
  readonly severity: "critical" | "warning";
  readonly code:
    | "episode-count"
    | "episode-gap"
    | "duplicate-episode"
    | "episode-status"
    | "blocking-episode"
    | "open-core-hook"
    | "open-emotion-hook"
    | "missing-final-state"
    | "missing-final-summary"
    | "missing-final-script"
    | "incomplete-final-arc"
    | "incomplete-series-resolution"
    | "stagnant-run"
    | "final-cliffhanger";
  readonly message: string;
}

export interface SeriesCompletionReport {
  readonly completed: boolean;
  readonly targetEpisodes: number;
  readonly persistedEpisodes: number;
  readonly issues: ReadonlyArray<SeriesCompletionIssue>;
}

export function evaluateSeriesCompletion(params: {
  readonly book: BookConfig;
  readonly episodes: ReadonlyArray<EpisodeMeta>;
  readonly runtimeState?: EpisodeRuntimeStateSnapshot;
  readonly finalEpisodeScript?: EpisodeScript;
}): SeriesCompletionReport {
  const targetEpisodes = params.book.targetEpisodes ?? 100;
  const episodes = [...params.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
  const issues: SeriesCompletionIssue[] = [];
  const episodeNumbers = episodes.map((episode) => episode.episodeNumber);
  const uniqueEpisodeNumbers = new Set(episodeNumbers);

  if (!params.runtimeState) {
    issues.push({
      severity: "critical",
      code: "missing-final-state",
      message: "Runtime state snapshot is missing or invalid; series cannot be completed safely.",
    });
  }

  if (episodes.length !== targetEpisodes) {
    issues.push({
      severity: "critical",
      code: "episode-count",
      message: `${episodes.length}/${targetEpisodes} episodes are persisted; the series must contain exactly the target count.`,
    });
  }

  if (uniqueEpisodeNumbers.size !== episodeNumbers.length) {
    issues.push({
      severity: "critical",
      code: "duplicate-episode",
      message: "Duplicate episode numbers are present in the persisted index.",
    });
  }

  const missingEpisodes = Array.from({ length: targetEpisodes }, (_, index) => index + 1)
    .filter((episodeNumber) => !uniqueEpisodeNumbers.has(episodeNumber));
  if (missingEpisodes.length > 0) {
    issues.push({
      severity: "critical",
      code: "episode-gap",
      message: `Missing episode numbers: ${missingEpisodes.join(", ")}.`,
    });
  }

  const finalEpisode = episodes.find((episode) => episode.episodeNumber === targetEpisodes);
  if (!finalEpisode || !["approved", "published", "ready-for-review"].includes(finalEpisode.status)) {
    issues.push({
      severity: "critical",
      code: "episode-status",
      message: `Episode ${targetEpisodes} is not in a completable status.`,
    });
  }

  if (!params.finalEpisodeScript || params.finalEpisodeScript.episode !== targetEpisodes) {
    issues.push({
      severity: "critical",
      code: "missing-final-script",
      message: `Episode ${targetEpisodes} has no valid authoritative screenplay JSON.`,
    });
  } else if (!params.finalEpisodeScript.seriesResolution) {
    issues.push({
      severity: "critical",
      code: "incomplete-series-resolution",
      message: `Episode ${targetEpisodes} does not explicitly resolve the main conflict, protagonist desire, character arcs, and core relationships.`,
    });
  } else if (!hasCompletedSeriesResolution(params.finalEpisodeScript)) {
    issues.push({
      severity: "critical",
      code: "incomplete-series-resolution",
      message: `Episode ${targetEpisodes} declares a series resolution, but its resolution text explicitly leaves core outcomes unfinished.`,
    });
  }

  for (const episode of episodes) {
    if (episode.status === "audit-failed" || episode.status === "state-degraded"
      || episode.auditIssues.some((issue) => /^\[critical\]/iu.test(issue))) {
      issues.push({
        severity: "critical",
        code: "blocking-episode",
        message: `Episode ${episode.episodeNumber} is ${episode.status}.`,
      });
    }
  }

  const finalSurface = params.finalEpisodeScript
    ? episodeTextSurface(params.finalEpisodeScript)
    : "";
  for (const hook of params.runtimeState?.hooks.hooks ?? []) {
    if (hook.status === "resolved" || hook.status === "deferred") continue;
    const kind = hook.hookKind ?? "plot";
    const baseSeverity = hook.coreHook || kind === "emotion" ? "critical" : "warning";
    // Lenient escape: the ledger can lag behind the on-screen story. If the
    // final episode's shots/resolution already surface this hook's named facts
    // (quoted in the hook's own notes), the payoff was delivered even though
    // the planner memo never recorded a resolve annotation. Downgrade to a
    // warning that asks for manual ledger reconciliation instead of blocking
    // completion on a bookkeeping gap.
    if (finalSurface && hookSeemsPaidOff(hook, finalSurface)) {
      issues.push({
        severity: "warning",
        code: kind === "emotion" ? "open-emotion-hook" : "open-core-hook",
        message: `Open ${kind} hook ${hook.hookId} appears paid off in the final episode, but the ledger still shows "${hook.status}". Reconcile the hook ledger (e.g. a resolve note in the planner memo) before final release.`,
      });
      continue;
    }
    issues.push({
      severity: baseSeverity,
      code: kind === "emotion" ? "open-emotion-hook" : "open-core-hook",
      message: `Open ${kind} hook ${hook.hookId}: ${hook.audienceQuestion || hook.expectedPayoff || hook.type}.`,
    });
  }

  if (params.runtimeState && params.runtimeState.manifest.lastAppliedEpisode < targetEpisodes) {
    issues.push({
      severity: "critical",
      code: "missing-final-state",
      message: `Runtime state ends at episode ${params.runtimeState.manifest.lastAppliedEpisode}, before episode ${targetEpisodes}.`,
    });
  }

  const summaryRows = params.runtimeState?.episodeSummaries?.rows
    ? [...params.runtimeState.episodeSummaries.rows].sort((left, right) => left.episodeNumber - right.episodeNumber)
    : [];
  let stagnantRun = 0;
  for (const row of summaryRows) {
    const hasEffectiveChange = Boolean(
      row.stateChanges.trim()
      || row.events.trim()
      || row.relationshipChange?.trim()
      || row.reversal?.trim()
      || row.payoff?.trim(),
    );
    stagnantRun = hasEffectiveChange ? 0 : stagnantRun + 1;
    if (stagnantRun >= 3) {
      issues.push({
        severity: "critical",
        code: "stagnant-run",
        message: `Episodes ${row.episodeNumber - 2}-${row.episodeNumber} contain no effective story-state change.`,
      });
      break;
    }
  }

  const finalSummary = summaryRows.find((row) => row.episodeNumber === targetEpisodes);
  if (!finalSummary) {
    issues.push({
      severity: "critical",
      code: "missing-final-summary",
      message: `Episode ${targetEpisodes} has no persisted summary evidence.`,
    });
  } else if (
    !finalSummary.events.trim()
    || !finalSummary.stateChanges.trim()
    || !finalSummary.payoff?.trim()
    || !finalSummary.relationshipChange?.trim()
  ) {
    issues.push({
      severity: "critical",
      code: "incomplete-final-arc",
      message: `Episode ${targetEpisodes} does not record final event, state, payoff, and relationship resolution evidence.`,
    });
  }
  if (
    finalSummary
    && finalSummary.endingQuestion?.trim()
    && !finalSummary.stateChanges.trim()
    && !finalSummary.events.trim()
    && !finalSummary.relationshipChange?.trim()
    && !finalSummary.reversal?.trim()
    && !finalSummary.payoff?.trim()
  ) {
    issues.push({
      severity: "critical",
      code: "final-cliffhanger",
      message: `Episode ${targetEpisodes} ends on a question without a resolving state change.`,
    });
  }

  return {
    completed: issues.every((issue) => issue.severity !== "critical"),
    targetEpisodes,
    persistedEpisodes: episodes.length,
    issues,
  };
}

function hasCompletedSeriesResolution(script: EpisodeScript): boolean {
  const resolution = script.seriesResolution;
  if (!resolution) return false;
  const claims = [
    resolution.mainConflict,
    resolution.protagonistDesire,
    ...resolution.characterArcs.map((arc) => arc.outcome),
    ...resolution.relationships.map((relationship) => relationship.outcome),
  ];
  return claims.every((claim) => !explicitlyLeavesOutcomeUnfinished(claim));
}

function explicitlyLeavesOutcomeUnfinished(claim: string): boolean {
  const normalized = claim.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized) return true;
  const unfinishedPatterns = [
    /(?:尚未|仍未|还未|并未|没有).{0,12}(?:解决|终结|结束|完成|兑现|回答|收束|结清|揭晓|公开)/u,
    /(?:悬置|待解|待续|未完|仍在继续|转向.{0,16}能否|准备.{0,16}终局)/u,
    /\b(?:remains?|is|are|was|were)\s+(?:still\s+)?unresolved\b/iu,
    /\b(?:not|never)\s+(?:fully\s+)?(?:resolved|ended|completed|settled|answered|paid\s+off)\b/iu,
    /\b(?:left|kept)\s+(?:the\s+)?(?:conflict|desire|arc|relationship|outcome)?\s*unresolved\b/iu,
  ];
  return unfinishedPatterns.some((pattern) => pattern.test(normalized));
}

function episodeTextSurface(script: EpisodeScript): string {
  return (script.scenes ?? [])
    .flatMap((scene) => scene.shots.flatMap((shot) => [
      shot.visual,
      shot.action ?? "",
      shot.narration ?? "",
      ...shot.dialogue.map((line) => `${line.speaker} ${line.text}`),
      ...(script.seriesResolution
        ? [
            script.seriesResolution.mainConflict,
            script.seriesResolution.protagonistDesire,
            ...script.seriesResolution.characterArcs.map((arc) => arc.outcome),
            ...script.seriesResolution.relationships.map((relationship) => relationship.outcome),
          ]
        : []),
    ]))
    .join(" ")
    .toLowerCase();
}

/**
 * True when the hook's own notes/questions name facts that already appear in
 * the final episode surface. Quoted 「」/"..." phrases are the most reliable
 * signal: the ledger seeds them for exactly the objects whose on-screen
 * appearance constitutes the payoff.
 */
function hookSeemsPaidOff(
  hook: Readonly<{
    readonly notes?: string;
    readonly audienceQuestion?: string;
  }>,
  surface: string,
): boolean {
  const source = `${hook.notes ?? ""}\n${hook.audienceQuestion ?? ""}`;
  const keywords = new Set<string>();
  for (const quoted of source.matchAll(/「([^」]{2,12})」/gu)) {
    keywords.add(quoted[1]!.toLowerCase());
  }
  for (const quoted of source.matchAll(/"([^"]{2,12})"/gu)) {
    keywords.add(quoted[1]!.toLowerCase());
  }
  const hits = [...keywords].filter((keyword) => surface.includes(keyword));
  return hits.length >= 1;
}
