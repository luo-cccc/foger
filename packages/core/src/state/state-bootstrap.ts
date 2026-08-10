import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EpisodeSummariesStateSchema,
  CurrentStateStateSchema,
  HooksStateSchema,
  StateManifestSchema,
  type EpisodeSummariesState,
  type CurrentStateState,
  type HooksState,
  type HookStatus,
  type StateManifest,
} from "../models/runtime-state.js";
import type { Fact, StoredHook } from "./memory-db.js";
import { normalizeHookPayoffTiming } from "../utils/hook-lifecycle.js";
import {
  normalizeHookStatusAlias,
  normalizeHookTypeLabel,
} from "../utils/hook-governance.js";
import {
  inferFactSubject,
  isCurrentEpisodeLabel,
  isStateTableHeaderRow,
  normalizeHookId,
  parseEpisodeSummariesMarkdown,
  parseInteger,
  parseMarkdownTableRows,
  parsePendingHooksMarkdown,
} from "../utils/story-markdown.js";

export {
  normalizeHookId,
  parseEpisodeSummariesMarkdown,
  parseCurrentStateFacts,
  parsePendingHooksMarkdown,
} from "../utils/story-markdown.js";

export interface BootstrapStructuredStateResult {
  readonly createdFiles: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly manifest: StateManifest;
}

interface MarkdownBootstrapState {
  readonly summariesState: EpisodeSummariesState;
  readonly hooksState: { readonly hooks: ReadonlyArray<StoredHook> };
  readonly currentState: CurrentStateState;
  readonly durableStoryProgress: number;
}

export async function bootstrapStructuredStateFromMarkdown(params: {
  readonly bookDir: string;
  readonly fallbackEpisode?: number;
}): Promise<BootstrapStructuredStateResult> {
  const storyDir = join(params.bookDir, "story");
  const stateDir = join(storyDir, "state");
  const manifestPath = join(stateDir, "manifest.json");
  const currentStatePath = join(stateDir, "current_state.json");
  const hooksPath = join(stateDir, "hooks.json");
  const summariesPath = join(stateDir, "episode_summaries.json");

  await mkdir(stateDir, { recursive: true });

  const createdFiles: string[] = [];
  const warnings: string[] = [];
  const existingManifest = await loadJsonIfValid(manifestPath, StateManifestSchema, warnings, "manifest.json");
  const language = existingManifest?.language ?? await resolveRuntimeLanguage(params.bookDir);
  const markdownState = await loadMarkdownBootstrapState({
    bookDir: params.bookDir,
    storyDir,
    fallbackEpisode: params.fallbackEpisode ?? 0,
    warnings,
  });

  const summariesState = await loadOrBootstrapSummaries({
    storyDir,
    statePath: summariesPath,
    createdFiles,
    warnings,
    bootstrapState: markdownState.summariesState,
  });
  const hooksState = await loadOrBootstrapHooks({
    storyDir,
    statePath: hooksPath,
    createdFiles,
    warnings,
    bootstrapState: markdownState.hooksState,
  });
  const currentState = await loadOrBootstrapCurrentState({
    storyDir,
    statePath: currentStatePath,
    fallbackEpisode: markdownState.durableStoryProgress,
    createdFiles,
    warnings,
    bootstrapState: markdownState.currentState,
  });
  // Only trust durable artifact progress (episode files + index).
  // currentState.episode comes from markdown which can contain
  // hallucinated numbers (e.g. year 1988 parsed as episode 1988).
  const derivedProgress = markdownState.durableStoryProgress;
  if ((existingManifest?.lastAppliedEpisode ?? 0) > derivedProgress) {
    appendWarning(
      warnings,
      `manifest lastAppliedEpisode normalized from ${existingManifest?.lastAppliedEpisode ?? 0} to ${derivedProgress}`,
    );
  }

  const manifest = StateManifestSchema.parse({
    schemaVersion: 2,
    language,
    lastAppliedEpisode: derivedProgress,
    projectionVersion: existingManifest?.projectionVersion ?? 1,
    migrationWarnings: uniqueStrings([
      ...(existingManifest?.migrationWarnings ?? []),
      ...warnings,
    ]),
  });

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  if (!existingManifest) {
    createdFiles.push("manifest.json");
  }

  return {
    createdFiles,
    warnings: manifest.migrationWarnings,
    manifest,
  };
}

