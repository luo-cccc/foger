import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { BookConfigSchema } from "../models/book.js";
import { atomicWriteJson } from "../utils/atomic-write.js";
import { isSafeBookId } from "../utils/book-id.js";
import { renamePathWithRetry } from "../utils/fs-retry.js";

const BACKUP_ID_RE = /^[A-Za-z0-9._-]+$/;
const TRANSIENT_BOOK_ENTRIES = new Set([
  ".write.lock",
  ".chapter-persistence.json",
  ".core-workflow-mutation.json",
  ".core-workflow-backup",
]);

export interface BookBackupState {
  acquireBookLock(bookId: string): Promise<() => Promise<void>>;
  bookDir(bookId: string): string;
  recoverIncompleteChapterPersistence?(bookId: string): Promise<unknown>;
  recoverIncompleteCoreWorkflowMutation?(bookId: string): Promise<unknown>;
}

export interface BookBackupInfo {
  readonly id: string;
  readonly createdAt: string;
}

export interface BookBackupOptions {
  readonly now?: () => Date;
}

export interface CreateBookBackupResult {
  readonly bookId: string;
  readonly backupId: string;
  readonly path: string;
}

export interface RestoreBookBackupResult {
  readonly bookId: string;
  readonly restoredFrom: string;
  readonly preRestoreBackupId: string | null;
}

export type BookRestoreRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "committed-cleanup"; readonly restoredFrom: string }
  | { readonly kind: "rolled-back"; readonly preRestoreBackupId: string | null };

interface BookRestoreTransaction {
  readonly version: 1;
  readonly bookId: string;
  readonly status: "preparing" | "committed";
  readonly restoredFrom: string;
  readonly preRestoreBackupId: string | null;
}

export type BookBackupCommand =
  | { readonly kind: "backup-book"; readonly bookId: string; readonly now?: () => Date }
  | { readonly kind: "restore-book"; readonly bookId: string; readonly backupId: string; readonly now?: () => Date };

export function bookBackupsDir(state: Pick<BookBackupState, "bookDir">, bookId: string): string {
  return join(projectRootForBook(state, bookId), ".inkos", "backups", bookId);
}

