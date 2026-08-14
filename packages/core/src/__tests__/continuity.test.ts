import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityAuditor } from "../agents/continuity.js";
import { estimateTextTokens } from "../llm/provider.js";
import { loadEpisodeContextSnapshot } from "../pipeline/episode-context.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function loadSnapshot(bookDir: string, episode: number) {
  return loadEpisodeContextSnapshot({
    bookDir,
    episode,
    model: "test-model",
    service: "test",
  });
}

describe("ContinuityAuditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a critical audit issue instead of throwing when audit output is not JSON", () => {
    const auditor = new ContinuityAuditor({
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
      projectRoot: "/tmp/inkos-auditor-bad-json-test",
    });

    const result = (auditor as any).parseAuditResult("模型只返回了一段散文，没有 JSON。", "zh");

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("审稿输出解析失败");
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        category: "系统错误",
      }),
    ]);
  });

  it("parses typed repair_scope from audit JSON", () => {
    const auditor = new ContinuityAuditor({
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
      projectRoot: "/tmp/inkos-auditor-repair-scope-test",
    });

    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      issues: [{
        severity: "critical",
        repair_scope: "structural",
        category: "模型审稿判断",
        description: "核心场面缺失",
        suggestion: "重写场面",
      }],
      summary: "needs rewrite",
    }), "zh");

    expect(result.issues[0]).toMatchObject({
      repairScope: "structural",
      category: "模型审稿判断",
    });
  });

  it("prefers book language override when building audit prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-lang-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "xuanhuan",
          platform: "royalroad",
          episodeDurationSeconds: 90,
          schemaVersion: "inkos-episode-v2" as const,
          format: "screenplay" as const,
          targetEpisodes: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue keeps the oath token hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 1\nReturn to the mentor debt.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditEpisode(bookDir, "Episode body.", 1, "xuanhuan", {
        episodeContextSnapshot: await loadSnapshot(bookDir, 1),
      });

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("ALL OUTPUT MUST BE IN ENGLISH");
      expect(systemPrompt).toContain("## Narrative Drive Audit");
      expect(systemPrompt).toContain("never require all five in every episode");
      expect(systemPrompt).toContain("## Finding quality requirements (apply to every issue)");
      expect(systemPrompt).toContain("never ghost-write replacement dialogue or prose inside a suggestion");
      expect(systemPrompt).toContain("Feels AI-written\" alone is not a finding");
      expect(systemPrompt).toContain("## Template-feel diagnostic rules");
      expect(systemPrompt).toContain("never file template feel on surface repetition alone");
      expect(systemPrompt).toContain("stay non-blocking craft guidance");
      expect(systemPrompt).toContain("speaker-swap thought experiment");
      expect(systemPrompt).toContain("goal, relationship, or knowledge");
      expect(systemPrompt).toContain("Escalation evidence");
      expect(systemPrompt).toContain("irreversible decisions, threats made real");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("localizes English audit prompts instead of mixing Chinese control text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-en-prompt-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "other",
          platform: "royalroad",
          episodeDurationSeconds: 90,
          schemaVersion: "inkos-episode-v2" as const,
          format: "screenplay" as const,
          targetEpisodes: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara keeps the warehouse key hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 1\nCheck Warehouse 9.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditEpisode(bookDir, "Episode body.", 1, "other", {
        episodeContextSnapshot: await loadSnapshot(bookDir, 1),
      });

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("Hook Check");
      expect(systemPrompt).toContain("Episode Memo Drift Check");
      expect(systemPrompt).toContain("Do not invent plot decisions");
      expect(systemPrompt).not.toContain("7 sections");
      expect(systemPrompt).not.toContain("Outline Drift Check");
      expect(systemPrompt).toContain("stays dormant long enough to feel abandoned");
      expect(systemPrompt).toContain("3-question test");
      expect(systemPrompt).toContain("same mode long enough to flatten rhythm");
      expect(systemPrompt).toContain("a critical issue requires identifying a 4th or later scene");
      expect(systemPrompt).not.toContain("more than 5 episodes");
      expect(systemPrompt).not.toContain("3 straight episodes");
      expect(systemPrompt).not.toContain("3+ consecutive episodes");
      expect(systemPrompt).not.toContain("伏笔检查");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      expect(userPrompt).toContain("Review episode 1.");
      expect(userPrompt).toContain("## Current State Card");
      expect(userPrompt).toContain("## Pending Hooks");
      expect(userPrompt).not.toContain("请审查第1章");
      expect(userPrompt).not.toContain("## 当前状态卡");
      expect(userPrompt).not.toContain("## 伏笔池");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses selected summary and hook evidence instead of full long-history markdown in governed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| guild-route | 1 | mystery | open | 2 | 6 | Merchant guild trail |",
          "| mentor-oath | 8 | relationship | open | 99 | 101 | Mentor oath debt with Lin Yue |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "episode_summaries.md"),
        [
          "# Episode Summaries",
          "",
          "| 1 | Guild Trail | Merchant guild flees west | Route clues only | None | guild-route seeded | tense | action |",
          "| 99 | Trial Echo | Lin Yue | Mentor left without explanation | Oath token matters again | mentor-oath advanced | aching | fallout |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Episode 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditEpisode(
        bookDir,
        "Episode body.",
        100,
        "xuanhuan",
        {
          episodeContextSnapshot: await loadSnapshot(bookDir, 100),
          episodeIntent: "# Episode Intent\n\n## Goal\nBring the focus back to the mentor oath conflict.\n",
          contextPackage: {
            episode: 100,
            selectedContext: [
              {
                source: "story/episode_summaries.md#99",
                reason: "Relevant episodic memory.",
                excerpt: "Trial Echo | Mentor left without explanation | mentor-oath advanced",
              },
              {
                source: "story/pending_hooks.md#mentor-oath",
                reason: "Carry forward unresolved hook.",
                excerpt: "relationship | open | 101 | Mentor oath debt with Lin Yue",
              },
              {
                source: "runtime/episode_claim_brief",
                reason: "Deterministic claim gate input.",
                excerpt: "CLAIM_BRIEF_MUST_NOT_BE_DUPLICATED_IN_THE_LLM_AUDIT_PROMPT",
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
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const userPrompt = messages?.[1]?.content ?? "";

      expect(userPrompt).toContain("story/episode_summaries.md#99");
      expect(userPrompt).toContain("story/pending_hooks.md#mentor-oath");
      expect(userPrompt.match(/story\/episode_summaries\.md#99/g)).toHaveLength(1);
      expect(userPrompt.match(/story\/pending_hooks\.md#mentor-oath/g)).toHaveLength(1);
      expect(userPrompt).not.toContain("CLAIM_BRIEF_MUST_NOT_BE_DUPLICATED_IN_THE_LLM_AUDIT_PROMPT");
      expect(userPrompt).not.toContain("| 1 | Guild Trail |");
      expect(userPrompt).not.toContain("guild-route | 1 | mystery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compacts lower-priority audit context below the provider prompt budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-budget-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    const largeBlock = Array.from({ length: 1200 }, (_, index) => `上下文条目${index}：重复的低优先级历史证据。`).join("\n");

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# 当前状态\n\n- 主角持有关键账本。\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), `# 伏笔池\n${largeBlock}\n`, "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), `# 章节摘要\n${largeBlock}\n`, "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), `# 支线\n${largeBlock}\n`, "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), `# 情感\n${largeBlock}\n`, "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), `# 矩阵\n${largeBlock}\n`, "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), `# 文风\n${largeBlock}\n`, "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
      maxPromptEstimatedTokens: 16_000,
    });
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, issues: [], summary: "ok" }),
      usage: ZERO_USAGE,
    });
    try {
      const episodeBody = "这是必须完整保留的待审章节正文。".repeat(120);
      await auditor.auditEpisode(bookDir, episodeBody, 1, "urban", {
        episodeContextSnapshot: await loadSnapshot(bookDir, 1),
      });

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      const estimatedTokens = messages.reduce((sum, message) => sum + estimateTextTokens(message.content), 0);
      expect(estimatedTokens).toBeLessThanOrEqual(15_520);
      expect(messages[1]?.content).toContain(episodeBody);
      expect(messages[1]?.content).toContain("主角持有关键账本");
      expect(messages[1]?.content).not.toContain("上下文条目1199");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a focused prompt when verifying a local revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-revision-verify-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# 当前状态\n\n- 林丙仍持有编号被改过的磁带。\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n- tape-id: 磁带编号来源未明。\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# 章节摘要\n\nSHOULD_DROP_OLD_SUMMARIES\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线\n\nSHOULD_DROP_SUBPLOTS\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感\n\nSHOULD_DROP_EMOTIONAL_ARCS\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 矩阵\n\nSHOULD_DROP_CHARACTER_MATRIX\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# 文风\n\nSHOULD_DROP_STYLE_GUIDE\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, overall_score: 100, issues: [], summary: "fixed" }),
      usage: ZERO_USAGE,
    });

    try {
      const episodeBody = "林丙把磁带装进证物袋，删掉了含混的判断。";
      const episodeContextSnapshot = await loadSnapshot(bookDir, 1);
      await auditor.auditEpisode(bookDir, episodeBody, 1, "urban", { episodeContextSnapshot });
      await auditor.auditEpisode(bookDir, episodeBody, 1, "urban", {
        episodeContextSnapshot,
        verificationIssues: [{
          severity: "critical",
          category: "禁止句式",
          description: "出现了禁用句式",
          suggestion: "改用直述句",
          repairScope: "local",
        }],
      });

      const fullMessages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      const messages = chatSpy.mock.calls[1]?.[0] as ReadonlyArray<{ content: string }>;
      const systemPrompt = messages[0]?.content ?? "";
      const userPrompt = messages[1]?.content ?? "";
      const fullPromptTokens = fullMessages.reduce(
        (sum, message) => sum + estimateTextTokens(message.content),
        0,
      );
      const verificationPromptTokens = messages.reduce(
        (sum, message) => sum + estimateTextTokens(message.content),
        0,
      );

      const fullSystemPrompt = fullMessages[0]?.content ?? "";

      expect(fullSystemPrompt).toContain("## Finding 质量要求（每条 issue 必须遵守）");
      expect(fullSystemPrompt).toContain("不要在 suggestion 里代写台词或正文");
      expect(fullSystemPrompt).toContain("只写\"AI 味重\"的 issue 无效");
      expect(fullSystemPrompt).toContain("## 模板感诊断规范");
      expect(fullSystemPrompt).toContain("不得仅凭表面重复判模板");
      expect(fullSystemPrompt).toContain("交换说话者思想实验");
      expect(fullSystemPrompt).toContain("独白、宣告、仪式性对话不适用");
      expect(fullSystemPrompt).toContain("升级证据要求");
      expect(fullSystemPrompt).toContain("只有措辞更激烈而状态维度不变，不算升级");
      expect(systemPrompt).toContain("修订复核员");
      expect(systemPrompt).toContain("## 改写回归检查表（逐项对照补丁前草稿）");
      expect(systemPrompt).toContain("对白逐字内容");
      expect(systemPrompt).toContain("未关联字段不得漂移");
      expect(systemPrompt).not.toContain("审查维度");
      expect(systemPrompt).not.toContain("Finding 质量要求");
      expect(systemPrompt).not.toContain("模板感诊断规范");
      expect(verificationPromptTokens).toBeLessThan(fullPromptTokens * 0.6);
      expect(userPrompt).toContain("## 上次审计的阻塞问题");
      expect(userPrompt).toContain("出现了禁用句式");
      expect(userPrompt).toContain("林丙仍持有编号被改过的磁带");
      expect(userPrompt).toContain("tape-id");
      expect(userPrompt).toContain(episodeBody);
      expect(userPrompt).not.toContain("SHOULD_DROP_OLD_SUMMARIES");
      expect(userPrompt).not.toContain("SHOULD_DROP_SUBPLOTS");
      expect(userPrompt).not.toContain("SHOULD_DROP_EMOTIONAL_ARCS");
      expect(userPrompt).not.toContain("SHOULD_DROP_CHARACTER_MATRIX");
      expect(userPrompt).not.toContain("SHOULD_DROP_STYLE_GUIDE");

      // P0-4: the rewrite fallback carries no preservation guarantee, so it
      // gets the regression checklist phrased against the pre-rewrite draft
      // instead of the patch-specific drift note.
      await auditor.auditEpisode(bookDir, episodeBody, 1, "urban", {
        episodeContextSnapshot,
        revisionKind: "rewrite",
        verificationIssues: [{
          severity: "critical",
          category: "structure",
          description: "S2 的反转没有前置证据",
          suggestion: "在 S1 补一个可回指的证据镜头",
          repairScope: "structural",
        }],
      });
      const rewriteMessages = chatSpy.mock.calls[2]?.[0] as ReadonlyArray<{ content: string }>;
      const rewriteSystemPrompt = rewriteMessages[0]?.content ?? "";
      expect(rewriteSystemPrompt).toContain("修订复核员");
      expect(rewriteSystemPrompt).toContain("## 改写回归检查表（逐项对照改写前草稿）");
      expect(rewriteSystemPrompt).toContain("完整结构审计已经在整集改写前执行");
      expect(rewriteSystemPrompt).toContain("改写不是顺手重写的借口");
      expect(rewriteSystemPrompt).not.toContain("补丁前草稿");
      expect(rewriteSystemPrompt).not.toContain("未关联字段不得漂移");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the episode memo into the audit prompt for memo-drift checking", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-memo-drift-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "episode_summaries.md"), "# Episode Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 矩阵\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, issues: [], summary: "ok" }),
      usage: ZERO_USAGE,
    });

    const memoBody = [
      "## 当前任务",
      "陆焚在小巷抢回残刃并离开。",
      "",
      "## 读者此刻在等什么",
      "读者想看他怎么脱身。",
      "",
      "## 该兑现的 / 暂不掀的",
      "兑现：残刃归手；暂不掀：身世。",
      "",
      "## 日常/过渡承担什么任务",
      "开篇小巷场景 → 情绪代入 + 信息植入。",
      "",
      "## 关键抉择过三连问",
      "陆焚选择独自动手的理由是什么？",
      "",
      "## 章尾必须发生的改变",
      "陆焚拿回残刃，被人目击。",
      "",
      "## 本章 hook 账",
      "resolve: H11 残刃下落 → 本章找回。defer: H04 幕后主使 → 留到第 50 章。",
      "",
      "## 不要做",
      "不要写成大段打斗。",
    ].join("\n");

    try {
      await auditor.auditEpisode(bookDir, "Episode body.", 42, "xuanhuan", {
        episodeContextSnapshot: await loadSnapshot(bookDir, 42),
        episodeMemo: {
          episode: 42,
          goal: "陆焚抢回残刃并离开",
          isGoldenOpening: false,
          body: memoBody,
          threadRefs: [],
        },
      });

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      // Prompt declares structure-only scope and sparse-memo legality.
      expect(systemPrompt).toContain("审稿边界");
      expect(systemPrompt).toContain("你不审文笔");
      expect(systemPrompt).toContain("稀疏 memo 是合法状态");
      expect(systemPrompt).toContain("剧集备忘偏离");
      expect(systemPrompt).toContain("Auditor 不发明剧情");
      expect(systemPrompt).toContain("第4个及以后新增场景");
      expect(systemPrompt).not.toContain("7 段正文");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      // User prompt receives the compact, fingerprinted execution contract.
      expect(userPrompt).toContain("## 单集执行合同");
      expect(userPrompt).toContain("目标: 陆焚抢回残刃并离开");
      expect(userPrompt).toContain("### 正文必须落地");
      expect(userPrompt).not.toContain("## 读者此刻在等什么");
      // Legacy volume-outline block is gone.
      expect(userPrompt).not.toContain("## 卷纲");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
