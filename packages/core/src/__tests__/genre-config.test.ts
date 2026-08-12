import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GENRES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../genres");

/**
 * Genre frontmatter hygiene: the built-in genre files must not re-declare
 * *universal* AI-tell words that the auditor already checks as a single
 * hard-coded list (continuity.ts). When a genre file carries its own
 * fatigueWords, they must be genre-specific; otherwise every genre ends up
 * shipping the identical generic list and the genre distinction is lost.
 */
const ZH_UNIVERSAL_AI_TELLS = ["仿佛", "不禁", "宛如", "竟然", "忽然", "猛地"];
const EN_UNIVERSAL_AI_TELLS = [
  "delve", "tapestry", "testament", "intricate", "pivotal", "vibrant",
  "comprehensive", "nuanced", "embark", "foster", "underscore", "bolstered", "crucial",
];

interface GenreFrontmatter {
  readonly id: string;
  readonly fatigueWords: string[];
  readonly satisfactionTypes: string[];
  readonly auditDimensions: number[];
}

async function loadGenres(): Promise<ReadonlyArray<GenreFrontmatter>> {
  const files = (await readdir(GENRES_DIR)).filter((file) => file.endsWith(".md")).sort();
  const profiles: GenreFrontmatter[] = [];
  for (const file of files) {
    const raw = await readFile(join(GENRES_DIR, file), "utf8");
    const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) continue;
    const body = frontmatter[1]!;
    const pick = (key: string): string | undefined =>
      body.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1];
    profiles.push({
      id: file.replace(/\.md$/, ""),
      fatigueWords: JSON.parse(pick("fatigueWords") ?? "[]") as string[],
      satisfactionTypes: JSON.parse(pick("satisfactionTypes") ?? "[]") as string[],
      auditDimensions: JSON.parse(pick("auditDimensions") ?? "[]") as number[],
    });
  }
  return profiles;
}

describe("genre frontmatter hygiene", () => {
  it("keeps universal Chinese AI-tell words out of genre fatigueWords", async () => {
    const genres = await loadGenres();
    for (const genre of genres) {
      const leaked = genre.fatigueWords.filter((word) => ZH_UNIVERSAL_AI_TELLS.includes(word));
      expect(leaked, `${genre.id} still carries universal AI-tell words ${leaked.join("、")}`).toEqual([]);
    }
  });

  it("keeps universal English AI-tell words out of genre fatigueWords", async () => {
    const genres = await loadGenres();
    for (const genre of genres) {
      const leaked = genre.fatigueWords.filter((word) => EN_UNIVERSAL_AI_TELLS.includes(word));
      expect(leaked, `${genre.id} still carries universal AI-tell words ${leaked.join(", ")}`).toEqual([]);
    }
  });

  it("gives every genre a distinct fatigueWords list (no duplicated generic tables)", async () => {
    const genres = await loadGenres();
    const signatures = genres.map((genre) => JSON.stringify(genre.fatigueWords));
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("keeps genre differentiation in audit dimensions (more than a handful of shared layouts)", async () => {
    const genres = await loadGenres();
    const signatures = new Set(genres.map((genre) => JSON.stringify(genre.auditDimensions)));
    expect(signatures.size).toBeGreaterThanOrEqual(6);
  });

  it("expands every genre satisfaction pool beyond a minimal 6-type rotation", async () => {
    const genres = await loadGenres();
    for (const genre of genres) {
      expect(genre.satisfactionTypes.length, `${genre.id} satisfaction pool is too small to rotate`).toBeGreaterThanOrEqual(8);
    }
  });
});
