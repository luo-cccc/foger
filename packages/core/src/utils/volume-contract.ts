import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChapterMemo } from "../models/input-governance.js";
import {
  VolumeContractFileSchema,
  VolumeContractSchema,
  VolumeProgressFileSchema,
  type VolumeContract,
  type VolumeContractFile,
  type VolumeGateIssue,
  type VolumeProgressEntry,
  type VolumeProgressFile,
} from "../models/volume-contract.js";
import { readVolumeMap } from "./outline-paths.js";

const VOLUME_SOURCE = "story/outline/volume_map.md";
const VOLUME_PROGRESS_SOURCE = "story/runtime/volume-progress.json";

export interface LoadVolumeContractOptions {
  readonly chapterNumber?: number;
  readonly now?: Date;
}

export async function loadVolumeContracts(
  bookDir: string,
  options: LoadVolumeContractOptions = {},
): Promise<VolumeContractFile> {
  const volumeMap = await readVolumeMap(bookDir, "");
  const contracts = extractVolumeContracts(volumeMap, {
    source: VOLUME_SOURCE,
    chapterNumber: options.chapterNumber,
  });
  return VolumeContractFileSchema.parse({
    version: 1,
    source: VOLUME_SOURCE,
    generatedAt: (options.now ?? new Date()).toISOString(),
    contracts,
  });
}

export async function loadCurrentVolumeContract(
  bookDir: string,
  chapterNumber: number,
): Promise<VolumeContract | null> {
  const file = await loadVolumeContracts(bookDir, { chapterNumber });
  return selectVolumeContract(file.contracts, chapterNumber);
}

