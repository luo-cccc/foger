import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ComposeChapterResult, PlanChapterResult, RewriteChapterResult } from "./runner.js";
import type { AuditResult } from "../agents/continuity.js";
import type { ConsolidationResult } from "../agents/consolidator.js";
import type { ChapterMeta } from "../models/chapter.js";
import { BookConfigSchema, type BookConfig, type ChapterReviewMode } from "../models/book.js";
import type {
  ChapterPersistenceRecovery,
  CoreWorkflowMutationKind,
  CoreWorkflowRecovery,
} from "../state/manager.js";
import {
  executeEditTransaction,
  MANUAL_CHAPTER_EDIT_ISSUE,
  type ExecutedEditTransaction,
} from "../interaction/edit-controller.js";
import {
  assertSafeTruthFileName,
  isRuntimeDiagnosticTruthFile,
  LEGACY_TRUTH_SHIM_FILES,
} from "../interaction/truth-file-policy.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { isSafeBookId } from "../utils/book-id.js";
import { isNewLayoutBook } from "../utils/outline-paths.js";

export type CoreMutationCommand =
  | {
      readonly kind: "approve";
      readonly bookId: string;
      readonly chapterNumber: number;
    }
  | {
      readonly kind: "reject";
      readonly bookId: string;
      readonly chapterNumber: number;
      readonly reason?: string;
      readonly keepSubsequent?: boolean;
    }
  | {
      readonly kind: "rewrite";
      readonly bookId: string;
      readonly chapterNumber: number;
      readonly wordCount?: number;
      readonly brief?: string;
    }
  | {
      readonly kind: "save-chapter";
      readonly bookId: string;
      readonly chapterNumber: number;
      readonly content: string;
    }
  | {
      readonly kind: "patch-chapter";
      readonly bookId: string;
      readonly chapterNumber: number;
      readonly targetText: string;
      readonly replacementText: string;
    }
  | {
      readonly kind: "revise-foundation";
      readonly bookId: string;
      readonly feedback: string;
    }
  | {
      readonly kind: "edit-truth";
      readonly bookId: string;
      readonly fileName: string;
      readonly content: string;
    }
  | {
      readonly kind: "approve-all";
      readonly bookId: string;
    }
  | {
      readonly kind: "rename-entity";
      readonly bookId: string;
      readonly entityType: "protagonist" | "character" | "location" | "organization";
      readonly oldValue: string;
      readonly newValue: string;
    }
  | {
      readonly kind: "update-book-config";
      readonly bookId: string;
      readonly updates: {
        readonly chapterWordCount?: unknown;
        readonly targetChapters?: unknown;
        readonly status?: unknown;
        readonly language?: unknown;
      };
    }
  | {
      readonly kind: "set-chapter-review-mode";
      readonly bookId: string;
      readonly mode: ChapterReviewMode | "inherit";
    }
  | {
      readonly kind: "delete-book";
      readonly bookId: string;
    }
  | {
      readonly kind: "plan-chapter";
      readonly bookId: string;
      readonly context?: string;
    }
  | {
      readonly kind: "compose-chapter";
      readonly bookId: string;
      readonly context?: string;
    }
  | {
      readonly kind: "audit-chapter";
      readonly bookId: string;
      readonly chapterNumber?: number;
    }
  | {
      readonly kind: "consolidate-book";
      readonly bookId: string;
    };

export type ChapterMutationCommand = Extract<
  CoreMutationCommand,
  { readonly kind: "approve" | "reject" | "rewrite" | "save-chapter" | "patch-chapter" }
>;

export interface ApproveChapterMutationResult {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly status: "approved";
}

export type RejectChapterMutationResult = {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly status: "rejected";
  readonly discarded: ReadonlyArray<number>;
} & (
  | { readonly keepSubsequent: true }
  | { readonly keepSubsequent: false; readonly rolledBackTo: number }
);

