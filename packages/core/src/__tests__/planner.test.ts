import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlannerAgent } from "../agents/planner.js";
import * as llmProvider from "../llm/provider.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import type { OnPipelineDiagnostic } from "../pipeline/diagnostics.js";
import { loadEpisodeContextSnapshot, type EpisodeContextSnapshot } from "../pipeline/episode-context.js";

const VALID_BODY = `
## 当前任务
主角进入七号门现场，比对锁芯刮痕与监控时间线，把"被动过手脚"从猜测钉成实证。

## 本集爽点
观众看到主角用一条可验证的证据逼退对手，满足调查题材中现场反制的期待。

## 进入状态
主角知道锁芯有异常但没有实证；对手掌握门禁权限；两人互不信任；主角带着记录仪进入七号门；取证动作尚未完成。

## 当前目标
主角要在监控清除前固定锁芯证据，因为这是唯一能改变对手主动权的时机。

## 反对力量
门禁管理员想抹掉记录，手里有封锁权限和时间优势，必须阻止主角取证。

## 因果升级
因为监控即将清除，主角选择拆下锁芯；管理员反锁现场并切断照明；主角仍取得刮痕样本，下一压力是公开指认管理员。

## 关系压力
主角与对手的互相利用关系被施压；对手拥有现场主动权，并隐瞒自己提前改过记录。

## 反转铺垫
观众先判断管理员只是奉命看守，前置证据是他反复避开同一段监控画面。

## 本集反转
锁芯刮痕证明管理员亲手动过门，而不是单纯执行命令。

## 反转后果
管理员失去可信度，主角获得指认筹码，但也失去继续潜伏的安全位置。

## 当集兑现
主角拿到锁芯实证并逼退管理员，代价是身份暴露和现场封锁升级。

## 出去压力
管理员会在天亮前公开指控主角盗窃；这是因为主角带走了能证明篡改的样本。

## 结尾交接状态
主角掌握锁芯实证；管理员掌握先发指控权；两人关系转为公开对立；主角仍在七号门内；下一步必须把证据送出。

## 读者此刻在等什么
1) 读者在等七号门是否有异常实锤
2) 本章完全兑现，钉成现场实证

## 该兑现的 / 暂不掀的
- 该兑现：七号门异常 → 钉成现场实证
- 暂不掀：幕后主使 → 压到第 20 章

## 日常/过渡承担什么任务
不适用 - 本章为高压实证章，无日常过渡段。

## 关键抉择过三连问
- 主角本章最关键的一次选择：
  - 为什么这么做？线索只剩这一条
  - 符合当前利益吗？符合
  - 符合他的人设吗？符合
- 对手/配角本章最关键的一次选择：
  - 为什么这么做？掩盖踪迹
  - 符合当前利益吗？符合
  - 符合他的人设吗？符合

## 章尾必须发生的改变
- 信息改变：主角掌握实证，可以面对幕后主使前先压住对手的退路

## 方向性转折
主角从暗中取证转为当面对手公开施压，前置实证迫使他放弃继续潜伏。

## 信息权限
主角和观众知道锁芯被动过手脚；对手只知道主角拿到了一部分证据；幕后主使仍未知。

## 情绪钩子
主角已经拿到实证，观众要追问对手会先背叛谁？

## 结尾状态
锁芯实证落入主角手中，主角与对手的关系从试探变成公开对立。

## 本章 hook 账
advance:
- H03 "七号门异常" → 从 pressured → near_payoff（本章钉成实证）
resolve:
- S004 "锁芯刮痕" → 核验完毕，本章结清
defer:
- H07 "幕后主使" → 第 20 章再动

## 卷级 KR 绑定
- 绑定：KR1
- 推进方式：七号门实证让本卷追查门禁账目的 KR 前进一步。

## 不要做
- 不要让对手突然降智
- 不要直接点破幕后主使
`.trim();

function validMemoRaw(episode: number): string {
  return `# 第 ${episode} 章 memo

## 本章目标
把七号门被动过手脚钉成现场实证

## 关联线索
- H03
- S004

${VALID_BODY}
`;
}

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const STUB_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, maxTokensCap: null, extra: {} },
};

