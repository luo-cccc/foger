import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";
import type { PlanEpisodeOutput } from "../agents/planner.js";
import { composeGovernedEpisode } from "../agents/composer.js";
import {
  attachEpisodePlanningMemory,
  buildEpisodeContextSnapshot,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";

describe("composeGovernedEpisode snapshot contract", () => {
  let root: string;
  let bookDir: string;
  let book: BookConfig;
  let plan: PlanEpisodeOutput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-composer-test-"));
    bookDir = join(root, "books", "composer-book");
    await mkdir(join(bookDir, "story", "runtime"), { recursive: true });
    book = {
      id: "composer-book",
      title: "Composer Book",
      platform: "tomato",
      genre: "other",
      status: "active",
      schemaVersion: "inkos-episode-v2",
      format: "screenplay",
      targetEpisodes: 20,
      episodeDurationSeconds: 90,
      createdAt: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-22T00:00:00.000Z",
    };
    plan = {
      intent: {
        episode: 4,
        goal: "Secure the archive ledger.",
        outlineNode: "The alliance splits over the evidence.",
        mustKeep: ["Mara holds the archive key."],
        mustAvoid: ["Do not reveal the mastermind."],
        styleEmphasis: ["visible action"],
      },
      memo: {
        episode: 4,
        goal: "Secure the archive ledger.",
        isGoldenOpening: false,
        body: [
          "## 当前任务",
          "Mara secures the ledger.",
          "",
          "## 当集兑现",
          "Mara gets the ledger but loses the exit.",
          "",
          "## 出去压力",
          "The archive alarm starts.",
          "",
          "## 结尾交接状态",
          "Mara has the ledger; Taryn controls the exit.",
        ].join("\n"),
        threadRefs: ["H01"],
        volumeKrRefs: ["KR1"],
        volumeKrRationale: "The evidence changes control.",
      },
      intentMarkdown: "# Episode Intent\n",
      plannerInputs: ["story/author_intent.md"],
      runtimePath: join(bookDir, "story", "runtime", "episode-0004.intent.md"),
    };
    await writeFile(plan.runtimePath, plan.intentMarkdown, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function snapshot(withMemory = true): EpisodeContextSnapshot {
    const value = buildEpisodeContextSnapshot({
      episode: 4,
      model: "test-model",
      service: "test",
      entries: [
        { source: "story/author_intent.md", content: "Keep pressure on the alliance." },
        { source: "story/current_focus.md", content: "Secure the ledger now." },
        { source: "story/current_state.md", content: "Mara holds the archive key." },
        { source: "story/outline/story_frame.md", content: "The seal cannot be destroyed." },
        { source: "story/outline/volume_map.md", content: "Episode 4 splits control." },
      ],
    });
    if (withMemory) {
      attachEpisodePlanningMemory(value, {
        summaries: [{
          episode: 3,
          title: "The Locked Door",
          characters: "Mara, Taryn",
          events: "Mara reaches the archive.",
          stateChanges: "The exit is threatened.",
          hookActivity: "H01 advanced.",
          episodeType: "pressure",
          mood: "tense",
        }],
        hooks: [{
          hookId: "H01",
          type: "plot",
          status: "open",
          startEpisode: 1,
          lastAdvancedEpisode: 3,
          expectedPayoff: "Identify who altered the seal.",
          notes: "The active archive clue.",
        }],
        activeHooks: [],
        recyclableHooks: [],
        facts: [{
          subject: "Mara",
          predicate: "holds",
          object: "archive key",
          validFromEpisode: 3,
          validUntilEpisode: null,
          sourceEpisode: 3,
        }],
        volumeSummaries: [],
      });
    }
    return value;
  }

  it("requires the operation EpisodeContextSnapshot", async () => {
    await expect(composeGovernedEpisode({
      book,
      bookDir,
      episodeNumber: 4,
      plan,
    })).rejects.toThrow("EPISODE_CONTEXT_REQUIRED");
  });

  it("requires Planner memory selection on the same snapshot", async () => {
    await expect(composeGovernedEpisode({
      book,
      bookDir,
      episodeNumber: 4,
      plan,
      episodeContextSnapshot: snapshot(false),
    })).rejects.toThrow("EPISODE_CONTEXT_INCOMPLETE");
  });

  it("consumes stable context and memory only from the supplied snapshot", async () => {
    const operationSnapshot = snapshot();
    await writeFile(join(bookDir, "story", "current_state.md"), "DISK_CONTENT_MUST_NOT_BE_READ", "utf8");

    const result = await composeGovernedEpisode({
      book,
      bookDir,
      episodeNumber: 4,
      plan,
      episodeContextSnapshot: operationSnapshot,
    });
    const selected = result.contextPackage.selectedContext;
    const text = selected.map((entry) => entry.excerpt).join("\n");

    expect(text).toContain("Mara holds the archive key.");
    expect(text).toContain("The Locked Door");
    expect(text).toContain("Identify who altered the seal.");
    expect(text).not.toContain("DISK_CONTENT_MUST_NOT_BE_READ");
  });

  it("attaches context artifacts to the same snapshot object", async () => {
    const operationSnapshot = snapshot();
    const result = await composeGovernedEpisode({
      book,
      bookDir,
      episodeNumber: 4,
      plan,
      episodeContextSnapshot: operationSnapshot,
    });

    expect(operationSnapshot.contextPackage).toBe(result.contextPackage);
    expect(operationSnapshot.ruleStack).toBe(result.ruleStack);
    expect(operationSnapshot.contextPackage?.episode).toBe(4);
  });

  it("deduplicates repeated semantic source ids before writing the context package", async () => {
    const operationSnapshot = snapshot();
    operationSnapshot.planningMemorySelection = {
      ...operationSnapshot.planningMemorySelection!,
      hooks: [
        ...operationSnapshot.planningMemorySelection!.hooks,
        operationSnapshot.planningMemorySelection!.hooks[0]!,
      ],
    };

    const result = await composeGovernedEpisode({
      book,
      bookDir,
      episodeNumber: 4,
      plan,
      episodeContextSnapshot: operationSnapshot,
    });
    const hookSources = result.contextPackage.selectedContext
      .filter((entry) => entry.source === "story/pending_hooks.md#H01");

    expect(hookSources).toHaveLength(1);
  });
});
