import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateToolArguments } from "@mariozechner/pi-ai";
import { createProposeActionTool, createSubAgentTool } from "../agent/agent-tools.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SubAgentParams schema", () => {
  const mockPipeline = {} as any;
  const tool = createSubAgentTool(mockPipeline, null);
  const schema = tool.parameters;
  const props = (schema as any).properties;

  it("has architect params: title, genre, platform, language, targetEpisodes", () => {
    expect(props.title).toBeDefined();
    expect(props.genre).toBeDefined();
    expect(props.platform).toBeDefined();
    expect(props.language).toBeDefined();
    expect(props.targetEpisodes).toBeDefined();
  });

  it("has writer/architect param: episodeDurationSeconds", () => {
    expect(props.episodeDurationSeconds).toBeDefined();
  });

  it("has reviser param: mode", () => {
    expect(props.mode).toBeDefined();
  });

  it("has exporter params: format, approvedOnly", () => {
    expect(props.format).toBeDefined();
    expect(props.approvedOnly).toBeDefined();
  });

  it("has existing params: agent, instruction, bookId, episodeNumber", () => {
    expect(props.agent).toBeDefined();
    expect(props.instruction).toBeDefined();
    expect(props.bookId).toBeDefined();
    expect(props.episodeNumber).toBeDefined();
  });

  it("all new params have description with agent scope", () => {
    expect(props.title.description).toMatch(/architect/i);
    expect(props.genre.description).toMatch(/architect/i);
    expect(props.mode.description).toMatch(/reviser/i);
    expect(props.format.description).toMatch(/exporter/i);
  });

  it("normalizes platform aliases before sub_agent schema validation", () => {
    const prepared = tool.prepareArguments?.({
      agent: "architect",
      instruction: "创建一本番茄都市文",
      title: "雾港账本",
      genre: "urban",
      platform: "番茄小说",
      language: "zh",
    });

    expect(prepared).toMatchObject({ platform: "tomato" });
    expect(() => validateToolArguments(tool as any, {
      name: "sub_agent",
      arguments: prepared,
    } as any)).not.toThrow();

    const blankPlatform = tool.prepareArguments?.({
      agent: "architect",
      instruction: "创建一本都市文",
      title: "空平台测试",
      genre: "urban",
      platform: "",
      language: "zh",
    });

    expect(blankPlatform).not.toHaveProperty("platform");
    expect(() => validateToolArguments(tool as any, {
      name: "sub_agent",
      arguments: blankPlatform,
    } as any)).not.toThrow();
  });
});

describe("propose_action payload", () => {
  it("preserves structured create-book arguments for confirmation", async () => {
    const tool = createProposeActionTool("zh");
    const result = await tool.execute("proposal-1", {
      action: "create_book",
      title: "创建《葬神契》",
      summary: "确认后创建长篇连载。",
      instruction: "创建《葬神契》，东方玄幻，番茄小说。",
      createBook: {
        title: "葬神契",
        genre: "东方玄幻",
        platform: "tomato",
        language: "zh",
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
      },
    });

    expect(result.details).toMatchObject({
      kind: "proposed_action",
      action: "create_book",
      title: "创建《葬神契》",
      summary: "确认后创建长篇连载。",
      actionPayload: {
        createBook: {
          title: "葬神契",
          genre: "东方玄幻",
          platform: "tomato",
          language: "zh",
          targetEpisodes: 100,
          episodeDurationSeconds: 90,
        },
      },
    });
    expect(result.details).not.toHaveProperty("payload");
  });
});

describe("architect agent — BookConfig construction", () => {
  let initBookMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    initBookMock = vi.fn(async () => {});
    const mockPipeline = { initBook: initBookMock } as any;
    tool = createSubAgentTool(mockPipeline, null);
  });

  it("passes complete BookConfig with schema params", async () => {
    await tool.execute("tc1", {
      agent: "architect",
      instruction: "Create a xuanhuan novel",
      title: "天道独行",
      genre: "xuanhuan",
      platform: "tomato",
      language: "zh",
      targetEpisodes: 100,
      episodeDurationSeconds: 90,
    });
    expect(initBookMock).toHaveBeenCalledOnce();
    const [bookConfig, options] = initBookMock.mock.calls[0];
    expect(bookConfig.title).toBe("天道独行");
    expect(bookConfig.genre).toBe("xuanhuan");
    expect(bookConfig.platform).toBe("tomato");
    expect(bookConfig.language).toBe("zh");
    expect(bookConfig.format).toBe("screenplay");
    expect(bookConfig.targetEpisodes).toBe(100);
    expect(bookConfig.episodeDurationSeconds).toBe(90); // explicit param wins over the 150s default
    expect(bookConfig.status).toBe("outlining");
    expect(bookConfig.createdAt).toBeDefined();
    expect(options.externalContext).toBe("Create a xuanhuan novel");
  });

  it("infers language and applies native defaults when optional params are omitted", async () => {
    await tool.execute("tc2", { agent: "architect", instruction: "Create a book", title: "Test Book" });
    const [bookConfig] = initBookMock.mock.calls[0];
    expect(bookConfig.genre).toBe("general");
    expect(bookConfig.platform).toBe("other");
    expect(bookConfig.language).toBe("en"); // inferred from the English instruction
    expect(bookConfig.targetEpisodes).toBe(100);
    expect(bookConfig.episodeDurationSeconds).toBe(150);
  });

  it("infers zh and its native episode length from a Chinese brief", async () => {
    await tool.execute("tc2b", { agent: "architect", instruction: "写一本都市重生爽文", title: "回到二零零八" });
    const [bookConfig] = initBookMock.mock.calls[0];
    expect(bookConfig.language).toBe("zh");
    expect(bookConfig.episodeDurationSeconds).toBe(150);
  });

  it("normalizes unsupported platform names to other during architect creation", async () => {
    await tool.execute("tc3", {
      agent: "architect",
      instruction: "Create a Royal Road fantasy novel",
      title: "Harbor Oath",
      genre: "fantasy",
      platform: "royal-road",
      language: "en",
    } as any);

    const [bookConfig] = initBookMock.mock.calls[0];
    expect(bookConfig.platform).toBe("other");
  });
});

