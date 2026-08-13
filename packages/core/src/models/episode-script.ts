import { z } from "zod";

export const EpisodeDialogueSchema = z.object({
  speaker: z.string().trim().min(1),
  text: z.string().trim().min(1),
  delivery: z.string().trim().optional(),
});

export type EpisodeDialogue = z.infer<typeof EpisodeDialogueSchema>;

export const EpisodeShotSchema = z.object({
  id: z.string().trim().min(1),
  shotSize: z.string().trim().min(1),
  camera: z.string().trim().min(1),
  durationSeconds: z.number().finite().positive(),
  visual: z.string().trim().min(1),
  action: z.string().trim().optional(),
  dialogue: z.array(EpisodeDialogueSchema).default([]),
  narration: z.string().trim().optional(),
  sound: z.string().trim().optional(),
  transition: z.string().trim().optional(),
});

export type EpisodeShot = z.infer<typeof EpisodeShotSchema>;

export const EpisodeSceneSchema = z.object({
  id: z.string().trim().min(1),
  location: z.string().trim().min(1),
  time: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  shots: z.array(EpisodeShotSchema).min(1).max(24),
});

export type EpisodeScene = z.infer<typeof EpisodeSceneSchema>;

export const EpisodeStateBucketSchema = z.object({
  knowledge: z.array(z.string().trim().min(1)),
  power: z.array(z.string().trim().min(1)),
  relationship: z.array(z.string().trim().min(1)),
  physical: z.array(z.string().trim().min(1)),
  activeAction: z.array(z.string().trim().min(1)),
  // Emotional state only counts choices that change the next behavior, never
  // vague intensity ("关系更紧张" does not belong here).
  emotional: z.array(z.string().trim().min(1)).default([]),
});

export type EpisodeStateBucket = z.infer<typeof EpisodeStateBucketSchema>;

export const EpisodeObjectiveSchema = z.object({
  character: z.string().trim().min(1),
  desiredChange: z.string().trim().min(1),
  whyNow: z.string().trim().min(1),
});

export type EpisodeObjective = z.infer<typeof EpisodeObjectiveSchema>;

export const EpisodeOppositionSchema = z.object({
  actorOrConstraint: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  leverage: z.string().trim().min(1),
});

export type EpisodeOpposition = z.infer<typeof EpisodeOppositionSchema>;

export const EpisodeCausalStepSchema = z.object({
  becauseOf: z.string().trim().min(1),
  choice: z.string().trim().min(1),
  countermove: z.string().trim().min(1),
  stateChange: z.string().trim().min(1),
  nextPressure: z.string().trim().min(1),
});

export type EpisodeCausalStep = z.infer<typeof EpisodeCausalStepSchema>;

export const EpisodeLocalResultSchema = z.object({
  goalOutcome: z.string().trim().min(1),
  stateChange: z.string().trim().min(1),
  costPaid: z.string().trim().min(1),
});

export type EpisodeLocalResult = z.infer<typeof EpisodeLocalResultSchema>;

export const EpisodeOutgoingPressureSchema = z.object({
  startedDecisionDangerOrQuestion: z.string().trim().min(1),
  whyItFollows: z.string().trim().min(1),
});

export type EpisodeOutgoingPressure = z.infer<typeof EpisodeOutgoingPressureSchema>;

export const EpisodeInformationPermissionSchema = z.object({
  subject: z.string().trim().min(1),
  audience: z.string().trim().min(1),
  known: z.array(z.string().trim().min(1)),
  suspected: z.array(z.string().trim().min(1)),
  mistaken: z.array(z.string().trim().min(1)),
  unknown: z.array(z.string().trim().min(1)),
});

export type EpisodeInformationPermission = z.infer<typeof EpisodeInformationPermissionSchema>;

export const EpisodeContractSchema = z.object({
  incomingState: EpisodeStateBucketSchema,
  objective: EpisodeObjectiveSchema,
  opposition: EpisodeOppositionSchema,
  causalEscalation: z.array(EpisodeCausalStepSchema).min(1),
  localDramaticResult: EpisodeLocalResultSchema,
  outgoingPressure: EpisodeOutgoingPressureSchema,
  handoffState: EpisodeStateBucketSchema,
  informationPermissions: z.array(EpisodeInformationPermissionSchema),
});

export type EpisodeContract = z.infer<typeof EpisodeContractSchema>;

