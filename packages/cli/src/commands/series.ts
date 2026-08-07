import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId } from "../utils.js";

export const seriesCommand = new Command("series")
  .description("Inspect and complete a comic-drama series");

seriesCommand
  .command("status")
  .argument("[book-id]", "Series ID")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean }) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const status = await pipeline.getSeriesStatus(bookId);
      const payload = {
        bookId,
        title: status.title,
        episodesWritten: status.chaptersWritten,
        nextEpisode: status.nextChapter,
        status: status.status,
        performance: status.episodePerformance,
      };
      if (opts.json) log(JSON.stringify(payload, null, 2));
      else {
        log(`Series: ${status.title} (${bookId})`);
        log(`  Episodes: ${status.chaptersWritten}`);
        log(`  Next episode: ${status.nextChapter}`);
        log(`  Status: ${status.status}`);
        if (status.episodePerformance) {
          log(`  Model calls: ${status.episodePerformance.totalCalls}`);
          log(`  Tokens: ${status.episodePerformance.totalTokens.toLocaleString()}`);
          log(`  Avg context: ${status.episodePerformance.averageContextEstimatedTokens.toLocaleString()} est. tokens`);
          log(`  Cache: ${status.episodePerformance.cacheHits} hit / ${status.episodePerformance.cacheMisses} miss`);
        }
      }
    } catch (error) {
      logError(`Failed to read series status: ${error}`);
      process.exitCode = 1;
    }
  });

seriesCommand
  .command("complete")
  .argument("[book-id]", "Series ID")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean }) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const report = await pipeline.completeSeries(bookId);
      if (opts.json) {
        log(JSON.stringify(report, null, 2));
      } else if (report.completed) {
        log(`Series ${bookId} passed the completion gate.`);
      } else {
        log(`Series ${bookId} is not complete.`);
        for (const issue of report.issues) log(`  [${issue.severity}] ${issue.message}`);
        process.exitCode = 1;
      }
    } catch (error) {
      logError(`Failed to complete series: ${error}`);
      process.exitCode = 1;
    }
  });
