import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChapterMemo } from "../models/input-governance.js";
import type { CanonClaim } from "../models/canon.js";
import {
  compileChapterClaims,
  saveChapterClaimArtifacts,
  type CompiledChapterClaims,
} from "../utils/chapter-claim-compiler.js";
import {
  detectVisibleRevealClaimIds,
  runPostWriteClaimGate,
  runPreWriteClaimGate,
} from "../utils/claim-gate.js";
import { recordReaderClaimReveals, type ClaimVisibilityState } from "../state/claim-visibility.js";
import { saveClaimsFile } from "../state/canon-store.js";
import { validateHookLedger } from "../utils/hook-ledger-validator.js";
import {
  detectAttemptedKrRefs,
  detectVisibleKrRefs,
  extractVolumeContracts,
  recordVisibleVolumeProgress,
  recordVolumeProgressEntry,
  runVolumeGate,
  saveVolumeContractArtifacts,
} from "../utils/volume-contract.js";
import type { VolumeContractFile, VolumeProgressFile } from "../models/volume-contract.js";

interface CorpusChapter {
  readonly chapter: number;
  readonly pov: string;
  readonly memo: ChapterMemo;
  readonly prose: string;
}

interface CorpusCase {
  readonly name: string;
  readonly volumeMap: string;
  readonly claims: ReadonlyArray<CanonClaim>;
  readonly chapters: ReadonlyArray<CorpusChapter>;
}

interface CorpusIssueSummary {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
}

interface CorpusRunResult {
  readonly perChapterIssues: Record<number, CorpusIssueSummary[]>;
  readonly progress: VolumeProgressFile;
  readonly dashboard: string;
  readonly claimVisibility: ClaimVisibilityState | null;
}

