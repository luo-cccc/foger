import { describe, expect, it } from "vitest";
import { splitEpisodes } from "../utils/episode-splitter.js";

describe("splitEpisodes", () => {
  it("splits English episode headings with the default pattern", () => {
    const input = [
      "Episode 1: Prelude",
      "",
      "The harbor bells rang before dawn.",
      "",
      "Episode 2: Into the Fog",
      "",
      "Mara followed the last lantern into the mist.",
    ].join("\n");

    const episodes = splitEpisodes(input);

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({
      title: "Prelude",
      content: "The harbor bells rang before dawn.",
    });
    expect(episodes[1]).toEqual({
      title: "Into the Fog",
      content: "Mara followed the last lantern into the mist.",
    });
  });

  it("uses an English fallback title when the episode heading has no title text", () => {
    const input = [
      "Episode 1",
      "",
      "The harbor bells rang before dawn.",
    ].join("\n");

    const episodes = splitEpisodes(input);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.title).toBe("Episode 1");
  });

  it("splits Roman numeral English episode headings with the default pattern", () => {
    const input = [
      "EPISODE I.",
      "",
      "The harbor bells rang before dawn.",
      "",
      "EPISODE II.",
      "",
      "Mara followed the last lantern into the mist.",
    ].join("\n");

    const episodes = splitEpisodes(input);

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({
      title: "Episode 1",
      content: "The harbor bells rang before dawn.",
    });
    expect(episodes[1]).toEqual({
      title: "Episode 2",
      content: "Mara followed the last lantern into the mist.",
    });
  });

  it("keeps English fallback titles when a custom regex matches Roman numeral headings", () => {
    const input = [
      "EPISODE I.",
      "",
      "The harbor bells rang before dawn.",
    ].join("\n");

    const episodes = splitEpisodes(input, "^EPISODE\\s+[IVXLCDM]+\\.$");

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.title).toBe("Episode 1");
  });

  it("strips a Project Gutenberg trailer from the final episode content", () => {
    const input = [
      "Episode 1: Finale",
      "",
      "The harbor bells rang once and went silent.",
      "",
      "Project Gutenberg™ depends upon and cannot survive without widespread",
      "public support and donations to carry out its mission.",
    ].join("\n");

    const episodes = splitEpisodes(input);

    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.content).toBe("The harbor bells rang once and went silent.");
    expect(episodes[0]?.content).not.toContain("Project Gutenberg");
  });
});
