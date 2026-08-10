import { describe, expect, it } from "vitest";
import type { AuditIssue } from "../agents/continuity.js";
import {
  auditIssuesFromEpisodeRecovery,
  buildEpisodeRecoveryState,
  decideEpisodeRecovery,
  fingerprintEpisodeContent,
} from "../pipeline/episode-recovery-policy.js";

const LOCAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "The episode contradicts the current location.",
  suggestion: "Correct the location reference.",
  repairScope: "local",
};

const STRUCTURAL_ISSUE: AuditIssue = {
  ...LOCAL_ISSUE,
  category: "causal-structure",
  description: "The episode resolves the conflict without its required cause.",
  repairScope: "structural",
};

describe("episode recovery evidence", () => {
  it("fingerprints the current body and preserves structured blocking issues", () => {
    const state = buildEpisodeRecoveryState({
      content: "Current episode body.",
      issues: [LOCAL_ISSUE, { ...LOCAL_ISSUE, severity: "info" }],
      operationId: "550e8400-e29b-41d4-a716-446655440000",
      terminationReason: "revision-still-blocked",
      now: () => "2026-07-17T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      version: 1,
      contentFingerprint: fingerprintEpisodeContent("Current episode body."),
      sourceOperationId: "550e8400-e29b-41d4-a716-446655440000",
      terminationReason: "revision-still-blocked",
      blockingIssues: [LOCAL_ISSUE],
    });
    expect(fingerprintEpisodeContent("# Episode 1\n\nCurrent episode body.\n"))
      .toBe(state.contentFingerprint);
  });

  it("rejects structured evidence when the persisted body has changed", () => {
    const recoveryState = buildEpisodeRecoveryState({
      content: "Old body.",
      issues: [STRUCTURAL_ISSUE],
    });

    expect(auditIssuesFromEpisodeRecovery({ auditIssues: [], recoveryState }, "New body.")).toEqual([
      expect.objectContaining({
        category: "recovery-evidence-stale",
        repairScope: "unknown",
      }),
    ]);
  });

  it("creates explicit evidence for legacy audit-failed episodes with empty issue arrays", () => {
    expect(auditIssuesFromEpisodeRecovery({ auditIssues: [] })).toEqual([
      expect.objectContaining({ category: "audit-evidence-missing", severity: "critical" }),
    ]);
  });
});

describe("bounded episode recovery policy", () => {
  it("runs repair and resync once per content fingerprint before pausing", () => {
    expect(decideEpisodeRecovery({ status: "state-degraded" }).action).toBe("repair-state");
    expect(decideEpisodeRecovery({
      status: "state-degraded",
      attempts: { currentContent: { "repair-state": 1 } },
    }).action).toBe("resync-state");
    expect(decideEpisodeRecovery({
      status: "state-degraded",
      attempts: { currentContent: { "repair-state": 1, "resync-state": 1 } },
    }).action).toBe("pause");
  });

  it("rewrites structural failures once and then pauses", () => {
    expect(decideEpisodeRecovery({
      status: "audit-failed",
      issues: [STRUCTURAL_ISSUE],
    }).action).toBe("rewrite");
    expect(decideEpisodeRecovery({
      status: "audit-failed",
      issues: [STRUCTURAL_ISSUE],
      attempts: { global: { rewrite: 1 } },
    }).action).toBe("pause");
  });

  it("escalates a local failure from revise to rewrite and then pauses", () => {
    expect(decideEpisodeRecovery({
      status: "audit-failed",
      issues: [LOCAL_ISSUE],
    }).action).toBe("revise");
    expect(decideEpisodeRecovery({
      status: "audit-failed",
      issues: [LOCAL_ISSUE],
      attempts: { global: { revise: 1 } },
    }).action).toBe("rewrite");
    expect(decideEpisodeRecovery({
      status: "audit-failed",
      issues: [LOCAL_ISSUE],
      attempts: { global: { revise: 1, rewrite: 1 } },
    }).action).toBe("pause");
  });
});
