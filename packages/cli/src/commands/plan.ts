import { Command } from "commander";
import { executeCoreMutation, PipelineRunner, StateManager } from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId, resolveContext } from "../utils.js";

export const planCommand = new Command("plan")
  .description("Plan episode input artifacts");

planCommand
  .command("episode")
  .description("Generate episode intent for the next episode")
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
          inputGovernanceMode: "v2",
          quiet: opts.quiet,
        }),
      );
      const state = new StateManager(root);

      const result = await executeCoreMutation({ state, pipeline }, {
        kind: "plan-episode",
        bookId,
        context,
      });

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`Planned episode ${result.episodeNumber} for "${bookId}"`);
        log(`  Goal: ${result.goal}`);
        log(`  Intent: ${result.intentPath}`);
        if (result.capacity) {
          log(`  Capacity: promised beats ${result.capacity.promisedBeats}`
            + (result.capacity.estimatedShots !== undefined
              ? `, est. ${result.capacity.estimatedShots} shots / ${result.capacity.estimatedDurationSeconds}s`
              : ""));
          if (result.capacity.note) {
            log(`  Note: ${result.capacity.note}`);
          }
        }
        if (result.conflicts.length > 0) {
          log("  Conflicts:");
          for (const conflict of result.conflicts) {
            log(`    - ${conflict}`);
          }
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to plan episode: ${e}`);
      }
      process.exit(1);
    }
  });
