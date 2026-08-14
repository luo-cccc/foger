import { access, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { EpisodeMeta } from "../models/episode.js";
import { parseEpisodeScriptOutput, renderEpisodeScriptMarkdown } from "../models/episode-script.js";
import { buildEpisodeRecoveryState } from "../pipeline/episode-recovery-policy.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import type { TruthAuthority } from "./truth-authority.js";

export type EditRequest =
  | {
      readonly kind: "entity-rename";
      readonly bookId: string;
      readonly entityType: "protagonist" | "character" | "location" | "organization";
      readonly oldValue: string;
      readonly newValue: string;
    }
  | {
      readonly kind: "episode-rewrite";
      readonly bookId: string;
      readonly episodeNumber: number;
      readonly instruction: string;
    }
  | {
      readonly kind: "episode-replace";
      readonly bookId: string;
      readonly episodeNumber: number;
      readonly fullText: string;
    }
  | {
      readonly kind: "episode-local-edit";
      readonly bookId: string;
      readonly episodeNumber: number;
      readonly instruction: string;
      readonly targetText?: string;
      readonly replacementText?: string;
    }
  | {
      readonly kind: "focus-edit";
      readonly bookId: string;
      readonly instruction: string;
    };

export interface PlannedEditTransaction {
  readonly transactionType: EditRequest["kind"];
  readonly bookId: string;
  readonly episodeNumber?: number;
  readonly truthAuthority?: TruthAuthority;
  readonly normalizedFileName?: string;
  readonly affectedScope: "episode" | "downstream" | "future" | "book";
  readonly requiresTruthRebuild: boolean;
}

export interface EditExecutionDeps {
  readonly bookDir: (bookId: string) => string;
  readonly loadEpisodeIndex: (bookId: string) => Promise<ReadonlyArray<EpisodeMeta>>;
  readonly saveEpisodeIndex: (bookId: string, index: ReadonlyArray<EpisodeMeta>) => Promise<void>;
}

export interface ExecutedEditTransaction {
  readonly transactionType: EditRequest["kind"];
  readonly bookId: string;
  readonly episodeNumber?: number;
  readonly touchedFiles: ReadonlyArray<string>;
  readonly reviewRequired: boolean;
  readonly summary: string;
}

export const MANUAL_EPISODE_EDIT_ISSUE = "Manual episode edit requires review before continuation.";

function isMissingDirectoryError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

export function planEditTransaction(request: EditRequest): PlannedEditTransaction {
  switch (request.kind) {
    case "entity-rename":
      return {
        transactionType: request.kind,
        bookId: request.bookId,
        affectedScope: "book",
        requiresTruthRebuild: true,
      };
    case "episode-rewrite":
      return {
        transactionType: request.kind,
        bookId: request.bookId,
        episodeNumber: request.episodeNumber,
        affectedScope: "downstream",
        requiresTruthRebuild: true,
      };
    case "episode-replace":
      return {
        transactionType: request.kind,
        bookId: request.bookId,
        episodeNumber: request.episodeNumber,
        affectedScope: "episode",
        requiresTruthRebuild: true,
      };
    case "episode-local-edit":
      return {
        transactionType: request.kind,
        bookId: request.bookId,
        episodeNumber: request.episodeNumber,
        affectedScope: "episode",
        requiresTruthRebuild: true,
      };
    case "focus-edit":
      return {
        transactionType: request.kind,
        bookId: request.bookId,
        truthAuthority: "direction",
        normalizedFileName: "current_focus.md",
        affectedScope: "future",
        requiresTruthRebuild: false,
      };
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectEditableFiles(dir: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "snapshots" || entry.name === "runtime") return [];
      return collectEditableFiles(fullPath);
    }
    if (!/\.(md|json)$/i.test(entry.name)) {
      return [];
    }
    if (entry.name === "index.json" || /_review\.json$/i.test(entry.name)) {
      return [];
    }
    return [fullPath];
  }));
  return files.flat();
}

