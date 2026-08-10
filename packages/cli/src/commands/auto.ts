import { Command } from "commander";
import { PipelineRunner, StateManager } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, getLegacyMigrationHint, resolveBookId, log, logError } from "../utils.js";
import {
  formatAutoWriteAlreadyComplete,
  formatAutoWriteStart,
  formatNotifyBatchWriteBody,
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  formatWriteNextComplete,
  formatWriteNextProgress,
  formatWriteNextResultLines,
  resolveCliLanguage,
  type CliLanguage,
} from "../localization.js";
import { sendCommandNotification } from "../notify-helper.js";

export const autoCommand = new Command("auto")
  .description("Auto-write episodes until the book reaches a target episode number: auto [book-id] <target-episode>")
  .argument("<args...>", "Book ID (optional, auto-detected if only one book) and target episode number")
  .option("--duration <seconds>", "Target duration per episode (overrides book config)")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (args: ReadonlyArray<string>, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();

      let bookId: string;
      let targetEpisode: number;
      if (args.length === 1) {
        targetEpisode = parseInt(args[0]!, 10);
        if (isNaN(targetEpisode)) throw new Error(`Expected target episode number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        targetEpisode = parseInt(args[1]!, 10);
        if (isNaN(targetEpisode)) throw new Error(`Expected target episode number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos auto [book-id] <target-episode>");
      }
      if (targetEpisode < 1) {
        throw new Error(`Target episode must be >= 1, got ${targetEpisode}`);
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      notifyLanguage = language;
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
        log(`[migration] ${migrationHint}`);
      }

      const startEpisode = await state.getNextEpisodeNumber(bookId);
      if (startEpisode > targetEpisode) {
        if (opts.json) {
          log(JSON.stringify([], null, 2));
        } else {
          log(formatAutoWriteAlreadyComplete(language, bookId, startEpisode - 1, targetEpisode));
        }
        return;
      }

      const config = await loadConfig();
      // `inkos auto` is unattended batch writing, so the audit→revise loop must
      // run inline: force "auto" regardless of book/project reviewMode settings.
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        quiet: opts.quiet,
        episodeReviewMode: "auto",
      }));

      if (!opts.json) log(formatAutoWriteStart(language, bookId, startEpisode, targetEpisode));

      const episodeDurationSeconds = opts.duration ? parseInt(opts.duration, 10) : undefined;

      const results = [];
      for (let episode = startEpisode; episode <= targetEpisode; episode++) {
        if (!opts.json) log(formatWriteNextProgress(language, episode, targetEpisode, bookId));

        let result;
        try {
          result = await pipeline.writeNextEpisode(bookId, episodeDurationSeconds);
        } catch (e) {
          throw new Error(
            `Episode ${episode} failed, stopping auto-write (${results.length} episode(s) completed this run): ${e instanceof Error ? e.message : String(e)}`,
            { cause: e },
          );
        }
        results.push(result);

        if (!opts.json) {
          for (const line of formatWriteNextResultLines(language, {
            episodeNumber: result.episodeNumber,
            title: result.title,
            episodeDurationSeconds: result.episodeDurationSeconds,
            auditPassed: result.auditResult.passed,
            revised: result.revised,
            status: result.status,
            issues: result.auditResult.issues,
          })) {
            log(line);
          }
          log("");
        }

        if (result.status === "state-degraded") {
          throw new Error(
            `Episode ${result.episodeNumber} finished in state-degraded status, stopping auto-write. Run "inkos write repair-state ${bookId} ${result.episodeNumber}" first, then re-run inkos auto.`,
          );
        }
        if (result.status === "audit-failed") {
          throw new Error(
            `Episode ${result.episodeNumber} finished in audit-failed status, stopping auto-write. Revise or rewrite that episode before re-running inkos auto.`,
          );
        }
      }

      if (opts.json) {
        log(JSON.stringify(results, null, 2));
      } else {
        log(formatWriteNextComplete(language));
      }

      // The pipeline itself already sends one notification per completed
      // episode whenever notify channels are configured (runner.ts, end of
      // writeNextEpisode). A single-episode run would therefore duplicate that
      // exact notification — only send a command-level batch summary when this
      // run wrote more than one episode.
      if (opts.notify && results.length > 1) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(language, "auto", notifyBookName, true),
          body: formatNotifyBatchWriteBody(language, results.map((r) => ({
            episodeNumber: r.episodeNumber,
            title: r.title,
            episodeDurationSeconds: r.episodeDurationSeconds,
            auditPassed: r.auditResult.passed,
          }))),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "auto", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Auto-write failed: ${e}`);
      }
      process.exit(1);
    }
  });
