import { describe, expect, it } from "vitest";
import { attachEpisodeContextArtifacts, buildEpisodeContextSnapshot } from "../pipeline/episode-context.js";

describe("episode context snapshot", () => {
  it("deduplicates hook aliases and includes operation identity in the hash", () => {
    const snapshot = buildEpisodeContextSnapshot({
      episode: 2,
      model: "deepseek-v4-flash",
      service: "deepseek",
      entries: [
        { source: "runtime/hook_debt#H1", content: "secret" },
        { source: "story/pending_hooks.md#H1", content: "secret" },
        { source: "story/current_state.md", content: "state" },
      ],
    });
    expect(snapshot.entries.map((entry) => entry.source)).toEqual(["hook:H1", "story/current_state.md"]);
    expect(snapshot.duplicateChars).toBe(6);
    expect(snapshot.hash).toHaveLength(64);
  });

  it("attaches governed artifacts without replacing the operation snapshot", () => {
    const snapshot = buildEpisodeContextSnapshot({
      episode: 1,
      model: "stub",
      service: "test",
      entries: [{ source: "story/current_state.md", content: "state" }],
    });
    const originalHash = snapshot.hash;
    const result = attachEpisodeContextArtifacts(snapshot, { intent: "x" } as any, { rules: [] } as any);
    expect(result).toBe(snapshot);
    expect(snapshot.contextPackage).toEqual({ intent: "x" });
    expect(snapshot.ruleStack).toEqual({ rules: [] });
    expect(snapshot.hash).not.toBe(originalHash);
  });
});
