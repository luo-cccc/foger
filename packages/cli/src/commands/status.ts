import { Command } from "commander";
import { StateManager } from "@actalk/inkos-core";
import { findProjectRoot, getLegacyMigrationHint, log, logError } from "../utils.js";

export const statusCommand = new Command("status")
  .description("Show project status")
  .argument("[book-id]", "Book ID (optional, shows all if omitted)")
  .option("--episodes", "Show per-episode status and issues")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);

      const allBookIds = await state.listBooks();
      const bookIds = bookIdArg ? [bookIdArg] : allBookIds;

      if (bookIdArg && !allBookIds.includes(bookIdArg)) {
        throw new Error(
          `Book "${bookIdArg}" not found. Available: ${allBookIds.join(", ") || "(none)"}`,
        );
      }

      const booksData = [];

      if (!opts.json) {
        log(`InkOS Project: ${root}`);
        log(`Books: ${allBookIds.length}`);
        log("");
      }

      for (const id of bookIds) {
        const book = await state.loadBookConfig(id);
        const index = await state.loadEpisodeIndex(id);
        const migrationHint = await getLegacyMigrationHint(root, id);
        const persistedEpisodeCount = await state.getPersistedEpisodeCount(id);
        const approved = index.filter((ch) => ch.status === "approved").length;
        const pending = index.filter(
          (ch) => ch.status === "ready-for-review",
        ).length;
        const failed = index.filter(
          (ch) => ch.status === "audit-failed",
        ).length;
        const degraded = index.filter(
          (ch) => ch.status === "state-degraded",
        ).length;
        const totalDurationSeconds = index.reduce((sum, episode) => sum + episode.episodeDurationSeconds, 0);
        const avgDurationSeconds = index.length > 0 ? Math.round(totalDurationSeconds / index.length) : 0;

        booksData.push({
          id,
          title: book.title,
          status: book.status,
          genre: book.genre,
          platform: book.platform,
          episodes: persistedEpisodeCount,
          targetEpisodes: book.targetEpisodes,
          totalDurationSeconds,
          avgDurationSeconds,
          approved,
          pending,
          failed,
          degraded,
          ...(migrationHint ? { migrationHint } : {}),
          ...(opts.episodes ? {
            episodeList: index.map((ch) => ({
              episodeNumber: ch.episodeNumber,
              title: ch.title,
              status: ch.status,
              episodeDurationSeconds: ch.episodeDurationSeconds,
              ...(ch.auditIssues.length > 0 || ch.lengthWarnings.length > 0
                ? {
                    issues: ch.auditIssues,
                    ...(ch.lengthWarnings.length > 0 ? { lengthWarnings: ch.lengthWarnings } : {}),
                  }
                : {}),
            })),
          } : {}),
        });

        if (!opts.json) {
          log(`  ${book.title} (${id})`);
          log(`    Status: ${book.status}`);
          log(`    Platform: ${book.platform} | Genre: ${book.genre}`);
          log(`    Episodes: ${persistedEpisodeCount} / ${book.targetEpisodes}`);
          log(`    Script duration: ${totalDurationSeconds.toLocaleString()}s (avg ${avgDurationSeconds}s/episode)`);
          log(`    Approved: ${approved} | Pending: ${pending} | Failed: ${failed} | Degraded: ${degraded}`);
          if (migrationHint) {
            log(`    Migration: ${migrationHint}`);
          }

          if (opts.episodes && index.length > 0) {
            log("");
            for (const ch of index) {
              const icon = ch.status === "approved"
                ? "+"
                : ch.status === "audit-failed"
                  ? "!"
                  : ch.status === "state-degraded"
                    ? "x"
                    : "~";
              log(`    [${icon}] Ep.${ch.episodeNumber} "${ch.title}" | ${ch.episodeDurationSeconds}s | ${ch.status}`);
              if (ch.auditIssues.length > 0 || ch.lengthWarnings.length > 0) {
                const criticals = ch.auditIssues.filter((i: string) => i.startsWith("[critical]"));
                const warnings = ch.auditIssues.filter((i: string) => i.startsWith("[warning]"));
                const infos = ch.auditIssues.filter((i: string) => i.startsWith("[info]"));
                if (criticals.length > 0) {
                  for (const issue of criticals) {
                    log(`        ${issue}`);
                  }
                }
                if (warnings.length > 0) {
                  if (ch.status === "state-degraded") {
                    for (const issue of warnings) {
                      log(`        ${issue}`);
                    }
                  } else {
                    log(`        + ${warnings.length} warning(s)`);
                  }
                }
                if (infos.length > 0) {
                  log(`        + ${infos.length} info item(s)`);
                }
                for (const warning of ch.lengthWarnings) {
                  log(`        [critical] ${warning}`);
                }
              }
            }
          }
          log("");
        }
      }

      if (opts.json) {
        log(JSON.stringify({ project: root, books: booksData }, null, 2));
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to get status: ${e}`);
      }
      process.exit(1);
    }
  });
