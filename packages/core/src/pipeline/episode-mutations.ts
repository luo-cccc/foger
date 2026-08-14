import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ComposeEpisodeResult, PlanEpisodeResult, RewriteEpisodeResult } from "./runner.js";
import type { AuditResult } from "../agents/continuity.js";
import type { ConsolidationResult } from "../agents/consolidator.js";
import type { EpisodeMeta } from "../models/episode.js";
import { BookConfigSchema, type BookConfig, type EpisodeReviewMode } from "../models/book.js";
import type {
  EpisodePersistenceRecovery,
  CoreWorkflowMutationKind,
  CoreWorkflowRecovery,
} from "../state/manager.js";
import {
  executeEditTransaction,
  MANUAL_EPISODE_EDIT_ISSUE,
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
import { loadEpisodeReviewEvidence } from "./episode-review-evidence.js";
import { loadEpisodeRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { EpisodeScriptSchema } from "../models/episode-script.js";

async function findBlockedReviewEpisodes(
  bookDir: string,
  episodes: ReadonlyArray<EpisodeMeta>,
): Promise<number[]> {
  const blocked: number[] = [];
  const episodesDir = join(bookDir, "episodes");
  const files = await readdir(episodesDir).catch(() => [] as string[]);
  for (const episode of episodes) {
    if (episode.status !== "ready-for-review") {
      blocked.push(episode.episodeNumber);
      continue;
    }
    const padded = String(episode.episodeNumber).padStart(4, "0");
    const jsonFile = files.find((file) =>
      file.startsWith(`${padded}_`)
      && file.endsWith(".json")
      && !file.endsWith("_review.json"),
    );
    if (!jsonFile) {
      blocked.push(episode.episodeNumber);
      continue;
    }
    const currentContent = await readFile(join(episodesDir, jsonFile), "utf8").catch(() => undefined);
    if (!currentContent) {
      blocked.push(episode.episodeNumber);
      continue;
    }
    try {
      EpisodeScriptSchema.parse(JSON.parse(currentContent));
    } catch {
      blocked.push(episode.episodeNumber);
      continue;
    }
    const evidence = await loadEpisodeReviewEvidence({
      bookDir,
      episode: episode.episodeNumber,
      currentContent,
    });
    if (!evidence || evidence.status !== "PROVISIONAL") {
      blocked.push(episode.episodeNumber);
    }
  }
  return blocked;
}

export type CoreMutationCommand =
  | {
      readonly kind: "approve";
      readonly bookId: string;
      readonly episodeNumber: number;
    }
  | {
      readonly kind: "reject";
      readonly bookId: string;
      readonly episodeNumber: number;
      readonly reason?: string;
      readonly keepSubsequent?: boolean;
    }
  | {
      readonly kind: "rewrite";
      readonly bookId: string;
      readonly episodeNumber: number;
      readonly episodeDurationSeconds?: number;
      readonly brief?: string;
    }
  | {
      readonly kind: "save-episode";
      readonly bookId: string;
      readonly episodeNumber: number;
      readonly content: string;
    }
  | {
      readonly kind: "patch-episode";
      readonly bookId: string;
      readonly episodeNumber: number;
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
        readonly episodeDurationSeconds?: unknown;
        readonly targetEpisodes?: unknown;
        readonly status?: unknown;
        readonly language?: unknown;
      };
    }
  | {
      readonly kind: "set-episode-review-mode";
      readonly bookId: string;
      readonly mode: EpisodeReviewMode | "inherit";
    }
  | {
      readonly kind: "delete-book";
      readonly bookId: string;
    }
  | {
      readonly kind: "plan-episode";
      readonly bookId: string;
      readonly context?: string;
    }
  | {
      readonly kind: "compose-episode";
      readonly bookId: string;
      readonly context?: string;
    }
  | {
      readonly kind: "audit-episode";
      readonly bookId: string;
      readonly episodeNumber?: number;
    }
  | {
      readonly kind: "consolidate-book";
      readonly bookId: string;
    };

export type EpisodeMutationCommand = Extract<
  CoreMutationCommand,
  { readonly kind: "approve" | "reject" | "rewrite" | "save-episode" | "patch-episode" }
>;

export interface ApproveEpisodeMutationResult {
  readonly bookId: string;
  readonly episodeNumber: number;
  readonly status: "approved";
}

export type RejectEpisodeMutationResult = {
  readonly bookId: string;
  readonly episodeNumber: number;
  readonly status: "rejected";
  readonly discarded: ReadonlyArray<number>;
} & (
  | { readonly keepSubsequent: true }
  | { readonly keepSubsequent: false; readonly rolledBackTo: number }
);

export interface EpisodeMutationPipeline {
  rewriteEpisode?(
    bookId: string,
    episodeNumber: number,
    episodeDurationSeconds?: number,
    externalContext?: string,
  ): Promise<RewriteEpisodeResult>;
  reviseFoundation?(bookId: string, feedback: string): Promise<void>;
  planEpisode?(bookId: string, context?: string): Promise<PlanEpisodeResult>;
  composeEpisode?(bookId: string, context?: string): Promise<ComposeEpisodeResult>;
  auditDraft?(bookId: string, episodeNumber?: number): Promise<AuditResult & { readonly episodeNumber: number }>;
  consolidateBook?(bookId: string): Promise<ConsolidationResult>;
}

export interface CoreMutationState {
  acquireBookLock(bookId: string): Promise<() => Promise<void>>;
  bookDir(bookId: string): string;
  ensureControlDocuments(bookId: string): Promise<void>;
  loadBookConfig?(bookId: string): Promise<BookConfig>;
  saveBookConfig?(bookId: string, config: BookConfig): Promise<void>;
  loadEpisodeIndex(bookId: string): Promise<ReadonlyArray<EpisodeMeta>>;
  saveEpisodeIndex(bookId: string, index: ReadonlyArray<EpisodeMeta>): Promise<void>;
  rollbackToEpisode?(bookId: string, targetEpisode: number): Promise<ReadonlyArray<number>>;
  recoverIncompleteEpisodePersistence?(bookId: string): Promise<EpisodePersistenceRecovery>;
  recoverIncompleteCoreWorkflowMutation?(bookId: string): Promise<CoreWorkflowRecovery>;
  beginCoreWorkflowMutation?(bookId: string, workflow: CoreWorkflowMutationKind): Promise<void>;
  commitCoreWorkflowMutation?(bookId: string, workflow: CoreWorkflowMutationKind): Promise<void>;
}

export interface CoreMutationDependencies {
  readonly state: CoreMutationState;
  readonly pipeline?: EpisodeMutationPipeline;
}

export type EpisodeMutationDependencies = CoreMutationDependencies;

export class EpisodeMutationEpisodeNotFoundError extends Error {
  readonly code = "EPISODE_NOT_FOUND";

  constructor(
    readonly bookId: string,
    readonly episodeNumber: number,
  ) {
    super(`Episode ${episodeNumber} not found in "${bookId}"`);
    this.name = "EpisodeMutationEpisodeNotFoundError";
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
    readonly code:
      | "INVALID_MUTATION"
      | "INVALID_BOOK_CONFIG"
      | "INVALID_TRUTH_FILE"
      | "LEGACY_TRUTH_SHIM"
      | "EPISODE_HAS_BLOCKING_REVIEW_FINDINGS"
      | "EPISODE_NOT_READY_FOR_APPROVAL"
      | "UNSAFE_REJECT_WITH_DEPENDENTS"
      | "RUNTIME_STATE_INCONSISTENT",
    message: string,
  ) {
    super(message);
    this.name = "CoreMutationValidationError";
  }
}

export interface SaveEpisodeMutationResult {
  readonly bookId: string;
  readonly episodeNumber: number;
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
  readonly episodeNumbers: ReadonlyArray<number>;
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

export interface SetEpisodeReviewModeMutationResult {
  readonly bookId: string;
  readonly bookMode: EpisodeReviewMode | null;
  readonly book: BookConfig;
}

export interface DeleteBookMutationResult {
  readonly bookId: string;
  readonly deleted: true;
}

type AppliedEpisodePersistenceRecovery = Exclude<EpisodePersistenceRecovery, { readonly kind: "none" }>;

export type RecoverableCoreMutationResult<T extends object> = T & {
  readonly recovery?: AppliedEpisodePersistenceRecovery;
  readonly workflowRecovery?: Exclude<CoreWorkflowRecovery, { readonly kind: "none" }>;
};

type ApproveEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "approve" }>;

/**
 * Approving commits review status on top of persisted runtime state. If the
 * state files drifted (e.g. a degraded episode write left the manifest ahead
 * of current_state / episode_summaries), approving on top makes the drift
 * harder to trace — refuse early with an actionable repair hint instead.
 */
async function assertRuntimeStateConsistent(bookDir: string, action: string): Promise<void> {
  try {
    await loadEpisodeRuntimeStateSnapshot(bookDir);
  } catch (error) {
    throw new CoreMutationValidationError(
      "RUNTIME_STATE_INCONSISTENT",
      `Cannot ${action}: persisted runtime state is inconsistent (${error instanceof Error ? error.message : String(error)}). Repair it first with \`inkos write sync <book> <episode> [--brief "<guidance>"]\` or \`inkos write repair-state <book> <episode>\`.`,
    );
  }
}type RejectEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "reject" }>;
type RewriteEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "rewrite" }>;
type SaveEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "save-episode" | "patch-episode" }>;
type ReviseFoundationMutationCommand = Extract<CoreMutationCommand, { readonly kind: "revise-foundation" }>;
type EditTruthMutationCommand = Extract<CoreMutationCommand, { readonly kind: "edit-truth" }>;
type ApproveAllMutationCommand = Extract<CoreMutationCommand, { readonly kind: "approve-all" }>;
type RenameEntityMutationCommand = Extract<CoreMutationCommand, { readonly kind: "rename-entity" }>;
type UpdateBookConfigMutationCommand = Extract<CoreMutationCommand, { readonly kind: "update-book-config" }>;
type SetEpisodeReviewModeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "set-episode-review-mode" }>;
type DeleteBookMutationCommand = Extract<CoreMutationCommand, { readonly kind: "delete-book" }>;
type PlanEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "plan-episode" }>;
type ComposeEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "compose-episode" }>;
type AuditEpisodeMutationCommand = Extract<CoreMutationCommand, { readonly kind: "audit-episode" }>;
type ConsolidateBookMutationCommand = Extract<CoreMutationCommand, { readonly kind: "consolidate-book" }>;