export async function rewriteStructuredStateFromMarkdown(params: {
  readonly bookDir: string;
  readonly fallbackEpisode?: number;
  readonly authoritativeEpisode?: number;
}): Promise<BootstrapStructuredStateResult> {
  const storyDir = join(params.bookDir, "story");
  const stateDir = join(storyDir, "state");
  const manifestPath = join(stateDir, "manifest.json");
  const currentStatePath = join(stateDir, "current_state.json");
  const hooksPath = join(stateDir, "hooks.json");
  const summariesPath = join(stateDir, "episode_summaries.json");

  await mkdir(stateDir, { recursive: true });

  const warnings: string[] = [];
  const existingManifest = await loadJsonIfValid(manifestPath, StateManifestSchema, warnings, "manifest.json");
  const language = existingManifest?.language ?? await resolveRuntimeLanguage(params.bookDir);
  const markdownState = await loadMarkdownBootstrapState({
    bookDir: params.bookDir,
    storyDir,
    fallbackEpisode: params.fallbackEpisode ?? 0,
    authoritativeEpisode: params.authoritativeEpisode,
    warnings,
  });
  const summariesState = markdownState.summariesState;
  const hooksState = markdownState.hooksState;
  const currentState = markdownState.currentState;

  const manifest = StateManifestSchema.parse({
    schemaVersion: 2,
    language,
    lastAppliedEpisode: markdownState.durableStoryProgress,
    projectionVersion: existingManifest?.projectionVersion ?? 1,
    migrationWarnings: uniqueStrings([
      ...(existingManifest?.migrationWarnings ?? []),
      ...warnings,
    ]),
  });

  await Promise.all([
    writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8"),
    writeFile(currentStatePath, JSON.stringify(currentState, null, 2), "utf-8"),
    writeFile(hooksPath, JSON.stringify(hooksState, null, 2), "utf-8"),
    writeFile(summariesPath, JSON.stringify(summariesState, null, 2), "utf-8"),
  ]);

  return {
    createdFiles: [],
    warnings: manifest.migrationWarnings,
    manifest,
  };
}

async function loadOrBootstrapCurrentState(params: {
  readonly storyDir: string;
  readonly statePath: string;
  readonly fallbackEpisode: number;
  readonly createdFiles: string[];
  readonly warnings: string[];
  readonly bootstrapState?: CurrentStateState;
  readonly forceBootstrapFromMarkdown?: boolean;
}): Promise<CurrentStateState> {
  if (!params.forceBootstrapFromMarkdown) {
    const existing = await loadJsonIfValid(
      params.statePath,
      CurrentStateStateSchema,
      params.warnings,
      "current_state.json",
    );
    if (existing) {
      return existing;
    }
  }

  const currentState = params.bootstrapState ?? await loadMarkdownCurrentState({
    storyDir: params.storyDir,
    fallbackEpisode: params.fallbackEpisode,
    warnings: params.warnings,
  });
  const existed = await pathExists(params.statePath);
  await writeFile(params.statePath, JSON.stringify(currentState, null, 2), "utf-8");
  if (!existed) {
    params.createdFiles.push("current_state.json");
  }
  return currentState;
}

