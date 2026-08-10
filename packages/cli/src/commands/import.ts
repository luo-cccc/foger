import { Command } from "commander";
import { PipelineRunner, StateManager, loadEpisodesFromPath } from "@actalk/inkos-core";
import { resolve } from "node:path";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatImportCanonComplete,
  formatImportCanonStart,
  formatImportEpisodesComplete,
  formatImportEpisodesDiscovery,
  formatImportEpisodesResume,
  resolveCliLanguage,
} from "../localization.js";

export const importCommand = new Command("import")
  .description("Import external data into a book");

importCommand
  .command("canon")
  .description("Import parent book's canon for spinoff writing")
  .argument("[target-book-id]", "Target book ID (auto-detected if only one book)")
  .requiredOption("--from <parent-book-id>", "Parent book ID to import canon from")
  .option("--json", "Output JSON")
  .action(async (targetBookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const targetBookId = await resolveBookId(targetBookIdArg, root);
      const config = await loadConfig();
      const state = new StateManager(root);
      const targetBook = await state.loadBookConfig(targetBookId);
      const language = resolveCliLanguage(targetBook.language);

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      if (!opts.json) log(formatImportCanonStart(language, opts.from, targetBookId));

      await pipeline.importCanon(targetBookId, opts.from);

      if (opts.json) {
        log(JSON.stringify({
          targetBookId,
          parentBookId: opts.from,
          output: "story/parent_canon.md",
        }, null, 2));
      } else {
        for (const line of formatImportCanonComplete(language)) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Canon import failed: ${e}`);
      }
      process.exit(1);
    }
  });

importCommand
  .command("episodes")
  .description("Import EpisodeScript JSON/Markdown files for continuation writing.")
  .argument("[book-id]", "Target book ID (auto-detected if only one book)")
  .requiredOption("--from <path>", "Path to an EpisodeScript JSON/Markdown file or directory of .md/.json files")
  .option("--split <regex>", "Custom regex for episode splitting (single-file mode)")
  .option("--resume-from <n>", "Resume from episode N (for interrupted imports)", parseInt)
  .option("--series", "Treat as a new series (shared universe, independent story) instead of direct continuation")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const config = await loadConfig();

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      const existingEpisodeCount = (await state.getNextEpisodeNumber(bookId)) - 1;
      if (existingEpisodeCount > 0 && !opts.resumeFrom) {
        throw new Error(
          `Book "${bookId}" already has ${existingEpisodeCount} episode(s). ` +
          `Use --resume-from <n> to append, or delete existing episodes first.`
        );
      }

      const fromPath = resolve(opts.from);
      const episodes = [...await loadEpisodesFromPath(fromPath, opts.split)];

      if (!opts.json) {
        log(formatImportEpisodesDiscovery(language, episodes.length, bookId));
        if (opts.resumeFrom) {
          log(formatImportEpisodesResume(language, opts.resumeFrom));
        }
      }

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      const result = await pipeline.importEpisodes({
        bookId,
        episodes,
        resumeFrom: opts.resumeFrom,
        importMode: opts.series ? "series" : "continuation",
      });

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        for (const line of formatImportEpisodesComplete(language, {
          importedCount: result.importedCount,
          totalDurationSeconds: result.totalDurationSeconds,
          nextEpisode: result.nextEpisode,
          continueBookId: bookId,
        })) {
          log(line);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Episode import failed: ${e}`);
      }
      process.exit(1);
    }
  });
