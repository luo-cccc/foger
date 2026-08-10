import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportFoundationSource, PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { PlannerAgent } from "../agents/planner.js";
import { ComposerAgent } from "../agents/composer.js";
import { WriterAgent, type WriteEpisodeOutput } from "../agents/writer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import type { BookConfig } from "../models/book.js";
import {
  attachEpisodeContextArtifacts,
  attachEpisodePlanningMemory,
  type EpisodeContextSnapshot,
} from "../pipeline/episode-context.js";
import { createEpisodeScriptMarkdown } from "./episode-test-fixtures.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function writerOutput(episode: number): WriteEpisodeOutput {
  return {
    episodeNumber: episode,
    title: "Archive Pressure",
    content: createEpisodeScriptMarkdown(episode),
    episodeDurationSeconds: 90,
    preWriteCheck: "ok",
    stateProjection: "projected",
    updatedState: "# Current State",
    updatedLedger: "# Ledger",
    updatedHooks: "# Pending Hooks",
    episodeSummary: "| " + episode + " | Archive Pressure |",
    updatedSubplots: "# Subplots",
    updatedEmotionalArcs: "# Emotional Arcs",
    updatedCharacterMatrix: "# Character Matrix",
    postWriteErrors: [],
    postWriteWarnings: [],
    tokenUsage: ZERO_USAGE,
  };
}

async function createRunnerFixture(): Promise<{
  root: string;
  runner: PipelineRunner;
  state: StateManager;
  bookId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inkos-runner-test-"));
  const state = new StateManager(root);
  const bookId = "test-book";
  const book: BookConfig = {
    id: bookId,
    title: "Test Book",
    platform: "tomato",
    genre: "other",
    status: "active",
    schemaVersion: "inkos-episode-v2",
    format: "screenplay",
    targetEpisodes: 10,
    episodeDurationSeconds: 90,
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
  };
  await state.saveBookConfig(bookId, book);
  await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
  await mkdir(join(state.bookDir(bookId), "episodes"), { recursive: true });

  return {
    root,
    state,
    bookId,
    runner: new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    }),
  };
}

describe("buildImportFoundationSource", () => {
  it("compacts imported EpisodeScript material using Episode-only language", () => {
    const episodes = Array.from({ length: 36 }, (_, index) => ({
      title: "Episode " + (index + 1),
      content: "OPEN-" + (index + 1) + "\n" + "script".repeat(3000) + "\nTAIL-" + (index + 1),
    }));
    const source = buildImportFoundationSource(episodes, "en", {
      maxFullTextChars: 20_000,
      episodeExcerptChars: 1_200,
      titleCatalogChars: 2_000,
    });

    expect(source).toContain("36 episodes");
    expect(source).toContain("OPEN-1");
    expect(source).toContain("TAIL-36");
    expect(source).not.toContain("chapter");
  });
});

