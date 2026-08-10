import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../state/manager.js";
import { createImportEpisodesTool } from "../agent/agent-tools.js";
import { EpisodeScriptSchema, renderEpisodeScriptMarkdown } from "../models/episode-script.js";

function episodeArtifact(episode: number, title: string): string {
  return renderEpisodeScriptMarkdown(EpisodeScriptSchema.parse({
    episode,
    title,
    estimatedDurationSeconds: 90,
    openingHook: `${title}的可见异常立即发生。`,
    reversal: `既有证据推翻原判断，并让关系主动权发生变化。`,
    emotionalHook: `角色会为这次选择付出什么代价？`,
    endState: `信息、关系与下一行动均发生不可逆变化。`,
    contract: {
      incomingState: { knowledge: [], power: [], relationship: [], physical: [], activeAction: [] },
      objective: { character: "林月", desiredChange: "取得证据", whyNow: "封锁即将开始" },
      opposition: { actorOrConstraint: "守门人", goal: "阻止调查", leverage: "控制出口" },
      causalEscalation: [{
        becauseOf: "前情留下的证据",
        choice: "林月公开核验证据",
        countermove: "守门人封锁出口",
        stateChange: "真相范围缩小",
        nextPressure: "林月必须立刻脱身",
      }],
      localDramaticResult: { goalOutcome: "取得部分证据", stateChange: "调查方向确定", costPaid: "身份暴露" },
      outgoingPressure: { startedDecisionDangerOrQuestion: "守门人开始追捕林月", whyItFollows: "林月已经触发警报" },
      handoffState: { knowledge: ["调查方向确定"], power: ["守门人控制出口"], relationship: ["双方公开敌对"], physical: [], activeAction: ["林月正在脱身"] },
      informationPermissions: [{ subject: "证据", audience: "观众", known: ["林月"], suspected: ["守门人"], mistaken: [], unknown: [] }],
    },
    scenes: [{
      id: "S1",
      location: "码头",
      time: "夜/外景",
      purpose: "完成取证并启动追捕",
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `S1-${index + 1}`,
        shotSize: "近景",
        camera: "固定机位",
        durationSeconds: 15,
        visual: `林月完成第 ${index + 1} 个可见动作。`,
        dialogue: [],
      })),
    }],
  }));
}

function mockPipeline() {
  return {
    importEpisodes: vi.fn(async (input: { bookId: string; episodes: ReadonlyArray<{ title: string; content: string }> }) => ({
      bookId: input.bookId,
      importedCount: input.episodes.length,
      totalDurationSeconds: 180,
      nextEpisode: input.episodes.length + 1,
    })),
  };
}

