import { describe, expect, it } from "vitest";
import type { StoredHook } from "../state/memory-db.js";
import {
  computeHookDiagnostics,
  renderHookDiagnosticMarker,
} from "../utils/hook-stale-detection.js";

function hook(overrides: Partial<StoredHook>): StoredHook {
  return {
    hookId: "H01",
    startEpisode: 1,
    type: "主线",
    status: "open",
    lastAdvancedEpisode: 0,
    expectedPayoff: "",
    notes: "",
    ...overrides,
  };
}

describe("computeHookDiagnostics — Phase 7 stale / blocked detection", () => {
  it("flags a hook as stale when distance exceeds half-life and hook is unresolved", () => {
    // near-term default half-life is 10, plant at ch 5, current ch 25 => distance 20 > 10.
    const h = hook({ startEpisode: 5, payoffTiming: "near-term" });
    const diag = computeHookDiagnostics({ hooks: [h], currentEpisode: 25 }).get("H01")!;
    expect(diag.stale).toBe(true);
    expect(diag.distance).toBe(20);
    expect(diag.halfLife).toBe(10);
  });

  it("does NOT flag a hook as stale when distance is within half-life", () => {
    const h = hook({ startEpisode: 5, payoffTiming: "mid-arc" });
    const diag = computeHookDiagnostics({ hooks: [h], currentEpisode: 25 }).get("H01")!;
    expect(diag.stale).toBe(false);
  });

  it("honors explicit halfLifeEpisodes over the timing default", () => {
    const h = hook({
      startEpisode: 5,
      payoffTiming: "near-term", // default 10
      halfLifeEpisodes: 50,
    });
    const diag = computeHookDiagnostics({ hooks: [h], currentEpisode: 30 }).get("H01")!;
    expect(diag.stale).toBe(false); // distance 25 < explicit 50
    expect(diag.halfLife).toBe(50);
  });

  it("never flags a resolved hook as stale", () => {
    const h = hook({ startEpisode: 5, status: "resolved", payoffTiming: "immediate" });
    const diag = computeHookDiagnostics({ hooks: [h], currentEpisode: 90 }).get("H01")!;
    expect(diag.stale).toBe(false);
  });

  it("flags a hook as blocked when its depends_on upstream is unplanted", () => {
    const downstream = hook({
      hookId: "H-down",
      startEpisode: 10,
      dependsOn: ["H-up"],
    });
    // upstream missing entirely
    const diag = computeHookDiagnostics({
      hooks: [downstream],
      currentEpisode: 20,
    }).get("H-down")!;
    expect(diag.blocked).toBe(true);
    expect(diag.missingUpstream).toEqual(["H-up"]);
  });

  it("flags a hook as blocked when the upstream is planted but unresolved", () => {
    const upstream = hook({ hookId: "H-up", startEpisode: 3, status: "open" });
    const downstream = hook({
      hookId: "H-down",
      startEpisode: 10,
      dependsOn: ["H-up"],
    });
    const result = computeHookDiagnostics({
      hooks: [upstream, downstream],
      currentEpisode: 20,
    });
    expect(result.get("H-down")!.blocked).toBe(true);
    expect(result.get("H-up")!.blocked).toBe(false);
  });

  it("clears the blocked flag once every upstream is resolved", () => {
    const upstream = hook({ hookId: "H-up", startEpisode: 3, status: "resolved" });
    const downstream = hook({
      hookId: "H-down",
      startEpisode: 10,
      dependsOn: ["H-up"],
    });
    const result = computeHookDiagnostics({
      hooks: [upstream, downstream],
      currentEpisode: 20,
    });
    expect(result.get("H-down")!.blocked).toBe(false);
    expect(result.get("H-down")!.missingUpstream).toEqual([]);
  });

  it("pre-planting seeds (startEpisode 0) are not marked stale", () => {
    const h = hook({ startEpisode: 0, payoffTiming: "immediate" });
    const diag = computeHookDiagnostics({ hooks: [h], currentEpisode: 50 }).get("H01")!;
    expect(diag.stale).toBe(false);
  });

  it("renderHookDiagnosticMarker formats zh / en markers correctly", () => {
    // Hotfix 3: marker now embeds blocked distance (已阻 N 集 / blocked N episodes)
    // so the reviewer can apply the 5/6-episode threshold directly.
    const diag = {
      stale: true,
      blocked: true,
      missingUpstream: ["H-up"],
      distance: 20,
      halfLife: 10,
      blockedDistance: 7,
    } as const;
    expect(renderHookDiagnosticMarker(diag, "zh")).toBe(
      "过期 (距=20/半衰=10); 受阻于 H-up (已阻 7 集)",
    );
    expect(renderHookDiagnosticMarker(diag, "en")).toBe(
      "stale (d=20/half=10); blocked on H-up (blocked 7 episodes)",
    );
  });

  it("renders empty marker when nothing is flagged", () => {
    const diag = {
      stale: false,
      blocked: false,
      missingUpstream: [],
      distance: 1,
      halfLife: 10,
      blockedDistance: 0,
    } as const;
    expect(renderHookDiagnosticMarker(diag, "zh")).toBe("");
    expect(renderHookDiagnosticMarker(diag, "en")).toBe("");
  });
});
