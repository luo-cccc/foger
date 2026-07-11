import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectAttemptedKrRefs,
  detectVisibleKrRefs,
  extractVolumeContracts,
  recordVisibleVolumeProgress,
  recordVolumeProgressEntry,
  renderVolumeContractBrief,
  renderVolumeDashboard,
  runVolumeGate,
} from "../utils/volume-contract.js";
import type { ChapterMemo } from "../models/input-governance.js";

describe("volume contract", () => {
  it("extracts Objective, KRs, irreversible event, and chapter range from volume_map", () => {
    const contracts = extractVolumeContracts([
      "# Volume Map",
      "",
      "## 第一卷 暗账初开（第1-40章）",
      "Objective: 林月把七号门异常从传闻钉成内城账本入口。",
      "KR1: 拿到七号门被动过手脚的现场实证。",
      "KR2: 让阿泽从旁观者变成共同担责者。",
      "KR3: 锁定内城旧契与师门失踪之间的账本通道。",
      "卷尾不可逆事件：林月公开撕下杂役腰牌，失去退回外门的可能。",
    ].join("\n"));

    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      volumeId: "volume-001",
      volumeNumber: 1,
      title: "暗账初开（第1-40章）",
      chapterStart: 1,
      chapterEnd: 40,
      objective: "林月把七号门异常从传闻钉成内城账本入口。",
      irreversibleEvent: "林月公开撕下杂役腰牌，失去退回外门的可能。",
    });
    expect(contracts[0]!.keyResults.map((kr) => kr.id)).toEqual(["V1-KR1", "V1-KR2", "V1-KR3"]);
  });

  it("extracts volume-level supply fields for stage, world, relationship, and hook governance", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-20)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "KR3: Connect the invoice to the mentor disappearance.",
      "Protagonist Stage Goal: Mara moves from courier to named claimant.",
      "Foreground Goal: Win the archive tribunal contest.",
      "Background Thread: The guild debt engine is tied to the mentor's disappearance.",
      "World Rule Releases:",
      "- Dock seals record custody, not truth.",
      "- Guild ledgers cannot erase burned witnesses.",
      "Relationship Tensions: Mara and Joss must cooperate while hiding incompatible debts; the clerk starts testing Mara's identity.",
      "Hook Debts:",
      "- sealed invoice origin",
      "- mentor ledger route",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;

    expect(contract).toMatchObject({
      protagonistStageGoal: "Mara moves from courier to named claimant.",
      foregroundGoal: "Win the archive tribunal contest.",
      backgroundThread: "The guild debt engine is tied to the mentor's disappearance.",
      worldRuleReleases: [
        "Dock seals record custody, not truth.",
        "Guild ledgers cannot erase burned witnesses.",
      ],
      relationshipTensions: [
        "Mara and Joss must cooperate while hiding incompatible debts",
        "the clerk starts testing Mara's identity.",
      ],
      hookDebts: ["sealed invoice origin", "mentor ledger route"],
    });

    const brief = renderVolumeContractBrief(contract);
    expect(brief).toContain("protagonistStageGoal: Mara moves from courier to named claimant.");
    expect(brief).toContain("worldRuleReleases: Dock seals record custody, not truth. / Guild ledgers cannot erase burned witnesses.");

    const dashboard = renderVolumeDashboard({
      version: 1,
      source: "story/outline/volume_map.md",
      generatedAt: "2026-07-08T00:00:00.000Z",
      contracts: [contract],
    }, {
      version: 1,
      generatedAt: "2026-07-08T00:00:00.000Z",
      entries: [],
    });
    expect(dashboard).toContain("### Volume supply");
    expect(dashboard).toContain("hookDebts: sealed invoice origin / mentor ledger route");
  });

  it("warns when a memo neither binds a KR nor explains a transition", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-20)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "KR3: Connect the invoice to the mentor disappearance.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "Meet the clerk",
      isGoldenOpening: false,
      body: "## Volume KR binding\nnone",
      threadRefs: [],
      volumeKrRefs: [],
      volumeKrRationale: "",
    };

    const issues = runVolumeGate({ memo, contract, phase: "pre" });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", category: "volume-kr-unbound" }),
    ]);
  });

  it("accepts a buffer rationale when no KR is bound", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "Cross the harbor",
      isGoldenOpening: false,
      body: "## Volume KR binding\nbuffer",
      threadRefs: [],
      volumeKrRefs: [],
      volumeKrRationale: "buffer chapter that stages the dock route for the next invoice recovery",
    };

    expect(runVolumeGate({ memo, contract, phase: "pre" })).toEqual([]);
  });

  it("detects visible Chinese KR advancement from partial prose restatements", () => {
    const contract = extractVolumeContracts([
      "## 第一卷 暗账初开（第1-5章）",
      "Objective: 林月把七号门异常从传闻钉成内城账本入口。",
      "KR1: 拿到七号门被动过手脚的现场实证。",
      "卷尾不可逆事件：林月公开撕下杂役腰牌，失去退回外门的可能。",
    ].join("\n"))[0]!;

    expect(detectVisibleKrRefs(
      contract,
      "林月在七号门墙缝里找到现场实证，证明机关确实被人动过手脚。",
    )).toEqual(["V1-KR1"]);
  });

  it("accepts Chinese irreversible volume-end events from partial prose restatements", () => {
    const contract = extractVolumeContracts([
      "## 第一卷 暗账初开（第1-5章）",
      "Objective: 林月把七号门异常从传闻钉成内城账本入口。",
      "KR1: 拿到七号门被动过手脚的现场实证。",
      "卷尾不可逆事件：林月公开撕下杂役腰牌，失去退回外门的可能。",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "结束第一卷",
      isGoldenOpening: false,
      body: "## Volume KR binding\nKR1",
      threadRefs: [],
      volumeKrRefs: ["KR1"],
      volumeKrRationale: "拿到七号门现场实证。",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 5,
      text: "林月在七号门墙缝里找到现场实证，证明机关确实被人动过手脚。随后她当众扯碎杂役腰牌，从此不能退回外门。",
    });

    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-irreversible-missing");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-kr-incomplete");
  });

  it("warns when a 3-5 chapter mini-cycle has no KR advancement", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-20)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "Hold position",
      isGoldenOpening: false,
      body: "## Volume KR binding\nbuffer",
      threadRefs: [],
      volumeKrRefs: [],
      volumeKrRationale: "buffer chapter that delays the invoice recovery",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "pre",
      chapterNumber: 5,
      miniCycleWindow: 5,
      progress: {
        version: 1,
        generatedAt: "2026-07-08T00:00:00.000Z",
        entries: [1, 2, 3, 4].map((chapter) => ({
          chapter,
          volumeId: contract.volumeId,
          volumeNumber: contract.volumeNumber,
          krRefs: [],
          visibleKrRefs: [],
          attemptedKrRefs: [],
          rationale: "buffer",
          memoGoal: `buffer ${chapter}`,
          recordedAt: "2026-07-08T00:00:00.000Z",
        })),
      },
    });

    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", category: "volume-mini-cycle-stalled" }),
    ]);
  });

  it("blocks volume end when KRs or the irreversible event are missing", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "End the volume",
      isGoldenOpening: false,
      body: "## Volume KR binding\nKR1",
      threadRefs: [],
      volumeKrRefs: ["KR1"],
      volumeKrRationale: "Recover the sealed invoice.",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 5,
      text: "Mara recovered the sealed invoice and left the dock quietly.",
      progress: {
        version: 1,
        generatedAt: "2026-07-08T00:00:00.000Z",
        entries: [{
          chapter: 3,
          volumeId: contract.volumeId,
          volumeNumber: contract.volumeNumber,
          krRefs: ["KR1"],
          visibleKrRefs: [],
          attemptedKrRefs: [],
          rationale: "Recover the sealed invoice.",
          memoGoal: "invoice",
          recordedAt: "2026-07-08T00:00:00.000Z",
        }],
      },
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "critical", category: "volume-end-kr-incomplete" }),
      expect.objectContaining({ severity: "critical", category: "volume-end-irreversible-missing" }),
    ]));
  });

  it("does not re-fire the volume-end gate on chapters past the planned end", () => {
    // Volume planned as chapters 1-5. When writing overruns (chapter 6+) and the
    // contract is reused for out-of-range chapters, the volume-end critical suite
    // must NOT fire again — it belongs to the last chapter only.
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 6,
      goal: "Transition beat after the volume climax",
      isGoldenOpening: false,
      body: "## Volume KR binding\nbuffer",
      threadRefs: [],
      volumeKrRefs: [],
      volumeKrRationale: "cool-down chapter after the volume already ended at chapter 5",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 6,
      // Prose deliberately mentions none of the KRs / irreversible event.
      text: "Mara walked the quiet harbor at dawn, thinking about what came next.",
    });

    const categories = issues.map((issue) => issue.category);
    expect(categories).not.toContain("volume-end-kr-incomplete");
    expect(categories).not.toContain("volume-end-irreversible-missing");
    expect(categories).not.toContain("volume-end-protagonist-stage-missing");
  });

  it("accepts volume end when every KR is recorded and the irreversible event is visible", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "End the volume",
      isGoldenOpening: false,
      body: "## Volume KR binding\nKR2",
      threadRefs: [],
      volumeKrRefs: ["KR2"],
      volumeKrRationale: "Force the guild clerk to make a visible mistake.",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 5,
      text: "Mara forced the guild clerk to make a visible mistake, then burns her safe identity at the dock gate.",
      progress: {
        version: 1,
        generatedAt: "2026-07-08T00:00:00.000Z",
        entries: [{
          chapter: 3,
          volumeId: contract.volumeId,
          volumeNumber: contract.volumeNumber,
          krRefs: ["KR1"],
          visibleKrRefs: ["KR1"],
          attemptedKrRefs: [],
          rationale: "Recover the sealed invoice.",
          memoGoal: "invoice",
          recordedAt: "2026-07-08T00:00:00.000Z",
        }],
      },
    });

    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-kr-incomplete");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-irreversible-missing");
  });

  it("warns at volume end when stage, world, relationship, and hook supplies are missing", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "Protagonist Stage Goal: Mara moves from courier to named claimant.",
      "Foreground Goal: Win the archive tribunal contest.",
      "Background Thread: The guild debt engine is tied to the mentor disappearance.",
      "World Rule Releases: Dock seals record custody, not truth.",
      "Relationship Tensions: Mara and Joss cooperate while hiding incompatible debts.",
      "Hook Debts: mentor ledger route",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "End the volume",
      isGoldenOpening: false,
      body: "## Volume KR binding\nKR1",
      threadRefs: [],
      volumeKrRefs: ["KR1"],
      volumeKrRationale: "Recover the sealed invoice.",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 5,
      text: "Mara recovered the sealed invoice, then burns her safe identity at the dock gate.",
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", category: "volume-end-protagonist-stage-missing" }),
      expect.objectContaining({ severity: "warning", category: "volume-end-foreground-goal-missing" }),
      expect.objectContaining({ severity: "warning", category: "volume-end-background-thread-missing" }),
      expect.objectContaining({ severity: "warning", category: "volume-end-world-rule-release-missing" }),
      expect.objectContaining({ severity: "warning", category: "volume-end-relationship-tension-missing" }),
      expect.objectContaining({ severity: "warning", category: "volume-end-hook-debt-missing" }),
    ]));
  });

  it("accepts visible volume-end supplies when the prose lands them", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "Protagonist Stage Goal: Mara moves from courier to named claimant.",
      "Foreground Goal: Win the dock-gate ledger contest.",
      "Background Thread: The guild debt engine is tied to the mentor disappearance.",
      "World Rule Releases: Dock seals record custody, not truth.",
      "Relationship Tensions: Mara and Joss cooperate while hiding incompatible debts.",
      "Hook Debts: mentor ledger route",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "End the volume",
      isGoldenOpening: false,
      body: "## Volume KR binding\nKR1",
      threadRefs: [],
      volumeKrRefs: ["KR1"],
      volumeKrRationale: "Recover the sealed invoice.",
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 5,
      text: [
        "Mara recovered the sealed invoice and moved from courier to named claimant.",
        "She won the dock-gate ledger contest because dock seals record custody, not truth.",
        "The guild debt engine tied the mentor disappearance to the mentor ledger route.",
        "Mara and Joss cooperated while hiding incompatible debts, then Mara burns her safe identity at the dock gate.",
      ].join(" "),
    });

    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-protagonist-stage-missing");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-foreground-goal-missing");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-background-thread-missing");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-world-rule-release-missing");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-relationship-tension-missing");
    expect(issues.map((issue) => issue.category)).not.toContain("volume-end-hook-debt-missing");
  });

  it("renders a dashboard and dynamic KR statuses from progress", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const progress = {
      version: 1 as const,
      generatedAt: "2026-07-08T00:00:00.000Z",
      entries: [
        {
          chapter: 2,
          volumeId: contract.volumeId,
          volumeNumber: contract.volumeNumber,
          krRefs: ["KR1"],
          visibleKrRefs: ["KR1"],
          attemptedKrRefs: [],
          rationale: "invoice recovered",
          memoGoal: "recover invoice",
          recordedAt: "2026-07-08T00:00:00.000Z",
        },
        {
          chapter: 5,
          volumeId: contract.volumeId,
          volumeNumber: contract.volumeNumber,
          krRefs: ["KR2"],
          visibleKrRefs: ["KR2"],
          attemptedKrRefs: [],
          rationale: "clerk mistake forced",
          memoGoal: "force clerk mistake",
          recordedAt: "2026-07-08T00:00:00.000Z",
        },
      ],
    };

    const brief = renderVolumeContractBrief(contract, progress);
    expect(brief).toContain("V1-KR1: Recover the sealed invoice. [advanced] visible=2");
    expect(brief).toContain("V1-KR2: Force the guild clerk to make a visible mistake. [done] visible=5");

    const dashboard = renderVolumeDashboard({
      version: 1,
      source: "story/outline/volume_map.md",
      generatedAt: "2026-07-08T00:00:00.000Z",
      contracts: [contract],
    }, progress);
    expect(dashboard).toContain("# Volume Dashboard");
    expect(dashboard).toContain("| V1-KR1 | advanced | ch2 | ch2 | - | Recover the sealed invoice. |");
    expect(dashboard).toContain("| V1-KR2 | done | ch5 | ch5 | - | Force the guild clerk to make a visible mistake. |");
    expect(dashboard).toContain("- ch5: planned=KR2 visible=KR2 attempted=- | force clerk mistake | clerk mistake forced");
  });

  it("records failed-but-meaningful KR attempts without completing the KR", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-5)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "KR2: Force the guild clerk to make a visible mistake.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const failedAttemptText = "Mara tried to recover the sealed invoice, but failed to recover it when the clerk burned the copy.";
    const memo: ChapterMemo = {
      chapter: 5,
      goal: "End the volume",
      isGoldenOpening: false,
      body: "## Volume KR binding\nKR1",
      threadRefs: [],
      volumeKrRefs: ["KR1"],
      volumeKrRationale: "Recover the sealed invoice.",
    };

    expect(detectVisibleKrRefs(contract, failedAttemptText)).toEqual([]);
    expect(detectAttemptedKrRefs(contract, failedAttemptText)).toEqual(["V1-KR1"]);

    const progress = {
      version: 1 as const,
      generatedAt: "2026-07-08T00:00:00.000Z",
      entries: [{
        chapter: 4,
        volumeId: contract.volumeId,
        volumeNumber: contract.volumeNumber,
        krRefs: ["KR1"],
        visibleKrRefs: [],
        attemptedKrRefs: ["KR1"],
        rationale: "failed invoice recovery",
        memoGoal: "try invoice recovery",
        recordedAt: "2026-07-08T00:00:00.000Z",
      }],
    };

    const issues = runVolumeGate({
      memo,
      contract,
      phase: "post",
      chapterNumber: 5,
      text: `${failedAttemptText} Mara burns her safe identity at the dock gate.`,
      progress,
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "critical", category: "volume-end-kr-incomplete" }),
    ]));

    const dashboard = renderVolumeDashboard({
      version: 1,
      source: "story/outline/volume_map.md",
      generatedAt: "2026-07-08T00:00:00.000Z",
      contracts: [contract],
    }, progress);
    expect(dashboard).toContain("| V1-KR1 | attempted | ch4 | - | ch4 | Recover the sealed invoice. |");
    expect(dashboard).toContain("- ch4: planned=KR1 visible=- attempted=KR1 | try invoice recovery | failed invoice recovery");
  });

  it("records visible KR refs without losing planned memo bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-volume-progress-"));
    try {
      const bookDir = join(root, "book");
      const storyDir = join(bookDir, "story");
      const runtimeDir = join(storyDir, "runtime");
      await mkdir(runtimeDir, { recursive: true });
      const contract = extractVolumeContracts([
        "## Volume 1 Harbor Ledger (Chapters 1-5)",
        "Objective: Pin the harbor ledger trail to a named guild.",
        "KR1: Recover the sealed invoice.",
        "KR2: Force the guild clerk to make a visible mistake.",
        "Irreversible Event: Mara burns her safe identity at the dock gate.",
      ].join("\n"))[0]!;
      await writeFile(join(runtimeDir, "volume-contracts.json"), `${JSON.stringify({
        version: 1,
        source: "story/outline/volume_map.md",
        generatedAt: "2026-07-08T00:00:00.000Z",
        contracts: [contract],
      }, null, 2)}\n`, "utf-8");

      await recordVolumeProgressEntry(bookDir, {
        chapter: 2,
        volumeId: contract.volumeId,
        volumeNumber: contract.volumeNumber,
        krRefs: ["KR1"],
        rationale: "planned invoice beat",
        memoGoal: "recover invoice",
        recordedAt: "2026-07-08T00:00:00.000Z",
      });
      await recordVisibleVolumeProgress(bookDir, {
        chapter: 2,
        contract,
        visibleKrRefs: ["KR1"],
        recordedAt: "2026-07-08T01:00:00.000Z",
      });

      const progress = JSON.parse(await readFile(join(runtimeDir, "volume-progress.json"), "utf-8"));
      expect(progress.entries[0]).toMatchObject({
        chapter: 2,
        krRefs: ["KR1"],
        visibleKrRefs: ["KR1"],
        attemptedKrRefs: [],
        memoGoal: "recover invoice",
      });
      await expect(readFile(join(runtimeDir, "volume-dashboard.md"), "utf-8")).resolves.toContain(
        "| V1-KR1 | advanced | ch2 | ch2 | - | Recover the sealed invoice. |",
      );
      await expect(readFile(join(runtimeDir, `${contract.volumeId}.dashboard.md`), "utf-8")).resolves.toContain(
        "# Volume Dashboard: volume-001 Harbor Ledger (Chapters 1-5)",
      );
      await expect(readFile(join(runtimeDir, `${contract.volumeId}.dashboard.md`), "utf-8")).resolves.toContain(
        "| V1-KR1 | advanced | ch2 | ch2 | - | Recover the sealed invoice. |",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
