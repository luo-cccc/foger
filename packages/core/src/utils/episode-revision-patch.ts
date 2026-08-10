import { z } from "zod";
import {
  EpisodeScriptSchema,
  EpisodeShotSchema,
  parseEpisodeScriptOutput,
  renderEpisodeScriptMarkdown,
  type EpisodeScript,
} from "../models/episode-script.js";

export const EpisodeRevisionPatchSchema = z.object({
  episode: z.number().int().min(1).optional(),
  replaceShots: z.array(z.object({
    sceneId: z.string().min(1),
    shotId: z.string().min(1),
    shot: EpisodeShotSchema,
  })).default([]),
  updateContract: z.array(z.object({
    path: z.string().min(1),
    value: z.string(),
  })).default([]),
  title: z.string().min(1).optional(),
  openingHook: z.string().min(1).optional(),
  reversal: z.string().min(1).optional(),
  emotionalHook: z.string().min(1).optional(),
  endState: z.string().min(1).optional(),
});

export type EpisodeRevisionPatch = z.infer<typeof EpisodeRevisionPatchSchema>;

const SCALAR_CONTRACT_PATHS = new Set([
  "objective.character", "objective.desiredChange", "objective.whyNow",
  "opposition.actorOrConstraint", "opposition.goal", "opposition.leverage",
  "localDramaticResult.goalOutcome", "localDramaticResult.stateChange", "localDramaticResult.costPaid",
  "outgoingPressure.startedDecisionDangerOrQuestion", "outgoingPressure.whyItFollows",
]);

/**
 * Apply a localized revision patch to the original episode content (markdown
 * or raw EpisodeScript). Returns the rendered markdown only when the patched
 * script passes the full schema; otherwise `applied: false` so the caller can
 * fall back to a full rewrite.
 */
export function applyEpisodeRevisionPatch(
  originalContent: string,
  patch: EpisodeRevisionPatch,
): { readonly content: string; readonly applied: boolean } {
  let script: EpisodeScript;
  try {
    script = parseEpisodeScriptOutput(originalContent);
  } catch {
    return { content: originalContent, applied: false };
  }
  if (patch.episode !== undefined && patch.episode !== script.episode) {
    return { content: originalContent, applied: false };
  }

  let next: EpisodeScript = {
    ...script,
    scenes: script.scenes.map((scene) => ({
      ...scene,
      shots: scene.shots.map((shot) => ({ ...shot })),
    })),
    contract: {
      ...script.contract,
      incomingState: { ...script.contract.incomingState },
      objective: { ...script.contract.objective },
      opposition: { ...script.contract.opposition },
      localDramaticResult: { ...script.contract.localDramaticResult },
      outgoingPressure: { ...script.contract.outgoingPressure },
      handoffState: { ...script.contract.handoffState },
      informationPermissions: script.contract.informationPermissions.map((permission) => ({ ...permission })),
    },
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.openingHook ? { openingHook: patch.openingHook } : {}),
    ...(patch.reversal ? { reversal: patch.reversal } : {}),
    ...(patch.emotionalHook ? { emotionalHook: patch.emotionalHook } : {}),
    ...(patch.endState ? { endState: patch.endState } : {}),
  };

  for (const entry of patch.replaceShots) {
    const scene = next.scenes.find((candidate) => candidate.id === entry.sceneId);
    const shotIndex = scene?.shots.findIndex((candidate) => candidate.id === entry.shotId);
    if (!scene || shotIndex === undefined || shotIndex < 0) {
      return { content: originalContent, applied: false };
    }
    scene.shots[shotIndex] = entry.shot;
  }

  for (const entry of patch.updateContract) {
    const path = entry.path.trim().replace(/^contract\./, "");
    if (!SCALAR_CONTRACT_PATHS.has(path)) {
      return { content: originalContent, applied: false };
    }
    const [group, field] = path.split(".");
    const bucket = next.contract[group as keyof EpisodeScript["contract"]];
    if (!bucket || typeof bucket !== "object" || !(field in bucket)) {
      return { content: originalContent, applied: false };
    }
    (bucket as Record<string, unknown>)[field] = entry.value;
  }

  try {
    const validated = EpisodeScriptSchema.parse(next);
    const reparsed = parseEpisodeScriptOutput(renderEpisodeScriptMarkdown(validated), validated.episode);
    return { content: renderEpisodeScriptMarkdown(reparsed), applied: true };
  } catch {
    return { content: originalContent, applied: false };
  }
}

export function parseEpisodeRevisionPatch(raw: string): EpisodeRevisionPatch | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = EpisodeRevisionPatchSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
