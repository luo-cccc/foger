import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExportArtifact, type ExportStateLike } from "../interaction/export-artifact.js";

describe("screenplay export", () => {
  it("exports screenplay markdown, JSON, and dialogue from episode artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-export-"));
    const bookDir = join(root, "books", "demo");
    try {
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await writeFile(join(episodesDir, "0001-opening.md"), "# Episode 1\n\nA close-up.", "utf8");
      await writeFile(join(episodesDir, "0001-opening.json"), JSON.stringify({
        episode: 1,
        scenes: [{ shots: [{ dialogue: [{ speaker: "主角", text: "我来了。" }] }] }],
      }), "utf8");
      const state: ExportStateLike = {
        bookDir: () => bookDir,
        loadBookConfig: async () => ({ title: "Demo" }),
        loadEpisodeIndex: async () => [{ episodeNumber: 1, status: "approved", episodeDurationSeconds: 90 }],
      };

      const markdown = await buildExportArtifact(state, "demo", { format: "screenplay-md" });
      const json = await buildExportArtifact(state, "demo", { format: "screenplay-json" });
      const dialogue = await buildExportArtifact(state, "demo", { format: "dialogue" });
      expect(markdown.payload).toContain("Episode 1");
      expect(json.payload).toContain('"episode": 1');
      expect(dialogue.payload).toContain("主角：我来了。");
      expect(markdown.totalDurationSeconds).toBe(90);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
