import { describe, expect, it } from "vitest";
import {
  buildGovernanceOverviewSections,
  latestRuntimeChapter,
  latestRuntimeVolume,
  pickGovernanceOverviewTargets,
} from "./governance-overview";

describe("pickGovernanceOverviewTargets", () => {
  it("selects the latest chapter loop and aggregate volume files", () => {
    const targets = pickGovernanceOverviewTargets([
      { name: "runtime/tier2_current_arc.md" },
      { name: "runtime/volume-dashboard.md" },
      { name: "runtime/volume-progress.json" },
      { name: "runtime/volume-contracts.json" },
      { name: "runtime/chapter-0006.intent.md" },
      { name: "runtime/chapter-0006.context.json" },
      { name: "runtime/chapter-0006.claim-brief.md" },
      { name: "runtime/chapter-0006.rule-stack.yaml" },
      { name: "runtime/chapter-0006.trace.json" },
      { name: "runtime/chapter-0005.intent.md" },
    ]);

    expect(targets).toEqual([
      { kind: "current_arc", name: "runtime/tier2_current_arc.md" },
      { kind: "volume_dashboard", name: "runtime/volume-dashboard.md" },
      { kind: "volume_progress", name: "runtime/volume-progress.json" },
      { kind: "volume_contracts", name: "runtime/volume-contracts.json" },
      { kind: "chapter_intent", name: "runtime/chapter-0006.intent.md" },
      { kind: "chapter_context", name: "runtime/chapter-0006.context.json" },
      { kind: "chapter_claim_brief", name: "runtime/chapter-0006.claim-brief.md" },
      { kind: "chapter_rule_stack", name: "runtime/chapter-0006.rule-stack.yaml" },
      { kind: "chapter_trace", name: "runtime/chapter-0006.trace.json" },
    ]);
  });

  it("falls back to the latest per-volume dashboard when aggregate dashboard is absent", () => {
    const targets = pickGovernanceOverviewTargets([
      { name: "runtime/volume-001.dashboard.md" },
      { name: "runtime/volume-002.dashboard.md" },
    ]);

    expect(targets).toEqual([
      { kind: "volume_dashboard", name: "runtime/volume-002.dashboard.md" },
    ]);
  });
});

describe("buildGovernanceOverviewSections", () => {
  it("groups overview cards into volume and chapter governance", () => {
    const sections = buildGovernanceOverviewSections([
      { name: "runtime/tier2_current_arc.md" },
      { name: "runtime/volume-dashboard.md" },
      { name: "runtime/volume-progress.json" },
      { name: "runtime/volume-contracts.json" },
      { name: "runtime/chapter-0008.intent.md" },
      { name: "runtime/chapter-0008.context.json" },
      { name: "runtime/chapter-0008.claim-brief.md" },
      { name: "runtime/chapter-0008.rule-stack.yaml" },
      { name: "runtime/chapter-0008.trace.json" },
    ]);

    expect(sections).toEqual([
      expect.objectContaining({ id: "volume", status: "complete", missing: [] }),
      expect.objectContaining({ id: "chapter", status: "complete", missing: [] }),
    ]);
  });

  it("marks missing latest chapter artifacts as partial coverage", () => {
    const sections = buildGovernanceOverviewSections([
      { name: "runtime/chapter-0008.intent.md" },
      { name: "runtime/chapter-0008.trace.json" },
    ]);

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "chapter",
        status: "partial",
        missing: expect.arrayContaining([
          "runtime/chapter-0008.context.json",
          "runtime/chapter-0008.claim-brief.md",
          "runtime/chapter-0008.rule-stack.yaml",
        ]),
      }),
    ]));
  });
});

describe("latestRuntimeChapter", () => {
  it("returns the highest padded chapter number", () => {
    expect(latestRuntimeChapter([
      { name: "runtime/chapter-0003.intent.md" },
      { name: "runtime/chapter-0011.trace.json" },
      { name: "runtime/chapter-0009.claim-brief.md" },
    ])).toBe("0011");
  });
});

describe("latestRuntimeVolume", () => {
  it("returns the highest padded volume number", () => {
    expect(latestRuntimeVolume([
      { name: "runtime/volume-001.contract.json" },
      { name: "runtime/volume-003.dashboard.md" },
      { name: "runtime/volume-002.dashboard.md" },
    ])).toBe("003");
  });
});