export const SeriesResolutionSchema = z.object({
  mainConflict: z.string().trim().min(1),
  protagonistDesire: z.string().trim().min(1),
  characterArcs: z.array(z.object({
    character: z.string().trim().min(1),
    outcome: z.string().trim().min(1),
  })).min(1),
  relationships: z.array(z.object({
    parties: z.string().trim().min(1),
    outcome: z.string().trim().min(1),
  })).min(1),
});

export type SeriesResolution = z.infer<typeof SeriesResolutionSchema>;

export const EpisodeScriptSchema = z.object({
  episode: z.number().int().min(1),
  title: z.string().trim().min(1),
  estimatedDurationSeconds: z.number().finite().positive(),
  openingHook: z.string().trim().min(1),
  reversal: z.string().trim().min(1),
  emotionalHook: z.string().trim().min(1),
  endState: z.string().trim().min(1),
  seriesResolution: SeriesResolutionSchema.optional(),
  contract: EpisodeContractSchema,
  scenes: z.array(EpisodeSceneSchema).min(1).max(3),
});

/**
 * Incoming state is a continuity boundary, not a creative choice. Carry
 * forward facts from the previous handoff when a model omits or paraphrases
 * them; the visible episode remains unchanged while the persisted contract
 * stays authoritative for the next operation.
 */
export function carryForwardEpisodeIncomingState(
  script: EpisodeScript,
  previousHandoff?: EpisodeStateBucket,
): EpisodeScript {
  if (!previousHandoff) return script;
  const merge = (current: ReadonlyArray<string>, previous: ReadonlyArray<string>): string[] =>
    [...new Set([...previous, ...current].map((fact) => fact.trim()).filter(Boolean))];
  return EpisodeScriptSchema.parse({
    ...script,
    contract: {
      ...script.contract,
      incomingState: {
        knowledge: merge(script.contract.incomingState.knowledge, previousHandoff.knowledge),
        power: merge(script.contract.incomingState.power, previousHandoff.power),
        relationship: merge(script.contract.incomingState.relationship, previousHandoff.relationship),
        physical: merge(script.contract.incomingState.physical, previousHandoff.physical),
        activeAction: merge(script.contract.incomingState.activeAction, previousHandoff.activeAction),
        emotional: merge(script.contract.incomingState.emotional, previousHandoff.emotional ?? []),
      },
    },
  });
}

export type EpisodeScript = z.infer<typeof EpisodeScriptSchema>;

export const EpisodeScriptMetricsSchema = z.object({
  spokenCharacters: z.number().int().min(0),
  narrationCharacters: z.number().int().min(0),
  shotCount: z.number().int().min(0),
  sceneCount: z.number().int().min(0),
  estimatedDurationSeconds: z.number().finite().nonnegative(),
  durationWarning: z.string().optional(),
  durationWarnings: z.array(z.string()).default([]),
});

export type EpisodeScriptMetrics = z.infer<typeof EpisodeScriptMetricsSchema>;

export interface EpisodeScriptValidationIssue {
  readonly code:
    | "episode-mismatch"
    | "duplicate-scene-id"
    | "duplicate-shot-id"
    | "scene-count"
    | "shot-count"
    | "duration-mismatch"
    | "duration-hard-range"
    | "missing-reversal"
    | "missing-emotional-hook"
    | "invalid-emotional-hook"
    | "missing-end-state"
    | "missing-local-payoff"
    | "missing-outgoing-pressure"
    | "unprepared-reversal"
    | "reversal-without-consequence";
  readonly message: string;
}

export const EPISODE_DURATION_TARGET_SECONDS = 150;
export const EPISODE_DURATION_SOFT_MIN_SECONDS = 120;
export const EPISODE_DURATION_SOFT_MAX_SECONDS = 180;
export const EPISODE_DURATION_HARD_MIN_SECONDS = 90;
export const EPISODE_DURATION_HARD_MAX_SECONDS = 210;

/** Half-window around the target duration used for the soft (preferred) range. */
export const EPISODE_DURATION_SOFT_WINDOW_SECONDS = 30;

/** Average seconds per shot used to scale the shot budget with episode duration. */
export const EPISODE_SECONDS_PER_SHOT = 7.5;

/** Minimum shot count stays a hard structural floor (a shorter script is incomplete output). */
export const EPISODE_SHOT_MIN = 6;

