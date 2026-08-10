export type EpisodeIssueSeverity = "critical" | "warning" | "info";

export interface EpisodeQualitySummary {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
  readonly total: number;
  readonly samples: ReadonlyArray<string>;
}

const ISSUE_PATTERN = /^\[(critical|warning|info)\]\s*(.*)$/i;

export function summarizeEpisodeIssues(
  auditIssues: ReadonlyArray<string> = [],
  lengthWarnings: ReadonlyArray<string> = [],
): EpisodeQualitySummary {
  const counts: Record<EpisodeIssueSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  const samples: string[] = [];

  for (const issue of auditIssues) {
    const match = issue.match(ISSUE_PATTERN);
    const severity = (match?.[1]?.toLowerCase() ?? "warning") as EpisodeIssueSeverity;
    counts[severity] += 1;
    if (samples.length < 2) samples.push(match?.[2]?.trim() || issue);
  }

  for (const warning of lengthWarnings) {
    counts.critical += 1;
    if (samples.length < 2) samples.push(warning);
  }

  return {
    ...counts,
    total: counts.critical + counts.warning + counts.info,
    samples,
  };
}
