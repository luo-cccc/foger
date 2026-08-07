import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WriterAgent } from "../agents/writer.js";
import { EpisodeScriptSchema } from "../models/episode-script.js";

const context = {
  client: {
    provider: "openai" as const,
    apiFormat: "chat" as const,
    stream: false,
    defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
  },
  model: "test-model",
  projectRoot: "/tmp/inkos-writer-episode-persistence",
};

function script() {
  return EpisodeScriptSchema.parse({
    episode: 1,
    title: "断电证词",
    estimatedDurationSeconds: 90,
    openingHook: "停电后，证人从监控死角走出。",
    reversal: "证人故意制造停电，反转了被胁迫的判断，并因此暴露出口。",
    emotionalHook: "她会把唯一的出口交给谁？",
    endState: "证人与主角的同盟变成互相要挟。",
    contract: {
      incomingState: { knowledge: ["停电即将发生"], power: ["证人掌握钥匙"], relationship: ["临时同盟"], physical: ["主角受伤"], activeAction: ["寻找出口"] },
      objective: { character: "主角", desiredChange: "拿到证词", whyNow: "警报即将恢复" },
      opposition: { actorOrConstraint: "证人", goal: "带证词离开", leverage: "出口钥匙" },
      causalEscalation: [{ becauseOf: "停电遮蔽监控", choice: "主角追上证人", countermove: "证人锁住出口", stateChange: "证人掌握主动权", nextPressure: "主角必须说服证人开门" }],
      localDramaticResult: { goalOutcome: "拿到半份证词", stateChange: "同盟变成互相要挟", costPaid: "主角暴露受伤状态" },
      outgoingPressure: { startedDecisionDangerOrQuestion: "证人会把出口交给谁", whyItFollows: "证人已经拿到钥匙并看见主角伤势" },
      handoffState: { knowledge: ["证人故意制造停电"], power: ["证人掌握出口"], relationship: ["同盟变成互相要挟"], physical: ["主角受伤"], activeAction: ["说服证人开门"] },
      informationPermissions: [{ subject: "停电真相", audience: "观众和主角", known: ["主角"], suspected: ["证人"], mistaken: ["警方"], unknown: ["幕后买家"] }],
    },
    scenes: [{
      id: "S1",
      location: "地下档案室",
      time: "夜/内",
      purpose: "逼迫双方争夺证词",
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `S1-${index + 1}`,
        shotSize: "近景",
        camera: "缓慢推进",
        durationSeconds: 15,
        visual: `钥匙在第 ${index + 1} 个镜头中不断换手。`,
        action: "双方争夺钥匙",
        dialogue: [],
        sound: "警报声",
      })),
    }],
  });
}

describe("structured episode persistence", () => {
  it("writes screenplay artifacts under episodes without creating chapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-episode-save-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(join(bookDir, "story"), { recursive: true });
      const agent = new WriterAgent(context);
      await agent.saveChapter(bookDir, {
        chapterNumber: 1,
        title: "断电证词",
        content: "# 第1集 断电证词",
        wordCount: 1,
        episodeScript: script(),
        episodePerformanceReport: {
          episode: 1,
          operationId: "operation-1",
          elapsedMs: 1200,
          calls: { planner: 1, writer: 1, auditor: 0, reviser: 0, recovery: 0 },
          retries: 0,
          promptTokens: 120,
          completionTokens: 80,
          totalTokens: 200,
          contextEstimatedTokens: 150,
          contextDuplicateChars: 0,
          cacheHits: 1,
          cacheMisses: 1,
          status: "ok",
        },
        preWriteCheck: "",
        postSettlement: "",
        updatedState: "(状态卡未更新)",
        updatedLedger: "",
        updatedHooks: "(伏笔池未更新)",
        chapterSummary: "",
        updatedSubplots: "",
        updatedEmotionalArcs: "",
        updatedCharacterMatrix: "",
        postWriteErrors: [],
        postWriteWarnings: [],
      });
      await expect(readdir(join(bookDir, "chapters"))).rejects.toThrow();
      expect(await readdir(join(bookDir, "episodes"))).toEqual(expect.arrayContaining([
        "0001_断电证词.md",
        "0001_断电证词.json",
      ]));
      expect(JSON.parse(await readFile(join(bookDir, "story", "runtime", "episode-0001.performance.json"), "utf8")))
        .toMatchObject({ episode: 1, totalTokens: 200 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back episode files when a later artifact write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-episode-rollback-"));
    try {
      const bookDir = join(root, "book");
      const storyDir = join(bookDir, "story");
      await mkdir(storyDir, { recursive: true });
      await writeFile(join(storyDir, "current_state.md"), "existing state", "utf8");
      await writeFile(join(storyDir, "pending_hooks.md"), "existing hooks", "utf8");
      await mkdir(join(storyDir, "particle_ledger.md"), { recursive: true });
      const agent = new WriterAgent(context);
      await expect(agent.saveChapter(bookDir, {
        chapterNumber: 1,
        title: "断电证词",
        content: "# 第1集 断电证词",
        wordCount: 1,
        episodeScript: script(),
        episodePerformanceReport: {
          episode: 1,
          operationId: "operation-rollback",
          elapsedMs: 1200,
          calls: { planner: 1, writer: 1, auditor: 0, reviser: 0, recovery: 0 },
          retries: 0,
          promptTokens: 120,
          completionTokens: 80,
          totalTokens: 200,
          contextEstimatedTokens: 150,
          contextDuplicateChars: 0,
          cacheHits: 1,
          cacheMisses: 1,
          status: "ok",
        },
        preWriteCheck: "",
        postSettlement: "",
        updatedState: "(状态卡未更新)",
        updatedLedger: "ledger",
        updatedHooks: "(伏笔池未更新)",
        chapterSummary: "",
        updatedSubplots: "",
        updatedEmotionalArcs: "",
        updatedCharacterMatrix: "",
        postWriteErrors: [],
        postWriteWarnings: [],
      })).rejects.toThrow();
      expect(await readdir(join(bookDir, "episodes"))).toEqual([]);
      await expect(readFile(join(storyDir, "runtime", "episode-0001.performance.json"), "utf8"))
        .rejects.toThrow();
      expect(await readFile(join(storyDir, "current_state.md"), "utf8")).toBe("existing state");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
