import { Command } from "commander";
import {
  PipelineRunner,
  StateManager,
} from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const foundationCommand = new Command("foundation")
  .description("Maintain the series foundation (settings)");

export const canonCommand = new Command("canon")
  .description("Manage structured canon claims");

foundationCommand
  .command("extend")
  .description("Rewrite volume_map to cover a new target episode count (keeps story_frame / roles / rules)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--episodes <n>", "New target episode count (defaults to the book's targetEpisodes)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { episodes?: string; json?: boolean }) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {}));
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const targetEpisodes = opts.episodes
        ? parseInt(opts.episodes, 10)
        : (book.targetEpisodes ?? 100);
      const result = await pipeline.extendFoundation(bookId, targetEpisodes);
      if (opts.json) {
        log(JSON.stringify({
          bookId,
          targetEpisodes,
          volumeMap: result.volumeMap,
          warnings: result.warnings,
        }, null, 2));
        return;
      }
      log(`Foundation volume_map extended to ${targetEpisodes} episodes (${book.title}).`);
      for (const warning of result.warnings) {
        logError(`  [warning] ${warning}`);
      }
    } catch (e) {
      logError(`Failed to extend foundation: ${e}`);
      process.exit(1);
    }
  });

canonCommand
  .command("refresh")
  .description("Turn unclaimed episode facts into new canon claims (one explicit LLM call)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts: { json?: boolean }) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {}));
      const result = await pipeline.refreshCanon(bookId);
      if (opts.json) {
        log(JSON.stringify(result, null, 2));
        return;
      }
      log(`Canon refresh complete: ${result.added} new claim(s) added for ${bookId}.`);
    } catch (e) {
      logError(`Failed to refresh canon: ${e}`);
      process.exit(1);
    }
  });
