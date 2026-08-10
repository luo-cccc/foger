import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createStateCard(params: {
  readonly episode: number;
  readonly location: string;
  readonly protagonistState: string;
  readonly goal: string;
  readonly conflict: string;
}): string {
  return [
    "# Current State",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Current Episode | ${params.episode} |`,
    `| Current Location | ${params.location} |`,
    `| Protagonist State | ${params.protagonistState} |`,
    `| Current Goal | ${params.goal} |`,
    "| Current Constraint | The city gates are watched. |",
    "| Current Alliances | Mentor allies are scattered. |",
    `| Current Conflict | ${params.conflict} |`,
    "",
  ].join("\n");
}

interface FakeStore {
  facts: Array<{
    id: number;
    subject: string;
    predicate: string;
    object: string;
    validFromEpisode: number;
    validUntilEpisode: number | null;
    sourceEpisode: number;
  }>;
  summaries: Array<{
    episode: number;
    title: string;
    characters: string;
    events: string;
    stateChanges: string;
    hookActivity: string;
    mood: string;
    episodeType: string;
  }>;
  hooks: Array<{
    hookId: string;
    startEpisode: number;
    type: string;
    status: string;
    lastAdvancedEpisode: number;
    expectedPayoff: string;
    notes: string;
  }>;
  nextFactId: number;
}

class FakeMemoryDB {
  static stores = new Map<string, FakeStore>();

  private readonly store: FakeStore;

  constructor(private readonly bookDir: string) {
    const existing = FakeMemoryDB.stores.get(bookDir);
    if (existing) {
      this.store = existing;
      return;
    }

    const created: FakeStore = {
      facts: [],
      summaries: [],
      hooks: [],
      nextFactId: 1,
    };
    FakeMemoryDB.stores.set(bookDir, created);
    this.store = created;
  }

  close(): void {}

  getEpisodeCount(): number {
    return this.store.summaries.length;
  }

  getCurrentFacts(): ReadonlyArray<FakeStore["facts"][number]> {
    return this.store.facts;
  }

  replaceCurrentFacts(facts: ReadonlyArray<Omit<FakeStore["facts"][number], "id">>): void {
    this.resetFacts();
    for (const fact of facts) this.addFact(fact);
  }

  getActiveHooks(): ReadonlyArray<FakeStore["hooks"][number]> {
    return this.store.hooks.filter((hook) => hook.status !== "resolved");
  }

  getSummaries(startEpisode: number, endEpisode: number): ReadonlyArray<FakeStore["summaries"][number]> {
    return this.store.summaries.filter((summary) => (
      summary.episode >= startEpisode && summary.episode <= endEpisode
    ));
  }

  replaceSummaries(summaries: FakeStore["summaries"]): void {
    this.store.summaries = summaries.map((summary) => ({ ...summary }));
  }

  replaceHooks(hooks: FakeStore["hooks"]): void {
    this.store.hooks = hooks.map((hook) => ({ ...hook }));
  }

  resetFacts(): void {
    this.store.facts = [];
    this.store.nextFactId = 1;
  }

  addFact(fact: Omit<FakeStore["facts"][number], "id">): number {
    const id = this.store.nextFactId++;
    this.store.facts.push({ id, ...fact });
    return id;
  }

  invalidateFact(id: number, untilEpisode: number): void {
    const index = this.store.facts.findIndex((fact) => fact.id === id);
    if (index >= 0) {
      this.store.facts[index] = {
        ...this.store.facts[index]!,
        validUntilEpisode: untilEpisode,
      };
    }
  }
}

describe("PipelineRunner structured-state memory sync", () => {
  let root = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("../state/memory-db.js");
    FakeMemoryDB.stores.clear();
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("uses structured runtime state for narrative memory during writeNextEpisode even when markdown projections drift after persistence", async () => {
    vi.doMock("../state/memory-db.js", () => ({
      MemoryDB: FakeMemoryDB,
    }));

    const { PipelineRunner } = await import("../pipeline/runner.js");
    const { StateManager } = await import("../state/manager.js");
    const { WriterAgent } = await import("../agents/writer.js");
    const { PlannerAgent } = await import("../agents/planner.js");
    const { ComposerAgent } = await import("../agents/composer.js");
    const { ContinuityAuditor } = await import("../agents/continuity.js");
    const { StateValidatorAgent } = await import("../agents/state-validator.js");
    const {
      attachEpisodeContextArtifacts,
      attachEpisodePlanningMemory,
    } = await import("../pipeline/episode-context.js");

    root = await mkdtemp(join(tmpdir(), "inkos-runner-memory-sync-"));
    const state = new StateManager(root);
    const bookId = "memory-sync-book";
    const now = "2026-03-25T00:00:00.000Z";
    const book: BookConfig = {
      id: bookId,
      title: "Memory Sync Book",
      platform: "tomato",
      genre: "xuanhuan",
      status: "active",
      language: "en",
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 10,
      episodeDurationSeconds: 90,
      createdAt: now,
      updatedAt: now,
    };

    await state.saveBookConfig(bookId, book);
    const bookDir = state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await mkdir(join(bookDir, "episodes"), { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), createStateCard({
        episode: 0,
        location: "Shrine outskirts",
        protagonistState: "Lin Yue begins with the oath token hidden.",
        goal: "Reach the trial city.",
        conflict: "The trial deadline is closing in.",
      }), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), [
        "# Pending Hooks",
        "",
        "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| D001 | 1 | relationship | open | 0 | Reveal why the mentor vanished. | Initial debt hook. |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
    ]);

    const runner = new PipelineRunner({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,

        },
      } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
      model: "test-model",
      projectRoot: root,
      inputGovernanceMode: "legacy",
    });

    const { createEpisodeScript, createEpisodeScriptMarkdown } = await import("./episode-test-fixtures.js");
    const { measureEpisodeScript } = await import("../models/episode-script.js");
    const episodeScript = createEpisodeScript(1);
    const episodeContent = createEpisodeScriptMarkdown(1);
    const originalSaveEpisode = WriterAgent.prototype.saveEpisode;
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
          goal: "Trace the debt.",
          mustKeep: [],
          mustAvoid: [],
          styleEmphasis: [],
        },
        memo: {
          episode: input.episodeNumber,
          goal: "Trace the debt.",
          isGoldenOpening: true,
          body: [
            "## 本集 Hook ledger",
            "open:",
            "- [new] Structured hook should win.",
          ].join("\n"),
          threadRefs: [],
        },
        intentMarkdown: "# Episode Intent",
        plannerInputs: [],
        runtimePath: join(input.bookDir, "story", "runtime", "episode-0001.intent.md"),
      };
    });
    vi.spyOn(ComposerAgent.prototype, "composeEpisode").mockImplementation(async (input) => {
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
    vi.spyOn(WriterAgent.prototype, "writeEpisode").mockResolvedValue({
      episodeNumber: 1,
      title: "Structured Episode",
      content: episodeContent,
      episodeDurationSeconds: 90,
      episodeScript,
      episodeScriptMetrics: measureEpisodeScript(episodeScript, 90),
      preWriteCheck: "check",
      stateProjection: "projected",
      updatedState: "unused legacy state",
      updatedLedger: "unused legacy ledger",
      updatedHooks: "unused legacy hooks",
      episodeSummary: "| 1 | unused summary |",
      updatedSubplots: "",
      updatedEmotionalArcs: "",
      updatedCharacterMatrix: "",
      postWriteErrors: [],
      postWriteWarnings: [],
      tokenUsage: ZERO_USAGE,
      runtimeStateDelta: {
        episode: 1,
        currentStatePatch: {
          currentGoal: "Trace the debt through the watchtower archive.",
          currentConflict: "Guild pressure keeps colliding with the debt trail.",
        },
        hookOps: {
          upsert: [{
            hookId: "D001",
            startEpisode: 1,
            type: "relationship",
            status: "progressing",
            lastAdvancedEpisode: 1,
            expectedPayoff: "Reveal why the mentor vanished.",
            notes: "Structured hook should win.",
          }],
          mention: [],
          resolve: [],
          defer: [],
        },
        newHookCandidates: [],
        episodeSummary: {
          episodeNumber: 1,
          title: "Structured Summary",
          characters: "Lin Yue",
          events: "Lin Yue follows the debt into the watchtower archive.",
          stateChanges: "The debt trail sharpens.",
          hookActivity: "structured-hook advanced",
          mood: "tense",
          episodeType: "investigation",
        },
        subplotOps: [],
        emotionalArcOps: [],
        characterMatrixOps: [],
        notes: [],
      },
    });
    vi.spyOn(ContinuityAuditor.prototype, "auditEpisode").mockResolvedValue({
      passed: true,
      issues: [],
      summary: "clean",
      overallScore: 90,
      tokenUsage: ZERO_USAGE,
    });
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({
      warnings: [],
      passed: true,
    });
    vi.spyOn(WriterAgent.prototype, "saveEpisode").mockImplementation(async function (
      this: InstanceType<typeof WriterAgent>,
      bookDirArg,
      output,
      numericalSystem,
      language,
    ) {
      await originalSaveEpisode.call(this, bookDirArg, output, numericalSystem, language);
      await Promise.all([
        writeFile(
          join(bookDirArg, "story", "pending_hooks.md"),
          [
            "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
            "| --- | --- | --- | --- | --- | --- | --- |",
            "| markdown-drift-hook | 1 | mystery | open | 1 | 5 | Drifted markdown hook |",
            "",
          ].join("\n"),
          "utf-8",
        ),
        writeFile(
          join(bookDirArg, "story", "episode_summaries.md"),
          [
            "| episode | title | characters | events | stateChanges | hookActivity | mood | episodeType |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 1 | Markdown Drift Summary | Lin Yue | Drifted markdown event | Drifted markdown state | markdown-drift-hook advanced | flat | fallback |",
            "",
          ].join("\n"),
          "utf-8",
        ),
      ]);
    });

    const result = await runner.writeNextEpisode(bookId);
    expect(result.status, JSON.stringify(result.auditResult)).toBe("ready-for-review");

    expect(await readFile(join(storyDir, "pending_hooks.md"), "utf-8")).toContain("markdown-drift-hook");
    expect(await readFile(join(storyDir, "episode_summaries.md"), "utf-8")).toContain("Markdown Drift Summary");
    // Markdown projections are deliberately drifted after persistence. The
    // runner must still complete from the structured EpisodeScript path rather
    // than treating those projections as the authoritative narrative state.
    expect([...FakeMemoryDB.stores.values()].every((store) => (
      store.summaries.every((summary) => summary.title !== "Markdown Drift Summary")
      && store.hooks.every((hook) => hook.notes !== "Drifted markdown hook")
    ))).toBe(true);
    // Heavy end-to-end test (full writeNextEpisode pipeline + sqlite memory.db +
    // structured-state projections). The 5s default is too tight for this under
    // parallel-suite CPU contention; give it explicit headroom.
  }, 20000);
});