describe("import_episodes agent tool", () => {
  let root: string;
  let state: StateManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-import-episodes-tool-"));
    state = new StateManager(root);

    await state.saveBookConfig("harbor", {
      id: "harbor",
      title: "Harbor",
      platform: "tomato",
      genre: "other",
      status: "active",
      schemaVersion: "inkos-episode-v2" as const,
      format: "screenplay" as const,
      targetEpisodes: 20,
      episodeDurationSeconds: 90,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("imports a directory of EpisodeScript Markdown/JSON files in filename order", async () => {
    const sourceDir = join(root, "source-dir");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "02_风暴.json"), JSON.stringify(JSON.parse(episodeArtifact(2, "风暴").match(/<!-- inkos-episode-script-json\n(.+)\n-->/s)?.[1] ?? "{}")), "utf-8");
    await writeFile(join(sourceDir, "01_序章.md"), episodeArtifact(1, "序章"), "utf-8");
    await writeFile(join(sourceDir, "notes.pdf"), "ignored", "utf-8");

    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    const result = await tool.execute("tool-import-dir", { sourcePath: sourceDir });

    expect(pipeline.importEpisodes).toHaveBeenCalledTimes(1);
    expect(pipeline.importEpisodes).toHaveBeenCalledWith({
      bookId: "harbor",
      episodes: [
        { title: "序章", content: episodeArtifact(1, "序章") },
        { title: "风暴", content: episodeArtifact(2, "风暴") },
      ],
      resumeFrom: undefined,
      importMode: undefined,
    });
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain('Imported 2 episode(s) into book "harbor"');
      expect(result.content[0].text).toContain("Next episode to write: 3");
    }
    expect(result.details).toMatchObject({
      kind: "episodes_imported",
      bookId: "harbor",
      importedCount: 2,
      totalDurationSeconds: 180,
      nextEpisode: 3,
      importMode: "continuation",
    });
  });

  it("rejects legacy txt imports instead of splitting novel prose", async () => {
    await mkdir(join(root, ".inkos", "uploads", "s1"), { recursive: true });
    await writeFile(
      join(root, ".inkos", "uploads", "s1", "novel.txt"),
      "第一章 开局\n\n他在码头醒来。\n\n第二章 反转\n\n账本不见了。\n",
      "utf-8",
    );

    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    await expect(tool.execute("tool-import-file", { sourcePath: ".inkos/uploads/s1/novel.txt" }))
      .rejects.toThrow(/UNSUPPORTED_EPISODE_IMPORT_FORMAT/);
  });

  it("rejects custom splitting of legacy prose", async () => {
    const sourceFile = join(root, "novel-custom.txt");
    await writeFile(sourceFile, "Part 序幕\n雨夜。\nPart 终局\n天亮。\n", "utf-8");

    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    await expect(tool.execute("tool-import-custom-split", {
      sourcePath: sourceFile,
      splitPattern: "^Part\\s+(.*)$",
    })).rejects.toThrow(/UNSUPPORTED_EPISODE_IMPORT_FORMAT/);
  });

  it("throws when the single file yields no episodes", async () => {
    const sourceFile = join(root, "no-headings.txt");
    await writeFile(sourceFile, "只有正文，没有任何章节标题。", "utf-8");

    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    await expect(tool.execute("tool-import-no-split", { sourcePath: sourceFile }))
      .rejects.toThrow(/UNSUPPORTED_EPISODE_IMPORT_FORMAT/);
    expect(pipeline.importEpisodes).not.toHaveBeenCalled();
  });

  it("throws when the book already has episodes and resumeFrom is missing", async () => {
    await mkdir(join(state.bookDir("harbor"), "episodes"), { recursive: true });
    await writeFile(
      join(state.bookDir("harbor"), "episodes", "0001_旧章.md"),
      "# 第1章 旧章\n\n已有正文。\n",
      "utf-8",
    );
    await state.saveEpisodeIndex("harbor", [{
      episodeNumber: 1,
      title: "旧章",
      status: "imported",
      episodeDurationSeconds: 10,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    const sourceDir = join(root, "source-dir");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "01_新集.md"), episodeArtifact(1, "新集"), "utf-8");

    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    await expect(tool.execute("tool-import-conflict", { sourcePath: sourceDir }))
      .rejects.toThrow(/already has 1 episode\(s\).*resumeFrom/);
    expect(pipeline.importEpisodes).not.toHaveBeenCalled();
  });

  it("passes resumeFrom and importMode through to pipeline.importEpisodes", async () => {
    await mkdir(join(state.bookDir("harbor"), "episodes"), { recursive: true });
    await writeFile(
      join(state.bookDir("harbor"), "episodes", "0001_旧章.md"),
      "# 第1章 旧章\n\n已有正文。\n",
      "utf-8",
    );
    await state.saveEpisodeIndex("harbor", [{
      episodeNumber: 1,
      title: "旧章",
      status: "imported",
      episodeDurationSeconds: 10,
      createdAt: "2026-07-07T00:00:00.000Z",
      updatedAt: "2026-07-07T00:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }]);

    const sourceDir = join(root, "source-dir");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "01_旧集.md"), episodeArtifact(1, "旧集"), "utf-8");
    await writeFile(join(sourceDir, "02_新集.md"), episodeArtifact(2, "新集"), "utf-8");

    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    const result = await tool.execute("tool-import-resume", {
      sourcePath: sourceDir,
      resumeFrom: 2,
      importMode: "series",
    });

    expect(pipeline.importEpisodes).toHaveBeenCalledWith({
      bookId: "harbor",
      episodes: [
        { title: "旧集", content: episodeArtifact(1, "旧集") },
        { title: "新集", content: episodeArtifact(2, "新集") },
      ],
      resumeFrom: 2,
      importMode: "series",
    });
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("Resumed replay from episode 2");
    }
    expect(result.details).toMatchObject({ importMode: "series" });
  });

  it("rejects a bookId that does not match the active book", async () => {
    const pipeline = mockPipeline();
    const tool = createImportEpisodesTool(pipeline as never, "harbor", root);

    await expect(tool.execute("tool-import-wrong-book", {
      bookId: "other-book",
      sourcePath: join(root, "whatever.txt"),
    })).rejects.toThrow(/must match the active book/);
    expect(pipeline.importEpisodes).not.toHaveBeenCalled();
  });
});
