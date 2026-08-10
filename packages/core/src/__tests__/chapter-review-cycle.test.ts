import { describe, expect, it, vi } from "vitest";
import {
  runEpisodeReviewCycle,
  type EpisodeReviewEvaluation,
} from "../pipeline/episode-review-cycle.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { LengthSpec } from "../models/length-governance.js";

const LENGTH_SPEC: LengthSpec = {
  target: 220,
  softMin: 190,
  softMax: 250,
  hardMin: 160,
  hardMax: 280,
  countingMode: "zh_chars",
  normalizeMode: "none",
};

const ZERO_USAGE: { promptTokens: number; completionTokens: number; totalTokens: number } = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    overallScore: 90,
    ...overrides,
  };
}

function createEvaluation(
  auditEpisode: (content: string, options?: { readonly temperature?: number }) => Promise<AuditResult>,
  runPostWriteChecks: (content: string) => ReadonlyArray<AuditIssue> = () => [],
): Parameters<typeof runEpisodeReviewCycle>[0]["evaluateEpisode"] {
  return async (content, options): Promise<EpisodeReviewEvaluation> => {
    const llmAudit = await auditEpisode(content, options);
    const postWriteIssues = runPostWriteChecks(content);
    const revisionBlockingIssues = [...llmAudit.issues, ...postWriteIssues];
    return {
      auditResult: {
        ...llmAudit,
        passed: postWriteIssues.some((issue) => issue.severity === "critical")
          ? false
          : llmAudit.passed,
        issues: revisionBlockingIssues,
      },
      aiTellCount: 0,
      blockingCount: revisionBlockingIssues.filter((issue) => issue.severity === "warning" || issue.severity === "critical").length,
      criticalCount: revisionBlockingIssues.filter((issue) => issue.severity === "critical").length,
      revisionBlockingIssues,
    };
  };
}

const baseParams = {
  book: { genre: "xuanhuan" },
  bookDir: "/tmp/book",
  episodeNumber: 1,
  lengthSpec: LENGTH_SPEC,
  reducedControlInput: undefined,
  initialUsage: ZERO_USAGE,
  assertEpisodeContentNotEmpty: () => undefined,
  addUsage: (left: typeof ZERO_USAGE, right?: typeof ZERO_USAGE) => ({
    promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
    completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
    totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
  }),
  logWarn: () => undefined,
  logStage: () => undefined,
} as const;

