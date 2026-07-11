import { describe, expect, it, vi, afterEach } from "vitest";
import { buildSpinoffFoundationContext } from "../pipeline/runner.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { ArchitectAgent } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { CanonExtractor } from "../agents/canon-extractor.js";
import type { ExtractedCanon } from "../agents/canon-extractor.js";
import type { ArchitectOutput } from "../agents/architect.js";
import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";
import { emptyWorldSystem } from "../models/canon.js";

const TEST_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
} as unknown as LLMClient;

const PARENT_CANON = "## 角色\n林深：记忆债诊所的医生。\n## 世界\n触碰濒死者能读到其记忆。";

describe("buildSpinoffFoundationContext (番外 framing)", () => {
  it("frames the work as an independent side-story that must not advance the parent main line", () => {
    const ctx = buildSpinoffFoundationContext(PARENT_CANON, "讲林深学生时代的一段往事", "zh");
    expect(ctx).toContain("这是一部番外");
    expect(ctx).toContain("独立");
    expect(ctx).toContain("不要推进或违背正传的主线剧情");
  });

  it("embeds the parent canon so the architect reuses its cast and world", () => {
    const ctx = buildSpinoffFoundationContext(PARENT_CANON, undefined, "zh");
    expect(ctx).toContain("正传正典");
    expect(ctx).toContain("林深");
    expect(ctx).toContain("触碰濒死者能读到其记忆");
  });

  it("includes the user's side-story direction when provided, omits the section when blank", () => {
    const withDir = buildSpinoffFoundationContext(PARENT_CANON, "番外聚焦配角的视角", "zh");
    expect(withDir).toContain("番外方向");
    expect(withDir).toContain("番外聚焦配角的视角");

    const noDir = buildSpinoffFoundationContext(PARENT_CANON, "   ", "zh");
    expect(noDir).not.toContain("番外方向");
  });

  it("produces an English framing for en books", () => {
    const ctx = buildSpinoffFoundationContext(PARENT_CANON, "A what-if where the clinic never opened", "en");
    expect(ctx).toContain("This is a SIDE-STORY");
    expect(ctx).toContain("does NOT advance or contradict the parent work's main storyline");
    expect(ctx).toContain("Side-story direction");
    expect(ctx).toContain("Parent canon");
  });
});

describe("initSpinoffBook extracts structured canon", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const spinoffBook = (): BookConfig => ({
    id: "spinoff-1", title: "番外", platform: "qidian", genre: "xuanhuan",
    status: "active", targetChapters: 30, chapterWordCount: 3000, language: "zh",
    createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z",
  });

  it("writes story/canon for the side-story so its claim gates have canon to work against", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { StateManager } = await import("../state/manager.js");

    const root = await mkdtemp(join(tmpdir(), "inkos-spinoff-canon-"));

    try {
      // importCanon depends on a parent book + LLM; mock it out to isolate the
      // canon-extraction wiring we are verifying.
      vi.spyOn(PipelineRunner.prototype, "importCanon").mockResolvedValue(PARENT_CANON);
      vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
        storyBible: "(shim)", volumeOutline: "(shim)",
        bookRules: "---\nversion: \"1.0\"\n---\n",
        currentState: "", pendingHooks: "| hook_id |",
        storyFrame: "## 主题\n番外世界观", volumeMap: "## 段 1\n番外卷一",
        roles: [{ tier: "major", name: "林深", content: "番外主角" }],
      } as ArchitectOutput);
      vi.spyOn(FoundationReviewerAgent.prototype, "review").mockResolvedValue({
        passed: true, totalScore: 90, dimensions: [], overallFeedback: "ok",
      } as unknown as Awaited<ReturnType<FoundationReviewerAgent["review"]>>);

      const spinoffCanon: ExtractedCanon = {
        claims: [{
          id: "SPIN-1", domain: "world", claimType: "objective_rule",
          content: "番外世界铁律", scope: { appliesTo: [] },
          authority: { source: "story_frame", priority: "hard" },
          visibility: { characterKnownBy: [], hiddenFrom: [] },
          constraints: { requiresCost: [], forbiddenUses: [] },
        }],
        worldSystem: emptyWorldSystem(),
        protagonistSystem: null,
        systemRelations: null,
        warnings: [],
        usedFallback: false,
      };
      const extractSpy = vi.spyOn(CanonExtractor.prototype, "extract").mockResolvedValue(spinoffCanon);

      const state = new StateManager(root);
      const runner = new PipelineRunner({
        state, projectRoot: root, client: TEST_CLIENT, model: "test-model",
      } as unknown as ConstructorParameters<typeof PipelineRunner>[0]);

      await runner.initSpinoffBook(spinoffBook(), "parent-book", "讲林深学生时代");

      expect(extractSpy).toHaveBeenCalledTimes(1);
      const bookDir = state.bookDir("spinoff-1");
      const claims = JSON.parse(await readFile(join(bookDir, "story", "canon", "claims.json"), "utf-8"));
      expect(claims.claims.map((c: { id: string }) => c.id)).toEqual(["SPIN-1"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fail spinoff creation when canon extraction throws (non-fatal degradation)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { StateManager } = await import("../state/manager.js");

    const root = await mkdtemp(join(tmpdir(), "inkos-spinoff-canon-fail-"));

    try {
      vi.spyOn(PipelineRunner.prototype, "importCanon").mockResolvedValue(PARENT_CANON);
      vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
        storyBible: "(shim)", volumeOutline: "(shim)",
        bookRules: "---\nversion: \"1.0\"\n---\n",
        currentState: "", pendingHooks: "| hook_id |",
        storyFrame: "## 主题\n番外", volumeMap: "## 段 1\n卷一",
        roles: [{ tier: "major", name: "林深", content: "主角" }],
      } as ArchitectOutput);
      vi.spyOn(FoundationReviewerAgent.prototype, "review").mockResolvedValue({
        passed: true, totalScore: 90, dimensions: [], overallFeedback: "ok",
      } as unknown as Awaited<ReturnType<FoundationReviewerAgent["review"]>>);
      vi.spyOn(CanonExtractor.prototype, "extract").mockRejectedValue(new Error("boom"));

      const state = new StateManager(root);
      const runner = new PipelineRunner({
        state, projectRoot: root, client: TEST_CLIENT, model: "test-model",
      } as unknown as ConstructorParameters<typeof PipelineRunner>[0]);

      await expect(runner.initSpinoffBook(spinoffBook(), "parent-book", "讲林深学生时代")).resolves.not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
