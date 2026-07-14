export type ChapterIssueSeverity = "critical" | "warning" | "info";

export interface ChapterQualitySummary {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
  readonly total: number;
  readonly samples: ReadonlyArray<string>;
}

const ISSUE_PATTERN = /^\[(critical|warning|info)\]\s*(.*)$/i;

export function summarizeChapterIssues(
  auditIssues: ReadonlyArray<string> = [],
  lengthWarnings: ReadonlyArray<string> = [],
): ChapterQualitySummary {
  const counts: Record<ChapterIssueSeverity, number> = {
    critical: 0,
    warning: 0,
    info: 0,
  };
  const samples: string[] = [];

  for (const issue of auditIssues) {
    const match = issue.match(ISSUE_PATTERN);
    const severity = (match?.[1]?.toLowerCase() ?? "warning") as ChapterIssueSeverity;
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
