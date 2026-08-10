import { Command } from "commander";
import { StateManager, writeExportArtifact } from "@actalk/inkos-core";
import { join } from "node:path";
import { findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const exportCommand = new Command("export")
  .description("Export a comic-drama screenplay to a single file")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--format <format>", "Output format (screenplay-md, screenplay-json, dialogue)", "screenplay-md")
  .option("--output <path>", "Output file path")
  .option("--approved-only", "Only export approved episodes")
  .option("--json", "Output JSON metadata")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);

      const result = await writeExportArtifact(state, bookId, {
        format: opts.format as "screenplay-md" | "screenplay-json" | "dialogue",
        approvedOnly: Boolean(opts.approvedOnly),
        outputPath: opts.output ?? join(root, `${bookId}_export.${opts.format}`),
      });

      if (opts.json) {
        log(JSON.stringify({
          bookId,
          episodesExported: result.episodesExported,
          totalDurationSeconds: result.totalDurationSeconds,
          format: result.format,
          outputPath: result.outputPath,
        }, null, 2));
      } else {
        log(`Exported ${result.episodesExported} episodes (${result.totalDurationSeconds}s total)`);
        log(`Output: ${result.outputPath}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to export: ${e}`);
      }
      process.exit(1);
    }
  });