export async function saveVolumeContractArtifacts(
  bookDir: string,
  contractFile: VolumeContractFile,
): Promise<ReadonlyArray<string>> {
  const runtimeDir = join(bookDir, "story", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const written: string[] = [];
  const allPath = join(runtimeDir, "volume-contracts.json");
  await writeFile(allPath, `${JSON.stringify(contractFile, null, 2)}\n`, "utf-8");
  written.push(allPath);
  for (const contract of contractFile.contracts) {
    const path = join(runtimeDir, `${contract.volumeId}.contract.json`);
    await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
    written.push(path);
  }
  const progress = await loadVolumeProgress(bookDir);
  written.push(...await writeVolumeDashboardArtifacts(runtimeDir, contractFile, progress));
  return written;
}

export async function readSavedVolumeContract(
  bookDir: string,
  chapterNumber: number,
): Promise<VolumeContract | null> {
  const path = join(bookDir, "story", "runtime", "volume-contracts.json");
  try {
    const file = VolumeContractFileSchema.parse(JSON.parse(await readFile(path, "utf-8")));
    return selectVolumeContract(file.contracts, chapterNumber);
  } catch {
    return null;
  }
}

export async function loadVolumeProgress(bookDir: string): Promise<VolumeProgressFile> {
  const path = join(bookDir, "story", "runtime", "volume-progress.json");
  try {
    return VolumeProgressFileSchema.parse(JSON.parse(await readFile(path, "utf-8")));
  } catch {
    return VolumeProgressFileSchema.parse({
      version: 1,
      generatedAt: new Date().toISOString(),
      entries: [],
    });
  }
}

export async function saveVolumeProgress(
  bookDir: string,
  progress: VolumeProgressFile,
): Promise<string> {
  const runtimeDir = join(bookDir, "story", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const path = join(runtimeDir, "volume-progress.json");
  const parsedProgress = VolumeProgressFileSchema.parse(progress);
  await writeFile(path, `${JSON.stringify(parsedProgress, null, 2)}\n`, "utf-8");
  const contractsPath = join(runtimeDir, "volume-contracts.json");
  try {
    const contractFile = VolumeContractFileSchema.parse(JSON.parse(await readFile(contractsPath, "utf-8")));
    await writeVolumeDashboardArtifacts(runtimeDir, contractFile, parsedProgress);
  } catch {
    // Contract artifacts may not exist yet during first-run bootstrap.
  }
  return path;
}

export async function recordVolumeProgressEntry(
  bookDir: string,
  entry: Omit<VolumeProgressEntry, "recordedAt" | "visibleKrRefs" | "attemptedKrRefs"> & {
    readonly visibleKrRefs?: ReadonlyArray<string>;
    readonly attemptedKrRefs?: ReadonlyArray<string>;
    readonly recordedAt?: string;
  },
): Promise<VolumeProgressFile> {
  const progress = await loadVolumeProgress(bookDir);
  const recordedAt = entry.recordedAt ?? new Date().toISOString();
  const nextEntry: VolumeProgressEntry = {
    chapter: entry.chapter,
    volumeId: entry.volumeId,
    volumeNumber: entry.volumeNumber,
    krRefs: [...new Set(entry.krRefs)],
    visibleKrRefs: [...new Set(entry.visibleKrRefs ?? [])],
    attemptedKrRefs: [...new Set(entry.attemptedKrRefs ?? [])],
    rationale: entry.rationale,
    memoGoal: entry.memoGoal,
    recordedAt,
  };
  const entries = [
    ...progress.entries.filter((existing) => existing.chapter !== entry.chapter),
    nextEntry,
  ].sort((left, right) => left.chapter - right.chapter);
  const next = VolumeProgressFileSchema.parse({
    version: 1,
    generatedAt: recordedAt,
    entries,
  });
  await saveVolumeProgress(bookDir, next);
  return next;
}

export async function recordVisibleVolumeProgress(
  bookDir: string,
  params: {
    readonly chapter: number;
    readonly contract: VolumeContract;
    readonly visibleKrRefs: ReadonlyArray<string>;
    readonly attemptedKrRefs?: ReadonlyArray<string>;
    readonly appendRationale?: string;
    readonly recordedAt?: string;
  },
): Promise<VolumeProgressFile> {
  const progress = await loadVolumeProgress(bookDir);
  const recordedAt = params.recordedAt ?? new Date().toISOString();
  const existing = progress.entries.find((entry) => entry.chapter === params.chapter);
  const nextEntry: VolumeProgressEntry = {
    chapter: params.chapter,
    volumeId: params.contract.volumeId,
    volumeNumber: params.contract.volumeNumber,
    krRefs: [...new Set(existing?.krRefs ?? [])],
    visibleKrRefs: [...new Set([
      ...(existing?.visibleKrRefs ?? []),
      ...params.visibleKrRefs,
    ])],
    attemptedKrRefs: [...new Set([
      ...(existing?.attemptedKrRefs ?? []),
      ...(params.attemptedKrRefs ?? []),
    ])],
    rationale: [
      existing?.rationale,
      params.appendRationale,
    ].filter(Boolean).join(" | "),
    memoGoal: existing?.memoGoal ?? "",
    recordedAt,
  };
  const next = VolumeProgressFileSchema.parse({
    version: 1,
    generatedAt: recordedAt,
    entries: [
      ...progress.entries.filter((entry) => entry.chapter !== params.chapter),
      nextEntry,
    ].sort((left, right) => left.chapter - right.chapter),
  });
  await saveVolumeProgress(bookDir, next);
  return next;
}

export function renderVolumeProgressBrief(
  progress: VolumeProgressFile,
  contract: VolumeContract,
  options: {
    readonly beforeChapter?: number;
    readonly windowSize?: number;
  } = {},
): string {
  const beforeChapter = options.beforeChapter ?? Number.POSITIVE_INFINITY;
  const windowSize = options.windowSize ?? 5;
  const entries = recentVolumeProgressEntries(progress, contract, beforeChapter, windowSize);
  if (entries.length === 0) {
    return "# Recent Volume KR Progress\n\n(none yet)";
  }
  return [
    "# Recent Volume KR Progress",
    "",
    ...entries.map((entry) => [
      `- ch${entry.chapter}: planned=${entry.krRefs.length > 0 ? entry.krRefs.join(" / ") : "(buffer)"}`,
      `visible=${(entry.visibleKrRefs ?? []).length > 0 ? (entry.visibleKrRefs ?? []).join(" / ") : "-"}`,
      `attempted=${(entry.attemptedKrRefs ?? []).length > 0 ? (entry.attemptedKrRefs ?? []).join(" / ") : "-"}`,
      entry.memoGoal ? `goal=${entry.memoGoal}` : undefined,
      entry.rationale ? `rationale=${entry.rationale}` : undefined,
    ].filter(Boolean).join(" | ")),
  ].join("\n");
}

export function renderVolumeDashboard(
  contractFile: VolumeContractFile,
  progress: VolumeProgressFile,
): string {
  return [
    "# Volume Dashboard",
    "",
    `- source: ${contractFile.source}`,
    `- generatedAt: ${progress.generatedAt}`,
    "",
    ...contractFile.contracts.map((contract) => renderVolumeDashboardSection(contract, progress, "##")),
    "",
  ].join("\n");
}

export function renderVolumeDashboardForContract(
  contract: VolumeContract,
  progress: VolumeProgressFile,
  options: {
    readonly source?: string;
  } = {},
): string {
  return [
    `# Volume Dashboard: ${contract.volumeId} ${contract.title}`,
    "",
    options.source ? `- source: ${options.source}` : undefined,
    `- generatedAt: ${progress.generatedAt}`,
    "",
    renderVolumeDashboardSection(contract, progress, "##"),
    "",
  ].filter((line): line is string => line !== undefined).join("\n");
}

async function writeVolumeDashboardArtifacts(
  runtimeDir: string,
  contractFile: VolumeContractFile,
  progress: VolumeProgressFile,
): Promise<string[]> {
  const written: string[] = [];
  const dashboardPath = join(runtimeDir, "volume-dashboard.md");
  await writeFile(dashboardPath, renderVolumeDashboard(contractFile, progress), "utf-8");
  written.push(dashboardPath);
  for (const contract of contractFile.contracts) {
    const volumeDashboardPath = join(runtimeDir, `${contract.volumeId}.dashboard.md`);
    await writeFile(
      volumeDashboardPath,
      renderVolumeDashboardForContract(contract, progress, { source: contractFile.source }),
      "utf-8",
    );
    written.push(volumeDashboardPath);
  }
  return written;
}

function renderVolumeDashboardSection(
  contract: VolumeContract,
  progress: VolumeProgressFile,
  heading: "##",
): string {
  const volumeEntries = progress.entries
    .filter((entry) => entry.volumeId === contract.volumeId)
    .sort((left, right) => left.chapter - right.chapter);
  const krRows = contract.keyResults.map((kr) => {
    const plannedChapters = chaptersForKr(volumeEntries, kr.id, "planned");
    const visibleChapters = chaptersForKr(volumeEntries, kr.id, "visible");
    const attemptedChapters = chaptersForKr(volumeEntries, kr.id, "attempted");
    const status = resolveKrStatus(contract, kr.id, visibleChapters, attemptedChapters);
    return `| ${kr.id} | ${status} | ${plannedChapters.length > 0 ? plannedChapters.map((ch) => `ch${ch}`).join(", ") : "-"} | ${visibleChapters.length > 0 ? visibleChapters.map((ch) => `ch${ch}`).join(", ") : "-"} | ${attemptedChapters.length > 0 ? attemptedChapters.map((ch) => `ch${ch}`).join(", ") : "-"} | ${kr.text} |`;
  });
  const recent = volumeEntries.slice(-5).map((entry) =>
    `- ch${entry.chapter}: planned=${entry.krRefs.length > 0 ? entry.krRefs.join(" / ") : "(buffer)"} visible=${entry.visibleKrRefs.length > 0 ? entry.visibleKrRefs.join(" / ") : "-"} attempted=${(entry.attemptedKrRefs ?? []).length > 0 ? (entry.attemptedKrRefs ?? []).join(" / ") : "-"}${entry.memoGoal ? ` | ${entry.memoGoal}` : ""}${entry.rationale ? ` | ${entry.rationale}` : ""}`,
  );
  return [
    `${heading} ${contract.volumeId} ${contract.title}`,
    "",
    `- chapters: ${contract.chapterStart && contract.chapterEnd ? `${contract.chapterStart}-${contract.chapterEnd}` : "(not declared)"}`,
    `- objective: ${contract.objective}`,
    `- irreversibleEvent: ${contract.irreversibleEvent}`,
    contract.protagonistStageGoal ? `- protagonistStageGoal: ${contract.protagonistStageGoal}` : undefined,
    contract.foregroundGoal ? `- foregroundGoal: ${contract.foregroundGoal}` : undefined,
    contract.backgroundThread ? `- backgroundThread: ${contract.backgroundThread}` : undefined,
    `- progressEntries: ${volumeEntries.length}`,
    "",
    ...renderContractSupplySection(contract),
    "",
    "| KR | status | plannedChapters | visibleChapters | attemptedChapters | text |",
    "| --- | --- | --- | --- | --- | --- |",
    ...krRows,
    "",
    "### Recent entries",
    recent.length > 0 ? recent.join("\n") : "(none)",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderContractSupplySection(contract: VolumeContract): string[] {
  const rows = [
    contract.worldRuleReleases.length > 0
      ? `- worldRuleReleases: ${contract.worldRuleReleases.join(" / ")}`
      : undefined,
    contract.relationshipTensions.length > 0
      ? `- relationshipTensions: ${contract.relationshipTensions.join(" / ")}`
      : undefined,
    contract.hookDebts.length > 0
      ? `- hookDebts: ${contract.hookDebts.join(" / ")}`
      : undefined,
  ].filter((line): line is string => line !== undefined);
  if (rows.length === 0) return [];
  return [
    "### Volume supply",
    ...rows,
  ];
}

export function extractVolumeContracts(
  volumeMap: string,
  options: {
    readonly source?: string;
    readonly chapterNumber?: number;
  } = {},
): VolumeContract[] {
  const source = options.source ?? VOLUME_SOURCE;
  const blocks = splitVolumeBlocks(volumeMap);
  const contracts = blocks
    .map((block, index) => contractFromBlock(block, index + 1, source))
    .filter((contract): contract is VolumeContract => contract !== null);

  if (contracts.length > 0) return contracts;

  const fallback = contractFromBlock({
    heading: "Volume 1",
    body: volumeMap,
  }, 1, source);
  return fallback ? [fallback] : [];
}

export function selectVolumeContract(
  contracts: ReadonlyArray<VolumeContract>,
  chapterNumber: number,
): VolumeContract | null {
  if (contracts.length === 0) return null;
  const ranged = contracts.find((contract) =>
    contract.chapterStart !== undefined
    && contract.chapterEnd !== undefined
    && chapterNumber >= contract.chapterStart
    && chapterNumber <= contract.chapterEnd,
  );
  if (ranged) return ranged;
  const starts = contracts
    .filter((contract) => contract.chapterStart !== undefined && chapterNumber >= contract.chapterStart)
    .sort((left, right) => (right.chapterStart ?? 0) - (left.chapterStart ?? 0));
  if (starts[0]) return starts[0];
  return contracts[0] ?? null;
}

export function renderVolumeContractBrief(
  contract: VolumeContract,
  progress?: VolumeProgressFile,
): string {
  return [
    `# Volume Contract: ${contract.title}`,
    "",
    `- volumeId: ${contract.volumeId}`,
    contract.chapterStart && contract.chapterEnd
      ? `- chapters: ${contract.chapterStart}-${contract.chapterEnd}`
      : undefined,
    `- objective: ${contract.objective}`,
    `- irreversibleEvent: ${contract.irreversibleEvent}`,
    contract.protagonistStageGoal ? `- protagonistStageGoal: ${contract.protagonistStageGoal}` : undefined,
    contract.foregroundGoal ? `- foregroundGoal: ${contract.foregroundGoal}` : undefined,
    contract.backgroundThread ? `- backgroundThread: ${contract.backgroundThread}` : undefined,
    contract.worldRuleReleases.length > 0 ? `- worldRuleReleases: ${contract.worldRuleReleases.join(" / ")}` : undefined,
    contract.relationshipTensions.length > 0 ? `- relationshipTensions: ${contract.relationshipTensions.join(" / ")}` : undefined,
    contract.hookDebts.length > 0 ? `- hookDebts: ${contract.hookDebts.join(" / ")}` : undefined,
    "",
    "## Key Results",
    ...contract.keyResults.map((kr) => {
      const chapters = progress ? chaptersForKr(
        progress.entries.filter((entry) => entry.volumeId === contract.volumeId),
        kr.id,
        "visible",
      ) : [];
      const attemptedChapters = progress ? chaptersForKr(
        progress.entries.filter((entry) => entry.volumeId === contract.volumeId),
        kr.id,
        "attempted",
      ) : [];
      const status = progress ? resolveKrStatus(contract, kr.id, chapters, attemptedChapters) : kr.status;
      return [
        `- ${kr.id}: ${kr.text} [${status}]`,
        chapters.length > 0 ? `visible=${chapters.join(",")}` : undefined,
        attemptedChapters.length > 0 ? `attempted=${attemptedChapters.join(",")}` : undefined,
      ].filter(Boolean).join(" ");
    }),
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function runVolumeGate(input: {
  readonly memo: ChapterMemo;
  readonly contract: VolumeContract | null;
  readonly phase: "pre" | "post";
  readonly text?: string;
  readonly progress?: VolumeProgressFile;
  readonly chapterNumber?: number;
  readonly miniCycleWindow?: number;
}): ReadonlyArray<VolumeGateIssue> {
  if (!input.contract) return [];

  const issues: VolumeGateIssue[] = [];
  const knownKrIds = new Set(input.contract.keyResults.flatMap((kr) => normalizeKrRefs(kr.id)));
  const memoRefs = normalizeKrRefs(...(input.memo.volumeKrRefs ?? []));
  const unknownRefs = memoRefs.filter((ref) => !knownKrIds.has(ref));
  const rationale = (input.memo.volumeKrRationale ?? "").trim();
  const hasRationale = isMeaningfulRationale(rationale);
  const boundRefs = memoRefs.filter((ref) => knownKrIds.has(ref));
  const chapterNumber = input.chapterNumber ?? input.memo.chapter;
  const miniCycleWindow = input.miniCycleWindow ?? 5;

  if (unknownRefs.length > 0) {
    issues.push({
      severity: "warning",
      category: "volume-kr-unknown",
      description: `[${input.phase}-write volume gate] Chapter memo references unknown volume KR: ${[...new Set(unknownRefs)].join(", ")}.`,
      suggestion: "Bind the chapter to an existing KR from the current VolumeContract or explain why the chapter is a buffer/transition.",
      repairScope: "local",
    });
  }

  if (boundRefs.length === 0 && !hasRationale) {
    issues.push({
      severity: "warning",
      category: "volume-kr-unbound",
      description: `[${input.phase}-write volume gate] Chapter memo neither binds an existing volume KR nor explains a buffer/transition exception.`,
      suggestion: "Add at least one volume KR binding (for example KR1) or a concrete rationale for not advancing a KR this chapter.",
      repairScope: "local",
    });
  }

  if (input.phase === "pre" && input.progress && chapterNumber > 1) {
    const recentEntries = recentVolumeProgressEntries(
      input.progress,
      input.contract,
      chapterNumber,
      miniCycleWindow - 1,
    );
    const recentAdvanced = recentEntries.some((entry) =>
      [...(entry.visibleKrRefs ?? []), ...(entry.attemptedKrRefs ?? [])].some((ref) =>
        normalizeKrRefs(ref).some((normalized) => knownKrIds.has(normalized))
      ),
    );
    if (boundRefs.length === 0 && recentEntries.length >= Math.max(2, miniCycleWindow - 1) && !recentAdvanced) {
      issues.push({
        severity: "warning",
        category: "volume-mini-cycle-stalled",
        description: `[pre-write volume gate] Recent ${recentEntries.length + 1}-chapter mini-cycle has no visible volume KR advancement, including this chapter's memo.`,
        suggestion: "Advance at least one current-volume KR this chapter, or revise the recent buffer run so the volume objective remains observable.",
        repairScope: "local",
      });
    }
  }

  if (input.phase === "post" && input.text && boundRefs.length > 0) {
    const text = normalizeText(input.text);
    const visibleRefs = detectVisibleKrRefs(input.contract, text)
      .filter((ref) => normalizeKrRefs(ref).some((id) => boundRefs.includes(id)));
    const attemptedRefs = detectAttemptedKrRefs(input.contract, text)
      .filter((ref) => normalizeKrRefs(ref).some((id) => boundRefs.includes(id)));
    if (visibleRefs.length === 0 && attemptedRefs.length === 0) {
      issues.push({
        severity: "warning",
        category: "volume-kr-not-visible",
        description: "[post-write volume gate] Draft is bound to a volume KR, but the KR is not visibly advanced in the prose.",
        suggestion: "Make the bound KR visible on page through evidence, relationship movement, power shift, or a concrete failed attempt.",
        repairScope: "local",
      });
    }
  }

  if (input.phase === "post" && input.text && isVolumeEndChapter(input.contract, chapterNumber)) {
    const text = normalizeText(input.text);
    const progressedRefs = new Set<string>(detectVisibleKrRefs(input.contract, text));
    for (const entry of input.progress?.entries ?? []) {
      if (entry.volumeId !== input.contract.volumeId || entry.chapter > chapterNumber) continue;
      for (const ref of entry.visibleKrRefs ?? []) {
        for (const normalized of normalizeKrRefs(ref)) {
          if (knownKrIds.has(normalized)) progressedRefs.add(normalized);
        }
      }
    }

    const missingKrs = input.contract.keyResults.filter((kr) =>
      !normalizeKrRefs(kr.id).some((ref) => progressedRefs.has(ref)),
    );
    if (missingKrs.length > 0) {
      issues.push({
        severity: "critical",
        category: "volume-end-kr-incomplete",
        description: `[post-write volume gate] Volume end reached but these KRs have no recorded chapter binding: ${missingKrs.map((kr) => kr.id).join(", ")}.`,
        suggestion: "Before ending the volume, visibly advance or resolve every volume KR, or revise the VolumeContract if the outline changed intentionally.",
        repairScope: "structural",
      });
    }

    if (!mentionsIrreversibleEvent(text, input.contract.irreversibleEvent)) {
      issues.push({
        severity: "critical",
        category: "volume-end-irreversible-missing",
        description: "[post-write volume gate] Volume end reached but the declared irreversible event is not visible in the prose.",
        suggestion: `Make the irreversible event explicit on page: ${input.contract.irreversibleEvent}`,
        repairScope: "structural",
      });
    }

    issues.push(...runVolumeSupplyEndChecks(input.contract, text));
  }

  return issues;
}

function runVolumeSupplyEndChecks(
  contract: VolumeContract,
  normalizedText: string,
): VolumeGateIssue[] {
  const issues: VolumeGateIssue[] = [];
  if (contract.protagonistStageGoal && !mentionsContractSupply(normalizedText, contract.protagonistStageGoal)) {
    issues.push({
      severity: "warning",
      category: "volume-end-protagonist-stage-missing",
      description: "[post-write volume gate] Volume end reached but the protagonist stage goal is not visible in the prose.",
      suggestion: `Make the protagonist's stage shift observable on page: ${contract.protagonistStageGoal}`,
      repairScope: "structural",
    });
  }
  if (contract.foregroundGoal && !mentionsContractSupply(normalizedText, contract.foregroundGoal)) {
    issues.push({
      severity: "warning",
      category: "volume-end-foreground-goal-missing",
      description: "[post-write volume gate] Volume end reached but the foreground goal is not visible in the prose.",
      suggestion: `Resolve or visibly reframe the volume foreground goal: ${contract.foregroundGoal}`,
      repairScope: "structural",
    });
  }
  if (contract.backgroundThread && !mentionsContractSupply(normalizedText, contract.backgroundThread)) {
    issues.push({
      severity: "warning",
      category: "volume-end-background-thread-missing",
      description: "[post-write volume gate] Volume end reached but the background thread is not visible in the prose.",
      suggestion: `Surface the volume's background thread through evidence, implication, or consequence: ${contract.backgroundThread}`,
      repairScope: "structural",
    });
  }
  issues.push(...missingSupplyItems(
    normalizedText,
    "volume-end-world-rule-release-missing",
    "World rule release has no visible prose evidence at volume end",
    contract.worldRuleReleases,
  ));
  issues.push(...missingSupplyItems(
    normalizedText,
    "volume-end-relationship-tension-missing",
    "Relationship tension has no visible prose evidence at volume end",
    contract.relationshipTensions,
  ));
  issues.push(...missingSupplyItems(
    normalizedText,
    "volume-end-hook-debt-missing",
    "Hook debt has no visible prose evidence at volume end",
    contract.hookDebts,
  ));
  return issues;
}

function missingSupplyItems(
  normalizedText: string,
  category: string,
  label: string,
  items: ReadonlyArray<string>,
): VolumeGateIssue[] {
  return items
    .filter((item) => !mentionsContractSupply(normalizedText, item))
    .map((item) => ({
      severity: "warning" as const,
      category,
      description: `[post-write volume gate] ${label}: ${item}.`,
      suggestion: "Make this volume-level supply visible on page or revise the VolumeContract if the outline changed intentionally.",
      repairScope: "structural",
    }));
}

export function detectVisibleKrRefs(
  contract: VolumeContract,
  text: string,
): string[] {
  const normalizedText = normalizeText(text);
  return contract.keyResults
    .filter((kr) => mentionsKr(normalizedText, kr.text) && !mentionsFailedAttempt(normalizedText, kr.text))
    .map((kr) => kr.id);
}

export function detectAttemptedKrRefs(
  contract: VolumeContract,
  text: string,
): string[] {
  const normalizedText = normalizeText(text);
  return contract.keyResults
    .filter((kr) => mentionsKr(normalizedText, kr.text) && mentionsFailedAttempt(normalizedText, kr.text))
    .map((kr) => kr.id);
}

export function recentVolumeProgressEntries(
  progress: VolumeProgressFile,
  contract: VolumeContract,
  beforeChapter: number,
  limit: number,
): VolumeProgressEntry[] {
  return progress.entries
    .filter((entry) =>
      entry.volumeId === contract.volumeId
      && entry.chapter < beforeChapter
      && isChapterInContract(entry.chapter, contract),
    )
    .sort((left, right) => right.chapter - left.chapter)
    .slice(0, Math.max(0, limit))
    .sort((left, right) => left.chapter - right.chapter);
}

function chaptersForKr(
  entries: ReadonlyArray<VolumeProgressEntry>,
  krId: string,
  mode: "planned" | "visible" | "attempted" = "planned",
): number[] {
  const aliases = new Set(normalizeKrRefs(krId));
  return entries
    .filter((entry) => {
      const refs = mode === "visible"
        ? (entry.visibleKrRefs ?? [])
        : mode === "attempted"
          ? (entry.attemptedKrRefs ?? [])
          : (entry.krRefs ?? []);
      return refs.some((ref) => normalizeKrRefs(ref).some((normalized) => aliases.has(normalized)));
    })
    .map((entry) => entry.chapter);
}

function resolveKrStatus(
  contract: VolumeContract,
  krId: string,
  chapters: ReadonlyArray<number>,
  attemptedChapters: ReadonlyArray<number> = [],
): "pending" | "attempted" | "advanced" | "done" {
  if (chapters.length === 0) return attemptedChapters.length > 0 ? "attempted" : "pending";
  if (contract.chapterEnd !== undefined && chapters.some((chapter) => chapter >= contract.chapterEnd!)) {
    return "done";
  }
  return "advanced";
}

function isChapterInContract(chapter: number, contract: VolumeContract): boolean {
  if (contract.chapterStart !== undefined && chapter < contract.chapterStart) return false;
  if (contract.chapterEnd !== undefined && chapter > contract.chapterEnd) return false;
  return true;
}

function isVolumeEndChapter(contract: VolumeContract, chapterNumber: number): boolean {
  // Fire the volume-end gate only on the planned last chapter. Chapters are
  // written sequentially, so `=== chapterEnd` hits exactly once per volume.
  // Using `>=` here re-fired the full volume-end critical suite on every chapter
  // past the planned end (e.g. when writing overruns the outline and
  // selectVolumeContract falls back to the last volume for out-of-range chapters).
  return contract.chapterEnd !== undefined && chapterNumber === contract.chapterEnd;
}

export function normalizeKrRefs(...refs: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const raw of refs) {
    const normalized = raw.trim().toUpperCase();
    if (!normalized) continue;
    out.add(normalized);
    const kr = normalized.match(/\bKR\s*[-_#:]?\s*(\d+)\b/i)?.[1];
    if (kr) {
      out.add(`KR${kr}`);
      out.add(`VKR${kr}`);
    }
    const vkr = normalized.match(/\bV(?:OLUME)?\s*[-_#:]?\s*\d+\s*[-_:]\s*KR\s*[-_#:]?\s*(\d+)\b/i)?.[1];
    if (vkr) out.add(`KR${vkr}`);
  }
  return [...out];
}

function splitVolumeBlocks(volumeMap: string): Array<{ heading: string; body: string }> {
  const lines = volumeMap.split(/\r?\n/);
  const blocks: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+?)\s*$/);
    const heading = headingMatch?.[1]?.trim() ?? "";
    if (heading && isVolumeHeading(heading)) {
      if (current) blocks.push(current);
      current = { heading, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  return blocks
    .map((block) => ({ heading: block.heading, body: block.lines.join("\n") }))
    .filter((block) => block.body.trim().length > 0);
}

function contractFromBlock(
  block: { readonly heading: string; readonly body: string },
  fallbackVolumeNumber: number,
  source: string,
): VolumeContract | null {
  const volumeNumber = parseVolumeNumber(block.heading) ?? fallbackVolumeNumber;
  const objective = extractLabelValue(block.body, [
    "Objective",
    "卷级 Objective",
    "本卷 Objective",
    "本卷目标",
    "卷级目标",
    "目标",
  ]);
  const keyResults = extractKeyResults(block.body, volumeNumber);
  const irreversibleEvent = extractLabelValue(block.body, [
    "Irreversible Event",
    "卷尾不可逆事件",
    "不可逆事件",
    "不可逆改变",
    "强制改变",
  ]);
  const protagonistStageGoal = extractLabelValue(block.body, [
    "Protagonist Stage Goal",
    "Character Stage Goal",
    "主角阶段目标",
    "角色阶段目标",
    "主角阶段",
  ]);
  const foregroundGoal = extractLabelValue(block.body, [
    "Foreground Goal",
    "Foreground Story",
    "前台目标",
    "前台故事",
    "前台线",
  ]);
  const backgroundThread = extractLabelValue(block.body, [
    "Background Thread",
    "Background Story",
    "后台暗线",
    "后台故事",
    "后台线",
  ]);

  if (!objective || keyResults.length === 0 || !irreversibleEvent) {
    return null;
  }

  const range = parseChapterRange(`${block.heading}\n${block.body}`);
  return VolumeContractSchema.parse({
    volumeId: `volume-${String(volumeNumber).padStart(3, "0")}`,
    volumeNumber,
    title: cleanTitle(block.heading, volumeNumber),
    ...(range ? { chapterStart: range.start, chapterEnd: range.end } : {}),
    objective,
    keyResults,
    irreversibleEvent,
    ...(protagonistStageGoal ? { protagonistStageGoal } : {}),
    worldRuleReleases: extractLabeledList(block.body, [
      "World Rule Releases",
      "World Rule Release Plan",
      "世界规则释放计划",
      "世界规则释放",
      "规则释放",
    ]),
    relationshipTensions: extractLabeledList(block.body, [
      "Relationship Tensions",
      "Core Relationship Tension",
      "核心关系张力",
      "关系张力",
      "关系推进",
    ]),
    ...(foregroundGoal ? { foregroundGoal } : {}),
    ...(backgroundThread ? { backgroundThread } : {}),
    hookDebts: extractLabeledList(block.body, [
      "Hook Debts",
      "Hooks",
      "Hook Debt",
      "必须推进或回收的 hook 债",
      "Hook 债",
      "钩子债",
      "卷间钩子",
    ]),
    source,
  });
}

function extractKeyResults(body: string, volumeNumber: number): VolumeContract["keyResults"] {
  const results: VolumeContract["keyResults"] = [];
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/(?:^|\s)(?:[-*]\s*)?(?:(?:V(?:olume)?\s*\d+\s*[-_:])?KR\s*[-_#:]?\s*(\d+)|Key Result\s*(\d+)|关键结果\s*(\d+))\s*[：:.)-]?\s*(.+)$/i);
    if (!match) continue;
    const index = Number(match[1] ?? match[2] ?? match[3]);
    const text = cleanLine(match[4] ?? "");
    if (!Number.isFinite(index) || !text) continue;
    results.push({
      id: `V${volumeNumber}-KR${index}`,
      text,
      status: "pending",
    });
  }
  return dedupeKeyResults(results).slice(0, 5);
}

function extractLabelValue(body: string, labels: ReadonlyArray<string>): string | undefined {
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    for (const label of labels) {
      const escaped = escapeRegExp(label);
      const inline = line.match(new RegExp(`^(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*(.+)$`, "i"));
      if (inline?.[1]) return cleanLine(inline[1]);
      const heading = line.match(new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "i"));
      if (heading) {
        const next = findNextContentLine(lines, index + 1);
        if (next) return cleanLine(next);
      }
    }
  }
  return undefined;
}

function extractLabeledList(body: string, labels: ReadonlyArray<string>): string[] {
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    for (const label of labels) {
      const escaped = escapeRegExp(label);
      const inline = line.match(new RegExp(`^(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*(.+)$`, "i"));
      if (inline?.[1]) return splitListItems(inline[1]);
      const heading = line.match(new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, "i"));
      const labelOnly = line.match(new RegExp(`^(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]?\\s*$`, "i"));
      if (heading || labelOnly) return collectFollowingList(lines, index + 1);
    }
  }
  return [];
}

function collectFollowingList(lines: ReadonlyArray<string>, start: number): string[] {
  const items: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) {
      if (items.length > 0) break;
      continue;
    }
    if (line.startsWith("#") || looksLikeLabel(line)) break;
    const bullet = line.match(/^[-*]\s+(.+)$/)?.[1] ?? line;
    items.push(...splitListItems(bullet));
  }
  return dedupeStrings(items).slice(0, 8);
}

function splitListItems(value: string): string[] {
  return dedupeStrings(value
    .split(/[;；|]/)
    .map((item) => cleanLine(item))
    .filter(Boolean)).slice(0, 8);
}

function findNextContentLine(lines: ReadonlyArray<string>, start: number): string | undefined {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (line.startsWith("#")) return undefined;
    return line;
  }
  return undefined;
}

function parseChapterRange(text: string): { start: number; end: number } | null {
  const patterns = [
    /(?:Chapters?|Ch\.?)\s*(\d+)\s*[-~–—]\s*(\d+)/i,
    /第\s*(\d+)\s*[-~–—至到]\s*(\d+)\s*章/u,
    /章节范围\s*[：:]\s*(\d+)\s*[-~–—至到]\s*(\d+)\s*章?/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return { start: Math.min(start, end), end: Math.max(start, end) };
    }
  }
  return null;
}

function isVolumeHeading(heading: string): boolean {
  return /^(第[一二三四五六七八九十百千万零〇\d]+\s*卷|Volume\s+\d+|Vol\.\s*\d+|\d+_Volume)/i.test(heading.trim());
}

function parseVolumeNumber(text: string): number | null {
  const arabic = text.match(/(?:Volume|Vol\.?|第|^)\s*(\d+)/i)?.[1];
  if (arabic) return Number(arabic);
  const chinese = text.match(/第\s*([一二三四五六七八九十百千万零〇]+)\s*卷/u)?.[1];
  return chinese ? parseChineseNumber(chinese) : null;
}

function parseChineseNumber(value: string): number | null {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value.length === 1 && digits[value] !== undefined) return digits[value];
  if (value === "十") return 10;
  const tenMatch = value.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (tenMatch) {
    return (tenMatch[1] ? digits[tenMatch[1]]! : 1) * 10 + (tenMatch[2] ? digits[tenMatch[2]]! : 0);
  }
  return null;
}

function cleanTitle(heading: string, volumeNumber: number): string {
  const cleaned = heading
    .replace(/^第[一二三四五六七八九十百千万零〇\d]+\s*卷\s*/u, "")
    .replace(/^Volume\s+\d+\s*[:：.-]?\s*/i, "")
    .replace(/^Vol\.\s*\d+\s*[:：.-]?\s*/i, "")
    .trim();
  return cleaned || `Volume ${volumeNumber}`;
}

function cleanLine(value: string): string {
  return value
    .replace(/^[-*]\s*/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKeyResults(results: ReadonlyArray<VolumeContract["keyResults"][number]>): VolumeContract["keyResults"] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.id)) return false;
    seen.add(result.id);
    return true;
  });
}