/**
 * Shot-count budget for a target duration. The upper bound is a SOFT cap:
 * exceeding it produces an audit warning, never a hard validation failure.
 */
export function episodeShotBudget(
  targetDurationSeconds = EPISODE_DURATION_TARGET_SECONDS,
): { readonly min: number; readonly softMax: number } {
  return {
    min: Math.max(EPISODE_SHOT_MIN, Math.round(targetDurationSeconds / 18)),
    softMax: Math.max(12, Math.round(targetDurationSeconds / EPISODE_SECONDS_PER_SHOT)),
  };
}

/** Preferred (soft) duration range for a target: target ± window, clamped to the hard range. */
export function episodeSoftDurationRange(
  targetDurationSeconds = EPISODE_DURATION_TARGET_SECONDS,
): { readonly softMin: number; readonly softMax: number } {
  return {
    softMin: Math.max(EPISODE_DURATION_HARD_MIN_SECONDS, targetDurationSeconds - EPISODE_DURATION_SOFT_WINDOW_SECONDS),
    softMax: Math.min(EPISODE_DURATION_HARD_MAX_SECONDS, targetDurationSeconds + EPISODE_DURATION_SOFT_WINDOW_SECONDS),
  };
}

export function measureEpisodeScript(
  script: EpisodeScript,
  targetDurationSeconds = EPISODE_DURATION_TARGET_SECONDS,
): EpisodeScriptMetrics {
  const shots = script.scenes.flatMap((scene) => scene.shots);
  const spokenCharacters = shots.reduce(
    (total, shot) => total + shot.dialogue.reduce((sum, line) => sum + line.text.length, 0),
    0,
  );
  const narrationCharacters = shots.reduce(
    (total, shot) => total + (shot.narration?.length ?? 0),
    0,
  );
  const estimatedDurationSeconds = Math.round(
    shots.reduce((total, shot) => total + shot.durationSeconds, 0) * 10,
  ) / 10;

  const { softMin, softMax } = episodeSoftDurationRange(targetDurationSeconds);
  const durationWarning = estimatedDurationSeconds < softMin
    ? `Episode is short: ${estimatedDurationSeconds}s (soft minimum ${softMin}s).`
    : estimatedDurationSeconds > softMax
      ? `Episode is long: ${estimatedDurationSeconds}s (soft maximum ${softMax}s).`
      : undefined;

  const durationWarnings = durationWarning ? [durationWarning] : [];
  return {
    spokenCharacters,
    narrationCharacters,
    shotCount: shots.length,
    sceneCount: script.scenes.length,
    estimatedDurationSeconds,
    ...(durationWarning ? { durationWarning } : {}),
    durationWarnings,
  };
}

/**
 * Deterministic engineering adjustment: scale shot durations so the episode
 * estimate lands within 5s of the target. Never changes shot count or
 * content; each shot is clamped to 2-45s. Applied only when the result still
 * fits the hard duration range, otherwise the script is left untouched so the
 * duration audit keeps flagging it.
 */
export function normalizeEpisodeShotDurations(
  script: EpisodeScript,
  targetDurationSeconds = EPISODE_DURATION_TARGET_SECONDS,
): { readonly script: EpisodeScript; readonly adjusted: boolean } {
  const current = measureEpisodeScript(script, targetDurationSeconds).estimatedDurationSeconds;
  if (Math.abs(current - targetDurationSeconds) <= 5) {
    return { script, adjusted: false };
  }
  const factor = targetDurationSeconds / current;
  const clamp = (value: number): number => Math.min(45, Math.max(2, value));
  const scenes = script.scenes.map((scene) => ({
    ...scene,
    shots: scene.shots.map((shot) => ({
      ...shot,
      durationSeconds: Math.round(clamp(shot.durationSeconds * factor)),
    })),
  }));
  const normalized = EpisodeScriptSchema.parse({ ...script, scenes });
  const measured = measureEpisodeScript(normalized, targetDurationSeconds).estimatedDurationSeconds;
  if (measured < EPISODE_DURATION_HARD_MIN_SECONDS || measured > EPISODE_DURATION_HARD_MAX_SECONDS) {
    return { script, adjusted: false };
  }
  return {
    script: { ...normalized, estimatedDurationSeconds: measured },
    adjusted: true,
  };
}

