import { describe, expect, it } from "vitest";
import { summarizeChapterIssues } from "./chapter-quality-summary";

describe("summarizeChapterIssues", () => {
  it("counts structured severities and treats hard length warnings as critical", () => {
    expect(summarizeChapterIssues(
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
    expect(summarizeChapterIssues(["legacy issue"])).toMatchObject({
      critical: 0,
      warning: 1,
      info: 0,
      total: 1,
      samples: ["legacy issue"],
    });
  });
});
