import { describe, expect, it } from "vitest";
import {
  applyEpisodeRevisionPatch,
  parseEpisodeRevisionPatch,
} from "../utils/episode-revision-patch.js";
import { createEpisodeScript } from "./episode-test-fixtures.js";
import { parseEpisodeScriptOutput } from "../models/episode-script.js";

describe("episode revision patch", () => {
  it("applies a localized shot replacement and contract update", () => {
    const script = createEpisodeScript(2);
    const content = JSON.stringify(script);
    const patch = parseEpisodeRevisionPatch(JSON.stringify({
      episode: 2,
      replaceShots: [{
        sceneId: script.scenes[0]!.id,
        shotId: script.scenes[0]!.shots[0]!.id,
        shot: {
          ...script.scenes[0]!.shots[0]!,
          action: "林岚把怀表放进抽屉，锁上。",
        },
      }],
      updateContract: [{
        path: "localDramaticResult.stateChange",
        value: "怀表已入抽屉并上锁。",
      }],
    }));
    expect(patch).not.toBeNull();

    const result = applyEpisodeRevisionPatch(content, patch!);
    expect(result.applied).toBe(true);
    const parsed = parseEpisodeScriptOutput(result.content, 2);
    expect(parsed.scenes[0]!.shots[0]!.action).toContain("放进抽屉");
    expect(parsed.contract.localDramaticResult.stateChange).toContain("抽屉");
  });

  it("rejects a patch that references an unknown shot id", () => {
    const script = createEpisodeScript(1);
    const patch = parseEpisodeRevisionPatch(JSON.stringify({
      episode: 1,
      replaceShots: [{ sceneId: script.scenes[0]!.id, shotId: "S9-99", shot: script.scenes[0]!.shots[0]! }],
    }));
    const result = applyEpisodeRevisionPatch(JSON.stringify(script), patch!);
    expect(result.applied).toBe(false);
  });

  it("rejects an episode mismatch", () => {
    const script = createEpisodeScript(1);
    const patch = parseEpisodeRevisionPatch(JSON.stringify({ episode: 3 }));
    const result = applyEpisodeRevisionPatch(JSON.stringify(script), patch!);
    expect(result.applied).toBe(false);
  });
});