export function validateEpisodeScript(
  script: EpisodeScript,
  expectedEpisode?: number,
): EpisodeScriptValidationIssue[] {
  const issues: EpisodeScriptValidationIssue[] = [];
  const metrics = measureEpisodeScript(script);
  if (expectedEpisode !== undefined && script.episode !== expectedEpisode) {
    issues.push({
      code: "episode-mismatch",
      message: `script episode ${script.episode} does not match expected episode ${expectedEpisode}`,
    });
  }
  if (metrics.sceneCount < 1 || metrics.sceneCount > 3) {
    issues.push({ code: "scene-count", message: `episode must contain 1-3 scenes (got ${metrics.sceneCount})` });
  }
  const sceneIds = script.scenes.map((scene) => scene.id);
  if (new Set(sceneIds).size !== sceneIds.length) {
    issues.push({ code: "duplicate-scene-id", message: "episode scene IDs must be unique" });
  }
  const shotIds = script.scenes.flatMap((scene) => scene.shots.map((shot) => shot.id));
  if (new Set(shotIds).size !== shotIds.length) {
    issues.push({ code: "duplicate-shot-id", message: "episode shot IDs must be unique" });
  }
  if (metrics.shotCount < EPISODE_SHOT_MIN) {
    issues.push({ code: "shot-count", message: `episode must contain at least ${EPISODE_SHOT_MIN} shots (got ${metrics.shotCount})` });
  }
  // The upper shot bound is a soft cap: over-budget episodes are flagged by the
  // screenplay audit as a warning (see auditEpisodeScript), never rejected here.
  if (
    metrics.estimatedDurationSeconds < EPISODE_DURATION_HARD_MIN_SECONDS
    || metrics.estimatedDurationSeconds > EPISODE_DURATION_HARD_MAX_SECONDS
  ) {
    issues.push({
      code: "duration-hard-range",
      message: `episode duration ${metrics.estimatedDurationSeconds}s is outside ${EPISODE_DURATION_HARD_MIN_SECONDS}-${EPISODE_DURATION_HARD_MAX_SECONDS}s`,
    });
  }
  if (Math.abs(script.estimatedDurationSeconds - metrics.estimatedDurationSeconds) > 5) {
    issues.push({
      code: "duration-mismatch",
      message: `declared duration ${script.estimatedDurationSeconds}s differs from shot total ${metrics.estimatedDurationSeconds}s`,
    });
  }
  if (!script.reversal.trim()) issues.push({ code: "missing-reversal", message: "episode reversal is required" });
  if (!script.emotionalHook.trim()) issues.push({ code: "missing-emotional-hook", message: "episode emotional hook is required" });
  if (script.emotionalHook.trim() && !hasConcreteAudienceQuestion(script.emotionalHook)) {
    issues.push({
      code: "invalid-emotional-hook",
      message: "episode emotional hook must be a concrete audience question about a relationship, danger, identity, sacrifice, or choice",
    });
  }
  if (!script.endState.trim()) issues.push({ code: "missing-end-state", message: "episode end state is required" });
  if (!script.contract.localDramaticResult.stateChange.trim()) {
    issues.push({ code: "missing-local-payoff", message: "episode local dramatic result must change state" });
  }
  if (!script.contract.outgoingPressure.startedDecisionDangerOrQuestion.trim()) {
    issues.push({ code: "missing-outgoing-pressure", message: "episode outgoing pressure is required" });
  }
  if (script.contract.causalEscalation.length === 0) {
    issues.push({ code: "unprepared-reversal", message: "episode reversal requires at least one causal step" });
  }
  if (!script.contract.localDramaticResult.costPaid.trim()) {
    issues.push({ code: "reversal-without-consequence", message: "episode result must state a paid cost" });
  }
  return issues;
}

/** A production ending hook must leave one specific unresolved audience question. */
export function hasConcreteAudienceQuestion(value: string): boolean {
  return /[?？]/u.test(value)
    || /(?:观众(?:追问|想知道|会问)|到底.{2,}|能否.{2,}|是否.{2,}|会不会.{2,}|为什么.{2,}|为何.{2,}|谁.{2,}(?:会|能|要|还)|什么.{2,}(?:会|能|要|还)|多少.{2,})/u.test(value);
}

