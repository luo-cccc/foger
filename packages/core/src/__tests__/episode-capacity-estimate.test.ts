import { describe, expect, it } from "vitest";
import {
  buildEpisodeCapacityBaseline,
  estimateEpisodeCapacityFromPlan,
  summarizeMemoCapacityCommitments,
  EPISODE_CAPACITY_MIN_SAMPLES,
} from "../pipeline/episode-capacity-estimate.js";

function sample(overrides: Partial<{
  shotCount: number;
  spokenCharacters: number;
  narrationCharacters: number;
  estimatedDurationSeconds: number;
}> = {}) {
  return {
    shotCount: overrides.shotCount ?? 9,
    spokenCharacters: overrides.spokenCharacters ?? 540,
    narrationCharacters: overrides.narrationCharacters ?? 90,
    estimatedDurationSeconds: overrides.estimatedDurationSeconds ?? 90,
  };
}

describe("buildEpisodeCapacityBaseline", () => {
  it("skips when fewer than 3 accepted episodes exist", () => {
    expect(buildEpisodeCapacityBaseline([])).toBeUndefined();
    expect(buildEpisodeCapacityBaseline([sample(), sample()])).toBeUndefined();
    const baseline = buildEpisodeCapacityBaseline([sample(), sample(), sample()]);
    expect(baseline).toBeDefined();
    expect(baseline!.sampleSize).toBe(EPISODE_CAPACITY_MIN_SAMPLES);
  });

  it("computes per-shot character and second ratios", () => {
    const baseline = buildEpisodeCapacityBaseline([
      sample({ shotCount: 10, spokenCharacters: 600, narrationCharacters: 100, estimatedDurationSeconds: 100 }),
      sample({ shotCount: 8, spokenCharacters: 480, narrationCharacters: 80, estimatedDurationSeconds: 80 }),
      sample({ shotCount: 12, spokenCharacters: 720, narrationCharacters: 120, estimatedDurationSeconds: 120 }),
    ]);
    expect(baseline).toBeDefined();
    // 2100 chars / 30 shots = 70 chars per shot; 300s / 30 shots = 10s per shot
    expect(baseline!.avgCharactersPerShot).toBeCloseTo(70);
    expect(baseline!.avgSecondsPerShot).toBeCloseTo(10);
  });

  it("ignores samples without shots", () => {
    const baseline = buildEpisodeCapacityBaseline([
      sample({ shotCount: 0, spokenCharacters: 0, narrationCharacters: 0, estimatedDurationSeconds: 0 }),
      sample(), sample(), sample(),
    ]);
    expect(baseline!.sampleSize).toBe(3);
  });
});

describe("estimateEpisodeCapacityFromPlan", () => {
  const baseline = buildEpisodeCapacityBaseline([sample(), sample(), sample()])!;
  // baseline: 70 chars/shot, 10s/shot

  it("stays silent for plan text within one episode's magnitude", () => {
    // 560 chars → 8 shots / 80s — inside 6-12 shots
    const estimate = estimateEpisodeCapacityFromPlan("纲".repeat(560), baseline);
    expect(estimate.deviation).toBe("within");
    expect(estimate.note).toBeUndefined();
    expect(estimate.estimatedShots).toBeCloseTo(8);
    expect(estimate.estimatedDurationSeconds).toBe(80);
  });

  it("notes an over-magnitude plan (≥2× shot budget)", () => {
    // 3150 chars → 45 shots / 450s — over 40-shot and 300s magnitude lines
    const estimate = estimateEpisodeCapacityFromPlan("纲".repeat(3150), baseline);
    expect(estimate.deviation).toBe("over");
    expect(estimate.note).toBeDefined();
    expect(estimate.note!.zh).toContain("容量提示");
    expect(estimate.note!.zh).toContain("这不是质量门槛");
    expect(estimate.note!.en).toContain("Not a quality gate");
  });

  it("notes an under-magnitude plan (≤½ shot budget)", () => {
    // 210 chars → 3 shots / 30s — under the 3-shot / 45s magnitude lines
    const estimate = estimateEpisodeCapacityFromPlan("纲".repeat(210), baseline);
    expect(estimate.deviation).toBe("under");
    expect(estimate.note).toBeDefined();
    expect(estimate.note!.zh).toContain("过薄");
  });

  it("ignores whitespace when measuring plan volume", () => {
    const compact = estimateEpisodeCapacityFromPlan("纲纲纲", baseline);
    const spaced = estimateEpisodeCapacityFromPlan("纲 纲\n纲 ", baseline);
    expect(compact.planCharacters).toBe(3);
    expect(spaced.planCharacters).toBe(3);
    expect(spaced.estimatedShots).toBe(compact.estimatedShots);
  });
});

describe("summarizeMemoCapacityCommitments", () => {
  it("counts scene intents and causal chains", () => {
    const summary = summarizeMemoCapacityCommitments({
      sceneLimit: 2,
      causalEscalation: "因为A → 选择B → 反制C → 变化D → 压力E\n因为F → 选择G → 反制H → 变化I → 压力J",
    });
    expect(summary.scenes).toBe(2);
    expect(summary.causalChains).toBe(2);
    expect(summary.promisedBeats).toBe(4);
    expect(summary.note).toBeUndefined();
  });

  it("notes when promised beats exceed the shot budget", () => {
    const chains = Array.from({ length: 20 }, (_, i) => `因为${i} → 选择 → 反制 → 变化 → 压力`).join("\n");
    const summary = summarizeMemoCapacityCommitments({ sceneLimit: 2, causalEscalation: chains });
    expect(summary.promisedBeats).toBe(22);
    expect(summary.note).toBeDefined();
    expect(summary.note!.zh).toContain("容量提示");
    expect(summary.note!.zh).toContain("不是质量门槛");
    expect(summary.note!.en).toContain("not a quality gate");
  });

  it("handles a memo without escalation text", () => {
    const summary = summarizeMemoCapacityCommitments({});
    expect(summary).toMatchObject({ scenes: 1, causalChains: 0, promisedBeats: 1 });
    expect(summary.note).toBeUndefined();
  });
});
