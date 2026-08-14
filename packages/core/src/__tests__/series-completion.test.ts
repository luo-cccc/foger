import { describe, expect, it } from "vitest";
import { evaluateSeriesCompletion } from "../pipeline/series-completion.js";
import type { BookConfig } from "../models/book.js";
import type { EpisodeMeta } from "../models/episode.js";

const book: BookConfig = {
  id: "series",
  title: "Series",
  platform: "other",
  genre: "other",
  status: "active",
  schemaVersion: "inkos-episode-v2",
  format: "screenplay" as const,
  targetEpisodes: 2,
  episodeDurationSeconds: 90,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function episode(episodeNumber: number, status: EpisodeMeta["status"] = "approved"): EpisodeMeta {
  return {
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    status,
    episodeDurationSeconds: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
  };
}

const resolvedFinalScript = {
  episode: 2,
  seriesResolution: {
    mainConflict: "The conspiracy is exposed and dismantled.",
    protagonistDesire: "The protagonist restores the victims' identities.",
    characterArcs: [{ character: "hero", outcome: "accepts public responsibility" }],
    relationships: [{ parties: "hero and ally", outcome: "choose an honest alliance" }],
  },
} as never;

describe("series completion gate", () => {
  it("blocks completion when runtime state is missing", () => {
    const report = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
    });
    expect(report.completed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("missing-final-state");
  });

  it("requires every episode and the final state", () => {
    const report = evaluateSeriesCompletion({
      book,
      episodes: [episode(1)],
      runtimeState: { manifest: { lastAppliedEpisode: 1 }, hooks: { hooks: [] } } as never,
    });
    expect(report.completed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("episode-count");
  });

  it("blocks unresolved core hooks", () => {
    const report = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
      runtimeState: {
        manifest: { lastAppliedEpisode: 2 },
        hooks: { hooks: [{ hookId: "H1", hookKind: "plot", coreHook: true, status: "open", audienceQuestion: "Who did it?" }] },
      } as never,
    });
    expect(report.completed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("open-core-hook");
  });

  it("blocks a final cliffhanger with no state resolution", () => {
    const report = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
      runtimeState: {
        manifest: { lastAppliedEpisode: 2 },
        hooks: { hooks: [] },
        episodeSummaries: {
          rows: [{
            episodeNumber: 2,
            title: "Final",
            characters: "",
            events: "",
            stateChanges: "",
            hookActivity: "",
            mood: "",
            episodeType: "episode",
            endingQuestion: "谁会活下来？",
          }],
        },
      } as never,
    });
    expect(report.completed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("final-cliffhanger");
  });

  it("blocks three consecutive episodes without effective change", () => {
    const report = evaluateSeriesCompletion({
      book: { ...book, targetEpisodes: 3 },
      episodes: [episode(1), episode(2), episode(3)],
      runtimeState: {
        manifest: { lastAppliedEpisode: 3 },
        hooks: { hooks: [] },
        episodeSummaries: {
          rows: [1, 2, 3].map((episode) => ({
            episodeNumber: episode,
            title: `Episode ${episode}`,
            characters: "",
            events: "",
            stateChanges: "",
            hookActivity: "",
            mood: "",
            episodeType: "episode",
          })),
        },
      } as never,
    });
    expect(report.completed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("stagnant-run");
  });

  it("blocks gaps, duplicates, and persisted critical audit issues", () => {
    const criticalEpisode = {
      ...episode(1),
      auditIssues: ["[critical] reversal has no consequence"],
    };
    const report = evaluateSeriesCompletion({
      book: { ...book, targetEpisodes: 3 },
      episodes: [criticalEpisode, episode(1), episode(3)],
      runtimeState: {
        manifest: { lastAppliedEpisode: 3 },
        hooks: { hooks: [] },
        episodeSummaries: { rows: [] },
      } as never,
    });
    expect(report.completed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "duplicate-episode",
      "episode-gap",
      "blocking-episode",
    ]));
  });

  it("requires final summary evidence for event, state, payoff, and relationship resolution", () => {
    const missing = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
      runtimeState: {
        manifest: { lastAppliedEpisode: 2 },
        hooks: { hooks: [] },
        episodeSummaries: { rows: [] },
      } as never,
    });
    expect(missing.issues.map((issue) => issue.code)).toContain("missing-final-summary");

    const incomplete = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
      runtimeState: {
        manifest: { lastAppliedEpisode: 2 },
        hooks: { hooks: [] },
        episodeSummaries: { rows: [{
          episodeNumber: 2,
          title: "Final",
          characters: "hero",
          events: "The final confrontation ends.",
          stateChanges: "The threat is removed.",
          hookActivity: "",
          mood: "resolved",
          episodeType: "episode",
          payoff: "The protagonist wins the promised result.",
        }] },
      } as never,
    });
    expect(incomplete.issues.map((issue) => issue.code)).toContain("incomplete-final-arc");
  });

  it("requires an authoritative finale script with explicit series resolution", () => {
    const runtimeState = {
      manifest: { lastAppliedEpisode: 2 },
      hooks: { hooks: [] },
      episodeSummaries: { rows: [{
        episodeNumber: 2,
        title: "Final",
        characters: "hero, ally",
        events: "The conspiracy is exposed.",
        stateChanges: "The system is dismantled.",
        hookActivity: "all core hooks resolved",
        mood: "resolved",
        episodeType: "episode",
        payoff: "Victims recover their identities.",
        relationshipChange: "The hero and ally choose an honest alliance.",
      }] },
    } as never;
    const missingResolution = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
      runtimeState,
      finalEpisodeScript: { episode: 2 } as never,
    });
    expect(missingResolution.issues.map((issue) => issue.code)).toContain("incomplete-series-resolution");

    const completed = evaluateSeriesCompletion({
      book,
      episodes: [episode(1), episode(2)],
      runtimeState,
      finalEpisodeScript: resolvedFinalScript,
    });
    expect(completed.completed).toBe(true);
  });

  it("requires every episode to be approved or published", () => {
    const runtimeState = {
      manifest: { lastAppliedEpisode: 2 },
      hooks: { hooks: [] },
      episodeSummaries: { rows: [{
        episodeNumber: 2,
        title: "Final",
        characters: "hero, ally",
        events: "The conspiracy is exposed.",
        stateChanges: "The system is dismantled.",
        hookActivity: "all core hooks resolved",
        mood: "resolved",
        episodeType: "episode",
        payoff: "Victims recover their identities.",
        relationshipChange: "The hero and ally choose an honest alliance.",
      }] },
    } as never;

    for (const episodes of [
      [episode(1, "rejected"), episode(2)],
      [episode(1), episode(2, "ready-for-review")],
    ]) {
      const report = evaluateSeriesCompletion({ book, episodes, runtimeState, finalEpisodeScript: resolvedFinalScript });
      expect(report.completed).toBe(false);
      expect(report.issues.map((issue) => issue.code)).toContain("blocking-episode");
    }
  });
});
