import { describe, expect, it } from "vitest";
import { validateRuntimeState } from "../state/state-validator.js";

describe("validateRuntimeState", () => {
  it("rejects hook rows with non-integer numeric fields", () => {
    const issues = validateRuntimeState({
      manifest: {
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 12,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: {
        episode: 12,
        facts: [],
      },
      hooks: {
        hooks: [
          {
            hookId: "mentor-debt",
            startEpisode: 1,
            type: "relationship",
            status: "open",
            lastAdvancedEpisode: "episode twelve",
            expectedPayoff: "Reveal the debt.",
            notes: "Bad numeric field.",
          },
        ],
      },
      episodeSummaries: {
        rows: [],
      },
    });

    expect(issues.map((issue) => issue.code)).toContain("invalid_hooks_state");
  });

  it("rejects duplicate hook ids", () => {
    const issues = validateRuntimeState({
      manifest: {
        schemaVersion: 2,
        language: "en",
        lastAppliedEpisode: 12,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: {
        episode: 12,
        facts: [],
      },
      hooks: {
        hooks: [
          {
            hookId: "mentor-debt",
            startEpisode: 1,
            type: "relationship",
            status: "open",
            lastAdvancedEpisode: 10,
            expectedPayoff: "Reveal the debt.",
            notes: "",
          },
          {
            hookId: "mentor-debt",
            startEpisode: 4,
            type: "mystery",
            status: "progressing",
            lastAdvancedEpisode: 12,
            expectedPayoff: "Identify the courier.",
            notes: "",
          },
        ],
      },
      episodeSummaries: {
        rows: [],
      },
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_hook_id",
          path: "hooks.mentor-debt",
        }),
      ]),
    );
  });

  it("accepts stale open hooks as valid runtime state", () => {
    const issues = validateRuntimeState({
      manifest: {
        schemaVersion: 2,
        language: "zh",
        lastAppliedEpisode: 30,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: {
        episode: 30,
        facts: [],
      },
      hooks: {
        hooks: [
          {
            hookId: "mentor-oath",
            startEpisode: 2,
            type: "relationship",
            status: "open",
            lastAdvancedEpisode: 8,
            expectedPayoff: "揭开师债真相",
            notes: "已经很多章没推进，但仍然有效。",
          },
        ],
      },
      episodeSummaries: {
        rows: [],
      },
    });

    expect(issues).toEqual([]);
  });

  it("rejects runtime truth that trails its committed manifest episode", () => {
    const issues = validateRuntimeState({
      manifest: {
        schemaVersion: 2,
        language: "zh",
        lastAppliedEpisode: 2,
        projectionVersion: 1,
        migrationWarnings: [],
      },
      currentState: {
        episode: 1,
        facts: [],
      },
      hooks: { hooks: [] },
      episodeSummaries: {
        rows: [{
          episode: 1,
          title: "第一章",
          characters: "林丙",
          events: "发现广播",
          stateChanges: "开始调查",
          hookActivity: "H001 advanced",
          mood: "紧张",
          episodeType: "主线",
        }],
      },
    });

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "current_state_behind_manifest",
      "invalid_episode_summaries_state",
    ]));
  });
});
