import { z } from "zod";
import { CronPattern } from "croner";
import { CONTENT_POLICY_FALLBACK_AGENTS } from "../llm/agent-model-routing.js";

// C1 (v2.0.0 breaking): `maxTokens` 字段已被 providers bank 接管；zod 用 strip mode 静默丢弃老配置里的 `maxTokens`。
const LLMServiceEntrySchema = z.object({
  service: z.string().min(1),
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).optional(),
  apiFormat: z.enum(["chat", "responses"]).optional(),
  stream: z.boolean().optional(),
});

// C1 (v2.0.0 breaking): 删除 maxTokens / maxTokensCap 字段。
// 每个模型的真实 maxOutput 来自 providers/<name>.ts 的 InkosModel.maxOutput；
// 老配置里写的 maxTokens / maxTokensCap 会被 zod strip 静默丢弃（不报错）。
export const LLMConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "custom"]),
  service: z.string().default("custom"),
  configSource: z.enum(["env", "studio"]).default("env"),
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  proxyUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  thinkingBudget: z.number().int().min(0).default(0),
  extra: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  apiFormat: z.enum(["chat", "responses"]).default("chat"),
  stream: z.boolean().default(true),
  services: z.array(LLMServiceEntrySchema).optional(),
  defaultModel: z.string().min(1).optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const NotifyChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("telegram"),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
  z.object({
    type: z.literal("wechat-work"),
    webhookUrl: z.string().url(),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
  z.object({
    type: z.literal("feishu"),
    webhookUrl: z.string().url(),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url(),
    secret: z.string().optional(),
    events: z.array(z.string()).default([]),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
]);

export type NotifyChannel = z.infer<typeof NotifyChannelSchema>;

export const DetectionConfigSchema = z.object({
  provider: z.enum(["gptzero", "originality", "custom"]).default("custom"),
  apiUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  threshold: z.number().min(0).max(1).default(0.5),
  enabled: z.boolean().default(false),
  autoRewrite: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
});

export type DetectionConfig = z.infer<typeof DetectionConfigSchema>;

export const QualityGatesSchema = z.object({
  maxAuditRetries: z.number().int().min(0).max(10).default(2),
  pauseAfterConsecutiveFailures: z.number().int().min(1).default(3),
  retryTemperatureStep: z.number().min(0).max(0.5).default(0.1),
  maxChapterTokens: z.number().int().min(1).default(100_000),
  maxPromptTokensPerCall: z.number().int().min(1).default(16_000),
  maxRetryRate: z.number().min(0).max(1).default(0.2),
  maxTimeoutRate: z.number().min(0).max(1).default(0),
  maxFallbacksPerChapter: z.number().int().min(0).default(0),
  minHardRangeRate: z.number().min(0).max(1).default(0.8),
});

export type QualityGates = z.infer<typeof QualityGatesSchema>;

export const FoundationConfigSchema = z.object({
  reviewRetries: z.number().int().min(0).max(10).default(2),
});

export type FoundationConfig = z.infer<typeof FoundationConfigSchema>;

export const WritingConfigSchema = z.object({
  reviewRetries: z.number().int().min(0).max(10).default(2),
  reviewMode: z.enum(["auto", "manual"]).default("auto"),
  revisionGate: z.enum(["strict", "lenient", "always"]).default("strict"),
});

export type WritingConfig = z.infer<typeof WritingConfigSchema>;

export const AgentLLMOverrideSchema = z.object({
  model: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "custom"]).optional(),
  service: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  apiFormat: z.enum(["chat", "responses"]).optional(),
  stream: z.boolean().optional(),
});

export type AgentLLMOverride = z.infer<typeof AgentLLMOverrideSchema>;

export const ContentPolicyFallbackConfigSchema = AgentLLMOverrideSchema.extend({
  service: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "apiKeyEnv must be an environment variable name"),
  agents: z.array(z.enum(CONTENT_POLICY_FALLBACK_AGENTS)).min(1)
    .default([...CONTENT_POLICY_FALLBACK_AGENTS]),
});

export type ContentPolicyFallbackConfig = z.infer<typeof ContentPolicyFallbackConfigSchema>;

export const InputGovernanceModeSchema = z.enum(["legacy", "v2"]);
export type InputGovernanceMode = z.infer<typeof InputGovernanceModeSchema>;

const ModelOverrideValueSchema = z.union([z.string(), AgentLLMOverrideSchema]);

const CronExpressionSchema = z.string().trim().min(1).refine((value) => {
  try {
    new CronPattern(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid cron expression");

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  version: z.literal("0.1.0"),
  language: z.enum(["zh", "en"]).default("zh"),
  llm: LLMConfigSchema,
  notify: z.array(NotifyChannelSchema).default([]),
  detection: DetectionConfigSchema.optional(),
  foundation: FoundationConfigSchema.default({
    reviewRetries: 2,
  }),
  writing: WritingConfigSchema.default({
    reviewRetries: 2,
  }),
  modelOverrides: z.record(z.string(), ModelOverrideValueSchema).optional(),
  /** Explicit one-shot cross-provider route for provider content-policy rejections. */
  contentPolicyFallback: ContentPolicyFallbackConfigSchema.optional(),
  inputGovernanceMode: InputGovernanceModeSchema.default("v2"),
  daemon: z.object({
    schedule: z.object({
      writeCron: CronExpressionSchema.default("*/15 * * * *"),
    }),
    maxConcurrentBooks: z.number().int().min(1).default(3),
    chaptersPerCycle: z.number().int().min(1).max(20).default(1),
    retryDelayMs: z.number().int().min(0).default(30_000),
    cooldownAfterChapterMs: z.number().int().min(0).default(10_000),
    maxChaptersPerDay: z.number().int().min(1).default(50),
    qualityGates: QualityGatesSchema.default({
      maxAuditRetries: 2,
      pauseAfterConsecutiveFailures: 3,
      retryTemperatureStep: 0.1,
      maxChapterTokens: 100_000,
      maxPromptTokensPerCall: 16_000,
      maxRetryRate: 0.2,
      maxTimeoutRate: 0,
      maxFallbacksPerChapter: 0,
      minHardRangeRate: 0.8,
    }),
  }).default({
    schedule: {
      writeCron: "*/15 * * * *",
    },
    maxConcurrentBooks: 3,
    chaptersPerCycle: 1,
    retryDelayMs: 30_000,
    cooldownAfterChapterMs: 10_000,
    maxChaptersPerDay: 50,
    qualityGates: {
      maxAuditRetries: 2,
      pauseAfterConsecutiveFailures: 3,
      retryTemperatureStep: 0.1,
      maxChapterTokens: 100_000,
      maxPromptTokensPerCall: 16_000,
      maxRetryRate: 0.2,
      maxTimeoutRate: 0,
      maxFallbacksPerChapter: 0,
      minHardRangeRate: 0.8,
    },
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
