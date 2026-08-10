import { describe, expect, it } from "vitest";
import { summarizeEpisodeIssues } from "./episode-quality-summary";

describe("summarizeEpisodeIssues", () => {
  it("counts structured severities and treats hard length warnings as critical", () => {
    expect(summarizeEpisodeIssues(
      ["[warning] pacing", "[critical] continuity", "[info] style"],
      ["outside hard range"],
    )).toEqual({
      critical: 2,
      warning: 1,
      info: 1,
      total: 4,
      samples: ["pacing", "continuity"],
    });
  });

  it("keeps legacy untagged issues visible as review warnings", () => {
    expect(summarizeEpisodeIssues(["legacy issue"])).toMatchObject({
      critical: 0,
      warning: 1,
      info: 0,
      total: 1,
      samples: ["legacy issue"],
    });
  });
});
