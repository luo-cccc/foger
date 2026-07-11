import { describe, expect, it } from "vitest";
import { VolumeAuditorAgent } from "../agents/volume-auditor.js";
import type { ChapterMemo } from "../models/input-governance.js";
import { extractVolumeContracts } from "../utils/volume-contract.js";

describe("VolumeAuditorAgent", () => {
  it("runs the deterministic volume gate behind the Phase 7 volume-auditor agent", () => {
    const contract = extractVolumeContracts([
      "## Volume 1 Harbor Ledger (Chapters 1-10)",
      "Objective: Pin the harbor ledger trail to a named guild.",
      "KR1: Recover the sealed invoice.",
      "Irreversible Event: Mara burns her safe identity at the dock gate.",
    ].join("\n"))[0]!;
    const memo: ChapterMemo = {
      chapter: 3,
      goal: "Hold position",
      isGoldenOpening: false,
      body: "## Volume KR binding\nnone",
      threadRefs: [],
      volumeKrRefs: [],
      volumeKrRationale: "",
    };
    const agent = new VolumeAuditorAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "volume-auditor-model",
      projectRoot: process.cwd(),
    });

    const issues = agent.auditVolumeGate({
      memo,
      contract,
      phase: "pre",
      chapterNumber: 3,
    });

    expect(agent.name).toBe("volume-auditor");
    expect(issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        category: "volume-kr-unbound",
      }),
    ]);
  });
});
