import { readFile, writeFile, mkdir, readdir, rm, stat, unlink, open, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BookConfigSchema,
  EpisodeBookConfigSchema,
  UnsupportedLegacyFormatError,
  type BookConfig,
  type EpisodeBookConfig,
} from "../models/book.js";
import type { EpisodeMeta } from "../models/episode.js";
import { bootstrapStructuredStateFromMarkdown, resolveDurableStoryProgress } from "./state-bootstrap.js";
import { atomicWriteFile, atomicWriteJson } from "../utils/atomic-write.js";
import { recoverIncompleteBookRestore } from "./book-backup.js";
import { parseEpisodeScriptOutput, measureEpisodeScript } from "../models/episode-script.js";

export type EpisodePersistenceRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "committed-cleanup"; readonly episodeNumber: number; readonly operationId?: string }
  | { readonly kind: "rolled-back"; readonly episodeNumber: number; readonly rolledBackTo: number; readonly operationId?: string };

export type CoreWorkflowMutationKind = "plan-episode" | "compose-episode" | "audit-episode" | "consolidate-book" | "rewrite-episode";

export type CoreWorkflowRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "committed-cleanup"; readonly workflow: CoreWorkflowMutationKind }
  | { readonly kind: "rolled-back"; readonly workflow: CoreWorkflowMutationKind };

const EPISODE_PERSISTENCE_TRANSACTION = ".episode-persistence.json";
const CORE_WORKFLOW_TRANSACTION = ".core-workflow-mutation.json";
const CORE_WORKFLOW_BACKUP = ".core-workflow-backup";

/**
 * Collapse duplicate index rows for the same episode, keeping the first
 * (richest) row. Guards against any writer appending a rebuild/placeholder
 * row next to the authoritative persisted entry.
 */
function dedupeEpisodeIndex(index: ReadonlyArray<EpisodeMeta>): ReadonlyArray<EpisodeMeta> {
  const seen = new Set<number>();
  const out: EpisodeMeta[] = [];
  for (const entry of index) {
    if (!Number.isInteger(entry.episodeNumber) || entry.episodeNumber < 1) continue;
    if (seen.has(entry.episodeNumber)) continue;
    seen.add(entry.episodeNumber);
    out.push(entry);
  }
  return out;
}

interface EpisodePersistenceTransaction {
  readonly episodeNumber: number;
  readonly previousEpisode: number;
  readonly status: "preparing" | "committed";
  readonly operationId?: string;
}

function coreWorkflowTargets(workflow: CoreWorkflowMutationKind): ReadonlyArray<string> {
  switch (workflow) {
    case "plan-episode":
    case "compose-episode":
      return ["story/runtime"];
    case "audit-episode":
      return ["episodes/index.json", "story/audit_drift.md"];
    case "rewrite-episode":
      // Rewriting rolls truth back and removes all later screenplay/episode
      // artifacts before regeneration. Back up the complete affected roots so
      // a provider or schema failure cannot destroy the accepted draft.
      return ["episodes", "story"];
    case "consolidate-book":
      return [
        "story/episode_summaries.md",
        "story/volume_summaries.md",
        "story/pending_hooks.md",
        "story/summaries_archive",
      ];
  }
}

interface CoreWorkflowTransaction {
  readonly workflow: CoreWorkflowMutationKind;
  readonly status: "preparing" | "committed";
  readonly targets: ReadonlyArray<{ readonly relativePath: string; readonly existed: boolean }>;
}

export class StateManager {
  /** Books actively being written by this process — used for same-process stale lock detection. */
  private readonly activeWrites = new Set<string>();

  constructor(private readonly projectRoot: string) {}

  private static defaultAuthorIntent(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 作者意图\n\n（在这里描述这本书的长期创作方向。）\n"
      : "# Author Intent\n\n(Describe the long-horizon vision for this book here.)\n";
  }

