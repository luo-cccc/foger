import { describe, expect, it } from "vitest";
import type { CanonClaim } from "../models/canon.js";
import type { CompiledChapterClaims } from "../utils/chapter-claim-compiler.js";
import { runPostWriteClaimGate, runPreWriteClaimGate } from "../utils/claim-gate.js";

function claim(overrides: Partial<CanonClaim> & Pick<CanonClaim, "id">): CanonClaim {
  return {
    domain: "world",
    claimType: "objective_rule",
    content: "誓契不能替他人偿还。",
    scope: { appliesTo: ["all"] },
    authority: { source: "story_frame", priority: "hard" },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: { requiresCost: [], forbiddenUses: [] },
    ...overrides,
  };
}

function compiled(overrides: Partial<CompiledChapterClaims>): CompiledChapterClaims {
  return {
    chapterNumber: 5,
    usable: [],
    revealNow: [],
    mustHide: [],
    noGeneralize: [],
    costRequired: [],
    conflictResolve: [],
    ...overrides,
  };
}

describe("claim gates", () => {
  it("flags hidden claim references in the chapter memo", () => {
    const secret = claim({
      id: "s-1",
      claimType: "secret_truth",
      content: "宗门高层早已知道真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = runPreWriteClaimGate({
      text: "本章让林月知道 s-1，宗门高层早已知道真相。",
      compiled: compiled({ mustHide: [secret] }),
      phase: "pre",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-character-knowledge-leak" }),
    ]);
  });

  it("surfaces planned reveal claims during pre-write", () => {
    const secret = claim({
      id: "s-1",
      claimType: "secret_truth",
      content: "宗门高层早已知道真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = runPreWriteClaimGate({
      text: "本章揭示 s-1。",
      compiled: compiled({ usable: [secret], revealNow: [secret] }),
      phase: "pre",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", category: "claim-reveal-planned" }),
    ]);
  });

  it("warns when a planned reveal never becomes visible in prose", () => {
    const secret = claim({
      id: "s-1",
      claimType: "secret_truth",
      content: "宗门高层早已知道真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月只是在门外听见风声，却没有真正触到核心秘密。",
      compiled: compiled({ usable: [secret], revealNow: [secret] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", category: "claim-reveal-missing" }),
    ]);
  });

  it(
    "warns when a paraphrase memo commitment to reveal never lands on-page",
    () => {
      const secret = claim({
        id: "s-1",
        claimType: "secret_truth",
        content: "宗门高层早已知道七号门真相。",
        visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
      });
      const compiledCase = compiled({
        usable: [secret],
        // revealNow is populated by the compiler because the memo committed
        // to the reveal in natural language rather than echoing the id.
        mustHide: [],
        revealNow: [secret],
      });
      const issues = runPostWriteClaimGate({
        text: "林月只是在门外听见风声，却没有真正触到核心秘密。",
        compiled: compiledCase,
        phase: "post",
      });
      expect(issues).toEqual([
        expect.objectContaining({ severity: "warning", category: "claim-reveal-missing" }),
      ]);
    },
  );

  it("does not warn when the planned reveal is visible through prose evidence", () => {
    const secret = claim({
      id: "s-2",
      claimType: "secret_truth",
      content: "宗门高层早已知道七号门真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月终于看明白，宗门高层一直知情，七号门根本不是事故。",
      compiled: compiled({ usable: [secret], revealNow: [secret] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-reveal-missing");
  });

  it("flags hidden claim leaks in prose", () => {
    const secret = claim({
      id: "s-1",
      claimType: "secret_truth",
      content: "宗门高层早已知道真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月停在门外，忽然明白宗门高层早已知道真相。",
      compiled: compiled({ mustHide: [secret] }),
      phase: "post",
    });

    expect(issues[0]).toMatchObject({ severity: "critical", category: "claim-character-knowledge-leak" });
  });

  it("keeps reader-only hidden leaks in the generic hidden leak category", () => {
    const secret = claim({
      id: "s-reader",
      claimType: "secret_truth",
      content: "宗门高层早已知道真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: [] },
    });

    const issues = runPostWriteClaimGate({
      text: "叙述旁白提前交代：宗门高层早已知道真相。",
      compiled: compiled({ mustHide: [secret] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-hidden-leak" }),
    ]);
  });

  it("flags hidden claim leaks even when prose only partially restates the claim", () => {
    const secret = claim({
      id: "s-2",
      claimType: "secret_truth",
      content: "宗门高层早已知道七号门真相。",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["林月"] },
    });

    const issues = runPostWriteClaimGate({
      text: "门外的谈话让人意识到：宗门高层一直知情，七号门不是事故。",
      compiled: compiled({ mustHide: [secret] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-hidden-leak" }),
    ]);
  });

  it("flags hidden character-knowledge leaks when excluded POV learns a secret", () => {
    const secret = claim({
      id: "s-3",
      claimType: "secret_truth",
      content: "内城旧契藏在七号门账本里。",
      visibility: { readerKnownFrom: 30, characterKnownBy: ["阿泽"], hiddenFrom: ["林月"] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月终于发现七号门账本，意识到内城旧契藏在那里。",
      compiled: compiled({ mustHide: [secret] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-character-knowledge-leak" }),
    ]);
  });

  it("does not treat hiddenFrom character names alone as hidden claim leaks", () => {
    const secret = claim({
      id: "s-role-name",
      claimType: "secret_truth",
      content: "The violet archive cipher names Master Orin as the route owner.",
      visibility: { readerKnownFrom: 30, characterKnownBy: [], hiddenFrom: ["Mara"] },
    });

    const issues = runPostWriteClaimGate({
      text: "Mara leaves the dock clerk's office with only a rumor.",
      compiled: compiled({ mustHide: [secret] }),
      phase: "post",
    });

    expect(issues).toEqual([]);
  });

  it("flags non-generalizable protagonist exceptions granted to others", () => {
    const exception = claim({
      id: "p-1",
      domain: "protagonist",
      claimType: "character_exception",
      content: "林月能听见誓契铜片的回声。",
      scope: { appliesTo: ["林月"], excludes: ["配角"] },
      authority: { source: "roles/林月", priority: "strong" },
      constraints: {
        nonGeneralizable: true,
        requiresCost: [],
        forbiddenUses: ["配角获得同能力"],
      },
    });

    const issues = runPostWriteClaimGate({
      text: "林月能听见誓契铜片的回声。此后配角获得同能力，人人都能听见铜片。",
      compiled: compiled({ usable: [exception], noGeneralize: [exception] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-non-generalizable" }),
    ]);
  });

  it("flags cost-bound claims when the cost is missing", () => {
    const power = claim({
      id: "pow-1",
      domain: "power",
      content: "林月强行催动誓契铜片。",
      constraints: { requiresCost: ["头痛"], forbiddenUses: [] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月强行催动誓契铜片，门锁随即打开。",
      compiled: compiled({ usable: [power], costRequired: [power] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-cost-missing" }),
    ]);
  });

  it("does not treat appliesTo character names alone as cost-bound claim usage", () => {
    const power = claim({
      id: "pow-role-name",
      domain: "protagonist",
      content: "Mara can hear debt ink when she touches a forged ledger.",
      scope: { appliesTo: ["Mara"] },
      constraints: { requiresCost: ["nosebleed"], forbiddenUses: [] },
    });

    const issues = runPostWriteClaimGate({
      text: "Mara leaves the dock clerk's office with only a rumor.",
      compiled: compiled({ usable: [power], costRequired: [power] }),
      phase: "post",
    });

    expect(issues).toEqual([]);
  });

  it("flags hard prohibitions when text invokes the prohibited content", () => {
    const prohibition = claim({
      id: "ban-1",
      claimType: "prohibition",
      content: "不得出现短篇分支。",
    });

    const issues = runPostWriteClaimGate({
      text: "这一章突然转向短篇分支。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-prohibition" }),
    ]);
  });

  it("does not flag a prohibition merely because prose follows the constrained action", () => {
    const prohibition = claim({
      id: "ban-repair-grind",
      claimType: "prohibition",
      content: "禁止星门修复变成“打怪升级”（每次修复必须推动剧情或角色弧，不能为修复而修复）",
    });

    const issues = runPostWriteClaimGate({
      text: "沈砚修复第一道星纹，失去童年记忆，也从回声里取得姐姐失踪前的线索。城防司随即锁定了他。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-prohibition");
  });

  it("does not ban a contextual subject when the prohibited misuse is absent", () => {
    const prohibition = claim({
      id: "prohibit-quantum-handwave",
      claimType: "prohibition",
      content: "禁止“量子”作为万能解释，所有技术设定必须有逻辑锚点",
    });

    const issues = runPostWriteClaimGate({
      text: "量子雾对记忆的干扰具有实时性。回溯仪验证了哈希签名、时间戳偏移和军用加密频段，林澈据此缩小了信号来源。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-prohibition");
  });

  it("still rejects using a contextual subject as the forbidden handwave", () => {
    const prohibition = claim({
      id: "prohibit-quantum-handwave",
      claimType: "prohibition",
      content: "禁止“量子”作为万能解释，所有技术设定必须有逻辑锚点",
    });

    const issues = runPostWriteClaimGate({
      text: "这一切都可以用量子解释，不需要任何原理、机制或证据。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-prohibition" }),
    ]);
  });

  it("does not flag a prohibition when a memo restates it as negative guidance", () => {
    const prohibition = claim({
      id: "ban-breakthrough",
      claimType: "prohibition",
      content: "禁止沈砚通过“顿悟”或“爆种”解决核心冲突",
    });

    const issues = runPreWriteClaimGate({
      text: "本章禁止沈砚顿悟，也不能让他爆种；修复必须基于已有知识。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "pre",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-prohibition");
  });

  it("still flags an explicit violation of a quoted prohibition target", () => {
    const prohibition = claim({
      id: "ban-repair-grind",
      claimType: "prohibition",
      content: "禁止星门修复变成“打怪升级”（每次修复必须推动剧情或角色弧，不能为修复而修复）",
    });

    const issues = runPostWriteClaimGate({
      text: "从此修复被当成打怪升级：每点亮一道星纹，他就无条件变强一级。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-prohibition" }),
    ]);
  });

  it("flags a high-confidence paraphrase of a progression-loop prohibition", () => {
    const prohibition = claim({
      id: "ban-repair-grind",
      claimType: "prohibition",
      content: "禁止星门修复变成“打怪升级”（每次修复必须推动剧情或角色弧，不能为修复而修复）",
    });

    const issues = runPostWriteClaimGate({
      text: "从此每修复一道星纹，他都会无条件变强一级，不需要发现线索，也没有人物变化。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-prohibition" }),
    ]);
  });

  it("does not confuse an earned one-off advantage with an upgrade loop", () => {
    const prohibition = claim({
      id: "ban-repair-grind",
      claimType: "prohibition",
      content: "禁止星门修复变成“打怪升级”（每次修复必须推动剧情或角色弧，不能为修复而修复）",
    });

    const issues = runPostWriteClaimGate({
      text: "沈砚修复星纹后取得一段坐标线索，因此在追查姐姐时更有胜算，但能力没有自动提升。",
      compiled: compiled({ usable: [prohibition] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-prohibition");
  });

  it("flags institution rules that fail without a grounded exception", () => {
    const rule = claim({
      id: "org-1",
      domain: "organization",
      claimType: "institution_rule",
      content: "内城账房调阅账本必须持有商会令牌。",
      scope: { appliesTo: ["内城账房"], geography: ["内城"] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月走进内城账房，无视商会令牌的规矩，直接调阅账本。",
      compiled: compiled({ usable: [rule] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-institution-rule-bypass" }),
    ]);
  });

  it("accepts institution rule exceptions when authorization is visible", () => {
    const rule = claim({
      id: "org-2",
      domain: "organization",
      claimType: "institution_rule",
      content: "内城账房调阅账本必须持有商会令牌。",
      scope: { appliesTo: ["内城账房"], geography: ["内城"] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月凭借执事特批的授权进入内城账房，调阅账本时交出商会令牌。",
      compiled: compiled({ usable: [rule] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-institution-rule-bypass");
  });

  it("flags hard world rules that are bypassed without the declared cost", () => {
    const hardRule = claim({
      id: "world-1",
      claimType: "objective_rule",
      content: "誓契不能替他人偿还。",
      authority: { source: "story_frame", priority: "hard" },
      constraints: { requiresCost: ["折损寿数"], forbiddenUses: [] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月绕过誓契限制，直接替阿泽偿还欠债，没有任何代价。",
      compiled: compiled({ usable: [hardRule], costRequired: [hardRule] }),
      phase: "post",
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "claim-hard-rule-bypass" }),
      expect.objectContaining({ severity: "critical", category: "claim-cost-missing" }),
    ]);
  });

  it("accepts hard world rule exceptions when the declared cost is paid", () => {
    const hardRule = claim({
      id: "world-2",
      claimType: "objective_rule",
      content: "誓契不能替他人偿还。",
      authority: { source: "story_frame", priority: "hard" },
      constraints: { requiresCost: ["折损寿数"], forbiddenUses: [] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月凭借旧契漏洞替阿泽偿还欠债，但誓契立刻折损寿数作为代价。",
      compiled: compiled({ usable: [hardRule], costRequired: [hardRule] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-hard-rule-bypass");
    expect(issues.map((issue) => issue.category)).not.toContain("claim-cost-missing");
  });

  it("does not flag a bypass from generic narrative adverbs alone", () => {
    // "直接" and similar adverbs are ordinary prose, not a rule-circumvention
    // signal. Mentioning the rule's subject/action while walking "directly"
    // must not fire a hard-rule-bypass critical when nothing is actually bypassed.
    const hardRule = claim({
      id: "world-3",
      claimType: "objective_rule",
      content: "誓契不能替他人偿还。",
      authority: { source: "story_frame", priority: "hard" },
      constraints: { requiresCost: ["折损寿数"], forbiddenUses: [] },
    });

    const issues = runPostWriteClaimGate({
      text: "林月想到誓契的旧事，直接推门走进丹房，仍然打算按规矩偿还自己的欠债。",
      compiled: compiled({ usable: [hardRule], costRequired: [hardRule] }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-hard-rule-bypass");
  });

  it("does not connect unrelated maintenance bypass words to broad world rules elsewhere in the chapter", () => {
    const hardRules = [
      claim({
        id: "world-memory",
        claimType: "objective_rule",
        content: "锚点集团通过维护系统执行排他性的记忆校准，回声体不能生成新记忆。",
        authority: { source: "story_frame", priority: "hard" },
      }),
      claim({
        id: "world-tone",
        claimType: "objective_rule",
        content: "雾港建筑维护系统处于湿冷环境，声音在雾中成为闷响。",
        authority: { source: "story_frame", priority: "hard" },
      }),
      claim({
        id: "world-pov",
        claimType: "objective_rule",
        content: "叙事严格限定在林澈的第三人称有限视角，推理必须有线索。",
        authority: { source: "story_frame", priority: "hard" },
      }),
    ];

    const issues = runPostWriteClaimGate({
      text: [
        "塔基铭牌刻着：S13-废弃-无需维护。",
        "林澈沿着湿冷的雾港街道检查信号参数。",
        "系统把设备老化噪声归入低优先级，无需人工复核。",
        "他依据终端日志和螺栓痕迹继续推理。",
      ].join("\n"),
      compiled: compiled({ usable: hardRules }),
      phase: "post",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("claim-hard-rule-bypass");
  });
});
