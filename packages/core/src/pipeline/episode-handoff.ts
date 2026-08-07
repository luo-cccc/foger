import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { EpisodeScript } from "../models/episode-script.js";

export const EpisodeHandoffCapsuleSchema = z.object({
  authority: z.literal("derived"),
  episode: z.number().int().min(1),
  scriptHash: z.string().regex(/^[a-f0-9]{64}$/u),
  tailShotId: z.string().min(1),
  changedState: z.object({
    knowledge: z.array(z.string()),
    power: z.array(z.string()),
    relationship: z.array(z.string()),
    physical: z.array(z.string()),
    activeAction: z.array(z.string()),
  }),
  setupDebt: z.array(z.string()),
  informationPermissions: z.array(z.object({
    subject: z.string(),
    audience: z.string(),
    known: z.array(z.string()),
    suspected: z.array(z.string()),
    mistaken: z.array(z.string()),
    unknown: z.array(z.string()),
  })),
  nextPressure: z.string(),
  unresolved: z.array(z.string()),
});

export interface EpisodeHandoffCapsule {
  readonly authority: "derived";
  readonly episode: number;
  readonly scriptHash: string;
  readonly tailShotId: string;
  readonly changedState: EpisodeScript["contract"]["handoffState"];
  readonly setupDebt: ReadonlyArray<string>;
  readonly informationPermissions: EpisodeScript["contract"]["informationPermissions"];
  readonly nextPressure: string;
  readonly unresolved: ReadonlyArray<string>;
}

export function buildEpisodeHandoffCapsule(script: EpisodeScript, sourceContent: string): EpisodeHandoffCapsule {
  const lastScene = script.scenes.at(-1);
  const lastShot = lastScene?.shots.at(-1);
  if (!lastShot) throw new Error(`Episode ${script.episode} has no tail shot for handoff capsule`);
  return {
    authority: "derived",
    episode: script.episode,
    scriptHash: createHash("sha256").update(sourceContent, "utf8").digest("hex"),
    tailShotId: lastShot.id,
    changedState: script.contract.handoffState,
    setupDebt: [],
    informationPermissions: script.contract.informationPermissions,
    nextPressure: script.contract.outgoingPressure.startedDecisionDangerOrQuestion,
    unresolved: [script.emotionalHook],
  };
}

export function isEpisodeHandoffCapsuleCurrent(capsule: EpisodeHandoffCapsule, sourceContent: string): boolean {
  return capsule.scriptHash === createHash("sha256").update(sourceContent, "utf8").digest("hex");
}

export async function recoverEpisodeHandoffCapsule(params: {
  readonly bookDir: string;
  readonly script: EpisodeScript;
  readonly sourceContent: string;
}): Promise<EpisodeHandoffCapsule> {
  const runtimeDir = join(params.bookDir, "story", "runtime");
  const capsulePath = join(
    runtimeDir,
    `episode-${String(params.script.episode).padStart(4, "0")}-handoff.json`,
  );
  const existing = await readFile(capsulePath, "utf8")
    .then((raw) => EpisodeHandoffCapsuleSchema.parse(JSON.parse(raw)))
    .catch(() => undefined);
  if (existing && isEpisodeHandoffCapsuleCurrent(existing, params.sourceContent)) return existing;

  await rm(capsulePath, { force: true }).catch(() => undefined);
  const recovered = buildEpisodeHandoffCapsule(params.script, params.sourceContent);
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(capsulePath, `${JSON.stringify(recovered, null, 2)}\n`, "utf8");
  return recovered;
}
