import { deriveBookIdFromTitle, normalizePlatformOrOther, type Platform } from "@actalk/inkos-core";
export { waitForStudioBookReady } from "../lib/book-ready.js";
export type { StudioBookDetail, WaitForStudioBookReadyOptions } from "../lib/book-ready.js";

export interface StudioCreateBookBody {
  readonly title: string;
  readonly genre: string;
  readonly language?: string;
  readonly platform?: string;
  readonly targetEpisodes?: number;
  readonly episodeDurationSeconds?: number;
  readonly blurb?: string;
}

export interface StudioBookConfigDraft {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  readonly genre: string;
  readonly status: "outlining";
  readonly schemaVersion: "inkos-episode-v2";
  readonly format: "screenplay";
  readonly targetEpisodes: number;
  readonly episodeDurationSeconds: number;
  readonly language?: "zh" | "en";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function normalizeStudioPlatform(platform?: string): Platform {
  return normalizePlatformOrOther(platform);
}

export function buildStudioBookConfig(body: StudioCreateBookBody, now: string): StudioBookConfigDraft {
  const targetEpisodes = body.targetEpisodes ?? 100;
  return {
    id: deriveBookIdFromTitle(body.title) || `book-${Date.now().toString(36)}`,
    title: body.title,
    platform: normalizeStudioPlatform(body.platform),
    genre: body.genre,
    status: "outlining",
    schemaVersion: "inkos-episode-v2",
    format: "screenplay",
    targetEpisodes,
    episodeDurationSeconds: body.episodeDurationSeconds ?? 90,
    ...(body.language === "en"
      ? { language: "en" as const }
      : body.language === "zh"
        ? { language: "zh" as const }
        : {}),
    createdAt: now,
    updatedAt: now,
  };
}