export function parseEpisodeScriptOutput(
  raw: string,
  expectedEpisode?: number,
  targetDurationSeconds?: number,
): EpisodeScript {
  const candidates = extractJsonCandidates(raw);
  let script: EpisodeScript | undefined;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(repairLooseJson(stripTrailingCommas(candidate)));
      const unwrapped = unwrapEpisodeScript(parsed);
      script = EpisodeScriptSchema.parse(normalizeEpisodeScriptJson(unwrapped));
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!script) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "no JSON object found");
    throw new Error(`Episode script JSON parsing failed: ${detail}`);
  }
  const measuredDuration = measureEpisodeScript(script).estimatedDurationSeconds;
  const normalizedScript = script.estimatedDurationSeconds === measuredDuration
    ? script
    : EpisodeScriptSchema.parse({
        ...script,
        estimatedDurationSeconds: measuredDuration,
      });
  const issues = validateEpisodeScript(normalizedScript, expectedEpisode);
  if (issues.length > 0) {
    // A script whose only problems are duration arithmetic can be repaired
    // deterministically: scale shot seconds toward the target (2-45s clamp,
    // hard duration range) instead of burning a repair call. This rescues
    // under/over-length drafts before they reach the model-feedback loop.
    const durationCodes = new Set(["duration-hard-range", "duration-mismatch"]);
    if (targetDurationSeconds && issues.every((issue) => durationCodes.has(issue.code))) {
      const normalizedDuration = normalizeEpisodeShotDurations(normalizedScript, targetDurationSeconds);
      if (normalizedDuration.adjusted) {
        const rechecked = validateEpisodeScript(normalizedDuration.script, expectedEpisode);
        if (rechecked.length === 0) {
          return normalizedDuration.script;
        }
      }
    }
    throw new Error(`Episode script validation failed: ${issues.map((issue) => issue.message).join("; ")}`);
  }
  return normalizedScript;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const marker = raw.match(/===\s*EPISODE_SCRIPT_JSON\s*===\s*([\s\S]*?)(?====\s*[A-Z_]+\s*===|$)/i)?.[1]?.trim();
  const markerPosition = raw.match(/===\s*EPISODE_SCRIPT_JSON\b[^\n]*\n?/i);
  const markerTail = markerPosition
    ? extractBalancedJsonObject(raw.slice((markerPosition.index ?? 0) + markerPosition[0].length))
    : undefined;
  const embedded = raw.match(/<!--\s*inkos-episode-script-json\s*([\s\S]*?)-->/i)?.[1]?.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  // A malformed string quote can confuse the balanced scanner before the
  // local loose-JSON repair gets a chance to normalize it. Keep a greedy
  // outer-object candidate as a bounded fallback; schema validation still
  // rejects anything that is not a complete EpisodeScript.
  const greedy = extractGreedyJsonObject(raw);
  // Writers occasionally emit the PRE_WRITE_CHECK block first and then a bare
  // JSON object without a second marker. When the response leads with a
  // `=== ... ===` section, drop everything up to the first `{` so the object
  // that follows the prose can still be extracted instead of falling through
  // to raw.trim() (which failed with "Unexpected token '=' ...").
  const markerStripped = stripMarkedPreamble(raw);
  const strippedCandidates = markerStripped
    ? [markerStripped, ...extractBalancedJsonObjects(markerStripped)]
    : [];
  for (const value of [
    markerTail,
    marker,
    embedded,
    fenced,
    greedy,
    ...extractBalancedJsonObjects(raw),
    ...strippedCandidates,
    raw.trim(),
  ]) {
    if (value && !candidates.includes(value)) candidates.push(value);
  }
  return candidates;
}

function stripMarkedPreamble(raw: string): string | undefined {
  // The PRE_WRITE_CHECK block does not always lead the response: writers can
  // emit prose first and then a `=== ... ===` section before the JSON object.
  // Drop everything up to the first `{` that follows a marked block, instead of
  // only handling a response that starts with `===`.
  const markerMatch = raw.match(/===\s*[A-Z_]+[^\n]*\n?/u);
  const sliceStart = markerMatch ? (markerMatch.index ?? 0) + markerMatch[0].length : 0;
  const firstBrace = raw.indexOf("{", sliceStart);
  if (firstBrace < 0) return undefined;
  return raw.slice(firstBrace).trim();
}

function stripTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1").replace(/^\uFEFF/u, "").trim();
}

