import { Command } from "commander";
import { executeCoreMutation, PipelineRunner, StateManager } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";
import {
  formatNotifyAuditBody,
  formatNotifyCommandTitle,
  formatNotifyFailureBody,
  resolveCliLanguage,
  type CliLanguage,
} from "../localization.js";
import { sendCommandNotification } from "../notify-helper.js";

export const auditCommand = new Command("audit")
  .description("Audit a episode for continuity issues")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .argument("[episode]", "Episode number (defaults to latest)")
  .option("--json", "Output JSON")
  .option("--notify", "Send a notification to configured notify channels when the command finishes")
  .action(async (bookIdArg: string | undefined, episodeStr: string | undefined, opts) => {
    let notifyLanguage: CliLanguage = "zh";
    let notifyBookName: string | undefined;
    try {
      const config = await loadConfig();
      const root = findProjectRoot();

      // If first arg looks like a number, treat it as episode (auto-detect book)
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

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root));

      if (!opts.json) log(`Auditing "${bookId}"${episodeNumber ? ` episode ${episodeNumber}` : " (latest)"}...`);

      const result = await executeCoreMutation({ state, pipeline }, {
        kind: "audit-episode",
        bookId,
        episodeNumber,
      });

      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`  Episode ${result.episodeNumber}: ${result.passed ? "PASSED" : "FAILED"}`);
        log(`  Summary: ${result.summary}`);
        if (result.issues.length > 0) {
          log("  Issues:");
          for (const issue of result.issues) {
            log(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
          }
        }
      }

      // Unlike write commands, the pipeline sends no notification for
      // auditDraft, so --notify always sends the completion notification here.
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(language, "audit", notifyBookName, true),
          body: formatNotifyAuditBody(language, {
            episodeNumber: result.episodeNumber,
            passed: result.passed,
            issueCount: result.issues.length,
            summary: result.summary,
          }),
        }, config);
      }
    } catch (e) {
      if (opts.notify) {
        await sendCommandNotification({
          title: formatNotifyCommandTitle(notifyLanguage, "audit", notifyBookName, false),
          body: formatNotifyFailureBody(notifyLanguage, e),
        });
      }
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Audit failed: ${e}`);
      }
      process.exit(1);
    }
  });
