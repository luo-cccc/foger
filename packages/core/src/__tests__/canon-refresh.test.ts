import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectAgent } from "../agents/architect.js";
import { CanonExtractor } from "../agents/canon-extractor.js";
import { CanonClaimSchema } from "../models/canon.js";
import {
  loadClaimsFile,
  loadUnclaimedFacts,
  saveClaimsFile,
  saveUnclaimedFacts,
} from "../state/canon-store.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as const;

function baseClaim(id: string, content: string) {
  return CanonClaimSchema.parse({
    id,
    domain: "world",
    claimType: "objective_rule",
    content,
    scope: { appliesTo: [] },
    authority: { source: "story_frame", priority: "hard" },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: {},
  });
}

describe("canon refresh", () => {
  it("merges new claims from unclaimed facts without duplicating existing ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-refresh-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await saveClaimsFile(bookDir, { claims: [baseClaim("w-1", "旧铁律：钟表不能撒谎。")] });
      await saveUnclaimedFacts(bookDir, {
        version: 1,
        updatedAt: new Date().toISOString(),
        facts: [{ fact: "钟表集团的暗账藏在冷柜后面。", sourceEpisode: 3 }],
      });

      const canonProto = CanonExtractor.prototype as unknown as {
        chat: (...args: unknown[]) => Promise<{ content: string; usage: typeof ZERO_USAGE }>;
      };
      const chatSpy = vi.spyOn(canonProto, "chat").mockResolvedValue({
        content: JSON.stringify({
          claims: [{
            id: "refresh-new",
            domain: "world",
            claimType: "secret_truth",
            content: "钟表集团的暗账藏在冷柜后面。",
            scope: { appliesTo: [] },
            authority: { source: "episode-0003", priority: "strong" },
            visibility: { characterKnownBy: [], hiddenFrom: ["陆时"] },
            constraints: {},
          }],
        }),
        usage: ZERO_USAGE,
      });

      const extractor = new CanonExtractor({
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.2, maxTokens: 4096, thinkingBudget: 0, maxTokensCap: null, extra: {} },
      } as never);
      const result = await extractor.refreshFromUnclaimed(bookDir, "zh");
      expect(result.added).toBe(1);
      const persisted = await loadClaimsFile(bookDir);
      expect(persisted.claims.some((claim) => claim.content.includes("暗账"))).toBe(true);

      // Second refresh with the same facts must not duplicate.
      const second = await extractor.refreshFromUnclaimed(bookDir, "zh");
      expect(second.added).toBe(0);
      chatSpy.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  function makeExtractor(chatContent: string) {
    const canonProto = CanonExtractor.prototype as unknown as {
      chat: (...args: unknown[]) => Promise<{ content: string; usage: typeof ZERO_USAGE }>;
    };
    const chatSpy = vi.spyOn(canonProto, "chat").mockResolvedValue({
      content: chatContent,
      usage: ZERO_USAGE,
    });
    const extractor = new CanonExtractor({
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0.2, maxTokens: 4096, thinkingBudget: 0, maxTokensCap: null, extra: {} },
    } as never);
    return { extractor, chatSpy };
  }

  it("honors the two-stage decisions: reuse and unresolved never enter canon", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-decisions-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await saveClaimsFile(bookDir, { claims: [baseClaim("w-1", "旧铁律：钟表不能撒谎。")] });
      await saveUnclaimedFacts(bookDir, {
        version: 1,
        updatedAt: new Date().toISOString(),
        facts: [
          { fact: "钟表不能撒谎。", sourceEpisode: 4 },
          { fact: "他当时拿走了一样东西。", sourceEpisode: 4 },
          { fact: "暗账的副本有三份。", sourceEpisode: 4 },
        ],
      });

      const { extractor, chatSpy } = makeExtractor(JSON.stringify({
        decisions: [
          { fact: "钟表不能撒谎。", evidenceEpisode: 4, decision: "reuse" },
          { fact: "他当时拿走了一样东西。", evidenceEpisode: 4, decision: "new_asset", unresolvedReference: true },
          { fact: "他当时拿走了一样东西。", evidenceEpisode: 4, decision: "unresolved" },
          {
            fact: "暗账的副本有三份。",
            evidenceEpisode: 4,
            decision: "new_asset",
            claim: {
              id: "refresh-copies",
              domain: "world",
              claimType: "secret_truth",
              content: "暗账的副本有三份。",
              scope: { appliesTo: [] },
              authority: { source: "episode-0004", priority: "strong" },
              visibility: { characterKnownBy: [], hiddenFrom: [] },
              constraints: {},
            },
          },
        ],
      }));

      const result = await extractor.refreshFromUnclaimed(bookDir, "zh");
      expect(result.added).toBe(1);
      const persisted = await loadClaimsFile(bookDir);
      expect(persisted.claims).toHaveLength(2);
      expect(persisted.claims.some((claim) => claim.content.includes("三份"))).toBe(true);
      expect(persisted.claims.some((claim) => claim.content.includes("拿走"))).toBe(false);
      chatSpy.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supersedes the old wording on new_variant and coerces temporary_state away from new_asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-variant-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await saveClaimsFile(bookDir, { claims: [baseClaim("w-1", "陆时的怀表停在三点。")] });
      await saveUnclaimedFacts(bookDir, {
        version: 1,
        updatedAt: new Date().toISOString(),
        facts: [{ fact: "陆时的怀表停在了四点。", sourceEpisode: 5 }],
      });

      const { extractor, chatSpy } = makeExtractor(JSON.stringify({
        decisions: [
          {
            fact: "陆时的怀表停在了四点。",
            evidenceEpisode: 5,
            // temporary_state must be coerced to new_variant even when the
            // model labels it new_asset — temporary states found no identity.
            decision: "new_asset",
            claim: {
              id: "refresh-watch",
              domain: "character",
              claimType: "temporary_state",
              content: "陆时的怀表停在了四点。",
              scope: { appliesTo: ["陆时"] },
              authority: { source: "episode-0005", priority: "soft" },
              visibility: { characterKnownBy: [], hiddenFrom: [] },
              constraints: {},
            },
          },
        ],
      }));

      const result = await extractor.refreshFromUnclaimed(bookDir, "zh");
      expect(result.added).toBe(1);
      const persisted = await loadClaimsFile(bookDir);
      const oldClaim = persisted.claims.find((claim) => claim.id === "w-1")!;
      const newClaim = persisted.claims.find((claim) => claim.id === "refresh-watch")!;
      expect(oldClaim.status).toBe("superseded");
      expect(oldClaim.statusUpdatedAtEpisode).toBe(5);
      expect(newClaim.status).toBe("active");
      chatSpy.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes settled facts from the unclaimed pool and keeps unresolved ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-prune-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await saveClaimsFile(bookDir, { claims: [baseClaim("w-1", "旧铁律：钟表不能撒谎。")] });
      await saveUnclaimedFacts(bookDir, {
        version: 1,
        updatedAt: new Date().toISOString(),
        facts: [
          { fact: "钟表不能撒谎。", sourceEpisode: 4 },
          { fact: "暗账的副本有三份。", sourceEpisode: 4 },
          { fact: "他当时拿走了一样东西。", sourceEpisode: 4 },
          { fact: "模型没有裁决的事实。", sourceEpisode: 4 },
        ],
      });

      const { extractor, chatSpy } = makeExtractor(JSON.stringify({
        decisions: [
          { fact: "钟表不能撒谎。", evidenceEpisode: 4, decision: "reuse" },
          {
            fact: "暗账的副本有三份。",
            evidenceEpisode: 4,
            decision: "new_asset",
            claim: {
              id: "refresh-copies",
              domain: "world",
              claimType: "secret_truth",
              content: "暗账的副本有三份。",
              scope: { appliesTo: [] },
              authority: { source: "episode-0004", priority: "strong" },
              visibility: { characterKnownBy: [], hiddenFrom: [] },
              constraints: {},
            },
          },
          { fact: "他当时拿走了一样东西。", evidenceEpisode: 4, decision: "unresolved" },
        ],
      }));

      await extractor.refreshFromUnclaimed(bookDir, "zh");
      const pool = await loadUnclaimedFacts(bookDir);
      const remaining = pool.facts.map((entry) => entry.fact);
      // reuse / new_asset are settled and leave the pool; unresolved and
      // model-dropped facts stay for the next episode.
      expect(remaining).not.toContain("钟表不能撒谎。");
      expect(remaining).not.toContain("暗账的副本有三份。");
      expect(remaining).toContain("他当时拿走了一样东西。");
      expect(remaining).toContain("模型没有裁决的事实。");
      chatSpy.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("foundation extend", () => {
  it("extracts and validates a rewritten volume_map from the architect call", async () => {
    const volumeMap = [
      "## 第1卷 停摆之夜（第1-10集）",
      "Objective: 陆时查明母亲失踪真相并关闭实验装置。",
      "KR1: 建立午夜电话能力规则并付出第一道刻痕。",
      "KR2: 姜甲亲眼见证能力并找到钟表集团线索。",
      "KR3: 陆时在终局做出不可逆选择。",
      "Irreversible Event: 陆时放弃修复怀表，选择保存记忆。",
      "",
      "### 紧凑篇逐集节拍合同",
      "| 集数 | 目标 | 阻碍 | 转折 | 交付 | 集末钩子 |",
      "|---|---|---|---|---|---|",
      "| 1 | 接听电话 | 怀疑被耍 | 目睹三分钟后 | 救下行人 | 记忆缺失 |",
      "| 2 | 再拨一次 | 线索断裂 | 姜甲入场 | 建立规则 | 刻痕显形 |",
      "| 3 | 验证能力 | 代价出现 | 失去记忆 | 第一道刻痕 | 怀表来历 |",
    ].join("\n");
    const architectProto = ArchitectAgent.prototype as unknown as {
      chat: (...args: unknown[]) => Promise<{ content: string; usage: typeof ZERO_USAGE }>;
    };
    const chatSpy = vi.spyOn(architectProto, "chat").mockResolvedValue({
      content: volumeMap,
      usage: ZERO_USAGE,
    });
    const architect = new ArchitectAgent({
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0.5, maxTokens: 8192, thinkingBudget: 0, maxTokensCap: null, extra: {} },
    } as never);
    const result = await architect.generateVolumeMapExtension({
      book: {
        id: "b",
        title: "B",
        platform: "tomato",
        genre: "urban",
        status: "active",
        schemaVersion: "inkos-episode-v2",
        format: "screenplay",
        targetEpisodes: 10,
        episodeDurationSeconds: 90,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      genreProfile: {
        id: "urban",
        name: "都市",
        language: "zh",
        episodeTypes: [],
        fatigueWords: [],
        numericalSystem: false,
        powerScaling: false,
        eraResearch: false,
        pacingRule: "",
        satisfactionTypes: [],
        auditDimensions: [],
      },
      genreBody: "",
      storyFrame: "陆时能看见停摆日。",
      currentVolumeMap: "",
      targetEpisodes: 10,
      language: "zh",
    });
    expect(result.volumeMap).toContain("第1卷");
    expect(result.volumeMap.length).toBeGreaterThan(100);
    chatSpy.mockRestore();
  });
});
