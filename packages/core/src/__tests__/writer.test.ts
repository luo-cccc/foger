import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriterAgent } from "../agents/writer.js";
import { estimateTextTokens } from "../llm/provider.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import { buildEpisodeContextSnapshot } from "../pipeline/episode-context.js";
import { EpisodeScriptSchema, renderEpisodeScriptMarkdown } from "../models/episode-script.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function createCaptureLogger() {
  const infos: string[] = [];
  const warnings: string[] = [];

  const logger = {
    debug() {},
    info(message: string) {
      infos.push(message);
    },
    warn(message: string) {
      warnings.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };

  return { logger, infos, warnings };
}

function operationSnapshot(episode: number) {
  return buildEpisodeContextSnapshot({
    episode,
    model: "stub",
    service: "test",
    entries: [
      { source: "story/current_state.md", content: "state" },
      { source: "story/pending_hooks.md", content: "hooks" },
      { source: "story/episode_summaries.md", content: "summaries" },
    ],
  });
}

function episodeScript(episode: number) {
  return EpisodeScriptSchema.parse({
    episode,
    title: "Archive Pressure",
    estimatedDurationSeconds: 90,
    openingHook: "Mara blocks the archive exit.",
    reversal: "The ledger proves Taryn controlled the seal all along.",
    emotionalHook: "Will Mara still trust Taryn with the evidence?",
    endState: "Mara holds the ledger while Taryn controls the only exit.",
    contract: {
      incomingState: { knowledge: [], power: [], relationship: [], physical: [], activeAction: [] },
      objective: { character: "Mara", desiredChange: "Secure the ledger", whyNow: "The archive is closing" },
      opposition: { actorOrConstraint: "Taryn", goal: "Keep the seal", leverage: "Controls the exit" },
      causalEscalation: [{
        becauseOf: "Mara finds the ledger fragment",
        choice: "Mara confronts Taryn",
        countermove: "Taryn locks the exit",
        stateChange: "Both reveal their leverage",
        nextPressure: "They must decide who carries the evidence",
      }],
      localDramaticResult: { goalOutcome: "Mara secures the ledger", stateChange: "Control splits", costPaid: "She is trapped" },
      outgoingPressure: { startedDecisionDangerOrQuestion: "The archive alarm starts", whyItFollows: "Taryn locked the exit" },
      handoffState: { knowledge: ["Taryn controlled the seal"], power: ["Mara holds the ledger"], relationship: ["Trust collapses"], physical: [], activeAction: ["Alarm starts"] },
      informationPermissions: [],
    },
    scenes: [{
      id: "S1",
      location: "Archive",
      time: "Night",
      purpose: "Transfer the ledger and split control",
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `S1-${index + 1}`,
        shotSize: "medium",
        camera: "locked",
        durationSeconds: 15,
        visual: `Visible archive action ${index + 1}`,
        dialogue: [],
      })),
    }],
  });
}