export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ApproveEpisodeMutationCommand,
): Promise<ApproveEpisodeMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: RejectEpisodeMutationCommand,
): Promise<RejectEpisodeMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: RewriteEpisodeMutationCommand,
): Promise<RewriteEpisodeResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: SaveEpisodeMutationCommand,
): Promise<SaveEpisodeMutationResult>;
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
  command: SetEpisodeReviewModeMutationCommand,
): Promise<SetEpisodeReviewModeMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: DeleteBookMutationCommand,
): Promise<DeleteBookMutationResult>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: PlanEpisodeMutationCommand,
): Promise<RecoverableCoreMutationResult<PlanEpisodeResult>>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ComposeEpisodeMutationCommand,
): Promise<RecoverableCoreMutationResult<ComposeEpisodeResult>>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: AuditEpisodeMutationCommand,
): Promise<RecoverableCoreMutationResult<AuditResult & { readonly episodeNumber: number }>>;
export function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: ConsolidateBookMutationCommand,
): Promise<RecoverableCoreMutationResult<ConsolidationResult>>;
export async function executeCoreMutation(
  dependencies: CoreMutationDependencies,
  command: CoreMutationCommand,
): Promise<
  | ApproveEpisodeMutationResult
  | RejectEpisodeMutationResult
  | RewriteEpisodeResult
  | SaveEpisodeMutationResult
  | ReviseFoundationMutationResult
  | EditTruthMutationResult
  | ApproveAllMutationResult
  | RenameEntityMutationResult
  | UpdateBookConfigMutationResult
  | SetEpisodeReviewModeMutationResult
  | DeleteBookMutationResult
  | RecoverableCoreMutationResult<PlanEpisodeResult>
  | RecoverableCoreMutationResult<ComposeEpisodeResult>
  | RecoverableCoreMutationResult<AuditResult & { readonly episodeNumber: number }>
  | RecoverableCoreMutationResult<ConsolidationResult>
