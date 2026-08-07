import { describe, expect, it } from "vitest";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EpisodeScriptSchema } from "../models/episode-script.js";
import { auditEpisodeScript } from "../pipeline/episode-quality-gate.js";
import { buildEpisodeHandoffCapsule, recoverEpisodeHandoffCapsule } from "../pipeline/episode-handoff.js";
import {
  buildEpisodeReviewEvidence,
  loadEpisodeReviewEvidence,
} from "../pipeline/episode-review-evidence.js";
import { deriveEpisodeRuntimeDelta } from "../state/episode-runtime.js";

function script(episode: number) {
  const incoming = {
    knowledge: [`knowledge-${episode}`],
    power: [`power-${episode}`],
    relationship: [`relationship-${episode}`],
    physical: [`physical-${episode}`],
    activeAction: [`action-${episode}`],
  };
  return EpisodeScriptSchema.parse({
    episode,
    title: `Episode ${episode}`,
    estimatedDurationSeconds: 90,
    openingHook: "A sealed door opens by itself.",
    reversal: "The witness was not trapped; she chose the trap to expose the guard.",
    emotionalHook: "Will the guard betray her before the alarm sounds?",
    endState: `The alliance changes after episode ${episode}.`,
    contract: {
      incomingState: incoming,
      objective: { character: "hero", desiredChange: "secure proof", whyNow: "the alarm is armed" },
      opposition: { actorOrConstraint: "guard", goal: "erase proof", leverage: "the locked room" },
      causalEscalation: [{
        becauseOf: "the witness leaves a visible mark",
        choice: "the hero follows the mark",
        countermove: "the guard seals the exit",
        stateChange: "the proof is secured",
        nextPressure: "the alarm will expose the hero",
      }],
      localDramaticResult: { goalOutcome: "partial success", stateChange: "the proof is secured", costPaid: "the hero loses cover" },
      outgoingPressure: { startedDecisionDangerOrQuestion: "the alarm will expose the hero", whyItFollows: "securing proof triggers the alarm" },
      handoffState: {
        knowledge: [`knowledge-${episode + 1}`],
        power: [`power-${episode + 1}`],
        relationship: [`relationship-${episode + 1}`],
        physical: [`physical-${episode + 1}`],
        activeAction: [`action-${episode + 1}`],
      },
      informationPermissions: [{ subject: "the proof", audience: "the audience sees the mark", known: ["hero"], suspected: ["guard"], mistaken: ["alarm system"], unknown: ["the buyer"] }],
    },
    scenes: [{
      id: "S1",
      location: "sealed room",
      time: "night",
      purpose: "force the proof and the choice",
      shots: Array.from({ length: 6 }, (_, index) => ({
        id: `S1-${index + 1}`,
        shotSize: "close",
        camera: "static",
        durationSeconds: 15,
        visual: `The mark is visible in shot ${index + 1}.`,
        action: index === 5 ? "The hero pockets the proof." : "The hero advances.",
        dialogue: [],
        sound: "alarm hum",
      })),
    }],
  });
}

describe("episode contract runtime", () => {
  it("requires the structured contract", () => {
    expect(() => EpisodeScriptSchema.parse({
      episode: 1,
      title: "missing contract",
      estimatedDurationSeconds: 90,
      openingHook: "A visible hook.",
      reversal: "A prepared reversal with a consequence.",
      emotionalHook: "Who will choose?",
      endState: "The relationship changes.",
      scenes: [],
    })).toThrow(/contract/iu);
  });

  it("flags handoff mismatch as a critical structural issue", () => {
    const previous = script(1);
    const current = {
      ...script(2),
      contract: {
        ...script(2).contract,
        incomingState: { ...script(2).contract.incomingState, knowledge: ["wrong incoming fact"] },
      },
    };
    const issues = auditEpisodeScript(current, previous);
    expect(issues.some((issue) => issue.category === "handoff-state-mismatch" && issue.severity === "critical")).toBe(true);
  });

  it("rebuilds a stale handoff capsule from the current JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-handoff-"));
    try {
      const current = script(1);
      const source = JSON.stringify(current);
      const stale = buildEpisodeHandoffCapsule(current, "old-json");
      const runtimeDir = join(root, "story", "runtime");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "episode-0001-handoff.json"), JSON.stringify(stale), "utf8");
      const recovered = await recoverEpisodeHandoffCapsule({ bookDir: root, script: current, sourceContent: source });
      expect(recovered.scriptHash).not.toBe(stale.scriptHash);
      expect(JSON.parse(await readFile(join(runtimeDir, "episode-0001-handoff.json"), "utf8")).scriptHash).toBe(recovered.scriptHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks review findings stale when the reviewed JSON changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-review-"));
    try {
      const current = script(1);
      const original = JSON.stringify(current);
      const evidence = buildEpisodeReviewEvidence({
        artifact: "episodes/0001_Episode_1.json",
        content: original,
        issues: [{ severity: "critical", category: "missing-local-payoff", description: "payoff missing", suggestion: "add payoff" }],
      });
      await mkdir(join(root, "episodes"), { recursive: true });
      await writeFile(join(root, "episodes", "0001_review.json"), JSON.stringify(evidence), "utf8");
      const refreshed = await loadEpisodeReviewEvidence({ bookDir: root, episode: 1, currentContent: `${original}\nchanged` });
      expect(refreshed?.status).toBe("REVISE");
      expect(refreshed?.findings[0]?.status).toBe("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives screenplay state without an LLM settlement call", () => {
    const current = script(1);
    const delta = deriveEpisodeRuntimeDelta({
      script: current,
      title: current.title,
      episode: 1,
      memo: {
        chapter: 1,
        goal: "secure proof",
        isGoldenOpening: false,
        body: [
          "## 本集 Hook ledger",
          "advance:",
          "- H001 proof advances",
          "resolve:",
          "- H002 alarm resolves",
        ].join("\n"),
        threadRefs: [],
      },
      existingHooks: [
        {
          hookId: "H001",
          startChapter: 1,
          type: "plot",
          status: "open",
          lastAdvancedChapter: 1,
          expectedPayoff: "proof",
          notes: "",
        },
      ],
    });
    expect(delta.chapter).toBe(1);
    expect(delta.currentStatePatch?.currentLocation).toBe("sealed room");
    expect(delta.currentStatePatch?.protagonistState).toContain("physical-2");
    expect(delta.currentStatePatch?.currentConflict).toContain("alarm will expose the hero");
    expect(delta.currentStatePatch?.currentGoal).toContain("action-2");
    expect(delta.hookOps.upsert[0]?.hookId).toBe("H001");
    expect(delta.hookOps.resolve).toEqual(["H002"]);
    expect(delta.chapterSummary?.estimatedDurationSeconds).toBe(90);
  });
});
