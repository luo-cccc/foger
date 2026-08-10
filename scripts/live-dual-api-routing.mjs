import { mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BookConfigSchema,
  PipelineRunner,
  Scheduler,
  StateManager,
  UnattendedStateStore,
  chatCompletion,
  createLLMClient,
  deriveBookIdFromTitle,
  loadProjectConfig,
  buildLLMTokenBudgetReport,
  summarizeLLMCallTelemetry,
} from "../packages/core/dist/index.js";

// ── CLI ────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    chapters:     { type: "string", default: "5" },
    words:        { type: "string", default: "1000" },
    "route-mode": { type: "string", default: "openrouter-only" },
    "review-mode": { type: "string", default: "manual" },
    "review-retries": { type: "string", default: "2" },
    "foundation-review-retries": { type: "string", default: "1" },
    "foundation-only": { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "300000" },
    "output":     { type: "string", default: ".tmp-dual-api-routing/reports" },
    "project-dir":{ type: "string", default: ".tmp-dual-api-routing" },
    "recovery-mode": { type: "string", default: "repair-then-resync" },
    "max-retry-rate": { type: "string", default: "0.2" },
    "max-timeout-rate": { type: "string", default: "0" },
    "max-fallbacks": { type: "string", default: "0" },
    "min-hard-range-rate": { type: "string", default: "0.8" },
    "max-total-tokens": { type: "string", default: "0" },
    "max-chapter-tokens": { type: "string", default: "0" },
    "max-prompt-tokens-per-call": { type: "string", default: "0" },
    "max-agent-tokens": { type: "string", default: "" },
    "max-phase-tokens": { type: "string", default: "" },
    "max-audit-calls": { type: "string", default: "0" },
    "max-revision-calls": { type: "string", default: "0" },
    "max-normalize-calls": { type: "string", default: "0" },
    "max-settle-calls": { type: "string", default: "0" },
  },
});

const CHAPTER_COUNT = Math.max(1, Number(args.chapters) || 5);
const WORDS_PER_CHAPTER = Math.max(1000, Number(args.words) || 1000);
const ROUTE_MODE = args["route-mode"];
const ROUTE_MODES = new Set(["single-provider", "openrouter-only", "minimax-writer", "minimax-governance"]);
if (!ROUTE_MODES.has(ROUTE_MODE)) {
  throw new Error(`Invalid --route-mode: ${ROUTE_MODE}`);
}
const REVIEW_MODE = args["review-mode"];
const REVIEW_RETRIES = REVIEW_MODE === "auto"
  ? Math.max(0, Math.floor(Number(args["review-retries"]) || 0))
  : 0;
const FOUNDATION_REVIEW_RETRIES = Math.max(
  0,
  Math.floor(Number(args["foundation-review-retries"]) || 0),
);
const FOUNDATION_ONLY = args["foundation-only"];
const TIMEOUT_MS = Math.max(5000, Number(args["timeout-ms"]) || 300000);
const RECOVERY_MODE = args["recovery-mode"];
const RECOVERY_MODES = new Set(["none", "repair", "resync", "repair-then-resync"]);
if (!RECOVERY_MODES.has(RECOVERY_MODE)) {
  throw new Error(`Invalid --recovery-mode: ${RECOVERY_MODE}`);
}
if (REVIEW_MODE !== "manual" && REVIEW_MODE !== "auto") {
  throw new Error(`Invalid --review-mode: ${REVIEW_MODE}`);
}