export async function listBookBackups(
  state: Pick<BookBackupState, "bookDir">,
  bookId: string,
): Promise<ReadonlyArray<BookBackupInfo>> {
  assertBookId(bookId);
  const entries = await readdir(bookBackupsDir(state, bookId), { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const backups = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map(async (entry) => ({
      id: entry.name,
      createdAt: (await stat(join(bookBackupsDir(state, bookId), entry.name))).mtime.toISOString(),
    })));
  return backups.sort((left, right) => right.id.localeCompare(left.id));
}

export async function executeBookBackupCommand(
  state: BookBackupState,
  command: BookBackupCommand,
): Promise<CreateBookBackupResult | RestoreBookBackupResult> {
  assertBookId(command.bookId);
  if (command.kind === "backup-book") {
    await validateBookDirectory(state.bookDir(command.bookId), command.bookId);
  } else {
    assertBackupId(command.backupId);
    const backupPath = join(bookBackupsDir(state, command.bookId), command.backupId);
    const exists = await stat(backupPath).then((value) => value.isDirectory()).catch(() => false);
    if (!exists) throw new Error(`Backup "${command.backupId}" not found for book "${command.bookId}".`);
    await validateBookDirectory(backupPath, command.bookId);
  }
  const releaseLock = await state.acquireBookLock(command.bookId);
  try {
    if (command.kind === "backup-book") {
      await state.recoverIncompleteChapterPersistence?.(command.bookId);
      await state.recoverIncompleteCoreWorkflowMutation?.(command.bookId);
      return await createBookBackup(state, command.bookId, { now: command.now });
    }
    return await restoreBookBackup(state, command.bookId, command.backupId, { now: command.now });
  } finally {
    await releaseLock();
  }
}

export async function recoverIncompleteBookRestore(
  state: Pick<BookBackupState, "bookDir">,
  bookId: string,
): Promise<BookRestoreRecovery> {
  const transactionPath = bookRestoreTransactionPath(state, bookId);
  let transaction: BookRestoreTransaction;
  try {
    transaction = JSON.parse(await readFile(transactionPath, "utf-8")) as BookRestoreTransaction;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw new Error(`Invalid book restore transaction for "${bookId}"`, { cause: error });
  }
  assertRestoreTransaction(transaction, bookId);

  if (transaction.status === "committed") {
    await rm(bookRestoreDir(state, bookId), { recursive: true, force: true });
    return { kind: "committed-cleanup", restoredFrom: transaction.restoredFrom };
  }

  if (transaction.preRestoreBackupId) {
    const preRestorePath = join(bookBackupsDir(state, bookId), transaction.preRestoreBackupId);
    const exists = await stat(preRestorePath).then((value) => value.isDirectory()).catch(() => false);
    if (!exists) {
      throw new Error(
        `Cannot recover interrupted restore for "${bookId}": pre-restore backup `
        + `"${transaction.preRestoreBackupId}" is missing.`,
      );
    }
    await replaceBookContents(state.bookDir(bookId), preRestorePath);
  } else {
    await clearBookContents(state.bookDir(bookId));
  }
  await rm(bookRestoreDir(state, bookId), { recursive: true, force: true });
  return { kind: "rolled-back", preRestoreBackupId: transaction.preRestoreBackupId };
}

async function createBookBackup(
  state: Pick<BookBackupState, "bookDir">,
  bookId: string,
  options: BookBackupOptions & { readonly suffix?: string; readonly validateSource?: boolean } = {},
): Promise<CreateBookBackupResult> {
  const bookDir = state.bookDir(bookId);
  const exists = await stat(bookDir).then((value) => value.isDirectory()).catch(() => false);
  if (!exists) throw new Error(`Book "${bookId}" not found.`);
  if (options.validateSource !== false) await validateBookDirectory(bookDir, bookId);

  const backupsDir = bookBackupsDir(state, bookId);
  await mkdir(backupsDir, { recursive: true });
  const clock = options.now ?? (() => new Date());
  const base = options.suffix
    ? `${formatStamp(clock())}-${options.suffix}`
    : formatStamp(clock());
  let backupId = base;
  for (let attempt = 2; await pathExists(join(backupsDir, backupId)); attempt += 1) {
    backupId = `${base}-${attempt}`;
  }

  const targetPath = join(backupsDir, backupId);
  const stagingPath = join(backupsDir, `.partial-${backupId}-${process.pid}-${randomUUID()}`);
  try {
    await copyBookDirectory(bookDir, stagingPath);
    if (options.validateSource !== false) await validateBookDirectory(stagingPath, bookId);
    await renamePathWithRetry(stagingPath, targetPath);
    return { bookId, backupId, path: targetPath };
  } finally {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreBookBackup(
  state: Pick<BookBackupState, "bookDir">,
  bookId: string,
  backupId: string,
  options: BookBackupOptions = {},
): Promise<RestoreBookBackupResult> {
  assertBackupId(backupId);
  const backupPath = join(bookBackupsDir(state, bookId), backupId);
  const backupExists = await stat(backupPath).then((value) => value.isDirectory()).catch(() => false);
  if (!backupExists) throw new Error(`Backup "${backupId}" not found for book "${bookId}".`);
  await validateBookDirectory(backupPath, bookId);

  const restoreDir = bookRestoreDir(state, bookId);
  const stagingPath = join(restoreDir, "staging");
  await rm(restoreDir, { recursive: true, force: true });
  await mkdir(restoreDir, { recursive: true });
  await copyBookDirectory(backupPath, stagingPath);
  await validateBookDirectory(stagingPath, bookId);

  const currentEntries = await readdir(state.bookDir(bookId)).catch(() => []);
  const hasCurrentBook = currentEntries.some((entry) => entry !== ".write.lock");
  const preRestore = hasCurrentBook
    ? await createBookBackup(state, bookId, {
        now: options.now,
        suffix: "pre-restore",
        validateSource: false,
      })
    : null;
  const transaction: BookRestoreTransaction = {
    version: 1,
    bookId,
    status: "preparing",
    restoredFrom: backupId,
    preRestoreBackupId: preRestore?.backupId ?? null,
  };
  const transactionPath = bookRestoreTransactionPath(state, bookId);
  await atomicWriteJson(transactionPath, transaction);

  try {
    await replaceBookContents(state.bookDir(bookId), stagingPath);
    await validateBookDirectory(state.bookDir(bookId), bookId);
    await atomicWriteJson(transactionPath, { ...transaction, status: "committed" } satisfies BookRestoreTransaction);
  } catch (error) {
    try {
      await recoverIncompleteBookRestore(state, bookId);
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `Book restore and rollback both failed for "${bookId}".`);
    }
    throw error;
  }
  // A committed marker is sufficient for the next lock holder to finish cleanup.
  await rm(restoreDir, { recursive: true, force: true }).catch(() => undefined);

  return {
    bookId,
    restoredFrom: backupId,
    preRestoreBackupId: preRestore?.backupId ?? null,
  };
}

async function copyBookDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (path) => {
      const relativePath = relative(source, path);
      if (!relativePath) return true;
      const topLevel = relativePath.split(sep)[0];
      return !TRANSIENT_BOOK_ENTRIES.has(topLevel ?? relativePath);
    },
  });
}

