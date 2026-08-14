import { describe, expect, it, vi } from "vitest";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { EpisodeMeta } from "../models/episode.js";
import { persistEpisodeArtifacts } from "../pipeline/episode-persistence.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createIssue(overrides?: Partial<AuditIssue>): AuditIssue {
  return {
    severity: "warning",
    category: "continuity",
    description: "issue",
    suggestion: "fix",
    ...overrides,
  };
}

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    ...overrides,
  };
}

describe("persistEpisodeArtifacts", () => {
  it("persists truth files, index, drift guidance, and snapshots for reviewable episodes", async () => {
    const saveEpisode = vi.fn().mockResolvedValue(undefined);
    const saveTruthFiles = vi.fn().mockResolvedValue(undefined);
    const saveEpisodeIndex = vi.fn().mockResolvedValue(undefined);
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    await persistEpisodeArtifacts({
      episodeNumber: 3,
      episodeTitle: "Episode Title",
      episodeContent: "Reviewable episode content.",
      status: "ready-for-review",
      auditResult: createAuditResult({
        issues: [
          createIssue({ severity: "info", description: "ignore me" }),
          createIssue({ severity: "warning", description: "keep me" }),
          createIssue({ severity: "critical", description: "keep me too" }),
        ],
      }),
      recoveryIssues: [],
      finalWordCount: 888,
      lengthWarnings: ["warn"],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      reviewTelemetry: {
        terminationReason: "passed-after-revision",
        auditCalls: 2,
        revisionCalls: 1,
        normalizationCalls: 0,
        reviewedCandidates: 2,
        configuredMaxRevisions: 2,
      },
      operationId: "550e8400-e29b-41d4-a716-446655440000",
      loadEpisodeIndex: async () => [] satisfies ReadonlyArray<EpisodeMeta>,
      saveEpisode,
      saveTruthFiles,
      saveEpisodeIndex,
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
    });

    expect(saveEpisode).toHaveBeenCalledWith({ persistTruth: true });
    expect(saveTruthFiles).toHaveBeenCalledTimes(1);
    expect(saveEpisodeIndex).toHaveBeenCalledWith([
      expect.objectContaining({
        episodeNumber: 3,
        title: "Episode Title",
        status: "ready-for-review",
        episodeDurationSeconds: 888,
        auditIssues: [
          "[info] ignore me",
          "[warning] keep me",
          "[critical] keep me too",
        ],
        reviewNote: undefined,
        tokenUsage: ZERO_USAGE,
        reviewTelemetry: {
          terminationReason: "passed-after-revision",
          auditCalls: 2,
          revisionCalls: 1,
          normalizationCalls: 0,
          reviewedCandidates: 2,
          configuredMaxRevisions: 2,
        },
        operationId: "550e8400-e29b-41d4-a716-446655440000",
        recoveryState: expect.objectContaining({
          version: 1,
          blockingIssues: [],
          sourceOperationId: "550e8400-e29b-41d4-a716-446655440000",
        }),
      }),
    ]);
    expect(markBookActiveIfNeeded).toHaveBeenCalledTimes(1);
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([
      expect.objectContaining({ severity: "warning", description: "keep me" }),
      expect.objectContaining({ severity: "critical", description: "keep me too" }),
    ]);
    expect(logSnapshotStage).toHaveBeenCalledTimes(1);
    expect(snapshotState).toHaveBeenCalledTimes(1);
    expect(syncCurrentStateFactHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps audit-failed prose for review without advancing story truth or snapshots", async () => {
    const saveEpisode = vi.fn().mockResolvedValue(undefined);
    const saveTruthFiles = vi.fn().mockResolvedValue(undefined);
    const saveEpisodeIndex = vi.fn().mockResolvedValue(undefined);
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    await persistEpisodeArtifacts({
      episodeNumber: 2,
      episodeTitle: "Failed Episode",
      episodeContent: "Failed episode content.",
      status: "audit-failed",
      auditResult: createAuditResult({
        passed: false,
        issues: [createIssue({ severity: "critical", description: "blocking issue" })],
        summary: "failed",
      }),
      recoveryIssues: [createIssue({ severity: "critical", description: "blocking issue", repairScope: "structural" })],
      finalWordCount: 999,
      lengthWarnings: ["too long"],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadEpisodeIndex: async () => [] satisfies ReadonlyArray<EpisodeMeta>,
      saveEpisode,
      saveTruthFiles,
      saveEpisodeIndex,
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
    });

    expect(saveEpisode).toHaveBeenCalledWith({ persistTruth: false });
    expect(saveTruthFiles).not.toHaveBeenCalled();
    expect(saveEpisodeIndex).toHaveBeenCalledWith([
      expect.objectContaining({
        episodeNumber: 2,
        status: "audit-failed",
        auditIssues: ["[critical] blocking issue"],
        recoveryState: expect.objectContaining({
          blockingIssues: [expect.objectContaining({
            severity: "critical",
            description: "blocking issue",
            repairScope: "structural",
          })],
        }),
      }),
    ]);
    expect(markBookActiveIfNeeded).not.toHaveBeenCalled();
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([
      expect.objectContaining({ severity: "critical", description: "blocking issue" }),
    ]);
    expect(logSnapshotStage).not.toHaveBeenCalled();
    expect(snapshotState).not.toHaveBeenCalled();
    expect(syncCurrentStateFactHistory).not.toHaveBeenCalled();
  });

  it("stages manual-mode drafts without advancing truth or snapshots", async () => {
    const saveEpisode = vi.fn().mockResolvedValue(undefined);
    const saveTruthFiles = vi.fn().mockResolvedValue(undefined);
    const saveEpisodeIndex = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);

    await persistEpisodeArtifacts({
      episodeNumber: 1,
      episodeTitle: "Manual Draft",
      episodeContent: "Unaudited draft.",
      status: "drafted",
      auditResult: createAuditResult({ passed: false, issues: [], summary: "not reviewed" }),
      recoveryIssues: [],
      finalWordCount: 90,
      lengthWarnings: [],
      degradedIssues: [],
      loadEpisodeIndex: async () => [],
      saveEpisode,
      saveTruthFiles,
      saveEpisodeIndex,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance: vi.fn().mockResolvedValue(undefined),
      snapshotState,
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
    });

    expect(saveEpisode).toHaveBeenCalledWith({ persistTruth: false });
    expect(saveTruthFiles).not.toHaveBeenCalled();
    expect(snapshotState).not.toHaveBeenCalled();
    expect(saveEpisodeIndex).toHaveBeenCalledWith([
      expect.objectContaining({ status: "drafted" }),
    ]);
  });

  it("skips truth persistence and snapshots for state-degraded episodes while preserving review note", async () => {
    const saveEpisode = vi.fn().mockResolvedValue(undefined);
    const saveTruthFiles = vi.fn().mockResolvedValue(undefined);
    const saveEpisodeIndex = vi.fn().mockResolvedValue(undefined);
    const markBookActiveIfNeeded = vi.fn().mockResolvedValue(undefined);
    const persistAuditDriftGuidance = vi.fn().mockResolvedValue(undefined);
    const snapshotState = vi.fn().mockResolvedValue(undefined);
    const syncCurrentStateFactHistory = vi.fn().mockResolvedValue(undefined);
    const logSnapshotStage = vi.fn();

    await persistEpisodeArtifacts({
      episodeNumber: 4,
      episodeTitle: "Degraded Episode",
      episodeContent: "Degraded episode content.",
      status: "state-degraded",
      auditResult: createAuditResult({
        passed: false,
        issues: [createIssue({ description: "audit issue" })],
        summary: "needs review",
      }),
      recoveryIssues: [],
      finalWordCount: 512,
      lengthWarnings: [],
      degradedIssues: [createIssue({ description: "state mismatch" })],
      tokenUsage: ZERO_USAGE,
      loadEpisodeIndex: async () => [] satisfies ReadonlyArray<EpisodeMeta>,
      saveEpisode,
      saveTruthFiles,
      saveEpisodeIndex,
      markBookActiveIfNeeded,
      persistAuditDriftGuidance,
      snapshotState,
      syncCurrentStateFactHistory,
      logSnapshotStage,
      now: () => "2026-04-01T00:00:00.000Z",
    });

    expect(saveEpisode).toHaveBeenCalledWith({ persistTruth: false });
    expect(saveTruthFiles).not.toHaveBeenCalled();
    expect(saveEpisodeIndex).toHaveBeenCalledWith([
      expect.objectContaining({
        episodeNumber: 4,
        title: "Degraded Episode",
        status: "state-degraded",
        reviewNote: expect.any(String),
      }),
    ]);
    const reviewNote = saveEpisodeIndex.mock.calls[0]?.[0]?.[0]?.reviewNote as string;
    expect(JSON.parse(reviewNote)).toMatchObject({
      kind: "state-degraded",
      baseStatus: "ready-for-review",
      injectedIssues: ["[warning] state mismatch"],
    });
    expect(persistAuditDriftGuidance).toHaveBeenCalledWith([]);
    expect(markBookActiveIfNeeded).not.toHaveBeenCalled();
    expect(logSnapshotStage).not.toHaveBeenCalled();
    expect(snapshotState).not.toHaveBeenCalled();
    expect(syncCurrentStateFactHistory).not.toHaveBeenCalled();
  });

  it("replaces existing entry for the same episode number instead of appending", async () => {
    const saveEpisodeIndex = vi.fn().mockResolvedValue(undefined);
    const existingEntry: EpisodeMeta = {
      episodeNumber: 1,
      title: "Old Title",
      status: "drafted",
      episodeDurationSeconds: 500,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    };

    await persistEpisodeArtifacts({
      episodeNumber: 1,
      episodeTitle: "New Title",
      episodeContent: "Replacement episode content.",
      status: "ready-for-review",
      auditResult: createAuditResult(),
      recoveryIssues: [],
      finalWordCount: 2000,
      lengthWarnings: [],
      degradedIssues: [],
      tokenUsage: ZERO_USAGE,
      loadEpisodeIndex: async () => [existingEntry],
      saveEpisode: vi.fn().mockResolvedValue(undefined),
      saveTruthFiles: vi.fn().mockResolvedValue(undefined),
      saveEpisodeIndex,
      markBookActiveIfNeeded: vi.fn().mockResolvedValue(undefined),
      persistAuditDriftGuidance: vi.fn().mockResolvedValue(undefined),
      snapshotState: vi.fn().mockResolvedValue(undefined),
      syncCurrentStateFactHistory: vi.fn().mockResolvedValue(undefined),
      logSnapshotStage: vi.fn(),
      now: () => "2026-04-01T00:00:00.000Z",
    });

    const savedIndex = saveEpisodeIndex.mock.calls[0][0] as EpisodeMeta[];
    // Must have exactly 1 entry, not 2
    expect(savedIndex).toHaveLength(1);
    expect(savedIndex[0].episodeNumber).toBe(1);
    expect(savedIndex[0].title).toBe("New Title");
    expect(savedIndex[0].episodeDurationSeconds).toBe(2000);
    expect(savedIndex[0].status).toBe("ready-for-review");
    // Must preserve original createdAt
    expect(savedIndex[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(savedIndex[0].updatedAt).toBe("2026-04-01T00:00:00.000Z");
  });
});
