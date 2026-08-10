import { Command } from "commander";
import {
  StateManager,
  evaluateBookQuality,
} from "@actalk/inkos-core";
import { findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const evalCommand = new Command("eval")
  .description("Evaluate writing quality for a book — outputs structured quality report")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON only")
  .option("--episodes <range>", "Episode range (e.g. 1-10, 5-20)")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean; episodes?: string }) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const result = await evaluateBookQuality({ state, bookId, episodes: opts.episodes });

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`\nQuality Report: "${bookId}"\n`);
        log(`  Quality Score: ${result.qualityScore}/100`);
        log(`  Episodes: ${result.totalEpisodes}`);
        log(`  Total duration: ${result.totalDurationSeconds.toLocaleString()}s`);
        log("");
        log("  Dimensions:");
        log(`    Audit pass rate:      ${result.auditPassRate}%`);
        log(`    AI tell density:      ${result.avgAiTellDensity.toFixed(2)} / 1k chars`);
        log(`    Paragraph warnings:   ${result.avgParagraphWarnings.toFixed(1)} avg/episode`);
        log(`    Hook resolve rate:    ${result.hookResolveRate}%`);
        log(`    Duplicate titles:     ${result.duplicateTitles}`);
        log("");
        log("  Quality Trend:");
        for (const { episode, score } of result.qualityTrend) {
          const bar = "█".repeat(Math.round(score / 5)) + "░".repeat(20 - Math.round(score / 5));
          log(`    Ep.${String(episode).padStart(3)} ${bar} ${score}`);
        }
        log("");

        // Drift detection: compare first half vs second half
        if (result.qualityTrend.length >= 6) {
          const mid = Math.floor(result.qualityTrend.length / 2);
          const firstHalf = result.qualityTrend.slice(0, mid).reduce((s, c) => s + c.score, 0) / mid;
          const secondHalf = result.qualityTrend.slice(mid).reduce((s, c) => s + c.score, 0) / (result.qualityTrend.length - mid);
          const drift = Math.round(secondHalf - firstHalf);
          log(`  Quality Drift: ${drift > 0 ? "+" : ""}${drift} (${drift >= 0 ? "stable/improving" : "DEGRADING"})`);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Eval failed: ${e}`);
      }
      process.exit(1);
    }
  });