describe("architect agent — foundation revision mutation", () => {
  it("routes foundation revision through the command-owned book lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-agent-foundation-revise-"));
    try {
      const reviseFoundation = vi.fn(async () => undefined);
      const tool = createSubAgentTool({ reviseFoundation } as any, "my-book", root);

      await tool.execute("tc-revise", {
        agent: "architect",
        bookId: "my-book",
        revise: true,
        feedback: "Make the protagonist colder.",
      });

      expect(reviseFoundation).toHaveBeenCalledWith("my-book", "Make the protagonist colder.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writer agent — episodeDurationSeconds passthrough", () => {
  let writeNextEpisodeMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    writeNextEpisodeMock = vi.fn(async () => ({ episodeDurationSeconds: 90 }));
    const mockPipeline = { writeNextEpisode: writeNextEpisodeMock } as any;
    tool = createSubAgentTool(mockPipeline, "my-book");
  });

  it("passes episodeDurationSeconds as episodeDurationSeconds", async () => {
    await tool.execute("tc1", { agent: "writer", instruction: "Write", bookId: "my-book", episodeDurationSeconds: 105 });
    expect(writeNextEpisodeMock).toHaveBeenCalledWith("my-book", 105);
  });

  it("passes undefined when episodeDurationSeconds omitted", async () => {
    await tool.execute("tc2", { agent: "writer", instruction: "Write", bookId: "my-book" });
    expect(writeNextEpisodeMock).toHaveBeenCalledWith("my-book", undefined);
  });

  it("marks audit-failed output as a tool error", async () => {
    writeNextEpisodeMock.mockResolvedValueOnce({
      episodeNumber: 4,
      episodeDurationSeconds: 90,
      status: "audit-failed",
    });

    const result = await tool.execute("tc3", {
      agent: "writer",
      instruction: "Write",
      bookId: "my-book",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.details).toMatchObject({ status: "audit-failed", episodeNumber: 4 });
  });
});

describe("auditor agent — rich return value", () => {
  it("returns issue details with severity", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-tool-"));
    const auditDraftMock = vi.fn(async () => ({
      episodeNumber: 3, passed: false,
      issues: [
        { severity: "warning", description: "Pacing too fast" },
        { severity: "critical", description: "Name inconsistency" },
      ],
    }));
    try {
      const tool = createSubAgentTool({ auditDraft: auditDraftMock } as any, "my-book", root);
      const result = await tool.execute("tc1", { agent: "auditor", instruction: "Audit", bookId: "my-book", episodeNumber: 3 });
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("FAILED");
      expect(text).toContain("2 issue(s)");
      expect(text).toContain("[warning]");
      expect(text).toContain("[critical]");
      expect(text).toContain("Pacing too fast");
      expect(auditDraftMock).toHaveBeenCalledWith("my-book", 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("reviser agent — mode field", () => {
  let reviseDraftMock: ReturnType<typeof vi.fn>;
  let tool: ReturnType<typeof createSubAgentTool>;

  beforeEach(() => {
    reviseDraftMock = vi.fn(async () => ({}));
    tool = createSubAgentTool({ reviseDraft: reviseDraftMock } as any, "my-book");
  });

  it("uses mode param directly", async () => {
    await tool.execute("tc1", { agent: "reviser", instruction: "Fix", bookId: "my-book", episodeNumber: 5, mode: "anti-detect" });
    expect(reviseDraftMock).toHaveBeenCalledWith("my-book", 5, "anti-detect", "Fix");
  });

  it("defaults to spot-fix", async () => {
    await tool.execute("tc2", { agent: "reviser", instruction: "Fix", bookId: "my-book" });
    expect(reviseDraftMock).toHaveBeenCalledWith("my-book", undefined, "spot-fix", "Fix");
  });

  it("marks a non-applied revision as a tool error", async () => {
    reviseDraftMock.mockResolvedValueOnce({
      episodeNumber: 5,
      applied: false,
      status: "unchanged",
      skippedReason: "candidate did not improve",
    });

    const result = await tool.execute("tc3", {
      agent: "reviser",
      instruction: "Fix",
      bookId: "my-book",
      episodeNumber: 5,
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.details).toMatchObject({ applied: false, status: "unchanged" });
  });
});

describe("sub-agent failure results", () => {
  it("marks missing active-book usage as a tool error", async () => {
    const tool = createSubAgentTool({} as any, null);
    const result = await tool.execute("tc-missing-book", {
      agent: "writer",
      instruction: "Write",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
