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
} from "../packages/core/dist/index.js";

// ── CLI ────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    chapters:     { type: "string", default: "5" },
    words:        { type: "string", default: "1000" },
    "route-mode": { type: "string", default: "minimax-writer" },
    "timeout-ms": { type: "string", default: "300000" },
    "output":     { type: "string", default: ".tmp-dual-api-routing/reports" },
    "project-dir":{ type: "string", default: ".tmp-dual-api-routing" },
  },
});

const CHAPTER_COUNT = Math.max(1, Number(args.chapters) || 5);
const WORDS_PER_CHAPTER = Math.max(100, Number(args.words) || 1000);
const ROUTE_MODE = args["route-mode"];
const TIMEOUT_MS = Math.max(5000, Number(args["timeout-ms"]) || 300000);

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
    writing: { reviewRetries: 0, reviewMode: "manual", revisionGate: "always" },
    notify: [],
    inputGovernanceMode: "v2",
    modelOverrides: Object.fromEntries(routedAgents().map((agent) => [agent, minimaxOverride])),
  };
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/** @type {import("../packages/core/dist/index.js").LLMCallTelemetry[]} */
const allTelemetry = [];

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
    defaultTimeoutMs: TIMEOUT_MS,
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

/** Build a telemetry summary grouped by agent+phase. */
function buildTelemetrySummary(records) {
  const byAgent = {};
  let timeouts = 0;
  let errors = 0;
  for (const t of records) {
    const key = `${t.agent}:${t.phase}`;
    if (!byAgent[key]) byAgent[key] = { calls: 0, totalDurationMs: 0, timeouts: 0, errors: 0 };
    byAgent[key].calls++;
    byAgent[key].totalDurationMs += t.durationMs;
    if (t.status === "timeout") { byAgent[key].timeouts++; timeouts++; }
    if (t.status === "error") { byAgent[key].errors++; errors++; }
  }
  return {
    totalCalls: records.length,
    totalDurationMs: records.reduce((sum, t) => sum + t.durationMs, 0),
    timeouts,
    errors,
    byAgent,
  };
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
    reportVersion: "1.0.0",
    startedAt: new Date().toISOString(),
    config: {
      routeMode: ROUTE_MODE,
      chapters: CHAPTER_COUNT,
      wordsPerChapter: WORDS_PER_CHAPTER,
      timeoutMs: TIMEOUT_MS,
    },
    routing: {
      default: { service: openrouterServiceId, model: openrouterModel },
      overrides: Object.fromEntries(routedAgents().map((a) => [a, minimaxModel])),
    },
    smoke: {},
    routingProbe: {},
    chapters: [],
    health: {},
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
      { maxTokens: 80, temperature: 0.2, retry: false },
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
      { maxTokens: 80, temperature: 0.2, retry: false },
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
    await flushReport();

    // ── Chapter loop ─────────────────────────────────────────────────────────
    for (let i = 0; i < CHAPTER_COUNT; i++) {
      const chStart = Date.now();
      const beforeCount = allTelemetry.length;
      const result = await pipeline.writeNextChapter(bookId, WORDS_PER_CHAPTER);
      const chDuration = Date.now() - chStart;
      const chTelemetry = allTelemetry.slice(beforeCount);

      report.chapters.push({
        chapterNumber: result.chapterNumber,
        title: result.title,
        wordCount: result.wordCount,
        auditPassed: result.auditResult.passed,
        issueCount: result.auditResult.issues.length,
        revised: result.revised,
        status: result.status,
        durationMs: chDuration,
        telemetry: buildTelemetrySummary(chTelemetry),
      });
      if (result.status === "state-degraded") {
        report.warnings.push(`state-degraded after chapter ${result.chapterNumber}`);
        break;
      }
      await flushReport();
    }

    // ── Health checks ────────────────────────────────────────────────────────
    const bookRoot = join(projectRoot, "books", bookId);
    const chaptersIndex = await readJson(join(bookRoot, "chapters", "index.json"));
    report.health = {
      chaptersIndex: { chapterCount: Array.isArray(chaptersIndex.chapters) ? chaptersIndex.chapters.length : 0 },
      currentStateMd: await fileHealth(join(bookRoot, "story", "current_state.md")),
      pendingHooksMd: await fileHealth(join(bookRoot, "story", "pending_hooks.md")),
      chapterSummariesMd: await fileHealth(join(bookRoot, "story", "chapter_summaries.md")),
      currentStateJson: await jsonHealth(join(bookRoot, "story", "state", "current_state.json")),
      hooksJson: await jsonHealth(join(bookRoot, "story", "state", "hooks.json")),
      snapshots: await listDirs(join(bookRoot, "story", "snapshots")),
    };

    report.telemetrySummary = buildTelemetrySummary(allTelemetry);
    report.finishedAt = new Date().toISOString();
    await flushReport();

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
      health: report.health,
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