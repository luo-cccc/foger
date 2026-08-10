import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readRoleCards } from "../utils/outline-paths.js";
import { loadClaimsFile } from "./canon-store.js";

export interface SettingsEntityIndex {
  /** Normalized character / organization names that scripts may reference. */
  readonly characterNames: ReadonlySet<string>;
  /**
   * Dialogue speakers already introduced by earlier persisted episodes
   * (episode numbers strictly below `excludeEpisode`). They are established
   * through the story itself, so later references should not re-trigger the
   * invention guardrail; their FIRST appearance is still audited.
   */
  readonly episodeSeenSpeakers?: ReadonlySet<string>;
}

/**
 * Build the authoritative character name index from role cards plus canon
 * claims scoped to characters and organizations. Used by the deterministic
 * reference-integrity gate so a script cannot silently invent characters.
 */
export async function buildSettingsEntityIndex(
  bookDir: string,
  excludeEpisode?: number,
): Promise<SettingsEntityIndex> {
  const names = new Set<string>();
  const roleCards = await readRoleCards(bookDir);
  for (const card of roleCards) {
    const name = card.name.trim();
    if (name) names.add(name);
  }

  const claimsFile = await loadClaimsFile(bookDir);
  for (const claim of claimsFile.claims) {
    if (!["protagonist", "character", "organization"].includes(claim.domain)) continue;
    for (const candidate of [
      ...claim.scope.appliesTo,
      ...claim.visibility.characterKnownBy,
      ...claim.visibility.hiddenFrom,
    ]) {
      const name = candidate.trim();
      if (name.length >= 2) names.add(name);
    }
  }

  const episodeSeenSpeakers = new Set<string>();
  const episodesDir = join(bookDir, "episodes");
  const files = await readdir(episodesDir).catch(() => [] as string[]);
  for (const file of files) {
    const match = file.match(/^(\d{4})_.*\.json$/u);
    if (!match) continue;
    const episodeNumber = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(episodeNumber)) continue;
    if (excludeEpisode !== undefined && episodeNumber >= excludeEpisode) continue;
    try {
      const parsed = JSON.parse(await readFile(join(episodesDir, file), "utf-8")) as {
        readonly scenes?: ReadonlyArray<{
          readonly shots?: ReadonlyArray<{
            readonly dialogue?: ReadonlyArray<{ readonly speaker?: string }>;
          }>;
        }>;
      };
      for (const scene of parsed.scenes ?? []) {
        for (const shot of scene.shots ?? []) {
          for (const line of shot.dialogue ?? []) {
            const speaker = line.speaker?.trim();
            if (speaker) episodeSeenSpeakers.add(speaker);
          }
        }
      }
    } catch {
      // Skip unreadable/legacy files; the roles/canon index remains authoritative.
    }
  }

  return { characterNames: names, episodeSeenSpeakers };
}
