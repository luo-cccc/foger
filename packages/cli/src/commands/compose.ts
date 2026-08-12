import { Command } from "commander";
import { executeCoreMutation, PipelineRunner, StateManager } from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId, resolveContext } from "../utils.js";

export const composeCommand = new Command("compose")
  .description("Compose episode runtime artifacts");

composeCommand
  .command("episode")
  .description("Generate context/rule-stack/trace artifacts for the next episode")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--context <text>", "Episode steering guidance")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const config = await loadConfig({ requireApiKey: false });
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);

      const pipeline = new PipelineRunner(
        buildPipelineConfig(config, root, {
          externalContext: context,
          quiet: opts.quiet,
        }),
      );
      const state = new StateManager(root);

      const result = await executeCoreMutation({ state, pipeline }, {
        kind: "compose-episode",
        bookId,
        context,
      });

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`Composed episode ${result.episodeNumber} for "${bookId}"`);
        log(`  Intent: ${result.intentPath}`);
        log(`  Context: ${result.contextPath}`);
        log(`  Rule stack: ${result.ruleStackPath}`);
        log(`  Trace: ${result.tracePath}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to compose episode: ${e}`);
      }
      process.exit(1);
    }
  });
