import { Command } from "commander";
import { StateManager, executeCoreMutation } from "@actalk/inkos-core";
import { findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const reviewCommand = new Command("review")
  .description("Review and approve episodes");

reviewCommand
  .command("list")
  .description("List episodes pending review")
  .argument("[book-id]", "Book ID (optional, lists all books if omitted)")
  .option("--json", "Output JSON")
  .action(async (bookId: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);

      const bookIds = bookId ? [bookId] : await state.listBooks();
      const allPending: Array<{
        readonly bookId: string;
        readonly title: string;
        readonly episode: number;
        readonly episodeTitle: string;
        readonly episodeDurationSeconds: number;
        readonly status: string;
        readonly issues: ReadonlyArray<string>;
      }> = [];

      for (const id of bookIds) {
        const index = await state.loadEpisodeIndex(id);
        const pending = index.filter(
          (ch) =>
            ch.status === "ready-for-review" || ch.status === "audit-failed",
        );

        if (pending.length === 0) continue;

        const book = await state.loadBookConfig(id);

        if (!opts.json) {
          log(`\n${book.title} (${id}):`);
        }
        for (const ch of pending) {
          allPending.push({
            bookId: id,
            title: book.title,
            episode: ch.episodeNumber,
            episodeTitle: ch.title,
            episodeDurationSeconds: ch.episodeDurationSeconds,
            status: ch.status,
            issues: ch.auditIssues,
          });
          if (!opts.json) {
            log(
              `  Ep.${ch.episodeNumber} "${ch.title}" | ${ch.episodeDurationSeconds}s | ${ch.status}`,
            );
            if (ch.auditIssues.length > 0) {
              for (const issue of ch.auditIssues) {
                log(`    - ${issue}`);
              }
            }
          }
        }
      }

      if (opts.json) {
        log(JSON.stringify({ pending: allPending }, null, 2));
      } else if (allPending.length === 0) {
        log("No episodes pending review.");
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to list reviews: ${e}`);
      }
      process.exit(1);
    }
  });

/**
 * Parse "[book-id] <episode>" style arguments from variadic args.
 * Supports: "3" (auto-detect book) or "my-book 3"
 */
function parseBookAndEpisode(
  args: ReadonlyArray<string>,
): { readonly bookIdArg: string | undefined; readonly episodeNum: number } {
  if (args.length === 1) {
    const num = parseInt(args[0]!, 10);
    if (isNaN(num)) {
      throw new Error(`Expected episode number, got "${args[0]}"`);
    }
    return { bookIdArg: undefined, episodeNum: num };
  }
  if (args.length === 2) {
    const num = parseInt(args[1]!, 10);
    if (isNaN(num)) {
      throw new Error(`Expected episode number as second argument, got "${args[1]}"`);
    }
    return { bookIdArg: args[0], episodeNum: num };
  }
  throw new Error("Usage: inkos review approve [book-id] <episode>");
}

reviewCommand
  .command("approve")
  .description("Approve an audited episode: approve [book-id] <episode>")
  .argument("<args...>", "Book ID (optional) and episode number")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookIdArg, episodeNum } = parseBookAndEpisode(args);
      const bookId = await resolveBookId(bookIdArg, root);

      const state = new StateManager(root);
      await executeCoreMutation({ state }, {
        kind: "approve",
        bookId,
        episodeNumber: episodeNum,
      });

      if (opts.json) {
        log(JSON.stringify({ bookId, episode: episodeNum, status: "approved" }));
      } else {
        log(`Episode ${episodeNum} approved.`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to approve: ${e}`);
      }
      process.exit(1);
    }
  });

reviewCommand
  .command("approve-all")
  .description("Approve all pending episodes for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);

      const result = await executeCoreMutation({ state }, { kind: "approve-all", bookId });

      if (opts.json) {
        log(JSON.stringify({ bookId, approvedCount: result.approvedCount }));
      } else {
        log(`${result.approvedCount} episode(s) approved.`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to approve: ${e}`);
      }
      process.exit(1);
    }
  });

reviewCommand
  .command("reject")
  .description("Reject a episode and roll back state: reject [book-id] <episode>")
  .argument("<args...>", "Book ID (optional) and episode number")
  .option("--reason <reason>", "Rejection reason")
  .option("--keep-subsequent", "Keep the rejected episode artifact only when no later episode depends on it")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookIdArg, episodeNum } = parseBookAndEpisode(args);
      const bookId = await resolveBookId(bookIdArg, root);

      const state = new StateManager(root);
      const result = await executeCoreMutation({ state }, {
        kind: "reject",
        bookId,
        episodeNumber: episodeNum,
        reason: opts.reason,
        keepSubsequent: Boolean(opts.keepSubsequent),
      });

      if (result.keepSubsequent) {
        if (opts.json) {
          log(JSON.stringify({ bookId, episode: episodeNum, status: "rejected", discarded: result.discarded }));
        } else {
          log(`Episode ${episodeNum} rejected (state not rolled back).`);
        }
        return;
      }

      if (opts.json) {
        log(JSON.stringify({
          bookId,
          episode: episodeNum,
          status: "rejected",
          rolledBackTo: result.rolledBackTo,
          discarded: result.discarded,
        }));
      } else {
        log(`Episode ${episodeNum} rejected. State rolled back to episode ${result.rolledBackTo}.`);
        if (result.discarded.length > 1) {
          log(`  Also discarded ${result.discarded.length - 1} subsequent episode(s): ${result.discarded.filter((n) => n !== episodeNum).join(", ")}`);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to reject: ${e}`);
      }
      process.exit(1);
    }
  });