interface PlannedFileRename {
  readonly fromAbs: string;
  readonly toAbs: string;
  readonly from: string;
  readonly to: string;
}

// newValue is LLM-supplied (system boundary). A name embedded into a filename must stay a single
// path component — reject path separators so a rename target can never escape its directory.
function assertEntityRenameTargetIsSafe(newValue: string): void {
  if (!newValue.trim() || /[/\\\0]/.test(newValue)) {
    throw new Error(`Invalid rename target "${newValue}": entity names cannot contain path separators.`);
  }
}

interface FileBackup {
  readonly path: string;
  readonly content: string;
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

async function restoreBackups(backups: ReadonlyArray<FileBackup>): Promise<void> {
  for (const backup of backups) {
    await atomicWriteFile(backup.path, backup.content, "utf-8");
  }
}

async function attemptRollback(
  originalError: unknown,
  actions: ReadonlyArray<() => Promise<void>>,
): Promise<never> {
  const rollbackErrors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      `Edit transaction failed and rollback encountered ${rollbackErrors.length} additional error(s).`,
      { cause: originalError },
    );
  }
  throw originalError;
}

async function episodeDerivedBackups(root: string, episodeNumber: number): Promise<ReadonlyArray<FileBackup>> {
  const padded = String(episodeNumber).padStart(4, "0");
  const runtimeDir = join(root, "story", "runtime");
  const runtimeFiles = (await readdir(runtimeDir).catch((error) => {
    if (isMissingDirectoryError(error)) return [];
    throw error;
  }))
    .filter((file) => file.startsWith(`episode-${padded}.`))
    .map((file) => join(runtimeDir, file));
  const reviewPath = join(root, "episodes", `${padded}_review.json`);
  const paths = await fileExists(reviewPath) ? [...runtimeFiles, reviewPath] : runtimeFiles;
  return Promise.all(paths.map(async (path) => ({ path, content: await readFile(path, "utf-8") })));
}

async function invalidateBackups(backups: ReadonlyArray<FileBackup>): Promise<void> {
  for (const backup of backups) {
    await unlink(backup.path).catch((error) => {
      if (!isMissingDirectoryError(error)) throw error;
    });
  }
}

// Entity files are addressed by path elsewhere (e.g. roles/主要角色/<name>.md). When the content pass
// rewrites those path references from oldValue to newValue, the files themselves must be renamed too,
// or the references dangle. Plan the disk renames up front (before any write) so a name collision
// aborts the whole transaction cleanly instead of leaving content half-rewritten.
async function planEntityFileRenames(
  root: string,
  files: ReadonlyArray<string>,
  oldValue: string,
  newValue: string,
): Promise<ReadonlyArray<PlannedFileRename>> {
  const planned: PlannedFileRename[] = [];
  for (const filePath of files) {
    const base = basename(filePath);
    if (!base.includes(oldValue)) {
      continue;
    }
    const nextBase = base.split(oldValue).join(newValue);
    if (nextBase === base) {
      continue;
    }
    const toAbs = join(dirname(filePath), nextBase);
    const targetExists = await access(toAbs).then(() => true).catch(() => false);
    if (targetExists) {
      throw new Error(
        `Cannot rename "${relative(root, filePath)}" to "${nextBase}": a file with that name already exists.`,
      );
    }
    planned.push({ fromAbs: filePath, toAbs, from: relative(root, filePath), to: relative(root, toAbs) });
  }
  return planned;
}