  private static defaultCurrentFocus(language: "zh" | "en"): string {
    return language === "zh"
      ? "# 当前聚焦\n\n## 当前重点\n\n（描述接下来 1-3 集最需要优先推进的内容。）\n"
      : "# Current Focus\n\n## Active Focus\n\n(Describe what the next 1-3 episodes should prioritize.)\n";
  }

  async ensureControlDocuments(bookId: string, authorIntent?: string): Promise<void> {
    const language = await this.resolveControlDocumentLanguage(bookId);
    await this.ensureControlDocumentsAt(this.bookDir(bookId), language, authorIntent);
  }

  async ensureControlDocumentsAt(
    bookDir: string,
    language: "zh" | "en",
    authorIntent?: string,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    const outlineDir = join(storyDir, "outline");
    const rolesMajorDir = join(storyDir, "roles", "主要角色");
    const rolesMinorDir = join(storyDir, "roles", "次要角色");

    await mkdir(storyDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(outlineDir, { recursive: true });
    await mkdir(rolesMajorDir, { recursive: true });
    await mkdir(rolesMinorDir, { recursive: true });

    await this.writeIfMissing(
      join(storyDir, "author_intent.md"),
      authorIntent?.trim()
        ? authorIntent.trimEnd() + "\n"
        : StateManager.defaultAuthorIntent(language),
    );

    await this.writeIfMissing(
      join(storyDir, "current_focus.md"),
      StateManager.defaultCurrentFocus(language),
    );

    // Ensure style_guide includes writing methodology even without reference text
    const styleGuidePath = join(storyDir, "style_guide.md");
    try {
      const existing = await readFile(styleGuidePath, "utf-8");
      if (!existing.includes("写作方法论") && !existing.includes("Writing Methodology")) {
        const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
        await writeFile(styleGuidePath, `${existing}\n\n${buildWritingMethodologySection(language)}`, "utf-8");
      }
    } catch {
      const { buildWritingMethodologySection } = await import("../utils/writing-methodology.js");
      await writeFile(styleGuidePath, buildWritingMethodologySection(language), "utf-8");
    }
  }

  async loadControlDocuments(bookId: string): Promise<{
    authorIntent: string;
    currentFocus: string;
    runtimeDir: string;
  }> {
    await this.ensureControlDocuments(bookId);

    const storyDir = join(this.bookDir(bookId), "story");
    const runtimeDir = join(storyDir, "runtime");
    const [authorIntent, currentFocus] = await Promise.all([
      readFile(join(storyDir, "author_intent.md"), "utf-8"),
      readFile(join(storyDir, "current_focus.md"), "utf-8"),
    ]);

    return { authorIntent, currentFocus, runtimeDir };
  }

  private async resolveControlDocumentLanguage(bookId: string): Promise<"zh" | "en"> {
    try {
      const raw = await readFile(join(this.bookDir(bookId), "book.json"), "utf-8");
      const parsed = JSON.parse(raw) as { language?: unknown };
      return parsed.language === "en" ? "en" : "zh";
    } catch {
      return "zh";
    }
  }

  async acquireBookLock(bookId: string): Promise<() => Promise<void>> {
    await mkdir(this.bookDir(bookId), { recursive: true });
    const lockPath = join(this.bookDir(bookId), ".write.lock");
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`pid:${process.pid} ts:${Date.now()}`, "utf-8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        const lockData = await readFile(lockPath, "utf-8").catch(() => "pid:unknown ts:unknown");
        const lockPid = this.extractLockPid(lockData);
        const isStale =
          (lockPid !== undefined && !this.isProcessAlive(lockPid)) ||
          (lockPid === process.pid && !this.activeWrites.has(bookId));
        if (isStale) {
          await unlink(lockPath).catch(() => undefined);
          return this.acquireBookLock(bookId);
        }
        throw new Error(
          `Book "${bookId}" is locked by another process (${lockData}). ` +
            `If this is stale, delete ${lockPath}`,
        );
      }
      throw e;
    }
    this.activeWrites.add(bookId);
    try {
      await recoverIncompleteBookRestore(this, bookId);
    } catch (error) {
      this.activeWrites.delete(bookId);
      await unlink(lockPath).catch(() => undefined);
      throw error;
    }
    return async () => {
      this.activeWrites.delete(bookId);
      try {
        await unlink(lockPath);
      } catch {
        // ignore
      }
    };
  }

  private extractLockPid(lockData: string): number | undefined {
    const match = lockData.match(/pid:(\d+)/);
    if (!match) return undefined;
    const pid = Number.parseInt(match[1] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ESRCH") {
        return false;
      }
      return true;
    }
  }

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  stateDir(bookId: string): string {
    return join(this.bookDir(bookId), "story", "state");
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await atomicWriteJson(configPath, config);
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    return await this.loadEpisodeBookConfig(bookId);
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    await this.saveBookConfigAt(this.bookDir(bookId), config);
  }

  async saveBookConfigAt(bookDir: string, config: BookConfig): Promise<void> {
    const parsed = BookConfigSchema.parse(config);
    if (parsed.schemaVersion === "inkos-episode-v2") {
      await atomicWriteJson(join(bookDir, "book.json"), EpisodeBookConfigSchema.parse(parsed));
      return;
    }
    await atomicWriteJson(join(bookDir, "book.json"), parsed);
  }

  private episodePersistenceTransactionPath(bookId: string): string {
    return join(this.bookDir(bookId), EPISODE_PERSISTENCE_TRANSACTION);
  }

  private episodePersistenceRecoveryPath(bookId: string): string {
    return join(this.bookDir(bookId), "story", "runtime", "recovery.json");
  }

  private async recordEpisodePersistenceRecovery(
    bookId: string,
    recovery: Exclude<EpisodePersistenceRecovery, { readonly kind: "none" }>,
  ): Promise<void> {
    const recoveryPath = this.episodePersistenceRecoveryPath(bookId);
    await mkdir(join(this.bookDir(bookId), "story", "runtime"), { recursive: true });
    await atomicWriteJson(recoveryPath, {
      ...recovery,
      occurredAt: new Date().toISOString(),
    });
  }

  async recoverIncompleteEpisodePersistence(bookId: string): Promise<EpisodePersistenceRecovery> {
    const transactionPath = this.episodePersistenceTransactionPath(bookId);
    let transaction: EpisodePersistenceTransaction;
    try {
      transaction = JSON.parse(await readFile(transactionPath, "utf-8")) as EpisodePersistenceTransaction;
    } catch {
      return { kind: "none" };
    }

    if (transaction.status === "committed") {
      await rm(transactionPath, { force: true });
      const recovery = {
        kind: "committed-cleanup",
        episodeNumber: transaction.episodeNumber,
        ...(transaction.operationId ? { operationId: transaction.operationId } : {}),
      } as const;
      await this.recordEpisodePersistenceRecovery(bookId, recovery);
      return recovery;
    }

    if (
      !Number.isInteger(transaction.episodeNumber)
      || !Number.isInteger(transaction.previousEpisode)
      || transaction.episodeNumber !== transaction.previousEpisode + 1
      || transaction.previousEpisode < 0
    ) {
      throw new Error(`Invalid episode persistence transaction for book "${bookId}"`);
    }

    await this.rollbackToEpisode(bookId, transaction.previousEpisode);
    await rm(transactionPath, { force: true });
    const recovery = {
      kind: "rolled-back",
      episodeNumber: transaction.episodeNumber,
      rolledBackTo: transaction.previousEpisode,
      ...(transaction.operationId ? { operationId: transaction.operationId } : {}),
    } as const;
    await this.recordEpisodePersistenceRecovery(bookId, recovery);
    return recovery;
  }

  async beginEpisodePersistence(bookId: string, episodeNumber: number, operationId?: string): Promise<void> {
    await this.loadEpisodeBookConfig(bookId);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
      throw new Error(`Invalid episode number for persistence: ${episodeNumber}`);
    }
    await atomicWriteJson(this.episodePersistenceTransactionPath(bookId), {
      episodeNumber,
      previousEpisode: episodeNumber - 1,
      status: "preparing",
      ...(operationId ? { operationId } : {}),
    } satisfies EpisodePersistenceTransaction);
  }

  async commitEpisodePersistence(bookId: string, episodeNumber: number, operationId?: string): Promise<void> {
    await this.loadEpisodeBookConfig(bookId);
    const transactionPath = this.episodePersistenceTransactionPath(bookId);
    await atomicWriteJson(transactionPath, {
      episodeNumber,
      previousEpisode: episodeNumber - 1,
      status: "committed",
      ...(operationId ? { operationId } : {}),
    } satisfies EpisodePersistenceTransaction);
    await rm(transactionPath, { force: true });
  }

  async recoverIncompleteCoreWorkflowMutation(bookId: string): Promise<CoreWorkflowRecovery> {
    const markerPath = join(this.bookDir(bookId), CORE_WORKFLOW_TRANSACTION);
    let transaction: CoreWorkflowTransaction;
    try {
      transaction = JSON.parse(await readFile(markerPath, "utf-8")) as CoreWorkflowTransaction;
    } catch {
      return { kind: "none" };
    }

    const backupRoot = join(this.bookDir(bookId), CORE_WORKFLOW_BACKUP);
    if (transaction.status === "committed") {
      await Promise.all([
        rm(markerPath, { force: true }),
        rm(backupRoot, { recursive: true, force: true }),
      ]);
      return { kind: "committed-cleanup", workflow: transaction.workflow };
    }

    for (const target of transaction.targets) {
      const destination = join(this.bookDir(bookId), target.relativePath);
      const backup = join(backupRoot, target.relativePath);
      await rm(destination, { recursive: true, force: true });
      if (target.existed) {
        await mkdir(dirname(destination), { recursive: true });
        await cp(backup, destination, { recursive: true, force: true });
      }
    }
    await Promise.all([
      rm(markerPath, { force: true }),
      rm(backupRoot, { recursive: true, force: true }),
    ]);
    return { kind: "rolled-back", workflow: transaction.workflow };
  }

  async beginCoreWorkflowMutation(bookId: string, workflow: CoreWorkflowMutationKind): Promise<void> {
    const bookDir = this.bookDir(bookId);
    const backupRoot = join(bookDir, CORE_WORKFLOW_BACKUP);
    const isEpisodeProject = await this.isEpisodeProjectDir(bookDir);
    const targets = coreWorkflowTargets(workflow)
      .map((target) => isEpisodeProject
        ? target
          .replace(/^episodes(?:\/|$)/u, "episodes/")
          .replace(/^story\/episode_summaries\./u, "story/episode_summaries.")
          .replace(/\/$/u, "")
        : target)
      .filter((target, index, all) => all.indexOf(target) === index);
    await rm(backupRoot, { recursive: true, force: true });
    const recorded = await Promise.all(targets.map(async (relativePath) => {
      const source = join(bookDir, relativePath);
      const backup = join(backupRoot, relativePath);
      const existed = await stat(source).then(() => true).catch(() => false);
      if (existed) {
        await mkdir(dirname(backup), { recursive: true });
        await cp(source, backup, { recursive: true, force: true });
      }
      return { relativePath, existed } as const;
    }));
    await atomicWriteJson(join(bookDir, CORE_WORKFLOW_TRANSACTION), {
      workflow,
      status: "preparing",
      targets: recorded,
    } satisfies CoreWorkflowTransaction);
  }

  async commitCoreWorkflowMutation(bookId: string, workflow: CoreWorkflowMutationKind): Promise<void> {
    const bookDir = this.bookDir(bookId);
    const markerPath = join(bookDir, CORE_WORKFLOW_TRANSACTION);
    const transaction = JSON.parse(await readFile(markerPath, "utf-8")) as CoreWorkflowTransaction;
    if (transaction.workflow !== workflow) {
      throw new Error(`Core workflow transaction mismatch for book "${bookId}"`);
    }
    await atomicWriteJson(markerPath, { ...transaction, status: "committed" } satisfies CoreWorkflowTransaction);
    await Promise.all([
      rm(markerPath, { force: true }),
      rm(join(bookDir, CORE_WORKFLOW_BACKUP), { recursive: true, force: true }),
    ]);
  }

  async abortEpisodePersistence(bookId: string, episodeNumber: number): Promise<void> {
    await this.loadEpisodeBookConfig(bookId);
    await this.rollbackToEpisode(bookId, episodeNumber - 1);
    await rm(this.episodePersistenceTransactionPath(bookId), { force: true });
  }

  async ensureRuntimeState(bookId: string, fallbackEpisode = 0): Promise<void> {
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackEpisode,
    });
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextEpisodeNumber(bookId: string): Promise<number> {
    await this.loadEpisodeBookConfig(bookId);
    const durableEpisode = await resolveDurableStoryProgress({
      bookDir: this.bookDir(bookId),
    });
    // Ensure structured state is bootstrapped (side-effect: creates missing
    // JSON files), but do NOT trust its episode number for progress — only
    // the contiguous durable artifact chain is authoritative.
    await bootstrapStructuredStateFromMarkdown({
      bookDir: this.bookDir(bookId),
      fallbackEpisode: durableEpisode,
    });
    return durableEpisode + 1;
  }

  async getPersistedEpisodeCount(bookId: string): Promise<number> {
    await this.loadEpisodeBookConfig(bookId);
    const episodesDir = join(this.bookDir(bookId), "episodes");
    const episodeNumbers = new Set<number>();

    try {
      const files = await readdir(episodesDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        episodeNumbers.add(parseInt(match[1]!, 10));
      }
    } catch {
      return 0;
    }

    return episodeNumbers.size;
  }

  async loadEpisodeIndex(bookId: string): Promise<ReadonlyArray<EpisodeMeta>> {
    await this.loadEpisodeBookConfig(bookId);
    const bookDir = this.bookDir(bookId);
    const indexPath = join(bookDir, "episodes", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return dedupeEpisodeIndex(parsed as ReadonlyArray<EpisodeMeta>);
      }
      if (Array.isArray(parsed)) {
        const rebuilt = await this.rebuildEpisodeIndexFromFiles(bookId);
        return rebuilt.length > 0 ? rebuilt : parsed as ReadonlyArray<EpisodeMeta>;
      }
    } catch {
      const rebuilt = await this.rebuildEpisodeIndexFromFiles(bookId);
      if (rebuilt.length > 0) return rebuilt;
    }
    return [];
  }

  private async rebuildEpisodeIndexFromFiles(bookId: string): Promise<ReadonlyArray<EpisodeMeta>> {
    return this.rebuildEpisodeIndexFromFilesAt(this.bookDir(bookId));
  }

  private async rebuildEpisodeIndexFromFilesAt(bookDir: string): Promise<ReadonlyArray<EpisodeMeta>> {
    const episodesDir = join(bookDir, "episodes");
    let files: string[];
    try {
      files = await readdir(episodesDir);
    } catch {
      return [];
    }

    const rows = await Promise.all(files.flatMap(async (file) => {
      const match = file.match(/^(\d+)[_-]?(.*?)\.(md|json)$/i);
      if (!match) return [];
      const number = parseInt(match[1]!, 10);
      if (!Number.isFinite(number) || number <= 0) return [];
      if (match[3]?.toLowerCase() === "md" && files.some((candidate) =>
        candidate.startsWith(`${String(number).padStart(4, "0")}_`)
        && candidate.toLowerCase().endsWith(".json"),
      )) return [];
      const filePath = join(episodesDir, file);
      const [metadata, content] = await Promise.all([
        stat(filePath).catch(() => null),
        readFile(filePath, "utf-8").catch(() => ""),
      ]);
      const timestamp = (metadata?.mtime ?? new Date()).toISOString();
      const rawTitle = match[2]?.replace(/^_+/, "").replace(/_/g, " ").trim();
      let durationSeconds = 0;
      if (match[3]?.toLowerCase() === "json") {
        try {
          const script = parseEpisodeScriptOutput(content, number);
          durationSeconds = measureEpisodeScript(script).estimatedDurationSeconds;
        } catch {
          durationSeconds = 0;
        }
      } else {
        // Markdown is a projection; never treat its character count as
        // screenplay duration. JSON is the authority for screenplay timing.
        const jsonSibling = files.find((candidate) =>
          candidate.startsWith(`${String(number).padStart(4, "0")}_`)
          && candidate.toLowerCase().endsWith(".json"),
        );
        if (jsonSibling) {
          const jsonContent = await readFile(join(episodesDir, jsonSibling), "utf-8").catch(() => "");
          try {
            durationSeconds = measureEpisodeScript(parseEpisodeScriptOutput(jsonContent, number)).estimatedDurationSeconds;
          } catch {
            durationSeconds = 0;
          }
        }
      }
      return [{
        episodeNumber: number,
        title: rawTitle || `第${number}集`,
        status: "ready-for-review" as const,
        episodeDurationSeconds: durationSeconds,
        createdAt: timestamp,
        updatedAt: timestamp,
        auditIssues: [],
        lengthWarnings: [],
      }];
    }));

    return rows
      .flat()
      .sort((a, b) => a.episodeNumber - b.episodeNumber);
  }

  async saveEpisodeIndex(
    bookId: string,
    index: ReadonlyArray<EpisodeMeta>,
    options: { readonly allowEmptyWithEpisodeFiles?: boolean } = {},
  ): Promise<void> {
    await this.loadEpisodeBookConfig(bookId);
    await this.saveEpisodeIndexAt(this.bookDir(bookId), index, options);
  }

  async saveEpisodeIndexAt(
    bookDir: string,
    index: ReadonlyArray<EpisodeMeta>,
    options: { readonly allowEmptyWithEpisodeFiles?: boolean } = {},
  ): Promise<void> {
    const safeIndex = index.length === 0 && !options.allowEmptyWithEpisodeFiles
      ? await this.rebuildEpisodeIndexFromFilesAt(bookDir).then((rebuilt) => rebuilt.length > 0 ? rebuilt : index)
      : index;
    const episodesDir = join(bookDir, "episodes");
    await mkdir(episodesDir, { recursive: true });
    // Self-heal: never persist duplicate rows for the same episode. Keep the
    // first (richest) row per episode number; later rebuild/placeholder rows
    // are dropped.
    await atomicWriteJson(join(episodesDir, "index.json"), dedupeEpisodeIndex(safeIndex));
  }

  private async isEpisodeProjectDir(bookDir: string): Promise<boolean> {
    const raw = await readFile(join(bookDir, "book.json"), "utf8").catch(() => "");
    if (!raw.trim()) return false;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return value.schemaVersion === "inkos-episode-v2" && value.format === "screenplay";
    } catch {
      return false;
    }
  }

  async loadEpisodeBookConfig(bookId: string): Promise<EpisodeBookConfig> {
    const bookDir = this.bookDir(bookId);
    const configPath = join(bookDir, "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) throw new Error(`book.json is empty for book "${bookId}"`);
    const value = JSON.parse(raw) as Record<string, unknown>;
    const hasLegacyDirectory = await stat(join(bookDir, "chapters"))
      .then((entry) => entry.isDirectory())
      .catch(() => false);
    const hasLegacyRuntime = (await Promise.all([
      stat(join(bookDir, "chapters", "index.json")).then(() => true).catch(() => false),
      stat(join(bookDir, "story", "chapter_summaries.md")).then(() => true).catch(() => false),
      stat(join(bookDir, "story", "state", "chapter_summaries.json")).then(() => true).catch(() => false),
    ])).some(Boolean);
    const hasLegacyFields = "targetChapters" in value || "chapterWordCount" in value;
    if (
      hasLegacyDirectory
      || hasLegacyRuntime
      || hasLegacyFields
      || value.schemaVersion !== "inkos-episode-v2"
      || value.format !== "screenplay"
    ) {
      throw new UnsupportedLegacyFormatError(`UNSUPPORTED_LEGACY_FORMAT: book "${bookId}" is not an inkos-episode-v2 project.`);
    }
    return EpisodeBookConfigSchema.parse(value);
  }

  async snapshotState(bookId: string, episodeNumber: number): Promise<void> {
    await this.snapshotStateAt(this.bookDir(bookId), episodeNumber);
  }

  async snapshotEpisodeState(bookId: string, episodeNumber: number): Promise<void> {
    await this.loadEpisodeBookConfig(bookId);
    await this.snapshotState(bookId, episodeNumber);
  }

  async snapshotStateAt(bookDir: string, episodeNumber: number): Promise<void> {
    const storyDir = join(bookDir, "story");
    const snapshotDir = join(storyDir, "snapshots", String(episodeNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "episode_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );

    const stateDir = join(bookDir, "story", "state");
    const snapshotStateDir = join(snapshotDir, "state");
    try {
      const stateFiles = await readdir(stateDir);
      if (stateFiles.length > 0) {
        await mkdir(snapshotStateDir, { recursive: true });
        await Promise.all(
          stateFiles.map(async (fileName) => {
            const content = await readFile(join(stateDir, fileName), "utf-8");
            await writeFile(join(snapshotStateDir, fileName), content, "utf-8");
          }),
        );
      }
    } catch {
      // state directory missing — skip
    }
  }

  async isCompleteBookDirectory(bookDir: string): Promise<boolean> {
    // Completion is defined only for Episode v2 projects. Legacy projects are
    // detected and rejected rather than scanned through a compatibility path.
    if (!await this.isEpisodeProjectDir(bookDir)) return false;
    const requiredSingle = [
      join(bookDir, "book.json"),
      join(bookDir, "story", "book_rules.md"),
      join(bookDir, "story", "current_state.md"),
      join(bookDir, "story", "pending_hooks.md"),
      join(bookDir, "episodes", "index.json"),
    ];

    const requiredEpisodeOutline = [
      join(bookDir, "story", "outline", "story_frame.md"),
      join(bookDir, "story", "outline", "volume_map.md"),
    ];

    for (const requiredPath of requiredSingle) {
      try {
        await stat(requiredPath);
      } catch {
        return false;
      }
    }

    for (const requiredPath of requiredEpisodeOutline) {
      try {
        await stat(requiredPath);
      } catch {
        return false;
      }
    }

    return true;
  }

  async restoreState(bookId: string, episodeNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(episodeNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "episode_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    try {
      // current_state.md and pending_hooks.md are required;
      // particle_ledger.md is optional (numericalSystem=false genres don't have it)
      // the rest are optional (may not exist in older snapshots)
      const requiredFiles = ["current_state.md", "pending_hooks.md"];
      const optionalFiles = files.filter((f) => !requiredFiles.includes(f));

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          const targetPath = join(storyDir, f);
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(targetPath, content, "utf-8");
          } catch {
            await rm(targetPath, { force: true });
          }
        }),
      );

      const stateDir = this.stateDir(bookId);
      let restoredStructuredState = false;
      try {
        const snapshotStateDir = join(snapshotDir, "state");
        const stateFiles = await readdir(snapshotStateDir);
        if (stateFiles.length > 0) {
          restoredStructuredState = true;
          await mkdir(stateDir, { recursive: true });
          await Promise.all(
            stateFiles.map(async (fileName) => {
              const content = await readFile(join(snapshotStateDir, fileName), "utf-8");
              await writeFile(join(stateDir, fileName), content, "utf-8");
            }),
          );
        }
      } catch {
        // snapshot structured state missing — skip
      }
      if (!restoredStructuredState) {
        await rm(stateDir, { recursive: true, force: true });
      }

      return true;
    } catch {
      return false;
    }
  }

  async restoreEpisodeState(bookId: string, episodeNumber: number): Promise<boolean> {
    await this.loadEpisodeBookConfig(bookId);
    return this.restoreState(bookId, episodeNumber);
  }

  /**
   * Roll back state to the snapshot at `targetEpisode`, removing all episodes
   * after it and their associated files (episode markdown, snapshots, runtime).
   * Used by review reject to undo a bad episode and everything that followed.
   *
   * Returns the list of episode numbers that were discarded.
   */
  async rollbackToEpisode(
    bookId: string,
    targetEpisode: number,
  ): Promise<ReadonlyArray<number>> {
    const restored = await this.restoreState(bookId, targetEpisode);
    if (!restored) {
      throw new Error(`Cannot restore snapshot for episode ${targetEpisode} in "${bookId}"`);
    }

    const bookDir = this.bookDir(bookId);
    const index = await this.loadEpisodeIndex(bookId);

    const kept: EpisodeMeta[] = [];
    const discarded: number[] = [];

    for (const entry of index) {
      if (entry.episodeNumber <= targetEpisode) {
        kept.push(entry);
      } else {
        discarded.push(entry.episodeNumber);
      }
    }

    // Delete episode markdown files for discarded episodes.
    const episodesDir = join(bookDir, "episodes");
    try {
      const files = await readdir(episodesDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetEpisode) {
          await unlink(join(episodesDir, file)).catch(() => {});
        }
      }
    } catch {
      // episodes directory missing
    }

    // Screenplay projections are first-class artifacts and must roll back with
    // the internal episode reducer so a failed episode cannot remain exportable.
    try {
      const files = await readdir(episodesDir);
      for (const file of files) {
        const match = file.match(/^(\d+)_.*\.(?:md|json)$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetEpisode) {
          await unlink(join(episodesDir, file)).catch(() => {});
        }
      }
    } catch {
      // episodes directory missing
    }

    // Delete snapshots for discarded episodes
    const snapshotsDir = join(bookDir, "story", "snapshots");
    try {
      const snapshots = await readdir(snapshotsDir);
      for (const snap of snapshots) {
        const num = parseInt(snap, 10);
        if (Number.isFinite(num) && num > targetEpisode) {
          await rm(join(snapshotsDir, snap), { recursive: true, force: true });
        }
      }
    } catch {
      // snapshots directory missing
    }

    // Delete runtime artifacts for discarded episodes
    const runtimeDir = join(bookDir, "story", "runtime");
    try {
      const runtimeFiles = await readdir(runtimeDir);
      for (const file of runtimeFiles) {
        const match = file.match(/^episode-(\d+)\./);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetEpisode) {
          await unlink(join(runtimeDir, file)).catch(() => {});
        }
      }
    } catch {
      // runtime directory missing
    }
    await rm(join(runtimeDir, "tier2_current_arc.md"), { force: true });

    // Also check story/drafts/ for discarded episode files
    const draftsDir = join(bookDir, "story", "drafts");
    try {
      const draftFiles = await readdir(draftsDir);
      for (const file of draftFiles) {
        const match = file.match(/^(\d+)_.*\.md$/);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (num > targetEpisode) {
          await unlink(join(draftsDir, file)).catch(() => {});
        }
      }
    } catch {
      // drafts directory missing
    }

    // Drop any persisted sqlite acceleration index so discarded episodes
    // cannot leak back into retrieval after the markdown/state rollback.
    await Promise.all([
      rm(join(bookDir, "story", "memory.db"), { force: true }),
      rm(join(bookDir, "story", "memory.db-shm"), { force: true }),
      rm(join(bookDir, "story", "memory.db-wal"), { force: true }),
    ]);

    await this.saveEpisodeIndex(bookId, kept);
    return discarded;
  }

  private async writeIfMissing(path: string, content: string): Promise<void> {
    try {
      await stat(path);
    } catch {
      await atomicWriteFile(path, content, "utf-8");
    }
  }
}