/**
 * DeepSeek occasionally emits Chinese quotation marks as bare `"` inside a
 * JSON string (for example `"声音中的"姐姐"声"`).  This is unambiguous in
 * the EpisodeScript contract: a quote followed by a JSON delimiter closes the
 * field; any other quote is part of the field text and can be escaped locally.
 */
function repairLooseJson(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      let next = index + 1;
      while (next < value.length && /\s/u.test(value[next]!)) next += 1;
      const nextChar = value[next];
      if (next >= value.length || nextChar === "," || nextChar === "}" || nextChar === "]" || nextChar === ":") {
        output += char;
        inString = false;
      } else {
        output += '\\"';
      }
      continue;
    }
    output += char;
  }
  return output;
}

function unwrapEpisodeScript(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.episodeScript && typeof record.episodeScript === "object") return record.episodeScript;
  if (record.script && typeof record.script === "object") return record.script;
  return value;
}

const NUMERIC_KEYS = new Set([
  "episode",
  "estimatedDurationSeconds",
  "durationSeconds",
]);
const NULLABLE_OPTIONAL_KEYS = new Set([
  "delivery",
  "action",
  "narration",
  "sound",
  "transition",
  "seriesResolution",
]);

function normalizeEpisodeScriptJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeEpisodeScriptJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(record)) {
    if (rawValue === null && NULLABLE_OPTIONAL_KEYS.has(key)) continue;
    if (NUMERIC_KEYS.has(key) && typeof rawValue === "string" && rawValue.trim() !== "") {
      const numeric = Number(rawValue);
      normalized[key] = Number.isFinite(numeric) ? numeric : rawValue;
      continue;
    }
    normalized[key] = normalizeEpisodeScriptJson(rawValue);
  }
  return normalized;
}

function extractBalancedJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}

function extractBalancedJsonObjects(value: string): string[] {
  const objects: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "{") continue;
    const candidate = extractBalancedJsonObject(value.slice(index));
    if (candidate) objects.push(candidate);
  }
  return objects;
}

function extractGreedyJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return value.slice(start, end + 1);
}

export function renderEpisodeScriptMarkdown(script: EpisodeScript): string {
  const lines: string[] = [
    `# 第${script.episode}集 ${script.title}`,
    "",
    `- 预计时长：${script.estimatedDurationSeconds} 秒`,
    `- 开场钩子：${script.openingHook}`,
    `- 本集反转：${script.reversal}`,
    `- 情绪钩子：${script.emotionalHook}`,
    `- 结尾状态：${script.endState}`,
    `- 当集兑现：${script.contract.localDramaticResult.stateChange}`,
    `- 出去压力：${script.contract.outgoingPressure.startedDecisionDangerOrQuestion}`,
    "",
  ];
  if (script.seriesResolution) {
    lines.push(
      "## 全剧结算",
      `- 主线冲突：${script.seriesResolution.mainConflict}`,
      `- 主角欲望：${script.seriesResolution.protagonistDesire}`,
      ...script.seriesResolution.characterArcs.map((arc) => `- 角色弧线｜${arc.character}：${arc.outcome}`),
      ...script.seriesResolution.relationships.map((relationship) => `- 核心关系｜${relationship.parties}：${relationship.outcome}`),
      "",
    );
  }

  for (const [sceneIndex, scene] of script.scenes.entries()) {
    lines.push(`## 场景 ${sceneIndex + 1}｜${scene.location}｜${scene.time}`);
    lines.push(`场景目的：${scene.purpose}`, "");
    for (const shot of scene.shots) {
      lines.push(`### ${shot.id}｜${shot.shotSize}｜${shot.durationSeconds}秒`);
      lines.push(`镜头：${shot.camera}`);
      lines.push(`画面：${shot.visual}`);
      if (shot.action) lines.push(`动作：${shot.action}`);
      if (shot.narration) lines.push(`旁白：${shot.narration}`);
      for (const line of shot.dialogue) {
        const delivery = line.delivery ? `（${line.delivery}）` : "";
        lines.push(`${line.speaker}${delivery}：${line.text}`);
      }
      if (shot.sound) lines.push(`音效：${shot.sound}`);
      if (shot.transition) lines.push(`转场：${shot.transition}`);
      lines.push("");
    }
  }

  return [
    lines.join("\n").trimEnd(),
    "",
    "<!-- inkos-episode-script-json",
    JSON.stringify(script),
    "-->",
    "",
  ].join("\n");
}
