import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  StateManager,
  atomicWriteJson,
  buildEpisodeSampleReport,
  computeAnalytics,
  parseLLMCallTelemetryJsonl,
} from "@actalk/inkos-core";
import { loadConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

interface AnalyticsOptions {
  readonly json?: boolean;
  readonly episodes?: string;
  readonly llmReport?: boolean;
  readonly saveReport?: boolean;
  readonly maxTotalTokens?: string;
  readonly maxEpisodeTokens?: string;
  readonly maxPromptTokens?: string;
  readonly maxRetryRate?: string;
  readonly maxAuditCalls?: string;
  readonly maxRevisionCalls?: string;
  readonly maxNormalizeCalls?: string;
  readonly maxSettleCalls?: string;
}

export const analyticsCommand = new Command("analytics")
  .alias("stats")
  .description("Show analytics and token stats for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .option("--episodes <range>", "Episode range (for example 4-6 or 5)")
  .option("--llm-report", "Join episode operations with persisted LLM telemetry")
  .option("--save-report", "Save the JSON report under .inkos/reports")
  .option("--max-total-tokens <n>", "Fail the LLM report gate above this sample total")
  .option("--max-episode-tokens <n>", "Fail the LLM report gate above this per-episode total")
  .option("--max-prompt-tokens <n>", "Fail the LLM report gate above this estimated prompt size")
  .option("--max-retry-rate <ratio>", "Fail the LLM report gate above this retry ratio (0-1)")
  .option("--max-audit-calls <n>", "Fail above this audit call count per episode")
  .option("--max-revision-calls <n>", "Fail above this revision call count per episode")
  .option("--max-normalize-calls <n>", "Fail above this length-normalization call count per episode")
  .option("--max-settle-calls <n>", "Fail above this settlement call count per episode")
  .action(async (bookIdArg: string | undefined, opts: AnalyticsOptions) => {
    try {
      await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const allEpisodes = await state.loadEpisodeIndex(bookId);
      const range = parseEpisodeRange(opts.episodes);
      const episodes = allEpisodes.filter((episode) => (
        episode.episodeNumber >= range.start && episode.episodeNumber <= range.end
      ));

      const analytics = computeAnalytics(bookId, episodes);
      let llmReport: ReturnType<typeof buildEpisodeSampleReport> | undefined;
      let reportPath: string | undefined;

      if (opts.llmReport || opts.saveReport) {
        const telemetryPath = join(root, ".inkos", "runtime", "llm-calls", `${bookId}.jsonl`);
        const telemetryContent = await readFile(telemetryPath, "utf-8").catch(() => "");
        const telemetry = parseLLMCallTelemetryJsonl(telemetryContent);
        llmReport = buildEpisodeSampleReport({
          bookId,
          episodes,
          telemetry: telemetry.records,
          telemetryInvalidLines: telemetry.invalidLines,
          expectedEpisodeCount: range.expectedCount,
          limits: {
            maxTotalTokens: parsePositiveInteger(opts.maxTotalTokens, "--max-total-tokens"),
            maxEpisodeTokens: parsePositiveInteger(opts.maxEpisodeTokens, "--max-episode-tokens"),
            maxPromptEstimatedTokensPerCall: parsePositiveInteger(
              opts.maxPromptTokens,
              "--max-prompt-tokens",
            ),
            maxRetryRate: parseRatio(opts.maxRetryRate, "--max-retry-rate"),
            maxAuditCallsPerEpisode: parsePositiveInteger(
              opts.maxAuditCalls,
              "--max-audit-calls",
            ),
            maxRevisionCallsPerEpisode: parsePositiveInteger(
              opts.maxRevisionCalls,
              "--max-revision-calls",
            ),
            maxLengthNormalizationCallsPerEpisode: parsePositiveInteger(
              opts.maxNormalizeCalls,
              "--max-normalize-calls",
            ),
            maxSettlementCallsPerEpisode: parsePositiveInteger(
              opts.maxSettleCalls,
              "--max-settle-calls",
            ),
          },
        });
      }

      const output = llmReport
        ? { generatedAt: new Date().toISOString(), analytics, llmReport }
        : analytics;

      if (opts.saveReport) {
        const rangeLabel = opts.episodes ?? "all";
        const safeBookId = bookId.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
        reportPath = join(
          root,
          ".inkos",
          "reports",
          `${safeBookId}-episodes-${rangeLabel}-llm-report.json`,
        );
        await atomicWriteJson(reportPath, output);
      }

      if (opts.json) {
        log(JSON.stringify(output, null, 2));
      } else {
        log(`Analytics for "${bookId}":`);
        log("");
        log(`  Total episodes: ${analytics.totalEpisodes}`);
        log(`  Total duration: ${analytics.totalDurationSeconds.toLocaleString()}s`);
        log(`  Avg duration/episode: ${analytics.avgDurationSeconds.toLocaleString()}s`);
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
          log(`    Avg tokens/episode: ${analytics.tokenStats.avgTokensPerEpisode.toLocaleString()}`);
          if (analytics.tokenStats.recentTrend.length > 0) {
            log("    Recent trend:");
            for (const { episode, totalTokens } of analytics.tokenStats.recentTrend) {
              log(`      Ep.${episode}: ${totalTokens.toLocaleString()} tokens`);
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

        if (analytics.episodesWithMostIssues.length > 0) {
          log("  Episodes with most issues:");
          for (const { episode, issueCount } of analytics.episodesWithMostIssues) {
            log(`    Ep.${episode}: ${issueCount} issues`);
          }
        }

        if (llmReport) {
          log("");
          log("  LLM sample report:");
          log(`    Gate: ${llmReport.gate.passed ? "PASS" : "FAIL"}`);
          log(`    Correlated episodes: ${llmReport.telemetryWindow.matchedEpisodeOperations}/${llmReport.episodes.length}`);
          log(`    Calls: ${llmReport.totals.telemetryCalls.toLocaleString()}`);
          log(`    Telemetry tokens: ${llmReport.totals.telemetryTokens.toLocaleString()}`);
          log(`    Indexed tokens: ${llmReport.totals.indexedTokens.toLocaleString()}`);
          log(`    Unindexed telemetry tokens: ${llmReport.totals.telemetryMinusIndexedTokens.toLocaleString()}`);
          log(`    Index coverage: ${(llmReport.totals.indexedTelemetryCoverageRate * 100).toFixed(1)}%`);
          log(`    Retry rate: ${(llmReport.totals.retryRate * 100).toFixed(1)}%`);
          log(`    Max estimated prompt: ${llmReport.telemetry.prompt.maxEstimatedTokens.toLocaleString()}`);
          log("");
          log("    Episode operations:");
          for (const episode of llmReport.episodes) {
            log(
              `      Ep.${episode.episodeNumber}: ${episode.telemetry.calls} calls, ${episode.telemetry.usage.totalTokens.toLocaleString()} telemetry tokens, ${episode.indexedTokens.toLocaleString()} indexed tokens`,
            );
            const governance = episode.governanceCalls;
            log(
              `        governance audit=${governance.audit}, revise=${governance.revision}, normalize=${governance.lengthNormalization}, settle=${governance.settlement}; stop=${episode.reviewTelemetry?.terminationReason ?? "legacy/unrecorded"}`,
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

function parseEpisodeRange(value?: string): {
  readonly start: number;
  readonly end: number;
  readonly expectedCount?: number;
} {
  if (!value) return { start: 1, end: Number.POSITIVE_INFINITY };
  const match = value.trim().match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`Invalid episode range: ${value}`);
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2] ?? match[1]!, 10);
  if (start < 1 || end < start) throw new Error(`Invalid episode range: ${value}`);
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
