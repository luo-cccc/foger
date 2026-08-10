import { Command } from "commander";
import { access, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import {
  BookConfigSchema,
  deriveBookIdFromTitle,
  executeBookBackupCommand,
  executeCoreMutation,
  listBookBackups,
  normalizePlatformOrOther,
  loadVolumeContracts,
  PipelineRunner,
  StateManager,
  type BookConfig,
} from "@actalk/inkos-core";
import {
  formatBookCreateCreated,
  formatBookCreateCreating,
  formatBookCreateFoundationReady,
  formatBookCreateLocation,
  formatBookCreateNextStep,
  resolveCliLanguage,
} from "../localization.js";
import { loadConfig, buildPipelineConfig, findProjectRoot, resolveBookId, log, logError } from "../utils.js";

export const bookCommand = new Command("book")
  .description("Manage comic-drama series");

bookCommand
  .command("create")
  .description("Create a new comic-drama series with AI-generated foundation")
  .requiredOption("--title <title>", "Series title")
  .option("--genre <genre>", "Genre", "xuanhuan")
  .option("--platform <platform>", "Target platform", "tomato")
  .option("--episodes <n>", "Target episode count", "100")
  .option("--duration <seconds>", "Target duration per episode", "150")
  .option("--brief <path>", "Path to creative brief file (.md/.txt) — Architect builds from your ideas instead of generating from scratch")
  .option("--lang <language>", "Writing language: zh (Chinese) or en (English). Defaults from genre.")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const root = findProjectRoot();

      const bookId = deriveBookIdFromTitle(opts.title) || `book-${Date.now().toString(36)}`;

      const bookDir = join(root, "books", bookId);
      try {
        await access(bookDir);
        const state = new StateManager(root);
        if (await state.isCompleteBookDirectory(bookDir)) {
          throw new Error(`Book "${bookId}" already exists at books/${bookId}/. Use a different title or delete the existing book first.`);
        }
        await rm(bookDir, { recursive: true, force: true });
      } catch (e) {
        if (e instanceof Error && e.message.includes("already exists")) throw e;
        // Directory doesn't exist, good
      }

      const config = await loadConfig();
      const now = new Date().toISOString();
      const targetEpisodes = parseInt(opts.episodes ?? "100", 10);
      const episodeDurationSeconds = parseInt(opts.duration ?? "150", 10);
      const book: BookConfig = BookConfigSchema.parse({
        id: bookId,
        title: opts.title,
        platform: normalizePlatformOrOther(opts.platform),
        genre: opts.genre,
        status: "outlining",
        schemaVersion: "inkos-episode-v2",
        format: "screenplay",
        targetEpisodes,
        episodeDurationSeconds,
        language: opts.lang ?? config.language,
        createdAt: now,
        updatedAt: now,
      });
      const language = resolveCliLanguage(book.language);

      if (!opts.json) log(formatBookCreateCreating(language, book.title, book.genre, book.platform));

      const brief = opts.brief
        ? await readFile(resolve(opts.brief), "utf-8")
        : undefined;

      const pipeline = new PipelineRunner(buildPipelineConfig(config, root, { externalContext: brief }));

      await pipeline.initBook(book);

      if (opts.json) {
        log(JSON.stringify({
          bookId,
          title: book.title,
          genre: book.genre,
          platform: book.platform,
          location: `books/${bookId}/`,
          nextStep: `inkos write next ${bookId}`,
        }, null, 2));
      } else {
        log(formatBookCreateCreated(language, bookId));
        log(formatBookCreateLocation(language, bookId));
        log(formatBookCreateFoundationReady(language));
        log("");
        log(formatBookCreateNextStep(language, bookId));
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to create book: ${e}`);
      }
      process.exit(1);
    }
  });

bookCommand
  .command("update")
  .description("Update book settings")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--duration <seconds>", "Target duration per episode")
  .option("--episodes <n>", "Target episode count")
  .option("--status <status>", "Book status (outlining/active/paused/completed)")
  .option("--lang <language>", "Writing language: zh or en")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);

      const updates: Record<string, unknown> = {};
      if (opts.duration) updates.episodeDurationSeconds = parseInt(opts.duration, 10);
      if (opts.episodes) {
        updates.targetEpisodes = parseInt(opts.episodes, 10);
      }
      if (opts.status) updates.status = opts.status;
      if (opts.lang) updates.language = opts.lang;

      if (Object.keys(updates).length === 0) {
        const book = await state.loadBookConfig(bookId);
        if (opts.json) {
          log(JSON.stringify(book, null, 2));
        } else {
          log(`Book: ${book.title} (${bookId})`);
          log(`  Duration/episode: ${book.episodeDurationSeconds}s`);
          log(`  Target episodes: ${book.targetEpisodes}`);
          log(`  Status: ${book.status}`);
          log(`  Genre: ${book.genre} | Platform: ${book.platform}`);
        }
        return;
      }

      const result = await executeCoreMutation({ state }, {
        kind: "update-book-config",
        bookId,
        updates,
      });

      if (opts.episodes) {
        const parsedEpisodes = parseInt(opts.episodes, 10);
        const contracts = await loadVolumeContracts(state.bookDir(bookId), {
          episodeNumber: parsedEpisodes,
        }).catch(() => ({ contracts: [] }));
        const contract = contracts.contracts[0];
        if (contract?.episodeEnd !== undefined && parsedEpisodes > contract.episodeEnd) {
          log(`  [warning] 目标集数 ${parsedEpisodes} 超出当前卷合同覆盖（至第 ${contract.episodeEnd} 集）；运行 "inkos foundation extend ${bookId} --episodes ${parsedEpisodes}" 扩展卷合同。`);
        }
      }

      if (opts.json) {
        log(JSON.stringify(result.book, null, 2));
      } else {
        for (const [key, value] of Object.entries(updates)) {
          log(`  ${key}: ${(result.previous as Record<string, unknown>)[key]} → ${value}`);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to update book: ${e}`);
      }
      process.exit(1);
    }
  });

