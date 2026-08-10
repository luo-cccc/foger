import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import yaml from "js-yaml";
import type { PlanEpisodeOutput } from "../agents/planner.js";
import {
  EpisodeIntentSchema,
  ContextPackageSchema,
  RuleStackSchema,
  type EpisodeIntent,
  type ContextPackage,
  type RuleStack,
} from "../models/input-governance.js";
import { parseMemo, PlannerParseError } from "../utils/episode-memo-parser.js";

/**
 * Persisted governed plans are stored as a human-readable markdown file.
 * The model-facing memo protocol is also Markdown; we do not require LLMs to
 * emit YAML frontmatter. If an old YAML-frontmatter cache is encountered, this
 * loader returns null and the runner re-plans.
 *
 * File path: `story/runtime/episode-NNNN.plan.md`
 *
 * The sibling `episode-NNNN.intent.md` file stays as a human-readable
 * render — it is not parsed back. We keep it in sync by regenerating
 * downstream, but only this `.plan.md` is authoritative for restore.
 *
 * If parse fails for any reason we return null and let the runner re-invoke
 * the planner. We never try to partially reconstruct — silent degradation
 * is worse than re-planning.
 */

function planPath(bookDir: string, episodeNumber: number): string {
  const runtimeDir = join(bookDir, "story", "runtime");
  const padded = String(episodeNumber).padStart(4, "0");
  return join(runtimeDir, `episode-${padded}.plan.md`);
}

function intentPath(bookDir: string, episodeNumber: number): string {
  const runtimeDir = join(bookDir, "story", "runtime");
  const padded = String(episodeNumber).padStart(4, "0");
  return join(runtimeDir, `episode-${padded}.intent.md`);
}

export async function savePersistedPlan(
  bookDir: string,
  plan: PlanEpisodeOutput,
): Promise<void> {
  const { intent, memo, plannerInputs } = plan;
  const content = renderPersistedPlanMarkdown(intent, memo, plannerInputs);
  await writeFile(planPath(bookDir, memo.episode), content, "utf-8");
}

