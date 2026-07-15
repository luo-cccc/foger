import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  StateManager,
  atomicWriteJson,
  buildChapterSampleReport,
  computeAnalytics,
  parseLLMCallTelemetryJsonl,
} from "@actalk/inkos-core";
import { loadConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

interface AnalyticsOptions {
  readonly json?: boolean;
  readonly chapters?: string;
  readonly llmReport?: boolean;
  readonly saveReport?: boolean;
  readonly maxTotalTokens?: string;
  readonly maxChapterTokens?: string;
  readonly maxPromptTokens?: string;
  readonly maxRetryRate?: string;
}

export const analyticsCommand = new Command("analytics")
  .alias("stats")
  .description("Show analytics and token stats for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .option("--chapters <range>", "Chapter range (for example 4-6 or 5)")
  .option("--llm-report", "Join chapter operations with persisted LLM telemetry")
  .option("--save-report", "Save the JSON report under .inkos/reports")
  .option("--max-total-tokens <n>", "Fail the LLM report gate above this sample total")
  .option("--max-chapter-tokens <n>", "Fail the LLM report gate above this per-chapter total")
  .option("--max-prompt-tokens <n>", "Fail the LLM report gate above this estimated prompt size")
  .option("--max-retry-rate <ratio>", "Fail the LLM report gate above this retry ratio (0-1)")
  .action(async (bookIdArg: string | undefined, opts: AnalyticsOptions) => {
    try {
      await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const allChapters = await state.loadChapterIndex(bookId);
      const range = parseChapterRange(opts.chapters);
      const chapters = allChapters.filter((chapter) => (
        chapter.number >= range.start && chapter.number <= range.end
      ));

      const analytics = computeAnalytics(bookId, chapters);
      let llmReport: ReturnType<typeof buildChapterSampleReport> | undefined;
      let reportPath: string | undefined;

      if (opts.llmReport || opts.saveReport) {
        const telemetryPath = join(root, ".inkos", "runtime", "llm-calls", `${bookId}.jsonl`);
        const telemetryContent = await readFile(telemetryPath, "utf-8").catch(() => "");
        const telemetry = parseLLMCallTelemetryJsonl(telemetryContent);
        llmReport = buildChapterSampleReport({
          bookId,
          chapters,
          telemetry: telemetry.records,
          telemetryInvalidLines: telemetry.invalidLines,
          expectedChapterCount: range.expectedCount,
          limits: {
            maxTotalTokens: parsePositiveInteger(opts.maxTotalTokens, "--max-total-tokens"),
            maxChapterTokens: parsePositiveInteger(opts.maxChapterTokens, "--max-chapter-tokens"),
            maxPromptEstimatedTokensPerCall: parsePositiveInteger(
              opts.maxPromptTokens,
              "--max-prompt-tokens",
            ),
            maxRetryRate: parseRatio(opts.maxRetryRate, "--max-retry-rate"),
          },
        });
      }

      const output = llmReport
        ? { generatedAt: new Date().toISOString(), analytics, llmReport }
        : analytics;

      if (opts.saveReport) {
        const rangeLabel = opts.chapters ?? "all";
        const safeBookId = bookId.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
        reportPath = join(
          root,
          ".inkos",
          "reports",
          `${safeBookId}-chapters-${rangeLabel}-llm-report.json`,
        );
        await atomicWriteJson(reportPath, output);
      }

      if (opts.json) {
        log(JSON.stringify(output, null, 2));
      } else {
        log(`Analytics for "${bookId}":`);
        log("");
        log(`  Total chapters: ${analytics.totalChapters}`);
        log(`  Total words: ${analytics.totalWords.toLocaleString()}`);
        log(`  Avg words/chapter: ${analytics.avgWordsPerChapter.toLocaleString()}`);
        log(`  Audit pass rate: ${analytics.auditPassRate}%`);
        log("");

        if (Object.keys(analytics.statusDistribution).length > 0) {
          log("  Status distribution:");
          for (const [status, count] of Object.entries(analytics.statusDistribution)) {
            log(`    ${status}: ${count}`);
          }
          log("");
        }

        if (analytics.tokenStats) {
          log("  Token usage:");
          log(`    Total tokens: ${analytics.tokenStats.totalTokens.toLocaleString()}`);
          log(`    Prompt tokens: ${analytics.tokenStats.totalPromptTokens.toLocaleString()}`);
          log(`    Completion tokens: ${analytics.tokenStats.totalCompletionTokens.toLocaleString()}`);
          log(`    Avg tokens/chapter: ${analytics.tokenStats.avgTokensPerChapter.toLocaleString()}`);
          if (analytics.tokenStats.recentTrend.length > 0) {
            log("    Recent trend:");
            for (const { chapter, totalTokens } of analytics.tokenStats.recentTrend) {
              log(`      Ch.${chapter}: ${totalTokens.toLocaleString()} tokens`);
            }
          }
          log("");
        }

        if (analytics.topIssueCategories.length > 0) {
          log("  Most common issue categories:");
          for (const { category, count } of analytics.topIssueCategories) {
            log(`    ${category}: ${count}`);
          }
          log("");
        }

        if (analytics.chaptersWithMostIssues.length > 0) {
          log("  Chapters with most issues:");
          for (const { chapter, issueCount } of analytics.chaptersWithMostIssues) {
            log(`    Ch.${chapter}: ${issueCount} issues`);
          }
        }

        if (llmReport) {
          log("");
          log("  LLM sample report:");
          log(`    Gate: ${llmReport.gate.passed ? "PASS" : "FAIL"}`);
          log(`    Correlated chapters: ${llmReport.telemetryWindow.matchedChapterOperations}/${llmReport.chapters.length}`);
          log(`    Calls: ${llmReport.totals.telemetryCalls.toLocaleString()}`);
          log(`    Telemetry tokens: ${llmReport.totals.telemetryTokens.toLocaleString()}`);
          log(`    Indexed tokens: ${llmReport.totals.indexedTokens.toLocaleString()}`);
          log(`    Unindexed telemetry tokens: ${llmReport.totals.telemetryMinusIndexedTokens.toLocaleString()}`);
          log(`    Index coverage: ${(llmReport.totals.indexedTelemetryCoverageRate * 100).toFixed(1)}%`);
          log(`    Retry rate: ${(llmReport.totals.retryRate * 100).toFixed(1)}%`);
          log(`    Max estimated prompt: ${llmReport.telemetry.prompt.maxEstimatedTokens.toLocaleString()}`);
          log("");
          log("    Chapter operations:");
          for (const chapter of llmReport.chapters) {
            log(
              `      Ch.${chapter.number}: ${chapter.telemetry.calls} calls, ${chapter.telemetry.usage.totalTokens.toLocaleString()} telemetry tokens, ${chapter.indexedTokens.toLocaleString()} indexed tokens`,
            );
          }
          const topAgentPhases = Object.entries(llmReport.telemetry.byAgentPhase)
            .sort((left, right) => right[1].usage.totalTokens - left[1].usage.totalTokens)
            .slice(0, 8);
          if (topAgentPhases.length > 0) {
            log("");
            log("    Largest agent/phase totals:");
            for (const [key, aggregate] of topAgentPhases) {
              log(`      ${key}: ${aggregate.calls} calls, ${aggregate.usage.totalTokens.toLocaleString()} tokens`);
            }
          }
          if (llmReport.gate.issues.length > 0) {
            log("");
            log("    Gate issues:");
            for (const issue of llmReport.gate.issues) {
              log(`      [${issue.code}] ${issue.message}`);
            }
          }
        }

        if (reportPath) {
          log("");
          log(`  Saved report: ${reportPath}`);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Analytics failed: ${e}`);
      }
      process.exit(1);
    }
  });

function parseChapterRange(value?: string): {
  readonly start: number;
  readonly end: number;
  readonly expectedCount?: number;
} {
  if (!value) return { start: 1, end: Number.POSITIVE_INFINITY };
  const match = value.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`Invalid chapter range: ${value}`);
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2] ?? match[1]!, 10);
  if (start < 1 || end < start) throw new Error(`Invalid chapter range: ${value}`);
  return { start, end, expectedCount: end - start + 1 };
}

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseRatio(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between 0 and 1.`);
  }
  return parsed;
}
