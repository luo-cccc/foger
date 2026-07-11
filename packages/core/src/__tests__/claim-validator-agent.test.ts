import { describe, expect, it } from "vitest";
import { ClaimValidatorAgent } from "../agents/claim-validator.js";
import type { CanonClaim } from "../models/canon.js";
import { compileChapterClaims } from "../utils/chapter-claim-compiler.js";

function claim(overrides: Partial<CanonClaim> & Pick<CanonClaim, "id">): CanonClaim {
  return {
    domain: "world",
    claimType: "objective_rule",
    content: "一个客观规则。",
    scope: { appliesTo: ["all"] },
    authority: { source: "story_frame", priority: "hard" },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
    ...overrides,
  };
}

function createAgent(): ClaimValidatorAgent {
  return new ClaimValidatorAgent({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
    },
    model: "claim-validator-model",
    projectRoot: process.cwd(),
  });
}

describe("ClaimValidatorAgent", () => {
  it("runs deterministic canon validation behind the Phase 7 claim-validator agent", () => {
    const agent = createAgent();

    const issues = agent.validateCanonClaims({
      claims: [
        claim({
          id: "p-1",
          domain: "protagonist",
          claimType: "character_exception",
          content: "主角能听到器物低语。",
        }),
      ],
    });

    expect(agent.name).toBe("claim-validator");
    expect(issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "exception_not_non_generalizable",
        claimId: "p-1",
      }),
    ]);
  });

  it("runs deterministic pre-write claim gate checks through the agent", () => {
    const agent = createAgent();
    const claims = [
      claim({
        id: "s-1",
        claimType: "secret_truth",
        content: "宗门高层早已知道真相。",
        visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
      }),
    ];
    const compiled = compileChapterClaims(claims, {
      chapterNumber: 4,
      pov: "林月",
      memo: "本章让林月直接确认 s-1，宗门高层早已知道真相。",
      activeHookIds: [],
    });

    const issues = agent.runPreWriteClaimGate({
      text: "本章让林月直接确认 s-1，宗门高层早已知道真相。",
      compiled,
      phase: "pre",
    });

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        category: "claim-reveal-planned",
      }),
    ]);
  });

  it("runs deterministic post-write reveal checks through the agent", () => {
    const agent = createAgent();
    const reveal = claim({
      id: "s-2",
      claimType: "secret_truth",
      content: "宗门高层早已知道七号门真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = agent.runPostWriteClaimGate({
      text: "林月只觉得有人在隐瞒，却没有真正触到核心秘密。",
      compiled: compileChapterClaims([reveal], {
        chapterNumber: 4,
        pov: "林月",
        memo: "本章揭示 s-2，宗门高层早已知道七号门真相。",
        activeHookIds: ["s-2"],
      }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        category: "claim-reveal-missing",
      }),
    ]);
  });
});
