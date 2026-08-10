/**
 * Detection feedback loop — analyze detection_history.json to extract insights.
 */

import type { DetectionHistoryEntry, DetectionStats } from "../models/detection.js";

/**
 * Analyze detection history and produce aggregated statistics.
 */
export function analyzeDetectionInsights(
  history: ReadonlyArray<DetectionHistoryEntry>,
): DetectionStats {
  if (history.length === 0) {
    return {
      totalDetections: 0,
      totalRewrites: 0,
      avgOriginalScore: 0,
      avgFinalScore: 0,
      avgScoreReduction: 0,
      passRate: 0,
      episodeBreakdown: [],
    };
  }

  const detections = history.filter((h) => h.action === "detect");
  const rewrites = history.filter((h) => h.action === "rewrite");

  // Group by episode
  const episodeMap = new Map<number, DetectionHistoryEntry[]>();
  for (const entry of history) {
    const existing = episodeMap.get(entry.episodeNumber) ?? [];
    episodeMap.set(entry.episodeNumber, [...existing, entry]);
  }

  const episodeBreakdown: Array<{
    episodeNumber: number;
    originalScore: number;
    finalScore: number;
    rewriteAttempts: number;
  }> = [];

  let totalOriginal = 0;
  let totalFinal = 0;

  for (const [episodeNumber, entries] of episodeMap) {
    const sorted = [...entries].sort((a, b) => a.attempt - b.attempt);
    const originalScore = sorted[0]?.score ?? 0;
    const finalScore = sorted[sorted.length - 1]?.score ?? originalScore;
    const rewriteAttempts = sorted.filter((e) => e.action === "rewrite").length;

    episodeBreakdown.push({ episodeNumber, originalScore, finalScore, rewriteAttempts });
    totalOriginal += originalScore;
    totalFinal += finalScore;
  }

  const episodeCount = episodeBreakdown.length;
  const avgOriginalScore = episodeCount > 0 ? totalOriginal / episodeCount : 0;
  const avgFinalScore = episodeCount > 0 ? totalFinal / episodeCount : 0;

  // Pass rate = episodes where final score decreased (or no rewrite needed)
  const passedEpisodes = episodeBreakdown.filter((c) => c.finalScore <= c.originalScore).length;

  return {
    totalDetections: detections.length,
    totalRewrites: rewrites.length,
    avgOriginalScore: Math.round(avgOriginalScore * 1000) / 1000,
    avgFinalScore: Math.round(avgFinalScore * 1000) / 1000,
    avgScoreReduction: Math.round((avgOriginalScore - avgFinalScore) * 1000) / 1000,
    passRate: episodeCount > 0 ? Math.round((passedEpisodes / episodeCount) * 100) / 100 : 0,
    episodeBreakdown,
  };
}