describe("runEpisodeReviewCycle v9", () => {
  it("feeds postWriteErrors as extra issues into first assessment", async () => {
    // postWriteErrors are critical → auditResult.passed forced false
    // even though LLM says passed=true. This triggers the repair loop.
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ overallScore: 90, passed: true }))
      .mockResolvedValueOnce(createAuditResult({ overallScore: 92, passed: true }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["fixed"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "b".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [{
          rule: "episode-number-reference",
          description: "contains episode ref",
          suggestion: "remove it",
          severity: "error",
        }],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(
        auditEpisode,
        // Simulates: the reviser fixed the episode-ref, so re-check returns empty
        (content) => content === "b".repeat(200)
          ? [{ severity: "critical" as const, category: "episode-number-reference", description: "contains episode ref", suggestion: "remove it" }]
          : [],
      ),
      normalizeDraftLengthIfNeeded,
    });

    // After repair, postWriteChecks on the revised content returns empty → issue gone
    expect(result.auditResult.issues.some(i => i.category === "episode-number-reference")).toBe(false);
    // The loop should have run at least once to fix the critical postWriteError
    expect(reviseEpisode).toHaveBeenCalled();
    expect(reviseEpisode.mock.calls[0]?.[4]).toBe("auto");
  });

  it("sends only actionable issues to the reviser and records each reviewed candidate", async () => {
    const critical: AuditIssue = {
      severity: "critical",
      category: "summary-ending",
      description: "Replace the abstract ending.",
      suggestion: "End on a concrete action.",
    };
    const info: AuditIssue = {
      severity: "info",
      category: "continuity-ok",
      description: "Timeline is consistent.",
      suggestion: "None.",
    };
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 98,
        issues: [critical, info],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 92,
        issues: [info],
      }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "r".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["ending"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "i".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 1,
    });

    expect(reviseEpisode.mock.calls[0]?.[3]).toEqual([critical]);
    expect(result.reviewAttempts).toHaveLength(2);
    expect(result.reviewAttempts[0]).toMatchObject({
      stage: "initial",
      selected: false,
      score: 98,
      criticalCount: 1,
      actionableIssues: [critical],
    });
    expect(result.reviewAttempts[1]).toMatchObject({
      stage: "revision",
      selected: true,
      score: 92,
      criticalCount: 0,
      actionableIssues: [],
    });
  });

  it("does not auto-revise when audit output parsing failed", async () => {
    const originalContent = "b".repeat(200);
    const auditEpisode = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 0,
      parseFailed: true,
      summary: "审稿输出解析失败",
      issues: [{
        severity: "critical",
        category: "系统错误",
        description: "审稿输出格式异常，无法解析为 JSON",
        suggestion: "检查模型输出格式",
      }],
    }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["should not run"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        episodeDurationSeconds: originalContent.length,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(reviseEpisode).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.revised).toBe(false);
    expect(result.auditResult.parseFailed).toBe(true);
  });

  it("does not auto-revise a passed audit merely because the provider omitted a usable score", async () => {
    const originalContent = "b".repeat(200);
    const auditEpisode = vi.fn().mockResolvedValue(createAuditResult({
      passed: true,
      overallScore: 0,
      issues: [{ severity: "info", category: "trace", description: "all commitments landed", suggestion: "none" }],
    }));
    const reviseEpisode = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn().mockImplementation(async (content: string) => ({
      content,
      episodeDurationSeconds: content.length,
      applied: false,
      tokenUsage: ZERO_USAGE,
    }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        episodeDurationSeconds: originalContent.length,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 2,
    });

    expect(reviseEpisode).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.auditResult.overallScore).toBe(100);
  });

  it("runs repair loop when score is below threshold, picks best version", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 76,
        issues: [{ severity: "warning", category: "pacing", description: "still slow", suggestion: "trim more" }],
      }));

    const reviseEpisode = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 2,
    });

    // Should have attempted 2 revisions:
    // iter 1: 70 → 80 (+10, net improvement)
    // iter 2: 80 → 76 (no net improvement, stop)
    expect(reviseEpisode).toHaveBeenCalledTimes(2);
    expect(reviseEpisode.mock.calls[0]?.[4]).toBe("auto");

    // Best version should be picked (score 80 from iter 1)
    expect(result.auditResult.overallScore).toBe(80);
    expect(result.finalContent).toBe("a".repeat(200));
    expect(result.revised).toBe(true);
  });

  it("does not let a higher-scoring hard-range failure displace an in-range draft", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "needs work", suggestion: "tighten" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        issues: [],
      }));

    const reviseEpisode = vi.fn().mockResolvedValueOnce({
      revisedContent: "x".repeat(80),
      episodeDurationSeconds: 80,
      fixedIssues: ["tightened"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(reviseEpisode).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe("c".repeat(200));
    expect(result.finalWordCount).toBe(200);
    expect(result.auditResult.overallScore).toBe(80);
  });

  it("defaults to two automatic repair passes", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 90,
      }));

    const reviseEpisode = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
    });

    expect(reviseEpisode).toHaveBeenCalledTimes(2);
    expect(result.auditResult.overallScore).toBe(90);
    expect(result.finalContent).toBe("b".repeat(200));
  });

  it("caps automatic repair passes before creating a second reviser", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
      }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["fixed continuity"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 2,
      maxRevisionCalls: 1,
    });

    expect(reviseEpisode).toHaveBeenCalledTimes(1);
    expect(auditEpisode).toHaveBeenCalledTimes(2);
    expect(result.reviewTelemetry).toMatchObject({
      terminationReason: "max-review-iterations",
      auditCalls: 2,
      revisionCalls: 1,
      configuredMaxRevisions: 1,
    });
  });

  it("continues when critical issues decrease without a score increase", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "warning", category: "pacing", description: "still slow", suggestion: "trim more" }],
      }));
    const reviseEpisode = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 2,
    });

    expect(reviseEpisode).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe("a".repeat(200));
    expect(result.auditResult.overallScore).toBe(70);
  });

  it("normalizes a revised draft before re-auditing it", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{
          severity: "warning",
          category: "pacing",
          description: "The middle repeats the same beat.",
          suggestion: "Tighten the repeated beat.",
        }],
      }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 90 }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "x".repeat(400),
      episodeDurationSeconds: 400,
      fixedIssues: ["fixed"],
      updatedState: "", updatedLedger: "", updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: "n".repeat(200),
      episodeDurationSeconds: 200,
      applied: true,
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(normalizeDraftLengthIfNeeded).toHaveBeenCalledWith("x".repeat(400));
    expect(auditEpisode.mock.calls[1]?.[0]).toBe("n".repeat(200));
    expect(result.finalContent).toBe("n".repeat(200));
    expect(result.normalizeApplied).toBe(true);
  });

  it("stops immediately when initial score passes threshold", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 88 }));
    const reviseEpisode = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "d".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
    });

    // No revision should have been called
    expect(reviseEpisode).not.toHaveBeenCalled();
    expect(result.auditResult.overallScore).toBe(88);
    expect(result.revised).toBe(false);
  });

  it("normalizes deterministic surface blockers before audit and repair", async () => {
    const auditEpisode = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 90, passed: true }));
    const reviseEpisode = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));
    const unsafe = `${"雨".repeat(100)}——${"夜".repeat(98)}`;

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: unsafe,
        episodeDurationSeconds: unsafe.length,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(
        auditEpisode,
        (content) => content.includes("——")
          ? [{ severity: "critical" as const, category: "禁止破折号", description: "出现了破折号", suggestion: "用逗号断句" }]
          : [],
      ),
      normalizeDraftLengthIfNeeded,
      normalizePostWriteSurface: (content) => content.replace(/——+/g, "，"),
    });

    expect(auditEpisode.mock.calls[0]?.[0]).not.toContain("——");
    expect(result.finalContent).not.toContain("——");
    expect(result.auditResult.passed).toBe(true);
    expect(reviseEpisode).not.toHaveBeenCalled();
  });

  it("does not call the reviser when a failed audit exposes no actionable issues", async () => {
    const auditEpisode = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 72,
      issues: [{
        severity: "info",
        category: "trace",
        description: "No repair target was identified.",
        suggestion: "None.",
      }],
    }));
    const reviseEpisode = vi.fn();

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "a".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
    });

    expect(reviseEpisode).not.toHaveBeenCalled();
    expect(result.reviewTelemetry).toEqual({
      terminationReason: "no-actionable-issues",
      auditCalls: 1,
      revisionCalls: 0,
      normalizationCalls: 0,
      reviewedCandidates: 1,
      configuredMaxRevisions: 2,
    });
  });

  it("skips duplicate audit when length normalization restores the current episode", async () => {
    const currentContent = "a".repeat(200);
    const issue: AuditIssue = {
      severity: "critical",
      category: "continuity",
      description: "Repair the evidence chain.",
      suggestion: "Add the missing action.",
    };
    const auditEpisode = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 70,
      issues: [issue],
    }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "x".repeat(400),
      episodeDurationSeconds: 400,
      fixedIssues: ["continuity"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockResolvedValue({
      content: currentContent,
      episodeDurationSeconds: currentContent.length,
      applied: true,
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: currentContent,
        episodeDurationSeconds: currentContent.length,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded,
    });

    expect(auditEpisode).toHaveBeenCalledTimes(1);
    expect(reviseEpisode).toHaveBeenCalledTimes(1);
    expect(normalizeDraftLengthIfNeeded).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe(currentContent);
    expect(result.reviewTelemetry).toMatchObject({
      terminationReason: "normalized-revision-unchanged",
      auditCalls: 1,
      revisionCalls: 1,
      normalizationCalls: 1,
      reviewedCandidates: 1,
    });
  });

  it("does not spend another revision on an unchanged issue set and a higher random score", async () => {
    const issue: AuditIssue = {
      severity: "warning",
      category: "pacing",
      description: "The middle repeats the same deduction.",
      suggestion: "Remove the duplicate deduction.",
    };
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 70, issues: [issue] }))
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 79, issues: [issue] }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "b".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["pacing"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "a".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 2,
    });

    expect(auditEpisode).toHaveBeenCalledTimes(2);
    expect(reviseEpisode).toHaveBeenCalledTimes(1);
    expect(result.reviewTelemetry).toMatchObject({
      terminationReason: "issue-set-unchanged",
      auditCalls: 2,
      revisionCalls: 1,
      reviewedCandidates: 2,
    });
  });

  it("detects a revision cycle before re-auditing an already reviewed version", async () => {
    const firstIssue: AuditIssue = {
      severity: "warning",
      category: "pacing",
      description: "First issue.",
      suggestion: "Fix first issue.",
    };
    const secondIssue: AuditIssue = {
      severity: "warning",
      category: "continuity",
      description: "Second issue.",
      suggestion: "Fix second issue.",
    };
    const initialContent = "a".repeat(200);
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 70, issues: [firstIssue] }))
      .mockResolvedValueOnce(createAuditResult({ passed: false, overallScore: 80, issues: [secondIssue] }));
    const reviseEpisode = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        episodeDurationSeconds: 200,
        fixedIssues: ["first"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: initialContent,
        episodeDurationSeconds: 200,
        fixedIssues: ["second"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: initialContent,
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 2,
    });

    expect(auditEpisode).toHaveBeenCalledTimes(2);
    expect(reviseEpisode).toHaveBeenCalledTimes(2);
    expect(result.finalContent).toBe("b".repeat(200));
    expect(result.reviewTelemetry).toMatchObject({
      terminationReason: "revision-cycle-detected",
      auditCalls: 2,
      revisionCalls: 2,
      reviewedCandidates: 2,
    });
  });

  it("uses issue-focused verification after an applied local patch", async () => {
    const issue: AuditIssue = {
      severity: "critical",
      category: "禁止句式",
      description: "出现了禁用句式",
      suggestion: "改用直述句",
      repairScope: "local",
    };
    const evaluateEpisode = vi.fn()
      .mockResolvedValueOnce(createEvaluation(async () => createAuditResult({
        passed: false,
        overallScore: 78,
        issues: [issue],
      }))("a".repeat(200)))
      .mockResolvedValueOnce(createEvaluation(async () => createAuditResult({
        passed: true,
        overallScore: 100,
        issues: [],
      }))("b".repeat(200)));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "b".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["禁止句式"],
      updatedState: "(状态卡未更新)",
      updatedLedger: "",
      updatedHooks: "(伏笔池未更新)",
      changeKind: "patch" as const,
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "a".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode,
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 1,
    });

    expect(evaluateEpisode).toHaveBeenCalledTimes(2);
    expect(evaluateEpisode.mock.calls[1]?.[1]).toEqual({
      temperature: 0,
      verificationIssues: [issue],
      revisionKind: "patch",
    });
    expect(result.reviewTelemetry.terminationReason).toBe("passed-after-revision");
  });

  it("routes full-rewrite revisions through the same regression verification (P0-4)", async () => {
    // The rewrite fallback carries no preservation guarantee, so it must face
    // the regression checklist verifier exactly like the deterministic patch
    // path — previously verificationIssues were only forwarded for patches.
    const issue: AuditIssue = {
      severity: "critical",
      category: "structure",
      description: "S2 的反转没有前置证据",
      suggestion: "在 S1 补一个可回指的证据镜头",
      repairScope: "structural",
    };
    const evaluateEpisode = vi.fn()
      .mockResolvedValueOnce(createEvaluation(async () => createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [issue],
      }))("a".repeat(200)))
      .mockResolvedValueOnce(createEvaluation(async () => createAuditResult({
        passed: true,
        overallScore: 100,
        issues: [],
      }))("b".repeat(200)));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "b".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["structure"],
      updatedState: "(状态卡未更新)",
      updatedLedger: "",
      updatedHooks: "(伏笔池未更新)",
      changeKind: "rewrite" as const,
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "a".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode,
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 1,
    });

    expect(evaluateEpisode).toHaveBeenCalledTimes(2);
    expect(evaluateEpisode.mock.calls[1]?.[1]).toEqual({
      temperature: 0,
      verificationIssues: [issue],
      revisionKind: "rewrite",
    });
    expect(result.reviewTelemetry.terminationReason).toBe("passed-after-revision");
  });

  it("stops at requires-upstream-revision when every blocking issue is planner/canon-owned", async () => {
    const upstreamCritical: AuditIssue = {
      severity: "critical",
      category: "hook-state-contradiction",
      description: "Hook H003 is resolved but its note says the payoff remains deferred.",
      suggestion: "Fix the hook ledger entry in the next memo.",
    };
    const auditEpisode = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 70,
      issues: [upstreamCritical],
    }));
    const reviseEpisode = vi.fn();

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "a".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
    });

    // The reviser must never receive planner-owned decisions: patching them in
    // the execution layer would violate the memo alignment contract.
    expect(reviseEpisode).not.toHaveBeenCalled();
    expect(result.reviewTelemetry.terminationReason).toBe("requires-upstream-revision");
    expect(result.reviewTelemetry.revisionCalls).toBe(0);
  });

  it("sends only writer-owned issues to the reviser when blocking issues are mixed", async () => {
    const writerCritical: AuditIssue = {
      severity: "critical",
      category: "continuity",
      description: "Repair the evidence chain.",
      suggestion: "Add the missing action.",
    };
    const plannerCritical: AuditIssue = {
      severity: "critical",
      category: "hook-state-contradiction",
      description: "Hook H007 deferral refreshed lastAdvancedEpisode.",
      suggestion: "Correct the hook ledger in the next memo.",
    };
    const auditEpisode = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [writerCritical, plannerCritical],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [plannerCritical],
      }));
    const reviseEpisode = vi.fn().mockResolvedValue({
      revisedContent: "b".repeat(200),
      episodeDurationSeconds: 200,
      fixedIssues: ["continuity"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runEpisodeReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "a".repeat(200),
        episodeDurationSeconds: 200,
        postWriteErrors: [],
        postWriteWarnings: [],
      },
      createReviser: () => ({ reviseEpisode }),
      evaluateEpisode: createEvaluation(auditEpisode),
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        episodeDurationSeconds: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 2,
    });

    expect(reviseEpisode).toHaveBeenCalledTimes(1);
    expect(reviseEpisode.mock.calls[0]?.[3]).toEqual([writerCritical]);
    // After the writer-owned issue is fixed, only the planner-owned critical
    // remains: the cycle must stop at requires-upstream-revision instead of
    // handing the planner's decision to the reviser.
    expect(result.reviewTelemetry.terminationReason).toBe("requires-upstream-revision");
  });
});
