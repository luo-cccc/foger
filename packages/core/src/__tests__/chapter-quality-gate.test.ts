import { describe, expect, it } from "vitest";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import {
  countAuditIssues,
  deriveAuditPassed,
  resolveChapterReviewStatus,
} from "../pipeline/chapter-quality-gate.js";

function issue(severity: AuditIssue["severity"]): AuditIssue {
  return {
    severity,
    category: "test",
    description: `${severity} issue`,
    suggestion: "inspect",
  };
}

function audit(issues: ReadonlyArray<AuditIssue>, passed = true): AuditResult {
  return { issues, passed, summary: "test" };
}

describe("chapter quality gate", () => {
  it("keeps warning-only audits reviewable even when a provider returns passed=false", () => {
    const result = resolveChapterReviewStatus({
      auditResult: audit([issue("warning")], false),
    });

    expect(result.status).toBe("ready-for-review");
    expect(result.warning).toBe(1);
    expect(result.critical).toBe(0);
  });

  it("blocks critical issues regardless of the provider boolean", () => {
    const result = resolveChapterReviewStatus({
      auditResult: audit([issue("critical")], true),
    });

    expect(result.status).toBe("audit-failed");
    expect(result.hasCriticalIssue).toBe(true);
  });

  it("blocks a hard length failure even when there are no audit issues", () => {
    const result = resolveChapterReviewStatus({
      auditResult: audit([]),
      hardLengthPassed: false,
    });

    expect(result.status).toBe("audit-failed");
  });

  it("prioritizes state-degraded as the hard safety state", () => {
    const result = resolveChapterReviewStatus({
      auditResult: audit([issue("warning")]),
      stateDegraded: true,
    });

    expect(result.status).toBe("state-degraded");
  });

  it("derives the audit boolean from issue severity", () => {
    expect(deriveAuditPassed(audit([issue("warning")], false))).toBe(true);
    expect(deriveAuditPassed(audit([issue("critical")], true))).toBe(false);
    expect(deriveAuditPassed(audit([], false))).toBe(false);
    expect(countAuditIssues([issue("critical"), issue("warning"), issue("info")])).toEqual({
      critical: 1,
      warning: 1,
      info: 1,
    });
  });
});
