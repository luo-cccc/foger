import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExportArtifact, type ExportStateLike } from "../interaction/export-artifact.js";
import { createEpisodeScriptJson } from "./episode-test-fixtures.js";

describe("screenplay export", () => {
  it("exports screenplay markdown, JSON, and dialogue from episode artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-export-"));
    const bookDir = join(root, "books", "demo");
    try {
      const episodesDir = join(bookDir, "episodes");
      await mkdir(episodesDir, { recursive: true });
      await writeFile(join(episodesDir, "0001-opening.md"), "# stale projection", "utf8");
      await writeFile(join(episodesDir, "0001-opening.json"), createEpisodeScriptJson(1, "Opening"), "utf8");
      const state: ExportStateLike = {
        bookDir: () => bookDir,
        loadBookConfig: async () => ({ title: "Demo" }),
        loadEpisodeIndex: async () => [{ episodeNumber: 1, status: "approved", episodeDurationSeconds: 90 }],
      };

      const markdown = await buildExportArtifact(state, "demo", { format: "screenplay-md" });
      const json = await buildExportArtifact(state, "demo", { format: "screenplay-json" });
      const dialogue = await buildExportArtifact(state, "demo", { format: "dialogue" });
      expect(markdown.payload).toContain("Opening");
      expect(markdown.payload).not.toContain("stale projection");
      expect(json.payload).toContain('"episode": 1');
      expect(dialogue.payload).toContain("# Episode 1");
      expect(markdown.totalDurationSeconds).toBe(90);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to export a book that still has an audit-failed episode", async () => {
    const state: ExportStateLike = {
      bookDir: () => "unused",
      loadBookConfig: async () => ({ title: "Demo" }),
      loadEpisodeIndex: async () => [{ episodeNumber: 7, status: "audit-failed", episodeDurationSeconds: 90 }],
    };
    await expect(buildExportArtifact(state, "demo", { format: "screenplay-md" }))
      .rejects.toThrow(/EXPORT_BLOCKED_BY_EPISODE_STATUS/);
  });

  it("fails instead of silently omitting an approved episode with no JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-export-missing-"));
    const bookDir = join(root, "books", "demo");
    try {
      await mkdir(join(bookDir, "episodes"), { recursive: true });
      const state: ExportStateLike = {
        bookDir: () => bookDir,
        loadBookConfig: async () => ({ title: "Demo" }),
        loadEpisodeIndex: async () => [{ episodeNumber: 1, status: "approved", episodeDurationSeconds: 90 }],
      };
      await expect(buildExportArtifact(state, "demo", { format: "screenplay-md" }))
        .rejects.toThrow(/EXPORT_MISSING_AUTHORITATIVE_EPISODE/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
