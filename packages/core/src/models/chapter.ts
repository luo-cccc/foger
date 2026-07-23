import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";

export const ChapterStatusSchema = z.enum([
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
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;

export const ChapterReviewTerminationReasonSchema = z.enum([
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
]);
export type ChapterReviewTerminationReason = z.infer<typeof ChapterReviewTerminationReasonSchema>;

export const ChapterReviewTelemetrySchema = z.object({
  terminationReason: ChapterReviewTerminationReasonSchema,
  auditCalls: z.number().int().min(0),
  revisionCalls: z.number().int().min(0),
  normalizationCalls: z.number().int().min(0),
  reviewedCandidates: z.number().int().min(0),
  configuredMaxRevisions: z.number().int().min(0),
});
export type ChapterReviewTelemetry = z.infer<typeof ChapterReviewTelemetrySchema>;

export const ChapterRecoveryIssueSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  category: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().default(""),
  repairScope: z.enum(["local", "structural", "unknown"]).optional(),
});
export type ChapterRecoveryIssue = z.infer<typeof ChapterRecoveryIssueSchema>;

export const ChapterRecoveryStateSchema = z.object({
  version: z.literal(1),
  contentFingerprint: z.string().regex(/^[a-f0-9]{24}$/),
  blockingIssues: z.array(ChapterRecoveryIssueSchema),
  sourceOperationId: z.string().uuid().optional(),
  terminationReason: z.string().optional(),
  updatedAt: z.string().datetime(),
});
export type ChapterRecoveryState = z.infer<typeof ChapterRecoveryStateSchema>;

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  status: ChapterStatusSchema,
  wordCount: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditIssues: z.array(z.string()).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  reviewNote: z.string().optional(),
  detectionScore: z.number().min(0).max(1).optional(),
  detectionProvider: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
  reviewTelemetry: ChapterReviewTelemetrySchema.optional(),
  operationId: z.string().uuid().optional(),
  recoveryState: ChapterRecoveryStateSchema.optional(),
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
