import { mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BookConfigSchema,
  PipelineRunner,
  StateManager,
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
    "route-mode": { type: "string", default: "minimax-writer" },
    "review-mode": { type: "string", default: "manual" },
    "review-retries": { type: "string", default: "2" },
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
  },
});

const CHAPTER_COUNT = Math.max(1, Number(args.chapters) || 5);
const WORDS_PER_CHAPTER = Math.max(1000, Number(args.words) || 1000);
const ROUTE_MODE = args["route-mode"];
const REVIEW_MODE = args["review-mode"];
const REVIEW_RETRIES = REVIEW_MODE === "auto"
  ? Math.max(0, Math.floor(Number(args["review-retries"]) || 0))
  : 0;
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
const TOKEN_BUDGET_LIMITS = {
  ...(MAX_TOTAL_TOKENS !== undefined ? { maxTotalTokens: MAX_TOTAL_TOKENS } : {}),
  ...(MAX_PROMPT_TOKENS_PER_CALL !== undefined
    ? { maxPromptEstimatedTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL }
    : {}),
  ...(Object.keys(MAX_AGENT_TOKENS).length > 0 ? { maxAgentTokens: MAX_AGENT_TOKENS } : {}),
  ...(Object.keys(MAX_PHASE_TOKENS).length > 0 ? { maxPhaseTokens: MAX_PHASE_TOKENS } : {}),
};

const repoRoot = resolve(import.meta.dirname, "..");
const projectRoot = join(repoRoot, args["project-dir"]);
const reportDir = join(projectRoot, "reports");
const secretsPath = join(projectRoot, ".inkos", "secrets.json");

// ── Config ──────────────────────────────────────────────────────────────────

const openrouterServiceId = "custom:OpenRouterLive";
const openrouterModel = "deepseek/deepseek-v4-flash";
const minimaxModel = "MiniMax-M3";
const minimaxBaseUrl = "https://api.minimaxi.com/v1";

const openrouterKey = process.env.OPENROUTER_API_KEY;
const minimaxKey = process.env.MINIMAX_API_KEY;
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY is required");
if (!minimaxKey) throw new Error("MINIMAX_API_KEY is required");

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
  return ROUTE_MODE === "minimax-writer" ? minimaxWriterAgents : minimaxGovernanceAgents;
}

