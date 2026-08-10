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
};

describe("episode-only book format", () => {
  it("accepts the episode v2 schema", () => {
    expect(assertEpisodeBookConfig({
      ...base,
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 100,
      episodeDurationSeconds: 90,
    })).toMatchObject({ schemaVersion: "inkos-episode-v2" as const, targetEpisodes: 100 });
  });

  it("rejects legacy episode projects explicitly", () => {
    const legacy = { ...base, targetEpisodes: 100, episodeDurationSeconds: 3000 };
    expect(() => assertEpisodeBookConfig(legacy)).toThrow(UnsupportedLegacyFormatError);
    try {
      assertEpisodeBookConfig(legacy);
    } catch (error) {
      expect((error as UnsupportedLegacyFormatError).code).toBe("UNSUPPORTED_LEGACY_FORMAT");
    }
  });
});