async function replaceBookContents(bookDir: string, source: string): Promise<void> {
  await mkdir(bookDir, { recursive: true });
  await clearBookContents(bookDir);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    await cp(join(source, entry.name), join(bookDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

async function clearBookContents(bookDir: string): Promise<void> {
  const entries = await readdir(bookDir).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry !== ".write.lock")
    .map((entry) => rm(join(bookDir, entry), { recursive: true, force: true })));
}

async function validateBookDirectory(bookDir: string, expectedBookId: string): Promise<void> {
  const raw = await readFile(join(bookDir, "book.json"), "utf-8");
  const book = BookConfigSchema.parse(JSON.parse(raw));
  if (book.id !== expectedBookId) {
    throw new Error(`Backup book id "${book.id}" does not match requested book "${expectedBookId}".`);
  }
  const indexPath = join(bookDir, "chapters", "index.json");
  if (await pathExists(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf-8")) as unknown;
    if (!Array.isArray(index)) throw new Error(`Invalid chapter index in backup for "${expectedBookId}".`);
  }
}

function projectRootForBook(state: Pick<BookBackupState, "bookDir">, bookId: string): string {
  return dirname(dirname(state.bookDir(bookId)));
}

function bookRestoreDir(state: Pick<BookBackupState, "bookDir">, bookId: string): string {
  return join(projectRootForBook(state, bookId), ".inkos", "book-restore", bookId);
}

function bookRestoreTransactionPath(state: Pick<BookBackupState, "bookDir">, bookId: string): string {
  return join(bookRestoreDir(state, bookId), "transaction.json");
}

function formatStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

function assertBookId(bookId: string): void {
  if (!isSafeBookId(bookId)) throw new Error(`Invalid book id: ${JSON.stringify(bookId)}`);
}

function assertBackupId(backupId: string): void {
  if (!BACKUP_ID_RE.test(backupId) || backupId === "." || backupId === "..") {
    throw new Error(`Invalid backup id "${backupId}": expected a single directory name.`);
  }
}

function assertRestoreTransaction(transaction: BookRestoreTransaction, expectedBookId: string): void {
  if (
    transaction.version !== 1
    || transaction.bookId !== expectedBookId
    || (transaction.status !== "preparing" && transaction.status !== "committed")
  ) {
    throw new Error(`Invalid book restore transaction for "${expectedBookId}".`);
  }
  assertBackupId(transaction.restoredFrom);
  if (transaction.preRestoreBackupId !== null) assertBackupId(transaction.preRestoreBackupId);
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}