function buildConfig() {
  return {
    name: "dual-api-routing-live-test",
    version: "0.1.0",
    language: "zh",
    llm: {
      provider: "openai",
      service: openrouterServiceId,
      configSource: "studio",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      model: openrouterModel,
      defaultModel: openrouterModel,
      apiFormat: "chat",
      stream: false,
      temperature: 0.7,
      services: [
        { service: "custom", name: "OpenRouterLive", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "chat", stream: false, temperature: 0.7 },
        { service: "minimax", baseUrl: minimaxBaseUrl, apiFormat: "chat", stream: false, temperature: 0.9 },
      ],
    },
    foundation: { reviewRetries: 0 },
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

function buildQualityGate(report) {
  const telemetry = report.telemetrySummary;
  const retryRate = telemetry.calls === 0 ? 0 : telemetry.retries / telemetry.calls;
  const timeoutRate = telemetry.calls === 0 ? 0 : telemetry.statuses.timeout / telemetry.calls;
  const hardRangeRate = report.lengthSummary.hardRangeRate;
  const fallbackCount = report.diagnosticSummary.fallbackCount;
  const unrecoveredStateDegraded = report.chapters.filter((chapter) => chapter.status === "state-degraded").length;
  const chapterBudgetFailures = report.chapters.filter((chapter) => chapter.tokenBudget && !chapter.tokenBudget.passed).length;
  const checks = {
    retryRate: { actual: retryRate, maximum: MAX_RETRY_RATE, passed: retryRate <= MAX_RETRY_RATE },
    timeoutRate: { actual: timeoutRate, maximum: MAX_TIMEOUT_RATE, passed: timeoutRate <= MAX_TIMEOUT_RATE },
    fallbackCount: { actual: fallbackCount, maximum: MAX_FALLBACKS, passed: fallbackCount <= MAX_FALLBACKS },
    hardRangeRate: {
      actual: hardRangeRate,
      minimum: MIN_HARD_RANGE_RATE,
      passed: hardRangeRate !== null && hardRangeRate >= MIN_HARD_RANGE_RATE,
    },
    unrecoveredStateDegraded: { actual: unrecoveredStateDegraded, maximum: 0, passed: unrecoveredStateDegraded === 0 },
    tokenBudget: {
      actual: report.tokenBudget.total.totalTokens,
      violations: report.tokenBudget.violations,
      chapterFailures: chapterBudgetFailures,
      passed: report.tokenBudget.passed && chapterBudgetFailures === 0,
    },
  };
  return {
    passed: Object.values(checks).every((check) => check.passed),
    thresholds: {
      maxRetryRate: MAX_RETRY_RATE,
      maxTimeoutRate: MAX_TIMEOUT_RATE,
      maxFallbacks: MAX_FALLBACKS,
      minHardRangeRate: MIN_HARD_RANGE_RATE,
      tokenBudget: TOKEN_BUDGET_LIMITS,
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
  await writeFile(
    secretsPath,
    JSON.stringify({ services: { [openrouterServiceId]: { apiKey: openrouterKey } } }, null, 2),
    "utf-8",
  );

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
      timeoutMs: TIMEOUT_MS,
      recoveryMode: RECOVERY_MODE,
      tokenBudget: {
        ...TOKEN_BUDGET_LIMITS,
        ...(MAX_CHAPTER_TOKENS !== undefined ? { maxChapterTokens: MAX_CHAPTER_TOKENS } : {}),
      },
    },
    routing: {
      default: { service: openrouterServiceId, model: openrouterModel },
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

    // ── Smoke: OpenRouter ────────────────────────────────────────────────────
    const defaultClient = createLLMClient(loaded.llm);
    const orStart = Date.now();
    const openrouterSmoke = await chatCompletion(
      defaultClient, openrouterModel,
      [
        { role: "system", content: "你是严格的连通性测试助手。" },
        { role: "user", content: "用一句中文回答：OpenRouter 已连通。不要超过 20 个字。" },
      ],
      {
        maxTokens: 80,
        temperature: 0.2,
        retry: true,
        timeoutMs: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        onCallTelemetry: (telemetry) => allTelemetry.push(telemetry),
        agentName: "smoke-openrouter",
        callPhase: "smoke",
      },
    );
    report.smoke.openrouter = {
      content: openrouterSmoke.content.trim(),
      usage: openrouterSmoke.usage,
      service: defaultClient.service,
      apiFormat: defaultClient.apiFormat,
      stream: defaultClient.stream,
      latencyMs: Date.now() - orStart,
    };
    await flushReport();

    // ── Smoke: MiniMax ───────────────────────────────────────────────────────
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
    const chaptersToRun = report.preChapterGate.passed ? CHAPTER_COUNT : 0;
    for (let i = 0; i < chaptersToRun; i++) {
      const chStart = Date.now();
      const beforeCount = allTelemetry.length;
      const beforeDiagnostics = allDiagnostics.length;
      let result = await pipeline.writeNextChapter(bookId, WORDS_PER_CHAPTER);
      const chapterRecords = allTelemetry.slice(beforeCount);
      const chapterReport = {
        chapterNumber: result.chapterNumber,
        title: result.title,
        wordCount: result.wordCount,
        auditPassed: result.auditResult.passed,
        auditSummary: result.auditResult.summary,
        auditScore: result.auditResult.overallScore,
        auditIssues: result.auditResult.issues,
        reviewAttempts: result.reviewAttempts,
        issueCount: result.auditResult.issues.length,
        revised: result.revised,
        initialStatus: result.status,
        status: result.status,
        durationMs: Date.now() - chStart,
        length: buildLengthReport(result.lengthTelemetry, result.lengthWarnings),
        tokenBudget: buildLLMTokenBudgetReport(chapterRecords, {
          ...(MAX_CHAPTER_TOKENS !== undefined ? { maxTotalTokens: MAX_CHAPTER_TOKENS } : {}),
          ...(MAX_PROMPT_TOKENS_PER_CALL !== undefined
            ? { maxPromptEstimatedTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL }
            : {}),
        }),
        recovery: { mode: RECOVERY_MODE, attempts: [] },
      };
      report.chapters.push(chapterReport);
      await flushReport();

      if (result.status === "state-degraded") {
        report.warnings.push(`state-degraded after chapter ${result.chapterNumber}`);
        const operations = RECOVERY_MODE === "repair-then-resync"
          ? ["repair", "resync"]
          : RECOVERY_MODE === "none" ? [] : [RECOVERY_MODE];
        for (const operation of operations) {
          const attempt = await runRecoveryAttempt({
            pipeline,
            operation,
            bookId,
            chapterNumber: result.chapterNumber,
            statusBefore: result.status,
          });
          chapterReport.recovery.attempts.push(attempt.report);
          if (attempt.result) result = attempt.result;
          chapterReport.status = result.status;
          await flushReport();
          if (result.status !== "state-degraded") break;
        }
      }
      chapterReport.wordCount = result.wordCount;
      chapterReport.auditPassed = result.auditResult.passed;
      chapterReport.auditSummary = result.auditResult.summary;
      chapterReport.auditScore = result.auditResult.overallScore;
      chapterReport.auditIssues = result.auditResult.issues;
      chapterReport.reviewAttempts = result.reviewAttempts;
      chapterReport.issueCount = result.auditResult.issues.length;
      chapterReport.revised = result.revised;
      chapterReport.status = result.status;
      chapterReport.durationMs = Date.now() - chStart;
      chapterReport.length = buildLengthReport(result.lengthTelemetry, result.lengthWarnings);
      chapterReport.telemetry = summarizeLLMCallTelemetry(allTelemetry.slice(beforeCount));
      chapterReport.tokenBudget = buildLLMTokenBudgetReport(allTelemetry.slice(beforeCount), {
        ...(MAX_CHAPTER_TOKENS !== undefined ? { maxTotalTokens: MAX_CHAPTER_TOKENS } : {}),
        ...(MAX_PROMPT_TOKENS_PER_CALL !== undefined
          ? { maxPromptEstimatedTokensPerCall: MAX_PROMPT_TOKENS_PER_CALL }
          : {}),
      });
      chapterReport.diagnostics = allDiagnostics.slice(beforeDiagnostics);
      await flushReport();
      if (result.status === "state-degraded") break;
      if (result.status === "audit-failed") {
        report.warnings.push(`audit-failed after chapter ${result.chapterNumber}`);
        break;
      }
    }

    // ── Health checks ────────────────────────────────────────────────────────
    const bookRoot = join(projectRoot, "books", bookId);
    const chaptersIndex = await readJson(join(bookRoot, "chapters", "index.json"));
    const chapterEntries = Array.isArray(chaptersIndex)
      ? chaptersIndex
      : Array.isArray(chaptersIndex?.chapters)
        ? chaptersIndex.chapters
        : [];
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
        openrouter: report.smoke.openrouter?.content,
        minimax: report.smoke.minimax?.content,
      },
      routingProbe: report.routingProbe,
      chapters: report.chapters.map((c) => ({
        chapterNumber: c.chapterNumber,
        wordCount: c.wordCount,
        auditPassed: c.auditPassed,
        status: c.status,
        durationMs: c.durationMs,
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
    logHandle.end();
    await new Promise((resolveEnd) => logHandle.on("finish", resolveEnd));
    await rm(secretsPath, { force: true });
  }

  // ── Secret leak scan ───────────────────────────────────────────────────────
  const scanNeedles = [openrouterKey, minimaxKey].filter(Boolean);
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
