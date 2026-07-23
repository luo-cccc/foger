import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ChapterMeta, ChapterReviewTelemetry } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import { buildStateDegradedReviewNote } from "./chapter-state-recovery.js";
import { resolveChapterReviewStatus } from "./chapter-quality-gate.js";
import { buildChapterRecoveryState } from "./chapter-recovery-policy.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChapterPersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly chapterContent: string;
  readonly status: ChapterPersistenceStatus;
  readonly auditResult: AuditResult;
  readonly recoveryIssues: ReadonlyArray<AuditIssue>;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly reviewTelemetry?: ChapterReviewTelemetry;
  readonly operationId?: string;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapter: (options: { readonly persistTruth: boolean }) => Promise<void>;
  readonly saveTruthFiles: () => Promise<void>;
  readonly saveChapterIndex: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta }> {
  const advancesStoryState = params.status === "ready-for-review";
  await params.saveChapter({ persistTruth: advancesStoryState });
  if (advancesStoryState) {
    await params.saveTruthFiles();
  }

  const existingIndex = await params.loadChapterIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const stateDegradedBaseStatus = params.status === "state-degraded"
    ? resolveChapterReviewStatus({
        auditResult: params.auditResult,
        hardLengthPassed: params.lengthWarnings.length === 0,
      }).status
    : undefined;
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    status: params.status,
    wordCount: params.finalWordCount,
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
    tokenUsage: params.tokenUsage,
    reviewTelemetry: params.reviewTelemetry,
    ...(params.operationId ? { operationId: params.operationId } : {}),
    recoveryState: buildChapterRecoveryState({
      content: params.chapterContent,
      issues: params.recoveryIssues,
      operationId: params.operationId,
      terminationReason: params.reviewTelemetry?.terminationReason,
      now: params.now,
    }),
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt } : e)
    : [...existingIndex, entry];
  await params.saveChapterIndex(updatedIndex);
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