function makeBook(): BookConfig {
  return {
    id: "book-plan-1",
    title: "Test Book",
    genre: "urban",
    platform: "qidian",
    status: "active",
    language: "zh",
    schemaVersion: "inkos-episode-v2" as const,
    format: "screenplay" as const,
    targetEpisodes: 100,
    episodeDurationSeconds: 90,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

async function seedStoryFiles(bookDir: string): Promise<void> {
  const storyDir = join(bookDir, "story");
  await mkdir(storyDir, { recursive: true });
  await Promise.all([
    writeFile(join(storyDir, "author_intent.md"), "# Intent\n- Tell a taut mystery.", "utf-8"),
    writeFile(join(storyDir, "current_focus.md"), "# Focus\n- Keep pressure on the seventh gate.", "utf-8"),
    writeFile(join(storyDir, "story_bible.md"), "# Bible\n- Protagonist: 阿泽", "utf-8"),
    writeFile(join(storyDir, "volume_outline.md"), "# Outline\n- 第 1 章：开场", "utf-8"),
    writeFile(join(storyDir, "episode_summaries.md"), "# Summaries\n", "utf-8"),
    writeFile(join(storyDir, "book_rules.md"), "# Rules\n- 禁止反派降智", "utf-8"),
    writeFile(join(storyDir, "current_state.md"), "# State\n- 主角在七号门附近", "utf-8"),
    writeFile(join(storyDir, "pending_hooks.md"), [
      "# Hooks",
      "",
      "| hook_id | start_episode | type | status | last_advanced | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| H03 | 1 | mystery | progressing | 0 | Pin the Door 7 anomaly as evidence | Existing main clue |",
      "| S004 | 1 | evidence | progressing | 0 | Verify the lock scratches | Existing evidence thread |",
      "| H07 | 1 | mystery | deferred | 0 | Reveal the mastermind | Saved for later |",
      "",
    ].join("\n"), "utf-8"),
    writeFile(join(storyDir, "subplot_board.md"), "# Subplot\n", "utf-8"),
    writeFile(join(storyDir, "emotional_arcs.md"), "# Arcs\n", "utf-8"),
    writeFile(join(storyDir, "character_matrix.md"), "# Matrix\n", "utf-8"),
  ]);
}

describe("PlannerAgent.planEpisode memo generation", () => {
  let root: string;
  let bookDir: string;
  let episodeContextSnapshot: EpisodeContextSnapshot;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "planner-memo-"));
    bookDir = join(root, "book");
    await seedStoryFiles(bookDir);
    episodeContextSnapshot = await loadEpisodeContextSnapshot({
      bookDir,
      episode: 1,
      model: "test-model",
      service: "test",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function makePlanner(onPipelineDiagnostic?: OnPipelineDiagnostic): PlannerAgent {
    return new PlannerAgent({
      client: STUB_CLIENT,
      model: "test-model",
      projectRoot: root,
      bookId: "book-plan-1",
      onPipelineDiagnostic,
    });
  }

  it("produces a valid EpisodeMemo when the LLM returns well-formed output", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 1,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.episode).toBe(1);
    expect(result.memo.isGoldenOpening).toBe(true); // ch1 zh → golden opening, authoritative over LLM
    expect(result.memo.goal).toBe("把七号门被动过手脚钉成现场实证");
    expect(result.memo.threadRefs).toEqual(["H03", "S004"]);
    expect(result.memo.body).toContain("## 当前任务");
  });

  it("persists the structured current arc as a runtime diagnostic input", async () => {
    const storyDir = join(bookDir, "story");
    await Promise.all([
      writeFile(
        join(storyDir, "subplot_board.md"),
        [
          "| subplot_id | 名称 | 负责人 | 起始 | 最近触达 | 沉默章数 | 状态 | 压力 |",
          "|------------|------|--------|------|----------|----------|------|------|",
          "| S001 | 三担保排查 | 主角 | ch1 | ch4 | 3 | 推进 | 核心旧账线 |",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "emotional_arcs.md"),
        [
          "| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |",
          "|------|------|----------|----------|-------------|----------|",
          "| 周谨川 | 4 | 紧绷 | 门前对峙 | 8 | 升级 |",
        ].join("\n"),
        "utf-8",
      ),
    ]);
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(5),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const currentSnapshot = await loadEpisodeContextSnapshot({
      bookDir,
      episode: 5,
      model: "test-model",
      service: "test",
    });

    const result = await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot: currentSnapshot,
      episodeNumber: 5,
    });

    const currentArcPath = join(bookDir, "story", "runtime", "tier2_current_arc.md");
    await expect(readFile(currentArcPath, "utf-8")).resolves.toContain("当前叙事压力");
    await expect(readFile(currentArcPath, "utf-8")).resolves.toContain("S001");
    await expect(readFile(currentArcPath, "utf-8")).resolves.toContain("周谨川");
    expect(result.plannerInputs).toContain(currentArcPath);
  });

  it("caps memo generation at the planner output budget", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 1,
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const options = callArgs[3] as { temperature?: number; maxTokens?: number } | undefined;
    expect(options).toEqual(expect.objectContaining({ temperature: 0.7 }));
    expect(options?.maxTokens).toBe(4096);
  });

  it("passes per-episode user context into the memo prompt as a high-priority instruction", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 1,
      externalContext: "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。",
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("本集用户指令");
    expect(userMsg?.content).toContain("本章标题：雨夜账本");
    expect(userMsg?.content).toContain("当面对质");
  });

  it("retries when the first response is malformed and succeeds on retry", async () => {
    const diagnostics: Parameters<OnPipelineDiagnostic>[0][] = [];
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: "no memo sections here",
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: validMemoRaw(4),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner((diagnostic) => diagnostics.push(diagnostic)).planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 4,
    });

    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(result.memo.episode).toBe(4);
    expect(result.memo.isGoldenOpening).toBe(false);
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      "planner-parse-retry",
    ]);
    expect(diagnostics[0]).toMatchObject({
      agent: "planner",
      phase: "plan",
      bookId: "book-plan-1",
      episodeNumber: 4,
      attempt: 1,
      maxAttempts: 2,
    });

    // Retry prompts must include the failure feedback
    const secondCallArgs = chatSpy.mock.calls[1]!;
    const secondMessages = secondCallArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = secondMessages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("上次输出的错误");
  });

  it("reports the deterministic memo fallback after parse retries are exhausted", async () => {
    const diagnostics: Parameters<OnPipelineDiagnostic>[0][] = [];
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "no memo sections here",
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner((diagnostic) => diagnostics.push(diagnostic)).planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 4,
    });

    expect(result.memo.body).toContain("## Planner warning");
    expect(diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      "planner-parse-retry",
      "planner-parse-retry",
      "planner-fallback",
    ]);
  });

  it("includes exact allowed hook ids when retrying an invalid hook ledger", async () => {
    const invalidHookMemo = validMemoRaw(4).replace(/H03/g, "H03-truncated");
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({ content: invalidHookMemo, usage: ZERO_USAGE } as never)
      .mockResolvedValueOnce({ content: validMemoRaw(4), usage: ZERO_USAGE } as never);

    await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 4,
    });

    const retryMessages = chatSpy.mock.calls[1]?.[2] as ReadonlyArray<{ role: string; content: string }>;
    const retryUserMessage = retryMessages.find((message) => message.role === "user")?.content ?? "";
    expect(retryUserMessage).toContain("允许使用的伏笔 ID");
    expect(retryUserMessage).toContain("- H03");
    expect(retryUserMessage).toContain("- S004");
    expect(retryUserMessage).toContain("不要截断或重组");
  });

  it("skips volume-count metadata when deriving a prose outline node", () => {
    const planner = makePlanner() as unknown as {
      findOutlineNode: (outline: string, episodeNumber: number) => string | undefined;
    };
    const outline = [
      "## 各卷主题与情绪曲线",
      "本书共四卷，每卷约二十章。",
      "第一卷主题是怀疑的诞生，林澈从收到异常广播开始秘密调查。",
    ].join("\n");

    expect(planner.findOutlineNode(outline, 2)).toBe(
      "第一卷主题是怀疑的诞生，林澈从收到异常广播开始秘密调查。",
    );
  });

  // Phase hotfix 4: English books must receive English system + user prompts
  // and English golden-opening guidance for episodes ≤ 3.
  it("uses English prompts end-to-end when book.language is en", async () => {
    const VALID_EN_BODY = `
## Current task
Pin the Door 7 tampering from suspicion to live evidence.

## Episode payoff
The protagonist visibly outmaneuvers the gatekeeper with evidence the audience can verify.

## Incoming state
The protagonist suspects tampering, the gatekeeper controls access, trust is low, the recorder is ready, and evidence collection is unfinished.

## Episode objective
The protagonist must secure physical proof before the camera record is erased because this is the last available window.

## Opposition
The gatekeeper wants to erase the record and can seal the room, cut the lights, and control access.

## Causal escalation
Because deletion is imminent, the protagonist removes the lock; the gatekeeper seals the room; the scratches become proof and force a public confrontation.

## Relationship pressure
Their mutual-use arrangement breaks under leverage, secrecy, and the gatekeeper's control of the exit.

## What the reader is waiting for right now
1) Reader expects to learn whether Door 7 is really compromised.
2) This episode pays it off in full — live evidence on stage.

## To pay off / to keep buried
- Pay off: Door 7 anomaly → live evidence
- Keep buried: the mastermind → push to episode 20

## What the slow / transitional beats carry
n/a — pressure episode, no transitional beats.

## Three-question check on the key choice
- Protagonist's most important choice this episode:
  - Why this choice? It is the only remaining lead.
  - Does it match current interest? Yes.
  - Does it match their persona? Yes.
- Antagonist / supporting cast's most important choice this episode:
  - Why this choice? To cover their tracks.
  - Does it match current interest? Yes.
  - Does it match their persona? Yes.

## Required end-of-episode change
- Information change: protagonist holds live evidence.

## Outgoing pressure
The opponent will publicly accuse the protagonist before dawn because the evidence now threatens the opponent's position.

## Handoff state
The protagonist holds the evidence, the opponent has first-mover authority, their relationship is openly adversarial, the protagonist remains inside Door 7, and must get the evidence out.

## Directional turn
The protagonist shifts from covert verification to direct pressure because the evidence can no longer stay hidden.

## Reversal setup
The audience expects a cautious administrator; repeated avoidance of the same camera frame seeds the contrary possibility.

## Episode reversal
The lock evidence proves the administrator personally altered Door 7 rather than merely following orders.

## Reversal consequence
The opponent loses credibility and the protagonist loses the safety of remaining anonymous.

## Local dramatic result
The protagonist secures live evidence and forces the opponent back, paying with exposure and a sealed exit.

## Information permissions
The protagonist and audience know the lock was tampered with; the opponent suspects partial evidence; the mastermind remains unknown.

## Emotional hook
Will the opponent betray the protagonist before the evidence can be made public?

## End state
The evidence is secured and the relationship changes from cautious cooperation to open opposition.

## Hook ledger for this episode
advance:
- H03 "Door 7 anomaly" → pressured → near_payoff (pinned as live evidence this episode)
defer:
- H07 "the mastermind" → hold until episode 20

## Volume KR binding
- Bind: KR1
- Advancement: Door 7 evidence visibly advances the current volume's gate-ledger investigation.

## Do not
- Do not let the antagonist suddenly turn dumb.
- Do not directly name the mastermind.
`.trim();

    const validEnRaw = `# Episode 1 memo

## Episode goal
Pin Door 7 tampering as live evidence

## Thread refs
- H03

${VALID_EN_BODY}
`;

    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validEnRaw,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const enBook = { ...makeBook(), language: "en" as const };
    const result = await makePlanner().planEpisode({
      book: enBook,
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 1,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.episode).toBe(1);
    expect(result.memo.isGoldenOpening).toBe(true); // ch1 en → also golden (≤5)

    // System prompt must be the English variant
    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === "system");
    const userMsg = messages.find((m) => m.role === "user");

    // English system prompt markers
    expect(systemMsg?.content).toContain("editor-in-chief");
    expect(systemMsg?.content).toContain("Output format (strict)");
    expect(systemMsg?.content).not.toContain("你是这本小说的创作总编");

    // English user template markers
    expect(userMsg?.content).toContain("# Episode 1 memo request");
    expect(userMsg?.content).toContain("Last screen of previous episode");
    expect(userMsg?.content).toContain("Golden opening episode: yes");
    expect(userMsg?.content).not.toContain("# 第 1 章 memo 请求");

    // English golden-opening guidance appended for ch ≤ 3
    expect(userMsg?.content).toContain("Golden Opening Guidance");
    expect(userMsg?.content).toContain("Episode 1");
    expect(userMsg?.content).not.toContain("黄金三章规划指引");
  });

  it("returns a degraded memo instead of throwing when all 3 attempts fail", async () => {
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "permanently broken",
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 2,
    });

    expect(result.memo.episode).toBe(2);
    expect(result.memo.goal.length).toBeGreaterThan(0);
    expect(result.memo.body).toContain("## 当前任务");
    expect(result.memo.body).toContain("## Planner warning");
    expect(result.intentMarkdown).toContain("Planner warning");
  });

  // Phase hotfix 5: planner.intent.mustAvoid must come from the Phase 5
  // authoritative loader (story_frame frontmatter), not from raw
  // book_rules.md — for new-layout books the legacy file is just a shim.
  it("derives intent.mustAvoid from outline/story_frame.md frontmatter (new layout)", async () => {
    // Replace book_rules.md with a Phase 5 compat shim (no YAML, just pointer)
    // and put the authoritative YAML on outline/story_frame.md.
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await writeFile(
      join(storyDir, "outline/story_frame.md"),
      [
        "---",
        "version: \"1.0\"",
        "protagonist:",
        "  name: 阿泽",
        "  personalityLock: []",
        "  behavioralConstraints: []",
        "prohibitions:",
        "  - 禁止主角降智",
        "  - 禁止神化反派",
        "---",
        "",
        "## 主题与基调",
        "调查与压制。",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(storyDir, "book_rules.md"),
      "# 本书规则（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。",
      "utf-8",
    );

    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(2),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planEpisode({
      book: makeBook(),
      bookDir,
      episodeContextSnapshot,
      episodeNumber: 2,
    });

    expect(result.intent.mustAvoid).toContain("禁止主角降智");
    expect(result.intent.mustAvoid).toContain("禁止神化反派");
  });
});
