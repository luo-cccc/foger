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
  shots: z.array(EpisodeShotSchema).min(1).max(12),
});

export type EpisodeScene = z.infer<typeof EpisodeSceneSchema>;

export const EpisodeStateBucketSchema = z.object({
  knowledge: z.array(z.string().trim().min(1)),
  power: z.array(z.string().trim().min(1)),
  relationship: z.array(z.string().trim().min(1)),
  physical: z.array(z.string().trim().min(1)),
  activeAction: z.array(z.string().trim().min(1)),
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
    | "missing-end-state"
    | "missing-local-payoff"
    | "missing-outgoing-pressure"
    | "unprepared-reversal"
    | "reversal-without-consequence";
  readonly message: string;
}

export const EPISODE_DURATION_TARGET_SECONDS = 90;
export const EPISODE_DURATION_SOFT_MIN_SECONDS = 75;
export const EPISODE_DURATION_SOFT_MAX_SECONDS = 105;
export const EPISODE_DURATION_HARD_MIN_SECONDS = 60;
export const EPISODE_DURATION_HARD_MAX_SECONDS = 120;

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

  const softMin = Math.max(EPISODE_DURATION_HARD_MIN_SECONDS, targetDurationSeconds - 15);
  const softMax = Math.min(EPISODE_DURATION_HARD_MAX_SECONDS, targetDurationSeconds + 15);
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
    issues.push({ code: "scene-count", message: "episode must contain 1-3 scenes" });
  }
  const sceneIds = script.scenes.map((scene) => scene.id);
  if (new Set(sceneIds).size !== sceneIds.length) {
    issues.push({ code: "duplicate-scene-id", message: "episode scene IDs must be unique" });
  }
  const shotIds = script.scenes.flatMap((scene) => scene.shots.map((shot) => shot.id));
  if (new Set(shotIds).size !== shotIds.length) {
    issues.push({ code: "duplicate-shot-id", message: "episode shot IDs must be unique" });
  }
  if (metrics.shotCount < 6 || metrics.shotCount > 12) {
    issues.push({ code: "shot-count", message: "episode must contain 6-12 shots" });
  }
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

export function parseEpisodeScriptOutput(raw: string, expectedEpisode?: number): EpisodeScript {
  const marker = raw.match(/===\s*EPISODE_SCRIPT_JSON\s*===\s*([\s\S]*?)(?====\s*[A-Z_]+\s*===|$)/i)?.[1]?.trim();
  const embedded = raw.match(/<!--\s*inkos-episode-script-json\s*([\s\S]*?)-->/i)?.[1]?.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = marker || embedded || fenced || extractBalancedJsonObject(raw) || raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Episode script JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const script = EpisodeScriptSchema.parse(parsed);
  const measuredDuration = measureEpisodeScript(script).estimatedDurationSeconds;
  const normalizedScript = script.estimatedDurationSeconds === measuredDuration
    ? script
    : EpisodeScriptSchema.parse({
        ...script,
        estimatedDurationSeconds: measuredDuration,
      });
  const issues = validateEpisodeScript(normalizedScript, expectedEpisode);
  if (issues.length > 0) {
    throw new Error(`Episode script validation failed: ${issues.map((issue) => issue.message).join("; ")}`);
  }
  return normalizedScript;
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
