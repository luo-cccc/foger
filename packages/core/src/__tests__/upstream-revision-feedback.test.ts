import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditIssue } from "../agents/continuity.js";
import { resolveAuditIssueOwner } from "../pipeline/episode-review-evidence.js";
import {
  clearUpstreamRevisionFeedback,
  loadUpstreamRevisionFeedback,
  recordUpstreamRevisionFeedback,
} from "../pipeline/upstream-revision-feedback.js";

let bookDir: string;

beforeEach(async () => {
  bookDir = await mkdtemp(join(tmpdir(), "inkos-upstream-feedback-"));
});

afterEach(async () => {
  await rm(bookDir, { recursive: true, force: true });
});

const plannerCritical: AuditIssue = {
  severity: "critical",
  category: "hook-state-contradiction",
  description: "Hook H003 已回收但账本仍标 deferred。",
  suggestion: "在下一次 memo 中修正 Hook 账。",
};

const writerCritical: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "证据链断裂。",
  suggestion: "补一个证据镜头。",
};

describe("upstream revision feedback (P0-2)", () => {
  it("persists only planner/canon-owned blocking findings", async () => {
    const recorded = await recordUpstreamRevisionFeedback(
      bookDir,
      7,
      [plannerCritical, writerCritical],
      resolveAuditIssueOwner,
    );
    expect(recorded?.findings).toHaveLength(1);
    expect(recorded?.findings[0]).toMatchObject({
      category: "hook-state-contradiction",
      owner: "planner",
      severity: "critical",
    });

    const loaded = await loadUpstreamRevisionFeedback(bookDir, 7);
    expect(loaded?.episode).toBe(7);
    expect(loaded?.findings[0]?.suggestion).toContain("Hook 账");
  });

  it("returns undefined when no upstream-owned finding exists", async () => {
    const recorded = await recordUpstreamRevisionFeedback(
      bookDir,
      7,
      [writerCritical],
      resolveAuditIssueOwner,
    );
    expect(recorded).toBeUndefined();
    expect(await loadUpstreamRevisionFeedback(bookDir, 7)).toBeUndefined();
  });

  it("ignores feedback recorded for a different episode (stale)", async () => {
    await recordUpstreamRevisionFeedback(bookDir, 7, [plannerCritical], resolveAuditIssueOwner);
    expect(await loadUpstreamRevisionFeedback(bookDir, 8)).toBeUndefined();
    expect(await loadUpstreamRevisionFeedback(bookDir, 7)).toBeDefined();
  });

  it("drops info-severity findings and clears consumed feedback", async () => {
    const infoUpstream: AuditIssue = { ...plannerCritical, severity: "info" };
    const recorded = await recordUpstreamRevisionFeedback(
      bookDir,
      7,
      [infoUpstream, plannerCritical],
      resolveAuditIssueOwner,
    );
    expect(recorded?.findings).toHaveLength(1);

    await clearUpstreamRevisionFeedback(bookDir);
    expect(await loadUpstreamRevisionFeedback(bookDir, 7)).toBeUndefined();
  });
});