describe("PipelineRunner Episode operation context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes one EpisodeContextSnapshot object through the normal Planner, Composer, and Writer path", async () => {
    const { root, runner, bookId } = await createRunnerFixture();
    const snapshots: EpisodeContextSnapshot[] = [];

    vi.spyOn(PlannerAgent.prototype, "planEpisode").mockImplementation(async (input) => {
      snapshots.push(input.episodeContextSnapshot!);
      attachEpisodePlanningMemory(input.episodeContextSnapshot!, {
        summaries: [],
        hooks: [],
        activeHooks: [],
        recyclableHooks: [],
        facts: [],
        volumeSummaries: [],
      });
      return {
        intent: {
          episode: input.episodeNumber,
          goal: "Secure the ledger.",
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
        },
        memo: {
          episode: input.episodeNumber,
          goal: "Secure the ledger.",
          isGoldenOpening: false,
          body: "",
          threadRefs: [],
        },
        intentMarkdown: "# Episode Intent",
        plannerInputs: [],
        runtimePath: join(input.bookDir, "story", "runtime", "episode-0001.intent.md"),
      };
    });
    vi.spyOn(ComposerAgent.prototype, "composeEpisode").mockImplementation(async (input) => {
      snapshots.push(input.episodeContextSnapshot!);
      const contextPackage = { episode: input.episodeNumber, selectedContext: [] };
      const ruleStack = {
        layers: [],
        sections: { hard: [], soft: [], diagnostic: [] },
        overrideEdges: [],
        activeOverrides: [],
      };
      attachEpisodeContextArtifacts(input.episodeContextSnapshot!, contextPackage, ruleStack);
      return {
        contextPackage,
        ruleStack,
        trace: {
          episode: input.episodeNumber,
          plannerInputs: [],
          composerInputs: [],
          selectedSources: [],
          contextNeeds: [],
          usedSkills: [],
          promptPacks: [],
          contextTiers: {
            protectedSources: [],
            semanticSources: [],
            compressibleSources: [],
          },
          tokenBudget: {
            protectedTokens: 0,
            semanticTokens: 0,
            compressibleTokens: 0,
            totalSelectedTokens: 0,
          },
          sourceStats: [],
          notes: [],
        },
        contextPath: "",
        ruleStackPath: "",
        tracePath: "",
      };
    });
    vi.spyOn(WriterAgent.prototype, "writeEpisode").mockImplementation(async (input) => {
      snapshots.push(input.episodeContextSnapshot!);
      return writerOutput(input.episodeNumber);
    });
    vi.spyOn(ContinuityAuditor.prototype, "auditEpisode").mockImplementation(
      async (_bookDir, _content, _episode, _genre, options) => {
        snapshots.push(options!.episodeContextSnapshot!);
        return {
          passed: true,
          issues: [],
          summary: "ok",
          overallScore: 95,
          tokenUsage: ZERO_USAGE,
        };
      },
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      warnings: [],
      passed: true,
    });

    try {
      await runner.writeNextEpisode(bookId);
      expect(snapshots).toHaveLength(3);
      expect(snapshots.every((snapshot) => snapshot === snapshots[0])).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never constructs an Analyzer or free-text fallback during Episode writing", () => {
    const source = PipelineRunner.prototype.writeNextEpisode.toString();
    expect(source).not.toContain("EpisodeAnalyzer");
    expect(source).not.toContain("freeText");
    expect(source).not.toContain("settlerChat");
  });

  it("records planned and visible volume KR progress through the write pipeline", async () => {
    const { root, runner, state, bookId } = await createRunnerFixture();
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await writeFile(
      join(storyDir, "outline", "volume_map.md"),
      [
        "## Volume 1 Archive Ledger (Episodes 1-10)",
        "Objective: Pin the harbor ledger trail to a named guild.",
        "KR1: Secure the ledger in the archive.",
        "KR2: Reveal the sealed exit to the guild.",
        "Irreversible Event: Mara burns her safe identity at the dock gate.",
      ].join("\n"),
      "utf-8",
    );

    vi.spyOn(PlannerAgent.prototype, "planEpisode").mockImplementation(async (input) => {
      attachEpisodePlanningMemory(input.episodeContextSnapshot!, {
        summaries: [],
        hooks: [],
        activeHooks: [],
        recyclableHooks: [],
        facts: [],
        volumeSummaries: [],
      });
      return {
        intent: {
          episode: input.episodeNumber,
          goal: "Secure the ledger.",
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
        },
        memo: {
          episode: input.episodeNumber,
          goal: "Secure the ledger.",
          isGoldenOpening: false,
          body: "## 本集目标\nSecure the ledger.",
          threadRefs: [],
          volumeKrRefs: ["KR1"],
          volumeKrRationale: "本集推进卷级 KR1。",
        },
        intentMarkdown: "# Episode Intent",
        plannerInputs: [],
        runtimePath: join(input.bookDir, "story", "runtime", "episode-0001.intent.md"),
      };
    });
    vi.spyOn(WriterAgent.prototype, "writeEpisode").mockImplementation(
      async (input) => writerOutput(input.episodeNumber),
    );
    vi.spyOn(ContinuityAuditor.prototype, "auditEpisode").mockImplementation(
      async () => ({
        passed: true,
        issues: [],
        summary: "ok",
        overallScore: 95,
        tokenUsage: ZERO_USAGE,
      }),
    );
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      warnings: [],
      passed: true,
    });

    try {
      await runner.writeNextEpisode(bookId);

      const progressPath = join(storyDir, "runtime", "volume-progress.json");
      const firstProgress = JSON.parse(await readFile(progressPath, "utf-8"));
      const firstEntry = firstProgress.entries[0];
      expect(firstEntry.episode).toBe(1);
      expect(firstEntry.krRefs).toContain("KR1");
      // The post-write volume gate detects the bound KR in the episode text
      // and must record it as visible evidence.
      expect(firstEntry.visibleKrRefs).toContain("V1-KR1");

      // Write a second episode so a durable snapshot exists for episode 1,
      // then rewrite episode 2. Rewriting re-runs compose + post-write for
      // the same episode; re-planning must not wipe visible refs.
      await runner.writeNextEpisode(bookId);
      await runner.rewriteEpisode(bookId, 2);
      const replayedProgress = JSON.parse(await readFile(progressPath, "utf-8"));
      const replayedEntry = replayedProgress.entries.find(
        (entry: { episode: number }) => entry.episode === 2,
      );
      expect(replayedEntry).toBeDefined();
      expect(replayedEntry.krRefs).toContain("KR1");
      expect(replayedEntry.visibleKrRefs).toContain("V1-KR1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