async function loadOrBootstrapHooks(params: {
  readonly storyDir: string;
  readonly statePath: string;
  readonly createdFiles: string[];
  readonly warnings: string[];
  readonly bootstrapState?: { readonly hooks: ReadonlyArray<StoredHook> };
  readonly forceBootstrapFromMarkdown?: boolean;
}) {
  if (!params.forceBootstrapFromMarkdown) {
    const existing = await loadHooksStateIfValid(
      params.statePath,
      params.warnings,
      "hooks.json",
    );
    if (existing) {
      if (existing.repaired) {
        await writeFile(params.statePath, JSON.stringify(existing.state, null, 2), "utf-8");
      }
      return existing.state;
    }
  }

  const hooksState = params.bootstrapState ?? await loadMarkdownHooksState({
    storyDir: params.storyDir,
    warnings: params.warnings,
  });
  const existed = await pathExists(params.statePath);
  await writeFile(params.statePath, JSON.stringify(hooksState, null, 2), "utf-8");
  if (!existed) {
    params.createdFiles.push("hooks.json");
  }
  return hooksState;
}

async function loadOrBootstrapSummaries(params: {
  readonly storyDir: string;
  readonly statePath: string;
  readonly createdFiles: string[];
  readonly warnings: string[];
  readonly bootstrapState?: EpisodeSummariesState;
  readonly forceBootstrapFromMarkdown?: boolean;
}): Promise<EpisodeSummariesState> {
  if (!params.forceBootstrapFromMarkdown) {
    const existing = await loadJsonIfValid(
      params.statePath,
      EpisodeSummariesStateSchema,
      params.warnings,
      "episode_summaries.json",
    );
    if (existing) {
      // Always deduplicate even when loading from JSON (stale data may have duplicates)
      const dedupedExisting = deduplicateSummaryRows(existing.rows);
      if (dedupedExisting.length < existing.rows.length) {
        const repaired = EpisodeSummariesStateSchema.parse({ rows: dedupedExisting });
        await writeFile(params.statePath, JSON.stringify(repaired, null, 2), "utf-8");
        return repaired;
      }
      return existing;
    }
  }

  const summariesState = params.bootstrapState ?? await loadMarkdownSummariesState(params.storyDir);
  const existed = await pathExists(params.statePath);
  await writeFile(params.statePath, JSON.stringify(summariesState, null, 2), "utf-8");
  if (!existed) {
    params.createdFiles.push("episode_summaries.json");
  }
  return summariesState;
}

function parsePendingHooksStateMarkdown(markdown: string, warnings: string[]) {
  const parsedHooks = parsePendingHooksMarkdown(markdown);
  if (parsedHooks.length > 0) {
    return HooksStateSchema.parse({
      hooks: deduplicateHooksById(
        parsedHooks.map((hook) => ({
          ...hook,
          type: normalizeHookType(hook.type, warnings, hook.hookId),
          status: normalizeHookStatus(hook.status, warnings, hook.hookId),
        })),
        warnings,
      ),
    });
  }

  return HooksStateSchema.parse({
    hooks: markdown
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => line.replace(/^-\s*/, ""))
      .filter(Boolean)
      .map((line, index) => ({
        hookId: `hook-${index + 1}`,
        startEpisode: 0,
        type: "unspecified",
        status: "open" as HookStatus,
        lastAdvancedEpisode: 0,
        expectedPayoff: "",
        payoffTiming: undefined,
        notes: line,
      })),
  });
}

function parseCurrentStateStateMarkdown(
  markdown: string,
  fallbackEpisode: number,
  warnings: string[],
): CurrentStateState {
  const tableRows = parseMarkdownTableRows(markdown);
  const fieldValueRows = tableRows
    .filter((row) => row.length >= 2)
    .filter((row) => !isStateTableHeaderRow(row));

  if (fieldValueRows.length > 0) {
    const episodeFromTable = fieldValueRows.find((row) => isCurrentEpisodeLabel(row[0] ?? ""));
    const stateEpisode = parseIntegerWithFallback(
      episodeFromTable?.[1],
      fallbackEpisode,
      warnings,
      "current_state:episode",
    );

    return CurrentStateStateSchema.parse({
      episode: stateEpisode,
      facts: fieldValueRows
        .filter((row) => !isCurrentEpisodeLabel(row[0] ?? ""))
        .flatMap((row): Fact[] => {
          const label = (row[0] ?? "").trim();
          const value = (row[1] ?? "").trim();
          if (!label || !value) return [];

          return [{
            subject: inferFactSubject(label),
            predicate: label,
            object: value,
            validFromEpisode: stateEpisode,
            validUntilEpisode: null,
            sourceEpisode: stateEpisode,
          }];
        }),
    });
  }

  const bulletFacts = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, ""))
    .filter(Boolean);

  return CurrentStateStateSchema.parse({
    episode: Math.max(0, fallbackEpisode),
    facts: bulletFacts.map((line, index) => ({
      subject: "current_state",
      predicate: `note_${index + 1}`,
      object: line,
      validFromEpisode: Math.max(0, fallbackEpisode),
      validUntilEpisode: null,
      sourceEpisode: Math.max(0, fallbackEpisode),
    })),
  });
}