export interface ChapterMutationPipeline {
  rewriteChapter?(
    bookId: string,
    chapterNumber: number,
    wordCount?: number,
    externalContext?: string,
  ): Promise<RewriteChapterResult>;
  reviseFoundation?(bookId: string, feedback: string): Promise<void>;
  planChapter?(bookId: string, context?: string): Promise<PlanChapterResult>;
  composeChapter?(bookId: string, context?: string): Promise<ComposeChapterResult>;
  auditDraft?(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number }>;
  consolidateBook?(bookId: string): Promise<ConsolidationResult>;
}

export interface CoreMutationState {
  acquireBookLock(bookId: string): Promise<() => Promise<void>>;
  bookDir(bookId: string): string;
  ensureControlDocuments(bookId: string): Promise<void>;
  loadBookConfig?(bookId: string): Promise<BookConfig>;
  saveBookConfig?(bookId: string, config: BookConfig): Promise<void>;
  loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>>;
  saveChapterIndex(bookId: string, index: ReadonlyArray<ChapterMeta>): Promise<void>;
  rollbackToChapter?(bookId: string, targetChapter: number): Promise<ReadonlyArray<number>>;
  recoverIncompleteChapterPersistence?(bookId: string): Promise<ChapterPersistenceRecovery>;
  recoverIncompleteCoreWorkflowMutation?(bookId: string): Promise<CoreWorkflowRecovery>;
  beginCoreWorkflowMutation?(bookId: string, workflow: CoreWorkflowMutationKind): Promise<void>;
  commitCoreWorkflowMutation?(bookId: string, workflow: CoreWorkflowMutationKind): Promise<void>;
}

export interface CoreMutationDependencies {
  readonly state: CoreMutationState;
  readonly pipeline?: ChapterMutationPipeline;
}

export type ChapterMutationDependencies = CoreMutationDependencies;

export class ChapterMutationChapterNotFoundError extends Error {
  readonly code = "CHAPTER_NOT_FOUND";

  constructor(
    readonly bookId: string,
    readonly chapterNumber: number,
  ) {
    super(`Chapter ${chapterNumber} not found in "${bookId}"`);
    this.name = "ChapterMutationChapterNotFoundError";
  }
}

export class CoreMutationBookNotFoundError extends Error {
  readonly code = "BOOK_NOT_FOUND";

  constructor(readonly bookId: string) {
    super(`Book "${bookId}" not found`);
    this.name = "CoreMutationBookNotFoundError";
  }
}

export class CoreMutationValidationError extends Error {
  constructor(
    readonly code: "INVALID_MUTATION" | "INVALID_BOOK_CONFIG" | "INVALID_TRUTH_FILE" | "LEGACY_TRUTH_SHIM",
    message: string,
  ) {
    super(message);
    this.name = "CoreMutationValidationError";
  }
}

export interface SaveChapterMutationResult {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly status: "audit-failed";
  readonly warning: string;
  readonly execution: ExecutedEditTransaction;
}

export interface ReviseFoundationMutationResult {
  readonly bookId: string;
  readonly revised: true;
}

export interface EditTruthMutationResult {
  readonly bookId: string;
  readonly fileName: string;
}

export interface ApproveAllMutationResult {
  readonly bookId: string;
  readonly approvedCount: number;
  readonly chapterNumbers: ReadonlyArray<number>;
}

export interface RenameEntityMutationResult {
  readonly bookId: string;
  readonly execution: ExecutedEditTransaction;
}

export interface UpdateBookConfigMutationResult {
  readonly bookId: string;
  readonly previous: BookConfig;
  readonly book: BookConfig;
}

export interface SetChapterReviewModeMutationResult {
  readonly bookId: string;
  readonly bookMode: ChapterReviewMode | null;
  readonly book: BookConfig;
}

export interface DeleteBookMutationResult {
  readonly bookId: string;
  readonly deleted: true;
}

type AppliedChapterPersistenceRecovery = Exclude<ChapterPersistenceRecovery, { readonly kind: "none" }>;

export type RecoverableCoreMutationResult<T extends object> = T & {
  readonly recovery?: AppliedChapterPersistenceRecovery;
  readonly workflowRecovery?: Exclude<CoreWorkflowRecovery, { readonly kind: "none" }>;
};

type ApproveChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "approve" }>;
type RejectChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "reject" }>;
type RewriteChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "rewrite" }>;
type SaveChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "save-chapter" | "patch-chapter" }>;
type ReviseFoundationMutationCommand = Extract<CoreMutationCommand, { readonly kind: "revise-foundation" }>;
type EditTruthMutationCommand = Extract<CoreMutationCommand, { readonly kind: "edit-truth" }>;
type ApproveAllMutationCommand = Extract<CoreMutationCommand, { readonly kind: "approve-all" }>;
type RenameEntityMutationCommand = Extract<CoreMutationCommand, { readonly kind: "rename-entity" }>;
type UpdateBookConfigMutationCommand = Extract<CoreMutationCommand, { readonly kind: "update-book-config" }>;
type SetChapterReviewModeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "set-chapter-review-mode" }>;
type DeleteBookMutationCommand = Extract<CoreMutationCommand, { readonly kind: "delete-book" }>;
type PlanChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "plan-chapter" }>;
type ComposeChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "compose-chapter" }>;
type AuditChapterMutationCommand = Extract<CoreMutationCommand, { readonly kind: "audit-chapter" }>;
type ConsolidateBookMutationCommand = Extract<CoreMutationCommand, { readonly kind: "consolidate-book" }>;

export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ApproveChapterMutationCommand,
): Promise<ApproveChapterMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: RejectChapterMutationCommand,
): Promise<RejectChapterMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: RewriteChapterMutationCommand,
): Promise<RewriteChapterResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: SaveChapterMutationCommand,
): Promise<SaveChapterMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ReviseFoundationMutationCommand,
): Promise<ReviseFoundationMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: EditTruthMutationCommand,
): Promise<EditTruthMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ApproveAllMutationCommand,
): Promise<ApproveAllMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: RenameEntityMutationCommand,
): Promise<RenameEntityMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: UpdateBookConfigMutationCommand,
): Promise<UpdateBookConfigMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: SetChapterReviewModeMutationCommand,
): Promise<SetChapterReviewModeMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: DeleteBookMutationCommand,
): Promise<DeleteBookMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: PlanChapterMutationCommand,
): Promise<RecoverableCoreMutationResult<PlanChapterResult>>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ComposeChapterMutationCommand,
): Promise<RecoverableCoreMutationResult<ComposeChapterResult>>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: AuditChapterMutationCommand,
): Promise<RecoverableCoreMutationResult<AuditResult & { readonly chapterNumber: number }>>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ConsolidateBookMutationCommand,
): Promise<RecoverableCoreMutationResult<ConsolidationResult>>;
export async function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: CoreMutationCommand,
): Promise<
  | ApproveChapterMutationResult
  | RejectChapterMutationResult
  | RewriteChapterResult
  | SaveChapterMutationResult
  | ReviseFoundationMutationResult
  | EditTruthMutationResult
  | ApproveAllMutationResult
  | RenameEntityMutationResult
  | UpdateBookConfigMutationResult
  | SetChapterReviewModeMutationResult
  | DeleteBookMutationResult
  | RecoverableCoreMutationResult<PlanChapterResult>
  | RecoverableCoreMutationResult<ComposeChapterResult>
  | RecoverableCoreMutationResult<AuditResult & { readonly chapterNumber: number }>
  | RecoverableCoreMutationResult<ConsolidationResult>