const LEDGER_CASE: CorpusCase = {
  name: "three-chapter ledger arc",
  volumeMap: [
    "# Volume Map",
    "",
    "## Volume 1 Harbor Ledger (Chapters 1-3)",
    "Objective: Pin the harbor ledger trail to a named guild.",
    "KR1: Recover the sealed invoice.",
    "KR2: Force the guild clerk to make a visible mistake.",
    "KR3: Connect the invoice to the mentor disappearance.",
    "Protagonist Stage Goal: Mara moves from courier to named claimant.",
    "Foreground Goal: Win the archive tribunal contest.",
    "Background Thread: The guild debt engine is tied to the mentor disappearance.",
    "World Rule Releases: Dock seals record custody, not truth.",
    "Relationship Tensions: Mara and Joss cooperate while hiding incompatible debts.",
    "Hook Debts: violet archive origin",
    "Irreversible Event: Mara burns her safe identity at the dock gate.",
  ].join("\n"),
  claims: [
    {
      id: "world-dock-seals",
      domain: "world",
      claimType: "objective_rule",
      content: "Dock seals record custody, not truth.",
      scope: { appliesTo: ["all"] },
      authority: { source: "story_frame", priority: "hard" },
      visibility: { characterKnownBy: [], hiddenFrom: [] },
      constraints: { requiresCost: [], forbiddenUses: [] },
    },
    {
      id: "mara-ledger-sense",
      domain: "protagonist",
      claimType: "character_exception",
      content: "Mara can hear debt ink when she touches a forged ledger.",
      scope: { appliesTo: ["Mara"] },
      authority: { source: "roles/Mara", priority: "strong" },
      visibility: { characterKnownBy: ["Mara"], hiddenFrom: [] },
      constraints: {
        nonGeneralizable: true,
        requiresCost: [],
        forbiddenUses: ["anyone else hears debt ink"],
      },
    },
    {
      id: "secret-mentor-route",
      domain: "history",
      claimType: "secret_truth",
      content: "The violet archive cipher names Master Orin as the route owner.",
      scope: { appliesTo: ["all"] },
      authority: { source: "volume_map", priority: "hard" },
      visibility: { readerKnownFrom: 5, characterKnownBy: [], hiddenFrom: [] },
      constraints: { requiresCost: [], forbiddenUses: [] },
    },
  ],
  chapters: [
    {
      chapter: 1,
      pov: "Mara",
      memo: {
        chapter: 1,
        goal: "Recover the sealed invoice.",
        isGoldenOpening: false,
        body: [
          "POV: Mara",
          "## Volume KR binding",
          "KR1",
          "## Hook ledger for this chapter",
          "open:",
          "- [new] sealed invoice origin -> someone moved the invoice before Mara arrived",
          "advance:",
          "- invoice-clue \"sealed invoice\" -> recovered at the dock",
          "resolve:",
          "- none",
        ].join("\n"),
        threadRefs: ["invoice-clue"],
        volumeKrRefs: ["KR1"],
        volumeKrRationale: "Recover the sealed invoice.",
      },
      prose: "Mara recovered the sealed invoice at the dock, and the sealed invoice origin pointed to a missing courier.",
    },
    {
      chapter: 2,
      pov: "Mara",
      memo: {
        chapter: 2,
        goal: "Force the guild clerk to make a visible mistake.",
        isGoldenOpening: false,
        body: [
          "POV: Mara",
          "## Volume KR binding",
          "KR2",
          "## Hook ledger for this chapter",
          "open:",
          "- [new] clerk stamp order -> the second stamp came from inside the guild",
          "advance:",
          "- clerk-error \"guild clerk\" -> clerk contradicts the dock seal",
          "resolve:",
          "- none",
        ].join("\n"),
        threadRefs: ["clerk-error"],
        volumeKrRefs: ["KR2"],
        volumeKrRationale: "Force the guild clerk to make a visible mistake.",
      },
      prose: [
        "Mara touched the forged ledger and heard debt ink under the guild clerk's signature before she spoke.",
        "She forced the guild clerk to make a visible mistake when he contradicted the dock seal.",
      ].join(" "),
    },
    {
      chapter: 3,
      pov: "Mara",
      memo: {
        chapter: 3,
        goal: "Connect the invoice to the mentor disappearance and end the volume.",
        isGoldenOpening: false,
        body: [
          "POV: Mara",
          "## Volume KR binding",
          "KR3",
          "This chapter reveals the violet archive cipher names Master Orin as the route owner.",
          "## Hook ledger for this chapter",
          "open:",
          "- [new] tribunal patron -> the patron knows why the archive tribunal contest was rigged",
          "advance:",
          "- mentor-route \"mentor disappearance\" -> invoice points to the missing mentor",
          "resolve:",
          "- invoice-origin \"violet archive origin\" -> the dock clerk names the route",
        ].join("\n"),
        threadRefs: ["mentor-route", "secret-mentor-route"],
        volumeKrRefs: ["KR3"],
        volumeKrRationale: "Connect the invoice to the mentor disappearance.",
      },
      prose: [
        "The violet archive cipher names Master Orin as the route owner, and Mara connected the invoice to the mentor disappearance.",
        "Dock seals record custody, not truth, so the archive tribunal contest turns on who held the paper.",
        "Mara and Joss cooperate while hiding incompatible debts; she moves from courier to named claimant.",
        "The guild debt engine is tied to the mentor disappearance and explains the violet archive origin.",
        "Mara burns her safe identity at the dock gate.",
      ].join(" "),
    },
  ],
};

const BROKEN_LEDGER_CASE: CorpusCase = {
  ...LEDGER_CASE,
  name: "broken ledger arc with missing closeout",
  chapters: [
    ...LEDGER_CASE.chapters.slice(0, 2),
    {
      chapter: 3,
      pov: "Mara",
      memo: {
        chapter: 3,
        goal: "Connect the invoice to the mentor disappearance and end the volume.",
        isGoldenOpening: false,
        body: [
          "POV: Mara",
          "## Volume KR binding",
          "KR3",
          "This chapter reveals the violet archive cipher names Master Orin as the route owner.",
          "## Hook ledger for this chapter",
          "open:",
          "- none",
          "advance:",
          "- mentor-route \"mentor disappearance\" -> invoice points to the missing mentor",
          "resolve:",
          "- invoice-origin \"violet archive origin\" -> the dock clerk names the route",
        ].join("\n"),
        threadRefs: ["mentor-route", "secret-mentor-route"],
        volumeKrRefs: ["KR3"],
        volumeKrRationale: "Connect the invoice to the mentor disappearance.",
      },
      prose: [
        "Mara leaves the dock clerk's office with only a rumor.",
        "The missing-teacher case remains unresolved, and she keeps her courier papers for another day.",
      ].join(" "),
    },
  ],
};