async function resolveRuntimeLanguage(bookDir: string): Promise<"zh" | "en"> {
  try {
    const raw = await readFile(join(bookDir, "book.json"), "utf-8");
    const parsed = JSON.parse(raw) as { language?: unknown };
    return parsed.language === "zh" ? "zh" : "en";
  } catch {
    return "en";
  }
}

export async function resolveDurableStoryProgress(params: {
  readonly bookDir: string;
  readonly fallbackEpisode?: number;
}): Promise<number> {
  const explicitFallback = normalizeExplicitEpisode(params.fallbackEpisode);
  const durableArtifactProgress = await resolveContiguousArtifactEpisodeProgress(params.bookDir);
  return Math.max(durableArtifactProgress, explicitFallback);
}

async function loadJsonIfValid<T>(
  path: string,
  schema: { parse(value: unknown): T },
  warnings: string[],
  fileLabel: string,
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    const message = String(error);
    if (!/ENOENT/.test(message)) {
      appendWarning(warnings, `${fileLabel} invalid, rebuilt from markdown`);
    }
    return null;
  }
}

async function loadHooksStateIfValid(
  path: string,
  warnings: string[],
  fileLabel: string,
): Promise<{ readonly state: HooksState; readonly repaired: boolean } | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const repaired = repairHooksStateInput(JSON.parse(raw), warnings);
    const parsed = HooksStateSchema.parse(repaired.value);
    const hooks = deduplicateHooksById(parsed.hooks, warnings);
    return {
      state: hooks.length === parsed.hooks.length
        ? parsed
        : HooksStateSchema.parse({ hooks }),
      repaired: repaired.changed || hooks.length !== parsed.hooks.length,
    };
  } catch (error) {
    const message = String(error);
    if (!/ENOENT/.test(message)) {
      appendWarning(warnings, `${fileLabel} invalid, rebuilt from markdown`);
    }
    return null;
  }
}