> {
  assertCoreMutationCommand(command);

  if (command.kind === "rewrite") {
    if (!dependencies.pipeline?.rewriteChapter) {
      throw new Error("A pipeline is required for rewrite chapter mutations");
    }
    return await dependencies.pipeline.rewriteChapter(
      command.bookId,
      command.chapterNumber,
      command.wordCount,
      command.brief,
    );
  }

  if (command.kind === "delete-book") {
    try {
      await stat(dependencies.state.bookDir(command.bookId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        throw new CoreMutationBookNotFoundError(command.bookId);
      }
      throw error;
    }
  }

  const releaseLock = await dependencies.state.acquireBookLock(command.bookId);
  try {
    if (
      command.kind === "plan-chapter"
      || command.kind === "compose-chapter"
      || command.kind === "audit-chapter"
      || command.kind === "consolidate-book"
    ) {
      const workflow = command.kind;
      const workflowRecovery = await dependencies.state.recoverIncompleteCoreWorkflowMutation?.(command.bookId)
        ?? { kind: "none" as const };
      const recovery = await dependencies.state.recoverIncompleteChapterPersistence?.(command.bookId)
        ?? { kind: "none" as const };
      await dependencies.state.beginCoreWorkflowMutation?.(command.bookId, workflow);
      try {
        let result:
          | PlanChapterResult
          | ComposeChapterResult
          | (AuditResult & { readonly chapterNumber: number })
          | ConsolidationResult;
        if (command.kind === "plan-chapter") {
          if (!dependencies.pipeline?.planChapter) throw new Error("A pipeline is required for plan chapter mutations");
          result = await dependencies.pipeline.planChapter(command.bookId, command.context);
        } else if (command.kind === "compose-chapter") {
          if (!dependencies.pipeline?.composeChapter) throw new Error("A pipeline is required for compose chapter mutations");
          result = await dependencies.pipeline.composeChapter(command.bookId, command.context);
        } else if (command.kind === "audit-chapter") {
          if (!dependencies.pipeline?.auditDraft) throw new Error("A pipeline is required for audit chapter mutations");
          result = await dependencies.pipeline.auditDraft(command.bookId, command.chapterNumber);
        } else {
          if (!dependencies.pipeline?.consolidateBook) throw new Error("A consolidator is required for consolidate book mutations");
          result = await dependencies.pipeline.consolidateBook(command.bookId);
        }
        await dependencies.state.commitCoreWorkflowMutation?.(command.bookId, workflow);
        return withCoreWorkflowRecovery(result, recovery, workflowRecovery);
      } catch (error) {
        await dependencies.state.recoverIncompleteCoreWorkflowMutation?.(command.bookId);
        throw error;
      }
    }

    if (command.kind === "delete-book") {
      await rm(dependencies.state.bookDir(command.bookId), { recursive: true, force: true });
      return { bookId: command.bookId, deleted: true };
    }

    if (command.kind === "revise-foundation") {
      if (!dependencies.pipeline?.reviseFoundation) {
        throw new Error("A pipeline is required for foundation revision mutations");
      }
      await dependencies.pipeline.reviseFoundation(command.bookId, command.feedback.trim());
      return { bookId: command.bookId, revised: true };
    }

    if (command.kind === "edit-truth") {
      await dependencies.state.ensureControlDocuments(command.bookId);
      const fileName = resolveWritableTruthFileName(command.fileName);
      const bookDir = dependencies.state.bookDir(command.bookId);
      if (LEGACY_TRUTH_SHIM_FILES.has(fileName) && await isNewLayoutBook(bookDir)) {
        throw new CoreMutationValidationError(
          "LEGACY_TRUTH_SHIM",
          "Legacy compat shim; edit outline/story_frame.md instead",
        );
      }
      const targetPath = join(bookDir, "story", fileName);
      await mkdir(join(bookDir, "story"), { recursive: true });
      await atomicWriteFile(targetPath, command.content, "utf-8");
      return { bookId: command.bookId, fileName };
    }

    if (command.kind === "rename-entity") {
      const execution = await executeEditTransaction(
        editExecutionDependencies(dependencies.state),
        {
          kind: "entity-rename",
          bookId: command.bookId,
          entityType: command.entityType,
          oldValue: command.oldValue,
          newValue: command.newValue,
        },
      );
      return { bookId: command.bookId, execution };
    }

    if (command.kind === "update-book-config") {
      if (!dependencies.state.loadBookConfig || !dependencies.state.saveBookConfig) {
        throw new Error("Book config repository is required for update-book-config mutations");
      }
      const previous = await dependencies.state.loadBookConfig(command.bookId);
      const parsed = BookConfigSchema.safeParse({
        ...previous,
        ...(command.updates.chapterWordCount !== undefined
          ? { chapterWordCount: command.updates.chapterWordCount }
          : {}),
        ...(command.updates.targetChapters !== undefined
          ? { targetChapters: command.updates.targetChapters }
          : {}),
        ...(command.updates.status !== undefined ? { status: command.updates.status } : {}),
        ...(command.updates.language !== undefined ? { language: command.updates.language } : {}),
        updatedAt: new Date().toISOString(),
      });
      if (!parsed.success) {
        throw new CoreMutationValidationError(
          "INVALID_BOOK_CONFIG",
          parsed.error.issues[0]?.message ?? "Invalid book config",
        );
      }
      await dependencies.state.saveBookConfig(command.bookId, parsed.data);
      return { bookId: command.bookId, previous, book: parsed.data };
    }

    if (command.kind === "set-chapter-review-mode") {
      if (!dependencies.state.loadBookConfig || !dependencies.state.saveBookConfig) {
        throw new Error("Book config repository is required for chapter review mode mutations");
      }
      const previous = await dependencies.state.loadBookConfig(command.bookId);
      const writing = { ...(previous.writing ?? {}) };
      if (command.mode === "inherit") {
        delete writing.reviewMode;
      } else {
        writing.reviewMode = command.mode;
      }
      const parsed = BookConfigSchema.safeParse({
        ...previous,
        ...(Object.keys(writing).length > 0 ? { writing } : { writing: undefined }),
        updatedAt: new Date().toISOString(),
      });
      if (!parsed.success) {
        throw new CoreMutationValidationError(
          "INVALID_BOOK_CONFIG",
          parsed.error.issues[0]?.message ?? "Invalid book config",
        );
      }
      await dependencies.state.saveBookConfig(command.bookId, parsed.data);
      return {
        bookId: command.bookId,
        bookMode: parsed.data.writing?.reviewMode ?? null,
        book: parsed.data,
      };
    }

    if (command.kind === "save-chapter" || command.kind === "patch-chapter") {
      const execution = await executeChapterEditMutation(dependencies.state, command);
      return {
        bookId: command.bookId,
        chapterNumber: command.chapterNumber,
        status: "audit-failed",
        warning: `[warning] ${MANUAL_CHAPTER_EDIT_ISSUE}`,
        execution,
      };
    }

    const index = await dependencies.state.loadChapterIndex(command.bookId);
    if (command.kind === "approve-all") {
      const chapterNumbers: number[] = [];
      const now = new Date().toISOString();
      const updated = index.map((chapter) => {
        if (chapter.status !== "ready-for-review" && chapter.status !== "audit-failed") {
          return chapter;
        }
        chapterNumbers.push(chapter.number);
        return { ...chapter, status: "approved" as const, updatedAt: now };
      });
      await dependencies.state.saveChapterIndex(command.bookId, updated);
      return { bookId: command.bookId, approvedCount: chapterNumbers.length, chapterNumbers };
    }
    const chapterIndex = index.findIndex((chapter) => chapter.number === command.chapterNumber);
    if (chapterIndex === -1) {
      throw new ChapterMutationChapterNotFoundError(command.bookId, command.chapterNumber);
    }

    if (command.kind === "approve") {
      const updated = [...index];
      updated[chapterIndex] = {
        ...updated[chapterIndex]!,
        status: "approved",
        updatedAt: new Date().toISOString(),
      };
      await dependencies.state.saveChapterIndex(command.bookId, updated);
      return {
        bookId: command.bookId,
        chapterNumber: command.chapterNumber,
        status: "approved",
      };
    }

    if (command.keepSubsequent) {
      const updated = [...index];
      updated[chapterIndex] = {
        ...updated[chapterIndex]!,
        status: "rejected",
        reviewNote: command.reason ?? "Rejected without reason",
        updatedAt: new Date().toISOString(),
      };
      await dependencies.state.saveChapterIndex(command.bookId, updated);
      return {
        bookId: command.bookId,
        chapterNumber: command.chapterNumber,
        status: "rejected",
        discarded: [],
        keepSubsequent: true,
      };
    }

    const rolledBackTo = command.chapterNumber - 1;
    if (!dependencies.state.rollbackToChapter) {
      throw new Error("State rollback is required for reject chapter mutations");
    }
    const discarded = await dependencies.state.rollbackToChapter(command.bookId, rolledBackTo);
    return {
      bookId: command.bookId,
      chapterNumber: command.chapterNumber,
      status: "rejected",
      discarded,
      keepSubsequent: false,
      rolledBackTo,
    };
  } finally {
    await releaseLock();
  }
}

export const executeChapterMutation = executeCoreMutation;

function assertCoreMutationCommand(command: CoreMutationCommand): void {
  if (!isSafeBookId(command.bookId)) {
    throw new CoreMutationValidationError("INVALID_MUTATION", `Invalid book ID: ${JSON.stringify(command.bookId)}`);
  }
  if (
    "chapterNumber" in command
    && command.chapterNumber !== undefined
    && (!Number.isInteger(command.chapterNumber) || command.chapterNumber < 1)
  ) {
    throw new CoreMutationValidationError("INVALID_MUTATION", `Invalid chapter number: ${command.chapterNumber}`);
  }
  if (command.kind === "revise-foundation" && !command.feedback.trim()) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Foundation revision feedback is required");
  }
  if (command.kind === "save-chapter" && !command.content.trim()) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Chapter content is required");
  }
  if (command.kind === "patch-chapter" && !command.targetText) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Chapter patch target text is required");
  }
  if (command.kind === "rename-entity" && (!command.oldValue.trim() || !command.newValue.trim())) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Entity rename requires old and new values");
  }
  if (command.kind === "update-book-config" && Object.values(command.updates).every((value) => value === undefined)) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Book config update requires at least one field");
  }
}

