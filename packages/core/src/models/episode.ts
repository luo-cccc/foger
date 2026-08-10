import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";
import { EpisodeScriptMetricsSchema } from "./episode-script.js";

export const EpisodeStatusSchema = z.enum([
  "card-generated",
  "drafting",
  "drafted",
  "auditing",
  "audit-passed",
  "audit-failed",
  "state-degraded",
  "revising",
  "ready-for-review",
  "approved",
  "rejected",
  "published",
  "imported",
]);
export type EpisodeStatus = z.infer<typeof EpisodeStatusSchema>;

export const EpisodeReviewTerminationReasonSchema = z.enum([
  "manual-mode",
  "initial-passed",
  "audit-parse-failed",
  "no-actionable-issues",
  "revision-unchanged",
  "normalized-revision-unchanged",
  "revision-cycle-detected",
  "passed-after-revision",
  "issue-set-unchanged",
  "no-material-progress",
  "max-review-iterations",
  "requires-upstream-revision",
]);
export type EpisodeReviewTerminationReason = z.infer<typeof EpisodeReviewTerminationReasonSchema>;

export const EpisodeReviewTelemetrySchema = z.object({
  terminationReason: EpisodeReviewTerminationReasonSchema,
  auditCalls: z.number().int().min(0),
  revisionCalls: z.number().int().min(0),
  normalizationCalls: z.number().int().min(0),
  reviewedCandidates: z.number().int().min(0),
  configuredMaxRevisions: z.number().int().min(0),
});
export type EpisodeReviewTelemetry = z.infer<typeof EpisodeReviewTelemetrySchema>;

export const EpisodeRecoveryIssueSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  category: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().default(""),
  repairScope: z.enum(["local", "structural", "unknown"]).optional(),
});
export type EpisodeRecoveryIssue = z.infer<typeof EpisodeRecoveryIssueSchema>;

export const EpisodeRecoveryStateSchema = z.object({
  version: z.literal(1),
  contentFingerprint: z.string().regex(/^[a-f0-9]{24}$/),
  blockingIssues: z.array(EpisodeRecoveryIssueSchema),
  sourceOperationId: z.string().uuid().optional(),
  terminationReason: z.string().optional(),
  updatedAt: z.string().datetime(),
});
export type EpisodeRecoveryState = z.infer<typeof EpisodeRecoveryStateSchema>;

export const EpisodeMetaSchema = z.object({
  episodeNumber: z.number().int().min(1),
  title: z.string(),
  status: EpisodeStatusSchema,
  episodeDurationSeconds: z.number().finite().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditIssues: z.array(z.string()).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  reviewNote: z.string().optional(),
  detectionScore: z.number().min(0).max(1).optional(),
  detectionProvider: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  episodeScriptMetrics: EpisodeScriptMetricsSchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
  reviewTelemetry: EpisodeReviewTelemetrySchema.optional(),
  operationId: z.string().uuid().optional(),
  recoveryState: EpisodeRecoveryStateSchema.optional(),
});

export type EpisodeMeta = z.infer<typeof EpisodeMetaSchema>;
