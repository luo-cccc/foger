import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetRegistrySchema, CanonClaimSchema, emptyAssetRegistry } from "../models/canon.js";
import { createEpisodeScript } from "./episode-test-fixtures.js";
import { applyEpisodeCanonUpdates, deriveEpisodeCanonUpdates } from "../state/canon-evolution.js";
import {
  hasUnclaimedFactsBacklog,
  loadAssetRegistry,
  loadClaimsFile,
  loadUnclaimedFacts,
  saveAssetRegistry,
  saveClaimsFile,
} from "../state/canon-store.js";
import { collectUnclaimedEpisodeFacts } from "../state/canon-evolution.js";

function claim(overrides: Partial<ReturnType<typeof CanonClaimSchema.parse>> = {}) {
  return CanonClaimSchema.parse({
    id: "world-001",
    domain: "world",
    claimType: "objective_rule",
    content: "Taryn controlled the archive seal.",
    scope: { appliesTo: [] },
    authority: { source: "story_frame", priority: "hard" },
    visibility: { characterKnownBy: [], hiddenFrom: [] },
    constraints: {},
    ...overrides,
  });
}

describe("deriveEpisodeCanonUpdates", () => {
  it("settles an active claim whose fact lands in the episode state", () => {
    const script = createEpisodeScript(3);
    const result = deriveEpisodeCanonUpdates({
      script,
      claims: [claim()],
      revealedIds: new Set(),
    });

    expect(result.changed).toBe(true);
    expect(result.claims[0]?.status).toBe("resolved");
    expect(result.claims[0]?.statusUpdatedAtEpisode).toBe(3);
  });

  it("leaves unrelated claims active", () => {
    const script = createEpisodeScript(1);
    const unrelated = claim({ id: "world-002", content: "The harbor ledger never lies." });
    const result = deriveEpisodeCanonUpdates({
      script,
      claims: [unrelated],
      revealedIds: new Set(),
    });
    expect(result.changed).toBe(false);
    expect(result.claims[0]?.status).toBe("active");
  });

  it("is idempotent: re-running the same episode produces no further changes", () => {
    const script = createEpisodeScript(2);
    const first = deriveEpisodeCanonUpdates({ script, claims: [claim()], revealedIds: new Set() });
    const second = deriveEpisodeCanonUpdates({
      script,
      claims: first.claims,
      revealedIds: new Set(),
    });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("merges characters who know or suspect the fact into characterKnownBy", () => {
    const script = createEpisodeScript(4);
    script.contract.informationPermissions = [{
      subject: "Mara",
      audience: "reader",
      known: ["Taryn controlled the archive seal"],
      suspected: [],
      mistaken: [],
      unknown: [],
    }];
    const result = deriveEpisodeCanonUpdates({
      script,
      claims: [claim()],
      revealedIds: new Set(),
    });
    expect(result.claims[0]?.visibility.characterKnownBy).toContain("Mara");
  });

  it("does not settle a secret truth before it is revealed to the reader", () => {
    const script = createEpisodeScript(1);
    const secret = claim({
      id: "history-001",
      domain: "history",
      claimType: "secret_truth",
      visibility: { characterKnownBy: [], hiddenFrom: ["Mara"], readerKnownFrom: 8 },
    });
    const result = deriveEpisodeCanonUpdates({
      script,
      claims: [secret],
      revealedIds: new Set(),
    });
    expect(result.changed).toBe(false);
    expect(result.claims[0]?.status).toBe("active");
  });

  it("settles a secret truth once the reveal ledger includes it", () => {
    const script = createEpisodeScript(1);
    const secret = claim({
      id: "history-001",
      domain: "history",
      claimType: "secret_truth",
      visibility: { characterKnownBy: [], hiddenFrom: ["Mara"], readerKnownFrom: 8 },
    });
    const result = deriveEpisodeCanonUpdates({
      script,
      claims: [secret],
      revealedIds: new Set(["history-001"]),
    });
    expect(result.claims[0]?.status).toBe("resolved");
  });
});

describe("applyEpisodeCanonUpdates", () => {
  it("writes claims only when something changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-evolve-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await saveClaimsFile(bookDir, { claims: [claim()] });

      const script = createEpisodeScript(2);
      const changed = await applyEpisodeCanonUpdates({ bookDir, script });
      expect(changed).toBe(true);

      const persisted = await loadClaimsFile(bookDir);
      expect(persisted.claims[0]?.status).toBe("resolved");
      expect(persisted.claims[0]?.statusUpdatedAtEpisode).toBe(2);

      const again = await applyEpisodeCanonUpdates({ bookDir, script });
      expect(again).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records unclaimed facts even when there are no claims yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-empty-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      const changed = await applyEpisodeCanonUpdates({
        bookDir,
        script: createEpisodeScript(1),
      });
      expect(changed).toBe(true);
      const unclaimed = await loadUnclaimedFacts(bookDir);
      expect(unclaimed.facts.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects unclaimed episode facts deterministically and idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-canon-unclaimed-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await saveClaimsFile(bookDir, { claims: [claim()] });
      const script = createEpisodeScript(3);
      script.contract.handoffState.knowledge.push("全新事实：钟表集团的暗账藏在冷柜后面。");

      await applyEpisodeCanonUpdates({ bookDir, script });
      const unclaimed = await loadUnclaimedFacts(bookDir);
      expect(unclaimed.facts.some((entry) => entry.fact.includes("暗账"))).toBe(true);
      expect(unclaimed.facts.some((entry) => entry.fact.includes("Taryn controlled the archive seal"))).toBe(false);

      // Idempotent: re-running the same episode does not duplicate facts.
      await applyEpisodeCanonUpdates({ bookDir, script });
      const again = await loadUnclaimedFacts(bookDir);
      expect(again.facts.filter((entry) => entry.fact.includes("暗账"))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes facts already covered by a claim from the unclaimed set", () => {
    const script = createEpisodeScript(1);
    const covered = claim(); // content "Taryn controlled the archive seal."
    const facts = collectUnclaimedEpisodeFacts({ script, claims: [covered] });
    expect(facts).not.toContain("Taryn controlled the seal");
  });
});

describe("unclaimed canon backlog", () => {
  it("requires an explicit refresh only once the configured backlog threshold is reached", () => {
    const facts = {
      version: 1 as const,
      updatedAt: "2026-08-13T00:00:00.000Z",
      facts: Array.from({ length: 3 }, (_, index) => ({
        fact: `fact-${index + 1}`,
        sourceEpisode: index + 1,
      })),
    };
    expect(hasUnclaimedFactsBacklog(facts, 3)).toBe(true);
    expect(hasUnclaimedFactsBacklog(facts, 4)).toBe(false);
  });
});

describe("asset registry structure", () => {
  it("defaults to an empty registry when the file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-assets-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      await expect(loadAssetRegistry(bookDir)).resolves.toEqual(emptyAssetRegistry());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips asset profiles and keeps old claims parseable", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-assets-"));
    try {
      const bookDir = join(root, "book");
      await mkdir(bookDir, { recursive: true });
      const registry = AssetRegistrySchema.parse({
        version: 1,
        characters: [{ name: "Mara", appearance: "grey coat, pinned badge" }],
        locations: [{ name: "Archive", views: ["ledger table", "sealed exit"] }],
        props: [{ name: "seal", states: ["cracked"] }],
      });
      await saveAssetRegistry(bookDir, registry);
      await expect(loadAssetRegistry(bookDir)).resolves.toEqual(registry);

      // A legacy claim without status/assetRefs still parses (defaults apply).
      const legacy = CanonClaimSchema.parse({
        id: "world-001",
        domain: "world",
        claimType: "objective_rule",
        content: "The archive closes at midnight.",
        scope: { appliesTo: [] },
        authority: { source: "story_frame", priority: "hard" },
        visibility: { characterKnownBy: [], hiddenFrom: [] },
      });
      expect(legacy.status).toBe("active");
      expect(legacy.assetRefs).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