function withCoreWorkflowRecovery<T extends object>(
  result: T,
  recovery: ChapterPersistenceRecovery,
  workflowRecovery: CoreWorkflowRecovery,
): RecoverableCoreMutationResult<T> {
  return {
    ...result,
    ...(recovery.kind === "none" ? {} : { recovery }),
    ...(workflowRecovery.kind === "none" ? {} : { workflowRecovery }),
  };
}

function resolveWritableTruthFileName(fileName: string): string {
  if (isRuntimeDiagnosticTruthFile(fileName)) {
    throw new CoreMutationValidationError(
      "INVALID_TRUTH_FILE",
      "Runtime diagnostic files are read-only",
    );
  }
  try {
    return assertSafeTruthFileName(fileName);
  } catch (error) {
    throw new CoreMutationValidationError(
      "INVALID_TRUTH_FILE",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executeChapterEditMutation(
  state: CoreMutationState,
  command: SaveChapterMutationCommand,
): Promise<ExecutedEditTransaction> {
  try {
    return await executeEditTransaction(
      editExecutionDependencies(state),
      command.kind === "save-chapter"
        ? {
            kind: "chapter-replace",
            bookId: command.bookId,
            chapterNumber: command.chapterNumber,
            fullText: command.content,
          }
        : {
            kind: "chapter-local-edit",
            bookId: command.bookId,
            chapterNumber: command.chapterNumber,
            instruction: `Replace ${command.targetText} with ${command.replacementText}`,
            targetText: command.targetText,
            replacementText: command.replacementText,
          },
    );
  } catch (error) {
    if (/Chapter \d+ not found/i.test(error instanceof Error ? error.message : String(error))) {
      throw new ChapterMutationChapterNotFoundError(command.bookId, command.chapterNumber);
    }
    throw error;
  }
}

function editExecutionDependencies(state: CoreMutationState) {
  return {
    bookDir: (bookId: string) => state.bookDir(bookId),
    loadChapterIndex: (bookId: string) => state.loadChapterIndex(bookId),
    saveChapterIndex: (bookId: string, index: ReadonlyArray<ChapterMeta>) => state.saveChapterIndex(bookId, index),
  };
}