bookCommand
  .command("list")
  .description("List all books")
  .option("--json", "Output JSON")
  .action(async (opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);
      const bookIds = await state.listBooks();

      if (bookIds.length === 0) {
        if (opts.json) {
          log(JSON.stringify({ books: [] }));
        } else {
          log("No books found. Create one with: inkos book create --title '...'");
        }
        return;
      }

      const books = [];
      for (const id of bookIds) {
        const book = await state.loadBookConfig(id);
        const nextEpisode = await state.getNextEpisodeNumber(id);
        const info = {
          id,
          title: book.title,
          genre: book.genre,
          platform: book.platform,
          status: book.status,
          episodes: nextEpisode - 1,
        };
        books.push(info);
        if (!opts.json) {
          log(`  ${id} | ${book.title} | ${book.genre}/${book.platform} | ${book.status} | episodes: ${nextEpisode - 1}`);
        }
      }

      if (opts.json) {
        log(JSON.stringify({ books }, null, 2));
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to list books: ${e}`);
      }
      process.exit(1);
    }
  });

bookCommand
  .command("delete")
  .description("Delete a book and all its episodes, truth files, and snapshots")
  .argument("<book-id>", "Book ID to delete")
  .option("--force", "Skip confirmation prompt")
  .option("--json", "Output JSON")
  .action(async (bookId: string, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);

      const allBooks = await state.listBooks();
      if (!allBooks.includes(bookId)) {
        throw new Error(`Book "${bookId}" not found. Available: ${allBooks.join(", ") || "(none)"}`);
      }

      const book = await state.loadBookConfig(bookId);
      const index = await state.loadEpisodeIndex(bookId);

      if (!opts.force) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            `Delete "${book.title}" (${bookId})? This will remove ${index.length} episode(s) and all data. (y/N) `,
            resolve,
          );
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          log("Cancelled.");
          return;
        }
      }

      await executeCoreMutation({ state }, { kind: "delete-book", bookId });

      if (opts.json) {
        log(JSON.stringify({ deleted: bookId, episodes: index.length }));
      } else {
        log(`Deleted "${book.title}" (${bookId}): ${index.length} episode(s) removed.`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to delete book: ${e}`);
      }
      process.exit(1);
    }
  });

bookCommand
  .command("backup")
  .description("Create or list whole-book backups")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--list", "List existing backups")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      if (opts.list) {
        const backups = await listBookBackups(state, bookId);
        if (opts.json) {
          log(JSON.stringify({ bookId, backups }, null, 2));
        } else if (backups.length === 0) {
          log(`No backups found for "${bookId}".`);
        } else {
          for (const backup of backups) log(`  ${backup.id} | ${backup.createdAt}`);
        }
        return;
      }

      const result = await executeBookBackupCommand(state, { kind: "backup-book", bookId });
      if (!("backupId" in result)) throw new Error("Unexpected restore result while creating a backup");
      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`Backed up "${bookId}" as ${result.backupId}.`);
        log(`  ${result.path}`);
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to back up book: ${e}`);
      }
      process.exit(1);
    }
  });

bookCommand
  .command("restore")
  .description("Restore a whole-book backup and preserve the current state as a pre-restore backup")
  .argument("<book-id>", "Book ID")
  .argument("<backup-id>", "Backup ID from inkos book backup --list")
  .option("--json", "Output JSON")
  .action(async (bookId: string, backupId: string, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);
      const result = await executeBookBackupCommand(state, {
        kind: "restore-book",
        bookId,
        backupId,
      });
      if (!("restoredFrom" in result)) throw new Error("Unexpected backup result while restoring a book");
      if (opts.json) {
        log(JSON.stringify(result, null, 2));
      } else {
        log(`Restored "${bookId}" from ${result.restoredFrom}.`);
        if (result.preRestoreBackupId) {
          log(`  Previous state preserved as ${result.preRestoreBackupId}.`);
        }
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to restore book: ${e}`);
      }
      process.exit(1);
    }
  });