> {
  assertCoreMutationCommand(command);

  if (command.kind === "rewrite") {
    if (!dependencies.pipeline?.rewriteEpisode) {
      throw new Error("A pipeline is required for rewrite episode mutations");
    }
    return await dependencies.pipeline.rewriteEpisode(
      command.bookId,
      command.episodeNumber,
      command.episodeDurationSeconds,
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
      command.kind === "plan-episode"
      || command.kind === "compose-episode"
      || command.kind === "audit-episode"
      || command.kind === "consolidate-book"
    ) {
      const workflow = command.kind;
      const workflowRecovery = await dependencies.state.recoverIncompleteCoreWorkflowMutation?.(command.bookId)
        ?? { kind: "none" as const };
      const recovery = await dependencies.state.recoverIncompleteEpisodePersistence?.(command.bookId)
        ?? { kind: "none" as const };
      await dependencies.state.beginCoreWorkflowMutation?.(command.bookId, workflow);
      try {
        let result:
          | PlanEpisodeResult
          | ComposeEpisodeResult
          | (AuditResult & { readonly episodeNumber: number })
          | ConsolidationResult;
        if (command.kind === "plan-episode") {
          if (!dependencies.pipeline?.planEpisode) throw new Error("A pipeline is required for plan episode mutations");
          result = await dependencies.pipeline.planEpisode(command.bookId, command.context);
        } else if (command.kind === "compose-episode") {
          if (!dependencies.pipeline?.composeEpisode) throw new Error("A pipeline is required for compose episode mutations");
          result = await dependencies.pipeline.composeEpisode(command.bookId, command.context);
        } else if (command.kind === "audit-episode") {
          if (!dependencies.pipeline?.auditDraft) throw new Error("A pipeline is required for audit episode mutations");
          result = await dependencies.pipeline.auditDraft(command.bookId, command.episodeNumber);
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
        ...(command.updates.episodeDurationSeconds !== undefined
          ? { episodeDurationSeconds: command.updates.episodeDurationSeconds }
          : {}),
        ...(command.updates.targetEpisodes !== undefined
          ? { targetEpisodes: command.updates.targetEpisodes }
          : {}),
        ...(command.updates.targetEpisodes !== undefined
          ? { targetEpisodes: command.updates.targetEpisodes }
          : {}),
        ...(command.updates.episodeDurationSeconds !== undefined
          ? { episodeDurationSeconds: command.updates.episodeDurationSeconds }
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

    if (command.kind === "set-episode-review-mode") {
      if (!dependencies.state.loadBookConfig || !dependencies.state.saveBookConfig) {
        throw new Error("Book config repository is required for episode review mode mutations");
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

    if (command.kind === "save-episode" || command.kind === "patch-episode") {
      const execution = await executeEpisodeEditMutation(dependencies.state, command);
      return {
        bookId: command.bookId,
        episodeNumber: command.episodeNumber,
        status: "audit-failed",
        warning: `[critical] ${MANUAL_EPISODE_EDIT_ISSUE}`,
        execution,
      };
    }

    const index = await dependencies.state.loadEpisodeIndex(command.bookId);
    if (command.kind === "approve-all") {
      const episodeNumbers: number[] = [];
      const now = new Date().toISOString();
      const pending = index.filter((episode) =>
        episode.status === "ready-for-review",
      );
      const blocked = await findBlockedReviewEpisodes(
        dependencies.state.bookDir(command.bookId),
        pending,
      );
      if (blocked.length > 0) {
        throw new CoreMutationValidationError(
          "EPISODE_HAS_BLOCKING_REVIEW_FINDINGS",
          `Cannot approve episodes with open blocking review findings: ${blocked.join(", ")}. Revise those episodes first.`,
        );
      }
      await assertRuntimeStateConsistent(dependencies.state.bookDir(command.bookId), "approve episodes");
      const updated = index.map((episode) => {
        if (episode.status !== "ready-for-review") {
          return episode;
        }
        episodeNumbers.push(episode.episodeNumber);
        return { ...episode, status: "approved" as const, updatedAt: now };
      });
      await dependencies.state.saveEpisodeIndex(command.bookId, updated);
      return { bookId: command.bookId, approvedCount: episodeNumbers.length, episodeNumbers };
    }
    const episodeIndex = index.findIndex((episode) => episode.episodeNumber === command.episodeNumber);
    if (episodeIndex === -1) {
      throw new EpisodeMutationEpisodeNotFoundError(command.bookId, command.episodeNumber);
    }

    if (command.kind === "approve") {
      if (index[episodeIndex]!.status !== "ready-for-review") {
        throw new CoreMutationValidationError(
          "EPISODE_NOT_READY_FOR_APPROVAL",
          `Episode ${command.episodeNumber} is ${index[episodeIndex]!.status}; audit it successfully before approval.`,
        );
      }
      const blocked = await findBlockedReviewEpisodes(
        dependencies.state.bookDir(command.bookId),
        [index[episodeIndex]!],
      );
      if (blocked.length > 0) {
        throw new CoreMutationValidationError(
          "EPISODE_HAS_BLOCKING_REVIEW_FINDINGS",
          `Episode ${blocked[0]} has open blocking review findings. Revise it before approval.`,
        );
      }
      await assertRuntimeStateConsistent(dependencies.state.bookDir(command.bookId), `approve episode ${command.episodeNumber}`);
      const updated = [...index];
      updated[episodeIndex] = {
        ...updated[episodeIndex]!,
        status: "approved",
        updatedAt: new Date().toISOString(),
      };
      await dependencies.state.saveEpisodeIndex(command.bookId, updated);
      return {
        bookId: command.bookId,
        episodeNumber: command.episodeNumber,
        status: "approved",
      };
    }

    if (command.keepSubsequent) {
      const dependentEpisodes = index
        .filter((episode) => episode.episodeNumber > command.episodeNumber)
        .map((episode) => episode.episodeNumber);
      if (dependentEpisodes.length > 0) {
        throw new CoreMutationValidationError(
          "UNSAFE_REJECT_WITH_DEPENDENTS",
          `Cannot reject episode ${command.episodeNumber} while keeping dependent episodes: ${dependentEpisodes.join(", ")}.`,
        );
      }
      const updated = [...index];
      updated[episodeIndex] = {
        ...updated[episodeIndex]!,
        status: "rejected",
        reviewNote: command.reason ?? "Rejected without reason",
        updatedAt: new Date().toISOString(),
      };
      await dependencies.state.saveEpisodeIndex(command.bookId, updated);
      return {
        bookId: command.bookId,
        episodeNumber: command.episodeNumber,
        status: "rejected",
        discarded: [],
        keepSubsequent: true,
      };
    }

    const rolledBackTo = command.episodeNumber - 1;
    if (!dependencies.state.rollbackToEpisode) {
      throw new Error("State rollback is required for reject episode mutations");
    }
    const discarded = await dependencies.state.rollbackToEpisode(command.bookId, rolledBackTo);
    return {
      bookId: command.bookId,
      episodeNumber: command.episodeNumber,
      status: "rejected",
      discarded,
      keepSubsequent: false,
      rolledBackTo,
    };
  } finally {
    await releaseLock();
  }
}

export const executeEpisodeMutation = executeCoreMutation;

function assertCoreMutationCommand(command: CoreMutationCommand): void {
  if (!isSafeBookId(command.bookId)) {
    throw new CoreMutationValidationError("INVALID_MUTATION", `Invalid book ID: ${JSON.stringify(command.bookId)}`);
  }
  if (
    "episodeNumber" in command
    && command.episodeNumber !== undefined
    && (!Number.isInteger(command.episodeNumber) || command.episodeNumber < 1)
  ) {
    throw new CoreMutationValidationError("INVALID_MUTATION", `Invalid episode number: ${command.episodeNumber}`);
  }
  if (command.kind === "revise-foundation" && !command.feedback.trim()) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Foundation revision feedback is required");
  }
  if (command.kind === "save-episode" && !command.content.trim()) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Episode content is required");
  }
  if (command.kind === "patch-episode" && !command.targetText) {
    throw new CoreMutationValidationError("INVALID_MUTATION", "Episode patch target text is required");
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
  recovery: EpisodePersistenceRecovery,
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

async function executeEpisodeEditMutation(
  state: CoreMutationState,
  command: SaveEpisodeMutationCommand,
): Promise<ExecutedEditTransaction> {
  try {
    return await executeEditTransaction(
      editExecutionDependencies(state),
      command.kind === "save-episode"
        ? {
            kind: "episode-replace",
            bookId: command.bookId,
            episodeNumber: command.episodeNumber,
            fullText: command.content,
          }
        : {
            kind: "episode-local-edit",
            bookId: command.bookId,
            episodeNumber: command.episodeNumber,
            instruction: `Replace ${command.targetText} with ${command.replacementText}`,
            targetText: command.targetText,
            replacementText: command.replacementText,
          },
    );
  } catch (error) {
    if (/Episode \d+ not found/i.test(error instanceof Error ? error.message : String(error))) {
      throw new EpisodeMutationEpisodeNotFoundError(command.bookId, command.episodeNumber);
    }
    throw error;
  }
}

function editExecutionDependencies(state: CoreMutationState) {
  return {
    bookDir: (bookId: string) => state.bookDir(bookId),
    loadEpisodeIndex: (bookId: string) => state.loadEpisodeIndex(bookId),
    saveEpisodeIndex: (bookId: string, index: ReadonlyArray<EpisodeMeta>) => state.saveEpisodeIndex(bookId, index),
  };
}