describe("long-form governance corpus", () => {
  it("keeps claims, hooks, and volume progress coherent across a multi-chapter fixture", async () => {
    await withCorpusBook(LEDGER_CASE, async (bookDir) => {
      const result = await runCorpusCase(bookDir, LEDGER_CASE);

      expect(criticalCategoriesByChapter(result.perChapterIssues)).toEqual({
        1: [],
        2: [],
        3: [],
      });

      await expect(readFile(join(bookDir, "story", "runtime", "chapter-0001.claim-brief.md"), "utf-8"))
        .resolves.toContain("secret-mentor-route");
      await expect(readFile(join(bookDir, "story", "runtime", "chapter-0003.claim-brief.md"), "utf-8"))
        .resolves.toContain("本章计划揭示");

      expect(result.progress.entries).toEqual([
        expect.objectContaining({ chapter: 1, krRefs: ["KR1"], visibleKrRefs: ["V1-KR1"] }),
        expect.objectContaining({ chapter: 2, krRefs: ["KR2"], visibleKrRefs: ["V1-KR2"] }),
        expect.objectContaining({ chapter: 3, krRefs: ["KR3"], visibleKrRefs: ["V1-KR3"] }),
      ]);

      expect(result.dashboard).toContain("| V1-KR1 | advanced | ch1 | ch1 | - | Recover the sealed invoice. |");
      expect(result.dashboard).toContain("| V1-KR2 | advanced | ch2 | ch2 | - | Force the guild clerk to make a visible mistake. |");
      expect(result.dashboard).toContain("| V1-KR3 | done | ch3 | ch3 | - | Connect the invoice to the mentor disappearance. |");

      expect(result.claimVisibility?.revealedToReader).toEqual([
        expect.objectContaining({ claimId: "secret-mentor-route", revealedAtChapter: 3 }),
      ]);
    });
  });

  it("surfaces accumulated governance failures in a broken multi-chapter fixture", async () => {
    await withCorpusBook(BROKEN_LEDGER_CASE, async (bookDir) => {
      const result = await runCorpusCase(bookDir, BROKEN_LEDGER_CASE);
      const chapterThreeCategories = result.perChapterIssues[3]?.map((issue) => issue.category) ?? [];

      expect(chapterThreeCategories).toEqual(expect.arrayContaining([
        "claim-reveal-missing",
        "hook 账揭 1 埋 1 违规",
        "volume-kr-not-visible",
        "volume-end-kr-incomplete",
        "volume-end-irreversible-missing",
      ]));
      expect(result.progress.entries[2]).toEqual(
        expect.objectContaining({ chapter: 3, krRefs: ["KR3"], visibleKrRefs: [] }),
      );
      expect(result.dashboard).toContain("| V1-KR3 | pending | ch3 | - | - | Connect the invoice to the mentor disappearance. |");
      expect(result.claimVisibility).toBeNull();
    });
  });
});

