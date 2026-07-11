import { z } from "zod";

export const VolumeKeyResultSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["pending", "attempted", "advanced", "done"]).default("pending"),
});

export type VolumeKeyResult = z.infer<typeof VolumeKeyResultSchema>;

export const VolumeContractSchema = z.object({
  volumeId: z.string().min(1),
  volumeNumber: z.number().int().min(1),
  title: z.string().min(1),
  chapterStart: z.number().int().min(1).optional(),
  chapterEnd: z.number().int().min(1).optional(),
  objective: z.string().min(1),
  keyResults: z.array(VolumeKeyResultSchema).min(1),
  irreversibleEvent: z.string().min(1),
  protagonistStageGoal: z.string().optional(),
  worldRuleReleases: z.array(z.string()).default([]),
  relationshipTensions: z.array(z.string()).default([]),
  foregroundGoal: z.string().optional(),
  backgroundThread: z.string().optional(),
  hookDebts: z.array(z.string()).default([]),
  source: z.string().min(1),
});

export type VolumeContract = z.infer<typeof VolumeContractSchema>;

export const VolumeContractFileSchema = z.object({
  version: z.literal(1),
  source: z.string().min(1),
  generatedAt: z.string().min(1),
  contracts: z.array(VolumeContractSchema).default([]),
});

export type VolumeContractFile = z.infer<typeof VolumeContractFileSchema>;

export const VolumeProgressEntrySchema = z.object({
  chapter: z.number().int().min(1),
  volumeId: z.string().min(1),
  volumeNumber: z.number().int().min(1),
  krRefs: z.array(z.string()).default([]),
  visibleKrRefs: z.array(z.string()).default([]),
  attemptedKrRefs: z.array(z.string()).default([]),
  rationale: z.string().default(""),
  memoGoal: z.string().default(""),
  recordedAt: z.string().min(1),
});

export type VolumeProgressEntry = z.infer<typeof VolumeProgressEntrySchema>;

export const VolumeProgressFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().min(1),
  entries: z.array(VolumeProgressEntrySchema).default([]),
});

export type VolumeProgressFile = z.infer<typeof VolumeProgressFileSchema>;

export const VolumeGateIssueSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  category: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().optional(),
  repairScope: z.string().optional(),
});

export type VolumeGateIssue = z.infer<typeof VolumeGateIssueSchema>;
