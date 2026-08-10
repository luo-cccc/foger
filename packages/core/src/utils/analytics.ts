export interface TokenStats {
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly totalTokens: number;
  readonly avgTokensPerEpisode: number;
  readonly recentTrend: ReadonlyArray<{ readonly episode: number; readonly totalTokens: number }>;
}

export interface AnalyticsData {
  readonly bookId: string;
  readonly totalEpisodes: number;
  readonly totalDurationSeconds: number;
  readonly avgDurationSeconds: number;
  readonly auditPassRate: number;
  readonly topIssueCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  readonly episodesWithMostIssues: ReadonlyArray<{ readonly episode: number; readonly issueCount: number }>;
  readonly statusDistribution: Record<string, number>;
  readonly tokenStats?: TokenStats;
}

export function computeAnalytics(
  bookId: string,
  episodes: ReadonlyArray<{
    readonly episodeNumber: number;
    readonly status: string;
    readonly episodeDurationSeconds: number;
    readonly auditIssues: ReadonlyArray<string>;
    readonly tokenUsage?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    };
  }>,
): AnalyticsData {
  const totalEpisodes = episodes.length;
  const totalDurationSeconds = episodes.reduce((sum, episode) => sum + episode.episodeDurationSeconds, 0);
  const avgDurationSeconds = totalEpisodes > 0 ? Math.round(totalDurationSeconds / totalEpisodes) : 0;

  const passedStatuses = new Set(["ready-for-review", "approved", "published"]);
  const auditedEpisodes = episodes.filter(
    (ch) => ch.status !== "drafted" && ch.status !== "drafting" && ch.status !== "card-generated",
  );
  const passedEpisodes = auditedEpisodes.filter((ch) => passedStatuses.has(ch.status));
  const auditPassRate = auditedEpisodes.length > 0
    ? Math.round((passedEpisodes.length / auditedEpisodes.length) * 100)
    : 100;

  const categoryCounts = new Map<string, number>();
  for (const ch of episodes) {
    for (const issue of ch.auditIssues) {
      const catMatch = issue.match(/\[(?:critical|warning|info)\]\s*(.+?)[:：]/);
      const category = catMatch?.[1] ?? "未分类";
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
  }
  const topIssueCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({ category, count }));

  const episodesWithMostIssues = [...episodes]
    .filter((ch) => ch.auditIssues.length > 0)
    .sort((a, b) => b.auditIssues.length - a.auditIssues.length)
    .slice(0, 5)
    .map((ch) => ({ episode: ch.episodeNumber, issueCount: ch.auditIssues.length }));

  const statusDistribution: Record<string, number> = {};
  for (const ch of episodes) {
    statusDistribution[ch.status] = (statusDistribution[ch.status] ?? 0) + 1;
  }

  const episodesWithUsage = episodes.filter((ch) => ch.tokenUsage);
  let tokenStats: TokenStats | undefined;
  if (episodesWithUsage.length > 0) {
    const totalPromptTokens = episodesWithUsage.reduce((sum, ch) => sum + (ch.tokenUsage?.promptTokens ?? 0), 0);
    const totalCompletionTokens = episodesWithUsage.reduce((sum, ch) => sum + (ch.tokenUsage?.completionTokens ?? 0), 0);
    const totalTokens = episodesWithUsage.reduce((sum, ch) => sum + (ch.tokenUsage?.totalTokens ?? 0), 0);
    const avgTokensPerEpisode = Math.round(totalTokens / episodesWithUsage.length);

    const recentTrend = [...episodesWithUsage]
      .sort((a, b) => a.episodeNumber - b.episodeNumber)
      .slice(-5)
      .map((ch) => ({ episode: ch.episodeNumber, totalTokens: ch.tokenUsage?.totalTokens ?? 0 }));

    tokenStats = { totalPromptTokens, totalCompletionTokens, totalTokens, avgTokensPerEpisode, recentTrend };
  }

  return {
    bookId, totalEpisodes, totalDurationSeconds, avgDurationSeconds, auditPassRate,
    topIssueCategories, episodesWithMostIssues, statusDistribution, tokenStats,
  };
}
