import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BookConfigSchema,
  PipelineRunner,
  Scheduler,
  StateManager,
  UnattendedStateStore,
} from "../../packages/core/dist/index.js";

const [mode, rootArg, bookId = "unattended-soak", targetArg = "20", delayArg = "0", timeoutArg = "0"] = process.argv.slice(2);
const root = resolve(rootArg);
const targetChapters = Math.max(1, Number.parseInt(targetArg, 10) || 20);
const delayMs = Math.max(0, Number.parseInt(delayArg, 10) || 0);
const timeoutMs = Math.max(0, Number.parseInt(timeoutArg, 10) || 0);

process.env.INKOS_AGENT_LLM_STUB = "1";
process.env.INKOS_AGENT_LLM_STUB_VOLUME_END_CHAPTER = String(targetChapters);
if (delayMs > 0) process.env.INKOS_AGENT_LLM_STUB_DELAY_MS = String(delayMs);
else delete process.env.INKOS_AGENT_LLM_STUB_DELAY_MS;

const client = {
  provider: "openai",
  service: "custom:UnattendedStub",
  apiFormat: "chat",
  stream: false,
  defaults: {
    temperature: 0.7,
    maxTokens: 8192,
    thinkingBudget: 0,
    extra: {},
  },
};

const pipelineConfig = {
  client,
  model: "unattended-stub",
  projectRoot: root,
  chapterReviewMode: "auto",
  writingReviewRetries: 2,
  revisionGate: "strict",
  inputGovernanceMode: "v2",
  ...(timeoutMs > 0 ? { defaultTimeoutMs: timeoutMs } : {}),
};

if (mode === "setup") {
  const now = new Date().toISOString();
  const runner = new PipelineRunner(pipelineConfig);
  await runner.initBook(BookConfigSchema.parse({
    id: bookId,
    title: "无人值守二十章故障注入",
    platform: "other",
    genre: "xuanhuan",
    status: "outlining",
    targetChapters,
    chapterWordCount: 1000,
    language: "zh",
    createdAt: now,
    updatedAt: now,
  }));
  process.stdout.write(`UNATTENDED_SETUP ${JSON.stringify({ bookId, targetChapters })}\n`);
} else if (mode === "run" || mode === "timeout") {
  const state = new StateManager(root);
  const before = await state.loadChapterIndex(bookId);
  const remaining = Math.max(0, targetChapters - before.length);
  const latest = before.at(-1);
  const hasPendingRecovery = latest?.status === "audit-failed" || latest?.status === "state-degraded";
  if (remaining > 0 || hasPendingRecovery) {
    const scheduler = new Scheduler({
      ...pipelineConfig,
      writeCron: "0 0 * * *",
      maxConcurrentBooks: 1,
      chaptersPerCycle: Math.min(20, Math.max(1, remaining)),
      retryDelayMs: 0,
      cooldownAfterChapterMs: 0,
      maxChaptersPerDay: targetChapters,
      qualityGates: {
        maxAuditRetries: 2,
        pauseAfterConsecutiveFailures: 3,
        retryTemperatureStep: 0,
        maxChapterTokens: 100_000,
        maxPromptTokensPerCall: 16_000,
        maxRetryRate: 0.2,
        maxTimeoutRate: 0,
        maxFallbacksPerChapter: 0,
        minHardRangeRate: 0.8,
      },
    });
    if (mode === "timeout") {
      scheduler.pipeline.writeNextChapter = async () => {
        throw new Error("ETIMEDOUT injected provider timeout");
      };
    }
    await scheduler.start();
    scheduler.stop();
  }

  const chapters = await state.loadChapterIndex(bookId);
  const unattended = await new UnattendedStateStore(root).load();
  const snapshotsDir = resolve(root, "books", bookId, "story", "snapshots");
  const snapshots = await readdir(snapshotsDir).catch(() => []);
  process.stdout.write(`UNATTENDED_RUN ${JSON.stringify({
    before: before.length,
    after: chapters.length,
    statuses: chapters.map((chapter) => chapter.status),
    snapshots: snapshots.length,
    unattended: unattended.books[bookId],
  })}\n`);
} else {
  throw new Error(`Unknown unattended soak worker mode: ${mode}`);
}
