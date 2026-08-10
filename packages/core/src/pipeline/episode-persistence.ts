import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { EpisodeMeta, EpisodeReviewTelemetry } from "../models/episode.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import type { EpisodeScriptMetrics } from "../models/episode-script.js";
import { buildStateDegradedReviewNote } from "./episode-state-recovery.js";
import { resolveEpisodeReviewStatus } from "./episode-review-quality-gate.js";
import { buildEpisodeRecoveryState } from "./episode-recovery-policy.js";

export interface EpisodePersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type EpisodePersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

export async function persistEpisodeArtifacts(params: {
  readonly episodeNumber: number;
  readonly episodeTitle: string;
  readonly episodeContent: string;
  readonly status: EpisodePersistenceStatus;
  readonly auditResult: AuditResult;
  readonly recoveryIssues: ReadonlyArray<AuditIssue>;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly episodeScriptMetrics?: EpisodeScriptMetrics;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly tokenUsage?: EpisodePersistenceUsage;
  readonly reviewTelemetry?: EpisodeReviewTelemetry;
  readonly operationId?: string;
  readonly loadEpisodeIndex: () => Promise<ReadonlyArray<EpisodeMeta>>;
  readonly saveEpisode: (options: { readonly persistTruth: boolean }) => Promise<void>;
  readonly saveTruthFiles: () => Promise<void>;
  readonly saveEpisodeIndex: (index: ReadonlyArray<EpisodeMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly now?: () => string;
}): Promise<{ readonly entry: EpisodeMeta }> {
  const advancesStoryState = params.status === "ready-for-review";
  await params.saveEpisode({ persistTruth: advancesStoryState });
  if (advancesStoryState) {
    await params.saveTruthFiles();
  }

  const existingIndex = await params.loadEpisodeIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const stateDegradedBaseStatus = params.status === "state-degraded"
    ? resolveEpisodeReviewStatus({
        auditResult: params.auditResult,
        hardLengthPassed: params.lengthWarnings.length === 0,
      }).status
    : undefined;
  const entry: EpisodeMeta = {
    episodeNumber: params.episodeNumber,
    title: params.episodeTitle,
    status: params.status,
    episodeDurationSeconds: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    auditIssues: params.auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    lengthWarnings: [...params.lengthWarnings],
    reviewNote: params.status === "state-degraded"
      ? buildStateDegradedReviewNote(
          stateDegradedBaseStatus === "audit-failed" ? "audit-failed" : "ready-for-review",
          params.degradedIssues,
        )
      : undefined,
    lengthTelemetry: params.lengthTelemetry,
    episodeScriptMetrics: params.episodeScriptMetrics,
    tokenUsage: params.tokenUsage,
    reviewTelemetry: params.reviewTelemetry,
    ...(params.operationId ? { operationId: params.operationId } : {}),
    recoveryState: buildEpisodeRecoveryState({
      content: params.episodeContent,
      issues: params.recoveryIssues,
      operationId: params.operationId,
      terminationReason: params.reviewTelemetry?.terminationReason,
      now: params.now,
    }),
  };
  const existingIdx = existingIndex.findIndex((e) => e.episodeNumber === params.episodeNumber);
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt } : e)
    : [...existingIndex, entry];
  await params.saveEpisodeIndex(updatedIndex);
  if (advancesStoryState) {
    await params.markBookActiveIfNeeded();
  }

  const driftIssues = params.auditResult.issues.filter(
    (issue) => issue.severity === "critical" || issue.severity === "warning",
  );
  await params.persistAuditDriftGuidance(params.status === "state-degraded" ? [] : driftIssues);

  if (advancesStoryState) {
    params.logSnapshotStage();
    await params.snapshotState();
    await params.syncCurrentStateFactHistory();
  }

  return { entry };
}
