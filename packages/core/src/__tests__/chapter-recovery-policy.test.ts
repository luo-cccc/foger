import { describe, expect, it } from "vitest";
import type { AuditIssue } from "../agents/continuity.js";
import {
  auditIssuesFromChapterRecovery,
  buildChapterRecoveryState,
  decideChapterRecovery,
  fingerprintChapterContent,
} from "../pipeline/chapter-recovery-policy.js";

const LOCAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "The chapter contradicts the current location.",
  suggestion: "Correct the location reference.",
  repairScope: "local",
};

const STRUCTURAL_ISSUE: AuditIssue = {
  ...LOCAL_ISSUE,
  category: "causal-structure",
  description: "The chapter resolves the conflict without its required cause.",
  repairScope: "structural",
};

describe("chapter recovery evidence", () => {
  it("fingerprints the current body and preserves structured blocking issues", () => {
    const state = buildChapterRecoveryState({
      content: "Current chapter body.",
      issues: [LOCAL_ISSUE, { ...LOCAL_ISSUE, severity: "info" }],
      operationId: "550e8400-e29b-41d4-a716-446655440000",
      terminationReason: "revision-still-blocked",
      now: () => "2026-07-17T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      version: 1,
      contentFingerprint: fingerprintChapterContent("Current chapter body."),
      sourceOperationId: "550e8400-e29b-41d4-a716-446655440000",
      terminationReason: "revision-still-blocked",
      blockingIssues: [LOCAL_ISSUE],
    });
    expect(fingerprintChapterContent("# Chapter 1\n\nCurrent chapter body.\n"))
      .toBe(state.contentFingerprint);
  });

  it("rejects structured evidence when the persisted body has changed", () => {
    const recoveryState = buildChapterRecoveryState({
      content: "Old body.",
      issues: [STRUCTURAL_ISSUE],
    });

    expect(auditIssuesFromChapterRecovery({ auditIssues: [], recoveryState }, "New body.")).toEqual([
      expect.objectContaining({
        category: "recovery-evidence-stale",
        repairScope: "unknown",
      }),
    ]);
  });

  it("creates explicit evidence for legacy audit-failed chapters with empty issue arrays", () => {
    expect(auditIssuesFromChapterRecovery({ auditIssues: [] })).toEqual([
      expect.objectContaining({ category: "audit-evidence-missing", severity: "critical" }),
    ]);
  });
});

describe("bounded chapter recovery policy", () => {
  it("runs repair and resync once per content fingerprint before pausing", () => {
    expect(decideChapterRecovery({ status: "state-degraded" }).action).toBe("repair-state");
    expect(decideChapterRecovery({
      status: "state-degraded",
      attempts: { currentContent: { "repair-state": 1 } },
    }).action).toBe("resync-state");
    expect(decideChapterRecovery({
      status: "state-degraded",
      attempts: { currentContent: { "repair-state": 1, "resync-state": 1 } },
    }).action).toBe("pause");
  });

  it("rewrites structural failures once and then pauses", () => {
    expect(decideChapterRecovery({
      status: "audit-failed",
      issues: [STRUCTURAL_ISSUE],
    }).action).toBe("rewrite");
    expect(decideChapterRecovery({
      status: "audit-failed",
      issues: [STRUCTURAL_ISSUE],
      attempts: { global: { rewrite: 1 } },
    }).action).toBe("pause");
  });

  it("escalates a local failure from revise to rewrite and then pauses", () => {
    expect(decideChapterRecovery({
      status: "audit-failed",
      issues: [LOCAL_ISSUE],
    }).action).toBe("revise");
    expect(decideChapterRecovery({
      status: "audit-failed",
      issues: [LOCAL_ISSUE],
      attempts: { global: { revise: 1 } },
    }).action).toBe("rewrite");
    expect(decideChapterRecovery({
      status: "audit-failed",
      issues: [LOCAL_ISSUE],
      attempts: { global: { revise: 1, rewrite: 1 } },
    }).action).toBe("pause");
  });
});
