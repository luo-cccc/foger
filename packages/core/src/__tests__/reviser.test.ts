import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviserAgent } from "../agents/reviser.js";
import type { AuditIssue } from "../agents/continuity.js";
import { renderEpisodeScriptMarkdown } from "../models/episode-script.js";
import { loadEpisodeContextSnapshot } from "../pipeline/episode-context.js";
import {
  createEpisodeContextSnapshot,
  createEpisodeScript,
  createEpisodeScriptMarkdown,
} from "./episode-test-fixtures.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const CRITICAL_ISSUE: AuditIssue = {
  severity: "critical",
  category: "continuity",
  description: "Fix the broken continuity",
  suggestion: "Repair the contradiction",
  repairScope: "structural",
};

function makeAgent(projectRoot: string): ReviserAgent {
  return new ReviserAgent({
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
    projectRoot,
  });
}

function revisedResponse(episode = 1, title = "Revised Archive Pressure"): string {
  return [
    "=== FIXED_ISSUES ===",
    "- repaired continuity",
    "",
    "=== REVISED_CONTENT ===",
    JSON.stringify(createEpisodeScript(episode, title)),
  ].join("\n");
}

describe("ReviserAgent EpisodeScript contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires the operation EpisodeContextSnapshot", async () => {
    const agent = makeAgent("/tmp/inkos-reviser-snapshot-test");
    await expect(agent.reviseEpisode(
      "/tmp/book",
      createEpisodeScriptMarkdown(1),
      1,
      [CRITICAL_ISSUE],
      "rewrite",
      "other",
    )).rejects.toThrow("EPISODE_CONTEXT_REQUIRED");
  });

  it("accepts only a complete EpisodeScript rewrite and projects it to Markdown", async () => {
    const agent = makeAgent("/tmp/inkos-reviser-script-test");
    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: revisedResponse(),
      usage: ZERO_USAGE,
    });

    const result = await agent.reviseEpisode(
      "/tmp/book",
      createEpisodeScriptMarkdown(1),
      1,
      [CRITICAL_ISSUE],
      "rewrite",
      "other",
      { episodeContextSnapshot: createEpisodeContextSnapshot(1) },
    );

    expect(result.changeKind).toBe("rewrite");
    expect(result.fixedIssues).toEqual(["- repaired continuity"]);
    expect(result.revisedContent).toBe(
      renderEpisodeScriptMarkdown(createEpisodeScript(1, "Revised Archive Pressure")),
    );
  });

  it("rejects free text and preserves the authoritative EpisodeScript", async () => {
    const agent = makeAgent("/tmp/inkos-reviser-free-text-test");
    vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: [
        "=== FIXED_ISSUES ===",
        "- claimed repair",
        "",
        "=== REVISED_CONTENT ===",
        "A prose paragraph is not an EpisodeScript.",
      ].join("\n"),
      usage: ZERO_USAGE,
    });
    const original = createEpisodeScriptMarkdown(1);

    const result = await agent.reviseEpisode(
      "/tmp/book",
      original,
      1,
      [CRITICAL_ISSUE],
      "auto",
      "other",
      { episodeContextSnapshot: createEpisodeContextSnapshot(1) },
    );

    expect(result.revisedContent).toBe(original);
    expect(result.fixedIssues).toEqual([]);
    expect(result.changeKind).toBeUndefined();
  });

  it("organizes revision as one pass per failure type (zh + en prompt discipline)", async () => {
    const agent = makeAgent("/tmp/inkos-reviser-pass-discipline-test");
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: revisedResponse(),
      usage: ZERO_USAGE,
    });

    await agent.reviseEpisode(
      "/tmp/book",
      createEpisodeScriptMarkdown(1),
      1,
      [CRITICAL_ISSUE],
      "rewrite",
      "other",
      { episodeContextSnapshot: createEpisodeContextSnapshot(1) },
    );

    const zhPrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>)[0]?.content ?? "";
    // P1-3 (script-craft §9): one pass solves one failure type, ordered, declared
    expect(zhPrompt).toContain("一遍只解决一种失败");
    expect(zhPrompt).toContain("因果→场景运动→可表演性→对白→生产事实→交接");
    expect(zhPrompt).toContain("局部修订逐字保留无关镜头");
  });

  it("uses the book language override while returning EpisodeScript JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-reviser-lang-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "english-book",
      title: "English Book",
      genre: "other",
      platform: "royalroad",
      episodeDurationSeconds: 90,
      schemaVersion: "inkos-episode-v2",
      format: "screenplay",
      targetEpisodes: 60,
      status: "active",
      language: "en",
      createdAt: "2026-03-23T00:00:00.000Z",
      updatedAt: "2026-03-23T00:00:00.000Z",
    }, null, 2), "utf8");
    await writeFile(join(storyDir, "current_state.md"), "# Current State", "utf8");

    const agent = makeAgent(root);
    const chatSpy = vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValue({
      content: revisedResponse(),
      usage: ZERO_USAGE,
    });

    try {
      const snapshot = await loadEpisodeContextSnapshot({
        bookDir,
        episode: 1,
        model: "test-model",
        service: "test",
      });
      await agent.reviseEpisode(
        bookDir,
        createEpisodeScriptMarkdown(1),
        1,
        [CRITICAL_ISSUE],
        "rewrite",
        "other",
        { episodeContextSnapshot: snapshot },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      expect(messages[0]?.content).toContain("MUST be in English");
      expect(messages[0]?.content).toContain("EpisodeScript");
      expect(messages[0]?.content).toContain("One pass solves one failure type");
      expect(messages[0]?.content).toContain("Localized repair preserves unrelated shots verbatim");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
