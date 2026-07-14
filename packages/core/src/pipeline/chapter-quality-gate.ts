import type { AuditIssue, AuditResult } from "../agents/continuity.js";

export type ChapterQualityStatus = "ready-for-review" | "audit-failed" | "state-degraded";

export interface AuditIssueCounts {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
}

export interface ChapterQualityGateInput {
  readonly auditResult: Pick<AuditResult, "issues">;
  readonly hardLengthPassed?: boolean;
  readonly stateDegraded?: boolean;
}

export interface ChapterQualityGateDecision extends AuditIssueCounts {
  readonly status: ChapterQualityStatus;
  readonly hardLengthPassed: boolean;
  readonly stateDegraded: boolean;
  readonly hasCriticalIssue: boolean;
}

export function countAuditIssues(issues: ReadonlyArray<AuditIssue>): AuditIssueCounts {
  return issues.reduce<AuditIssueCounts>(
    (counts, issue) => ({
      critical: counts.critical + (issue.severity === "critical" ? 1 : 0),
      warning: counts.warning + (issue.severity === "warning" ? 1 : 0),
      info: counts.info + (issue.severity === "info" ? 1 : 0),
    }),
    { critical: 0, warning: 0, info: 0 },
  );
}

export function hasCriticalIssue(issues: ReadonlyArray<AuditIssue>): boolean {
  return issues.some((issue) => issue.severity === "critical");
}

/**
 * The structured issue severity is the quality contract. Some providers still
 * return passed=false for warning-only audits, so the boolean must not be the
 * continuation gate by itself.
 */
export function resolveChapterReviewStatus(
  input: ChapterQualityGateInput,
): ChapterQualityGateDecision {
  const counts = countAuditIssues(input.auditResult.issues);
  const hardLengthPassed = input.hardLengthPassed ?? true;
  const stateDegraded = input.stateDegraded ?? false;
  const status: ChapterQualityStatus = stateDegraded
    ? "state-degraded"
    : counts.critical > 0 || !hardLengthPassed
      ? "audit-failed"
      : "ready-for-review";

  return {
    ...counts,
    status,
    hardLengthPassed,
    stateDegraded,
    hasCriticalIssue: counts.critical > 0,
  };
}

/** Keep the audit API boolean consistent with the severity contract. */
export function deriveAuditPassed(auditResult: AuditResult): boolean {
  if (hasCriticalIssue(auditResult.issues)) return false;
  // A provider that says "failed" without evidence is still not a pass. The
  // review cycle can then preserve the last actionable issues instead of
  // silently discarding a failed audit response.
  if (!auditResult.passed && auditResult.issues.length === 0) return false;
  return true;
}