async function executeEntityRename(
  deps: EditExecutionDeps,
  request: Extract<EditRequest, { kind: "entity-rename" }>,
): Promise<ExecutedEditTransaction> {
  const root = deps.bookDir(request.bookId);
  assertEntityRenameTargetIsSafe(request.newValue);
  if (!request.oldValue || request.oldValue === request.newValue) {
    throw new Error("Entity rename requires distinct non-empty old and new values.");
  }
  const files = await collectEditableFiles(root);
  const plannedRenames = await planEntityFileRenames(root, files, request.oldValue, request.newValue);
  const matcher = new RegExp(escapeRegExp(request.oldValue), "g");
  const touched = new Set<string>();
  const rewrites: Array<FileBackup & { readonly nextContent: string }> = [];
  for (const filePath of files) {
    const content = await readFile(filePath, "utf-8");
    const nextContent = content.replace(matcher, request.newValue);
    if (nextContent === content) continue;
    rewrites.push({ path: filePath, content, nextContent });
    touched.add(relative(root, filePath));
  }
  if (rewrites.length === 0 && plannedRenames.length === 0) {
    throw new Error(`No occurrences of "${request.oldValue}" were found in "${request.bookId}".`);
  }

  const touchedEpisodes = new Set<number>();
  for (const rewrite of rewrites) {
    const match = relative(root, rewrite.path).replaceAll("\\", "/").match(/^episodes\/(\d{4})_/u);
    if (match?.[1]) touchedEpisodes.add(Number(match[1]));
  }
  const originalIndex = await deps.loadEpisodeIndex(request.bookId);
  const derivedBackups = (await Promise.all(
    [...touchedEpisodes].map((episode) => episodeDerivedBackups(root, episode)),
  )).flat();
  const completedRenames: PlannedFileRename[] = [];

  try {
    for (const rewrite of rewrites) {
      await atomicWriteFile(rewrite.path, rewrite.nextContent, "utf-8");
    }
    for (const planned of plannedRenames) {
      await rename(planned.fromAbs, planned.toAbs);
      completedRenames.push(planned);
      touched.delete(planned.from);
      touched.add(planned.to);
    }

    let updatedIndex: ReadonlyArray<EpisodeMeta> = originalIndex.map((episode) => ({
      ...episode,
      title: episode.title.replace(matcher, request.newValue),
    }));
    for (const episodeNumber of touchedEpisodes) {
      const { markdownPath } = await findEpisodeMarkdownPath(root, episodeNumber);
      const content = await readFile(markdownPath, "utf-8");
      const episodeMeta = updatedIndex.find((episode) => episode.episodeNumber === episodeNumber);
      updatedIndex = markEpisodeForManualReview(
        updatedIndex,
        episodeNumber,
        `Entity rename ${request.oldValue} -> ${request.newValue} requires review.`,
        content,
        episodeMeta?.episodeDurationSeconds,
      );
    }
    await deps.saveEpisodeIndex(request.bookId, updatedIndex);
    await invalidateBackups(derivedBackups);
  } catch (error) {
    await attemptRollback(error, [
      async () => {
        for (const planned of completedRenames.reverse()) {
          if (await fileExists(planned.toAbs)) await rename(planned.toAbs, planned.fromAbs);
        }
      },
      () => restoreBackups(rewrites),
      () => restoreBackups(derivedBackups),
      () => deps.saveEpisodeIndex(request.bookId, originalIndex),
    ]);
  }

  for (const backup of derivedBackups) touched.add(relative(root, backup.path));
  if (touchedEpisodes.size > 0) touched.add("episodes/index.json");

  const touchedFiles = [...touched];
  const renameNote = plannedRenames.length > 0
    ? ` (${plannedRenames.length} file${plannedRenames.length === 1 ? "" : "s"} renamed on disk)`
    : "";
  return {
    transactionType: request.kind,
    bookId: request.bookId,
    touchedFiles,
    reviewRequired: true,
    summary: `Renamed ${request.oldValue} to ${request.newValue} across ${touchedFiles.length} files${renameNote}; affected episodes require review.`,
  };
}

