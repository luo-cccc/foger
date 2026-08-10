import { describe, expect, it } from "vitest";
import {
  buildGovernanceOverviewSections,
  latestRuntimeEpisode,
  latestRuntimeVolume,
  pickGovernanceOverviewTargets,
} from "./governance-overview";

describe("pickGovernanceOverviewTargets", () => {
  it("selects the latest episode loop and aggregate volume files", () => {
    const targets = pickGovernanceOverviewTargets([
      { name: "runtime/tier2_current_arc.md" },
      { name: "runtime/volume-dashboard.md" },
      { name: "runtime/volume-progress.json" },
      { name: "runtime/volume-contracts.json" },
      { name: "runtime/episode-0006.intent.md" },
      { name: "runtime/episode-0006.context.json" },
      { name: "runtime/episode-0006.claim-brief.md" },
      { name: "runtime/episode-0006.rule-stack.yaml" },
      { name: "runtime/episode-0006.trace.json" },
      { name: "runtime/episode-0005.intent.md" },
    ]);

    expect(targets).toEqual([
      { kind: "current_arc", name: "runtime/tier2_current_arc.md" },
      { kind: "volume_dashboard", name: "runtime/volume-dashboard.md" },
      { kind: "volume_progress", name: "runtime/volume-progress.json" },
      { kind: "volume_contracts", name: "runtime/volume-contracts.json" },
      { kind: "episode_intent", name: "runtime/episode-0006.intent.md" },
      { kind: "episode_context", name: "runtime/episode-0006.context.json" },
      { kind: "episode_claim_brief", name: "runtime/episode-0006.claim-brief.md" },
      { kind: "episode_rule_stack", name: "runtime/episode-0006.rule-stack.yaml" },
      { kind: "episode_trace", name: "runtime/episode-0006.trace.json" },
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
  it("groups overview cards into volume and episode governance", () => {
    const sections = buildGovernanceOverviewSections([
      { name: "runtime/tier2_current_arc.md" },
      { name: "runtime/volume-dashboard.md" },
      { name: "runtime/volume-progress.json" },
      { name: "runtime/volume-contracts.json" },
      { name: "runtime/episode-0008.intent.md" },
      { name: "runtime/episode-0008.context.json" },
      { name: "runtime/episode-0008.claim-brief.md" },
      { name: "runtime/episode-0008.rule-stack.yaml" },
      { name: "runtime/episode-0008.trace.json" },
    ]);

    expect(sections).toEqual([
      expect.objectContaining({ id: "volume", status: "complete", missing: [] }),
      expect.objectContaining({ id: "episode", status: "complete", missing: [] }),
    ]);
  });

  it("marks missing latest episode artifacts as partial coverage", () => {
    const sections = buildGovernanceOverviewSections([
      { name: "runtime/episode-0008.intent.md" },
      { name: "runtime/episode-0008.trace.json" },
    ]);

    expect(sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "episode",
        status: "partial",
        missing: expect.arrayContaining([
          "runtime/episode-0008.context.json",
          "runtime/episode-0008.claim-brief.md",
          "runtime/episode-0008.rule-stack.yaml",
        ]),
      }),
    ]));
  });
});

describe("latestRuntimeEpisode", () => {
  it("returns the highest padded episode number", () => {
    expect(latestRuntimeEpisode([
      { name: "runtime/episode-0003.intent.md" },
      { name: "runtime/episode-0011.trace.json" },
      { name: "runtime/episode-0009.claim-brief.md" },
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
