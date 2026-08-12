import { Command } from "commander";
import {
  StateManager,
  detectEpisode,
  loadDetectionHistory,
  analyzeDetectionInsights,
  type DetectionConfig,
} from "@actalk/inkos-core";
import { loadConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const detectCommand = new Command("detect")
  .description("Run AIGC detection on episodes")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[episode]", "Episode number (defaults to latest)")
  .option("--all", "Detect all episodes")
  .option("--stats", "Show detection statistics")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, episodeStr: string | undefined, opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      if (!config.detection?.enabled) {
        logError("AIGC detection is not enabled. Add detection config to inkos.json.");
        process.exit(1);
      }

      // If first arg looks like a number, treat it as episode
      let bookId: string;
      let episodeNumber: number | undefined;
      if (bookIdArg && /^\d+$/.test(bookIdArg)) {
        bookId = await resolveBookId(undefined, root);
        episodeNumber = parseInt(bookIdArg, 10);
      } else {
        bookId = await resolveBookId(bookIdArg, root);
        episodeNumber = episodeStr ? parseInt(episodeStr, 10) : undefined;
      }

      const state = new StateManager(root);
      const bookDir = state.bookDir(bookId);
      await state.loadEpisodeBookConfig(bookId);

      if (opts.stats) {
        const history = await loadDetectionHistory(bookDir);
        const stats = analyzeDetectionInsights(history);
        if (opts.json) {
          log(JSON.stringify(stats, null, 2));
        } else {
          log(`Detection Statistics:`);
          log(`  Total detections: ${stats.totalDetections}`);
          log(`  Total rewrites: ${stats.totalRewrites}`);
          log(`  Avg original score: ${stats.avgOriginalScore.toFixed(3)}`);
          log(`  Avg final score: ${stats.avgFinalScore.toFixed(3)}`);
          log(`  Avg score reduction: ${stats.avgScoreReduction.toFixed(3)}`);
          log(`  Pass rate: ${(stats.passRate * 100).toFixed(0)}%`);
          if (stats.episodeBreakdown.length > 0) {
            log(`  Episodes:`);
            for (const episode of stats.episodeBreakdown) {
              log(`    Ep.${episode.episodeNumber}: ${episode.originalScore.toFixed(3)} → ${episode.finalScore.toFixed(3)} (${episode.rewriteAttempts} rewrites)`);
            }
          }
        }
        return;
      }

      const detectionConfig = config.detection as DetectionConfig;

      if (opts.all) {
        const index = await state.loadEpisodeIndex(bookId);
        for (const episode of index) {
          const content = await readEpisodeContent(bookDir, episode.episodeNumber);
          const result = await detectEpisode(detectionConfig, content, episode.episodeNumber);
          printResult(result, opts.json);
        }
      } else {
        const targetEpisode = episodeNumber ?? (await state.getNextEpisodeNumber(bookId)) - 1;
        if (targetEpisode < 1) {
          logError("No episodes to detect.");
          process.exit(1);
        }
        const content = await readEpisodeContent(bookDir, targetEpisode);
        const result = await detectEpisode(detectionConfig, content, targetEpisode);
        printResult(result, opts.json);
      }
    } catch (e) {
      logError(`Detection failed: ${e}`);
      process.exit(1);
    }
  });

function printResult(
  result: { episodeNumber: number; detection: { score: number; provider: string }; passed: boolean },
  json: boolean,
): void {
  if (json) {
    log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.passed ? "✅" : "⚠️";
    log(`  ${icon} Episode ${result.episodeNumber}: score=${result.detection.score.toFixed(3)} (${result.detection.provider}) ${result.passed ? "PASS" : "FAIL"}`);
  }
}

async function readEpisodeContent(bookDir: string, episodeNumber: number): Promise<string> {
  const episodesDir = join(bookDir, "episodes");
  const files = await readdir(episodesDir);
  const paddedNum = String(episodeNumber).padStart(4, "0");
  const episodeFile = files.find((f) => f.startsWith(paddedNum) && f.endsWith(".md"));
  if (!episodeFile) {
    throw new Error(`Episode ${episodeNumber} file not found`);
  }
  const raw = await readFile(join(episodesDir, episodeFile), "utf-8");
  const lines = raw.split("\n");
  const contentStart = lines.findIndex((l, i) => i > 0 && l.trim().length > 0);
  return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
}
