import { describe, expect, it } from "vitest";
import { assertEpisodeBookConfig, UnsupportedLegacyFormatError } from "../models/book.js";

const base = {
  id: "series",
  title: "Series",
  platform: "other" as const,
  genre: "drama",
  status: "active" as const,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
  targetChapters: 100,
  chapterWordCount: 3000,
};

describe("episode-only book format", () => {
  it("accepts the episode v2 schema", () => {
    expect(assertEpisodeBookConfig({
      ...base,
      schemaVersion: "inkos-episode-v2",
      format: "screenplay",
      targetEpisodes: 100,
      episodeDurationSeconds: 90,
    })).toMatchObject({ schemaVersion: "inkos-episode-v2", targetEpisodes: 100 });
  });

  it("rejects legacy chapter projects explicitly", () => {
    expect(() => assertEpisodeBookConfig(base)).toThrow(UnsupportedLegacyFormatError);
    try {
      assertEpisodeBookConfig(base);
    } catch (error) {
      expect((error as UnsupportedLegacyFormatError).code).toBe("UNSUPPORTED_LEGACY_FORMAT");
    }
  });
});
