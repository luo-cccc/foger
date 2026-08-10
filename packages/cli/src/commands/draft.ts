import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveContext, resolveBookId, log, logError } from "../utils.js";

export const draftCommand = new Command("draft")
  .description("Write a draft episode (no audit/revise)")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--duration <seconds>", "Target duration per episode (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig();
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { quiet: opts.quiet }));

      const episodeDurationSeconds = opts.duration ? parseInt(opts.duration, 10) : undefined;

      if (!opts.json) log(`Writing draft for "${bookId}"...`);

      const result = await pipeline.writeDraft(bookId, context, episodeDurationSeconds);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`  Episode ${result.episodeNumber}: ${result.title}`);
        log(`  Duration: ${result.episodeDurationSeconds}s`);
        log(`  File: ${result.filePath}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to write draft: ${e}`);
      }
      process.exit(1);
    }
  });