async function findEpisodeMarkdownPath(root: string, episodeNumber: number): Promise<{
  readonly episodesDir: string;
  readonly markdownPath: string;
  readonly markdownFile: string;
}> {
  const episodesDir = join(root, "episodes");
  const paddedEpisode = String(episodeNumber).padStart(4, "0");
  const files = await readdir(episodesDir).catch((error) => {
    if (isMissingDirectoryError(error)) return [];
    throw error;
  });
  const markdownFile = files.find((file) => file.startsWith(`${paddedEpisode}_`) && file.endsWith(".md"));
  if (!markdownFile) throw new Error(`Episode ${episodeNumber} not found.`);
  return { episodesDir, markdownPath: join(episodesDir, markdownFile), markdownFile };
}

async function findEpisodePaths(root: string, episodeNumber: number): Promise<{
  readonly episodesDir: string;
  readonly markdownPath: string;
  readonly markdownFile: string;
  readonly jsonPath: string;
  readonly jsonFile: string;
}> {
  const { episodesDir, markdownPath, markdownFile } = await findEpisodeMarkdownPath(root, episodeNumber);
  const paddedEpisode = String(episodeNumber).padStart(4, "0");
  const files = await readdir(episodesDir).catch((error) => {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  });
  const jsonFile = files.find((file) =>
    file.startsWith(`${paddedEpisode}_`)
    && file.endsWith(".json")
    && !file.endsWith("_review.json"),
  );

  if (!jsonFile) {
    throw new Error(`EPISODE_JSON_AUTHORITY: episode ${episodeNumber} has no authoritative screenplay JSON.`);
  }
  return {
    episodesDir,
    markdownPath,
    markdownFile,
    jsonPath: join(episodesDir, jsonFile),
    jsonFile,
  };
}

function markEpisodeForManualReview(
  index: ReadonlyArray<EpisodeMeta>,
  episodeNumber: number,
  issue: string,
  content: string,
  episodeDurationSeconds?: number,
): ReadonlyArray<EpisodeMeta> {
  const now = new Date().toISOString();
  const recoveryIssue = {
    severity: "critical" as const,
    category: "manual-episode-edit",
    description: issue,
    suggestion: "Re-audit the edited episode before accepting it.",
    repairScope: "unknown" as const,
  };
  return index.map((episode) => episode.episodeNumber === episodeNumber
    ? {
        ...episode,
        status: "audit-failed" as const,
        updatedAt: now,
        ...(typeof episodeDurationSeconds === "number" ? { episodeDurationSeconds } : {}),
        auditIssues: [
          ...episode.auditIssues.filter((existing) => !existing.includes(issue)),
          `[critical] ${issue}`,
        ],
        reviewNote: undefined,
        recoveryState: buildEpisodeRecoveryState({
          content,
          issues: [recoveryIssue],
          terminationReason: "manual-episode-edit",
          now: () => now,
        }),
      }
    : episode);
}

