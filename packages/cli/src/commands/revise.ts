import { Command } from "commander";
import { DEFAULT_REVISE_MODE, PipelineRunner, ReviseModeSchema, StateManager, resolveRevisionGate } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  formatNotifyReviseBody,
  resolveCliLanguage,
  type CliLanguage,
} from "../localization.js";
import { sendCommandNotification } from "../notify-helper.js";

export const reviseCommand = new Command("revise")
  .description("Revise a episode based on audit issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[episode]", "Episode number (defaults to latest)")
  .option("--mode <mode>", "Revise mode: spot-fix, polish, rewrite, rework, anti-detect", DEFAULT_REVISE_MODE)
  .option("--brief <text>", "One-off creative guidance for this revise/rewrite only")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, episodeStr: string | undefined, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

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
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      notifyLanguage = language;
      notifyBookName = book.title ?? bookId;
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
        revisionGate: resolveRevisionGate(book, config.writing),
      }));

      const mode = ReviseModeSchema.parse(opts.mode);
      if (!opts.json) log(`Revising "${bookId}"${episodeNumber ? ` episode ${episodeNumber}` : " (latest)"} [mode: ${mode}]...`);

      const result = await pipeline.reviseDraft(bookId, episodeNumber, mode);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else if (!result.applied) {
        log(`  Episode ${result.episodeNumber}: kept original draft`);
        if (result.skippedReason) log(`  Reason: ${result.skippedReason}`);
      } else {
        log(`  Episode ${result.episodeNumber} revised`);
        log(`  Duration: ${result.episodeDurationSeconds}s`);
        log(`  Status: ${result.status}`);
        log("  Fixed:");
        for (const fix of result.fixedIssues) {
          log(`    - ${fix}`);
        }
      }

      // Unlike write commands, the pipeline sends no notification for
      // reviseDraft, so --notify always sends the completion notification here.
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(language, "revise", notifyBookName, true),
          body: formatNotifyReviseBody(language, {
            episodeNumber: result.episodeNumber,
            applied: result.applied,
            episodeDurationSeconds: result.episodeDurationSeconds,
            fixedCount: result.fixedIssues.length,
            skippedReason: result.skippedReason,
          }),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "revise", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Revise failed: ${e}`);
      }
      process.exit(1);
    }
  });