function dedupeStrings(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanLine(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function looksLikeLabel(value: string): boolean {
  return /^(?:[-*]\s*)?(?:\*\*)?[\p{L}\p{N}_\s/（）()#+-]{2,40}(?:\*\*)?\s*[：:]\s*.+$/u.test(value);
}

function isMeaningfulRationale(value: string): boolean {
  if (!value) return false;
  if (/^(无|none|n\/a|na|—|-|\(none\))$/i.test(value.trim())) return false;
  return /缓冲|过渡|蓄压|铺垫|暂不|defer|buffer|transition|setup|breath/i.test(value)
    || value.length >= 12;
}

function mentionsKr(text: string, krText: string): boolean {
  const terms = extractTerms(krText);
  if (terms.length === 0) return false;
  return hasTermHits(text, terms, { minHits: 2, maxHits: 4, ratio: 0.25 });
}

function mentionsFailedAttempt(text: string, krText: string): boolean {
  if (!mentionsKr(text, krText)) return false;
  const explicitFailure = /失败|未能|没能|没有(?:拿到|迫使|锁定|追回|完成|达成)|failed\s+to|fails\s+to|failure|unable\s+to|could\s+not|did\s+not/i.test(text);
  if (explicitFailure) return true;
  const failureSignal = /试图|尝试|被迫撤退|无功而返|受阻|tr(?:y|ied|ies|ying)|attempt(?:ed|s)?/i.test(text);
  if (!failureSignal) return false;
  const successSignal = /成功|已经(?:拿到|迫使|锁定|追回|完成|达成)|终于(?:拿到|迫使|锁定|追回|完成|达成)|拿到|追回|锁定|迫使|达成|完成|recovered|recovers|forced|forces|connected|connects|completed|completes|achieved|achieves/i.test(text);
  return !successSignal;
}

function mentionsIrreversibleEvent(text: string, eventText: string): boolean {
  const terms = extractTerms(eventText);
  if (terms.length === 0) return false;
  return hasTermHits(text, terms, { minHits: 2, maxHits: 5, ratio: 0.35 });
}

function mentionsContractSupply(text: string, supplyText: string): boolean {
  const terms = extractTerms(supplyText);
  if (terms.length === 0) return false;
  return hasTermHits(text, terms, { minHits: 1, maxHits: 3, ratio: 0.25 });
}

function extractTerms(value: string): string[] {
  const normalized = normalizeText(value);
  const terms = new Set<string>();
  for (const term of normalized.match(/[a-z0-9]{4,}/g) ?? []) terms.add(term);
  for (const term of normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? []) addCjkTerms(terms, term);
  return [...terms].slice(0, 32);
}

function hasTermHits(
  text: string,
  terms: ReadonlyArray<string>,
  options: { readonly minHits: number; readonly maxHits: number; readonly ratio: number },
): boolean {
  const hits = terms.filter((term) => text.includes(term));
  const required = Math.min(
    options.maxHits,
    Math.max(options.minHits, Math.ceil(terms.length * options.ratio)),
    terms.length,
  );
  return hits.length >= required;
}

function addCjkTerms(out: Set<string>, value: string): void {
  const phrases = value
    .replace(/[把将被]/gu, "")
    .split(/[的了和与及、，。；：:,.!?！？（）()《》“”"'\s]+/u)
    .map((phrase) => phrase
      .replace(/^(拿到|取得|获得|找到|证明|锁定|公开|撕下|失去|退回|让|使|从|到|成|变成|成为|连接|追回|迫使|完成|达成|不能|必须|需要)/gu, "")
      .replace(/(可能|入口|之间|当前|本章|本卷)$/gu, "")
      .trim())
    .filter((phrase) => phrase.length >= 2);

  for (const phrase of phrases) {
    if (phrase.length <= 8) addCjkTerm(out, phrase);
    const maxWindow = Math.min(5, phrase.length);
    for (let size = 2; size <= maxWindow; size += 1) {
      for (let index = 0; index <= phrase.length - size; index += 1) {
        addCjkTerm(out, phrase.slice(index, index + size));
      }
    }
  }
}

function addCjkTerm(out: Set<string>, term: string): void {
  if (/^(拿到|取得|获得|找到|证明|锁定|公开|撕下|失去|退回|不能|必须|需要|这个|那个|一个|可能|现场)$/u.test(term)) {
    return;
  }
  out.add(term);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function volumeContractPathFor(bookDir: string, volumeId: string): string {
  return join(dirname(join(bookDir, "story", "runtime", "x")), `${volumeId}.contract.json`);
}