export async function loadPersistedPlan(
  bookDir: string,
  episodeNumber: number,
  options?: { readonly allowFallbackMemo?: boolean },
): Promise<PlanEpisodeOutput | null> {
  let raw: string;
  try {
    raw = await readFile(planPath(bookDir, episodeNumber), "utf-8");
  } catch {
    return loadLegacyIntentPlan(bookDir, episodeNumber);
  }

  if (raw.trimStart().startsWith("---")) return null;

  // Reconstruct the memo via the same strict parser the planner uses. This
  // guarantees the required contract fields are still valid; drift triggers
  // re-planning (null return).
  let memo;
  try {
    const memoBlock = extractMarkedBlock(raw, "MEMO");
    if (!memoBlock) return null;
    memo = parseMemo(memoBlock, episodeNumber, readBooleanField(raw, "Golden Opening") ?? false);
    // A fallback memo is usable only for the operation that produced it. If
    // that operation is interrupted, reusing the cached fallback would skip a
    // healthy planner on the next write attempt and preserve the old failure.
    if (!options?.allowFallbackMemo && /^##\s+Planner warning\s*$/im.test(memo.body)) return null;
  } catch (error) {
    if (error instanceof PlannerParseError) return null;
    throw error;
  }

  let intent: EpisodeIntent;
  try {
    intent = EpisodeIntentSchema.parse({
      episode: episodeNumber,
      goal: readField(raw, "Intent Goal") ?? memo.goal,
      outlineNode: readOptionalField(raw, "Outline Node"),
      arcContext: readOptionalField(raw, "Arc Context"),
      mustKeep: readListSection(raw, "Must Keep"),
      mustAvoid: readListSection(raw, "Must Avoid"),
      styleEmphasis: readListSection(raw, "Style Emphasis"),
    });
  } catch {
    return null;
  }

  const plannerInputs = readListSection(raw, "Planner Inputs");

  // intentMarkdown is a display artifact — read the sibling .intent.md so we
  // surface the same content downstream consumers expect. If it's missing we
  // fall back to the memo body, which is usable but less rich.
  let intentMarkdown = memo.body;
  try {
    intentMarkdown = await readFile(intentPath(bookDir, episodeNumber), "utf-8");
  } catch {
    // fall through — memo body is a safe default.
  }

  return {
    intent,
    memo,
    intentMarkdown,
    plannerInputs,
    runtimePath: intentPath(bookDir, episodeNumber),
  };
}

export interface PersistedGovernedEpisodeInput {
  readonly plan: PlanEpisodeOutput | null;
  readonly contextPackage?: ContextPackage;
  readonly ruleStack?: RuleStack;
}

export async function loadPersistedGovernedEpisodeInput(
  bookDir: string,
  episodeNumber: number,
): Promise<PersistedGovernedEpisodeInput> {
  const runtimeDir = join(bookDir, "story", "runtime");
  const episodeSlug = `episode-${String(episodeNumber).padStart(4, "0")}`;
  const [plan, contextPackage, ruleStack] = await Promise.all([
    loadPersistedPlan(bookDir, episodeNumber, { allowFallbackMemo: true }),
    readAndParse(
      join(runtimeDir, `${episodeSlug}.context.json`),
      (raw) => ContextPackageSchema.parse(JSON.parse(raw)),
    ),
    readAndParse(
      join(runtimeDir, `${episodeSlug}.rule-stack.yaml`),
      (raw) => RuleStackSchema.parse(yaml.load(raw)),
    ),
  ]);

  return {
    plan,
    ...(contextPackage ? { contextPackage } : {}),
    ...(ruleStack ? { ruleStack } : {}),
  };
}

async function readAndParse<T>(
  path: string,
  parse: (raw: string) => T,
): Promise<T | undefined> {
  try {
    return parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function renderPersistedPlanMarkdown(
  intent: EpisodeIntent,
  memo: PlanEpisodeOutput["memo"],
  plannerInputs: ReadonlyArray<string>,
): string {
  return [
    `# Episode ${memo.episode} Plan`,
    "",
    "## Metadata",
    `Episode: ${memo.episode}`,
    `Golden Opening: ${memo.isGoldenOpening ? "yes" : "no"}`,
    "",
    "<!-- INKOS_PLAN_MEMO_START -->",
    renderMemoMarkdown(memo),
    "<!-- INKOS_PLAN_MEMO_END -->",
    "",
    "## Intent",
    `Intent Goal: ${intent.goal}`,
    `Outline Node: ${intent.outlineNode ?? "(none)"}`,
    `Arc Context: ${intent.arcContext ?? "(none)"}`,
    "",
    "### Must Keep",
    renderList(intent.mustKeep),
    "",
    "### Must Avoid",
    renderList(intent.mustAvoid),
    "",
    "### Style Emphasis",
    renderList(intent.styleEmphasis),
    "",
    "## Planner Inputs",
    renderList(plannerInputs),
    "",
  ].join("\n");
}

function renderMemoMarkdown(memo: PlanEpisodeOutput["memo"]): string {
  const volumeKrRefs = memo.volumeKrRefs ?? [];
  const volumeKrRationale = memo.volumeKrRationale ?? "";
  const memoBody = memo.body.trim();
  const bodyAlreadyHasVolumeBinding = memoBody.includes("## 卷级 KR 绑定")
    || memoBody.includes("## Volume KR binding");
  return [
    `# 第 ${memo.episode} 集 memo`,
    "",
    "## 本集目标",
    memo.goal,
    "",
    "## 关联线索",
    renderList(memo.threadRefs),
    "",
    bodyAlreadyHasVolumeBinding
      ? undefined
      : [
          "## 卷级 KR 绑定",
          volumeKrRefs.length > 0
            ? [
                `- 绑定：${volumeKrRefs.join(" / ")}`,
                volumeKrRationale ? `- 推进方式：${volumeKrRationale}` : undefined,
              ].filter(Boolean).join("\n")
            : (volumeKrRationale ? `- 缓冲/过渡：${volumeKrRationale}` : "- 缓冲/过渡：本集暂不直接推进篇章 KR，等待后续剧集承接。"),
          "",
        ].join("\n"),
    memoBody,
  ].filter((value): value is string => value !== undefined).join("\n");
}

function renderList(items: ReadonlyArray<string>): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function extractMarkedBlock(markdown: string, name: string): string | undefined {
  const match = markdown.match(new RegExp(`<!--\\s*INKOS_PLAN_${name}_START\\s*-->\\s*([\\s\\S]*?)\\s*<!--\\s*INKOS_PLAN_${name}_END\\s*-->`, "m"));
  return match?.[1]?.trim();
}

function readField(markdown: string, label: string): string | undefined {
  const match = markdown.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.*)$`, "m"));
  const value = match?.[1]?.trim();
  return value && value !== "(none)" ? value : undefined;
}

function readOptionalField(markdown: string, label: string): string | undefined {
  const value = readField(markdown, label);
  return value && isMeaningfulLegacyValue(value) ? value : undefined;
}

function readBooleanField(markdown: string, label: string): boolean | undefined {
  const value = readField(markdown, label);
  if (!value) return undefined;
  if (/^(yes|true|是)$/i.test(value)) return true;
  if (/^(no|false|否)$/i.test(value)) return false;
  return undefined;
}

function readListSection(markdown: string, heading: string): string[] {
  const section = markdown.match(new RegExp(`^#{2,3}\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s+|(?![\\s\\S]))`, "m"))?.[1]?.trim();
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "none");
}

async function loadLegacyIntentPlan(
  bookDir: string,
  episodeNumber: number,
): Promise<PlanEpisodeOutput | null> {
  let intentMarkdown: string;
  const runtimePath = intentPath(bookDir, episodeNumber);
  try {
    intentMarkdown = await readFile(runtimePath, "utf-8");
  } catch {
    return null;
  }

  const rawGoal = extractSection(intentMarkdown, "Goal");
  if (!rawGoal || !isMeaningfulLegacyValue(rawGoal)) return null;
  const goal = rawGoal;
  const outlineNodeRaw = extractSection(intentMarkdown, "Outline Node");
  const outlineNode = outlineNodeRaw && isMeaningfulLegacyValue(outlineNodeRaw)
    ? outlineNodeRaw
    : undefined;

  const intent: EpisodeIntent = EpisodeIntentSchema.parse({
    episode: episodeNumber,
    goal,
    outlineNode,
    mustKeep: extractListSection(intentMarkdown, "Must Keep"),
    mustAvoid: extractListSection(intentMarkdown, "Must Avoid"),
    styleEmphasis: extractListSection(intentMarkdown, "Style Emphasis"),
  });

  return {
    intent,
    memo: {
      episode: episodeNumber,
      goal: goal.slice(0, 50),
      isGoldenOpening: false,
      body: intentMarkdown,
      threadRefs: [],
      volumeKrRefs: [],
      volumeKrRationale: "",
    },
    intentMarkdown,
    plannerInputs: [relativeToBookDir(bookDir, runtimePath)],
    runtimePath,
  };
}

function extractSection(markdown: string, heading: string): string | undefined {
  const match = markdown.match(new RegExp(`^## ${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n### |$)`, "m"));
  const value = match?.[1]?.trim();
  return value && value !== "- none" ? value : undefined;
}

function extractListSection(markdown: string, heading: string): string[] {
  const section = extractSection(markdown, heading);
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "none");
}

function isMeaningfulLegacyValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (/^\(?not found\)?$/i.test(normalized)) return false;
  if (/^(?:none|null|undefined|n\/a)$/i.test(normalized)) return false;
  if (/^[*_`\-\s]+$/.test(normalized)) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function relativeToBookDir(bookDir: string, absolutePath: string): string {
  return relative(bookDir, absolutePath).replaceAll("\\", "/");
}