function canonicalizeEpisodeScript(content: string, episodeNumber: number): {
  readonly markdown: string;
  readonly json: string;
  readonly durationSeconds: number;
} {
  try {
    const script = parseEpisodeScriptOutput(content, episodeNumber);
    return {
      markdown: renderEpisodeScriptMarkdown(script),
      json: `${JSON.stringify(script, null, 2)}\n`,
      durationSeconds: script.estimatedDurationSeconds,
    };
  } catch (error) {
    throw new Error(
      `INVALID_EPISODE_SCRIPT: episode ${episodeNumber} must remain a valid EpisodeScript JSON/Markdown artifact (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

async function executeEpisodeReplace(
  deps: EditExecutionDeps,
  request: Extract<EditRequest, { kind: "episode-replace" }>,
): Promise<ExecutedEditTransaction> {
  const root = deps.bookDir(request.bookId);
  const fullText = request.fullText.trim();
  if (!fullText) {
    throw new Error("Episode replacement requires fullText.");
  }
  const { markdownPath, jsonPath } = await findEpisodePaths(root, request.episodeNumber);
  const canonical = canonicalizeEpisodeScript(fullText, request.episodeNumber);
  const [originalMarkdown, originalJson] = await Promise.all([
    readFile(markdownPath, "utf-8"),
    readFile(jsonPath, "utf-8"),
  ]);
  const originalIndex = await deps.loadEpisodeIndex(request.bookId);
  const derivedBackups = await episodeDerivedBackups(root, request.episodeNumber);
  const updatedIndex = markEpisodeForManualReview(
    originalIndex,
    request.episodeNumber,
    MANUAL_EPISODE_EDIT_ISSUE,
    canonical.markdown,
    canonical.durationSeconds,
  );
  try {
    await atomicWriteFile(jsonPath, canonical.json, "utf-8");
    await atomicWriteFile(markdownPath, canonical.markdown, "utf-8");
    await deps.saveEpisodeIndex(request.bookId, updatedIndex);
    await invalidateBackups(derivedBackups);
  } catch (error) {
    await attemptRollback(error, [
      () => atomicWriteFile(jsonPath, originalJson, "utf-8"),
      () => atomicWriteFile(markdownPath, originalMarkdown, "utf-8"),
      () => restoreBackups(derivedBackups),
      () => deps.saveEpisodeIndex(request.bookId, originalIndex),
    ]);
  }

  return {
    transactionType: request.kind,
    bookId: request.bookId,
    episodeNumber: request.episodeNumber,
    touchedFiles: [
      relative(root, jsonPath),
      relative(root, markdownPath),
      ...derivedBackups.map((backup) => relative(root, backup.path)),
      "episodes/index.json",
    ],
    reviewRequired: true,
    summary: `Replaced episode ${request.episodeNumber} and marked it for review.`,
  };
}

async function executeEpisodeLocalEdit(
  deps: EditExecutionDeps,
  request: Extract<EditRequest, { kind: "episode-local-edit" }>,
): Promise<ExecutedEditTransaction> {
  const root = deps.bookDir(request.bookId);
  const { markdownPath, jsonPath } = await findEpisodePaths(root, request.episodeNumber);
  if (!request.targetText || request.replacementText === undefined) {
    throw new Error("Episode-local edits require targetText and replacementText.");
  }

  const [content, originalJson] = await Promise.all([
    readFile(markdownPath, "utf-8"),
    readFile(jsonPath, "utf-8"),
  ]);
  const nextContent = replaceEpisodeTargetText(content, request.targetText, request.replacementText);
  if (nextContent === content) {
    throw new Error(`Target text was not found in episode ${request.episodeNumber}.`);
  }
  const before = canonicalizeEpisodeScript(content, request.episodeNumber);
  const canonical = canonicalizeEpisodeScript(nextContent, request.episodeNumber);
  if (canonical.markdown === before.markdown) {
    throw new Error(
      "EPISODE_JSON_AUTHORITY: the edit changed only the Markdown projection. Edit the embedded EpisodeScript JSON or replace the full EpisodeScript artifact.",
    );
  }
  const originalIndex = await deps.loadEpisodeIndex(request.bookId);
  const derivedBackups = await episodeDerivedBackups(root, request.episodeNumber);
  const updatedIndex = markEpisodeForManualReview(
    originalIndex,
    request.episodeNumber,
    MANUAL_EPISODE_EDIT_ISSUE,
    canonical.markdown,
    canonical.durationSeconds,
  );
  try {
    await atomicWriteFile(jsonPath, canonical.json, "utf-8");
    await atomicWriteFile(markdownPath, canonical.markdown, "utf-8");
    await deps.saveEpisodeIndex(request.bookId, updatedIndex);
    await invalidateBackups(derivedBackups);
  } catch (error) {
    await attemptRollback(error, [
      () => atomicWriteFile(jsonPath, originalJson, "utf-8"),
      () => atomicWriteFile(markdownPath, content, "utf-8"),
      () => restoreBackups(derivedBackups),
      () => deps.saveEpisodeIndex(request.bookId, originalIndex),
    ]);
  }

  return {
    transactionType: request.kind,
    bookId: request.bookId,
    episodeNumber: request.episodeNumber,
    touchedFiles: [
      relative(root, jsonPath),
      relative(root, markdownPath),
      ...derivedBackups.map((backup) => relative(root, backup.path)),
      "episodes/index.json",
    ],
    reviewRequired: true,
    summary: `Patched episode ${request.episodeNumber} and marked it for review.`,
  };
}

function replaceEpisodeTargetText(content: string, targetText: string, replacementText: string): string {
  const firstExact = content.indexOf(targetText);
  if (firstExact >= 0) {
    if (content.indexOf(targetText, firstExact + targetText.length) >= 0) {
      throw new Error("Episode-local edit target appears more than once; provide a unique target.");
    }
    return `${content.slice(0, firstExact)}${replacementText}${content.slice(firstExact + targetText.length)}`;
  }

  const pattern = flexibleWhitespacePattern(targetText);
  if (pattern) {
    const matches = [...content.matchAll(pattern)];
    if (matches.length > 1) {
      throw new Error("Episode-local edit target appears more than once after whitespace normalization; provide a unique target.");
    }
    if (matches[0]?.index !== undefined) {
      const match = matches[0][0];
      return `${content.slice(0, matches[0].index)}${replacementText}${content.slice(matches[0].index + match.length)}`;
    }
  }

  return replaceApproximateParagraph(content, targetText, replacementText);
}

function flexibleWhitespacePattern(targetText: string): RegExp | null {
  const parts = targetText.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("\\s+"), "g");
}

function replaceApproximateParagraph(content: string, targetText: string, replacementText: string): string {
  const target = normalizeApproximateText(targetText);
  if (target.length < 24) return content;

  let best: { readonly start: number; readonly end: number; readonly score: number } | undefined;
  let secondBestScore = 0;
  const paragraphPattern = /\S[\s\S]*?(?=\n\s*\n|$)/g;
  for (const match of content.matchAll(paragraphPattern)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const normalized = normalizeApproximateText(raw);
    if (normalized.length < 24) continue;
    if (normalized.length < target.length * 0.35 || normalized.length > target.length * 3) continue;
    const score = approximateTextScore(target, normalized);
    if (!best || score > best.score) {
      secondBestScore = best?.score ?? secondBestScore;
      best = { start, end: start + raw.length, score };
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  // High threshold + margin keeps this as a target locator, not a semantic rewrite engine.
  if (!best || best.score < 0.72 || (best.score < 0.86 && best.score - secondBestScore < 0.06)) {
    return content;
  }

  return `${content.slice(0, best.start)}${replacementText}${content.slice(best.end)}`;
}

function normalizeApproximateText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function approximateTextScore(target: string, candidate: string): number {
  if (candidate.includes(target) || target.includes(candidate)) {
    return Math.min(target.length, candidate.length) / Math.max(target.length, candidate.length);
  }
  return diceCoefficient(toBigrams(target), toBigrams(candidate));
}

function toBigrams(text: string): string[] {
  if (text.length < 2) return text ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    out.push(text.slice(i, i + 2));
  }
  return out;
}

function diceCoefficient(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of left) counts.set(item, (counts.get(item) ?? 0) + 1);
  let overlap = 0;
  for (const item of right) {
    const count = counts.get(item) ?? 0;
    if (count <= 0) continue;
    overlap += 1;
    counts.set(item, count - 1);
  }
  return (2 * overlap) / (left.length + right.length);
}

export async function executeEditTransaction(
  deps: EditExecutionDeps,
  request: EditRequest,
): Promise<ExecutedEditTransaction> {
  switch (request.kind) {
    case "entity-rename":
      return executeEntityRename(deps, request);
    case "episode-replace":
      return executeEpisodeReplace(deps, request);
    case "episode-local-edit":
      return executeEpisodeLocalEdit(deps, request);
    default:
      throw new Error(`Edit transaction "${request.kind}" is not executable yet.`);
  }
}
