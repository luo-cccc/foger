import { Command } from "commander";
import { PipelineRunner, StateManager, executeEpisodeMutation, resolveEpisodeReviewMode } from "@actalk/inkos-core";
import { createInterface } from "node:readline";
import { loadConfig, buildPipelineConfig, findProjectRoot, getLegacyMigrationHint, resolveContext, resolveBookId, log, logError } from "../utils.js";
import {
  formatEpisodeRecoveryNotice,
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
import { withEpisodeCheckpoint } from "../episode-checkpoint.js";

export const writeCommand = new Command("write")
  .description("Write episodes");

writeCommand
  .command("next")
  .description("Write the next episode for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--count <n>", "Number of episodes to write", "1")
  .option("--duration <seconds>", "Target duration per episode (overrides book config)")
  .option("--context <text>", "Creative guidance (natural language)")
  .option("--context-file <path>", "Read guidance from file")
  .option("--json", "Output JSON")
  .option("-q, --quiet", "Suppress console output")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const context = await resolveContext(opts);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      notifyLanguage = language;
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint) throw new Error(migrationHint);
      const config = await loadConfig();

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: context,
        quiet: opts.quiet,
        episodeReviewMode: resolveEpisodeReviewMode(book, config.writing),
      }));

      const count = parseInt(opts.count, 10);
      const episodeDurationSeconds = opts.duration ? parseInt(opts.duration, 10) : undefined;

      const results = [];
      for (let i = 0; i < count; i++) {
        if (!opts.json) log(formatWriteNextProgress(language, i + 1, count, bookId));

        const result = await pipeline.writeNextEpisode(bookId, episodeDurationSeconds);
        results.push(result);

        if (!opts.json) {
          const recoveryNotice = formatEpisodeRecoveryNotice(language, result.recovery);
          if (recoveryNotice) log(recoveryNotice);
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

        if (result.status === "audit-failed") {
          if (!opts.json) {
            log(language === "en"
              ? "Audit review required before continuing. Stopping batch."
              : "需要先处理审计问题，已停止后续连写。");
          }
          break;
        }

        if (result.status === "state-degraded") {
          if (!opts.json) {
            log(language === "en"
              ? "State repair required before continuing. Stopping batch."
              : "需要先修复 state，已停止后续连写。");
          }
          break;
        }
      }

      if (opts.json) {
        log(JSON.stringify(results.map(withEpisodeCheckpoint), null, 2));
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
          title: formatNotifyCommandTitle(language, "write-next", notifyBookName, true),
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
          title: formatNotifyCommandTitle(notifyLanguage, "write-next", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to write episode: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("rewrite")
  .description("Re-generate a specific episode: rewrite [book-id] <episode>")
  .argument("<args...>", "Book ID (optional) and episode number")
  .option("--force", "Skip confirmation prompt")
  .option("--duration <seconds>", "Target duration per episode (overrides book config)")
  .option("--brief <text>", "One-off creative guidance for this rewrite only")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (args: ReadonlyArray<string>, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const root = findProjectRoot();

      let bookId: string;
      let episode: number;
      if (args.length === 1) {
        episode = parseInt(args[0]!, 10);
        if (isNaN(episode)) throw new Error(`Expected episode number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        episode = parseInt(args[1]!, 10);
        if (isNaN(episode)) throw new Error(`Expected episode number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write rewrite [book-id] <episode>");
      }

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Rewrite episode ${episode} of "${bookId}"? This will delete episode ${episode} and all later episodes. (y/N) `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log("Cancelled.");
          return;
        }
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      notifyLanguage = resolveCliLanguage(book.language);
      notifyBookName = book.title ?? bookId;
      const migrationHint = await getLegacyMigrationHint(root, bookId);
      if (migrationHint && !opts.json) {
        log(`[migration] ${migrationHint}`);
      }

      if (!opts.json) log(`Regenerating episode ${episode}...`);

      const episodeDurationSeconds = opts.duration ? parseInt(opts.duration, 10) : undefined;

      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
        episodeReviewMode: resolveEpisodeReviewMode(book, config.writing),
      }));

      const result = await executeEpisodeMutation({ state, pipeline }, {
        kind: "rewrite",
        bookId,
        episodeNumber: episode,
        episodeDurationSeconds,
        brief: opts.brief,
      });
      const language = resolveCliLanguage(book.language);

      if (opts.json) {
        log(JSON.stringify(withEpisodeCheckpoint(result), null, 2));
      } else {
        const recoveryNotice = formatEpisodeRecoveryNotice(language, result.recovery);
        if (recoveryNotice) log(recoveryNotice);
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
      }

      // Success notification intentionally skipped: the pipeline already sent
      // the per-episode notification for this exact episode (runner.ts, end of
      // writeNextEpisode) — a command-level one would be a duplicate. --notify
      // only adds the failure notification for this command.
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "write-rewrite", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to rewrite episode: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("sync")
  .description("Rebuild truth files and SQLite indexes from the latest edited episode body")
  .argument("<args...>", "Book ID (optional) and episode number")
  .option("--brief <text>", "One-off guidance for how to interpret the edited episode while syncing")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();

      let bookId: string;
      let episode: number;
      if (args.length === 1) {
        episode = parseInt(args[0]!, 10);
        if (isNaN(episode)) throw new Error(`Expected episode number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        episode = parseInt(args[1]!, 10);
        if (isNaN(episode)) throw new Error(`Expected episode number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write sync [book-id] <episode>");
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, {
        externalContext: opts.brief,
      }));
      const result = await pipeline.resyncEpisodeArtifacts(bookId, episode);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
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
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to sync episode artifacts: ${e}`);
      }
      process.exit(1);
    }
  });

writeCommand
  .command("repair-state")
  .description("Rebuild truth files for a persisted state-degraded episode without rewriting body text")
  .argument("<args...>", "Book ID (optional) and episode number")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();

      let bookId: string;
      let episode: number;
      if (args.length === 1) {
        episode = parseInt(args[0]!, 10);
        if (isNaN(episode)) throw new Error(`Expected episode number, got "${args[0]}"`);
        bookId = await resolveBookId(undefined, root);
      } else if (args.length === 2) {
        episode = parseInt(args[1]!, 10);
        if (isNaN(episode)) throw new Error(`Expected episode number, got "${args[1]}"`);
        bookId = await resolveBookId(args[0], root);
      } else {
        throw new Error("Usage: inkos write repair-state [book-id] <episode>");
      }

      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const language = resolveCliLanguage(book.language);
      const config = await loadConfig();
      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
      const result = await pipeline.repairEpisodeState(bookId, episode);

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
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
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to repair episode state: ${e}`);
      }
      process.exit(1);
    }
  });