describe("WriterAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders per-episode user context in governed creative prompts", () => {
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-writer-context-test",
    });

    const prompt = (agent as unknown as {
      buildGovernedUserPrompt(params: {
        readonly episodeNumber: number;
        readonly episodeMemo: {
          readonly episode: number;
          readonly goal: string;
          readonly isGoldenOpening: boolean;
          readonly body: string;
          readonly threadRefs: readonly string[];
        };
        readonly contextPackage: { readonly episode: number; readonly selectedContext: readonly [] };
        readonly ruleStack: {
          readonly layers: readonly [];
          readonly sections: { readonly hard: readonly string[]; readonly soft: readonly string[]; readonly diagnostic: readonly string[] };
          readonly overrideEdges: readonly [];
          readonly activeOverrides: readonly [];
        };
        readonly lengthSpec: ReturnType<typeof buildLengthSpec>;
        readonly language?: "zh" | "en";
        readonly externalContext?: string;
      }): string;
    }).buildGovernedUserPrompt({
      episodeNumber: 7,
      episodeMemo: {
        episode: 7,
        goal: "推进账本线",
        isGoldenOpening: false,
        body: "## 当前任务\n围绕账本线推进。",
        threadRefs: [],
      },
      contextPackage: { episode: 7, selectedContext: [] },
      ruleStack: {
        layers: [],
        sections: { hard: [], soft: [], diagnostic: [] },
        overrideEdges: [],
        activeOverrides: [],
      },
      lengthSpec: buildLengthSpec(1200, "zh"),
      language: "zh",
      externalContext: "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。",
    });

    expect(prompt).toContain("本集用户指令");
    expect(prompt).toContain("本章标题：雨夜账本");
    expect(prompt).toContain("当面对质");
    expect(prompt).toContain("目标时长：约 150 秒");
    expect(prompt).not.toContain("NaN");
  });

  it("caps oversized legacy truth files in creative prompts", () => {
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-writer-context-budget-test",
    });
    const oversizedStoryBible = [
      "BEGIN-STORY",
      "旧设定。".repeat(4000),
      "MIDDLE-MARKER",
      "近期设定。".repeat(4000),
      "LATEST-STORY",
    ].join("\n");

    const prompt = (agent as unknown as {
      buildUserPrompt(params: {
        readonly episodeNumber: number;
        readonly storyBible: string;
        readonly currentState: string;
        readonly ledger: string;
        readonly hooks: string;
        readonly recentEpisodes: string;
        readonly lengthSpec: ReturnType<typeof buildLengthSpec>;
        readonly episodeSummaries: string;
        readonly subplotBoard: string;
        readonly emotionalArcs: string;
        readonly characterMatrix: string;
        readonly language?: "zh" | "en";
      }): string;
    }).buildUserPrompt({
      episodeNumber: 88,
      storyBible: oversizedStoryBible,
      currentState: "(文件尚未创建)",
      ledger: "",
      hooks: "(文件尚未创建)",
      recentEpisodes: "",
      lengthSpec: buildLengthSpec(1200, "zh"),
      episodeSummaries: "(文件尚未创建)",
      subplotBoard: "(文件尚未创建)",
      emotionalArcs: "(文件尚未创建)",
      characterMatrix: "(文件尚未创建)",
      language: "zh",
    });

    expect(prompt).toContain("BEGIN-STORY");
    expect(prompt).toContain("LATEST-STORY");
    expect(prompt).toContain("InkOS context budget");
    expect(prompt).toContain("story_bible");
    expect(prompt).not.toContain("MIDDLE-MARKER");
  });

  it("does not overwrite existing truth files with empty settlement placeholders", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-empty-settlement-save-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const stateDir = join(storyDir, "state");
    await mkdir(storyDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const existingState = [
      "# 当前状态",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      "| 当前章节 | 4 |",
      "| 当前目标 | 调查监听系统设备清单 |",
      "",
    ].join("\n");
    const existingHooks = [
      "# 伏笔池",
      "",
      "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| morse-controller | 4 | mystery | open | 4 | 揭示摩斯码暗号操控者 | S-043 通道发出暗号 |",
      "",
    ].join("\n");
    const existingCurrentStateJson = {
      episode: 4,
      facts: [
        {
          subject: "protagonist",
          predicate: "当前目标",
          object: "调查监听系统设备清单",
          validFromEpisode: 4,
          validUntilEpisode: null,
          sourceEpisode: 4,
        },
      ],
    };
    const existingHooksJson = {
      hooks: [
        {
          hookId: "morse-controller",
          startEpisode: 4,
          type: "mystery",
          status: "open",
          lastAdvancedEpisode: 4,
          expectedPayoff: "揭示摩斯码暗号操控者",
          notes: "S-043 通道发出暗号",
        },
      ],
    };

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), existingState, "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), existingHooks, "utf-8"),
      writeFile(join(stateDir, "manifest.json"), JSON.stringify({
        schemaVersion: 2,
        language: "zh" as const,
        lastAppliedEpisode: 4,
        projectionVersion: 1,
        migrationWarnings: [],
      }, null, 2), "utf-8"),
      writeFile(join(stateDir, "current_state.json"), JSON.stringify(existingCurrentStateJson, null, 2), "utf-8"),
      writeFile(join(stateDir, "hooks.json"), JSON.stringify(existingHooksJson, null, 2), "utf-8"),
      writeFile(join(stateDir, "episode_summaries.json"), JSON.stringify({ rows: [] }, null, 2), "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    try {
      await agent.saveEpisode(
        bookDir,
        {
          episodeNumber: 5,
          title: "设备间的信号线",
          content: "林澈在设备间发现异常线缆。",
          episodeDurationSeconds: 15,
          preWriteCheck: "",
          stateProjection: "",
          runtimeStateSnapshot: {
            manifest: {
              schemaVersion: 2,
              language: "zh",
              lastAppliedEpisode: 5,
              projectionVersion: 1,
              migrationWarnings: [],
            },
            currentState: { episode: 5, facts: [] },
            hooks: { hooks: [] },
            episodeSummaries: { rows: [] },
          },
          updatedState: "(状态卡未更新)",
          updatedLedger: "",
          updatedHooks: "(伏笔池未更新)",
          episodeSummary: "",
          updatedSubplots: "",
          updatedEmotionalArcs: "",
          updatedCharacterMatrix: "",
          postWriteErrors: [],
          postWriteWarnings: [],
          hookHealthIssues: [],
          tokenUsage: ZERO_USAGE,
        },
        false,
        "zh",
      );

      await expect(readFile(join(storyDir, "current_state.md"), "utf-8")).resolves.toBe(existingState);
      await expect(readFile(join(storyDir, "pending_hooks.md"), "utf-8")).resolves.toBe(existingHooks);
      await expect(readFile(join(stateDir, "current_state.json"), "utf-8").then(JSON.parse)).resolves.toEqual(existingCurrentStateJson);
      await expect(readFile(join(stateDir, "hooks.json"), "utf-8").then(JSON.parse)).resolves.toEqual(existingHooksJson);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders explicit title history, mood trail, and canon blocks in governed creative prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-governed-evidence-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- Registry seals still matter.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 4\nPush Mara back toward the archive ledger.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose lean.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara still hides the ledger fragment.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- ledger-fragment\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValue({
        content: JSON.stringify(episodeScript(4)),
        usage: ZERO_USAGE,
      });
    try {
      await agent.writeEpisode({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "other",
          genre: "other",
          status: "active",
          schemaVersion: "inkos-episode-v2" as const,
          format: "screenplay" as const,
          targetEpisodes: 20,
          episodeDurationSeconds: 90,
          language: "en",
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
        bookDir,
        episodeNumber: 4,
        episodeContextSnapshot: operationSnapshot(4),
        episodeMemo: {
          episode: 4,
          goal: "Push Mara back toward the archive ledger.",
          isGoldenOpening: false,
          body: "",
          threadRefs: ["ledger-fragment"],
        },
        contextPackage: {
          episode: 4,
          selectedContext: [
            {
              source: "story/episode_summaries.md#recent_titles",
              reason: "Avoid repeated ledger titles.",
              excerpt: "1: Ledger in Rain | 2: Ledger at Dusk | 3: Harbor Ledger",
            },
            {
              source: "story/episode_summaries.md#recent_mood_type_trail",
              reason: "Track recent emotional and episode-type cadence.",
              excerpt: "1: tight / investigation | 2: tight / investigation | 3: tight / investigation",
            },
            {
              source: "story/parent_canon.md",
              reason: "Preserve parent canon constraints.",
              excerpt: "The mentor does not learn about the archive fire until volume two.",
            },
          ],
        },
        ruleStack: {
          layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
          sections: {
            hard: ["current_state"],
            soft: ["current_focus"],
            diagnostic: ["continuity_audit"],
          },
          overrideEdges: [],
          activeOverrides: [],
        },
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(creativePrompt).toContain("## Recent Title History");
      expect(creativePrompt).toContain("Ledger in Rain");
      expect(creativePrompt).toContain("## Recent Mood / Episode Type Trail");
      expect(creativePrompt).toContain("tight / investigation");
      expect(creativePrompt).toContain("## Canon Evidence");
      expect(creativePrompt).toContain("archive fire until volume two");
      expect(creativePrompt.match(/Ledger in Rain/g)).toHaveLength(1);
      expect(creativePrompt.match(/## Recent Mood \/ Episode Type Trail/g)).toHaveLength(1);
      expect(creativePrompt.match(/archive fire until volume two/g)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders the governed episode memo once even when it is also a context source", () => {
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-writer-memo-dedup-test",
    });
    const marker = "UNIQUE_MEMO_EXECUTION_MARKER";
    const prompt = (agent as unknown as {
      buildGovernedUserPrompt(params: Record<string, unknown>): string;
    }).buildGovernedUserPrompt({
      episodeNumber: 7,
      episodeMemo: {
        episode: 7,
        goal: "Advance the ledger.",
        isGoldenOpening: false,
        body: `## Current task\n${marker}`,
        threadRefs: [],
      },
      contextPackage: {
        episode: 7,
        selectedContext: [{
          source: "runtime/episode_memo",
          reason: "Planner memo.",
          excerpt: `goal=Advance the ledger. | ## Current task | ${marker}`,
        }],
      },
      ruleStack: {
        layers: [],
        sections: { hard: [], soft: [], diagnostic: [] },
        overrideEdges: [],
        activeOverrides: [],
      },
      lengthSpec: buildLengthSpec(1200, "en"),
      language: "en",
    });

    expect(prompt.match(new RegExp(marker, "g"))).toHaveLength(1);
  });

  it("sanitizes governed control inputs so raw hook ids and control headings do not enter the creative prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-hook-agenda-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- Registry seals still matter.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 4\nPush Mara back toward the archive ledger.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose lean.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara still hides the ledger fragment.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- ledger-fragment\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValue({
        content: JSON.stringify(episodeScript(4)),
        usage: ZERO_USAGE,
      });
    try {
      await agent.writeEpisode({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "other",
          genre: "other",
          status: "active",
          schemaVersion: "inkos-episode-v2" as const,
          format: "screenplay" as const,
          targetEpisodes: 20,
          episodeDurationSeconds: 90,
          language: "en",
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
        bookDir,
        episodeNumber: 4,
        episodeContextSnapshot: operationSnapshot(4),
        episodeMemo: {
          episode: 4,
          goal: "Push Mara back toward the archive ledger.",
          isGoldenOpening: false,
          body: "本章要做的是推进 ledger-fragment tension at the archive.",
          threadRefs: ["mentor-oath", "ledger-fragment"],
        },
        contextPackage: {
          episode: 4,
          selectedContext: [
            {
              source: "story/pending_hooks.md#mentor-oath",
              reason: "Carry the unresolved oath line.",
              excerpt: "relationship | open | old oath debt",
            },
          ],
        },
        ruleStack: {
          layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
          sections: {
            hard: ["current_state"],
            soft: ["current_focus"],
            diagnostic: ["continuity_audit"],
          },
          overrideEdges: [],
          activeOverrides: [],
        },
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      const systemPrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[0]?.content ?? "";
      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";

      expect(systemPrompt).not.toContain("Hook-A / Hook-B");
      expect(systemPrompt).toContain("Hook execution"); // English book gets the English output scaffold
      expect(systemPrompt).toContain("advance/resolve ids");
      expect(systemPrompt).toContain("Dialogue is action");
      expect(systemPrompt).toContain("Scene work card");
      expect(systemPrompt).toContain("not an emotion word");
      // Enum/identifier fields (hookId, movement, episodeType) are NOT sanitized —
      // the writer needs them to understand which hook to move and what episode type
      // to write. Free-text fields (goal, instruction, targetEffect) ARE sanitized.
      expect(creativePrompt).not.toContain("## Hook Agenda");
      // hookIds appear verbatim in Hook Plan (identifiers, not free text)
      expect(creativePrompt).toContain("mentor-oath");
      expect(creativePrompt).toContain("ledger-fragment");
      // But slug references INSIDE free text (targetEffect) are sanitized
      expect(creativePrompt).not.toContain("stale-ledger");
      expect(creativePrompt).not.toContain("H001");
      expect(creativePrompt).not.toContain("本章要做的");
      // The goal text should survive sanitization
      expect(creativePrompt).toContain("Push Mara back toward the archive ledger.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replayEpisodeState consumes the persisted plan memo so hook ledger annotations are not lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-replay-hooks-"));
    try {
      const storyDir = join(root, "story");
      const runtimeDir = join(storyDir, "runtime");
      await mkdir(runtimeDir, { recursive: true });
      const hooksMarkdown = [
        "| hook_id | 起始剧集 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 上游依赖 | 回收篇章 | 核心 | 半衰期 | 升级 | 备注 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| H001 | 0 | 主线 | open | 0 | 第3集 | 中程 | 无 | 第1篇 | 否 | 30 | 否 | 虞允文玉佩 |",
      ].join("\n");
      await writeFile(join(storyDir, "pending_hooks.md"), hooksMarkdown, "utf8");
      await writeFile(join(storyDir, "current_state.md"), "当前位置：采石矶\n", "utf8");
      await writeFile(join(storyDir, "episode_summaries.md"), "", "utf8");

      const memoBody = [
        "## 当前任务", "沈砚用虞允文玉佩叩开襄阳城门并建立立足点。",
        "## 本集爽点", "入场即被看见的身份跃迁。",
        "## 进入状态", "沈砚身处采石战场前夜，持有军情承诺与极低气运。",
        "## 当前目标", "在吕文焕的怀疑与城防困局中站稳脚跟，并保住火种营的立足之地。",
        "## 反对力量", "吕文焕的怀疑与城防器械短缺构成双重阻力。",
        "## 因果升级", "玉佩叩门换来姑且一试，突火枪验货换来三天限期。",
        "## 关系压力", "吕文焕掌握绝对主动权，沈砚隐瞒知道城破的事实。",
        "## 方向性转折", "从凭本事换信任转向被列入重点观察名单。",
        "## 反转铺垫", "吕文焕验过玉佩为真、验过判断为真，却下令彻查底细。",
        "## 本集反转", "专业表现让他从可用之人变成重点怀疑对象。",
        "## 反转后果", "三天限期成为倒计时，暗哨已布而沈砚不知。",
        "## 当集兑现", "入城、见吕文焕、验证工械能力、拿到三天限期。",
        "## 出去压力", "三天内证明自己不是细作，否则王贵随时可以把他当细作处置。",
        "## 结尾交接状态", "沈砚成为被监视的可疑之人，暗哨已布而他一无所知。",
        "## 信息权限", "观众全知、沈砚不知自己被查、吕文焕不知沈砚是穿越者。",
        "## 情绪钩子", "沈砚要如何在不知道自己被怀疑的情况下证明自己？",
        "## 结尾状态", "立足基础是怀疑而非信任。",
        "## 本集 Hook ledger",
        "advance:",
        "- H001 \"虞允文玉佩\" → 沈砚用它叩开襄阳城门（deferred → activated）",
        "resolve:",
        "- 无",
        "defer:",
        "- 无",
        "## 卷级 KR 绑定",
        "- 缓冲/过渡：本集建立立足点。",
        "## 不要做",
        "- 禁止主角成功改变南宋灭亡的宏观结局",
      ].join("\n");
      const planMarkdown = [
        "# Episode 21 Plan",
        "",
        "## Metadata",
        "Episode: 21",
        "Golden Opening: no",
        "",
        "<!-- INKOS_PLAN_MEMO_START -->",
        "# 第 21 集 memo",
        "",
        "## 本集目标",
        "襄阳城门在望，沈砚以采石余威立足。",
        "",
        "## 关联线索",
        "- H001",
        "",
        "## 卷级 KR 绑定",
        "- 缓冲/过渡：本集建立立足点。",
        "",
        memoBody,
        "<!-- INKOS_PLAN_MEMO_END -->",
        "",
      ].join("\n");
      await writeFile(join(runtimeDir, "episode-0021.plan.md"), planMarkdown, "utf8");

      const agent = new WriterAgent({
        client: {
          provider: "openai",
          apiFormat: "chat",
          stream: false,
          defaults: {
            temperature: 0.7,
            maxTokens: 4096,
            thinkingBudget: 0,
            extra: {},
          },
        },
        model: "test-model",
        projectRoot: root,
      });
      const book = {
        id: "replay-book",
        title: "Replay Book",
        platform: "other" as const,
        genre: "other",
        status: "active" as const,
        schemaVersion: "inkos-episode-v2" as const,
        format: "screenplay" as const,
        targetEpisodes: 100,
        episodeDurationSeconds: 90,
        language: "zh" as const,
        createdAt: "2026-03-26T00:00:00.000Z",
        updatedAt: "2026-03-26T00:00:00.000Z",
      };
      const script = episodeScript(21);
      script.title = "襄阳不是采石";
      const replayed = await agent.replayEpisodeState({
        book,
        bookDir: root,
        episodeNumber: 21,
        title: script.title,
        content: renderEpisodeScriptMarkdown(script),
        allowReapply: true,
        episodeContextSnapshot: buildEpisodeContextSnapshot({
          episode: 21,
          model: "test",
          service: "test",
          entries: [
            { source: "story/pending_hooks.md", content: hooksMarkdown },
            { source: "story/current_state.md", content: "state" },
            { source: "story/episode_summaries.md", content: "summaries" },
          ],
        }),
      });

      const upsert = replayed.runtimeStateDelta?.hookOps.upsert ?? [];
      expect(upsert.some((hook) => hook.hookId === "H001" && hook.lastAdvancedEpisode === 21)).toBe(true);
      expect(replayed.updatedHooks).toContain("H001");
      expect(replayed.updatedHooks).toMatch(/progressing|已推进|重大推进/u);
      expect(replayed.episodeSummary).toContain("advance:H001");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps screenplay output tokens at the model card limit (large model gets the ceiling, small model falls back)", async () => {
    const runWith = async (clientMaxTokens: number): Promise<number | undefined> => {
      const root = await mkdtemp(join(tmpdir(), "inkos-writer-max-tokens-test-"));
      const bookDir = join(root, "book");
      const storyDir = join(bookDir, "story");
      await mkdir(storyDir, { recursive: true });
      await Promise.all([
        writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n", "utf-8"),
        writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 4\nPush forward.\n", "utf-8"),
        writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n", "utf-8"),
        writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
        writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
        writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
      ]);

      const agent = new WriterAgent({
        client: {
          provider: "openai",
          apiFormat: "chat",
          stream: false,
          defaults: { temperature: 0.7, maxTokens: clientMaxTokens, thinkingBudget: 0, extra: {} },
        },
        model: "test-model",
        projectRoot: root,
      });
      const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
        .mockResolvedValue({ content: JSON.stringify(episodeScript(4)), usage: ZERO_USAGE });
      try {
        await agent.writeEpisode({
          book: {
            id: "writer-book",
            title: "Writer Book",
            platform: "other",
            genre: "other",
            status: "active",
            schemaVersion: "inkos-episode-v2" as const,
            format: "screenplay" as const,
            targetEpisodes: 20,
            episodeDurationSeconds: 90,
            language: "en",
            createdAt: "2026-03-26T00:00:00.000Z",
            updatedAt: "2026-03-26T00:00:00.000Z",
          },
          bookDir,
          episodeNumber: 4,
          episodeContextSnapshot: operationSnapshot(4),
          episodeMemo: {
            episode: 4,
            goal: "Push forward.",
            isGoldenOpening: false,
            body: "",
            threadRefs: [],
          },
          contextPackage: {
            episode: 4,
            selectedContext: [],
          },
          ruleStack: {
            layers: [],
            sections: { hard: [], soft: [], diagnostic: [] },
            overrideEdges: [],
            activeOverrides: [],
          },
          lengthSpec: buildLengthSpec(2200, "en"),
        });
        const opts = chatSpy.mock.calls[0]?.[1] as { maxTokens?: number } | undefined;
        return opts?.maxTokens;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };

    // deepseek-v4-flash advertises maxOutput=393216 -> full 32768 ceiling.
    expect(await runWith(393_216)).toBe(32768);
    // A smaller model (maxOutput=8192) falls back instead of hitting an API error.
    expect(await runWith(8192)).toBe(8192);
  });
});