function boundedRateArg(name, fallback) {
  const value = Number(args[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

const MAX_RETRY_RATE = boundedRateArg("max-retry-rate", 0.2);
const MAX_TIMEOUT_RATE = boundedRateArg("max-timeout-rate", 0);
const MIN_HARD_RANGE_RATE = boundedRateArg("min-hard-range-rate", 0.8);
const MAX_FALLBACKS = Math.max(0, Number(args["max-fallbacks"]) || 0);

function optionalPositiveLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBudgetMap(value, optionName) {
  if (!value || !String(value).trim()) return {};
  const result = {};
  for (const part of String(value).split(",")) {
    const [key, rawLimit] = part.split("=").map((item) => item.trim());
    const limit = optionalPositiveLimit(rawLimit);
    if (!key || limit === undefined) {
      throw new Error(`Invalid --${optionName} entry: ${part}`);
    }
    result[key] = limit;
  }
  return result;
}

const MAX_TOTAL_TOKENS = optionalPositiveLimit(args["max-total-tokens"]);
const MAX_CHAPTER_TOKENS = optionalPositiveLimit(args["max-chapter-tokens"]);
const MAX_PROMPT_TOKENS_PER_CALL = optionalPositiveLimit(args["max-prompt-tokens-per-call"]);
const MAX_AGENT_TOKENS = parseBudgetMap(args["max-agent-tokens"], "max-agent-tokens");
const MAX_PHASE_TOKENS = parseBudgetMap(args["max-phase-tokens"], "max-phase-tokens");
const MAX_AUDIT_CALLS = optionalPositiveLimit(args["max-audit-calls"]);
const MAX_REVISION_CALLS = optionalPositiveLimit(args["max-revision-calls"]);
const MAX_NORMALIZE_CALLS = optionalPositiveLimit(args["max-normalize-calls"]);
const MAX_SETTLE_CALLS = optionalPositiveLimit(args["max-settle-calls"]);
const TOKEN_BUDGET_LIMITS = {
  ...(MAX_TOTAL_TOKENS !== undefined ? { maxTotalTokens: MAX_TOTAL_TOKENS } : {}),
  ...(MAX_PROMPT_TOKENS_PER_CALL !== undefined
    ? { maxPromptEstimatedTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL }
    : {}),
  ...(Object.keys(MAX_AGENT_TOKENS).length > 0 ? { maxAgentTokens: MAX_AGENT_TOKENS } : {}),
  ...(Object.keys(MAX_PHASE_TOKENS).length > 0 ? { maxPhaseTokens: MAX_PHASE_TOKENS } : {}),
};
const GOVERNANCE_CALL_LIMITS = {
  ...(MAX_AUDIT_CALLS !== undefined ? { audit: MAX_AUDIT_CALLS } : {}),
  ...(MAX_REVISION_CALLS !== undefined ? { revision: MAX_REVISION_CALLS } : {}),
  ...(MAX_NORMALIZE_CALLS !== undefined ? { lengthNormalization: MAX_NORMALIZE_CALLS } : {}),
  ...(MAX_SETTLE_CALLS !== undefined ? { settlement: MAX_SETTLE_CALLS } : {}),
};
const PIPELINE_GOVERNANCE_CALL_LIMITS = {
  ...(MAX_REVISION_CALLS !== undefined
    ? { maxRevisionCallsPerChapter: MAX_REVISION_CALLS }
    : {}),
  ...(MAX_SETTLE_CALLS !== undefined
    ? { maxSettlementCallsPerChapter: MAX_SETTLE_CALLS }
    : {}),
};

const repoRoot = resolve(import.meta.dirname, "..");
const projectRoot = join(repoRoot, args["project-dir"]);
const reportDir = join(projectRoot, "reports");
const secretsPath = join(projectRoot, ".inkos", "secrets.json");

let signalCleanupStarted = false;
async function removeEphemeralSecret() {
  await rm(secretsPath, { force: true }).catch(() => undefined);
}

function handleTerminationSignal(signal) {
  if (signalCleanupStarted) return;
  signalCleanupStarted = true;
  void removeEphemeralSecret().finally(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

const onSigint = () => handleTerminationSignal("SIGINT");
const onSigterm = () => handleTerminationSignal("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

// ── Config ──────────────────────────────────────────────────────────────────

const openrouterServiceId = "custom:OpenRouterLive";
const openrouterModel = "deepseek/deepseek-v4-flash";
const minimaxModel = "MiniMax-M3";
const minimaxBaseUrl = "https://api.minimaxi.com/v1";

const openrouterKey = process.env.OPENROUTER_API_KEY;
const minimaxKey = process.env.MINIMAX_API_KEY;
const singleProvider = ROUTE_MODE === "single-provider";
const primaryServiceId = singleProvider ? process.env.INKOS_LLM_SERVICE || "custom" : openrouterServiceId;
const primaryModel = singleProvider ? process.env.INKOS_LLM_MODEL : openrouterModel;
const primaryBaseUrl = singleProvider ? process.env.INKOS_LLM_BASE_URL : "https://openrouter.ai/api/v1";
const primaryProvider = singleProvider ? process.env.INKOS_LLM_PROVIDER || "openai" : "openai";
const primaryApiFormat = singleProvider ? process.env.INKOS_LLM_API_FORMAT || "chat" : "chat";
const primaryLabel = singleProvider ? process.env.INKOS_LIVE_PROVIDER_LABEL || primaryServiceId : "OpenRouter";
const primaryKey = singleProvider ? process.env.INKOS_LLM_API_KEY : openrouterKey;
if (!primaryKey) {
  throw new Error(singleProvider ? "INKOS_LLM_API_KEY is required" : "OPENROUTER_API_KEY is required");
}
if (!primaryModel) throw new Error("INKOS_LLM_MODEL is required for single-provider mode");
if (!primaryBaseUrl) throw new Error("INKOS_LLM_BASE_URL is required for single-provider mode");
if (ROUTE_MODE !== "openrouter-only" && !minimaxKey) {
  if (!singleProvider) throw new Error("MINIMAX_API_KEY is required for MiniMax route modes");
}

const minimaxOverride = {
  model: minimaxModel,
  provider: "openai",
  service: "minimax",
  baseUrl: minimaxBaseUrl,
  apiKeyEnv: "MINIMAX_API_KEY",
  apiFormat: "chat",
  stream: false,
};

const minimaxGovernanceAgents = [
  "architect", "foundation-reviewer", "planner", "composer",
  "auditor", "reviser", "state-validator", "canon-extractor",
  "claim-validator", "volume-auditor", "length-normalizer",
];

const minimaxWriterAgents = ["writer", "reviser", "length-normalizer"];

function routedAgents() {
  if (ROUTE_MODE === "single-provider" || ROUTE_MODE === "openrouter-only") return [];
  return ROUTE_MODE === "minimax-writer" ? minimaxWriterAgents : minimaxGovernanceAgents;
}

function buildConfig() {
  return {
    name: "dual-api-routing-live-test",
    version: "0.1.0",
    language: "zh",
    llm: {
      provider: primaryProvider,
      service: primaryServiceId,
      // Custom plan gateways use the native OpenAI-compatible transport so
      // provider-specific reasoning blocks cannot hide the final text output.
      configSource: "studio",
      baseUrl: primaryBaseUrl,
      apiKey: "",
      model: primaryModel,
      defaultModel: primaryModel,
      apiFormat: primaryApiFormat,
      stream: false,
      temperature: 0.7,
      ...(singleProvider ? {} : {
        services: [
          { service: "custom", name: "OpenRouterLive", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "chat", stream: false, temperature: 0.7 },
          { service: "minimax", baseUrl: minimaxBaseUrl, apiFormat: "chat", stream: false, temperature: 0.9 },
        ],
      }),
    },
    foundation: { reviewRetries: FOUNDATION_REVIEW_RETRIES },
    writing: { reviewRetries: REVIEW_RETRIES, reviewMode: REVIEW_MODE, revisionGate: "always" },
    notify: [],
    inputGovernanceMode: "v2",
    modelOverrides: Object.fromEntries(routedAgents().map((agent) => [agent, minimaxOverride])),
  };
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/** @type {import("../packages/core/dist/index.js").LLMCallTelemetry[]} */
const allTelemetry = [];
/** @type {import("../packages/core/dist/index.js").PipelineDiagnostic[]} */
const allDiagnostics = [];

function makePipelineConfig(config, root, logFile) {
  const makeLogger = (tag) => ({
    child: (childTag) => makeLogger(`${tag}:${childTag}`),
    info: (message) => logFile.write(JSON.stringify({ level: "info", tag, message: String(message) }) + "\n"),
    warn: (message) => logFile.write(JSON.stringify({ level: "warn", tag, message: String(message) }) + "\n"),
    error: (message) => logFile.write(JSON.stringify({ level: "error", tag, message: String(message) }) + "\n"),
    debug: (message) => logFile.write(JSON.stringify({ level: "debug", tag, message: String(message) }) + "\n"),
  });

  return {
    client: createLLMClient(config.llm),
    model: config.llm.model,
    projectRoot: root,
    defaultLLMConfig: config.llm,
    foundationReviewRetries: config.foundation.reviewRetries,
    writingReviewRetries: config.writing.reviewRetries,
    governanceCallLimits: PIPELINE_GOVERNANCE_CALL_LIMITS,
    chapterReviewMode: config.writing.reviewMode,
    revisionGate: config.writing.revisionGate,
    modelOverrides: config.modelOverrides,
    inputGovernanceMode: config.inputGovernanceMode,
    notifyChannels: config.notify,
    externalContext: [
      "这是一次双 API 连载稳定性测试。",
      "题材：近未来旧城悬疑成长，主角林澈是夜班档案修复员。",
      "核心钩子：一盘编号被涂改的磁带里出现母亲年轻时的声音。",
      "写法要求：第三人称有限视角，具体行动推进，不做作者总结，不用设定讲解替代场景。",
      "连载目标：每章都要推进调查动作，并保留至少一个可追踪伏笔。",
    ].join("\n"),
    logger: makeLogger("inkos"),
    onCallTelemetry: (t) => allTelemetry.push(t),
    onPipelineDiagnostic: (diagnostic) => allDiagnostics.push(diagnostic),
    defaultTimeoutMs: TIMEOUT_MS,
    ...(MAX_PROMPT_TOKENS_PER_CALL !== undefined
      ? { maxPromptEstimatedTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL }
      : {}),
  };
}

// ── Health Utilities ─────────────────────────────────────────────────────────

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function fileHealth(path) {
  try {
    const text = await readFile(path, "utf-8");
    return {
      exists: true,
      bytes: Buffer.byteLength(text, "utf-8"),
      chars: text.length,
      placeholder: text.includes("(状态卡未更新)") || text.includes("(伏笔池未更新)"),
      empty: text.trim().length === 0,
    };
  } catch {
    return { exists: false, bytes: 0, chars: 0, placeholder: false, empty: true };
  }
}

async function jsonHealth(path) {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    const serialized = JSON.stringify(parsed);
    return {
      exists: true,
      bytes: Buffer.byteLength(raw, "utf-8"),
      topLevelKeys: parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0,
      serializedChars: serialized.length,
    };
  } catch (error) {
    return { exists: false, error: String(error) };
  }
}

async function listDirs(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function summarizeDiagnostics(records) {
  const byKind = {};
  for (const diagnostic of records) {
    byKind[diagnostic.kind] = (byKind[diagnostic.kind] ?? 0) + 1;
  }
  return {
    total: records.length,
    fallbackCount: records.filter((diagnostic) => diagnostic.kind.endsWith("fallback")).length,
    byKind,
  };
}

function buildLengthReport(lengthTelemetry, warnings = []) {
  if (!lengthTelemetry) return null;
  const deviation = lengthTelemetry.finalCount - lengthTelemetry.target;
  return {
    ...lengthTelemetry,
    deviation,
    deviationPercent: Number(((deviation / lengthTelemetry.target) * 100).toFixed(2)),
    absoluteDeviationPercent: Number((Math.abs(deviation / lengthTelemetry.target) * 100).toFixed(2)),
    withinSoftRange: lengthTelemetry.finalCount >= lengthTelemetry.softMin
      && lengthTelemetry.finalCount <= lengthTelemetry.softMax,
    withinHardRange: lengthTelemetry.finalCount >= lengthTelemetry.hardMin
      && lengthTelemetry.finalCount <= lengthTelemetry.hardMax,
    warningCount: warnings.length,
  };
}

function summarizeChapterLengths(chapters) {
  const lengths = chapters.map((chapter) => chapter.length).filter(Boolean);
  const withinSoftRange = lengths.filter((length) => length.withinSoftRange).length;
  const withinHardRange = lengths.filter((length) => length.withinHardRange).length;
  return {
    chapters: lengths.length,
    withinSoftRange,
    withinHardRange,
    softRangeRate: lengths.length === 0 ? null : withinSoftRange / lengths.length,
    hardRangeRate: lengths.length === 0 ? null : withinHardRange / lengths.length,
    normalizedChapters: lengths.filter((length) => length.normalizeApplied).length,
    warningCount: lengths.reduce((sum, length) => sum + length.warningCount, 0),
    averageAbsoluteDeviationPercent: lengths.length === 0
      ? null
      : Number((lengths.reduce((sum, length) => sum + length.absoluteDeviationPercent, 0) / lengths.length).toFixed(2)),
  };
}

function countGovernanceCalls(records) {
  const countPhase = (phase) => records.filter((record) => record.phase === phase).length;
  return {
    audit: countPhase("audit"),
    revision: countPhase("revise"),
    lengthNormalization: countPhase("normalize-length"),
    settlement: countPhase("settle"),
    settlementObservation: countPhase("settle-observe"),
    stateValidation: countPhase("validate-state"),
    chapterAnalysis: countPhase("analyze"),
  };
}

function buildGovernanceCallGate(chapters) {
  const violations = [];
  for (const chapter of chapters) {
    for (const [phase, maximum] of Object.entries(GOVERNANCE_CALL_LIMITS)) {
      const actual = chapter.governanceCalls?.[phase] ?? 0;
      if (actual > maximum) {
        violations.push({ chapter: chapter.chapterNumber, phase, actual, maximum });
      }
    }
  }
  return { limits: GOVERNANCE_CALL_LIMITS, violations, passed: violations.length === 0 };
}

function buildQualityGate(report) {
  const telemetry = report.telemetrySummary;
  const retryRate = telemetry.calls === 0 ? 0 : telemetry.retries / telemetry.calls;
  const timeoutRate = telemetry.calls === 0 ? 0 : telemetry.statuses.timeout / telemetry.calls;
  const hardRangeRate = report.lengthSummary.hardRangeRate;
  const fallbackCount = report.diagnosticSummary.fallbackCount;
  const completedChapterCount = report.chapters.length;
  const auditFailed = report.chapters.filter((chapter) => chapter.status === "audit-failed").length;
  const unrecoveredStateDegraded = report.chapters.filter((chapter) => chapter.status === "state-degraded").length;
  const chapterBudgetFailures = report.chapters.filter((chapter) => chapter.tokenBudget && !chapter.tokenBudget.passed).length;
  const governanceCalls = buildGovernanceCallGate(report.chapters);
  const checks = {
    retryRate: {
      actual: retryRate,
      maximum: MAX_RETRY_RATE,
      enforced: !FOUNDATION_ONLY,
      passed: FOUNDATION_ONLY || retryRate <= MAX_RETRY_RATE,
    },
    timeoutRate: { actual: timeoutRate, maximum: MAX_TIMEOUT_RATE, passed: timeoutRate <= MAX_TIMEOUT_RATE },
    fallbackCount: { actual: fallbackCount, maximum: MAX_FALLBACKS, passed: fallbackCount <= MAX_FALLBACKS },
    ...(FOUNDATION_ONLY ? {} : {
      completedChapterCount: {
        actual: completedChapterCount,
        expected: CHAPTER_COUNT,
        passed: completedChapterCount === CHAPTER_COUNT,
      },
      auditFailed: { actual: auditFailed, maximum: 0, passed: auditFailed === 0 },
      hardRangeRate: {
        actual: hardRangeRate,
        minimum: MIN_HARD_RANGE_RATE,
        passed: hardRangeRate !== null && hardRangeRate >= MIN_HARD_RANGE_RATE,
      },
      unrecoveredStateDegraded: { actual: unrecoveredStateDegraded, maximum: 0, passed: unrecoveredStateDegraded === 0 },
    }),
    tokenBudget: {
      actual: report.tokenBudget.total.totalTokens,
      violations: report.tokenBudget.violations,
      chapterFailures: chapterBudgetFailures,
      passed: report.tokenBudget.passed && chapterBudgetFailures === 0,
    },
    governanceCalls,
  };
  return {
    passed: Object.values(checks).every((check) => check.passed),
    thresholds: {
      maxRetryRate: MAX_RETRY_RATE,
      maxTimeoutRate: MAX_TIMEOUT_RATE,
      maxFallbacks: MAX_FALLBACKS,
      minHardRangeRate: MIN_HARD_RANGE_RATE,
      tokenBudget: TOKEN_BUDGET_LIMITS,
      governanceCalls: GOVERNANCE_CALL_LIMITS,
    },
    checks,
  };
}

function buildPreChapterGate() {
  const telemetry = summarizeLLMCallTelemetry(allTelemetry);
  const diagnostics = summarizeDiagnostics(allDiagnostics);
  const tokenBudget = buildLLMTokenBudgetReport(allTelemetry, TOKEN_BUDGET_LIMITS);
  const retryRate = telemetry.calls === 0 ? 0 : telemetry.retries / telemetry.calls;
  const timeoutRate = telemetry.calls === 0 ? 0 : telemetry.statuses.timeout / telemetry.calls;
  const checks = {
    timeoutCount: {
      actual: telemetry.statuses.timeout,
      maximum: MAX_TIMEOUT_RATE === 0 ? 0 : null,
      passed: MAX_TIMEOUT_RATE !== 0 || telemetry.statuses.timeout === 0,
    },
    fallbackCount: {
      actual: diagnostics.fallbackCount,
      maximum: MAX_FALLBACKS,
      passed: diagnostics.fallbackCount <= MAX_FALLBACKS,
    },
    tokenBudget: {
      actual: tokenBudget.total.totalTokens,
      violations: tokenBudget.violations,
      passed: tokenBudget.passed,
    },
  };
  return {
    passed: Object.values(checks).every((check) => check.passed),
    checks,
    observations: {
      retryRate: { actual: retryRate, maximum: MAX_RETRY_RATE, currentlyWithinLimit: retryRate <= MAX_RETRY_RATE },
      timeoutRate: { actual: timeoutRate, maximum: MAX_TIMEOUT_RATE, currentlyWithinLimit: timeoutRate <= MAX_TIMEOUT_RATE },
    },
  };
}

async function runRecoveryAttempt({ pipeline, operation, bookId, chapterNumber, statusBefore }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const telemetryStart = allTelemetry.length;
  const diagnosticStart = allDiagnostics.length;
  try {
    const result = operation === "repair"
      ? await pipeline.repairChapterState(bookId, chapterNumber)
      : await pipeline.resyncChapterArtifacts(bookId, chapterNumber);
    return {
      result,
      report: {
        operation,
        startedAt,
        durationMs: Date.now() - started,
        statusBefore,
        statusAfter: result.status,
        succeeded: result.status === "ready-for-review",
        telemetry: summarizeLLMCallTelemetry(allTelemetry.slice(telemetryStart)),
        diagnostics: allDiagnostics.slice(diagnosticStart),
      },
    };
  } catch (error) {
    return {
      report: {
        operation,
        startedAt,
        durationMs: Date.now() - started,
        statusBefore,
        statusAfter: "error",
        succeeded: false,
        error: error instanceof Error ? error.message : String(error),
        telemetry: summarizeLLMCallTelemetry(allTelemetry.slice(telemetryStart)),
        diagnostics: allDiagnostics.slice(diagnosticStart),
      },
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await rm(projectRoot, { recursive: true, force: true });
  await mkdir(join(projectRoot, ".inkos"), { recursive: true });
  await mkdir(reportDir, { recursive: true });

  const config = buildConfig();
  await writeFile(join(projectRoot, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
  if (!singleProvider) {
    await writeFile(
      secretsPath,
      JSON.stringify({ services: { [openrouterServiceId]: { apiKey: openrouterKey } } }, null, 2),
      "utf-8",
    );
  }

  const logHandle = await import("node:fs").then(({ createWriteStream }) =>
    createWriteStream(join(reportDir, "pipeline.jsonl"), { flags: "a" }),
  );

  const report = {
    reportVersion: "2.0.0",
    startedAt: new Date().toISOString(),
    config: {
      routeMode: ROUTE_MODE,
      chapters: CHAPTER_COUNT,
      wordsPerChapter: WORDS_PER_CHAPTER,
      reviewMode: REVIEW_MODE,
      reviewRetries: REVIEW_RETRIES,
      foundationReviewRetries: FOUNDATION_REVIEW_RETRIES,
      foundationOnly: FOUNDATION_ONLY,
      timeoutMs: TIMEOUT_MS,
      recoveryMode: RECOVERY_MODE,
      tokenBudget: {
        ...TOKEN_BUDGET_LIMITS,
        ...(MAX_CHAPTER_TOKENS !== undefined ? { maxChapterTokens: MAX_CHAPTER_TOKENS } : {}),
      },
      governanceCalls: GOVERNANCE_CALL_LIMITS,
    },
    routing: {
      default: { service: primaryServiceId, model: primaryModel, baseUrl: primaryBaseUrl, label: primaryLabel },
      overrides: Object.fromEntries(routedAgents().map((a) => [a, minimaxModel])),
    },
    smoke: {},
    routingProbe: {},
    chapters: [],
    health: {},
    diagnostics: allDiagnostics,
    warnings: [],
  };
  const reportPath = join(reportDir, `dual-api-routing-${ROUTE_MODE}-live-report.json`);
  const flushReport = async () => {
    await writeFile(
      reportPath,
      JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
  };

  try {
    // ── Load config ──────────────────────────────────────────────────────────
    const loaded = await loadProjectConfig(projectRoot, { consumer: "cli", requireApiKey: true });

    // ── Smoke: primary provider ──────────────────────────────────────────────
    const defaultClient = createLLMClient(loaded.llm);
    const primaryStart = Date.now();
    const primarySmoke = await chatCompletion(
      defaultClient, primaryModel,
      [
        { role: "system", content: "你是严格的连通性测试助手。" },
        { role: "user", content: `用一句中文回答：${primaryLabel} 已连通。不要超过 20 个字。` },
      ],
      {
        maxTokens: 80,
        temperature: 0.2,
        retry: true,
        timeoutMs: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        onCallTelemetry: (telemetry) => allTelemetry.push(telemetry),
        agentName: "smoke-primary",
        callPhase: "smoke",
      },
    );
    report.smoke.primary = {
      content: primarySmoke.content.trim(),
      usage: primarySmoke.usage,
      service: defaultClient.service,
      apiFormat: defaultClient.apiFormat,
      stream: defaultClient.stream,
      latencyMs: Date.now() - primaryStart,
    };
    await flushReport();

    // ── Smoke: MiniMax ───────────────────────────────────────────────────────
    if (!singleProvider && ROUTE_MODE !== "openrouter-only") {
      const minimaxClient = createLLMClient({
        provider: "openai", service: "minimax", configSource: "env",
        baseUrl: minimaxBaseUrl, apiKey: minimaxKey, model: minimaxModel,
        temperature: 0.7, apiFormat: "chat", stream: false,
      });
      const mmStart = Date.now();
      const minimaxSmoke = await chatCompletion(
        minimaxClient, minimaxModel,
        [
          { role: "system", content: "你是严格的连通性测试助手。" },
          { role: "user", content: "用一句中文回答：MiniMax 已连通。不要超过 20 个字。" },
        ],
        {
          maxTokens: 80,
          temperature: 0.2,
          retry: true,
          timeoutMs: TIMEOUT_MS,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          onCallTelemetry: (telemetry) => allTelemetry.push(telemetry),
          agentName: "smoke-minimax",
          callPhase: "smoke",
        },
      );
      report.smoke.minimax = {
        content: minimaxSmoke.content.trim(),
        usage: minimaxSmoke.usage,
        service: minimaxClient.service,
        apiFormat: minimaxClient.apiFormat,
        stream: minimaxClient.stream,
        latencyMs: Date.now() - mmStart,
      };
      await flushReport();
    }

    // ── Routing probe ────────────────────────────────────────────────────────
    const pipeline = new PipelineRunner(makePipelineConfig(loaded, projectRoot, logHandle));
    for (const agent of ["writer", "settler", "planner", "composer", "state-validator", "canon-extractor"]) {
      const ctx = pipeline.createAgentContext(agent);
      report.routingProbe[agent] = {
        model: ctx.model,
        service: ctx.client.service,
        apiFormat: ctx.client.apiFormat,
        stream: ctx.client.stream,
      };
    }
    await flushReport();

    // ── Book creation ────────────────────────────────────────────────────────
    const title = "双路由磁带测试";
    const bookId = deriveBookIdFromTitle(title) || `book-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const book = BookConfigSchema.parse({
      id: bookId, title, platform: "tomato", genre: "xuanhuan",
      status: "outlining", targetChapters: CHAPTER_COUNT, chapterWordCount: WORDS_PER_CHAPTER,
      language: "zh", createdAt: now, updatedAt: now,
    });
    await pipeline.initBook(book);
    report.preChapterGate = buildPreChapterGate();
    await flushReport();

    // ── Chapter loop ─────────────────────────────────────────────────────────
    if (!report.preChapterGate.passed) {
      report.warnings.push("pre-chapter gate failed; skipped chapter generation");
      await flushReport();
    }
    const chapterRuns = new Map();
    const latestChapterResults = new Map();
    let telemetryCursor = allTelemetry.length;
    let diagnosticCursor = allDiagnostics.length;
    if (report.preChapterGate.passed && !FOUNDATION_ONLY) {
      const scheduler = new Scheduler({
        ...makePipelineConfig(loaded, projectRoot, logHandle),
        writeCron: "0 0 * * *",
        maxConcurrentBooks: 1,
        chaptersPerCycle: CHAPTER_COUNT,
        retryDelayMs: 5_000,
        cooldownAfterChapterMs: 0,
        maxChaptersPerDay: CHAPTER_COUNT,
        qualityGates: {
          maxAuditRetries: REVIEW_RETRIES,
          pauseAfterConsecutiveFailures: Math.max(3, REVIEW_RETRIES + 1),
          retryTemperatureStep: 0,
          maxChapterTokens: MAX_CHAPTER_TOKENS ?? Number.MAX_SAFE_INTEGER,
          maxPromptTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL ?? Number.MAX_SAFE_INTEGER,
          maxRetryRate: MAX_RETRY_RATE,
          maxTimeoutRate: MAX_TIMEOUT_RATE,
          maxFallbacksPerChapter: MAX_FALLBACKS,
          minHardRangeRate: MIN_HARD_RANGE_RATE,
        },
        onChapterResult: (_completedBookId, result) => {
          latestChapterResults.set(result.chapterNumber, result);
        },
        onChapterComplete: (_completedBookId, chapterNumber, status) => {
          const existing = chapterRuns.get(chapterNumber) ?? {
            telemetry: [],
            diagnostics: [],
            statuses: [],
          };
          existing.telemetry.push(...allTelemetry.slice(telemetryCursor));
          existing.diagnostics.push(...allDiagnostics.slice(diagnosticCursor));
          existing.statuses.push(status);
          chapterRuns.set(chapterNumber, existing);
          telemetryCursor = allTelemetry.length;
          diagnosticCursor = allDiagnostics.length;
        },
        onError: (_failedBookId, error) => {
          report.warnings.push(`unattended provider/action error: ${error.message}`);
        },
        onPause: (_pausedBookId, reason) => {
          report.warnings.push(`unattended scheduler paused: ${reason}`);
        },
      });
      await scheduler.runOnce();
      report.unattendedState = (await new UnattendedStateStore(projectRoot).load()).books[bookId];
      report.unassignedTelemetry = summarizeLLMCallTelemetry(allTelemetry.slice(telemetryCursor));
      await flushReport();
    }

    // ── Health checks ────────────────────────────────────────────────────────
    const bookRoot = join(projectRoot, "books", bookId);
    const chaptersIndex = await readJson(join(bookRoot, "chapters", "index.json"));
    const chapterEntries = Array.isArray(chaptersIndex)
      ? chaptersIndex
      : Array.isArray(chaptersIndex?.chapters)
        ? chaptersIndex.chapters
        : [];
    report.chapters = chapterEntries.map((chapter) => {
      const result = latestChapterResults.get(chapter.number);
      const run = chapterRuns.get(chapter.number) ?? {
        telemetry: [],
        diagnostics: [],
        statuses: [],
      };
      const auditIssues = result?.auditResult?.issues ?? chapter.auditIssues ?? [];
      const governanceCalls = countGovernanceCalls(run.telemetry);
      return {
        chapterNumber: chapter.number,
        title: chapter.title,
        wordCount: chapter.wordCount,
        auditPassed: chapter.status === "ready-for-review",
        auditSummary: result?.auditResult?.summary,
        auditScore: result?.auditResult?.overallScore,
        auditIssues,
        reviewAttempts: result?.reviewAttempts,
        reviewTelemetry: result?.reviewTelemetry ?? chapter.reviewTelemetry,
        governanceCalls,
        issueCount: auditIssues.length,
        revised: result?.revised ?? false,
        initialStatus: result?.status,
        status: chapter.status,
        durationMs: run.telemetry.reduce((sum, record) => sum + record.durationMs, 0),
        length: buildLengthReport(chapter.lengthTelemetry, chapter.lengthWarnings),
        telemetry: summarizeLLMCallTelemetry(run.telemetry),
        tokenBudget: buildLLMTokenBudgetReport(run.telemetry, {
          ...(MAX_CHAPTER_TOKENS !== undefined ? { maxTotalTokens: MAX_CHAPTER_TOKENS } : {}),
          ...(MAX_PROMPT_TOKENS_PER_CALL !== undefined
            ? { maxPromptEstimatedTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL }
            : {}),
        }),
        diagnostics: run.diagnostics,
        recovery: {
          mode: "unattended-state-machine",
          statuses: run.statuses,
        },
      };
    });
    report.health = {
      chaptersIndex: { chapterCount: chapterEntries.length },
      currentStateMd: await fileHealth(join(bookRoot, "story", "current_state.md")),
      pendingHooksMd: await fileHealth(join(bookRoot, "story", "pending_hooks.md")),
      chapterSummariesMd: await fileHealth(join(bookRoot, "story", "chapter_summaries.md")),
      currentStateJson: await jsonHealth(join(bookRoot, "story", "state", "current_state.json")),
      hooksJson: await jsonHealth(join(bookRoot, "story", "state", "hooks.json")),
      snapshots: await listDirs(join(bookRoot, "story", "snapshots")),
    };

    report.telemetrySummary = summarizeLLMCallTelemetry(allTelemetry);
    report.tokenBudget = buildLLMTokenBudgetReport(allTelemetry, TOKEN_BUDGET_LIMITS);
    report.contextCompilationCache = pipeline.getContextCompilationCacheStats();
    report.diagnosticSummary = summarizeDiagnostics(allDiagnostics);
    report.lengthSummary = summarizeChapterLengths(report.chapters);
    report.qualityGate = buildQualityGate(report);
    report.finishedAt = new Date().toISOString();
    await flushReport();
    if (!report.qualityGate.passed) process.exitCode = 1;

    console.log(JSON.stringify({
      smoke: {
        primary: report.smoke.primary?.content,
        minimax: report.smoke.minimax?.content,
      },
      routingProbe: report.routingProbe,
      chapters: report.chapters.map((c) => ({
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount,
        auditPassed: c.auditPassed,
        status: c.status,
        durationMs: c.durationMs,
        reviewTermination: c.reviewTelemetry?.terminationReason,
        governanceCalls: c.governanceCalls,
      })),
      telemetry: report.telemetrySummary,
      tokenBudget: report.tokenBudget,
      qualityGate: report.qualityGate,
      contextCompilationCache: report.contextCompilationCache,
      health: report.health,
      report: reportPath,
    }, null, 2));
  } catch (error) {
    report.failure = {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    };
    report.telemetrySummary = summarizeLLMCallTelemetry(allTelemetry);
    report.tokenBudget = buildLLMTokenBudgetReport(allTelemetry, TOKEN_BUDGET_LIMITS);
    report.diagnosticSummary = summarizeDiagnostics(allDiagnostics);
    report.finishedAt = new Date().toISOString();
    await flushReport().catch(() => undefined);
    process.exitCode = 1;
    console.error(JSON.stringify({
      failure: report.failure,
      chapters: report.chapters.map((c) => ({
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount,
        status: c.status,
        durationMs: c.durationMs,
      })),
      telemetry: report.telemetrySummary,
      diagnostics: report.diagnosticSummary,
      report: reportPath,
    }, null, 2));
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    logHandle.end();
    await new Promise((resolveEnd) => logHandle.on("finish", resolveEnd));
    await removeEphemeralSecret();
  }

  // ── Secret leak scan ───────────────────────────────────────────────────────
  const scanNeedles = [primaryKey, minimaxKey].filter(Boolean);
  const reportFiles = await readdir(reportDir).catch(() => []);
  const leaks = [];
  for (const file of reportFiles) {
    const path = join(reportDir, file);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    const text = await readFile(path, "utf-8");
    if (scanNeedles.some((needle) => text.includes(needle))) leaks.push(file);
  }
  if (leaks.length > 0) {
    throw new Error(`Secret leak detected in reports: ${leaks.join(", ")}`);
  }
}

await main();