async function runCorpusCase(bookDir: string, testCase: CorpusCase): Promise<CorpusRunResult> {
  const contracts = extractVolumeContracts(testCase.volumeMap);
  expect(contracts).toHaveLength(1);
  const contract = contracts[0]!;
  const contractFile: VolumeContractFile = {
    version: 1,
    source: "story/outline/volume_map.md",
    generatedAt: "2026-07-08T00:00:00.000Z",
    contracts,
  };
  await saveVolumeContractArtifacts(bookDir, contractFile);
  await saveClaimsFile(bookDir, { claims: [...testCase.claims] });

  let visibility: ClaimVisibilityState = {
    version: 1,
    updatedAt: "2026-07-08T00:00:00.000Z",
    revealedToReader: [],
  };
  const perChapterIssues: Record<number, CorpusIssueSummary[]> = {};

  for (const chapter of testCase.chapters) {
    const compiled = compileChapterClaims(testCase.claims, {
      chapterNumber: chapter.chapter,
      pov: chapter.pov,
      memo: chapter.memo.body,
      activeHookIds: chapter.memo.threadRefs,
      revealedClaimIds: visibility.revealedToReader.map((entry) => entry.claimId),
    });
    await saveChapterClaimArtifacts(bookDir, compiled, {
      chapterNumber: chapter.chapter,
      pov: chapter.pov,
      memo: chapter.memo.body,
      activeHookIds: chapter.memo.threadRefs,
      revealedClaimIds: visibility.revealedToReader.map((entry) => entry.claimId),
    });

    const progressBefore = await readProgress(bookDir);
    const preIssues = [
      ...runPreWriteClaimGate({ text: chapter.memo.body, compiled, phase: "pre" }),
      ...runVolumeGate({
        memo: chapter.memo,
        contract,
        phase: "pre",
        progress: progressBefore,
        chapterNumber: chapter.chapter,
        miniCycleWindow: 3,
      }),
    ];
    const postIssues = [
      ...runPostWriteClaimGate({ text: chapter.prose, compiled, phase: "post" }),
      ...validateHookLedger(chapter.memo.body, chapter.prose),
      ...runVolumeGate({
        memo: chapter.memo,
        contract,
        phase: "post",
        text: chapter.prose,
        progress: progressBefore,
        chapterNumber: chapter.chapter,
        miniCycleWindow: 3,
      }),
    ];

    perChapterIssues[chapter.chapter] = [...preIssues, ...postIssues]
      .map((issue) => ({ severity: issue.severity, category: issue.category }));

    await recordVolumeProgressEntry(bookDir, {
      chapter: chapter.chapter,
      volumeId: contract.volumeId,
      volumeNumber: contract.volumeNumber,
      krRefs: chapter.memo.volumeKrRefs ?? [],
      rationale: chapter.memo.volumeKrRationale ?? "",
      memoGoal: chapter.memo.goal,
      recordedAt: `2026-07-08T00:0${chapter.chapter}:00.000Z`,
    });
    await recordVisibleVolumeProgress(bookDir, {
      chapter: chapter.chapter,
      contract,
      visibleKrRefs: detectVisibleKrRefs(contract, chapter.prose),
      attemptedKrRefs: detectAttemptedKrRefs(contract, chapter.prose),
      recordedAt: `2026-07-08T00:1${chapter.chapter}:00.000Z`,
    });

    const visibleRevealIds = detectVisibleRevealClaimIds({ text: chapter.prose, compiled });
    if (visibleRevealIds.length > 0) {
      visibility = await recordReaderClaimReveals(bookDir, {
        chapter: chapter.chapter,
        claimIds: visibleRevealIds,
        recordedAt: `2026-07-08T00:2${chapter.chapter}:00.000Z`,
      });
    }
  }

  return {
    perChapterIssues,
    progress: await readProgress(bookDir),
    dashboard: await readFile(join(bookDir, "story", "runtime", "volume-dashboard.md"), "utf-8"),
    claimVisibility: visibility.revealedToReader.length > 0 ? visibility : null,
  };
}

function criticalCategoriesByChapter(
  perChapterIssues: Record<number, ReadonlyArray<CorpusIssueSummary>>,
): Record<number, string[]> {
  return Object.fromEntries(
    Object.entries(perChapterIssues).map(([chapter, issues]) => [
      Number(chapter),
      issues.filter((issue) => issue.severity === "critical").map((issue) => issue.category),
    ]),
  );
}

async function withCorpusBook(testCase: CorpusCase, run: (bookDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "inkos-long-form-governance-"));
  try {
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await mkdir(join(storyDir, "runtime"), { recursive: true });
    await writeFile(join(storyDir, "outline", "volume_map.md"), testCase.volumeMap, "utf-8");
    await run(bookDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readProgress(bookDir: string): Promise<VolumeProgressFile> {
  try {
    return JSON.parse(await readFile(join(bookDir, "story", "runtime", "volume-progress.json"), "utf-8")) as VolumeProgressFile;
  } catch {
    return { version: 1, generatedAt: "2026-07-08T00:00:00.000Z", entries: [] };
  }
}