function repairHooksStateInput(value: unknown, warnings: string[]): { readonly value: unknown; readonly changed: boolean } {
  if (!isRecord(value) || !Array.isArray(value.hooks)) {
    return { value, changed: false };
  }

  let changed = false;
  const hooks = value.hooks.map((hook, index) => {
    if (!isRecord(hook)) return hook;
    const rawHookId = typeof hook.hookId === "string" && hook.hookId.trim()
      ? hook.hookId.trim()
      : `hooks[${index}]`;
    const normalizedHookId = normalizeHookId(rawHookId) || rawHookId;
    let repairedHook = hook;
    if (normalizedHookId !== rawHookId) {
      changed = true;
      appendWarning(warnings, `${rawHookId}: hook id normalized to "${normalizedHookId}"`);
      repairedHook = { ...repairedHook, hookId: normalizedHookId };
    }

    if (typeof hook.type === "string" && hook.type.trim().length > 0) {
      if (hook.type !== hook.type.trim()) {
        changed = true;
        repairedHook = { ...repairedHook, type: hook.type.trim() };
      }
      return repairedHook;
    }

    changed = true;
    appendWarning(warnings, `${normalizedHookId}: empty hook type normalized to "unspecified"`);
    return {
      ...repairedHook,
      type: "unspecified",
    };
  });

  return {
    value: changed ? { ...value, hooks } : value,
    changed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadMarkdownBootstrapState(params: {
  readonly bookDir: string;
  readonly storyDir: string;
  readonly fallbackEpisode: number;
  readonly authoritativeEpisode?: number;
  readonly warnings: string[];
}): Promise<MarkdownBootstrapState> {
  const summariesState = await loadMarkdownSummariesState(params.storyDir);
  const hooksState = await loadMarkdownHooksState({
    storyDir: params.storyDir,
    warnings: params.warnings,
  });
  const explicitFallback = normalizeExplicitEpisode(params.fallbackEpisode);
  const durableArtifactProgress = await resolveContiguousArtifactEpisodeProgress(params.bookDir);
  const authoritativeProgress = params.authoritativeEpisode === undefined
    ? Math.max(explicitFallback, durableArtifactProgress)
    : normalizeExplicitEpisode(params.authoritativeEpisode);
  const parsedCurrentState = await loadMarkdownCurrentState({
    storyDir: params.storyDir,
    fallbackEpisode: authoritativeProgress,
    warnings: params.warnings,
  });
  const currentState = params.authoritativeEpisode === undefined
    ? parsedCurrentState
    : normalizeCurrentStateEpisode(parsedCurrentState, authoritativeProgress, params.warnings);

  return {
    summariesState,
    hooksState,
    currentState,
    durableStoryProgress: authoritativeProgress,
  };
}

function normalizeCurrentStateEpisode(
  currentState: CurrentStateState,
  authoritativeEpisode: number,
  warnings: string[],
): CurrentStateState {
  if (currentState.episode === authoritativeEpisode) return currentState;
  appendWarning(
    warnings,
    `current_state episode normalized from ${currentState.episode} to ${authoritativeEpisode}`,
  );
  return CurrentStateStateSchema.parse({
    ...currentState,
    episode: authoritativeEpisode,
    facts: currentState.facts.map((fact) => ({
      ...fact,
      validFromEpisode: authoritativeEpisode,
      sourceEpisode: authoritativeEpisode,
    })),
  });
}

async function loadMarkdownSummariesState(storyDir: string): Promise<EpisodeSummariesState> {
  const markdown = await readFile(join(storyDir, "episode_summaries.md"), "utf-8").catch(() => "");
  const rawRows = parseEpisodeSummariesMarkdown(markdown);
  return EpisodeSummariesStateSchema.parse({
    rows: deduplicateSummaryRows(rawRows.map((row) => ({
      ...row,
      episodeNumber: row.episode,
    }))),
  });
}

async function loadMarkdownHooksState(params: {
  readonly storyDir: string;
  readonly warnings: string[];
}) {
  const markdown = await readFile(join(params.storyDir, "pending_hooks.md"), "utf-8").catch(() => "");
  return parsePendingHooksStateMarkdown(markdown, params.warnings);
}

async function loadMarkdownCurrentState(params: {
  readonly storyDir: string;
  readonly fallbackEpisode: number;
  readonly warnings: string[];
}): Promise<CurrentStateState> {
  const markdown = await readFile(join(params.storyDir, "current_state.md"), "utf-8").catch(() => "");
  return parseCurrentStateStateMarkdown(markdown, params.fallbackEpisode, params.warnings);
}

async function resolveContiguousArtifactEpisodeProgress(bookDir: string): Promise<number> {
  const episodeNumbers = await loadDurableArtifactEpisodeNumbers(bookDir);
  return resolveContiguousEpisodePrefix(episodeNumbers);
}

async function loadDurableArtifactEpisodeNumbers(bookDir: string): Promise<number[]> {
  const episodesDir = join(bookDir, "episodes");
  const indexPath = join(episodesDir, "index.json");
  const [indexState, fileEpisodes] = await Promise.all([
    readFile(indexPath, "utf-8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as Array<{ episodeNumber?: unknown; status?: unknown }>;
        const durable: number[] = [];
        const blocked = new Set<number>();
        for (const entry of parsed) {
          const episodeNumber = entry?.episodeNumber;
          if (typeof episodeNumber !== "number" || !Number.isInteger(episodeNumber) || episodeNumber < 1) continue;
          if (entry.status === "audit-failed" || entry.status === "state-degraded") {
            blocked.add(episodeNumber);
          } else {
            durable.push(episodeNumber);
          }
        }
        return { durable, blocked };
      })
      .catch(() => ({ durable: [] as number[], blocked: new Set<number>() })),
    readdir(episodesDir)
      .then((entries) => entries.flatMap((entry) => {
        const match = entry.match(/^(\d+)_/);
        return match ? [parseInt(match[1]!, 10)] : [];
      }))
      .catch(() => [] as number[]),
  ]);
  return [
    ...indexState.durable,
    ...fileEpisodes.filter((episode) => !indexState.blocked.has(episode)),
  ];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function deduplicateSummaryRows<T extends { episodeNumber: number }>(rows: ReadonlyArray<T>): T[] {
  const byEpisode = new Map<number, T>();
  for (const row of rows) {
    byEpisode.set(row.episodeNumber, row);
  }
  return [...byEpisode.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

function deduplicateHooksById<T extends { hookId: string }>(hooks: ReadonlyArray<T>, warnings: string[]): T[] {
  const byHookId = new Map<string, T>();
  for (const hook of hooks) {
    if (byHookId.has(hook.hookId)) {
      appendWarning(warnings, `${hook.hookId}: duplicate hook id normalized; kept last occurrence`);
    }
    byHookId.set(hook.hookId, hook);
  }
  return [...byHookId.values()];
}

export function resolveContiguousEpisodePrefix(episodeNumbers: ReadonlyArray<number>): number {
  const episodes = new Set(
    episodeNumbers.filter((episode): episode is number => Number.isInteger(episode) && episode > 0),
  );
  let contiguousEpisode = 0;
  while (episodes.has(contiguousEpisode + 1)) {
    contiguousEpisode += 1;
  }
  return contiguousEpisode;
}

function normalizeHookStatus(value: string | undefined, warnings: string[], hookId: string): HookStatus {
  const normalized = normalizeHookStatusAlias(value ?? "");
  if (normalized === "resolved" || normalized === "deferred" || normalized === "progressing" || normalized === "open") {
    return normalized;
  }
  if (!(value ?? "").trim()) return "open";
  appendWarning(warnings, `${hookId}:status normalized from "${value ?? ""}" to "open"`);
  return "open";
}

function normalizeHookType(value: string | undefined, warnings: string[], hookId: string): string {
  const normalized = normalizeHookTypeLabel(value ?? "");
  if (normalized) return normalized;
  appendWarning(warnings, `${hookId}: empty hook type normalized to "unspecified"`);
  return "unspecified";
}

function parseStrictIntegerWithWarning(value: string | undefined, warnings: string[], fieldLabel: string): number {
  if (!value) return 0;
  const parsed = parseStrictIntegerCell(value);
  if (parsed !== null) {
    return parsed;
  }
  appendWarning(warnings, `${fieldLabel} normalized from "${value}" to 0`);
  return 0;
}

function parseIntegerWithFallback(
  value: string | undefined,
  fallback: number,
  warnings: string[],
  fieldLabel: string,
): number {
  if (!value) return Math.max(0, fallback);
  const match = value.match(/\d+/);
  if (!match) {
    appendWarning(warnings, `${fieldLabel} normalized from "${value}" to ${Math.max(0, fallback)}`);
    return Math.max(0, fallback);
  }
  return parseInt(match[0], 10);
}

function parseStrictIntegerCell(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = normalizeHookId(value);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  return parseInt(normalized, 10);
}

function normalizeExplicitEpisode(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return 0;
  }
  return value;
}

function appendWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

function uniqueStrings(values: ReadonlyArray<string>): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
