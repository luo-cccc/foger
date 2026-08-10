import { describe, it, expect } from "vitest";
import { computeAnalytics } from "@actalk/inkos-core";

describe("computeAnalytics", () => {
  it("returns zeros for empty episodes", () => {
    const result = computeAnalytics("test-book", []);
    expect(result.bookId).toBe("test-book");
    expect(result.totalEpisodes).toBe(0);
    expect(result.totalDurationSeconds).toBe(0);
    expect(result.avgDurationSeconds).toBe(0);
    expect(result.auditPassRate).toBe(100); // no audited episodes = 100%
    expect(result.topIssueCategories).toEqual([]);
    expect(result.episodesWithMostIssues).toEqual([]);
    expect(result.statusDistribution).toEqual({});
  });

  it("computes basic stats correctly", () => {
    const episodes = [
      { episodeNumber: 1, status: "approved", episodeDurationSeconds: 90, auditIssues: [] },
      { episodeNumber: 2, status: "approved", episodeDurationSeconds: 95, auditIssues: [] },
      { episodeNumber: 3, status: "ready-for-review", episodeDurationSeconds: 85, auditIssues: [] },
    ];
    const result = computeAnalytics("book-a", episodes);
    expect(result.totalEpisodes).toBe(3);
    expect(result.totalDurationSeconds).toBe(270);
    expect(result.avgDurationSeconds).toBe(90);
  });

  it("calculates audit pass rate excluding un-audited statuses", () => {
    const episodes = [
      { episodeNumber: 1, status: "approved", episodeDurationSeconds: 3000, auditIssues: [] },
      { episodeNumber: 2, status: "audit-failed", episodeDurationSeconds: 3000, auditIssues: ["[critical] 连续性：角色位置矛盾"] },
      { episodeNumber: 3, status: "drafted", episodeDurationSeconds: 3000, auditIssues: [] }, // not audited
      { episodeNumber: 4, status: "ready-for-review", episodeDurationSeconds: 3000, auditIssues: [] },
    ];
    const result = computeAnalytics("book-b", episodes);
    // Audited: approved(1), audit-failed(2), ready-for-review(4) = 3
    // Passed (approved + ready-for-review + published): 1 + 4 = 2
    // Pass rate: 2/3 = 67%
    expect(result.auditPassRate).toBe(67);
  });

  it("counts state-degraded episodes as audited but not passed", () => {
    const episodes = [
      { episodeNumber: 1, status: "approved", episodeDurationSeconds: 3000, auditIssues: [] },
      { episodeNumber: 2, status: "state-degraded", episodeDurationSeconds: 2800, auditIssues: ["[warning] state validation drift"] },
      { episodeNumber: 3, status: "drafted", episodeDurationSeconds: 2600, auditIssues: [] },
    ];
    const result = computeAnalytics("book-state-degraded", episodes);
    expect(result.auditPassRate).toBe(50);
    expect(result.statusDistribution).toEqual({
      approved: 1,
      "state-degraded": 1,
      drafted: 1,
    });
  });

  it("extracts issue categories from formatted strings", () => {
    const episodes = [
      {
        episodeNumber: 1,
        status: "audit-failed",
        episodeDurationSeconds: 3000,
        auditIssues: [
          "[critical] 连续性：角色位置矛盾",
          "[warning] 数值错误：灵石数量不一致",
          "[critical] 连续性：时间线冲突",
        ],
      },
      {
        episodeNumber: 2,
        status: "audit-failed",
        episodeDurationSeconds: 2900,
        auditIssues: [
          "[warning] 数值错误：修炼速度超标",
        ],
      },
    ];
    const result = computeAnalytics("book-c", episodes);
    expect(result.topIssueCategories).toEqual([
      { category: "连续性", count: 2 },
      { category: "数值错误", count: 2 },
    ]);
  });

  it("falls back to 未分类 for unstructured issues", () => {
    const episodes = [
      {
        episodeNumber: 1,
        status: "audit-failed",
        episodeDurationSeconds: 3000,
        auditIssues: ["some random issue without format"],
      },
    ];
    const result = computeAnalytics("book-d", episodes);
    expect(result.topIssueCategories).toEqual([
      { category: "未分类", count: 1 },
    ]);
  });

  it("ranks episodes by issue count", () => {
    const episodes = [
      { episodeNumber: 1, status: "audit-failed", episodeDurationSeconds: 3000, auditIssues: ["a"] },
      { episodeNumber: 2, status: "audit-failed", episodeDurationSeconds: 3000, auditIssues: ["a", "b", "c"] },
      { episodeNumber: 3, status: "approved", episodeDurationSeconds: 3000, auditIssues: [] },
      { episodeNumber: 4, status: "audit-failed", episodeDurationSeconds: 3000, auditIssues: ["a", "b"] },
    ];
    const result = computeAnalytics("book-e", episodes);
    expect(result.episodesWithMostIssues).toEqual([
      { episode: 2, issueCount: 3 },
      { episode: 4, issueCount: 2 },
      { episode: 1, issueCount: 1 },
    ]);
  });

  it("computes status distribution", () => {
    const episodes = [
      { episodeNumber: 1, status: "approved", episodeDurationSeconds: 3000, auditIssues: [] },
      { episodeNumber: 2, status: "approved", episodeDurationSeconds: 3000, auditIssues: [] },
      { episodeNumber: 3, status: "audit-failed", episodeDurationSeconds: 3000, auditIssues: ["x"] },
      { episodeNumber: 4, status: "drafted", episodeDurationSeconds: 3000, auditIssues: [] },
    ];
    const result = computeAnalytics("book-f", episodes);
    expect(result.statusDistribution).toEqual({
      approved: 2,
      "audit-failed": 1,
      drafted: 1,
    });
  });

  it("limits topIssueCategories to 10", () => {
    const issues = Array.from({ length: 15 }, (_, i) =>
      `[warning] cat${i}：something`,
    );
    const episodes = [
      { episodeNumber: 1, status: "audit-failed", episodeDurationSeconds: 3000, auditIssues: issues },
    ];
    const result = computeAnalytics("book-g", episodes);
    expect(result.topIssueCategories.length).toBe(10);
  });

  it("limits episodesWithMostIssues to 5", () => {
    const episodes = Array.from({ length: 8 }, (_, i) => ({
      episodeNumber: i + 1,
      status: "audit-failed",
      episodeDurationSeconds: 3000,
      auditIssues: Array.from({ length: i + 1 }, (_, j) => `issue-${j}`),
    }));
    const result = computeAnalytics("book-h", episodes);
    expect(result.episodesWithMostIssues.length).toBe(5);
    // Sorted descending: ch8(8), ch7(7), ch6(6), ch5(5), ch4(4)
    expect(result.episodesWithMostIssues[0]!.episode).toBe(8);
  });
});
